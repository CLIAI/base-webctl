---
id: v7m2
title: "Logging, Verbosity & Output Stream Separation"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [logging, verbosity, stderr, stdout, output-separation, diagnostics]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Logging, Verbosity & Output Stream Separation

## Motivation

CLI tools that mix diagnostic output with data output break pipelines. When a
user writes `tool extract --jsonl | jq .status`, log messages interleaved on
stdout corrupt the JSON stream. Separating concerns at the stream level is the
foundation of composable command-line tooling.

This document establishes the output stream contract for all web-control CLI
tools and defines a uniform verbosity model that every command must honour.

## Core Principle: Stream Separation

```
stdout  →  DATA / RESULTS  →  consumed by pipes, scripts, downstream tools
stderr  →  DIAGNOSTICS     →  consumed by humans, monitoring, log aggregators
```

**stdout** carries *only* machine-parseable or human-requested results: JSON
lines, extracted text, CSV rows, or formatted tables when the user explicitly
asks for them.

**stderr** carries *everything else*: progress indicators, warnings, debug
traces, timing information, configuration hints.

This separation enables clean pipelines:

```bash
tool navigate --url "..." --screenshot out.png 2>/dev/null   # silence logs
tool extract --jsonl 2>debug.log | jq '.[] | .title'         # capture logs separately
tool batch urls.txt --jsonl 2>&1 | tee full.log              # merge when desired
```

## Verbosity Levels

All tools share a five-tier verbosity model controlled by flags on every
command.

| Level | Flag        | Mnemonic | What appears on stderr              |
|-------|-------------|----------|-------------------------------------|
| -1    | `-q`        | quiet    | Fatal errors only                   |
| 0     | *(default)* | normal   | Errors and warnings                 |
| 1     | `-v`        | info     | Configuration hints, progress bars  |
| 2     | `-vv`       | debug    | Protocol commands, timing, retries  |
| 3     | `-vvv`      | trace    | Raw wire frames, full DOM snapshots |

### Flag Conventions

* `-q` / `--quiet` sets level -1.
* Each additional `-v` increments the level: `-v` = 1, `-vv` = 2, `-vvv` = 3.
* `--verbosity N` allows setting the level directly for scripting.
* Flags are additive and idempotent at their max tier.

### Interaction with `--json` / `--jsonl`

When the caller requests structured output (`--json`, `--jsonl`), the tool
**must not** emit anything on stdout except the requested format. Verbosity
flags affect only stderr. This is non-negotiable for pipeline safety.

## Implementation Pattern

### Module-Level Verbosity

Each module exposes a `setVerbosity(level)` function (or equivalent
language-idiomatic construct). This function:

1. Stores the current verbosity level in module-scoped state.
2. Conditionally emits log calls only when the message's level is at or below
   the current threshold.

```
setVerbosity(2)          # enable debug output
log.info("loading...")   # level 1 → shown
log.debug("retry #3")   # level 2 → shown
log.trace("frame 0x...")  # level 3 → suppressed
```

### Log Message Format

Diagnostic messages on stderr follow a predictable structure:

```
[LEVEL] [TIMESTAMP] [MODULE] message
```

Example:

```
[DEBUG] [14:32:01.003] [navigate] retrying after timeout (attempt 2/3)
[WARN]  [14:32:04.112] [extract]  selector matched 0 elements
[TRACE] [14:32:04.115] [ws]       ← {"method":"Page.loadEventFired",...}
```

Fields:

* **LEVEL** — uppercase, fixed-width (5 chars padded).
* **TIMESTAMP** — `HH:MM:SS.mmm` local time; sufficient for interactive use.
* **MODULE** — short identifier for the subsystem emitting the message.
* **message** — free-form, single line preferred.

### Explicit Data Output

Provide a dedicated function (e.g., `logOut()`, `emitResult()`) that writes
exclusively to stdout. Application code must never use generic print/log calls
for result data. This makes accidental stream contamination a code review
signal.

```
logOut(jsonLine)     // → stdout
log.info("done")     // → stderr
```

## File-Based Logging

For long-running or batch operations, tools should support persistent log files
in addition to stderr.

### Configuration

* `--log-file PATH` — write structured logs to the specified file.
* `--log-format text|jsonl` — choose between human-readable and machine-parseable.
* Default file format is **JSONL** (one JSON object per line) for programmatic
  consumption.

### JSONL Log Schema

```json
{
  "ts": "2026-03-03T14:32:01.003Z",
  "level": "DEBUG",
  "module": "navigate",
  "msg": "retrying after timeout",
  "data": { "attempt": 2, "max": 3 }
}
```

### Rotation

When file logging is enabled:

* Rotate when a single file exceeds a configurable size limit (default: 50 MB).
* Keep at most N rotated files (default: 5).
* Name rotated files with an incrementing suffix: `tool.log.1`, `tool.log.2`, etc.
* Atomic-ish open: attempt to create the file exclusively; on failure, log a
  warning to stderr and continue without file logging rather than crashing.

## Error Handling at the Output Boundary

* If writing to stdout fails (broken pipe), exit immediately with a non-zero
  status. Do not attempt to log to stdout about the failure.
* If writing to stderr fails, degrade silently — there is nowhere to report the
  error.
* If writing to the log file fails, emit a single warning to stderr and disable
  file logging for the remainder of the session.

## Testing Expectations

* **Stream purity tests** — pipe stdout through a strict JSON parser; any
  parse failure indicates stream contamination.
* **Verbosity gate tests** — at each level, assert that messages above the
  threshold are absent from stderr.
* **Quiet mode test** — with `-q`, only fatal errors appear; stdout remains
  valid.
* **Broken pipe test** — send stdout to a process that closes early; verify
  clean exit without panic or stderr spam.

## Summary

| Concern             | Stream   | Controlled by     |
|---------------------|----------|-------------------|
| Results / data      | stdout   | `--json`, `--jsonl` |
| Diagnostics / logs  | stderr   | `-q`, `-v`, `-vv`, `-vvv` |
| Persistent logs     | file     | `--log-file`, `--log-format` |

The contract is simple: **stdout is sacred**. Nothing touches it except
explicitly requested output. Everything else flows to stderr or log files.
