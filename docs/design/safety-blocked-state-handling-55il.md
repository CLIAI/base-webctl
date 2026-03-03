---
id: 55il
title: "Blocked State Detection: Captcha, Challenge & Rate Limit Handling"
category: safety
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [captcha, challenge, rate-limit, fail-fast, blocked-state, human-in-the-loop]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Blocked State Detection: Captcha, Challenge & Rate Limit Handling

## 1. Problem Statement

Web services deploy various blocking mechanisms to throttle or challenge
automated access: captchas, interactive challenges, rate-limit walls, IP bans,
and account-level restrictions. A web-control CLI tool that ignores these
signals will:

* Waste cycles retrying against an immovable wall.
* Escalate suspicion by hammering a service that already flagged the session.
* Produce silent data corruption when the tool scrapes the challenge page
  instead of the intended content.
* Leave the operator unaware that intervention is required.

The correct response is always the same: **detect early, stop immediately, and
hand control back to the human**.

## 2. Design Principles

### 2.1 Detect-First (Before Normal View Detection)

Blocked-state detection MUST execute **before** the tool attempts to locate
normal page elements. The check order on every page load or navigation is:

```
1. blocked-state detector  (this document)
2. error-state detector    (HTTP errors, empty DOM)
3. normal-view detector    (expected page structure)
```

Rationale: if the tool first looks for normal content and fails, it enters a
retry loop. That retry loop generates additional requests, each of which
deepens the block. By checking for blocked signals first, the tool can bail
out in a single round-trip.

### 2.2 Fail-Fast with Distinct Exit Code

When a blocked state is detected, the CLI MUST:

1. Log a human-readable diagnostic to stderr.
2. Write a structured lock file (see Section 4).
3. Exit with a **dedicated exit code** distinct from all other failure modes.

Suggested exit code allocation (fits a structured exit-code scheme):

| Code | Meaning                        |
|------|--------------------------------|
| 80   | Captcha / interactive challenge detected |
| 81   | Rate limit / throttle wall detected      |
| 82   | IP or session ban detected               |
| 83   | Account-level restriction detected       |
| 89   | Generic blocked state (unclassified)     |

These codes let wrapper scripts, CI pipelines, and orchestrators distinguish
"blocked" from "crashed" or "content not found" without parsing log text.

### 2.3 No Automatic Retries

Automatic retries after a blocked-state detection are **forbidden by design**.
The reasons are detailed in Section 7.

## 3. Detection Signal Catalog

Blocked states are identified by combining multiple signal types. No single
signal is authoritative on its own; use weighted scoring or threshold logic.

### 3.1 DOM Signals

| Signal | Detection Method | Weight |
|--------|-----------------|--------|
| Challenge iframe | `document.querySelector('iframe[src*="challenge"]')` | High |
| Captcha container | Known class/ID patterns: `.captcha`, `#captcha-box`, `[data-captcha]` | High |
| "Verify you are human" text | Regex on `document.body.innerText` | Medium |
| "Too many requests" heading | Regex match on `h1`, `h2`, `.error-title` | High |
| Checkbox challenge widget | `input[type="checkbox"]` inside challenge containers | Medium |
| Missing expected landmark | Absence of `<main>`, `<article>`, or app-specific root | Low (supporting) |

### 3.2 HTTP Signals

| Signal | Detection Method | Weight |
|--------|-----------------|--------|
| HTTP 429 Too Many Requests | CDP `Network.responseReceived` status code | High |
| HTTP 403 Forbidden | Status code on primary document request | Medium |
| HTTP 503 Service Unavailable | Status code with specific body patterns | Medium |
| `Retry-After` header present | CDP response headers inspection | High |
| Redirect to `/challenge` or `/blocked` path | URL pattern on final navigation | High |

### 3.3 Behavioral Signals

| Signal | Detection Method | Weight |
|--------|-----------------|--------|
| Repeated identical responses | Hash comparison of last N page bodies | Medium |
| Response body significantly smaller than expected | Byte-length threshold | Low |
| JavaScript-based redirect loop | Navigation event count within time window | Medium |
| Cookie clearing / session invalidation | Cookie jar delta after navigation | Low |

### 3.4 Composing Signals into a Verdict

```python
# Pseudocode: blocked-state scorer
THRESHOLD = 5

def check_blocked_state(page_context) -> BlockedVerdict | None:
    score = 0
    signals = []

    for detector in ALL_DETECTORS:
        result = detector.check(page_context)
        if result.matched:
            score += result.weight
            signals.append(result)

    if score >= THRESHOLD:
        return BlockedVerdict(
            kind=classify_signals(signals),  # captcha | rate_limit | ban | restriction
            score=score,
            signals=signals,
            timestamp=now_utc(),
        )
    return None
```

A threshold-based approach prevents false positives from a single ambiguous
signal (e.g., a 403 that is actually an authorization error, not a block).

## 4. Lock File Persistence

### 4.1 Purpose

A lock file records that a blocked state was encountered, **preventing
subsequent invocations from blindly retrying**. The lock persists until a
human explicitly releases it.

### 4.2 Location and Format

```
$WEBCTL_STATE_DIR/blocked.lock
```

Default `$WEBCTL_STATE_DIR` is `$XDG_STATE_HOME/webctl/` (typically
`~/.local/state/webctl/`). The lock file is JSON for easy inspection:

```json
{
  "locked_at": "2026-03-03T14:22:07Z",
  "exit_code": 80,
  "kind": "captcha",
  "target_domain": "example.com",
  "signals": [
    {"name": "challenge_iframe", "weight": 3},
    {"name": "verify_human_text", "weight": 2}
  ],
  "score": 5,
  "message": "Interactive captcha detected. Human intervention required.",
  "session_id": "a1b2c3d4"
}
```

### 4.3 Lock Check on Startup

Every CLI invocation MUST, before any network activity:

```
1. Check if blocked.lock exists for the target domain.
2. If present and not expired:
   a. Print diagnostic: "Blocked state active since {locked_at}. Run
      `webctl unblock` after resolving the challenge manually."
   b. Exit with the recorded exit code.
3. If absent or expired, proceed normally.
```

Optional: support a `--force` flag that bypasses the lock for advanced users,
but log a warning when it is used.

### 4.4 Lock Expiry (Optional Safety Net)

A configurable TTL (default: 24 hours) can auto-expire the lock. This prevents
permanent lockout if the operator forgets to release it. The TTL should be
generous -- the lock exists to protect the operator, not to auto-recover.

```
WEBCTL_BLOCK_LOCK_TTL=86400   # seconds, default 24h
```

## 5. Manual Release and Verification

### 5.1 Release Command

```bash
webctl unblock [--domain example.com] [--skip-verify]
```

Without `--skip-verify`, the release command performs a lightweight probe to
confirm the block has actually been resolved.

### 5.2 Verification on Unlock

The verification step:

1. Opens a headless browser session to the target domain.
2. Runs the blocked-state detector (Section 3) against the landing page.
3. If the detector returns a verdict, the lock is **not** released:
   ```
   Block still active (score=7, kind=captcha). Lock retained.
   Resolve the challenge in a real browser, then retry `webctl unblock`.
   ```
4. If the detector returns no verdict, the lock file is deleted:
   ```
   No block detected. Lock released. Normal operations may resume.
   ```

This prevents premature unlock attempts and gives the operator immediate
feedback.

### 5.3 Human-in-the-Loop Resolution Workflow

The recommended workflow when a block is encountered:

```
CLI detects block
  |
  v
Lock file written, CLI exits with code 80-89
  |
  v
Operator receives notification (exit code, stderr, lock file)
  |
  v
Operator opens a regular browser, navigates to the service
  |
  v
Operator solves captcha / waits out rate limit / contacts support
  |
  v
Operator runs: webctl unblock
  |
  v
Verification probe confirms block cleared
  |
  v
Lock file removed, CLI ready for normal use
```

## 6. Implementation Guidance

### 6.1 Detector Registration

Each detector should be a self-contained module implementing a common
interface:

```python
class BlockedStateDetector(Protocol):
    name: str
    weight: int

    def check(self, ctx: PageContext) -> DetectorResult:
        """Return matched=True if this signal is present."""
        ...
```

Detectors are registered in a list ordered by cost (cheapest first):

1. HTTP status code checks (no DOM access needed)
2. URL pattern checks (string comparison)
3. DOM queries (requires page to be loaded)
4. Behavioral checks (requires history/state)

### 6.2 Per-Domain Configuration

Different services present blocks differently. Support per-domain detector
configuration:

```toml
[blocked_state.detectors."example.com"]
extra_dom_selectors = [".custom-challenge-widget"]
extra_url_patterns = ["/security-check"]
rate_limit_header = "X-Custom-Rate-Limit"
threshold_override = 4
```

This keeps the core detection framework generic while allowing domain-specific
tuning without code changes.

### 6.3 Screenshot on Block

When a blocked state is detected, capture a screenshot before exiting:

```
$WEBCTL_STATE_DIR/blocked-screenshots/{domain}-{timestamp}.png
```

This gives the operator visual context for what the tool encountered, which
is invaluable for debugging false positives and understanding new challenge
types.

### 6.4 Exit Code Integration

The blocked-state exit codes (80-89) should be documented alongside other
exit codes in the CLI help and structured exit code registry. Wrapper scripts
can branch on these:

```bash
webctl fetch --url "https://example.com/data"
rc=$?

case $rc in
  0)   echo "Success" ;;
  80)  echo "Captcha detected, manual intervention needed" ;;
  81)  echo "Rate limited, wait and retry later" ;;
  82)  echo "IP/session banned" ;;
  1)   echo "General error" ;;
esac
```

## 7. Why Automatic Retries Are Harmful

Automatic retry after a blocked-state detection is explicitly forbidden. The
reasoning is multi-layered:

### 7.1 Escalation Risk

Each retry is an additional request from an already-flagged session. Services
commonly escalate their response:

```
First offense:  Captcha challenge (solvable, temporary)
Continued hits: Extended rate limit window (minutes -> hours)
Persistent:     IP-level ban (affects all users on that IP)
Extreme:        Account suspension or permanent ban
```

A retry loop can turn a 5-minute captcha into a 24-hour IP ban in seconds.

### 7.2 Signal Amplification

Automated retry patterns (fixed intervals, exponential backoff) are themselves
detectable signals. Sophisticated services use request timing analysis to
distinguish human retry behavior from automated retry behavior. Backing off
"politely" does not help -- the pattern itself is the signal.

### 7.3 Stale State Assumption

An automatic retry assumes the blocking condition will resolve on its own.
This is only true for transient rate limits with known `Retry-After` windows.
For captchas, interactive challenges, and account restrictions, no amount of
waiting will resolve the block without human action.

### 7.4 Data Integrity

If a retry "succeeds" by receiving an HTTP 200, the content may still be a
challenge page, a degraded view, or a honeypot. Without human verification
that the service is operating normally, automated data extraction from a
post-block session is unreliable.

### 7.5 The Correct Alternative

Instead of retrying, the tool should:

1. Record the block (lock file + screenshot + structured log).
2. Notify the operator (exit code + stderr message).
3. Stop completely.

The human decides when and how to resume. This is the only safe approach.

## 8. Observability and Logging

### 8.1 Structured Log Events

Every blocked-state detection emits a structured log entry:

```json
{
  "event": "blocked_state_detected",
  "level": "error",
  "timestamp": "2026-03-03T14:22:07Z",
  "domain": "example.com",
  "kind": "captcha",
  "score": 5,
  "signals": ["challenge_iframe", "verify_human_text"],
  "exit_code": 80,
  "lock_file": "/home/user/.local/state/webctl/blocked.lock"
}
```

### 8.2 Metrics for Monitoring

If the CLI reports to a metrics backend, track:

* `webctl_blocked_total{kind="captcha|rate_limit|ban|restriction"}` -- counter
* `webctl_blocked_duration_seconds` -- time between lock creation and release
* `webctl_blocked_false_positive_total` -- incremented when `--skip-verify`
  is used (suggests the detection was wrong)

These metrics help tune detector weights and thresholds over time.

## 9. Edge Cases and Considerations

### 9.1 Partial Blocks

Some services degrade functionality rather than fully blocking: search results
are limited, certain actions are disabled, or content is watermarked. These
are harder to detect and may not warrant a full lock. Consider a "warning"
mode that logs the degradation without locking.

### 9.2 Multi-Domain Lock Isolation

The lock file should be scoped per domain. A block on `service-a.example.com`
must not prevent operations on `service-b.example.com`:

```
$WEBCTL_STATE_DIR/blocked-{domain-hash}.lock
```

### 9.3 Concurrent CLI Invocations

If multiple CLI processes target the same domain, the lock file acts as a
shared signal. Use atomic file creation (`O_CREAT | O_EXCL` or equivalent) to
prevent race conditions. The first process to detect the block writes the lock;
subsequent processes read it and exit immediately.

### 9.4 Headless vs. Headed Detection Differences

Some challenge systems render differently in headless mode (or detect headless
and present harder challenges). The detector should account for this by:

* Running the same checks regardless of headed/headless mode.
* Including a `headless: true|false` field in the lock file for diagnostic
  context.
* Documenting that verification during `webctl unblock` uses the same browser
  mode as the original detection.

## 10. Summary

| Aspect | Decision |
|--------|----------|
| Check order | Blocked-state BEFORE normal view detection |
| On detection | Fail-fast, write lock, exit with code 80-89 |
| Automatic retry | Forbidden |
| Lock persistence | JSON file, per-domain, TTL-expirable |
| Release mechanism | `webctl unblock` with verification probe |
| Detection method | Weighted multi-signal scoring |
| Operator notification | Exit code + stderr + screenshot + lock file |
| Configuration | Per-domain detector tuning via config file |
