# FUTURE_WORK — registry + browser-location/index block on non-extracted siblings

* **Category:** migrate
* **Created:** 2026-06-22
* **Concerns:** base extraction of `browser-location/registry.js` and
  `browser-location/index.js`.

## What is deferred

Both are byte-identical across linkedin==chatgpt but require sibling modules that
are **not in the extraction set** (and one that is the per-repo seam):

* `registry.js` →
  * `require('./localhost-direct')` — **already in base (v0.2.0)** ✓
  * `require('./chromium-docker-xpra')` — the docker-xpra **driver**, NOT yet
    extracted (large; orchestrates docker-ctl + mounts + cdp-rewrite).
* `browser-location/index.js` →
  * `require('./registry')` — itself blocked (above)
  * `require('./mounts')` — **not yet extracted**
  * `require('../client-config.constants')` — the per-repo **SEAM**
    (see `260622-client-config-constants-seam.md`).

A base `registry.js` that `require('./chromium-docker-xpra')` would resolve to a
base file that does not exist (or to a stale copy) — so these can only move once
their dependencies are in base, in dependency order.

## Dependency order to unblock

1. **`mounts.js`** — NOT a clean leaf (checked 2026-06-22): it
   `require('../client-config.constants')` (the SEAM) **and it has already
   DRIFTED** between linkedin and chatgpt (`cmp` fails; 244 lines). So mounts
   needs BOTH (a) a **reconcile** of the linkedin/chatgpt divergence into one
   canonical source, AND (b) the constants-seam design — before it can be
   extracted. It is *not* the quick win first guessed.
2. Resolve the **constants SEAM** design (separate note).
3. Extract the **`chromium-docker-xpra` driver** (depends on docker-ctl ✓ +
   mounts + cdp-rewrite ✓ + the resolved constants seam). This is the big one.
4. Then `registry.js` (deps all present), then `browser-location/index.js`
   (the top-level orchestrator) last.

> **Drift flag for the manager:** `mounts.js` is a concrete case of the
> byte-duplication drift `sb7q` warns about — the two repos' copies have already
> diverged. Worth scheduling a reconcile + diff review before extraction so base
> ships the *correct* merged behaviour, not one repo's arbitrarily.

## Why it does not block

The 5 leaves shipped without these. registry/index are the *orchestration top*
of the browser-location subsystem — correctly migrated last, after their leaves.
Consumers keep their own copies meanwhile; the drift canary only checks wired
consumers.

## What unblocks it

The constants-seam design (gates `mounts`, the driver, and the 3 SEAM modules at
once — highest-leverage next decision), a `mounts` linkedin/chatgpt reconcile,
then the driver extraction, then registry/index. The seam design is the critical
path for nearly all remaining work; recommend the manager prioritise it.
