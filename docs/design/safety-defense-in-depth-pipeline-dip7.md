---
id: dip7
title: "Defense-in-Depth: Multi-Layer Safety Pipeline"
category: safety
created: "2026-03-03"
updated: "2026-06-22"
status: draft
tags: [defense-in-depth, safety-pipeline, layered-safety, phased-execution, invariants]
tech: []
relates_to: [k7m2]
depends_on: []
expands: []
similar_to: []
---

# Defense-in-Depth: Multi-Layer Safety Pipeline

## 1. Problem Statement

Browser automation commands operate on live, shared state -- an open browser
session with tabs, dialogs, and network activity that can change between any two
instructions. A single safety check (e.g., "verify correct tab before acting")
is insufficient because:

* The check itself can become stale (TOCTOU).
* An unexpected dialog or download prompt can intercept keyboard/mouse input.
* A concurrent process can mutate the same browser session.
* A configuration error can direct commands at the wrong target.

No single mechanism handles all of these failure modes. The solution is
**defense-in-depth**: multiple complementary safety layers organized as a
phased pipeline, where each layer catches what the others miss.

## 2. Core Invariant

> **By the time command dispatch begins, the execution environment is in a
> verified, known-good state.**

Every phase before dispatch exists to establish or re-confirm this invariant.
Every phase after dispatch exists to detect violations that occurred during
execution and restore safety before the next command.

## 3. The 7-Phase Execution Pipeline

Commands flow through seven sequential phases. Early phases are cheap and
filter out commands that should never reach the browser. Later phases
progressively tighten the safety envelope around the actual dispatch.

```
PHASE 0  No-connection commands           exit early (help, version, config)
PHASE 1  Pre-connection safety checks     flags, blocked-state lock
PHASE 2  Connection + routing             mutex, connect, tab switching
PHASE 3  Pre-command assertions           target identity, UI hygiene
PHASE 4  Command dispatch                 the actual browser interaction
PHASE 5  Post-command checks + cleanup    view detection, state validation
PHASE 6  Resource release                 connection close, mutex release
```

### Phase 0 -- Early Exit

Commands that do not touch the browser (help text, version, configuration
display) return immediately. This avoids acquiring any locks or connections
for read-only, offline operations.

**Prevents:** unnecessary lock contention, wasted connections, accidental
side effects from config-only invocations.

### Phase 1 -- Pre-Connection Safety

Before any connection attempt, the CLI checks:

* **Blocked-state lock.** A lock file (or equivalent marker) indicates the
  browser is in a state where automation must not proceed -- for example,
  a sensitive view is active, or a previous command failed and left dirty
  state. The CLI refuses to continue until the lock is cleared.
* **Flag validation.** Required flags (target identifiers, assertion flags)
  are checked for presence and format before any network activity.
* **Invariant requirements.** The caller must provide a `--required
  '{invariants...}'` specification declaring assumptions about the current
  state (e.g., expected last message, expected model selection). If
  invariants are not provided, the CLI refuses to proceed for any
  state-mutating command. The specific required invariants may vary by
  command/subcommand. A `--force` (`-f`) flag exists **only** for human
  operators who are actively observing the browser in headed mode and can
  visually confirm state -- it must never be used by automated callers.

**Prevents:** sending commands to a browser in a known-bad state; catching
missing arguments early rather than after partial execution; proceeding
without explicit caller assumptions about expected state.

### Phase 2 -- Connection and Routing

* **Process mutex.** A filesystem-based mutex (e.g., `mkdir`-based with PID
  tracking) ensures only one CLI instance operates on a given browser
  session at a time. If the lock holder is dead (stale PID), the lock is
  reclaimed.
* **Connection establishment.** The CLI connects to the browser's debug
  protocol endpoint.
* **Tab routing.** The correct tab/target is located and activated. If
  tab-activity tracking is available (e.g., LRU list), it is consulted to
  resolve ambiguous targets.

**Prevents:** concurrent mutation of browser state by parallel CLI
invocations; connecting to the wrong endpoint; operating on a stale or
wrong tab.

### Phase 3 -- Pre-Command Assertions

With a live connection to the correct tab, the CLI performs in-browser
assertions:

* **Target identity assertion.** The current page URL, title, or
  application-specific identifier (e.g., a conversation ID, post slug, or
  document key) is checked against the `"target"` key from the
  `--required` invariant specification. This is the strongest guard
  against operating on the wrong target.
* **Precondition assertions.** Additional keys in the `--required` JSON
  specification (e.g., `--required '{"target": "conv-123", "model":
  "X"}'`) declare expected application state. The CLI evaluates each
  invariant key against the live DOM or application state.
* **UI state hygiene.** The CLI scans for and dismisses unexpected modal
  dialogs, cookie banners, or notification popups that could intercept
  subsequent input. Download dialog suppression (via protocol-level
  configuration) prevents file-save dialogs from blocking the session.

**Prevents:** operating on the wrong conversation/document/page;
proceeding when the application is in an unexpected configuration;
losing input to an intercepting dialog.

### Phase 4 -- Command Dispatch

The actual browser interaction executes. By this point, seven layers of
verification have confirmed:

1. The command needs a browser connection.
2. No blocked-state lock is active.
3. Required flags are present and valid.
4. No other CLI process holds the mutex.
5. The connection is live and routed to the correct tab.
6. The target identity and preconditions match expectations.
7. The UI is free of intercepting overlays.

**This is the only phase that mutates browser state.**

### Phase 5 -- Post-Command Checks

After dispatch, the CLI optionally:

* **Detects view changes.** If the command caused navigation to a
  sensitive or blocked view, the blocked-state lock is set for future
  invocations.
* **Validates outcomes.** For commands with verifiable results (e.g.,
  message count increased, file appeared in downloads), the CLI checks
  that the expected effect occurred.
* **Captures diagnostics.** Screenshots, DOM snapshots, or protocol logs
  are saved when assertions fail.

**Prevents:** silent failures where the command appeared to succeed but
had no effect; future commands proceeding after a destructive navigation.

### Phase 6 -- Resource Release

* The browser connection is closed (or returned to a pool).
* The process mutex is released.
* Temporary files (screenshots, payloads) are cleaned up if configured.

**Prevents:** leaked connections exhausting protocol limits; stale mutex
locks blocking future commands; temporary file accumulation.

## 4. Layer Composition Table

Each layer handles a distinct failure class. The table shows what each layer
prevents and whether it is present across different implementation
approaches.

| Layer                      | Failure class prevented                | Minimal (3-layer) | Full (7-phase) |
|----------------------------|----------------------------------------|--------------------|-----------------|
| Blocked-state lock         | Commands during known-bad state        | --                 | Yes             |
| Flag/argument validation   | Missing or malformed required inputs   | Implicit           | Explicit        |
| Invariant requirements     | Proceeding without caller state assumptions | --            | Yes (mandatory) |
| Process mutex              | Concurrent CLI instances               | Yes                | Yes             |
| Target identity assertion  | Wrong page/document/conversation       | Yes                | Yes             |
| Precondition assertions    | Unexpected application configuration   | Partial            | Yes             |
| UI state hygiene           | Intercepting dialogs/overlays          | --                 | Yes             |
| Download dialog suppress.  | File-save dialogs blocking session     | --                 | Yes             |
| Tab activity tracking      | Ambiguous or stale tab selection       | Optional           | Yes             |
| Post-command view detect.  | Silent destructive navigation          | --                 | Yes             |

The minimal 3-layer approach (target assertion, process mutex, tab tracking)
is viable for simpler tools. The full 7-phase pipeline is recommended for
any tool that performs write operations or runs unattended.

## 5. 3-Layer vs. 7-Phase: When to Use Which

**3-layer model** -- suitable when:

* The tool performs mostly read operations (scraping, extraction).
* Only one target type exists (no multi-tab workflows).
* The operator is present and can intervene on dialog popups.

**7-phase pipeline** -- recommended when:

* The tool performs write operations (sending messages, submitting forms).
* Multiple target types or multi-tab workflows are involved.
* The tool runs unattended (cron, CI, scripted pipelines).
* The target application has modal dialogs, overlays, or navigation
  side effects.

## 6. Implementation Guidance

### 6.1 Mutex Design

Use a directory-based mutex (`mkdir` is atomic on POSIX systems):

```
/tmp/{tool-name}-mutex-{session-id}/
  PID         # contains the owning process ID
```

On acquisition:

1. Attempt `mkdir`. If it succeeds, write own PID.
2. If it fails, read the PID file. Check if that PID is alive
   (`kill -0 $PID`). If dead, remove the directory and retry.
3. If alive, exit with a clear error naming the owning PID.

On release: remove the directory in a cleanup trap (`trap ... EXIT`).

### 6.2 Target Identity Assertion

The `"target"` key in `--required` serves as the identity assertion.
After connecting and routing to the correct tab, evaluate a DOM query or
URL check to extract the current target identifier. Compare it to the
`"target"` value from the invariant specification. Abort with a
diagnostic message if they differ.

This is the single most important safety layer. It catches configuration
drift, tab reuse, and stale bookmarks.

### 6.3 Blocked-State Lock

Maintain a lock file at a known path:

```
/tmp/{tool-name}-blocked-{session-id}
```

Phase 1 checks for this file and refuses to proceed if it exists. Phase 5
sets it when a post-command view detection finds a sensitive/blocked state.
The user (or a dedicated `unblock` subcommand) clears it after
investigating.

### 6.4 UI Hygiene Scan

Before dispatch, execute a DOM query for common overlay selectors
(modals, cookie banners, notification toasts). Dismiss each by clicking
the appropriate close/accept button or pressing Escape. Log each
dismissed overlay for auditability.

For download dialogs, configure the browser protocol to auto-accept
downloads to a designated directory, preventing file-save dialogs from
blocking the session.

### 6.5 Post-Command View Detection

After dispatch, query the current URL and/or DOM markers to determine
whether the view changed to a known-sensitive state (e.g., account
settings, billing, admin panels). If so, set the blocked-state lock.

### 6.6 Invariant Specification (`--required`)

Accept a `--required <json>` flag containing a JSON object of key-value
pairs representing caller assumptions about current state.

**Parsing:** The JSON is parsed at Phase 1 (flag validation). Malformed
JSON is rejected immediately with a diagnostic message.

**Per-command key schemas:** Each command/subcommand defines which
invariant keys it supports and which are mandatory. For example:

* `send-message`: requires `"target"` (conversation ID); optional
  `"model"`, `"last_message"`.
* `click`: requires `"target"` (page identifier); optional `"selector"`.
* `extract`: requires `"target"`; no additional keys.

Unknown keys are rejected to prevent typos from silently passing
validation.

**Evaluation:** At Phase 3, each key is evaluated against the live DOM
or application state. All invariants must match for the command to
proceed. On mismatch, the CLI exits with a structured error identifying
which invariant failed, the expected value, and the actual value found.

**`--force` (`-f`) bypass:** When `--force` is set, invariant
requirements are skipped. This flag is intended **exclusively** for
human operators actively observing the browser in headed mode. Automated
callers (scripts, CI, agent loops) must never use `--force`. The CLI
emits a warning to stderr when `--force` is used, to discourage routine
reliance.

## 7. Design Rationale

### Why phases rather than ad-hoc checks?

Phases impose a strict ordering that makes it impossible to accidentally
skip a layer. Each phase has a single responsibility. Testing is
straightforward: inject a failure at phase N and verify that phases
N+1 through 6 are never reached.

### Why both pre- and post-command checks?

Pre-command checks establish a known-good state. Post-command checks
detect violations that *the command itself* caused. A command might
navigate to a sensitive page as a side effect; only post-command detection
catches this.

### Why a process mutex when the browser protocol is single-threaded?

The protocol may be single-threaded, but the CLI is not the only actor.
A user could manually interact with the browser, or a second CLI
instance could connect. The mutex ensures CLI-level serialization.
It does not prevent manual interference, but it eliminates the most
common source of concurrent-mutation bugs.

### Why mandatory invariants rather than optional assertions?

Optional safety checks get skipped. When assertions are opt-in, callers
under time pressure or unfamiliar with the tool omit them, and failures
occur silently on wrong targets. Making `--required` mandatory forces
every caller to explicitly state what state they expect, creating a
contract between the caller and the tool. If the contract cannot be
satisfied, the tool fails loudly rather than acting on stale assumptions.
The `--force` escape hatch exists only for the narrow case of a human
operator who can visually verify state -- it is deliberately inconvenient
for automated use to prevent normalization of skipped checks.

## 8. Failure Mode Summary

| Scenario                             | Layer(s) that catch it               |
|--------------------------------------|--------------------------------------|
| Wrong tab active                     | Tab routing (P2), Target assert (P3) |
| Two CLI instances running            | Process mutex (P2)                   |
| Cookie consent banner over input     | UI hygiene (P3)                      |
| Download dialog blocks session       | Download suppression (P3)            |
| Command navigates to settings page   | Post-command view detection (P5)     |
| Missing `--required` invariants      | Flag validation (P1)                 |
| Previous command left blocked state  | Blocked-state lock (P1)              |
| Stale mutex from crashed process     | PID liveness check (P2)             |

## 9. Summary

Defense-in-depth is not about redundancy for its own sake. Each layer
addresses a distinct failure mode that the other layers cannot catch. The
7-phase pipeline organizes these layers into a strict sequence with one
overriding guarantee: **command dispatch never begins until the environment
is verified safe.** Post-dispatch checks then ensure that the command
itself did not violate safety, protecting future invocations.

For simpler tools, a 3-layer subset (mutex, target assertion, tab tracking)
provides meaningful safety with lower implementation cost. For write-heavy
or unattended tools, the full pipeline is strongly recommended.
