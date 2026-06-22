# FUTURE_WORK — fresh-clone CI mode for the release gate

* **Category:** test
* **Created:** 2026-06-22
* **Concerns:** `scripts/test-all-consumers.sh` (xrl4 §"The gate").

## What is deferred

`test-all-consumers.sh` currently runs consumers from **local working copies**
under `$WEBCTL_CONSUMERS_DIR`. The eventual CI shape is **fresh-clone per
consumer**: for a candidate base commit, clone each consumer's repo, check that
base commit into `submodulePath`, run `./test-against-base.sh --offline`, and
aggregate — fully hermetic, no dependence on a developer's checkout.

## Why it does not block

The local-clone gate already enforces the contract (loop, headless run, JSONL
envelopes, FAIL-blocks / SKIP-doesn't). The pilot has **zero** wired consumers,
so the gate correctly SKIPs all four today; fresh-clone mode changes *where the
working copy comes from*, not the pass/fail logic.

## What unblocks it

* A CI runner with SSH **deploy keys** for the CLIAI consumer repos.
* A decision on candidate-commit injection: `git -C <clone>/<submodulePath>
  fetch <base-candidate> && checkout` vs. submodule-update to a branch.
* The per-consumer `./test-against-base.sh` entrypoints actually existing
  (today none do; they are each consumer's small follow-on per xrl4).

## Note

When implemented, keep the `wired` flag semantics: an unwired or absent consumer
is SKIP, never FAIL. Only a real exit-1 from a wired consumer blocks a base
release.
