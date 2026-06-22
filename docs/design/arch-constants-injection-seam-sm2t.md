---
id: sm2t
title: "Per-Repo Constants Injection Seam for Shared Modules"
category: arch
created: "2026-06-22"
updated: "2026-06-22"
status: draft
tags: [seam, dependency-injection, constants, factory, esm, require-esm, migration, secret-topology, multi-tenant]
tech:
  - name: "Node.js"
    version: ">=22.12"
relates_to: [sb7q, lf4f, 2fc5, v8p3, v7m2, r7m3]
depends_on: [sb7q]
expands: [sb7q]
similar_to: []
---

# Per-Repo Constants Injection Seam for Shared Modules

## Principle

**A shared module must receive each tool's per-repo constants without ever
importing them.** base is one source of truth for shared *behaviour*; the small
set of values that genuinely differ between tools (project identity, artifact
prefix, default port, env-var prefix, …) is *not* shared — it stays per-repo by
a Greg-approved co-design contract (2026-05-30). The open question this document
answers: **how does a module that lives in base read those per-repo values when,
by `sb7q`, base may not contain them?**

This is the design that unblocks the largest cluster of remaining extraction
work — three config-bound modules now (`chromium-prefs`, `client-config`,
`profile-lock`), then `mounts`, the `chromium-docker-xpra` driver, and the
`registry` + browser-location `index` orchestration chain that sit on top of
them.

## The contract this must honour (do not violate)

* **Per-repo values stay per-repo (2026-05-30).** `client-config.constants`
  holds PER-REPO data only — `PROJECT`, `ARTIFACT_PREFIX`, `IMAGE_CHROMIUM_REPO`,
  `IMAGE_XPRA`, `DEFAULT_CDP_PORT`, `CACHE_DIRNAME`, `ZOOM_DEFAULT_HOST`,
  `CONFIG_FILE_PROJECT`, `DOTENV_FILENAME`, `DOTENV_TEMPLATE`, `ENV_PREFIX`,
  `ENV_PREFIX_LEGACY`, `ENV_LEGACY_SUFFIXES`. It is **pure frozen data — no
  functions, no `require`** — so it is trivial to diff/mirror. base must **never
  ship a tool's real values**; it ships the **resolver + a shape/template only**
  (`sb7q`).
* **Distinct values keep tools co-resident.** Different ports / prefixes let two
  tools run simultaneously (`sb7q`, `v7m2`); the seam must preserve that.
* **Synchronous `require(esm)` path (`sb7q`).** The CJS consumers `require()` base
  ESM synchronously (Node ≥22.12). The seam must add **no top-level await** to any
  base module, or that path breaks.
* **Secret-free + multi-tenant (`v8p3`, `v7m2`).** The injected object carries no
  secrets; artifact names stay exact-prefixed.

## Why this is non-trivial: where `C` is read

Auditing the consumer modules (2026-06-22) shows two distinct usage scopes, and
the scope is what dictates a viable mechanism:

| Module | distinct `C.*` keys | read at **module scope**? |
|---|---|---|
| `client-config.js` | `PROJECT`, `DEFAULT_CDP_PORT`, `CONFIG_FILE_PROJECT`, `DOTENV_FILENAME`, `ENV_PREFIX`, `ENV_PREFIX_LEGACY`, `ENV_LEGACY_SUFFIXES` | **no** — only inside functions |
| `mounts.js` | `CACHE_DIRNAME`, `ARTIFACT_PREFIX`, `IMAGE_CHROMIUM_REPO`, `IMAGE_XPRA` | **no** — only inside functions |
| `chromium-prefs.js` | `ZOOM_DEFAULT_HOST`, `PROJECT` | **YES** — `const DEFAULT_HOST = C.ZOOM_DEFAULT_HOST;` |
| `profile-lock.js` | `PROJECT` | **YES** — `const LOCK_FILENAME = ` …`; const LOG_PREFIX = `… |

The **module-scope** reads are the trap: any mechanism that supplies `C` *after*
import (a setter/registry) runs *after* those top-level `const`s have already
captured `undefined`. The mechanism must make `C` available **at the moment the
module's logic first needs it** — which, for a clean and uniform rule, means
**before any of the module's code runs**, i.e. injected at construction.

## Shared vs per-repo split (a simplification base should make)

Today `client-config.js` also defines values that are **identical** in both
repos (`CACHE_BASE`, `CONFIG_BASE`, `CONFIG_SUBDIR`, the `PORT_OFFSET_*` set,
`ENV_SUFFIXES`, `CONTAINER_ENV`). Those are not a seam at all — base can **own
them directly** as ordinary module constants. So the injected object `C` only
needs the **per-repo subset** above; everything identical becomes base-internal.
This shrinks the seam surface and the template to exactly what differs.

## Options

Three mechanisms were considered. Code sketches use a neutral `C` for the
injected per-repo constants object and omit unrelated body.

### Option A — Per-module constants factory `createX(C)` — RECOMMENDED

Each shared module exports a **factory** that takes the per-repo constants and
returns the public surface. Module-scope derived constants move **into the
factory closure** (so they are computed from the injected `C`, not at import).

```js
// base: lib/chromium-prefs.js
/** @param {import('./client-config.constants.template.js').ClientConfigConstants} C */
export function createChromiumPrefs(C) {
  const DEFAULT_HOST = C.ZOOM_DEFAULT_HOST;          // was module-scope; now closure
  function writePrefs(opts = {}) { /* … uses DEFAULT_HOST, C.PROJECT … */ }
  function readPrefs(opts = {}) { /* … */ }
  return { writePrefs, readPrefs, /* … same names as today … */ };
}
```

```js
// consumer: lib/chromium-prefs.js  (CJS re-export shim — drop-in)
'use strict';
const C = require('./client-config.constants');               // per-repo, STAYS here
const { createChromiumPrefs } = require('../vendor/base-webctl/lib/chromium-prefs.js');
module.exports = createChromiumPrefs(C);                       // same flat surface callers expect
```

* **Pros:** base never imports constants; the consumer injects them. **No
  top-level await**, so `require(esm)` stays synchronous. Consumer **call sites
  do not change** — the shim re-exports the identical flat API. `C` is fully
  type-checked against the shared `@typedef`. No global mutable state →
  multi-tenant-clean. Uniform rule for module-scope and function-scope reads
  alike (everything is closure-local).
* **Cons:** the base module's exported *shape* changes from a flat object to a
  factory — but that change is fully absorbed by the one-line shim, invisible to
  callers. Minor per-module boilerplate (one `create*` wrapper + a closing
  `return`).

### Option B — Injected singleton registry `setConstants(C)` + lazy getters

base ships `constants-registry.js` exposing `setConstants(C)` / `getConstants()`;
every module reads `getConstants()` **lazily inside functions**. The consumer
shim calls `setConstants(C)` once at load.

```js
// base module
import { getConstants } from './constants-registry.js';
export function writePrefs(opts = {}) { const C = getConstants(); /* … */ }
```

* **Pros:** base module export stays a flat object (no factory).
* **Cons:** the **module-scope** reads (`chromium-prefs`, `profile-lock`) must be
  rewritten into lazy getters — an invasive change to exactly the modules that
  are otherwise byte-stable. Introduces **global mutable process state** with an
  **ordering hazard** (must `setConstants` before the first `getConstants`; a
  stray early read yields `undefined`). In a hypothetical single-process,
  multi-consumer scenario the singleton is a foot-gun (last writer wins). More
  moving parts for a strictly worse safety profile. **Rejected.**

### Option C — Explicit `C` parameter on every public function

`writePrefs(C, opts)`, `acquireLock(C, …)`, etc. — purely functional, no closure,
no state.

* **Pros:** maximally explicit; trivially testable; zero hidden state.
* **Cons:** **every call site in the consumer changes** (a new required first
  arg), so the shim can **no longer be a drop-in** — it would have to wrap and
  re-bind every function, or the consumer must edit all call sites. That defeats
  the migration's "thin re-export shim" property proven in v0.1.0–v0.2.0 and
  forces a large consumer-side diff per module. **Rejected** for the shared
  surface (still fine *internally* within a factory).

## Recommendation

**Adopt Option A (per-module factory `createX(C)`)**, plus two base-side support
pieces:

1. **`lib/client-config.constants.template.js`** — base ships the **shape**, not
   values: a JSDoc `@typedef ClientConfigConstants` enumerating the required
   per-repo keys (with types + one-line semantics), and a frozen placeholder
   object whose values throw / are clearly-marked sentinels if ever used by
   accident. This is the "schema/template" `sb7q` promised. Consumers keep their
   real `client-config.constants.js`; CI in base type-checks every `createX(C)`
   against the typedef.

   ```js
   // base: lib/client-config.constants.template.js
   /**
    * @typedef {object} ClientConfigConstants
    * @property {string} PROJECT              e.g. "<tool>-webctl"
    * @property {string} ARTIFACT_PREFIX      exact docker name prefix, "<tool>-webctl-"
    * @property {string} IMAGE_CHROMIUM_REPO  "<tool>-webctl/chromium" (base appends -<x>:latest)
    * @property {string} IMAGE_XPRA           "<tool>-webctl/xpra-ubuntu:latest"
    * @property {number} DEFAULT_CDP_PORT     distinct per tool so tools co-reside
    * @property {string} CACHE_DIRNAME
    * @property {string} ZOOM_DEFAULT_HOST    per-host zoom target hostname
    * @property {string} CONFIG_FILE_PROJECT  per-project JSONC layer filename
    * @property {string} DOTENV_FILENAME
    * @property {string} DOTENV_TEMPLATE
    * @property {string} ENV_PREFIX           canonical env-var prefix
    * @property {?string} ENV_PREFIX_LEGACY   back-compat prefix, or null
    * @property {string[]} ENV_LEGACY_SUFFIXES
    */
   export {};
   ```

2. **`assertConstants(C)`** (defense-in-depth, `dip7`-aligned) — a tiny validator
   the factories may call first, throwing a loud, redaction-safe error naming any
   missing/empty required key. Fails a malformed consumer object fast instead of
   producing a silently-wrong artifact name (a multi-tenant hazard).

The shared-vs-per-repo split above is folded in: base owns the identical values
directly; only the per-repo subset is injected.

## Folded-in dependencies

### `mounts.js` — reconcile-before-extract

`mounts.js` is **not yet byte-identical** across the consumer repos — the copies
have **drifted** (a concrete instance of the byte-duplication failure `sb7q`
predicts). It also binds this seam (`ARTIFACT_PREFIX`, `IMAGE_*`,
`CACHE_DIRNAME`, all function-scope → factory-clean). Therefore mounts follows a
**reconcile → verify → extract** sequence: pick the canonical variant recorded
in the migration ledger / consumers matrix, confirm both consumers' suites pass
on it, *then* factory-extract via Option A. The concrete canonical choice and the
behavioural delta are tracked in the migration ledger
(`FUTURE_WORK/migrate/260622-registry-index-driver-deps.md`), not here, to keep
this spec service-agnostic.

### `chromium-docker-xpra` driver — the chain above mounts

The docker-xpra driver consumes `docker-ctl` (shipped v0.1.0), `cdp-rewrite`
(v0.2.0), `mounts` (post-reconcile), and the injected `C`. Under Option A it
becomes `createChromiumDockerXpra(C, deps?)` — `deps` optionally injects
`docker-ctl`/`mounts` for tests (matching the existing `profile-lock`
docker-ctl-injection seam). `registry.js` and browser-location `index.js` are the
orchestration top and migrate **last**, also as factories.

## Migration order (smallest safe steps)

1. **This doc → review (mgr → Greg)** before any cross-consumer code. *(gate)*
2. Land base support: `client-config.constants.template.js` (typedef) +
   `assertConstants` + the shared-constant move into base. Unit-test + `tsc`.
3. Factory-extract the three function/closure-clean modules — `client-config`,
   `chromium-prefs`, `profile-lock` — each: convert to `createX(C)`, unit-test,
   `tsc --checkJs`, prove in a scratch consumer clone (shim injects `C`), ship a
   per-module proposal. Target **v0.3.0**.
4. `mounts`: reconcile drift → verify → factory-extract.
5. `chromium-docker-xpra` driver → `registry` → browser-location `index`, in
   dependency order, each via Option A.

Each step stays independently adoptable and test-before-bump (`xrl4`); nothing
wires a consumer until its own suite is green on the new pin.

## Consequences

* base gains a uniform, type-checked **injection boundary** for per-repo config —
  the structural seam the family wanted expressed design-doc-first.
* The per-repo values never enter base; the 2026-05-30 contract holds verbatim.
* The synchronous `require(esm)` consumption path is preserved (no TLA, no async
  factory).
* The consumer shim stays a thin drop-in: `const C = require('./client-config.constants');
  module.exports = createX(C);`.

## Open questions for review

* **Template realness:** should `client-config.constants.template.js` ship
  *throwing* placeholders, or a documented all-sentinel object? (Recommend
  throwing getters so accidental use of the template in place of real constants
  is impossible to miss.)
* **`assertConstants` mandatory or opt-in?** Recommend the factories call it by
  default (fail-fast) with an escape hatch for advanced callers.
* **Driver `deps` injection shape** — confirm it mirrors the existing
  `profile-lock` injection contract so tests stay uniform.
