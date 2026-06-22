# `verify-no-byte-drift.sh` — the re-vendoring canary

Guards the core promise of `sb7q`: once shared code lives in base and is consumed
via the submodule, no consumer may keep a **byte-identical copy** of a base file
in its own `lib/`. Such a copy is a silent regression to byte-duplication — a
base fix would never reach it.

## Usage

```bash
./scripts/verify-no-byte-drift.sh
```

Environment:

* `WEBCTL_CONSUMERS_DIR` — directory holding local consumer clones
  (default `$HOME/github/CLIAI`).

## What it does

For every base file under `lib/**/*.js`, and every **wired** consumer, it
compares (`cmp -s`) the base file against the consumer's same-path file. A
byte-identical match is **DRIFT** and fails the check. A consumer that has
adopted the module correctly has a *thin re-export shim* there instead (which is
not byte-identical to the base source), so it passes.

## Exit

* `0` — no drift (or nothing wired yet).
* `1` — at least one byte-identical re-vendored file found.

## Pairs with

* `test-all-consumers.sh` — the behavioural release gate.
* `consumers.jsonc` — supplies the consumer list and `wired` flags.
