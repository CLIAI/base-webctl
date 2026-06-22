---
id: sb7q
title: "Shared base-webctl as a Pinned Git Submodule"
category: arch
created: "2026-06-22"
updated: "2026-06-22"
status: draft
tags: [submodule, shared-library, versioning, semver, migration, esm, jsdoc, future-work, secret-topology]
tech:
  - name: "Node.js"
    version: ">=22.12"
  - name: "Git submodules"
    version: ""
relates_to: [v8p3, f868, lf4f, v7m2, xrl4]
depends_on: [v8p3]
expands: []
similar_to: []
---

# Shared base-webctl as a Pinned Git Submodule

## Principle

**One source of truth for shared code, consumed at a version each tool controls.**
Until now the `*-webctl` tools shared code by **byte-duplication** — the same
`lib/*.js` copied into every repo and kept identical by human discipline plus a
shape test. That works until a file drifts (and several already have: a fix lands
in one repo and never reaches the others). This document defines the replacement:
the shared code lives **once** in `base-webctl`, and every tool consumes it as a
**git submodule pinned to a specific commit**, bumping that pin only after its own
tests pass on the newer base. No tool is ever auto-broken by a base change.

> This is a **migration**, run one small refactoring at a time (see
> `## Incremental migration`), not a big-bang rewrite.

## Language & substrate decision (2026-06-22)

> Decision made under delegated authority; revisit if the trade-offs change.

base is authored in **zero-dependency, modern ESM JavaScript**, with **JSDoc type
annotations** verified by `tsc --checkJs --noEmit` in **base's own CI only**.

* **Zero runtime dependencies** — preserves the property the tools deliberately
  hold (`v8p3`). Consumers `import` plain `.js`; **no build step, no toolchain,
  no devDependency is imposed on any consumer.**
* **JSDoc + `--checkJs`** gives real compile-time type-checking across the module
  API boundaries — the robustness lever for a library many repos depend on — with
  **no emitted build artifact** (nothing compiled is committed; honours the
  no-build-artifacts repo rule).
* **ESM-first** — fetlife-webctl is already ESM and consumes base natively; the
  CJS tools (linkedin/chatgpt/telegram) consume base ESM **synchronously** via
  Node's `require(esm)` (see the consumption-floor policy below), so no
  `await import()` and no call-site rewrite is needed — a CJS file does
  `module.exports = require('../vendor/base-webctl/lib/<module>.js')`.

### Node consumption-floor policy (decided 2026-06-22, Greg)

**The fleet-wide minimum runtime for consuming base is Node `>=22.12`.** That is
the release line where `require()` of an ESM module (no top-level await) is
stable and synchronous — the mechanism that lets the CJS tools adopt base with a
thin re-export shim instead of an `await import()` refactor (proven in the
v0.1.0 docker-ctl pilot + the v0.2.0 leaf modules).

Consequences, binding on the whole family:

* base's own `package.json` declares `"engines": { "node": ">=22.12" }` as the
  **consumption floor** every consumer inherits; chatgpt/telegram adopt the same
  floor when they wire the submodule.
* **base modules MUST stay top-level-await-free** so `require(esm)` remains
  synchronous. (A future CI assert can enforce this; today it is a review rule.)
* A consumer on older Node hitting the submodule path gets a hard `require()`
  throw — acceptable because the floor is now policy, not a silent assumption.

Rejected alternatives, for the record:

* **TypeScript with a build step** — would force a `typescript` devDependency +
  build on the deliberately zero-dep tools, and commit compiled output. The
  robustness goal is met by JSDoc+`--checkJs` without that cost.
* **Rust → WASM** — the base core is **I/O-bound orchestration**: spawning
  `docker` (child_process), bind-mounting Chromium profiles (filesystem), driving
  Chromium over CDP WebSockets (`v7x3`). A WASM sandbox cannot perform that I/O
  without extensive host bindings, and a native rewrite contradicts the
  incremental-migration mandate. *Narrow future opening:* a pure-logic core
  (run-mode state machine, selector-drift detection, the cache-discrepancy diff)
  could later become a Rust→WASM module **if** a genuine cross-language plugin
  need appears. Not now.

Architecture concerns the family wants long-term — explicit **state machines**,
**formal flow/transition specs**, **module API boundaries**, **separation of
concerns** — are expressed **design-doc-first** in this directory (the human
review surface; language-independent), then implemented in `lib/`.

## Repository layout

base is no longer spec-only; it gains a code library beside the design docs:

```
base-webctl/
├── docs/design/            # the specs (this directory) — the WHY/WHAT
├── lib/                    # shared ESM modules — the HOW (zero-dep)
│   ├── browser-location/   # mode resolver, docker-ctl, profile-lock, ...
│   ├── chromium-prefs.js   client-config.js  lru-cleanup.js  ...
│   └── index.js            # the public API surface (see "API surface" below)
├── dockerfiles/            # shared chromium/xpra Dockerfile tree (templated tags)
├── scripts/
│   ├── verify_yaml_frontmatter.py
│   ├── test-all-consumers.sh        # the cross-repo gate (see xrl4)
│   └── verify-no-byte-drift.sh      # guards against re-vendoring (see xrl4)
├── consumers.jsonc         # registry of consuming repos (see xrl4)
└── package.json            # name, exports map, semver version, "type":"module"
```

## Submodule convention

* **Path (fleet-wide, uniform):** `vendor/base-webctl/`.
* Each consumer adds base as a submodule pinned to a released commit:
  `git submodule add git@github.com:CLIAI/base-webctl.git vendor/base-webctl`.
* Consumers import the public surface, never reach into internal files:
  `import { resolveBrowserLocation } from '../vendor/base-webctl/lib/index.js'`.
* `verify-no-byte-drift.sh` asserts no consumer has re-vendored (copied) a base
  file back into its own `lib/` — i.e. no silent regression to byte-duplication.

## API surface & semver

* `lib/index.js` is the **only** public entry; everything else is internal.
* base is **semver-versioned** in `package.json` and **git-tagged** per release.
  * **patch** — bug fix, no API change.
  * **minor** — additive (new export / new optional param).
  * **major** — breaking API change; **every** consumer must pass the cross-repo
    gate before the major is cut (see `xrl4`).
* The **per-repo seam stays per-repo**: `lib/client-config.constants.js`
  (PROJECT / ARTIFACT_PREFIX / DEFAULT_CDP_PORT / ZOOM_DEFAULT_HOST / ENV_PREFIX)
  is *never* shared (Greg-approved co-design contract, 2026-05-30). base ships
  the **resolver** + a constants **schema/template**; each tool fills in its own
  values. Distinct ports (e.g. 4327 vs 4877) keep tools running simultaneously.

## Secret topology — two supported modes

base canonicalises **secrets-out-of-image**: a published/exported container image
must leak **zero** auth (cookies / LocalStorage / IndexedDB / session-state). Two
profile-storage modes satisfy this; a tool selects one via its config:

1. **Host bind-mount (default).** The Chromium profile is a host directory
   bind-mounted into the container (`profileHostPath → /home/user/.config/chromium`,
   rw); the image holds no auth. The only named volume holds the **X11 socket**
   (zero secrets). This is the current fleet behaviour and the recommended default.
2. **Named-volume profile (opt-in).** The profile lives in a **dedicated named
   docker volume**, isolated from the image so the image stays leak-free while the
   secrets persist on the volume. Selected explicitly per tool.

Invariants for **both** modes (see also `f868`, `lf4f`, `v7m2`, `dip7`):

* Per-**client** profile isolation (`--client`, `lf4f`) so cookies never cross clients.
* `userDataDir` resolution order CLI > dotenv > env > JSONC; **base docs forbid
  defaulting a profile into any publishable/exportable location** (e.g. inside the
  repo or image build context).
* CDP debug port binds `127.0.0.1` only.
* Error-message redaction of Authorization headers + session-token URLs (`v8p3`).
* Secret-free `.gitignore` (the `f868` template) shipped in every tool.

## Version-bump process (test-before-bump)

The full loop + the consumer test contract live in `xrl4`. Summary of the SOP that
**every consumer's `AGENTS.md` links to via the submodule path**
(`see vendor/base-webctl/docs/design/test-cross-repo-consumer-loop-xrl4.md`):

1. base lands a change on a branch; base's own unit + `--checkJs` pass.
2. Maintainer runs `scripts/test-all-consumers.sh` against the candidate commit —
   it loops `consumers.jsonc`, exercises each consumer headlessly, collects
   pass/fail/skip. A base release is greenlit only if **zero** consumers FAIL.
3. base tags a semver release.
4. **Each consumer bumps its own submodule pin independently, at its own pace,**
   re-running its `./test-against-base.sh` against the new pin **before** committing
   the pointer bump. A consumer is never auto-broken — its pin moves only when its
   own tests pass.
5. Submodule-pointer bumps are **separate, focused commits**.

## Incremental migration & FUTURE_WORK

Migration is driven **one small refactoring at a time**, coordinated by the
manager (`webctl:mgr`). As base ships each shared module, the manager notifies the
consumer agents to: (a) refactor that tool to consume it from the submodule,
(b) test, (c) report back. **Nothing blocks.** If a consumer cannot migrate or
cannot test a piece yet, it does **not** stall — it records the deferral as a note:

```
<consumer-repo>/FUTURE_WORK/{category}/{YYMMDD}-{slug}.md
```

* `{category}` — e.g. `migrate`, `test`, `reconcile`, `esm`, `docker`, `secret`.
* `{YYMMDD}` — creation date (check `date +%y%m%d`).
* Body — what is deferred, why, what unblocks it, and the base module/ID it concerns.

`FUTURE_WORK/` is the family-wide ledger of "to migrate / to test / to reconcile
later," so coordination is forward-looking and no agent is ever blocked waiting on
another. The manager sweeps these notes to schedule the next small refactoring.

## Consumer tiers (capability is opt-in; base never forces docker/browser)

* **full** — managed browser + docker (linkedin, chatgpt): consume everything.
* **CDP-client-only** — no docker (telegram): consume utils + CDP client, not the
  docker/browser-location layer.
* **contracts-only** — (fetlife, ESM): consume policy/contracts (gitignore,
  redaction, 127.0.0.1, env-prefix, exit codes, the test contract), little/no code.
