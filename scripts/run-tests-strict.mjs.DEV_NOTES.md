# `run-tests-strict.mjs` — dev notes

## Why events, not text

The first idea was to scan TAP for `not ok`. node's reporter API already emits a
`test:fail` event for the suite whose `describe()` threw; the summary simply does not
count suites. Reading the event needs no parsing and cannot be fooled by a test that
prints TAP-looking text. (The release gate *does* scan text, because it cannot choose a
contract's reporter.)

## The empty-file trap, found while building it

A file that registers no tests produces ONE `test:pass` whose `name` is the file's own
path (`ℹ tests 1, pass 1`). The first zero-test guard counted it and passed an empty
file. Recognised now by `nesting === 0` and `name` equal to the file path.

## Measured against base's own suite

Switching `npm test` to this runner failed immediately: node's default discovery
(every `.js`/`.mjs` under `test/`) ran `test/helpers/{mutex-worker,cdp-leak-probe,
tla-violation.fixture}.mjs` as test files. One, given no arguments, acquired a lock in
the real `~/.cache/CLIAI/demo-webctl/locks`. Fixed by passing an explicit
`*.test.*` glob; the stray directory was removed.

## Tests

`test/strict-reporter.test.js` generates the hole LIVE and asserts its premise (plain
node exits 0); if a future Node fixes it, that test says so. Sabotage: removing the
`NODE_TEST_CONTEXT` strip fails the nested-runner test. The gate's scan is tested in
`test/gate-hidden-failures.test.js` against fake consumers; disabling the scan fails
both FAIL arms.

## `--serial`'s first test proved nothing on THIS box

`os.availableParallelism()` is **1** here, so node's default file concurrency never
overlaps. The first draft skipped the parallel control below 3 slots and its serial arm
passed — order made no difference, so the pass carried no information. Now the control
forces `--test-concurrency=2` (and must collide), and the serial arm runs
`--test-concurrency=2 --serial` (and must not). Sabotaging the `--serial` mapping turns it
red. *The constrained environment is where a test's assumption shows.*

## `--allow-plain-scripts` (from `linkedin`'s 34-file census)

A direct-script suite and an empty file are the same event: zero registered tests, exit
0. Only the caller's intent separates them, so it is a flag, never a heuristic.
