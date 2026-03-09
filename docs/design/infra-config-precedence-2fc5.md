---
id: 2fc5
title: "Configuration Precedence & Port Allocation"
category: infra
created: "2026-03-09"
updated: "2026-03-09"
status: draft
tags: [config, precedence, environment, ports, resolution]
tech: []
relates_to: [f868, lf4f, r7m3]
depends_on: []
expands: [r7m3]
similar_to: []
---

# Configuration Precedence & Port Allocation

## Purpose

Defines the resolution order when the same setting is specified in multiple
places (defaults, config files, dotenv, env vars, CLI flags). Also establishes
port allocation conventions for concurrent tool operation.

## Precedence Chain

From lowest to highest priority:

```
1. Built-in defaults           (code constants)
2. Legacy environment vars     (deprecated unprefixed names)
3. Structured config file      (JSONC per-client config — see lf4f)
4. Dotenv file                 (.env.{tool} — see r7m3)
5. Environment variables       (exported {ORG}_{TOOL}_* in shell)
6. CLI flags                   (--port=4999)
```

**CLI flags always win** — they represent the operator's explicit, immediate
intent. One-off overrides via flags must never be silently ignored by a
dotenv file or config file.

### Client-Aware Resolution

When `--client {name}` is specified, the structured config file loaded
changes from `default/webctl/{tool}.config.jsonc` to
`{client}/webctl/{tool}.config.jsonc`. The precedence chain applies within
that client's context. See `infra-client-profile-registry` (lf4f).

### Rationale

* **Defaults** → tool works with zero configuration
* **Config file** → complex, structured settings for power users
* **Dotenv** → persistent per-environment tuning
* **Env vars** → CI/CD, containers, scripted invocations
* **CLI flags** → immediate intent; always wins

## General Environment Variables

| Variable Pattern | Purpose | Example Default |
|------------------|---------|-----------------|
| `{ORG}_{TOOL}_PORT` | CDP remote debugging port | 4327 |
| `{ORG}_{TOOL}_HOST` | CDP host | 127.0.0.1 |
| `{ORG}_{TOOL}_OUTPUT_DIR` | Default output directory | (CWD) |
| `{ORG}_{TOOL}_CACHE_DIR` | Cache directory override | `~/.cache/CLIAI/...` |
| `{ORG}_{TOOL}_TIMEOUT_MULTIPLIER` | Scale all timeouts | 1.0 |
| `{ORG}_{TOOL}_URL` | Default target URL | (tool-specific) |

Browser-specific variables (USER_DATA_DIR, BROWSER_TYPE, WINDOW_SIZE,
OZONE_PLATFORM) are documented in `infra-client-profile-registry` (lf4f).

## Port Allocation

Each tool uses a **distinct default port** from the IANA dynamic/private
range (49152–65535) or a project-chosen range to enable concurrent operation.

**Rules:**

* Avoid standard/common ports (8080, 3000, 4000, 9222)
* Always overridable via `{ORG}_{TOOL}_PORT` or `--port`
* Document the default port in `dotenv.{tool}.example`
* Port uniqueness prevents collision when multiple tools run simultaneously

## Implementation Checklist

* [ ] Wire full precedence chain: defaults < legacy < config < dotenv < env < CLI
* [ ] Implement client-aware config file loading
* [ ] Document all supported env vars in `--help` output
* [ ] Assign distinct default port per tool, document in example template
