---
id: v59v
title: "Storage Path Resolution: Unified cacheRoot, XDG, and Dotenv Standard"
category: infra
created: "2026-06-24"
updated: "2026-09-02"
status: stable
tags: [filesystem, xdg, paths, cacheroot, state, dotenv, constants-seam, scaffold, consolidation]
tech:
  - name: "Node.js"
    version: ">=22.12"
relates_to: [f868, lf4f, r7m3, sazn, v8m2, p06y, f6rd, sm2t, sb7q, t2wf]
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
> storage input the new-tool scaffold stamps. **Status: stable, and IMPLEMENTED** —
> `lib/storage-paths.js` ships `createStoragePaths(C, opts)`. Two points below
> were decided during implementation and are marked ⇒ RESOLVED. Grounded in
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

> ⚠ **ONE PATH SEGMENT IS CARRYING TWO JOBS, and whoever splits them should do
> it knowingly.** `~/.cache/CLIAI/` currently holds per-TOOL directories
> (`chatgpt-webctl`, `linkedin-webctl`, …) *alongside* per-INSTANCE ones
> (`default`, `integration-test`, `test-lifecycle`). Tool identity and instance
> slug share one namespace, so nothing in the path distinguishes them and no
> reader can tell which kind of thing a directory is.
>
> That is the **same structural error** as `consumers.jsonc`'s `name` carrying
> both registry identity and on-disk location — which is exactly what produced
> the release gate's six-week false-green (`xrl4` "Gate validity"), and which
> needed a `localDir` field to separate. Second instance in this family, so it
> is recorded rather than rediscovered a third time. This standard does not
> split them (continuity); it names the seam.

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
(unchanged for current consumers); runtime-dir is an opt-in. Greg may flip it.

> ⇒ **RESOLVED 2026-09-02 — and this paragraph contradicted itself.** It said
> both "default: cache-fallback, unchanged for current consumers" *and*
> "runtime-dir is an opt-in the resolver picks when the var is present".
> `$XDG_RUNTIME_DIR` is set on virtually every desktop session, so "picks it
> when present" is not *unchanged* — it is a silent relocation for nearly
> everyone.
>
> ⛔ Resolved toward unchanged, and NOT as a matter of taste. **A lock directory
> that moves is a lock that stops working during the rollout.** Two processes of
> the same tool — one on the old base, one on the new — take locks in two
> different directories and BOTH believe they hold it. That is precisely the
> mutual-exclusion failure `v8m2`/`p06y` exist to prevent, caused by the upgrade
> rather than by a bug, and it would appear exactly once per consumer at the
> least reproducible possible moment.
>
> So the implementation moves locks **only** on explicit
> `opts.preferRuntimeDirForLocks`. A tool opts in when its whole fleet is on one
> version — which is a thing only that tool can know, and never something a
> shared library should decide on its behalf.

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

> ⇒ **[1] CORRECTION 2026-09-02 — the sketch said `CACHE_DIRNAME`; the SHIPPED
> code keys config on `C.PROJECT`.** They are different fields, and in all four
> real consumers they are currently EQUAL — which is exactly why this is worth
> pinning rather than leaving: the divergence is invisible today and would
> surface as config silently relocating for the first consumer that sets them
> apart. The implementation follows the code rather than the sketch, because the
> code is what already has files under it, and a test asserts the two trees
> diverge correctly with the fields deliberately different.

⇒ **IMPLEMENTED** in `lib/storage-paths.js`. sm2t-shaped, zero-dep, `env` and
`fs` injectable for tests. Three refusals are enforced in code rather than
documented, because this standard exists because a documented invariant was not
enough:

* **It ships no verb that can delete, move or clean anything.** The migration
  must never delete — the hazard behind this whole standard is a tool's rotation
  eating another tool's audit ledger, and a migration that tidies up is how you
  lose the thing you were protecting. `resolveExisting()` READS the legacy
  location and returns the canonical path for writers; a human moves files when
  a human decides to. A test asserts the surface exposes no mutating verb, so
  the guarantee cannot be eroded by a later helper that seemed convenient.
* **It refuses to invent a `$HOME`.** Unset `$HOME` is a real state (daemons,
  some containers) and silently resolving to `/tmp` would place profiles and
  grants — secret-grade — somewhere world-readable. It throws and says why.
* **It ignores a RELATIVE `$XDG_*` value**, as the spec requires, rather than
  resolving it against the current directory.

```js
/**
 * @param {ClientConfigConstants} C   // CACHE_DIRNAME, PROJECT, DOTENV_FILENAME, ...
 * @param {{ env?: Record<string,string>, client?: string }} [opts]
 * @returns {{
 *   configRoot: string,   // <XDG_CONFIG_HOME|~/.config>/CLIAI/<PROJECT>  [1]
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

⇒ **CONSOLIDATION DONE 2026-09-02.** `mounts.cacheRoot()` and the mutex
`lockBaseDir` are now thin callers of `createStoragePaths(C)`; the hand-rolled
`$HOME` derivations are gone from `lib/`. (The gateway `statePath` is
caller-supplied by contract, so it has nothing to consolidate — `gatewayStatePath()`
is there for whoever constructs it.)

⛔ **They pass `legacyHomeOnly: true`, and that is required rather than tidy.**
The existing derivations honour no XDG variable, so consolidating them onto the
XDG-aware default would **relocate cache, profiles and locks for anyone with
`$XDG_CACHE_HOME` set** — silently, on upgrade. For locks that is the
rollout-window mutual-exclusion break described in §4.1. For profiles it is
quieter and arguably worse: **a relocated profile is an empty profile**, i.e. a
silently logged-OUT browser, with the real authenticated session still sitting at
the old path.

So: new code gets the XDG-correct default this standard mandates; the existing
sites keep their paths byte-identical until a **deliberate, announced migration**.
Consolidation removes the drift risk (one implementation) without moving a single
file — which is the same never-delete/never-move discipline as §"the resolver
contract", applied to the consolidation itself.

One deliberate behaviour change came with it: `$HOME` unset now **throws** rather
than falling back. The two consolidated sites disagreed there anyway (`/tmp` vs
`os.tmpdir()`), so consolidation had to pick one, and writing profiles and cookies
somewhere world-readable is not the one.

## 7. Secret topology + .gitignore (carry from f868, hardened)

* state + cache + profiles hold secret-grade material (grants, cookies) → all
  under `$HOME`-derived roots, **never** tracked. The resolver never returns a
  path inside a repo for secret state.
* The shared `.gitignore` template (f868) gains the explicit `credentials*` /
  `cookies*` / `*token*` lines (the survey's chatgpt gap) — the scaffold stamps
  this template; it is also folded into chatgpt's mutex adoption proposal.

## 8. Scaffold input + migration

> ⭐ **THE BLAST RADIUS OF A `cacheRoot` MOVE IS INVERSE TO INTUITION — measured
> 2026-09-02 from `docker inspect` on live containers, not assumed.**
>
> | consumer | live profile mount | size | exposed to a cacheRoot move? |
> |---|---|---|---|
> | chatgpt-webctl | `~/priv/chromium-…` (explicit `userDataDir` override) | 2.1G | **NO** — outside the cache root entirely |
> | substack-webctl | `<cacheRoot>/profiles/default/chromium` | 131M | **YES** |
>
> The consumer carrying the most sensitive authenticated session is
> **structurally immune**, because it already overrides `userDataDir`; the
> exposed one is the ordinary consumer that took the defaults. Anyone planning
> the deliberate XDG migration will reason the other way round by default — "be
> careful with the important one" — and be careful with precisely the consumer
> that cannot be affected, while the one that can be is the unremarkable one.
>
> Check the actual mounts before planning, rather than inferring exposure from
> how much a consumer matters.

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
