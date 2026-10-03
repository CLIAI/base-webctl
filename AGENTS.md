# base-webctl — Agent Instructions

`base-webctl` is the **shared foundation** of the `*-webctl` web-control tool
family (linkedin / chatgpt / telegram / fetlife / future per-site tools). It is
two things at once:

1. the **canonical design corpus** — universal, service-agnostic specs in
   `docs/design/` (the WHY/WHAT); and
2. a **shared zero-dependency code library** in `lib/` (the HOW), consumed by each
   tool as a **git submodule pinned to a released commit** (the migration off
   byte-duplication is in progress — see `arch-shared-base-as-submodule-sb7q`).

## Invariants (do not violate)

* **Secret-free, always.** No cookies / session-state / tokens / credentials ever
  enter git. `.gitignore` follows base's own `infra-directory-structure-f868`
  template. base docs forbid defaulting a browser profile into any
  publishable/exportable location.
* ⛔ **base is the ONE PUBLIC repo in this family** — `CLIAI/base-webctl` is
  public; **every** consumer is private. So a worked example here is a
  publication. ⇒ **Provenance by ROLE, never by hostname:** write *"measured by
  `ccew` on its remote target"*, never the host alias; and never a real hostname,
  username, IP or home path in a doc, comment or commit message. Redacting does
  not weaken a measurement whose subject is a tool's behaviour rather than a
  machine. ⚠ Measured 2026-09-27: `arch-browser-targets-btg4` had shipped **13**
  host-alias references, and a contributed section additionally printed a real
  hostname and, via `x$(id -un)y`, the remote username. A first redaction pass
  replaced an alias with a name *derived from* the real hostname — which is not a
  redaction. Check the diff, not the intent.
  * ⛔ **AND OUR OWN AGENT HANDLES CARRY MACHINE NAMES.** A fleet handle is
    `lane:role@host` — so citing a reviewer by their handle publishes the host.
    ⇒ **Cite the LANE** (`ccew`, `cgwc`, `webctl:mgr`), never `lane@host`. The lane
    is the information; the machine is not. ⚠ Measured 2026-09-27: ~30 lines of
    June-era `proposals/` and `FUTURE_WORK/` attribute *"For:"* and *"From:"* with
    full `lane@host` handles, which is the bulk of this repo's remaining exposure
    — and it is the one class that is **mechanically** removable without losing
    anything, because the lane name survives the edit. *(Raised by `ccew`, whose
    own handle carries it.)*
* **Zero runtime dependencies** (`arch-zero-dependency-philosophy-v8p3`). base is
  modern **ESM JavaScript** with **JSDoc** types checked by `tsc --checkJs
  --noEmit` in base's CI only — **no build step, no toolchain imposed on
  consumers**, nothing compiled committed.
* **Design-doc-first.** New shared behaviour is specced here (state machines,
  flow/transition contracts, module API boundaries) **before** it lands in `lib/`.
* **Service-agnostic.** Specs and lib never name a specific platform.
* Bash `set -euo pipefail`; markdown blank-line-before-list + `*` bullets; small
  focused commits; non-trivial scripts ship `.README.md` + `.DEV_NOTES.md`.

## ⛔ Roughly HALF of base's callable surface is not a module export

**Measured 2026-09-23 at v0.13.1** — by construction, three times, by three
parties independently:

    module-level exports    140
    factory-return members  117
    ⇒ 46% of the callable surface is reachable ONLY by calling a factory

⇒ So **`grep 'export function X'` is structurally blind to half of this
library.** `inspect()` is the worked example: it exists on the driver returned
by `createChromiumDockerXpra(C).createDriver(cfg)` and on `createProfileLock(C)`,
and appears in **no** module's exports.

⚠ **This is not a hypothetical.** A consumer lane and its manager *independently*
concluded *"`inspect()` does not exist in base"*, both using a module-export
query, both reporting *"verified at the tag"*. Neither was careless — **the
query is the one a consumer naturally writes**, and a lane that reaches that
conclusion reimplements the capability locally, which is the duplication this
whole programme exists to stop, arrived at by someone doing due diligence.

⇒ **To find something in base, construct and inspect; do not grep for
`export`.** Two surfaces that are easy to confuse, named by the object they
live on:

    cfg.portSources          raw source STRINGS, on buildDriverCfg()'s result
    driver.inspect().ports   {value, source} per port, on the DRIVER

⚠ **And enumerating by CALLING is not free** — `resolveChromiumProfile()`
`mkdir`s. Any tool that walks this surface must construct against a throwaway
`HOME`/`userDataDir` and **prove it did not write**, rather than assert it.

## Design docs

* Conventions + frontmatter schema: `docs/design/DESIGN_DOCS_GUIDELINES.md`.
* **Validate before commit:** `uv run scripts/verify_yaml_frontmatter.py docs/design/`
  (checks required fields, unique 4-char IDs, category/filename match, cross-refs).
* Current corpus (filename = `{category}-{slug}-{id}.md`; cross-ref by ID):
  * **arch** — `arch-shared-base-as-submodule-sb7q` (submodule model, substrate
    decision, semver, secret modes, FUTURE_WORK),
    `arch-constants-injection-seam-sm2t` (how shared modules receive per-repo
    constants without importing them — the `createX(C)` factory seam),
    `arch-automatic-browser-lifecycle-8hw5`,
    `arch-browser-targets-btg4` (a TARGET says where a browser is and how to
    reach it; a PROFILE is the Chromium user-data dir — local, docker, or remote
    over ssh), `arch-coincident-fields-t2wf` (two fields holding one value are
    indistinguishable from one field), `arch-login-mode-clean-signin-lg1n` (a
    clean, exclusive, non-retrying window for a human sign-in; "clean" is MEASURED
    from the running browser's argv, never assumed from flags),
    `arch-remote-targets-build-inventory-rm7t` (`--tailscale` reaches ssh only; remote
    build/refresh behind the ownership claim, verified by a version READING; a
    read-only inventory where unreachable is UNKNOWN, never omitted),
    `arch-target-resolution-no-implicit-location-nl0c` (never assume where the browser
    runs: flag > env > config, else refused before any contact; `--target` is the
    location flag), `arch-remote-bring-up-over-ssh-rb7s` (the driver's work happens ON
    the target — phases 2–3 superseded by rx9q), `arch-runtime-layer-xq-boundary-rx9q`
    (xq runs the app up to a declared control port; base speaks CDP/BiDi above it;
    capability-pinned, never version-pinned).
  * **test** — `test-cross-repo-consumer-loop-xrl4` (the `test-against-base.sh`
    contract + `consumers.jsonc` + the release gate),
    `test-checks-that-cannot-fail-k3wn` (verification discipline, led by base's
    OWN shipped defects).
  * **infra** — `infra-directory-structure-f868`, `infra-browser-configuration-v7m2`,
    `infra-cdp-websocket-client-v7x3`, `infra-client-profile-registry-lf4f`,
    `infra-config-precedence-2fc5`, `infra-dotenv-configuration-r7m3`,
    `infra-logging-output-sazn`, `infra-storage-path-resolution-v59v`,
    `infra-xpra-remote-access-gateway-f6rd`.
  * **safety** — `safety-blocked-state-handling-k7m2`,
    `safety-defense-in-depth-pipeline-dip7`, `safety-process-mutex-v8m2`,
    `safety-process-mutex-factory-p06y`,
    `safety-safe-invocation-file-payloads-r7x2` (argv arrays, file payloads — and
    §1b, the REMOTE shell boundary an argv array does not cross),
    `safety-target-ownership-and-lock-identity-ow9k` (one identity for the X-input
    lease AND for "is this browser mine"; an unrecognised lock is HELD, never free).
  * **ux** — `ux-dual-audience-help-nho9`, `ux-tab-management-lru-1wsg`,
    `ux-ui-state-hygiene-iqrg`, `ux-gui-subcommand-surface-gu1d`.
  * **data** — `data-jsonl-machine-interface-lszd`.

⛔ **This list is checked, not maintained by memory.**
`test/agents-md-indexes-the-corpus.test.js` fails if a doc exists uncited or a
citation resolves to no file. Measured 2026-09-27, before that guard: 26 docs on
disk, **19 cited** — seven invisible to anyone who trusted the index, two of them
written that same week. The drift is silent: a missing entry breaks nothing, it
just means a lane re-derives a spec that already exists.

## Submodule / migration role

* Consumers add base at `vendor/base-webctl/` and import only `lib/index.js`.
* **Test-before-bump:** a consumer moves its pin only after its own
  `./test-against-base.sh` passes on the newer base (`sb7q` §version-bump; full
  contract in `xrl4`). base's `scripts/test-all-consumers.sh` gates releases.
* Migration runs **one small refactoring at a time**, coordinated by
  `webctl:mgr`. Deferred work is logged per-consumer under
  `FUTURE_WORK/{category}/{YYMMDD}-{slug}.md` — never block; leave a note.
