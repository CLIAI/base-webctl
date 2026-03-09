---
id: bu0y
title: "Filesystem Layout Conventions: Unified Path Patterns for CLI Tools"
category: infra
created: "2026-03-09"
updated: "2026-03-09"
status: draft
tags: [filesystem, xdg, paths, config, cache, locks, logs, conventions, layout]
tech: []
relates_to: [r7m3, v8m2, k7m2, 1wsg]
depends_on: []
expands: [r7m3]
similar_to: []
---

# Filesystem Layout Conventions: Unified Path Patterns for CLI Tools

> **REVIEW NOTE:** This is a first draft compiled from patterns observed across
> multiple tool implementations. Commentary blocks marked with `<!-- REVIEW: ... -->`
> provide context on divergences, trade-offs, and open decisions for the reviewer.
> After review, these should be compressed or removed.

## Purpose

This document defines the filesystem layout that all tools in the framework
should follow for configuration, cache, locks, logs, browser profiles, and
output data. A unified layout ensures:

* Operators can predict where any tool stores its files.
* Tools coexist without path collisions.
* Scripts and monitoring tools can inspect state across all tools uniformly.
* New tool authors have a clear blueprint to follow.

---

## 1. Naming Conventions

### 1.1 Organization and Tool Names

All paths incorporate two naming segments:

```
{ORG}     — Organization-level namespace (e.g., "CLIAI", "ctlai")
{TOOL}    — Specific tool name, lowercase with hyphens (e.g., "my-webctl")
```

**Casing rules:**

| Context | Casing | Example |
|---------|--------|---------|
| Directory paths | lowercase | `~/.config/cliai/my-webctl/` |
| Environment variables | UPPERCASE, hyphens → underscores | `CLIAI_MY_WEBCTL_PORT` |
| Dotenv filenames | lowercase, preserving hyphens | `.env.my-webctl` |

<!-- REVIEW: Existing implementations use mixed casing for the org segment in
paths — some use `CLIAI/` (uppercase), others use `ctlai/` (lowercase). The
canonical form needs to be decided. Recommendation: pick one (lowercase `cliai/`
aligns with XDG conventions) and alias the other during a migration period. -->

### 1.2 Environment Variable Prefix

```
{ORG}_{TOOL}_{SETTING}
```

Three segments, all uppercase, underscores between:

* **ORG** — organization namespace
* **TOOL** — tool name (hyphens become underscores)
* **SETTING** — the specific knob

This makes `env | grep CLIAI_` a quick way to see all tool configuration.

### 1.3 Legacy Variable Support

Older tools may have used shorter prefixes (e.g., `WEBCTL_PORT`) or unprefixed
names (e.g., `BROWSER_PORT`). These are recognized in the precedence chain
(above defaults, below dotenv) and trigger a deprecation warning:

```
WARN: WEBCTL_PORT is deprecated. Use CLIAI_MY_WEBCTL_PORT instead.
```

---

## 2. Directory Structure Overview

```
~/.config/{org}/
  ├── {tool}/
  │   ├── .env.{tool}                    # XDG-style global dotenv (§3)
  │   └── profile/                       # persistent browser profile (§7)
  ├── default/
  │   └── webctl/
  │       └── {tool}.config.jsonc        # structured config file (§4)
  └── {client}/                          # per-client profile (§4)
      └── webctl/
          └── {tool}.config.jsonc

~/.cache/{org}/
  ├── default/
  │   └── webctl/
  │       ├── locks/
  │       │   └── port-{PORT}.lock/      # process mutex (§6)
  │       ├── logs/
  │       │   └── {timestamp}-{pid}.jsonl # structured logs (§8)
  │       ├── tab-activity.json          # LRU tracking ledger (§9)
  │       ├── blocked.lock.json          # blocked state marker (§10)
  │       └── {id}.{tool}-{type}.json    # content cache files (§5)
  └── {tool}/                            # tool-specific cache (Option B, §2.1)
      └── locks/
          └── port-{PORT}.lock/

{project}/
  ├── .env.{tool}                        # project-local dotenv (§3)
  └── dotenv.{tool}.example              # tracked template (§3)
```

### 2.1 Cache Directory Namespacing: Two Options

<!-- REVIEW: Two approaches exist in current implementations. This needs to be
resolved to one canonical pattern. Both are documented here for review. -->

**Option A — Shared namespace (recommended):**

```
~/.cache/{org}/default/webctl/locks/port-{PORT}.lock/
~/.cache/{org}/default/webctl/tab-activity.json
```

Multiple tools share a single `default/webctl/` subtree. This enables shared
tab-activity tracking and cross-tool lock visibility. The `default` segment
supports future per-client isolation via `{client}/webctl/`.

**Option B — Per-tool namespace:**

```
~/.cache/{org}/{tool}/locks/port-{PORT}.lock/
~/.cache/{org}/{tool}/tab-activity.json
```

Each tool has its own subtree. Simpler isolation, but prevents shared state
(e.g., a single tab-activity ledger across tools that control the same browser).

**Trade-offs:**

| Concern | Option A (shared) | Option B (per-tool) |
|---------|-------------------|---------------------|
| Cross-tool lock visibility | Yes — can see all port locks | No — separate directories |
| Shared tab activity | Yes — one ledger | No — separate ledgers |
| Collision risk | Low (port-scoped locks) | None |
| Cleanup simplicity | One directory to monitor | Per-tool cleanup scripts |
| Multi-client support | Built-in (`{client}/`) | Requires additional nesting |

---

## 3. Dotenv Configuration Files

### 3.1 File Naming

| File | Purpose | Git-tracked |
|------|---------|-------------|
| `.env.{tool}` | Active configuration with real values | **No** (gitignored via `.env.*`) |
| `dotenv.{tool}.example` | Template with commented defaults | **Yes** |

The template uses a `dotenv.` prefix (not `.env.`) intentionally — this
prevents `.env*` gitignore globs from accidentally ignoring the template.

### 3.2 Template Format

```bash
# Port for the browser bridge server.
# Type: integer  Default: 4327
# CLIAI_MY_WEBCTL_PORT=4327

# Browser profile directory.
# Type: path  Default: ~/.config/cliai/my-webctl/profile
# CLIAI_MY_WEBCTL_USER_DATA_DIR=
```

Every variable is commented out with its type and default documented inline.

### 3.3 Discovery Locations

The loader searches in order; **first file found wins** (no merging):

```
1. $CWD/.env.{tool}                         # project-local
2. ~/.config/{org}/{tool}/.env.{tool}        # XDG-style global
   OR  ~/.env.{tool}                         # home-directory shorthand
3. (none found → use defaults)
```

### 3.4 Ambiguity: Both Global Locations Exist

<!-- REVIEW: Two approaches exist. The choice affects user experience when
migrating from home-shorthand to XDG-style.

Option A (warning): Prefer XDG, emit WARN, continue. Pros: non-breaking,
gradual migration. Cons: silent config shadowing may confuse.

Option B (hard error): Print both paths, exit with error. Pros: no ambiguity,
forces cleanup. Cons: breaks existing setups on upgrade.

Recommendation: Option A for existing tools, Option B for new tools. -->

**Option A — Warning:** Prefer XDG-style path, emit a warning naming both
files, continue operation.

**Option B — Hard error:** Print both paths, refuse to start. The operator
must remove one.

### 3.5 Missing Dotenv Behavior

When no `.env.{tool}` is found, the tool starts normally using defaults. At
verbose log level, an INFO message notes:

```
INFO: No .env.my-webctl found; using defaults. Copy dotenv.my-webctl.example to get started.
```

### 3.6 Zero-Dependency Parser Rules

All implementations must use an in-tree parser (no external library):

1. **Blank lines** — skipped.
2. **Comment lines** — first non-whitespace is `#` → skip.
3. **Key-value** — split on first `=`, trim whitespace.
4. **Quoted values** — matching outer `'` or `"` stripped; no escape processing.
5. **No variable expansion** — `$VAR` is literal (avoids injection).
6. **No multi-line** — one key-value per line.
7. **`export` prefix** — `export KEY=val` strips the prefix before parsing.
8. **Unmatched quotes** — keep as literal, emit WARN with line number.
9. **Duplicate keys** — last wins, DEBUG-level warning.

### 3.7 Gitignore Patterns

```gitignore
# Dotenv files contain secrets
.env.*
*.env

# But track the example templates
!dotenv.*.example
```

---

## 4. Structured Configuration Files (Optional Layer)

<!-- REVIEW: Currently implemented by only one tool. Consider whether this
layer is worth standardizing or should remain tool-specific. The dotenv
layer alone covers most use cases. The structured config adds value for:
complex model aliases, per-client profiles, nested settings. -->

For tools requiring richer configuration than key-value pairs, a JSONC
config file provides an additional layer:

```
~/.config/{org}/default/webctl/{tool}.config.jsonc
~/.config/{org}/{client}/webctl/{tool}.config.jsonc
```

**Format:** JSON with `//` and `/* */` comments, stripped by a zero-dependency
character-by-character scanner (no regex, preserves strings).

**Client profiles:** The `--client {name}` flag selects a named profile
directory. `default` is used when no client is specified.

**Merge semantics:** Shallow merge of top-level keys; specific keys (e.g.,
alias maps) may use deep merge as documented per-tool.

**Introspection subcommands:**

* `config list` — show all config sources and their paths
* `config show` — show effective merged values
* `config path` — print paths being searched

---

## 5. Content Cache Files

Cached content (conversations, extracted data, API responses) is stored per
resource:

```
{cache_dir}/{resource-id}.{tool}-{type}.json
```

* **resource-id** — unique identifier for the cached resource (e.g., thread
  ID, conversation ID). Must match `^[a-f0-9-]+$` (hex + hyphens).
* **tool** — tool name for namespace isolation.
* **type** — content type descriptor (e.g., `conversation`, `profile`).

### 5.1 Cache Configuration

| Flag / Variable | Purpose |
|-----------------|---------|
| `--cache-dir <d>` | Override cache directory |
| `--no-cache` | Disable cache reads/writes entirely |
| `{ORG}_{TOOL}_CACHE_DIR` | Environment variable override |

### 5.2 Atomic Writes

All cache writes use the temp-file-then-rename pattern:

```
writeFileSync(tmpPath, data)
renameSync(tmpPath, finalPath)    # atomic on POSIX
```

This prevents corruption if the process is killed mid-write.

---

## 6. Process Mutex Lock Files

Lock files serialize access to shared resources (typically a browser instance
bound to a specific port).

### 6.1 Lock Path

```
{cache_root}/locks/port-{PORT}.lock/
```

The lock is a **directory** (not a file) — `mkdir` is used as an atomic
acquisition primitive.

### 6.2 Lock Contents

<!-- REVIEW: Two formats exist in current implementations.

Minimal format: just a `pid` file. Simpler, less diagnostic info.

Rich format: `lock.json` with pid, command, subcommand, startedAt, etc.
Enables better wait-progress reporting and debugging.

Recommendation: Standardize on `lock.json` (rich format). The `pid` file
can coexist for backward compatibility during migration. -->

**Minimal format:**

```
port-{PORT}.lock/
  pid                    # text file containing PID number
```

**Rich format:**

```
port-{PORT}.lock/
  lock.json              # structured metadata
```

```json
{
  "pid": 48217,
  "command": "send",
  "subcommand": "message",
  "port": 4327,
  "startedAt": "2026-03-09T14:22:07.123Z"
}
```

### 6.3 Lock Mechanism

* **Primary:** `flock` (advisory file lock) — auto-released by kernel on
  process exit/crash. No signal handlers needed for cleanup.
* **Fallback:** `mkdir` (atomic POSIX operation) — requires PID-based stale
  detection and signal handlers for cleanup.

<!-- REVIEW: All current implementations use mkdir exclusively. The flock
approach is documented in base design but not yet implemented, likely because
Node.js lacks native flock without a C addon. The mkdir approach works
reliably. Consider whether to keep flock as the "recommended primary" or
acknowledge mkdir as the de facto standard. -->

### 6.4 Stale Lock Detection (mkdir only)

```
processExists(pid):
    kill(pid, 0)         # signal 0 = existence check
    ESRCH → stale        # No Such Process
    EPERM → alive        # exists but different user
    success → alive
```

### 6.5 Configurable Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Lock timeout | 30s | Max wait before returning timeout exit code |
| Retry interval | 200ms | Polling frequency when lock is held |
| Progress interval | 5s | How often to log "waiting for lock" messages |
| Long-wait threshold | 600s | When to warn about possibly stuck holder |

### 6.6 Exit Codes

A dedicated exit code for lock timeout (distinct from 0=success, 1=error,
2=blocked). The specific value is project-defined but must:

* Not collide with 1-2 or 128+N (signal exits)
* Be documented and consistent across all tools

<!-- REVIEW: Current implementations use exit code 3 and 4 for lock timeout.
Should standardize on one value. -->

---

## 7. Browser Profiles

### 7.1 Persistent Profile

```
{ORG}_{TOOL}_USER_DATA_DIR     # environment variable
```

Typical convention: `~/priv/chromium-{ServiceName}` (user-chosen path).

When set, this directory is passed as `--user-data-dir` to the browser.
Persists cookies, localStorage, and session state across invocations.

### 7.2 Ephemeral Profile

```
/tmp/{tool}-profile-{PID}/
```

A fresh profile created per invocation for stateless automation. Auto-cleaned
on process exit.

### 7.3 Profile Isolation

Each tool should use a **separate** browser profile to prevent cookie/session
leakage between tools. Concurrent tools can then run independent browser
instances without lock contention on a shared profile directory.

---

## 8. Log Files

### 8.1 Log Directory

```
{cache_root}/logs/
```

### 8.2 Log File Naming

```
{ISO-timestamp}-{PID}.jsonl
```

Timestamp format: `YYYY-MM-DDTHH-mm-ss` (colons replaced with hyphens for
filesystem compatibility).

### 8.3 Log Format

JSONL (one JSON object per line):

```json
{"ts":"2026-03-09T14:22:07.123Z","level":"WARN","pid":12345,"msg":"..."}
```

### 8.4 Rotation

| Parameter | Default |
|-----------|---------|
| Max files | 8 |
| Max file size | 50 MB |

### 8.5 Verbosity Levels

| Flag | Level | Value | Output |
|------|-------|-------|--------|
| `-q` / `--quiet` | quiet | -1 | suppress all stderr |
| (default) | warn | 0 | warnings only |
| `-v` | info | 1 | informational messages |
| `-vv` | debug | 2 | debug detail |
| `-vvv` | trace | 3 | full trace |

All levels write to **stderr**. Structured data output uses **stdout** (via
a separate `logOut()` function).

### 8.6 File Logging Configuration

| Flag / Variable | Purpose |
|-----------------|---------|
| `--log-dir <d>` | Override log directory |
| `--no-log` | Disable file logging entirely |

<!-- REVIEW: File logging is currently implemented by only one tool. Others
use stderr-only logging. Consider whether file logging should be a standard
requirement or an opt-in feature. For cron/automation use cases, file logging
is valuable; for interactive use, stderr is sufficient. -->

---

## 9. Tab Activity Ledger

The tab activity ledger tracks when each automation-managed tab was last used,
enabling LRU eviction.

### 9.1 Ledger Path

```
{cache_root}/tab-activity.json
```

<!-- REVIEW: The original base design used `~/.config/webctl/tab_activity.json`
(underscore, config dir). Implementations use `~/.cache/.../tab-activity.json`
(hyphen, cache dir). Cache dir is more appropriate since this is ephemeral
operational state, not user configuration. Recommend standardizing on the
cache-dir, hyphenated form. -->

### 9.2 Ledger Format

```json
{
  "{resource-key}": {
    "lastUsed": "2026-03-09T14:22:07Z",
    "url": "https://...",
    "command": "read",
    "protected": false
  }
}
```

**Key format options:**

<!-- REVIEW: Two key formats exist.

Format A: Plain resource ID (e.g., "abc-123"). Simpler, but collisions
possible if different resource types share ID spaces.

Format B: Prefixed with view type (e.g., "messaging:abc-123"). Avoids
collisions, self-documenting.

Recommendation: Format B for tools with multiple resource types, Format A
for single-resource tools. -->

* **Format A:** `{resource-id}` — simple, one resource type per tool
* **Format B:** `{view-type}:{resource-id}` — namespaced, multiple resource types

### 9.3 Atomic Writes

Ledger writes use the same temp-file-then-rename pattern as cache files (§5.2).

---

## 10. Blocked State Lock

When the tool detects an anti-abuse response (captcha, rate limit, challenge),
it writes a lock file that prevents subsequent invocations until a human
explicitly clears it.

### 10.1 Lock Path

```
{cache_dir}/blocked.lock.json
```

### 10.2 Schema

```json
{
  "version": 1,
  "blocked_at": "2026-03-09T14:22:07Z",
  "block_type": "rate_limit",
  "details": "Rate limit page detected",
  "evidence": "<truncated DOM snippet, max 500 chars>",
  "command": "tool fetch --url ...",
  "pid": 12345,
  "hostname": "workstation",
  "consecutive_blocks": 1
}
```

### 10.3 Behavior

* Checked at startup **before** any network connection.
* If present: print lock info, exit with blocked exit code (2).
* **Never auto-expires** — human must run `release-lock`.
* `release-lock --verify` optionally probes before clearing.

---

## 11. Output and Download Files

### 11.1 Output Directory

Configurable via `--output-dir <d>` or `{ORG}_{TOOL}_OUTPUT_DIR`.

Defaults to current working directory if not specified.

### 11.2 Output File Naming

```
{prefix}--{descriptor}.{extension}
```

Examples:

* `post--image-0.jpeg`
* `thread--export.jsonl`
* `screenshot-{timestamp}.png`

### 11.3 Structured Export Formats

| Format | Extension | Purpose |
|--------|-----------|---------|
| JSONL | `.{tool}-{type}.jsonl` | Machine-readable, one record per line |
| Markdown | `.{tool}-{type}.md` | Human-readable |
| HTML | `.{tool}-{type}.html` | Styled, self-contained |

### 11.4 Temporary Working Directories

For multi-step file assembly (e.g., video segment concatenation):

```
{output_dir}/.{operation}-tmp/
```

Hidden prefix (`.`) prevents confusion with final output files.

---

## 12. Precedence Chain (Full)

From lowest to highest priority:

```
1. Built-in defaults           (code constants)
2. Legacy environment vars     (deprecated unprefixed names)
3. Structured config file      (JSONC, if applicable — §4)
4. Dotenv file                 (.env.{tool} — §3)
5. Environment variables       (exported {ORG}_{TOOL}_* in shell)
6. CLI flags                   (--port=4999)
```

<!-- REVIEW: The precedence of dotenv vs CLI flags has historically been a
point of divergence.

Approach A (recommended, current canonical): CLI flags always win. Rationale:
flags represent the operator's explicit, immediate intent. One-off overrides
via flags should not be silently ignored by a dotenv file.

Approach B (historical): Dotenv wins over CLI flags. Rationale: dotenv
represents deliberate persistent configuration. But this proved confusing
when operators tried one-off overrides via flags.

Recommendation: Approach A. All newer implementations already follow it. -->

**Rationale for this order:**

* **Defaults** → tool works with zero configuration.
* **Config file** → complex, structured settings for power users.
* **Dotenv** → persistent per-environment tuning.
* **Env vars** → CI/CD, containers, scripted invocations.
* **CLI flags** → operator's explicit immediate intent; always wins.

---

## 13. XDG Base Directory Compliance

The layout follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/):

| XDG Variable | Default | Used For |
|--------------|---------|----------|
| `$XDG_CONFIG_HOME` | `~/.config` | Dotenv files, structured config, browser profiles |
| `$XDG_CACHE_HOME` | `~/.cache` | Locks, logs, tab activity, content cache, blocked state |

**Not used:**

* `$XDG_DATA_HOME` (`~/.local/share`) — no persistent user data outside cache
* `$XDG_STATE_HOME` (`~/.local/state`) — logs placed under cache for simplicity

### 13.1 Local Filesystem Requirement

Lock and cache files **must** reside on local storage. Networked filesystems
(NFS, SMB) do not guarantee `mkdir` atomicity. Use `$XDG_CACHE_HOME` or
`$TMPDIR` as the base path — both are expected to be local.

---

## 14. Gitignore Patterns

Standard `.gitignore` entries for tools following this layout:

```gitignore
# Configuration with secrets
.env.*
*.env
credentials*
cookies*

# But track example templates
!dotenv.*.example

# Runtime artifacts
tmp/
cache/
screenshots/
output/
phenomena/
debug.log

# Dependencies and build
node_modules/
package-lock.json

# IDE / tool state
.claude/
.worktrees/
```

---

## 15. Common Environment Variables Reference

| Variable Pattern | Purpose | Example Default |
|------------------|---------|-----------------|
| `{ORG}_{TOOL}_PORT` | CDP remote debugging port | 4327 |
| `{ORG}_{TOOL}_HOST` | CDP host | 127.0.0.1 |
| `{ORG}_{TOOL}_USER_DATA_DIR` | Browser profile path | (none) |
| `{ORG}_{TOOL}_OUTPUT_DIR` | Default output directory | (none) |
| `{ORG}_{TOOL}_CACHE_DIR` | Cache directory override | `~/.cache/{org}/...` |
| `{ORG}_{TOOL}_BROWSER_TYPE` | Browser binary | chromium |
| `{ORG}_{TOOL}_WINDOW_SIZE` | Initial window dimensions | 1280x800 |
| `{ORG}_{TOOL}_OZONE_PLATFORM` | Display backend (x11/wayland/auto) | auto |
| `{ORG}_{TOOL}_TIMEOUT_MULTIPLIER` | Scale all timeouts | 1.0 |
| `{ORG}_{TOOL}_URL` | Default target URL | (tool-specific) |

**Platform detection:**
`XDG_SESSION_TYPE` is read at runtime to auto-detect `x11` vs `wayland`
for the `--ozone-platform` Chromium flag.

---

## 16. Port Allocation

Each tool uses a **distinct default port** from the dynamic/private range
to enable concurrent operation. Ports should:

* Avoid standard/common ports (8080, 3000, 4000, etc.)
* Be overridable via `{ORG}_{TOOL}_PORT` or `--port`
* Be documented in the tool's example template

---

## Implementation Checklist

* [ ] Choose cache namespace strategy (Option A shared vs Option B per-tool)
* [ ] Standardize organization segment casing in paths
* [ ] Implement dotenv discovery with ambiguity detection
* [ ] Wire full precedence chain: defaults < legacy < config < dotenv < env < CLI
* [ ] Ship `dotenv.{tool}.example` with all variables documented
* [ ] Add `.env.*` and `!dotenv.*.example` to `.gitignore`
* [ ] Create lock directory structure with per-port isolation
* [ ] Implement atomic writes for all JSON state files
* [ ] Define and document tool-specific exit codes
* [ ] Choose tab-activity ledger key format (A vs B)
* [ ] Implement log rotation if file logging is enabled
* [ ] Document all supported environment variables in `--help` output
