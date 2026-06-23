---
id: f868
title: "Directory Structure & Naming Conventions"
category: infra
created: "2026-03-09"
updated: "2026-06-24"
status: draft
tags: [filesystem, xdg, paths, naming, conventions, layout]
tech: []
relates_to: [2fc5, sazn, lf4f, r7m3, v8m2, 1wsg, k7m2, v7m2]
depends_on: []
expands: []
similar_to: []
---

# Directory Structure & Naming Conventions

## Purpose

Defines the canonical filesystem layout for all webctl tools: where
configuration, cache, locks, logs, browser profiles, and output live.
A unified layout lets operators predict file locations, prevents path
collisions, and gives new tool authors a blueprint.

## Naming Conventions

### Organization and Tool Segments

All paths use two naming segments:

```
{ORG}     — "CLIAI" (uppercase, canonical form)
{TOOL}    — tool name, lowercase with hyphens (e.g., "my-webctl")
```

| Context | Casing | Example |
|---------|--------|---------|
| Directory paths | ORG uppercase, tool lowercase | `~/.config/CLIAI/my-webctl/` |
| Dotenv filenames | lowercase, preserving hyphens | `.env.my-webctl` |

For environment variable naming and legacy variable support, see
`infra-dotenv-configuration` (r7m3).

## Canonical Directory Tree

```
~/.config/CLIAI/
  ├── {tool}/
  │   ├── .env.{tool}                    # dotenv config (→ r7m3)
  │   └── profile/                       # browser profile (→ v7m2)
  ├── default/
  │   └── webctl/
  │       └── {tool}.config.jsonc        # per-client config (→ lf4f)
  └── {client}/
      └── webctl/
          └── {tool}.config.jsonc        # named client config (→ lf4f)

~/.cache/CLIAI/
  └── default/
      └── webctl/
          ├── locks/
          │   └── port-{PORT}.lock/      # process mutex (→ v8m2)
          ├── logs/
          │   └── {timestamp}-{pid}.jsonl # structured logs (→ sazn)
          ├── tab-activity.json          # LRU tracking (→ 1wsg)
          ├── blocked.lock.json          # blocked state (→ k7m2)
          └── {id}.{tool}-{type}.json    # content cache (→ sazn)

{project}/
  ├── .env.{tool}                        # project-local dotenv (→ r7m3)
  └── dotenv.{tool}.example              # tracked template (→ r7m3)
```

### Cache Namespace: Shared Strategy

> **Superseded by `infra-storage-path-resolution` (v59v) §3.** In practice the
> fleet fragmented and the **per-tool** `~/.cache/CLIAI/<CACHE_DIRNAME>/` namespace
> (base mounts/locks/gateway-state) is now canonical; the shared `default/webctl`
> below is legacy (chatgpt-only) to migrate. Retained here for history.

All tools share `~/.cache/CLIAI/default/webctl/`. This enables:

* Cross-tool port lock visibility (any tool can see all held locks)
* Shared tab-activity ledger across tools controlling the same browser
* Per-client isolation via `{client}/webctl/` directories

The `default` segment is the implicit client when no `--client` flag is
specified. Named clients get their own parallel subtrees.

## XDG Base Directory Compliance

| XDG Variable | Default | Used For |
|--------------|---------|----------|
| `$XDG_CONFIG_HOME` | `~/.config` | Dotenv, structured config, browser profiles |
| `$XDG_CACHE_HOME` | `~/.cache` | Locks, logs, tab activity, content cache, blocked state |

**Not used:** `$XDG_DATA_HOME`, `$XDG_STATE_HOME` (logs under cache for simplicity).

> **Updated by `infra-storage-path-resolution` (v59v) §4.** `$XDG_STATE_HOME` **is
> now used** (the gateway grant store, f6rd, is XDG "state"), and `$XDG_RUNTIME_DIR`
> is preferred for locks when set. v59v implements XDG resolution (this table was
> aspirational; nothing implemented it).

### Local Filesystem Requirement

Lock and cache files **must** reside on local storage. Networked filesystems
(NFS, SMB) do not guarantee `mkdir` atomicity. `$XDG_CACHE_HOME` and `$TMPDIR`
are expected to be local.

## Gitignore Patterns

```gitignore
# Configuration with secrets
.env.*
*.env
credentials*
cookies*

# Track example templates
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

## Implementation Checklist

* [ ] Ensure all tools use `CLIAI` (uppercase) as org segment in paths
* [ ] Create `~/.config/CLIAI/{tool}/` and `~/.cache/CLIAI/default/webctl/` on first run
* [ ] Respect `$XDG_CONFIG_HOME` and `$XDG_CACHE_HOME` overrides
* [ ] Ship `.gitignore` with patterns above in project templates
