# Proposal — linkedin-webctl: consume `docker-ctl` from the base-webctl submodule

* **For:** `webctl:linkedin@knot` (owner of linkedin-webctl) — review & merge at
  your own pace.
* **From:** `webctl:base@knot` (pilot vertical slice, brief 2026-06-22).
* **Status:** PROVEN in a scratch clone; **not** pushed to linkedin. This is a
  proposal, not a landed change.
* **Refs:** `arch-shared-base-as-submodule-sb7q`, `test-cross-repo-consumer-loop-xrl4`.

## What this does

Replaces linkedin's byte-duplicated `lib/browser-location/docker-ctl.js` (302
lines) with a **15-line re-export shim** that imports the now-shared module from
a pinned `base-webctl` git submodule at `vendor/base-webctl`. One source of
truth; linkedin moves its pin only when its own tests pass (test-before-bump).

**Net diff:** `+14 / -297` lines, plus `.gitmodules` and the submodule pointer.

## Why it is safe (proven, not asserted)

Proven in a throwaway clone of linkedin-webctl@`8e85d31`
(`/tmp/claude/260622-1545-webctl-base-pilot/linkedin-scratch`), headless:

* **Baseline** (before change): `node test/docker-mode-test.js` → **57 passed, 0
  failed**.
* **After** wiring the submodule + shim: `node test/docker-mode-test.js` → **57
  passed, 0 failed** — identical. The `docker-ctl` mocked-spawn tests
  (`_escapeRe`, `run()`, `dockerAvailable`, `imageExists`, `containerRunning`,
  `psByLabel`, `networkExists/volumeExists`, …) all pass **through the
  submodule**.
* **Full suite, no collateral breakage:** all **24** `test/*-test.js` files green
  (including `profile-lock-test.js`, which also consumes `docker-ctl`).

### The two seams that make a synchronous CJS→ESM shim work

1. **`require(esm)`** — Node ≥22.12 (here: v22.22.2) lets a CJS file
   synchronously `require()` an ESM module that has **no top-level await** (base's
   docker-ctl has none). `require()` returns the module namespace, which the shim
   re-exports as `module.exports`. No build step, no `await import()` refactor of
   linkedin's call sites.
2. **spawn monkey-patch survives** — base's ESM module keeps the original's
   *indirect* access (`import child_process from 'node:child_process'` + call-time
   `child_process.spawn(...)`). ESM default-import and CJS `require()` of a
   builtin share the same mutable `module.exports` object, so linkedin's test
   harness (`require('child_process').spawn = mock`) still intercepts every verb.
   This is why the mocked suites stay green unchanged.

## The change

`.gitmodules` (new):

```ini
[submodule "vendor/base-webctl"]
	path = vendor/base-webctl
	url = git@github.com:CLIAI/base-webctl.git
```

`lib/browser-location/docker-ctl.js` becomes:

```js
// docker-ctl.js — re-export shim (migration to base-webctl submodule, sb7q).
//
// The implementation now lives ONCE in base-webctl and is consumed here via
// the pinned submodule at vendor/base-webctl. This file is a thin CJS shim so
// every existing `require('./docker-ctl')` site (driver, profile-lock, tests)
// keeps working unchanged.
//
// Node >=22.12 `require(esm)` makes this synchronous: base ships zero-dep ESM
// with no top-level await, so require() returns its namespace. The base module
// reads `child_process.spawn` at call time, preserving the unit suites'
// spawn monkey-patch seam.
//
// Tag: [TOOL::*] [WEBCTL::CDP]
'use strict';
module.exports = require('../../vendor/base-webctl/lib/browser-location/docker-ctl.js');
```

The full patch (shim + `.gitmodules` + submodule pointer) is archived at
`/tmp/claude/260622-1545-webctl-base-pilot/linkedin-docker-ctl-submodule.patch`.

## How to adopt (suggested, at your pace)

```bash
cd linkedin-webctl
git checkout -b i-adopt-base-docker-ctl       # or your branch convention
git submodule add git@github.com:CLIAI/base-webctl.git vendor/base-webctl
git -C vendor/base-webctl checkout <RELEASED_BASE_SHA>   # the pinned commit
# replace lib/browser-location/docker-ctl.js with the shim above
node test/docker-mode-test.js                  # expect 57 passed, 0 failed
git add .gitmodules vendor/base-webctl lib/browser-location/docker-ctl.js
git commit   # separate, focused submodule-pin commit (sb7q §version-bump)
```

## Preconditions on base (owner: webctl:base)

* The scratch proof pinned base via a **local path** for speed. The real bump
  must pin the **github URL** at a released SHA:
  * base must **push** `master` to `git@github.com:CLIAI/base-webctl.git`, and
  * **tag** the release (proposed `v0.1.0`) so linkedin pins an immutable commit.
* Engine floor: the shim relies on `require(esm)` → **Node ≥22.12**. linkedin's
  `package.json` currently declares `"engines": { "node": ">=18" }`. Adopting
  the submodule shim **raises that floor to ≥22.12** (or linkedin keeps `>=18`
  but documents that the submodule path needs 22.12+). Flagged as the one
  consumer-side decision; see `FUTURE_WORK/migrate/260622-linkedin-node-floor-require-esm.md`
  in base.

## Not in scope here

* No change to linkedin's `master` (this is a proposal).
* `./test-against-base.sh` contract entrypoint for linkedin (xrl4) is a separate,
  small follow-on; the gate currently marks linkedin `"wired": false` → SKIP.
* The real-browser `--stack` docker tests are unaffected (the shim is a drop-in).
