# Proposal — telegram-webctl: adopt base `createProcessMutex` (minimal)

* **For:** `webctl:telegram@knot` + Greg — review & adopt at your pace.
* **From:** `webctl:base@knot` (mutex consolidation, 2026-06-24).
* **Status:** base side PROVEN against telegram's own `test/mutex.test.js`
  (**17/17** via the adapter shim, in a vendored worktree). **Not** pushed to
  telegram. test-before-bump (`xrl4`).
* **Refs:** `safety-process-mutex-factory-p06y`, `safety-process-mutex-v8m2`,
  `arch-constants-injection-seam-sm2t`, `arch-shared-base-as-submodule-sb7q`.

## What this does

Replace `lib/mutex.js` (61 lines) with a thin **adapter shim** onto base's
consolidated `createProcessMutex(C, opts)` in **minimal** mode — preserving
telegram's exact behaviour (mkdir-atomic, bare pid file, no signal handlers,
`process.exit(3)` on timeout). telegram's lock layout
(`~/.cache/CLIAI/telegram-webctl/locks/port-<N>.lock/pid`) is **byte-identical**
to base's mkdir path, so this is a clean drop-in.

## The shim (proven)

```js
'use strict';
// lib/mutex.js — adapter onto base createProcessMutex(C), minimal mode.
const { processMutex } = require('../vendor/base-webctl/lib/index.js'); // require(esm)
const C = require('./client-config.constants');   // see precondition: adopt the sm2t seam
const base = processMutex.createProcessMutex(C, { flock: 'off', metadata: false, signalCleanup: false });
module.exports = {
  async acquireLock(port, timeout = 30000) {
    try { const h = await base.acquireLock(port, timeout); return h.lockPath; }
    catch (e) { if (e && e.code === 'LOCK_TIMEOUT') process.exit(3); throw e; } // preserve exit 3
  },
  releaseLock(lockPath) { if (lockPath) base.releaseLock({ mode: 'mkdir', lockPath }); },
};
```

## API adaptation notes

* base's `acquireLock` returns a **handle** `{mode,lockPath,port}`; telegram's
  callers expect a **path string** → the adapter returns `h.lockPath`.
* base **throws** `LockTimeoutError` on timeout; telegram exits `3` → the adapter
  catches and `process.exit(3)` (behaviour-identical).
* base's `releaseLock` takes the handle → the adapter reconstructs
  `{mode:'mkdir', lockPath}`.
* `flock:'off'` keeps telegram mkdir-only (base never deps `fs-ext`); `metadata:
  false` keeps the bare pid file; `signalCleanup:false` matches telegram's
  no-signal-handler behaviour (it relies on stale-reclaim).

## Why it is safe

Proven 2026-06-24 against telegram @ HEAD in a vendored worktree + this exact
shim: `node --test test/mutex.test.js` → **17/17** (acquire/release cycle, pid
file content, recursive parent dirs, stale-reclaim of a dead PID, null/undefined
handling). base's pid file is a **bare** `String(pid)` (no trailing newline) —
byte-compatible with telegram's exact-match test.

## Preconditions (this is telegram's FIRST base adoption)

* Add base as a submodule at `vendor/base-webctl` (pin a released tag).
* Adopt the **sm2t constants seam**: ship `lib/client-config.constants.js`
  (telegram currently has none) with the full `ClientConfigConstants` shape
  (`CACHE_DIRNAME: 'telegram-webctl'` drives the lock dir). base's
  `assertConstants` enforces it.
* **Node ≥ 22.12** fleet floor (telegram's `engines` says `>=18`) — required for
  the synchronous `require(esm)` shim.

## How to adopt

```bash
cd telegram-webctl
git submodule add git@github.com:CLIAI/base-webctl.git vendor/base-webctl
git -C vendor/base-webctl checkout <tag>
# add lib/client-config.constants.js (sm2t seam), replace lib/mutex.js with the shim
node --test test/*.test.js   # expect green (mutex 17/17)
git add vendor/base-webctl lib/client-config.constants.js lib/mutex.js
git commit
```

## Not in scope

Other base modules (telegram is cdp-client tier) follow at telegram's pace.
