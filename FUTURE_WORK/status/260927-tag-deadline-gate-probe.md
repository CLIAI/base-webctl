# gate-probe is on master and UNTAGGED — tag by ~2026-10-04 if no lib/ change lands

**Ruled by `webctl:mgr` 2026-09-27.** Recorded here because a deadline held only in
a tmux pane is a deadline nobody inherits.

## The ruling

`gate-probe` (master `abe8503`) gets **no v0.15.0 of its own**. It rides with the
next `lib/` change. Reasoning: the probe runs from the **gate's** base HEAD, never
from a consumer's pin, so **no consumer gains anything from a tag for it**.

⚠ **BUT:** if nothing in `lib/` lands within about a week — i.e. by roughly
**2026-10-04** — tag it anyway, so master does not drift far from the newest tag.

## Why the drift matters

A large gap between master and the newest tag makes every consumer's "am I
behind?" question harder to answer, and `scripts/tags-since-pin.sh` less
informative. It also means the next release bundles unrelated changes, which is
what forces a CHANGELOG headline to be broad — and a broad headline is the shape
that has three times read as complete while omitting the part that mattered.

## State at the time of the ruling

* master `abe8503`; newest tag `v0.14.0` (commit `d3de614`).
* 314 tests, 0 fail; `tsc` clean; gate `--against-head` green with
  `harness gate-probe: ok=4 defect=0 no-verdict=0`.
* Nothing in `lib/` has changed since `v0.14.0`.
* `HARNESS_GENERATION` stays **1** — additive verb, no stale copies created.
  `perplexity` and `ccew` are both writing contracts against generation 1.
