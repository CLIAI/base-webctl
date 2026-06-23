# `test-all-consumers.sh` — dev notes

## Design choices

* **Local-clone gate, not fresh-clone CI.** The pilot runs consumers from
  working copies under `$WEBCTL_CONSUMERS_DIR`. A fresh-clone-per-consumer CI
  mode (clone repo, `git submodule update`, check out the candidate base commit
  into `submodulePath`, run) is the eventual shape but is **FUTURE_WORK** — it
  needs SSH deploy keys and a runner. Logged under
  `FUTURE_WORK/test/260622-fresh-clone-ci-gate.md`.
* **`wired` flag drives graceful no-op.** Migration is one-small-refactoring-at-
  a-time (sb7q). Until a consumer's master actually mounts the submodule, its
  registry entry has `"wired": false` and the gate reports `skip`. This lets the
  gate exist and stay green from day one, before any consumer is migrated.
* **Two-stage adoption: `wired` ≠ contract-present.** `wired:true` means only that
  the consumer's master mounts the submodule (linkedin: v0.3.0, 9 modules). A wired
  consumer may not yet have adopted the `./test-against-base.sh` contract script. A
  missing contract is reported as SKIP **"contract pending"**, NOT a FAIL — else a
  truthful `wired:true` would false-RED the gate with exit 127. The gate extracts
  the script path from `testCmd`'s first token and `-x`-checks it in the working
  copy; the instant the consumer commits the contract, the entry auto-flips to a
  real PASS/FAIL. (linkedin is in exactly this state as of 2026-06-23 — wired, with
  the contract delivered as an adoption proposal, proven real-GREEN in a worktree.)
* **JSONC parsing is delegated** to `read-consumers.mjs` (string-aware comment
  stripping) rather than `grep`/`sed`, so values containing `//` or `:` are
  never corrupted. Node is the runtime base already requires — zero extra dep.
* **`eval "$testCmd"`** is used because the contract string carries args
  (`./test-against-base.sh --offline`). The registry is repo-controlled and
  trusted; do not feed untrusted input here.

## Why exit 2 = skip, not fail

A consumer hitting a login wall / captcha / quota (`k7m2`, `dip7`) is *blocked
needing a human*, not broken by base. Counting it as fail would wedge every base
release behind a human gate. `xrl4` is explicit: exit 2 → SKIP.

## Headless guarantee

The gate never drives a real gated site. `--offline` (the default contract mode)
MUST be fully no-human: unit suites + mocked browser-location/docker-mode. The
real-browser `--stack` mode is opt-in per consumer (`dockerOptIn`) and gated
behind `{TOOL}_DOCKER_TESTS=1`; it is not invoked by this loop's default path.

## Testing the gate itself

Point `WEBCTL_CONSUMERS_DIR` at a scratch tree (e.g. a `git worktree` of the
consumer) carrying `./test-against-base.sh`. Proven 2026-06-23 against a linkedin
worktree (submodule v0.3.0):

* **PASS** — script present, 24/24 offline suites green → `PASS linkedin-webctl`,
  exit 0.
* **SKIP (contract pending)** — against the real master (no script) → exit 0, no
  false-fail.
* **FAIL (teeth)** — inject a `throw` into a base module the consumer imports
  (e.g. `vendor/base-webctl/lib/client-config.js`) → 12 suites FAIL →
  `BLOCKED: linkedin-webctl failed` → exit 1. This is the proof the gate is real:
  *base changes → one programmatic test catches a broken consumer.*
