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

With all consumers `"wired": false` (current state), the gate emits four `skip`
envelopes and exits 0. To smoke-test the pass/fail mapping, point
`WEBCTL_CONSUMERS_DIR` at a scratch tree with a stub `./test-against-base.sh`
returning the code under test.
