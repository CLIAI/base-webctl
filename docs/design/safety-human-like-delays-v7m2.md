---
id: v7m2
title: "Human-Like Operation Delays & Anti-Detection Patterns"
category: safety
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [rate-limiting, anti-detection, human-like, delays, behavioral-mimicry]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Human-Like Operation Delays & Anti-Detection Patterns

## Motivation

Automated web interactions that execute at machine speed stand out from organic
human behavior. Web services commonly deploy timing-based heuristics to
distinguish automated traffic from real users. Fixed-interval requests,
unnaturally rapid page transitions, and the absence of "reading time" between
navigations are strong signals of automation.

Introducing configurable, randomized delays between operations serves two goals:

* **Responsible automation** — respecting rate limits and terms-of-service
  expectations of the target service.
* **Operational reliability** — avoiding throttling, CAPTCHAs, or session
  termination that would break the automation run.

## Design Principle: Action, Assert, Delay

Delays are **cosmetic pacing**, not correctness gates. The canonical operation
sequence is:

```
Action  ->  Assert  ->  Delay
```

1. **Action** — perform the browser operation (click, navigate, type).
2. **Assert** — verify the expected outcome (element visible, URL changed,
   content loaded). This is the correctness gate.
3. **Delay** — pause for a randomized interval before the next action. This
   shapes the timing profile but never gates correctness.

A delay must never replace an assertion. If the assertion fails, the run should
fail immediately regardless of any pending delay.

## CLI Interface: `--delays` Flag

The `--delays` flag accepts a string specifying the delay range in seconds:

```
--delays "min~max"
```

### Accepted Formats

| Format      | Meaning                                    | Example              |
|-------------|--------------------------------------------|----------------------|
| `"0"`       | No delays (machine speed)                  | `--delays "0"`       |
| `"1.5"`     | Fixed 1.5-second delay between operations  | `--delays "1.5"`     |
| `"0.5~1.5"` | Random delay in [0.5, 1.5] seconds        | `--delays "0.5~1.5"` |

### Parsing Logic

```
function parseDelays(spec: string) -> (min: float, max: float):
    if "~" in spec:
        parts = spec.split("~", 1)
        return (float(parts[0]), float(parts[1]))
    else:
        val = float(spec)
        return (val, val)
```

When `min == max == 0`, delay calls become no-ops.

## The `opDelay` Function

All inter-operation pauses go through a single function:

```
function opDelay(label: string):
    duration = random_uniform(delayMin, delayMax)
    log_debug("delay", label=label, seconds=duration)
    sleep(duration)
```

* **`label`** — a human-readable tag for logging and debugging (e.g.,
  `"after-login"`, `"between-scroll"`, `"page-load-settle"`).
* The random value is drawn uniformly from `[delayMin, delayMax]`.
* When delays are disabled (`0~0`), the function returns immediately without
  sleeping.

## Recommended Delay Ranges by Operation Type

These ranges approximate natural human interaction cadence:

| Operation Type                | Recommended Range | Rationale                              |
|-------------------------------|-------------------|----------------------------------------|
| Between consecutive commands  | 2 -- 5 s          | Simulates reading/scanning a page      |
| Between scroll operations     | 3 -- 5 s          | Users pause to read scrolled content   |
| After navigation to new page  | 4 -- 10 s         | Users orient on new pages              |
| Simulated "reading" pauses    | 5 -- 10 s         | Occasional longer dwells on content    |
| Between form field inputs     | 0.3 -- 1.5 s      | Typing/tabbing cadence                 |

These are starting points. Actual ranges should be tuned to the specific
use-case and adjusted if throttling is observed.

## Detection Patterns to Avoid

Automation detectors look for statistical anomalies in user behavior. The
following patterns raise flags:

1. **Fixed timing intervals** — identical delays between every action produce a
   distinctive periodic signature. Always use randomized ranges, never fixed
   values in production runs.

2. **Zero reading time** — navigating to a content-heavy page and immediately
   performing the next action signals non-human behavior. Insert a
   proportionally longer delay after page navigations.

3. **High request volume** — accessing hundreds of pages in rapid succession is
   a clear automation signal. Self-impose rate limits even when the service does
   not enforce them externally.

4. **Consistent scroll distances** — scrolling by exactly the same pixel offset
   each time is unnatural. Vary scroll distances by a random factor.

5. **Missing peripheral interactions** — real users generate mouse movements,
   focus changes, and hover events. Pure keyboard-and-click automation without
   these secondary signals can be fingerprinted. Where feasible, inject
   occasional synthetic mouse movements or viewport adjustments.

## Implementation Guidance

### Configuration Precedence

Delay configuration should follow the standard precedence chain:

```
CLI flag  >  environment variable  >  config file default  >  built-in default
```

The built-in default should be a reasonable non-zero range (e.g., `"1~3"`) so
that users who forget to set delays still operate at a responsible pace.

### Logging

Every `opDelay` call should emit a debug-level log entry including:

* The label
* The computed delay duration
* The configured range

This allows post-run analysis of timing profiles and helps diagnose whether
delays are appropriate for the target service.

### Dry-Run and Testing

In dry-run or test modes, delays should be automatically set to `"0"` to avoid
slowing down test suites. The delay subsystem should expose a mechanism to
override the configured range programmatically for testing.

### Thread / Concurrency Safety

If the CLI supports concurrent operations (e.g., multiple tabs or parallel
workflows), each concurrent stream should maintain its own delay state. Delays
in one stream must not block or interfere with another.

## Responsible Use

Human-like delays are a tool for responsible automation, not for evasion.
Operators should:

* Respect the target service's terms of service and robots.txt directives.
* Use delays to reduce load on target infrastructure, not to mask abusive
  scraping at scale.
* Monitor for rate-limit responses (HTTP 429, CAPTCHA challenges) and back off
  further when they occur.
* Prefer official APIs when available; browser automation with delays is a
  fallback for cases where no API exists.

## Summary

The delay subsystem is a small but critical piece of responsible browser
automation. By randomizing inter-operation pauses through a single `opDelay`
function, configurable via `--delays "min~max"`, the CLI produces a timing
profile that respects target services and avoids common anti-automation
heuristics. Delays are always subordinate to assertions in the Action-Assert-
Delay pipeline and never replace correctness checks.
