---
id: v59v
title: "Storage Path Resolution: Unified cacheRoot, XDG, and Dotenv Standard"
category: infra
created: "2026-06-24"
updated: "2026-06-24"
status: review
tags: [filesystem, xdg, paths, cacheroot, state, dotenv, constants-seam, scaffold, consolidation]
tech:
  - name: "Node.js"
    version: ">=22.12"
relates_to: [f868, lf4f, r7m3, sazn, v8m2, p06y, f6rd, sm2t, sb7q]
depends_on: [f868, sm2t]
expands: [f868]
similar_to: []
---

# Storage Path Resolution: Unified cacheRoot, XDG, and Dotenv Standard

> **Expands `f868`** (Directory Structure & Naming Conventions). `f868` defines
> the *layout*; this doc defines the single **resolution layer** every tool uses
> to compute that layout — consolidating today's fragmented per-tool reimplementations,
> **implementing** XDG base-dir compliance (not downgrading it), and fixing the
> dotenv-location spec-drift. It is the last step-3 shared standard and the
> storage input the new-tool scaffold stamps. **Status: review** (design-only; no
> lib lands before review). Grounded in
> `FUTURE_WORK/migrate/260624-step3-shared-standards-survey.md` §B.

## 1. Principle

Every tool needs the same five storage roots (config, cache, state, runtime,
project) computed the same way from its injected constants. Today each tool
**reimplements** `cacheRoot()` and they have **drifted** — so a base-owned
resolver, `createStoragePaths(C)`, becomes the single source of truth, and the
new-tool scaffold ships it pre-wired.

## 2. Grounded fragmentation (what we are fixing)

| Concern | `f868` says | Reality (survey) | Resolution |
|---|---|---|---|
| Cache namespace | **shared** `~/.cache/CLIAI/default/webctl/` | **fragmented**: chatgpt uses `default/webctl`; linkedin/telegram/**base** use per-tool `<CACHE_DIRNAME>` | **per-tool `<CACHE_DIRNAME>` is canonical** (§3); chatgpt's `default/webctl` is the legacy outlier to migrate |
| cacheRoot computation | (each tool) | reimplemented per tool (base `mounts.cacheRoot()` is the de-facto reference) | **one base resolver** `createStoragePaths(C)` |
| XDG | `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`; **STATE not used** | implemented **nowhere** (all hardcode `$HOME`) | **IMPLEMENT** all of CONFIG/CACHE/STATE (+ RUNTIME for locks) |
| Dotenv location | `~/.config/CLIAI/{tool}/.env.{tool}` | **all tools** use project-root `.env.{tool}` | **precedence chain** (§5): project-root first, XDG-config second |

## 3. Canonical cache namespace — per-tool (decision)

base already committed to **per-tool** `~/.cache/CLIAI/<CACHE_DIRNAME>/` (mounts,
the v8m2/p06y locks, the f6rd gateway state). It gives clean per-tool isolation
matching the `ARTIFACT_PREFIX` model; cross-tool lock *visibility* (f868's
rationale for the shared namespace) is unnecessary because each tool owns a
distinct CDP port + profile + docker prefix. Therefore:

* **Canonical:** `<XDG_CACHE_HOME>/CLIAI/<CACHE_DIRNAME>/…` (per tool).
* chatgpt's `~/.cache/CLIAI/default/webctl/…` is **legacy** — migrate to per-tool
  on its base adoption (a one-time path move; document a fallback-read of the old
  location for one release if any persistent cache must survive).
* Per-**client** isolation stays in the **config** tree (`<client>/webctl/…`, lf4f)
  and per-**slug** isolation stays in `profiles/<slug>/` — both orthogonal to the
  per-tool cache root.

This **supersedes** `f868` §"Cache Namespace: Shared Strategy".

## 4. XDG base-dir — IMPLEMENT (decision)

`createStoragePaths(C)` resolves each root from its XDG variable with the
spec-mandated fallback, never a hardcoded `$HOME`:

| Root | XDG var | Fallback | Holds |
|---|---|---|---|
| **config** | `$XDG_CONFIG_HOME` | `~/.config` | dotenv (XDG layer), `<client>/webctl/<tool>.config.jsonc` (lf4f) |
| **cache** | `$XDG_CACHE_HOME` | `~/.cache` | logs (sazn), content cache, migration markers, profiles* |
| **state** | `$XDG_STATE_HOME` | `~/.local/state` | gateway grant store (f6rd), other persist-but-not-config access state |
| **runtime (locks)** | `$XDG_RUNTIME_DIR` | cache `…/locks` | port mutex dirs (v8m2/p06y) — see §4.1 |

All under the `CLIAI/<CACHE_DIRNAME>/` segment. This **supersedes** `f868`'s
"Not used: `$XDG_DATA_HOME`, `$XDG_STATE_HOME`" — **state IS used** now (the
gateway grant store is exactly XDG "state": persists, not config, not
regenerable cache).

### 4.1 Locks: runtime-dir-preferred, cache-fallback

Locks are ephemeral + session-scoped → `$XDG_RUNTIME_DIR/CLIAI/<CACHE_DIRNAME>/locks`
is the *ideal* home (tmpfs, auto-cleaned at logout). But `$XDG_RUNTIME_DIR` is not
always set (cron, ssh, some CI), so the resolver falls back to
`<cacheRoot>/locks` (today's location — behaviour-preserving). The mutex's
local-fs atomicity requirement (v8m2) holds for both. **Default: cache-fallback**
(unchanged for current consumers); runtime-dir is an opt-in the resolver picks
when the var is present. Greg may flip the default.

### 4.2 Profiles (note, not a change)

Profiles hold cookies/login → **secret-grade persistent**. f868/v7m2 keep them
under `cache/profiles/<slug>/`; the explicit `userDataDir` override (e.g.
`~/priv/...`) remains the way to relocate them off cache. The resolver exposes
`profilesRoot` but does not move profiles in this standard (continuity); a future
doc may promote them to a data/state root.

## 5. Dotenv location — precedence chain (fixes the drift)

The spec drifted (f868 said XDG-config; every tool uses project-root). Fix by
making **both** valid with a precedence chain the resolver/loader honors
(highest first):

1. **project-root `.env.<tool>`** — the dev/repo override (matches today's reality).
2. **`<configRoot>/CLIAI/<tool>/.env.<tool>`** — the user-global XDG location.

This *implements* the XDG location (decision: don't downgrade) while keeping the
project-root convention every tool already uses as the top override. Cross-ref
`r7m3` (dotenv config) for variable naming/legacy-prefix handling. **Supersedes**
f868 §canonical-tree's single dotenv location with this ordered pair.

## 6. The resolver contract — `createStoragePaths(C, opts)` (sm2t)

Design-only sketch (no lib yet). sm2t-shaped, zero-dep, `env` injectable for tests.

```js
/**
 * @param {ClientConfigConstants} C   // CACHE_DIRNAME, PROJECT, DOTENV_FILENAME, ...
 * @param {{ env?: Record<string,string>, client?: string }} [opts]
 * @returns {{
 *   configRoot: string,   // <XDG_CONFIG_HOME|~/.config>/CLIAI/<CACHE_DIRNAME>
 *   cacheRoot: string,    // <XDG_CACHE_HOME|~/.cache>/CLIAI/<CACHE_DIRNAME>
 *   stateRoot: string,    // <XDG_STATE_HOME|~/.local/state>/CLIAI/<CACHE_DIRNAME>
 *   locksDir: string,     // <XDG_RUNTIME_DIR>/.../locks  OR  <cacheRoot>/locks
 *   logsDir: string,      // <cacheRoot>/logs
 *   profilesRoot: string, // <cacheRoot>/profiles
 *   migrationMarker(name): string,
 *   gatewayStatePath(): string,        // <stateRoot>/xpra-access.json (f6rd)
 *   configFile(client?): string,       // <configRoot>/.../<tool>.config.jsonc (lf4f)
 *   dotenvCandidates(): string[],      // [project .env.<tool>, <configRoot>/.../.env.<tool>]
 * }}
 */
export function createStoragePaths(C, opts) { /* ... */ }
```

Consumers (and the existing base modules — mounts, the mutex, the gateway store)
get their roots from this ONE resolver instead of re-deriving `cacheRoot`. base's
`mounts.cacheRoot()`, the mutex `lockBaseDir`, and the gateway `statePath` become
thin callers of `createStoragePaths(C)` — a follow-up consolidation, **not part of
this design-only step**.

## 7. Secret topology + .gitignore (carry from f868, hardened)

* state + cache + profiles hold secret-grade material (grants, cookies) → all
  under `$HOME`-derived roots, **never** tracked. The resolver never returns a
  path inside a repo for secret state.
* The shared `.gitignore` template (f868) gains the explicit `credentials*` /
  `cookies*` / `*token*` lines (the survey's chatgpt gap) — the scaffold stamps
  this template; it is also folded into chatgpt's mutex adoption proposal.

## 8. Scaffold input + migration

* The **new-tool scaffold** stamps `createStoragePaths(C)` wiring + the `.gitignore`
  template, so every new tool inherits XDG-correct, per-tool storage with zero
  bespoke path code.
* **Migration (deferred, post-review, consumer-paced):** each consumer replaces
  its hand-rolled `cacheRoot`/path computation with the resolver; chatgpt also
  migrates `default/webctl` → per-tool. test-before-bump under the gate. Logged as
  follow-up; **no lib lands until adoption catches up (manager rebalance) or Greg
  redirects.**

## 9. Decisions (recommended; Greg may override)

| # | Decision | Resolution |
|---|----------|-----------|
| 1 | Cache namespace | **per-tool `<CACHE_DIRNAME>`** (base's model); chatgpt `default/webctl` = legacy migrate |
| 2 | XDG | **implement** CONFIG + CACHE + **STATE** (+ RUNTIME for locks); never hardcode `$HOME` |
| 3 | Locks home | `$XDG_RUNTIME_DIR` when set, else `<cacheRoot>/locks` (default = cache-fallback, unchanged) |
| 4 | Dotenv | precedence: **project-root first**, XDG-config second (implements XDG, keeps reality) |
| 5 | Profiles | unchanged under `cache/profiles/<slug>` + `userDataDir` override (note only) |
