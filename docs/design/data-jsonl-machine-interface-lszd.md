---
id: lszd
title: "JSONL Machine-Readable Output Convention"
category: data
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [jsonl, machine-output, structured-data, streaming, typed-events, pipeline]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# JSONL Machine-Readable Output Convention

## Problem

CLI tools that automate web interactions produce output consumed by two
distinct audiences: humans reading a terminal and programs parsing structured
data. Mixing the two forces downstream scripts into fragile screen-scraping of
free-form text, breaking on cosmetic changes.

A first-class **machine-readable mode** that emits one JSON object per line
(JSONL / JSON Lines) solves this cleanly while keeping human output as the
default.

## Design Principles

* **Opt-in, not default.** Human-friendly output remains the default. Machine
  output is activated by an explicit flag.
* **One object per line.** Each line is a self-contained JSON object,
  parseable independently. No multi-line pretty-printing.
* **Typed events.** Every object carries a `type` field so consumers can
  dispatch without inspecting payload shape.
* **Timestamps everywhere.** Every event includes an ISO-8601 `ts` field for
  log correlation, latency measurement, and audit trails.
* **Stderr for diagnostics.** Human-readable warnings and debug output go to
  stderr, keeping stdout clean for JSONL when in machine mode.

## The `--jsonl` Flag

Every subcommand that produces output MUST accept `--jsonl`. When present:

1. Stdout emits **only** valid JSONL -- one JSON object per `\n`-terminated
   line.
2. Human-formatted output (tables, coloured text, progress bars) is
   suppressed on stdout.
3. Diagnostic and debug messages go to stderr.
4. Exit codes remain unchanged (see structured exit codes design doc).

```
# Human mode (default)
$ webctl fetch --url "https://example.com/data"
Title: Example Page
Items: 42

# Machine mode
$ webctl fetch --url "https://example.com/data" --jsonl
{"type":"result","ts":"2026-03-03T14:22:01.003Z","title":"Example Page","items":42}

# Pipeline: machine mode, stderr silenced, piped into jq
$ webctl fetch --url "https://example.com/data" --jsonl 2>/dev/null | jq .
```

### Flag Registration Pattern

```typescript
// In argument parser setup
program
  .option("--jsonl", "Emit machine-readable JSONL to stdout")
  .action((opts) => {
    const ctx = createContext({ jsonl: opts.jsonl ?? false });
    runCommand(ctx);
  });
```

```python
# argparse equivalent
parser.add_argument(
    "--jsonl",
    action="store_true",
    default=False,
    help="Emit machine-readable JSONL to stdout",
)
```

## Event Envelope

Every JSONL object conforms to a minimal envelope:

```json
{
  "type": "<event-type>",
  "ts": "<ISO-8601 timestamp with milliseconds>"
}
```

Additional fields depend on `type`. Unknown fields MUST be tolerated by
consumers (forward-compatibility).

### Canonical Event Types

| Type        | Purpose                                  | Required Fields             |
|-------------|------------------------------------------|-----------------------------|
| `result`    | Primary output data                      | `type`, `ts`, + payload     |
| `error`     | Fatal or recoverable error               | `type`, `ts`, `message`, `code` |
| `warning`   | Non-fatal condition worth noting         | `type`, `ts`, `message`     |
| `progress`  | Long-running operation status            | `type`, `ts`, `current`, `total`, `label` |
| `heartbeat` | Liveness signal during idle periods      | `type`, `ts`                |
| `meta`      | Run metadata (versions, config digest)   | `type`, `ts`, + payload     |
| `debug`     | Verbose diagnostic (only with `--debug`) | `type`, `ts`, `message`     |

### Event Examples

**result** -- the primary data payload. Shape varies per subcommand:

```json
{"type":"result","ts":"2026-03-03T14:22:01.003Z","url":"https://example.com","status":200,"title":"Example","items_found":17}
```

**error** -- structured error with machine-parseable code:

```json
{"type":"error","ts":"2026-03-03T14:22:02.117Z","code":"ETIMEOUT","message":"Navigation timed out after 30000ms","url":"https://example.com/slow"}
```

**warning** -- non-fatal issue:

```json
{"type":"warning","ts":"2026-03-03T14:22:01.500Z","message":"Element not found, using fallback selector","selector":"#primary-nav"}
```

**progress** -- for long-running multi-step operations:

```json
{"type":"progress","ts":"2026-03-03T14:22:03.200Z","current":7,"total":25,"label":"Processing page 7 of 25"}
```

**heartbeat** -- emitted periodically during waits to signal liveness:

```json
{"type":"heartbeat","ts":"2026-03-03T14:25:00.000Z"}
```

**meta** -- emitted once at startup for provenance:

```json
{"type":"meta","ts":"2026-03-03T14:22:00.001Z","tool_version":"0.4.1","command":"fetch","args_hash":"a1b2c3d4"}
```

## The `emitResult()` Dual-Mode Pattern

The core abstraction: a single function that writes human output OR JSONL
depending on context, so command implementations never branch on mode.

### TypeScript Implementation

```typescript
interface OutputContext {
  jsonl: boolean;
  stream: NodeJS.WritableStream; // defaults to process.stdout
}

function emitEvent(ctx: OutputContext, event: Record<string, unknown>): void {
  const envelope = {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
  };
  ctx.stream.write(JSON.stringify(envelope) + "\n");
}

function emitResult(
  ctx: OutputContext,
  data: Record<string, unknown>,
  humanFormat: () => string,
): void {
  if (ctx.jsonl) {
    emitEvent(ctx, { type: "result", ...data });
  } else {
    process.stdout.write(humanFormat() + "\n");
  }
}

function emitError(
  ctx: OutputContext,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (ctx.jsonl) {
    emitEvent(ctx, { type: "error", code, message, ...extra });
  } else {
    process.stderr.write(`Error [${code}]: ${message}\n`);
  }
}

function emitProgress(
  ctx: OutputContext,
  current: number,
  total: number,
  label: string,
): void {
  if (ctx.jsonl) {
    emitEvent(ctx, { type: "progress", current, total, label });
  } else {
    const pct = Math.round((current / total) * 100);
    process.stderr.write(`\r[${pct}%] ${label}`);
  }
}

function emitWarning(ctx: OutputContext, message: string): void {
  if (ctx.jsonl) {
    emitEvent(ctx, { type: "warning", message });
  } else {
    process.stderr.write(`Warning: ${message}\n`);
  }
}
```

### Python Implementation

```python
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


@dataclass
class OutputContext:
    jsonl: bool = False
    stream: Any = field(default_factory=lambda: sys.stdout)


def emit_event(ctx: OutputContext, event: dict[str, Any]) -> None:
    event.setdefault("ts", datetime.now(timezone.utc).isoformat())
    ctx.stream.write(json.dumps(event, default=str) + "\n")
    ctx.stream.flush()


def emit_result(
    ctx: OutputContext,
    data: dict[str, Any],
    human_format: Callable[[], str],
) -> None:
    if ctx.jsonl:
        emit_event(ctx, {"type": "result", **data})
    else:
        print(human_format())


def emit_error(
    ctx: OutputContext,
    code: str,
    message: str,
    **extra: Any,
) -> None:
    if ctx.jsonl:
        emit_event(ctx, {"type": "error", "code": code, "message": message, **extra})
    else:
        print(f"Error [{code}]: {message}", file=sys.stderr)


def emit_progress(
    ctx: OutputContext,
    current: int,
    total: int,
    label: str,
) -> None:
    if ctx.jsonl:
        emit_event(ctx, {
            "type": "progress",
            "current": current,
            "total": total,
            "label": label,
        })
    else:
        pct = round(current / total * 100)
        print(f"\r[{pct}%] {label}", end="", file=sys.stderr)
```

### Usage in a Command

```typescript
async function fetchCommand(ctx: OutputContext, url: string): Promise<void> {
  // Emit provenance metadata
  if (ctx.jsonl) {
    emitEvent(ctx, {
      type: "meta",
      tool_version: VERSION,
      command: "fetch",
    });
  }

  try {
    const page = await browser.navigate(url);

    emitResult(
      ctx,
      { url, status: page.status, title: page.title, items: page.items },
      () => [
        `Title:  ${page.title}`,
        `Status: ${page.status}`,
        `Items:  ${page.items.length}`,
      ].join("\n"),
    );
  } catch (err) {
    emitError(ctx, "EFETCH", err.message, { url });
    process.exitCode = 1;
  }
}
```

## Streaming JSONL for Real-Time Updates

JSONL is inherently streaming: each line is independently parseable. This
makes it ideal for long-running operations that produce results
incrementally.

### Stream Flushing

Every `emitEvent` call MUST flush the output buffer. Buffered I/O defeats
the purpose of streaming. In Node.js, `process.stdout.write()` flushes
automatically when connected to a pipe. In Python, call `stream.flush()`
after each write or open stdout with `buffering=1` (line-buffered).

### Heartbeat Emission

For operations that may be idle for extended periods (waiting for page load,
polling for state changes), emit heartbeat events at a regular interval
(recommended: every 5-15 seconds) so consumers can distinguish "idle" from
"dead":

```typescript
function startHeartbeat(ctx: OutputContext, intervalMs = 10_000): () => void {
  if (!ctx.jsonl) return () => {};

  const timer = setInterval(() => {
    emitEvent(ctx, { type: "heartbeat" });
  }, intervalMs);

  return () => clearInterval(timer);
}

// Usage
const stopHeartbeat = startHeartbeat(ctx);
try {
  await longRunningOperation();
} finally {
  stopHeartbeat();
}
```

### Multi-Result Streaming

When a command produces multiple results (e.g., iterating over a list of
pages), emit each result as a separate JSONL line as it becomes available:

```typescript
async function batchFetch(ctx: OutputContext, urls: string[]): Promise<void> {
  for (let i = 0; i < urls.length; i++) {
    emitProgress(ctx, i + 1, urls.length, `Fetching ${urls[i]}`);

    try {
      const page = await browser.navigate(urls[i]);
      emitResult(
        ctx,
        { url: urls[i], status: page.status, title: page.title },
        () => `  [${page.status}] ${page.title}`,
      );
    } catch (err) {
      emitError(ctx, "EFETCH", err.message, { url: urls[i] });
    }
  }
}
```

Consumer side -- process results as they arrive:

```bash
webctl batch-fetch --file urls.txt --jsonl 2>/dev/null \
  | while IFS= read -r line; do
      type=$(echo "$line" | jq -r .type)
      case "$type" in
        result)   echo "$line" | jq '{url, title}' ;;
        error)    echo "$line" | jq -r .message >&2 ;;
        progress) ;;  # ignore progress in pipeline
      esac
    done
```

## Pipeline Compatibility

### Canonical Pipeline Patterns

```bash
# Extract specific fields
webctl search --query "test" --jsonl 2>/dev/null | jq -r '.title'

# Filter by type
webctl monitor --jsonl 2>/dev/null | jq 'select(.type == "result")'

# Count results
webctl scan --jsonl 2>/dev/null | jq 'select(.type == "result")' | wc -l

# Convert to CSV
webctl list --jsonl 2>/dev/null \
  | jq -r 'select(.type == "result") | [.name, .value] | @csv'

# Feed into another tool
webctl export --jsonl 2>/dev/null \
  | jq -r 'select(.type == "result") | .url' \
  | xargs -I{} webctl fetch --url "{}" --jsonl

# Aggregate with jq slurp
webctl report --jsonl 2>/dev/null \
  | jq -s '[.[] | select(.type == "result")] | length'
```

### Stderr Separation Convention

Stderr carries all non-data output in both modes:

* Human mode: progress bars, spinner animations, colour-coded warnings.
* JSONL mode: only truly unexpected diagnostics (e.g., stack traces on crash).

This ensures `2>/dev/null` is always safe in pipelines and stdout is always
pure data.

### Exit Codes

Exit codes are orthogonal to output format. A command that fails MUST still
emit a structured `error` event before exiting with a non-zero code:

```
$ webctl fetch --url "https://unreachable.test" --jsonl; echo "exit: $?"
{"type":"error","ts":"2026-03-03T14:22:02.117Z","code":"ECONNREFUSED","message":"Connection refused"}
exit: 2
```

## Testing JSONL Output

### Validation Helper

```bash
#!/usr/bin/env bash
# validate-jsonl.sh -- verify every line is valid JSON with required fields
set -euo pipefail

while IFS= read -r line; do
  if ! echo "$line" | jq -e '.type and .ts' >/dev/null 2>&1; then
    echo "INVALID: $line" >&2
    exit 1
  fi
done

echo "All lines valid JSONL with type+ts fields."
```

Usage:

```bash
webctl fetch --url "https://example.com" --jsonl 2>/dev/null \
  | ./validate-jsonl.sh
```

### Snapshot Testing

Capture JSONL output, strip volatile fields (`ts`), and compare against
expected output:

```bash
webctl fetch --url "https://example.com" --jsonl 2>/dev/null \
  | jq 'del(.ts)' \
  > actual.jsonl

diff expected.jsonl actual.jsonl
```

## Anti-Patterns

* **Pretty-printing JSON in `--jsonl` mode.** Multi-line JSON breaks
  line-oriented consumers. Always use compact single-line serialization.

* **Mixing human text into stdout under `--jsonl`.** Every byte on stdout
  must be valid JSONL. Log messages, banners, and tips go to stderr or are
  suppressed entirely.

* **Omitting `type` from events.** Without a type discriminator, consumers
  must guess payload shape. Every event gets a `type`.

* **Omitting `ts` from events.** Timestamps cost almost nothing and enable
  latency analysis, log correlation, and ordering guarantees.

* **Buffering all output until completion.** Emit events as they occur.
  JSONL's line-per-event design exists to enable streaming.

* **Using `--json` to mean JSONL.** The flag is `--jsonl` (note the "L")
  to signal line-delimited output. `--json` could imply a single JSON
  document wrapping all output, which is a different (and less
  pipeline-friendly) convention.

## Summary

The `--jsonl` convention gives every CLI subcommand a clean machine interface
with zero ambiguity:

* Opt-in via `--jsonl` flag
* Every line: `{"type":"...","ts":"...","..."}`
* `emitResult()` / `emitError()` / `emitProgress()` handle dual-mode output
* Streaming by default, heartbeats for liveness
* Pipeable: `tool --jsonl 2>/dev/null | jq .`
