# Proposal — linkedin-webctl: adopt base `createProcessMutex` (de-monolith)

* **For:** `webctl:linkedin@knot` + Greg — review & adopt at your pace.
* **From:** `webctl:base@knot` (mutex consolidation, 2026-06-24).
* **Status:** base side GREEN (incl. a 3-test multi-process contention proof +
  the TOCTOU fix that proof caught). linkedin adoption **must run
  `test/concurrency-lock-test.js` + `test/lock-age-test.js` before bumping**
  (test-before-bump, `xrl4`). **Not** pushed.
* **Refs:** `safety-process-mutex-factory-p06y`, `safety-process-mutex-v8m2`.

## What this does (a de-monolith, not a file swap)

linkedin's port mutex is **embedded in `linkedin-runner.js`** (the 22.4k-line
monolith), `:1309 tryFlockAcquire`, `:1348 getLockAgeMs`, `:1357 acquireLock`,
`:1419 releaseLock` (~180 lines). Replace that block with a small base-backed
lock module + call-site updates — **chipping ~180 lines off the monolith** while
preserving linkedin's distinctive features (flock-when-available + **age-based
reclaim**).

```js
// lib/port-mutex.js (new, small) — adapter onto base, flock:auto + age reclaim.
'use strict';
const { processMutex } = require('../vendor/base-webctl/lib/index.js');
const C = require('./client-config.constants');           // linkedin already ships this (v0.3.0)
// Inject linkedin's EXISTING fs-ext binding as flockImpl IFF present; else 'auto'
// resolves to the mkdir floor (which is what linkedin does today when fs-ext is
// absent — it is NOT currently installed in linkedin/node_modules).
let flockImpl = null;
try { const { flockSync } = require('fs-ext'); flockImpl = (fd, op) => flockSync(fd, op); } catch (_) { /* mkdir floor */ }
const base = processMutex.createProcessMutex(C, {
  flock: 'auto', flockImpl,
  staleAgeSec: /* from --lock-max-age, default */ 15 * 60,
  timeoutExitCode: 5,   // linkedin's EXIT.LOCK_TIMEOUT
});
module.exports = base; // runner uses base.acquireLock(port,timeout)/releaseLock(handle)
```

Then in `linkedin-runner.js`: delete the embedded lock functions and call
`portMutex.acquireLock(port, timeout)` / `portMutex.releaseLock(handle)`; map the
`--lock-max-age` flag to `staleAgeSec`. The runner's `getLockAgeMs` /
`isProcessAlive` helpers are subsumed by base (`getLockAgeMs`, internal pid check).

## Why base covers linkedin's features

* **flock-primary + mkdir fallback** — `flock:'auto'` uses the injected `fs-ext`
  binding when present, else the mkdir floor. base **never** deps `fs-ext`; it
  stays **linkedin's** dep (keep it in linkedin's `package.json` if/when you want
  the flock path; today it's absent so behaviour = mkdir, unchanged).
* **age-based reclaim of a wedged-but-alive holder** — `staleAgeSec` (= your
  `--lock-max-age`, default 15 min). This is the exact behaviour p06y §3.1
  documents (opt-in; default 0 elsewhere, but linkedin sets it).
* **PID-liveness reclaim, symlink-safety, atomic acquire** — all in base. base's
  acquire is **atomic-rename** (temp dir with pid inside → `renameSync`), which
  closes a real TOCTOU double-acquire window the promoted concurrency harness
  caught — a correctness *improvement* over the embedded version's
  mkdir-then-write-pid.

## test-before-bump

base ships the promoted concurrency proof (`test/process-mutex-concurrency.test.js`,
adapted from **your** `test/concurrency-lock-test.js` + `lock-helper.js`). After
wiring, run linkedin's own `test/concurrency-lock-test.js`, `test/lock-age-test.js`,
`test/lock-helper.js`-driven suites against the shimmed primitives — mutual
exclusion, dead-pid reclaim, and age takeover must stay green. Commit the pin only
on green. (linkedin is already wired to base at v0.3.0, so this rides the existing
submodule.)

## Notes

* Bump linkedin's submodule pin to the release carrying `createProcessMutex`.
* This is the largest of the three mutex adoptions (a runner refactor, not a file
  swap) — schedule it deliberately; it also advances de-monolithing the 22.4k
  runner.
