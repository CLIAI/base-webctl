# `run-tests-strict.mjs` + `strict-reporter.mjs`

Run `node --test` so that a **vanished** test block fails the run.

```bash
node vendor/base-webctl/scripts/run-tests-strict.mjs "test/**/*.test.{js,mjs,cjs}"
```

* Spec on stdout by default; the strict verdict on stderr.
* ⛔ **In a gate contract, pass `--tap`.** The release gate reads contract output line by
  line; with spec, two adopting lanes streamed **zero TAP lines** — green locally, dark to
  the gate. (The default stays spec because a lane already parses spec's `ℹ tests N`;
  flipping it broke that lane at the v0.28.0 gate.) Prove it in your contract: FAIL if no
  TAP line streamed (`substack`'s arm).
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
  * **`--tap`** — TAP instead of spec on stdout. Required for gate visibility (above).
    (`--spec` is accepted and is the default.)
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

## ⚠ Adopting: three ways a lane goes red (correctly) on day one

* **Your file pattern matches nothing** — base's glob is base's; pass your own.
* **A placeholder file of only `todo`/`skip` tests, run alone** fails as "ZERO tests
  ran". One real passing test anywhere in the run is enough; a run of only placeholders
  tested nothing.
* **Direct-script suites** need `--allow-plain-scripts` (see above).

To keep your own runner, add the reporter beside your human one:

```bash
node --test --test-reporter=spec --test-reporter-destination=stdout \
            --test-reporter=vendor/base-webctl/scripts/strict-reporter.mjs \
            --test-reporter-destination=stderr
```

What it cannot see: a `"test"` script that never runs node (`echo ... && exit 0`).
See `.DEV_NOTES.md`, and k3wn *"Green with fewer tests than last time"*.
