# `test-all-consumers.sh` — the cross-repo release gate

The release gate from `docs/design/test-cross-repo-consumer-loop-xrl4.md`. For
the current base checkout it loops every consumer in `consumers.jsonc`, runs
that consumer's `./test-against-base.sh` contract **headlessly**, and refuses
the release if **any** consumer reports FAIL.

## Usage

```bash
./scripts/test-all-consumers.sh                            # each consumer vs ITS OWN pin
./scripts/test-all-consumers.sh --against-head --scratch   # ⭐ pre-release arm (recommended)
./scripts/test-all-consumers.sh --against-head             # pre-release arm, IN PLACE (legacy)
```

### Which pre-release arm

* **`--against-head --scratch` — recommended.** For each wired consumer the gate
  clones the live repo at its **committed HEAD** into a throwaway dir under
  `$TMPDIR`, clones base at `BASE_HEAD` into the submodule path there (a real
  repo, never a symlink), and runs `testCmd` in the clone with a throwaway
  `HOME`, `WEBCTL_BASE_DIR=<clone>/<submodulePath>`, `WEBCTL_DECLARED_PIN=<the
  committed gitlink>` and `WEBCTL_GATE_SWAPPED=1` (0 when the gitlink already is
  base HEAD). The gate-probe runs in the clone too. The scratch dir is removed on
  every path, including a signal.
  * ⛔ **Network-isolated.** `testCmd` runs under the harness's `isolated` verb
    (private user+network namespace, only its own `lo`). If isolation is
    unavailable on the gate host the consumer is **NOT run** and the gate reports
    a **GATE-ENVIRONMENT** fault (`{"type":"error","code":"EGATEENV"}` on stdout)
    — not a lane FAIL or SKIP, and never a fallback to the host network. It still
    blocks: an unrun lane is an unvalidated lane.
  * ⛔ **The live tree is never written — and the gate checks.** Before and after
    each scratch run it fingerprints the live tree (HEAD, submodule HEAD, both
    indexes, full `git status --porcelain`); any difference prints `⛔ LIVE TREE
    CHANGED`, emits `{"type":"error","code":"ELIVETREE"}` and blocks. Reads use
    `GIT_OPTIONAL_LOCKS=0`, because a plain `git status` rewrites `.git/index`.
  * Uncommitted **tracked** changes → SKIP: *"live tree has N uncommitted tracked
    change(s) — the committed HEAD would be tested, not what runs; commit or
    stash first"*. Untracked files do not count (they are in neither).
  * A dirty live submodule pointer is FAIL, exactly as in place. A submodule path
    committed as a plain directory (not a gitlink) is FAIL UNDECLARED.
  * A contract that needs files present only in the live tree (gitignored
    fixtures, uninitialised nested submodules, LFS) now FAILs — correctly: the
    fresh-clone state is broken. The reason quotes the consumer's own words.
  * Limits: the namespace isolates the NETWORK, not the filesystem — unix sockets
    on disk (a docker socket, X11) stay reachable, and an absolute-path write
    still lands (the fingerprint catches it in the live tree). The contract runs
    as mapped root (uid 0 inside the namespace).
* **`--against-head` (in place)** checks base's candidate out INSIDE each live
  tree for the length of the contract, then restores it. Unchanged, still
  supported — but some live trees are what **unattended timers** run from, so a
  timer firing in the gate window runs an untested candidate. It also SKIPs any
  consumer whose tree is dirty, which forces repeat runs on a busy fleet.

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
