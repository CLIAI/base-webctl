---
id: 1t87
title: "Error Recovery: Fault Tolerance, Retry & Graceful Degradation"
category: ops
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [error-recovery, fault-tolerance, retry, graceful-degradation, stuck-detection, failover]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Error Recovery: Fault Tolerance, Retry & Graceful Degradation

## Motivation

Web-control CLI tools operate in inherently unreliable environments. Pages load
slowly, elements disappear between checks and clicks, network requests time out,
and browser processes crash without warning. A tool that treats every failure as
fatal frustrates users and wastes partial work already completed.

This document defines **recovery strategies** that let a web-control framework
survive transient faults, degrade gracefully when full success is impossible,
and always leave the environment in a clean state.

## Recovery Strategy Table

The table maps common failure types to their recommended recovery approach.
Each row is independent — multiple strategies may compose for a single
operation.

| Failure Type              | Detection Signal                        | Strategy               | Max Attempts | Backoff        |
|---------------------------|-----------------------------------------|------------------------|--------------|----------------|
| Element not found         | Selector timeout                        | Retry with wait        | 3            | 1s, 2s, 4s    |
| Element found but stale   | `StaleElementReference` or equivalent   | Re-locate and retry    | 3            | 500ms fixed    |
| Navigation timeout        | Page load exceeds deadline              | Reload + retry         | 2            | 3s, 6s        |
| Network request failure   | HTTP 5xx / connection reset             | Exponential backoff    | 5            | 1s .. 32s     |
| Rate limiting             | HTTP 429 / known throttle pattern       | Respect `Retry-After`  | 3            | Header-driven  |
| Browser crash             | Process exit / pipe broken              | Restart browser        | 1            | 5s             |
| Authentication expired    | Redirect to login / 401                 | Abort with actionable message | 0     | N/A            |
| Dialog / overlay blocking | Click intercepted / unexpected modal    | Dismiss + retry action | 2            | 500ms          |
| Content not yet rendered  | Expected text absent after load         | Poll with backoff      | 5            | 500ms .. 4s    |
| Stuck / no progress       | Heartbeat timeout (see below)           | Multi-step escalation  | 3 stages     | Staged         |

## Strategy Pattern with Automatic Failover

Operations should declare a **strategy chain** — an ordered list of approaches
to try before giving up. The framework executes each strategy in sequence,
falling through to the next on failure.

```python
# Pseudocode — strategy chain for a "fetch page content" operation

strategies = [
    Strategy(
        name="direct_load",
        action=lambda: browser.navigate(url),
        timeout=10_000,
    ),
    Strategy(
        name="reload_and_wait",
        action=lambda: (browser.reload(), wait_for_idle(15_000)),
        timeout=20_000,
    ),
    Strategy(
        name="fresh_context",
        action=lambda: (browser.new_context(), browser.navigate(url)),
        timeout=25_000,
    ),
]

result = execute_with_failover(strategies)
```

### `execute_with_failover` Contract

```
execute_with_failover(strategies) -> Result | PartialResult | Failure
```

Rules:

1. Try each strategy in order. On success, return immediately.
2. On timeout or exception, log the failure, run the strategy's optional
   `cleanup` callback, then advance to the next strategy.
3. If all strategies exhausted, return a `Failure` that aggregates every
   attempt's error context (timestamps, screenshots if available, DOM
   snapshots).
4. Never silently swallow exceptions — every caught error must be logged at
   `DEBUG` or higher.

### Composing Retry + Failover

A single strategy may internally retry (e.g., re-locate a stale element three
times) before the outer failover chain moves to the next strategy. Keep these
two levels distinct:

* **Inner retry** — same approach, repeated. Handles transient jitter.
* **Outer failover** — different approach. Handles structural problems.

```
failover chain
 ├── strategy A (inner retry x3)
 ├── strategy B (inner retry x2)
 └── strategy C (no retry, last resort)
```

## Graceful Degradation: Returning Partial Results

When an operation involves multiple independent sub-tasks (e.g., extracting
several fields from a page), failing one sub-task should not discard the
others.

### PartialResult Pattern

```python
@dataclass
class PartialResult:
    """Carries whatever succeeded alongside details of what failed."""
    data: dict                    # successfully extracted fields
    failures: list[SubTaskError]  # what went wrong, per failed sub-task
    degraded: bool                # True when any sub-task failed

@dataclass
class SubTaskError:
    field: str
    error: str
    recoverable: bool
    attempted_strategies: list[str]
```

### Reporting Degraded Results

The CLI must make degradation visible, never silent:

```
$ webctl extract --url "https://example.com/profile"
✓ name:     "Jane Doe"
✓ bio:      "Engineer and open-source contributor"
✗ avatar:   FAILED — element not found after 3 retries (selector: .avatar-img)
✓ location: "San Francisco, CA"

⚠ Partial result: 3/4 fields extracted. Use --strict to treat partial as error.
Exit code: 0 (partial success)
```

Design choices:

* **Exit code 0** for partial success by default — scripts that tolerate gaps
  continue working.
* **`--strict` flag** makes any degradation return exit code 1.
* **Structured output** (`--json`) includes the `failures` array so callers
  can programmatically decide.

## Actionable Error Messages with Remediation Steps

Every user-facing error must answer three questions:

1. **What happened?** — concrete symptom.
2. **Why?** — likely root cause.
3. **What can I do?** — specific next step.

### Error Message Template

```
ERROR [{error_code}]: {what_happened}

  Cause:  {likely_reason}
  Action: {what_user_should_do}
  Docs:   {link_or_flag_for_more_info}
```

### Examples

```
ERROR [AUTH_EXPIRED]: Session cookie is no longer valid.

  Cause:  The authentication token has expired or was revoked.
  Action: Re-authenticate by running:  webctl auth login
  Docs:   webctl help auth
```

```
ERROR [ELEMENT_GONE]: Target element disappeared before interaction.

  Cause:  The page updated between locating the element and clicking it.
          This is common on pages with live content feeds.
  Action: Retry the command. If persistent, increase --wait-before-action
          or file a bug with the DOM snapshot attached.
  Docs:   webctl help troubleshoot
```

### Structured Error Envelope

For `--json` output, wrap errors consistently:

```json
{
  "ok": false,
  "error": {
    "code": "NAV_TIMEOUT",
    "message": "Page did not finish loading within 30s",
    "cause": "Slow network or heavy page",
    "remediation": "Retry with --timeout 60000 or check connectivity",
    "context": {
      "url": "https://example.com/dashboard",
      "elapsed_ms": 30012,
      "strategies_attempted": ["direct_load", "reload_and_wait"]
    }
  }
}
```

## Signal Handler Cleanup

Web-control tools launch external processes (browsers, proxies). Unclean
shutdown leaks these processes, consuming memory and ports. Signal handlers
ensure cleanup runs regardless of how the tool exits.

### Required Signals to Handle

| Signal    | Source                    | Action                          |
|-----------|---------------------------|---------------------------------|
| `SIGINT`  | Ctrl-C                    | Graceful shutdown, cleanup      |
| `SIGTERM` | `kill`, orchestrator stop | Graceful shutdown, cleanup      |
| `SIGPIPE` | Piped output closed       | Flush buffers, cleanup, exit    |
| `SIGHUP`  | Terminal closed           | Cleanup, exit                   |

### Cleanup Sequence

```python
import signal
import atexit

_cleanup_done = False

def cleanup():
    global _cleanup_done
    if _cleanup_done:
        return
    _cleanup_done = True

    # 1. Save any pending partial results to a recovery file
    save_recovery_state()

    # 2. Close browser contexts (sends CDP close)
    browser_pool.close_all(timeout=5_000)

    # 3. Terminate child processes with SIGTERM first
    for proc in child_processes:
        proc.terminate()

    # 4. Wait briefly, then SIGKILL stragglers
    for proc in child_processes:
        try:
            proc.wait(timeout=3)
        except TimeoutError:
            proc.kill()

    # 5. Release port locks / temp files
    release_resources()

def signal_handler(signum, frame):
    cleanup()
    sys.exit(128 + signum)

for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, signal_handler)

atexit.register(cleanup)
```

### Guard Against Double Cleanup

The `_cleanup_done` flag prevents re-entrant cleanup when a signal arrives
during `atexit` processing. This is critical — browser teardown is not
idempotent on all platforms.

### Recovery File

On unclean exit, write a `.webctl-recovery.json` in the working directory
containing:

* Partial results collected so far
* The operation that was in progress
* Enough state to resume (`--resume` flag)

```
$ webctl extract --resume
Resuming from .webctl-recovery.json (3/10 items already extracted)
...
```

## Stuck Detection and Multi-Step Recovery

"Stuck" means the tool is running but making no forward progress. This is
harder to detect than a crash but equally damaging — it burns time and
resources silently.

### Heartbeat-Based Detection

Every long-running operation emits **heartbeat events** at regular intervals.
A watchdog monitors these heartbeats:

```python
class StuckDetector:
    def __init__(self, timeout_ms=30_000):
        self.timeout_ms = timeout_ms
        self.last_heartbeat = now()

    def heartbeat(self, context: str):
        """Called by the operation to signal progress."""
        self.last_heartbeat = now()
        log.debug(f"heartbeat: {context}")

    def check(self) -> bool:
        """Returns True if stuck (no heartbeat within timeout)."""
        return (now() - self.last_heartbeat) > self.timeout_ms
```

Operations emit heartbeats at meaningful progress points:

```python
for i, item in enumerate(work_items):
    detector.heartbeat(f"processing item {i+1}/{len(work_items)}")
    process(item)
```

### Multi-Step Escalation

When stuck is detected, recovery escalates through increasingly aggressive
steps. Each step is tried once before advancing.

```
Stage 1: Soft nudge
  → Send an Escape keypress (dismiss possible modal)
  → Wait 2s, check for heartbeat resume

Stage 2: Page-level recovery
  → Reload the current page
  → Re-navigate to the target URL
  → Wait 5s, check for heartbeat resume

Stage 3: Context-level recovery
  → Close the current browser context
  → Open a fresh context
  → Re-authenticate if needed
  → Replay from last checkpoint
  → Wait 10s, check for heartbeat resume

Stage 4: Abort
  → Save partial results to recovery file
  → Report stuck condition with diagnostic info
  → Exit with non-zero code
```

### Diagnostic Snapshot on Stuck

At each escalation stage, capture:

* Screenshot of the current viewport
* DOM snapshot (truncated to 50KB)
* Console log buffer (last 100 entries)
* Network request log (pending requests)
* Current URL and navigation history

Store these in a timestamped directory under `.webctl-diagnostics/` so the user
(or a bug report) has everything needed to understand the failure without
reproducing it.

## Implementation Checklist

* [ ] Define `Strategy` and `execute_with_failover` in core library
* [ ] Implement `PartialResult` and `SubTaskError` data types
* [ ] Wire signal handlers into CLI entrypoint
* [ ] Add `--strict` and `--resume` flags to relevant commands
* [ ] Implement `StuckDetector` with configurable timeout
* [ ] Add diagnostic snapshot capture utility
* [ ] Structured error envelope for `--json` output mode
* [ ] Integration tests: simulate element staleness, nav timeout, browser crash
* [ ] Document recovery file format for `--resume` interoperability

## Design Decisions

* **Partial results by default** — most web-control tasks are best-effort;
  discarding 9 successes because the 10th failed is wasteful. `--strict` opts
  in to all-or-nothing.
* **Strategy chain over retry loop** — different failures need different
  recovery (re-locate vs reload vs fresh context). A chain lets each strategy
  target a specific failure shape.
* **Staged stuck detection** — aggressive recovery (kill context) is expensive;
  soft nudges (Escape key) are cheap and often enough. Escalation balances
  speed against disruption.
* **Automatic diagnostics** — web automation failures are hard to reproduce.
  Snapshots at failure time make bug reports actionable without screen recording.
