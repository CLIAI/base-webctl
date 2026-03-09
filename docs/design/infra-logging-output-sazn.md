---
id: sazn
title: "Logging, Caching & Output Conventions"
category: infra
created: "2026-03-09"
updated: "2026-03-09"
status: draft
tags: [logging, cache, output, jsonl, verbosity, files]
tech: []
relates_to: [f868, 2fc5]
depends_on: []
expands: []
similar_to: []
---

# Logging, Caching & Output Conventions

## Purpose

Standardizes how webctl tools handle log output, content caching, and
file downloads/exports. Covers verbosity levels, log format, cache file
naming, atomic writes, and output directory conventions.

## Log Output

### Verbosity Levels

| Flag | Level | Value | Output |
|------|-------|-------|--------|
| `-q` / `--quiet` | quiet | -1 | suppress all stderr |
| (default) | warn | 0 | warnings only |
| `-v` | info | 1 | informational messages |
| `-vv` | debug | 2 | debug detail |
| `-vvv` | trace | 3 | full trace |

All log levels write to **stderr**. Structured data output uses **stdout**
(via a separate `logOut()` function). This separation enables piping tool
output while preserving diagnostic messages.

### File Logging (Optional)

Tools **may** implement file logging for cron/automation use cases.
When implemented:

**Directory:** `{cache_root}/logs/`

**File naming:** `{ISO-timestamp}-{PID}.jsonl`
(timestamp format: `YYYY-MM-DDTHH-mm-ss`, colons replaced with hyphens)

**Format:** JSONL — one JSON object per line:

```json
{"ts":"2026-03-09T14:22:07.123Z","level":"WARN","pid":12345,"msg":"..."}
```

**Rotation defaults:** max 8 files, max 50 MB each.

**Configuration:**

| Flag / Variable | Purpose |
|-----------------|---------|
| `--log-dir <d>` | Override log directory |
| `--no-log` | Disable file logging entirely |

## Content Cache Files

Cached content (conversations, extracted data, API responses) stored per
resource:

```
{cache_dir}/{resource-id}.{tool}-{type}.json
```

* **resource-id** — unique identifier; must match `^[a-zA-Z0-9-]+$`
  (alphanumeric + hyphens, filesystem-safe)
* **tool** — tool name for namespace isolation
* **type** — content type descriptor (e.g., `conversation`, `profile`)

### Cache Configuration

| Flag / Variable | Purpose |
|-----------------|---------|
| `--cache-dir <d>` | Override cache directory |
| `--no-cache` | Disable cache reads/writes entirely |
| `{ORG}_{TOOL}_CACHE_DIR` | Environment variable override |

### Atomic Writes

All cache and state file writes use temp-file-then-rename:

```
writeFileSync(tmpPath, data)
renameSync(tmpPath, finalPath)    # atomic on POSIX
```

Prevents corruption if process is killed mid-write. This pattern applies
to all JSON state files (cache, tab-activity ledger, blocked lock).

## Output & Download Files

### Output Directory

Configurable via `--output-dir <d>` or `{ORG}_{TOOL}_OUTPUT_DIR`.
Defaults to current working directory.

### Output File Naming

```
{prefix}--{descriptor}.{extension}
```

Examples: `post--image-0.jpeg`, `thread--export.jsonl`, `screenshot-{timestamp}.png`

### Structured Export Formats

| Format | Extension | Purpose |
|--------|-----------|---------|
| JSONL | `.{tool}-{type}.jsonl` | Machine-readable, one record per line |
| Markdown | `.{tool}-{type}.md` | Human-readable |
| HTML | `.{tool}-{type}.html` | Styled, self-contained |

### Temporary Working Directories

For multi-step file assembly (e.g., video segment concatenation):

```
{output_dir}/.{operation}-tmp/
```

Hidden prefix (`.`) prevents confusion with final output files.

## Implementation Checklist

* [ ] Implement `-q`/`-v`/`-vv`/`-vvv` verbosity flags with stderr output
* [ ] Separate structured output (stdout) from diagnostics (stderr)
* [ ] Use atomic temp-file-then-rename for all JSON state writes
* [ ] Validate resource-id format: `^[a-zA-Z0-9-]+$`
