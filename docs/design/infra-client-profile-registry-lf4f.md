---
id: lf4f
title: "Client Profile Registry: Multi-Browser Management"
category: infra
created: "2026-03-09"
updated: "2026-03-09"
status: draft
tags: [browser, profiles, client, config, jsonc, multi-browser, registry]
tech: []
relates_to: [f868, 2fc5, v7m2, v8m2, 1wsg]
depends_on: [f868]
expands: [v7m2]
similar_to: []
---

# Client Profile Registry: Multi-Browser Management

## Purpose

Defines how webctl tools manage multiple browser profiles (clients). The
mapping is many-to-many: multiple tools share multiple browser instances,
each with distinct cookies, logins, and session state for different
sites/projects. This registry is **core infrastructure** in base-webctl —
all downstream webctl tools depend on it for browser discovery and launch.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  tool-alpha  │     │  tool-beta   │     │  tool-gamma  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────┬───────────┼────────────────────┘
                │           │
        ┌───────▼───┐  ┌────▼──────┐
        │  client-A  │  │  client-B  │
        │  port 4327 │  │  port 4891 │
        │  profile/  │  │  profile/  │
        └───────────┘  └───────────┘
```

Any tool can connect to any client's browser. The registry tells each tool
where to find (or how to launch) the browser for a given client.

## Client Profile Configuration

### Config File Location

```
~/.config/CLIAI/{client}/webctl/{tool}.config.jsonc
```

* `{client}` — named profile (`default` when `--client` is omitted)
* `{tool}` — tool name, or `base-webctl` for shared base config
* Format: JSON with `//` and `/* */` comments (zero-dependency scanner)

### Config Schema

```jsonc
{
  // CDP remote debugging port for this client's browser
  "port": 4327,

  // Browser binary (resolved via PATH)
  "browser_type": "chromium",

  // Persistent profile directory
  "user_data_dir": "~/.config/CLIAI/my-webctl/profile",

  // Window dimensions
  "window_size": "1280x800",

  // Display backend: "x11", "wayland", or "auto"
  "ozone_platform": "auto",

  // Additional Chromium flags (tool-specific)
  "extra_flags": []
}
```

### Client Selection

```bash
my-webctl --client work send --message "hello"
my-webctl --client personal read --thread abc
my-webctl send --message "hello"   # uses "default" client
```

### Merge Semantics

Shallow merge of top-level keys. Client-specific config overrides
`default` config for matching keys. Per-tool config overrides
`base-webctl` config.

Resolution order for a tool `my-webctl` with `--client work`:

```
1. ~/.config/CLIAI/default/webctl/base-webctl.config.jsonc    (base defaults)
2. ~/.config/CLIAI/work/webctl/base-webctl.config.jsonc       (client base)
3. ~/.config/CLIAI/default/webctl/my-webctl.config.jsonc      (tool defaults)
4. ~/.config/CLIAI/work/webctl/my-webctl.config.jsonc         (client+tool)
```

Each layer shallow-merges onto the previous. CLI flags and env vars
still override everything per the precedence chain (→ 2fc5).

## Browser Lifecycle

### Discovery: Is the Browser Running?

1. Read `{cache_root}/locks/port-{PORT}.lock/` for the client's configured port
2. If lock exists and PID is alive → browser is running, connect via CDP
3. If no lock or PID is stale → browser needs to be launched

### Launch

When no browser is found for the requested client:

1. Load client profile config (port, user_data_dir, browser_type, etc.)
2. Launch browser with resolved flags (see `infra-browser-configuration` v7m2)
3. Acquire port lock (see `safety-process-mutex` v8m2)
4. Wait for CDP endpoint to become available
5. Connect and proceed with tool operation

### Shared Browser Access

Multiple tools can connect to the same client's browser simultaneously
via CDP. Port locks serialize **browser launch** (preventing duplicate
instances), not CDP connections. Once running, the browser accepts
multiple CDP clients.

## Browser-Specific Environment Variables

| Variable Pattern | Purpose | Example Default |
|------------------|---------|-----------------|
| `{ORG}_{TOOL}_USER_DATA_DIR` | Browser profile path | (from config) |
| `{ORG}_{TOOL}_BROWSER_TYPE` | Browser binary | chromium |
| `{ORG}_{TOOL}_WINDOW_SIZE` | Initial window dimensions | 1280x800 |
| `{ORG}_{TOOL}_OZONE_PLATFORM` | Display backend | auto |

Platform detection: `XDG_SESSION_TYPE` auto-detects `x11` vs `wayland`
for `--ozone-platform` when set to `auto`.

## Browser Profiles

### Persistent Profile

Set via `user_data_dir` in client config or `{ORG}_{TOOL}_USER_DATA_DIR`.
Passed as `--user-data-dir` to the browser. Persists cookies, localStorage,
and session state across invocations.

### Ephemeral Profile

```
/tmp/{tool}-profile-{PID}/
```

Fresh profile per invocation for stateless automation. Auto-cleaned on
process exit. Used when no `user_data_dir` is configured.

### Profile Isolation

Each **client** gets a separate browser profile. This prevents
cookie/session leakage between clients. Multiple tools sharing the same
client intentionally share that client's cookies and session.

## Introspection Subcommands

Required for all tools using the client profile system:

| Subcommand | Purpose |
|------------|---------|
| `config list` | Show all config sources and their file paths |
| `config show` | Show effective merged values for current client |
| `config path` | Print paths being searched |

## Implementation Checklist

* [ ] Implement JSONC parser (zero-dependency, character-by-character scanner)
* [ ] Implement client config discovery and 4-layer merge
* [ ] Implement browser discovery (check lock → check PID → connect or launch)
* [ ] Wire `--client {name}` flag through to config and cache path resolution
* [ ] Implement `config list`, `config show`, `config path` subcommands
* [ ] Document all client profiles in project README or `--help`
