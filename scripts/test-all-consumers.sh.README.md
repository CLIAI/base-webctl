# `test-all-consumers.sh` — the cross-repo release gate

The release gate from `docs/design/test-cross-repo-consumer-loop-xrl4.md`. For
the current base checkout it loops every consumer in `consumers.jsonc`, runs
that consumer's `./test-against-base.sh` contract **headlessly**, and refuses
the release if **any** consumer reports FAIL.

## Usage

```bash
./scripts/test-all-consumers.sh
```

Environment:

* `WEBCTL_CONSUMERS_DIR` — directory holding local consumer clones
  (default `$HOME/github/CLIAI`). Each consumer is expected at
  `$WEBCTL_CONSUMERS_DIR/<name>`.

## What it does

1. Reads `consumers.jsonc` (via `scripts/read-consumers.mjs`).
2. For each consumer, in order:
   * **not `wired`** → `skip` (migration is incremental; a consumer that has
     not yet mounted the submodule is not a failure).
   * repo or submodule path absent in the working copy → `skip`.
   * otherwise → run its `testCmd` in the consumer dir and map its exit code.
3. Emits one JSONL envelope per consumer
   (`{type,ts,consumer,suite,result}`, per `lszd`) on stdout, a human summary
   on stderr.

## Exit-code contract (from the consumer, per `xrl4`)

| Consumer exit | Gate result | Blocks release? |
|---------------|-------------|-----------------|
| `0`           | pass        | no              |
| `1`           | fail        | **yes**         |
| `2`           | skip (needs human) | no       |

The gate itself exits **1** iff at least one consumer FAILed; skips never block.

## Pairs with

* `verify-no-byte-drift.sh` — catches regression to byte-duplication.
* `consumers.jsonc` — the registry it loops over.
