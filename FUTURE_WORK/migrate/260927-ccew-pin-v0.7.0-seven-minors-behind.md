# ccew-webctl is pinned at v0.7.0 — 7 minors / 11 tags / 71 commits behind

**Status:** open, scheduled by `webctl:mgr`, deliberately NOT ahead of ccew's own
safety item (a real halt for HoloTab tasks in flight). Written down at mgr's
request so the gap is not only in their head.

## What

`claude-chrome-extension-webctl` (ccew) mounts base at gitlink `b2620e9`, which
`git describe --tags --exact-match` names **v0.7.0**. base is at **v0.14.0**.
Measured 2026-09-27:

* 11 tags since v0.7.0 (v0.8.0 … v0.14.0)
* **7 of them minor releases**
* 71 commits

⚠ My first report of this said "six releases behind" — eyeballed from the version
numbers rather than counted. `webctl:mgr` corrected it. The corrected figure is
the one above; the v0.14.0 tag's own CHANGELOG copy still carries the wrong one,
because a published tag does not get moved.

## Why it was invisible until now

`consumers.jsonc` carried ccew as `wired:false` while its submodule was mounted
and **ten-plus non-vendor files imported base**. Every gate run counted a
genuinely wired consumer as a skip, and the summary still said OK. The gate's own
stale-entry detector is what caught it — the registry was the thing that was
wrong, not the consumer. Flipped to `wired:true` in v0.14.0.

⇒ The general shape, for the k3wn corpus: **a registry that under-reports is
indistinguishable from a consumer that is not there.** The skip counter made both
read the same.

## What the bump needs

* ccew has no xrl4 contract (`./test-against-base.sh`), so the gate reports SKIP
  "contract pending" rather than FAIL. It does have its own
  `test/pin-by-tag.test.js`, so it is closer than most.
* When that contract is written it should **call** `scripts/contract-harness.mjs`
  rather than copy checks — v0.14.0 exists for this. The harness owns the exit
  code, and its `pin` check reads the committed gitlink, not the worktree.
* ⚠ A bump across 71 commits crosses the `portOrigin` / `PORT_ORIGINS` work and
  the `CONTAINER_LIFECYCLE_CONTRACT` additions. Read the v0.8.0 → v0.14.0
  CHANGELOG entries' "what this headline does NOT cover" sections, not just the
  headlines — that discipline exists because three releases running shipped a
  true headline that read as complete.

## Sequencing

`webctl:mgr` owns this and will open it with ccew **after** ccew's halt work
lands. Do not start it from this side.
