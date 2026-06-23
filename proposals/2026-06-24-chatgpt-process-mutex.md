# Proposal — chatgpt-webctl: adopt base `createProcessMutex` (+ .gitignore hardening)

* **For:** `webctl:chatgpt@knot` + Greg — review & adopt at your pace.
* **From:** `webctl:base@knot` (mutex consolidation, 2026-06-24).
* **Status:** base side GREEN + adapter pattern PROVEN on the sibling (telegram
  17/17). chatgpt adoption **must run chatgpt's own `tests/unit/mutex.test.js`
  before bumping** (test-before-bump, `xrl4`). **Not** pushed.
* **Refs:** `safety-process-mutex-factory-p06y`, `safety-process-mutex-v8m2`,
  `arch-constants-injection-seam-sm2t`, `infra-directory-structure-f868`.

## What this does

Replace `lib/mutex.js` (230 lines) with an **adapter shim** onto base's
`createProcessMutex(C, opts)` in **metadata** mode — preserving chatgpt's rich
`lock.json` metadata + module-level signal cleanup. chatgpt's lock layout is the
same `port-<N>.lock/` + pid + metadata that base produces.

```js
'use strict';
// lib/mutex.js — adapter onto base createProcessMutex(C), metadata mode.
const { processMutex } = require('../vendor/base-webctl/lib/index.js'); // require(esm)
const C = require('./client-config.constants');
const base = processMutex.createProcessMutex(C, { flock: 'off', metadata: true, signalCleanup: true });

function acquireLock(port, timeout, metadata) {
  return base.acquireLock(port, timeout, metadata).then(h => h.lockPath);
}
const registerLockCleanup = (lockPath) => base.registerLockCleanup({ mode: 'mkdir', lockPath });
module.exports = {
  getLockPath: base.getLockPath,
  readLockInfo: base.readLockInfo,
  isProcessAlive,            // keep chatgpt-local (display/aux helper)
  cleanupStaleLock,          // keep chatgpt-local OR drop (base reclaims internally)
  formatHolderDescription,   // keep chatgpt-local (pure display formatters)
  formatHeldDuration,        // keep chatgpt-local
  acquireLock,
  releaseLock: (lockPath) => base.releaseLock({ mode: 'mkdir', lockPath }),
  registerLockCleanup,
  clearLockCleanup: base.clearLockCleanup,
};
```

## API adaptation notes

| chatgpt export | base equivalent | adapter action |
|---|---|---|
| `getLockPath(port)` | `getLockPath` | re-export |
| `readLockInfo(lockPath)` | `readLockInfo(port\|path)` | re-export (accepts a path) |
| `acquireLock(port,timeout,meta)` → lockPath | `acquireLock` → handle | unwrap `h.lockPath` |
| `releaseLock(lockPath)` | `releaseLock(handle)` | wrap `{mode:'mkdir',lockPath}` |
| `registerLockCleanup(lockPath)` / `clearLockCleanup` | same | wrap / re-export |
| `writeLockInfo` | (base writes meta on acquire) | drop; base owns it |
| `isProcessAlive`, `cleanupStaleLock`, `format*` | — | keep chatgpt-local (display/aux) |

base's metadata schema (`schemaVersion/pid/tool/port/command/subcommand/client/
startedAt/extra`) is a superset of chatgpt's `lock.json`; pass chatgpt's
`{command,subcommand,chatId,model,port,client}` into `acquireLock(port,timeout,
metadata)` (extra fields land under `extra`). `flock:'off'` keeps base zero-dep
(no `fs-ext`); `signalCleanup:true` preserves the SIGINT/SIGTERM cleanup.

## SECURITY — bundle the `.gitignore` hardening (folded in per webctl:mgr)

Independently of the mutex, add an explicit **`credentials*` / `cookies*`** ignore
to chatgpt's `.gitignore` (it currently relies on `.env.*` + profile isolation;
LOW risk today, nothing tracked, but it touches the SECRET-FREE invariant). Use
the base `f868` `.gitignore` template as the source:

```gitignore
# secret-grade — never track
.env*
*credentials*
*cookies*
*token*
*.session
```

(`webctl:mgr` is also pinging chatgpt directly as the faster path; this bundle is
belt-and-suspenders so it can't be lost.)

## test-before-bump

Run chatgpt's `tests/unit/mutex.test.js` (13 cases) + `npm test` against the
shim. The adapter pattern is proven on telegram (17/17); chatgpt's richer surface
means *your* suite is the authority. Confirm your `client-config.constants.js`
satisfies the full shape (base `assertConstants` runs at construction).

## Preconditions (chatgpt's FIRST base adoption)

* Add base submodule at `vendor/base-webctl`; ensure `lib/client-config.constants.js`
  (the sm2t seam) is present + complete.
* **Node ≥ 22.12** for `require(esm)`.

## Not in scope

The 9 already-extracted base modules + the browser-location chain (v0.4.0/v0.5.0
proposals) remain available to adopt at chatgpt's pace.
