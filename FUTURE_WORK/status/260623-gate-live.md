# Status — xrl4 cross-consumer gate made REAL (2026-06-23)

**Result: GREEN + real.** The release gate was a false green (all `wired:false` +
no consumer contracts → all-SKIP/exit0, proving nothing). It now genuinely guards
base→consumer breakage. Manager-directed (post-v0.5.0); no Greg decision required
for the mechanism.

## What landed in base (pushed: 39b169c, 88cd117)

* **Contract authored** — `scripts/reference/linkedin-test-against-base.sh`:
  `--offline|--unit|--stack`, exit `0/1/2`, lszd JSONL envelopes, mapped to
  linkedin's runners (24 `test/*-test.js` offline; `docker-live-test.sh` `--stack`
  gated on `LINKEDIN_WEBCTL_DOCKER_TESTS=1`). Delivered as a linkedin adoption
  proposal — NOT committed to linkedin (no-touch rule).
* **Gate hardened** — `scripts/test-all-consumers.sh`: a `wired:true` consumer
  lacking the contract script → SKIP "contract pending" (not FAIL/exit127);
  auto-flips to real PASS/FAIL when it lands.
* **linkedin `wired:true`** in `consumers.jsonc` (honest — master mounts the
  submodule v0.3.0, 9 modules adopted).

## Both gate halves now real against linkedin

* **`test-all-consumers.sh`** (proven, linkedin worktree @ HEAD):
  * REAL-GREEN (script present): `PASS linkedin-webctl`, 24/24 offline suites, exit 0.
  * HONEST (real master, no script): SKIP "contract pending", exit 0 — no false-fail.
  * TEETH: inject a `throw` into a consumed base module → 12 suites FAIL →
    `BLOCKED` → exit 1.
* **`verify-no-byte-drift.sh`** (the re-vendoring canary, companion guard): now that
  linkedin is wired it actually runs — **compared=14, drift=0**: linkedin's 9
  adopted modules are genuine shims, not byte-copies. (Was all-skip before the flip.)

Net: *"a base change is provable not to break any consumer"* is TRUE + demonstrated.

## The ONE residual step to live-on-master-green

linkedin must commit the ~70-line `./test-against-base.sh` (proposal:
`proposals/2026-06-23-linkedin-test-against-base-contract.md`). Pending that, the
master gate honestly reports linkedin SKIP "contract pending" (never false-fail).
Open question pinged to `webctl:mgr`: linkedin-owner merges it, OR base is
authorized to commit the additive infra file directly. Do this BEFORE linkedin
bumps to v0.4.0/v0.5.0 so the gate guards those bumps.

## Migration state (whole arc)

* base modules extracted (sm2t `createX(C)` seams): client-config, chromium-prefs,
  profile-lock, mounts (v0.4.0), chromium-docker-xpra + registry + xpra-attach +
  browser-location/index (v0.5.0), plus the 5 v0.2.0 leaves + docker-ctl.
  **`browser-location/` is fully on base.** Manager's full-`lib/` scan: nothing
  shared hides outside it.
* Releases on origin: v0.1.0 `3cbfe63` · v0.2.0 `5032279` · v0.3.0 `7634f67` ·
  v0.4.0 `72f2e9c` · v0.5.0 `2794d72`.
* Consumers adopt at their pace (test-before-bump, now under a real gate). linkedin
  at v0.3.0 (9 modules); chatgpt at ZERO base modules (mid its own parser track).
* linkedin uploads FEATURE: still queued, low-pri, no commitment.

## Parked / next (awaiting manager+Greg strategic fork)

* Selector-canary "doctor" → promote to base as a shared helper (xrl4 §drift
  mitigation) — future, design-doc-first.
* Fresh-clone CI gate mode — `FUTURE_WORK/test/260622-fresh-clone-ci-gate.md`.
* chatgpt/telegram/fetlife contracts when they wire the submodule.
* xrl4 doc is still `status: draft` — candidate to promote now that the gate is
  built + proven (coordinate via review).
