---
id: r7m2
title: "Polling, Retry & Async Condition Waiting"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [polling, retry, async, timeout, condition-wait, state-machine, batch-extraction]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Polling, Retry & Async Condition Waiting

## 1. Problem Statement

Web-control CLI tools spend most of their time *waiting* — for pages to load,
elements to appear, modals to dismiss, or remote operations to complete. Naive
approaches use fixed-duration sleeps, which are simultaneously too slow (wasting
time when the condition is already met) and too fragile (failing when the
condition takes slightly longer than expected).

This document defines a unified set of polling, retry, and asynchronous
condition-waiting patterns that eliminate fixed sleeps and provide predictable,
observable behaviour under varying latency.

## 2. Core Principle: Never Fixed Sleep

**Every wait in the system must be condition-based, not duration-based.**

A fixed `sleep(3000)` has two failure modes:

* **Too long** — the condition was met in 200ms; the remaining 2800ms is waste
  that compounds across hundreds of operations.
* **Too short** — on a slow connection or under load, 3000ms is not enough,
  causing a false-negative failure.

Condition-based polling returns as soon as the condition is satisfied and times
out cleanly when it is not, making every wait both as fast as possible and as
resilient as needed.

## 3. The `pollUntil` Primitive

### 3.1 Canonical Signature

```
pollUntil(conditionFn, options?) -> Promise<T>
```

**Parameters:**

| Parameter       | Type       | Default  | Description                                              |
|-----------------|------------|----------|----------------------------------------------------------|
| `conditionFn`   | `() => T`  | required | Returns a truthy value `T` on success, falsy to retry    |
| `timeout`       | `number`   | 5000     | Wall-clock timeout in milliseconds                       |
| `interval`      | `number`   | 150      | Milliseconds between polls                               |
| `label`         | `string`   | `""`     | Human-readable label for logging and diagnostics         |
| `warnOnTimeout` | `boolean`  | `true`   | If `false`, timeout throws silently (for expected fails) |

**Returns:** The first truthy value returned by `conditionFn`.

**Throws:** `TimeoutError` if the condition is not met within `timeout` ms.

### 3.2 Design Decisions

1. **Wall-clock timeout, not iteration count.** A 5-second timeout means five
   real seconds regardless of how long each poll takes. This prevents
   accidentally polling for 500 iterations when the condition function itself
   is slow.

2. **Return the truthy value, not a boolean.** If the condition function
   returns the located element, `pollUntil` passes it through. Callers avoid a
   redundant second lookup.

3. **Swallow transient exceptions.** If `conditionFn` throws (e.g., a stale
   reference), the error is logged at TRACE level and the poll continues. Only
   a timeout causes a thrown error. This makes polling resilient to brief DOM
   instability.

4. **Configurable `warnOnTimeout`.** Some polls are speculative — checking
   whether an optional element exists. Setting `warnOnTimeout: false` keeps
   logs clean when timeout is the expected path.

### 3.3 Usage Pattern

```
// Wait for a submit button to become enabled
const button = await pollUntil(
  () => findElement('[type=submit]:not([disabled])'),
  { timeout: 10000, label: 'submit-button-enabled' }
);
await button.click();
```

## 4. The Action-Assert-Delay Sequence

Every interactive operation follows a three-phase sequence:

```
┌──────────┐     ┌──────────────────┐     ┌────────────┐
│  ACTION   │────>│  ASSERT (poll)   │────>│   DELAY    │
│  (click,  │     │  (pollUntil the  │     │  (opDelay  │
│   type,   │     │   expected state │     │   for rate │
│   nav)    │     │   is reached)    │     │   pacing)  │
└──────────┘     └──────────────────┘     └────────────┘
```

1. **Action** — Perform the operation (click, type, navigate).
2. **Assert** — `pollUntil` the expected post-condition is true. This is the
   only wait that matters for correctness.
3. **Delay** — An optional cosmetic/rate-limiting pause *after* success. This
   prevents overwhelming the target and makes automation less detectable.

### 4.1 The `opDelay` Helper

```
opDelay(label?) -> Promise<void>
```

Pauses for a random duration within `[delayMin, delayMax]` (typically 200ms to
800ms), creating human-like timing variance. The `label` parameter aids
debugging.

**Key rule:** `opDelay` is never used *instead* of `pollUntil`. It is always
the third phase — after the condition has been confirmed met.

## 5. Retry Wrappers

While `pollUntil` handles condition waiting, some operations need full
retry-with-backoff semantics — typically remote evaluations that may time out
transiently.

### 5.1 `evalRetry` — Remote Evaluation with Linear Backoff

```
evalRetry(evalFn, options?) -> Promise<T>
```

| Parameter    | Type       | Default | Description                                  |
|--------------|------------|---------|----------------------------------------------|
| `evalFn`     | `() => T`  | required| The evaluation to attempt                    |
| `maxRetries` | `number`   | 3       | Maximum number of attempts                   |
| `baseDelay`  | `number`   | 2000    | Base delay multiplied by attempt number      |

**Backoff formula:** `delay = baseDelay * attemptNumber`

Attempt 1: 2000ms, Attempt 2: 4000ms, Attempt 3: 6000ms.

**Retry condition:** Only retries on *timeout* errors. Other error types
(syntax errors, permission failures) are thrown immediately — retrying them
would be pointless.

### 5.2 When to Use `evalRetry` vs `pollUntil`

| Use Case                              | Tool        |
|---------------------------------------|-------------|
| Wait for a DOM element to appear      | `pollUntil` |
| Wait for a page to finish loading     | `pollUntil` |
| Execute a remote eval that may hang   | `evalRetry` |
| Retry a network request on timeout    | `evalRetry` |

The distinction: `pollUntil` re-checks a *condition*; `evalRetry` re-executes
an *operation*.

## 6. Batched Extraction

Extracting large datasets from the DOM (hundreds or thousands of items) in a
single evaluation risks timeout or memory exhaustion. The `evalBatched` pattern
splits extraction into pages.

### 6.1 `evalBatched` — Paginated DOM Extraction

```
evalBatched(extractFn, options?) -> Promise<T[]>
```

| Parameter   | Type                     | Default | Description                            |
|-------------|--------------------------|---------|----------------------------------------|
| `extractFn` | `(offset, limit) => T[]` | required| Returns items for the given page       |
| `batchSize` | `number`                 | 50      | Items per page                         |
| `maxItems`  | `number`                 | 10000   | Safety cap on total items              |

**Behaviour:**

1. Calls `extractFn(0, batchSize)` to get the first page.
2. If the returned array length equals `batchSize`, fetches the next page.
3. Continues until a partial page is returned or `maxItems` is reached.
4. On any single-batch failure, returns all items collected so far (graceful
   degradation) rather than discarding everything.

### 6.2 Graceful Degradation

If batch N fails (timeout, stale reference), the extractor:

* Logs a warning with batch number and offset.
* Returns items from batches 0 through N-1.
* Does **not** throw — partial data is better than no data for most extraction
  use cases.

This makes `evalBatched` safe for large, unpredictable DOM structures where
elements may be lazily loaded or removed during extraction.

## 7. Response Wait State Machine

For operations that trigger an asynchronous response (e.g., submitting a query
and waiting for the result to stream in), a simple `pollUntil` is insufficient.
The response goes through multiple observable phases, and the tool must track
progression through them.

### 7.1 State Transitions

```
┌─────────┐    indicator    ┌──────────┐   content    ┌───────────┐    stable    ┌──────┐
│ WAITING │───────────────>│ THINKING │────────────>│ STREAMING │──────────>│ DONE │
│         │    appears      │          │   begins     │           │   output    │      │
└─────────┘                └──────────┘              └───────────┘            └──────┘
     │                          │                         │
     │         timeout          │       timeout           │    timeout
     v                          v                         v
┌─────────┐              ┌─────────┐               ┌─────────┐
│  STUCK  │              │  STUCK  │               │  STUCK  │
└─────────┘              └─────────┘               └─────────┘
```

**States:**

| State       | Observable Signal                                    | Timeout |
|-------------|------------------------------------------------------|---------|
| `WAITING`   | No activity indicator present yet                    | 30s     |
| `THINKING`  | Activity indicator visible, no content yet           | 60s     |
| `STREAMING` | Content actively growing (length increases per poll) | 30s     |
| `DONE`      | Content stable for N consecutive polls               | —       |
| `STUCK`     | Any state exceeds its timeout                        | —       |

### 7.2 Stuck Detection and Recovery

When a stuck state is detected, the recovery sequence is:

1. **Interrupt** — Trigger the stop/cancel control.
2. **Wait** — `pollUntil` the interface returns to an idle state (3-5s).
3. **Retry or Escalate** — Either re-submit the operation or, after repeated
   failures, reload the entire context and retry from scratch.

The number of recovery attempts before escalation should be configurable
(default: 2).

### 7.3 Streaming Stability Detection

To detect the `STREAMING -> DONE` transition, the state machine compares
content length across consecutive polls:

```
if contentLength === previousContentLength for N consecutive polls:
    transition to DONE
```

A recommended value for N is 3 polls at the standard interval (150ms), giving
a 450ms stability window. For longer-form content, N may be increased.

## 8. Heartbeat Protocol

Long-running operations (multi-minute extractions, large uploads) need periodic
liveness signals to distinguish "still working" from "silently hung".

### 8.1 Design

```
heartbeat(checkFn, options?) -> Promise<void>
```

| Parameter       | Type         | Default | Description                          |
|-----------------|--------------|---------|--------------------------------------|
| `checkFn`       | `() => bool` | required| Returns `true` if operation is alive |
| `initialInterval` | `number`  | 1000    | First heartbeat interval (ms)        |
| `maxInterval`   | `number`     | 30000   | Maximum interval after backoff       |
| `backoffFactor` | `number`     | 2       | Multiplier per successful check      |

**Exponential backoff:** Each successful heartbeat doubles the interval (up to
`maxInterval`). A failed heartbeat resets the interval to `initialInterval` and
increments a failure counter.

**Failure threshold:** After `maxFailures` (default: 3) consecutive failed
heartbeats, the operation is declared dead and the appropriate recovery path is
triggered.

### 8.2 Rationale for Exponential Backoff

Early in an operation, rapid checking catches immediate failures. As the
operation proves stable, backing off reduces overhead. A 1s -> 2s -> 4s -> 8s
-> 16s -> 30s progression covers both fast-fail and long-running scenarios
efficiently.

## 9. Configuration and Defaults

All timing parameters should be configurable at three levels:

1. **Global defaults** — Sensible values baked into the library (as listed in
   the tables above).
2. **Per-profile overrides** — Configuration file settings that adjust defaults
   for slow or fast environments.
3. **Per-call overrides** — Direct parameters at the call site for
   operation-specific tuning.

### 9.1 Recommended Defaults

| Parameter                     | Default | Rationale                           |
|-------------------------------|---------|-------------------------------------|
| `pollUntil.timeout`           | 5000ms  | Covers most DOM operations          |
| `pollUntil.interval`          | 150ms   | Responsive without excessive CPU    |
| `opDelay.min`                 | 200ms   | Minimum human-like pause            |
| `opDelay.max`                 | 800ms   | Maximum human-like pause            |
| `evalRetry.maxRetries`        | 3       | Enough to survive transient issues  |
| `evalRetry.baseDelay`         | 2000ms  | Gives target time to recover        |
| `evalBatched.batchSize`       | 50      | Balances speed and reliability      |
| `heartbeat.initialInterval`   | 1000ms  | Fast initial failure detection      |
| `heartbeat.maxInterval`       | 30000ms | Reasonable ceiling for long ops     |
| `responseWait.stablePolls`    | 3       | ~450ms stability window             |

## 10. Observability

All polling and retry primitives must support structured logging:

* **Start** — Log the operation label, timeout, and interval at DEBUG level.
* **Each poll** — Log at TRACE level (off by default in production).
* **Success** — Log elapsed time and the number of polls at DEBUG level.
* **Timeout** — Log at WARN (or TRACE if `warnOnTimeout: false`).
* **Retry** — Log attempt number, delay until next attempt, and error summary
  at WARN level.

This logging enables post-hoc analysis of timing behaviour without impacting
production performance.

## 11. Anti-Patterns

| Anti-Pattern                     | Why It Fails                                            | Correct Alternative         |
|----------------------------------|--------------------------------------------------------|-----------------------------|
| `sleep(3000)` before checking    | Wastes time or is insufficient                          | `pollUntil(conditionFn)`    |
| Polling by iteration count       | Duration varies with poll function speed                | Wall-clock timeout          |
| Retrying all error types         | Syntax/auth errors will never self-resolve              | Retry only on timeout       |
| Single large DOM extraction      | Times out or exhausts memory on large datasets          | `evalBatched` with fallback |
| Ignoring stuck state             | Automation hangs indefinitely                           | State machine with recovery |
| Fixed retry delay                | Either too aggressive or too conservative               | Linear or exponential backoff |

## 12. Implementation Checklist

* [ ] Implement `pollUntil` with wall-clock timeout and truthy-value return
* [ ] Implement `opDelay` with configurable random range
* [ ] Implement `evalRetry` with linear backoff and timeout-only retry
* [ ] Implement `evalBatched` with graceful degradation
* [ ] Implement response wait state machine with stuck detection
* [ ] Implement heartbeat protocol with exponential backoff
* [ ] Add structured logging to all primitives
* [ ] Add per-profile configuration overrides
* [ ] Write unit tests for timeout, retry, and batch edge cases
