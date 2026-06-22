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
* **Zero runtime dependencies** (`arch-zero-dependency-philosophy-v8p3`). base is
  modern **ESM JavaScript** with **JSDoc** types checked by `tsc --checkJs
  --noEmit` in base's CI only — **no build step, no toolchain imposed on
  consumers**, nothing compiled committed.
* **Design-doc-first.** New shared behaviour is specced here (state machines,
  flow/transition contracts, module API boundaries) **before** it lands in `lib/`.
* **Service-agnostic.** Specs and lib never name a specific platform.
* Bash `set -euo pipefail`; markdown blank-line-before-list + `*` bullets; small
  focused commits; non-trivial scripts ship `.README.md` + `.DEV_NOTES.md`.

## Design docs

* Conventions + frontmatter schema: `docs/design/DESIGN_DOCS_GUIDELINES.md`.
* **Validate before commit:** `uv run scripts/verify_yaml_frontmatter.py docs/design/`
  (checks required fields, unique 4-char IDs, category/filename match, cross-refs).
* Current corpus (filename = `{category}-{slug}-{id}.md`; cross-ref by ID):
  * **arch** — `arch-shared-base-as-submodule-sb7q` (submodule model, substrate
    decision, semver, secret modes, FUTURE_WORK), `arch-automatic-browser-lifecycle-8hw5`.
  * **test** — `test-cross-repo-consumer-loop-xrl4` (the `test-against-base.sh`
    contract + `consumers.jsonc` + the release gate).
  * **infra** — `infra-directory-structure-f868`, `infra-browser-configuration-v7m2`,
    `infra-cdp-websocket-client-v7x3`, `infra-client-profile-registry-lf4f`,
    `infra-config-precedence-2fc5`, `infra-dotenv-configuration-r7m3`,
    `infra-logging-output-sazn`.
  * **safety** — `safety-blocked-state-handling-k7m2`,
    `safety-defense-in-depth-pipeline-dip7`, `safety-process-mutex-v8m2`.
  * **ux** — `ux-dual-audience-help-nho9`, `ux-tab-management-lru-1wsg`,
    `ux-ui-state-hygiene-iqrg`.
  * **data** — `data-jsonl-machine-interface-lszd`.

## Submodule / migration role

* Consumers add base at `vendor/base-webctl/` and import only `lib/index.js`.
* **Test-before-bump:** a consumer moves its pin only after its own
  `./test-against-base.sh` passes on the newer base (`sb7q` §version-bump; full
  contract in `xrl4`). base's `scripts/test-all-consumers.sh` gates releases.
* Migration runs **one small refactoring at a time**, coordinated by
  `webctl:mgr`. Deferred work is logged per-consumer under
  `FUTURE_WORK/{category}/{YYMMDD}-{slug}.md` — never block; leave a note.
