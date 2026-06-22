---
id: k7m2
title: "Blocked State Detection: Captcha, Challenge & Rate Limit Handling"
category: safety
created: "2026-03-03"
updated: "2026-06-22"
status: draft
tags: [captcha, challenge, rate-limit, fail-fast, blocked-state, human-in-the-loop]
tech: []
relates_to: [dip7]
depends_on: []
expands: []
similar_to: []
---

# Blocked State Detection: Captcha, Challenge & Rate Limit Handling

## Problem Statement

Web services deploy anti-abuse mechanisms — captchas, browser challenges, rate
limiters, login walls, and access-denied pages — to protect against automated
access. When a CLI automation tool encounters one of these blocked states, it
cannot proceed with its intended operation. Worse, naive retry strategies
actively escalate the situation: anti-abuse systems interpret repeated automated
attempts as confirmation of abusive behavior, leading to longer blocks, IP bans,
or account suspension.

A web-control CLI must treat blocked states as **fatal errors** requiring human
intervention, not as transient failures to retry.

## Principles

### 1. Detect First

Blocked-state detection must run **before** any normal view or content detection
logic. The check order matters because:

* A challenge page may contain DOM elements that partially match normal view
  selectors, causing false-positive "success" reads of garbage data.
* Acting on a challenge page (clicking, scrolling, extracting) generates
  additional requests that worsen rate-limit counters.
* Early detection produces clear, actionable error messages instead of confusing
  downstream failures.

### 2. Fail Fast

On detecting a blocked state, the tool must:

* Immediately halt all operations.
* Return a **distinct exit code** (e.g., exit code 2) separate from normal
  errors (exit code 1) and success (exit code 0). This allows calling scripts
  and CI pipelines to distinguish "blocked" from "bug."
* Log a human-readable message describing the block type and recommended action.

### 3. Persist Blocked State

A transient in-memory flag is insufficient. The tool must write a **lock file**
to disk so that:

* Subsequent invocations detect the block before even attempting a connection.
* The block survives process restarts, system reboots, and cron re-invocations.
* The lock file contains enough metadata for diagnosis (see schema below).

### 4. Refuse Subsequent Runs

At startup, before establishing any network connection, the tool must check for
an existing lock file. If one exists:

* Print the lock file contents (block type, timestamp, details).
* Exit immediately with the blocked exit code.
* Do **not** attempt to "test if the block is still active" — that test itself
  generates traffic that may worsen the block.

### 5. Human-in-the-Loop Release

Only an explicit manual command clears the block:

```
webctl release-lock
```

This deliberate friction ensures a human has:

* Reviewed the block reason.
* Resolved the underlying cause (solved a captcha in a real browser, waited out
  a rate limit, re-authenticated).
* Made a conscious decision to resume automation.

### 6. Verification on Unlock

An optional `--verify` flag on the release command performs a lightweight probe
to confirm the block is actually resolved before clearing the lock:

```
webctl release-lock --verify
```

If verification fails, the lock remains in place and the user is informed.

## Detection Signal Catalog

The following table lists universal detection signals. Implementations should
check these in order from most specific to most general.

| Block Type         | Detection Strategy                                        |
|--------------------|-----------------------------------------------------------|
| Rate limit         | Response body contains rate-limit indicator text combined with a request identifier token |
| Browser challenge  | Body text includes phrases like "checking your browser" or "please wait" with no actionable content |
| Captcha            | Presence of captcha-related iframes or container elements (`iframe[src*="captcha"]`, `div[class*="captcha"]`) |
| Login wall         | URL pathname redirected to authentication paths (`/login`, `/auth`, `/signin`) |
| Access denied      | HTTP 403 status or body text indicating access denial     |
| Session expiry     | Platform-specific DOM indicators showing deactivated or expired session state |
| IP block           | Connection refused or timeout after previously successful connections |
| Geographic block   | Redirect to region-unavailable page                       |

### Composing Detection Checks

Detection functions should be composable and ordered. A recommended pattern:

```
function check_blocked_state(page):
    checks = [
        check_rate_limit,
        check_browser_challenge,
        check_captcha,
        check_login_wall,
        check_access_denied,
        check_session_expiry,
    ]
    for check in checks:
        result = check(page)
        if result.is_blocked:
            return result
    return NOT_BLOCKED
```

Each check function returns a structured result containing:

* `is_blocked: bool`
* `block_type: string`
* `details: string` (human-readable description)
* `evidence: string` (the DOM snippet or HTTP status that triggered detection)

## Lock File Specification

### Location

```
{config_dir}/blocked.lock.json
```

Where `{config_dir}` is the tool's configuration directory (e.g.,
`~/.config/webctl/` or `$XDG_CONFIG_HOME/webctl/`).

### Schema

```json
{
  "version": 1,
  "blocked_at": "2026-03-03T14:22:07Z",
  "block_type": "rate_limit",
  "details": "Rate limit page detected with request identifier",
  "evidence": "<truncated DOM snippet or HTTP status>",
  "command": "webctl fetch --url ...",
  "pid": 12345,
  "hostname": "workstation",
  "consecutive_blocks": 1
}
```

### Fields

* **version** — Schema version for forward compatibility.
* **blocked_at** — ISO 8601 timestamp of when the block was detected.
* **block_type** — Machine-readable block category from the detection catalog.
* **details** — Human-readable explanation.
* **evidence** — Truncated snippet of the DOM or HTTP response that triggered
  detection. Truncate to a reasonable limit (e.g., 500 chars) to avoid storing
  large page contents.
* **command** — The CLI invocation that encountered the block.
* **pid** — Process ID for correlation with logs.
* **hostname** — Machine hostname for multi-host environments.
* **consecutive_blocks** — Counter incremented if a block is detected while an
  existing lock is already present (indicates escalation).

## Exit Code Convention

| Code | Meaning                              |
|------|--------------------------------------|
| 0    | Success                              |
| 1    | General error (bug, invalid input)   |
| 2    | Blocked state detected or lock active|

Using a distinct exit code enables reliable scripting:

```bash
webctl fetch --url "$URL"
case $? in
  0) echo "Success" ;;
  1) echo "Error — check logs" ;;
  2) echo "Blocked — human intervention required" ;;
esac
```

## Why Automatic Retries Are Harmful

Anti-abuse systems are stateful and escalatory:

1. **First offense** — Soft challenge (browser check, simple captcha). Clears in
   seconds if a human responds.
2. **Repeated automated attempts** — System classifies traffic as bot. Escalates
   to hard captcha, longer cooldown, or IP-level block.
3. **Continued retries** — Permanent ban, account suspension, or referral to
   abuse team.

By failing fast and refusing to retry, the tool:

* Minimizes damage from the initial trigger.
* Preserves the possibility of quick manual resolution.
* Avoids IP or account escalation that could affect the user's broader access.

## Startup Flow

```
┌─────────────┐
│  CLI Start   │
└──────┬──────┘
       │
       ▼
┌──────────────────┐     ┌─────────────────────────┐
│ Lock file exists? ├──Y──► Print lock info, exit 2  │
└──────┬───────────┘     └─────────────────────────┘
       │ N
       ▼
┌──────────────────┐
│ Connect / Load   │
└──────┬───────────┘
       │
       ▼
┌──────────────────────┐     ┌──────────────────────────┐
│ Blocked state check   ├──Y──► Write lock file, exit 2   │
└──────┬───────────────┘     └──────────────────────────┘
       │ N
       ▼
┌──────────────────┐
│ Normal operation  │
└──────────────────┘
```

## Release Flow

```
┌─────────────────────┐
│ webctl release-lock  │
└──────┬──────────────┘
       │
       ▼
┌──────────────────┐     ┌────────────────────┐
│ Lock file exists? ├──N──► "No lock", exit 0   │
└──────┬───────────┘     └────────────────────┘
       │ Y
       ▼
┌────────────────┐
│ --verify flag?  │
└──┬──────────┬──┘
   │ N        │ Y
   ▼          ▼
┌────────┐  ┌─────────────────┐     ┌──────────────────────┐
│ Remove │  │ Probe target     ├──BLOCKED──► "Still blocked", keep │
│ lock   │  └──────┬──────────┘     │  lock, exit 2          │
│ exit 0 │         │ OK             └──────────────────────┘
└────────┘         ▼
              ┌──────────┐
              │ Remove   │
              │ lock,    │
              │ exit 0   │
              └──────────┘
```

## Implementation Checklist

* [ ] Define blocked-state detection functions for each signal type.
* [ ] Implement detection-first ordering in the page-load pipeline.
* [ ] Define lock file path and schema.
* [ ] Write lock file on block detection with full metadata.
* [ ] Check lock file at startup before any network I/O.
* [ ] Return exit code 2 for all blocked-state scenarios.
* [ ] Implement `release-lock` subcommand.
* [ ] Implement `release-lock --verify` with lightweight probe.
* [ ] Add `--force` flag to `release-lock` for emergency override without
  verification.
* [ ] Log all blocked-state events with sufficient context for debugging.
* [ ] Document exit codes in CLI help text.
* [ ] Add integration tests with mock challenge pages.

## Edge Cases

### Multiple Concurrent Processes

If multiple CLI processes run simultaneously and one detects a block:

* The lock file write should use atomic file operations (write to temp file,
  then rename) to avoid partial reads.
* Other processes will pick up the lock on their next startup check.
* Already-running processes that have passed the startup check will detect the
  block when their own blocked-state check runs after page load.

### Stale Lock Files

A lock file with a very old timestamp may indicate a forgotten lock rather than
an active block. The tool should:

* Display the age of the lock prominently when refusing to run.
* Never auto-expire locks — the human decides when it is safe.
* Consider a `--info` flag to display lock details without clearing.

### Network-Level Blocks

Some blocks manifest as connection failures (TCP reset, DNS failure) rather than
HTTP responses. These are harder to distinguish from genuine network outages.
The tool should:

* Not automatically assume network failure means "blocked."
* Provide a way for the user to manually create a lock if they determine a
  network-level block is in effect.
* Log connection failure patterns for the user to review.
