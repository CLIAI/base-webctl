# `run-tests-strict.mjs` + `strict-reporter.mjs`

Run `node --test` so that a **vanished** test block fails the run.

```bash
node vendor/base-webctl/scripts/run-tests-strict.mjs "test/**/*.test.{js,mjs,cjs}"
```

* Human output (spec) on stdout; the strict verdict on stderr.
* Fails on any `test:fail` event (TODO/SKIP excepted), **including a suite whose
  `describe()` threw while registering** — which plain node reports as `# fail 0`,
  exit 0.
* Fails a test file that registered **zero** tests (node counts it as one pass).
* Strips `NODE_TEST_CONTEXT` from the child, so it behaves the same when started from
  inside another node:test process.
* ⚠ **Pass YOUR lane's own file pattern.** Base's is `"test/**/*.test.{js,mjs,cjs}"`;
  a lane naming files `*-test.js` matches nothing with it. A pattern that matches nothing
  **fails** here ("ZERO tests ran … the file pattern matched NOTHING"), where plain node
  exits 0.
* Arguments pass through to `node --test`, except three of its own:
  * **`--tap`** — TAP instead of spec on stdout. The release gate scans contract output
    for TAP `not ok` **and** for spec's `✖ failing tests:`, so spec does not hide a
    failure from it; use `--tap` if your contract streams TAP and you want to keep that.
  * **`--serial`** = `--test-concurrency=1`, and it wins over an earlier concurrency
    flag. node runs test **files** concurrently by default; suites that spawn processes,
    bind listeners or take lock dirs can collide.
  * **`--allow-plain-scripts`** — for **direct-script suites** (plain asserts, no
    node:test). node reports each such file as ONE file-level test; by default this
    runner fails it as EMPTY, because it looks exactly like a file that registered
    nothing. The flag accepts it. ⚠ It gives up the empty-file guard for the whole run,
    so run direct scripts separately from node:test suites. A script that exits
    non-zero, and a vanished `describe()`, still fail. Only the flag enables it; an
    inherited `WEBCTL_STRICT_ALLOW_PLAIN_SCRIPTS` is ignored.

To keep your own runner, add the reporter beside your human one:

```bash
node --test --test-reporter=spec --test-reporter-destination=stdout \
            --test-reporter=vendor/base-webctl/scripts/strict-reporter.mjs \
            --test-reporter-destination=stderr
```

What it cannot see: a `"test"` script that never runs node (`echo ... && exit 0`).
See `.DEV_NOTES.md`, and k3wn *"Green with fewer tests than last time"*.
