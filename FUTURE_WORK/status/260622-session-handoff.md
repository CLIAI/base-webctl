# Session handoff — webctl:base@knot (2026-06-22)

Durable state snapshot before a `/clear`. Read this + the two milestone status
files (`260622-pilot.md`, `260622-v0.2.0.md`) + the design corpus to resume.

## Released (on origin: git@github.com:CLIAI/base-webctl.git, branch master)

* **v0.1.0** (`3cbfe63`) — docker-ctl pilot: zero-dep ESM `docker-ctl.js` +
  `lib/index.js` + gate scaffolding (`consumers.jsonc`,
  `scripts/test-all-consumers.sh`, `scripts/verify-no-byte-drift.sh`,
  `read-consumers.mjs`).
* **v0.2.0** (`5032279`) — 5 clean leaf modules: `cdp-rewrite`,
  `localhost-direct`, `xpra-presence`, `lru-cleanup`, `systemd-timer`.
* base CI green at HEAD: **38/38 `node --test`**, **`tsc --checkJs` clean**,
  release gate exits 0 (all consumers `wired:false` → SKIP).
* **Node consumption floor = `>=22.12`, fleet-wide** (Greg, 2026-06-22) — codified
  in `sb7q` substrate section + `package.json` engines. base modules must stay
  **top-level-await-free** (keeps `require(esm)` synchronous).

## Proven consumption (scratch only — NO consumer repo touched)

* `/tmp/claude/260622-1545-webctl-base-pilot/linkedin-scratch`: linkedin@`8e85d31`
  + base submodule, 6 modules shimmed → **24/24 test files green**. Patches:
  `linkedin-docker-ctl-submodule.patch`, `linkedin-v0.2.0-five-modules.patch`.
  (NB: /tmp is ephemeral — the patches are reproducible from the proposals.)

## Delivered proposals (staged for the manager to hand to consumers; NOT pushed)

* `proposals/2026-06-22-linkedin-docker-ctl-submodule.md`
* `proposals/2026-06-22-linkedin-v0.2.0-five-modules.md`
* `proposals/2026-06-22-chatgpt-v0.2.0-five-modules.md`
* The manager (webctl:mgr) is delivering these to webctl:linkedin / webctl:chatgpt.

## PARKED pending Greg's review — DO NOT WIRE CONSUMERS

* **`docs/design/arch-constants-injection-seam-sm2t.md`** (status: draft) — the
  per-repo constants seam. Recommends **Option A: per-module factory `createX(C)`**
  (consumer shim injects its own `client-config.constants`; base never imports
  values). Goes mgr → Greg for sign-off BEFORE any cross-consumer implementation.
* Blocked behind that sign-off (all in `FUTURE_WORK/migrate/`):
  * 3 SEAM modules — `chromium-prefs`, `client-config`, `profile-lock`
    (`260622-client-config-constants-seam.md`).
  * `mounts.js` — **drifted** linkedin↔chatgpt; reconcile-to-canonical THEN
    factory-extract; then the `chromium-docker-xpra` driver, then
    `registry` + browser-location `index` (`260622-registry-index-driver-deps.md`).

## Next actions when resuming

1. Await Greg's verdict on `sm2t` (via webctl:mgr). Until then, seam work is parked.
2. On sign-off: land base support (constants template/typedef + `assertConstants`
   + move shared constants into base), then factory-extract the 3 seam modules →
   **v0.3.0**, each: unit-test + `tsc` + scratch-prove + per-module proposal.
3. Independent of the seam: a consumer adopting v0.2.0 may surface questions.

## Comms

* Manager pane: `tmux -L default -t webctl-mgr:0`. Introduce as `(webctl:base)`.
  Use the collision-safe sender; verify the pane is idle (not on a menu) first.
