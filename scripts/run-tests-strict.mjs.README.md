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
* Arguments pass through to `node --test`.

To keep your own runner, add the reporter beside your human one:

```bash
node --test --test-reporter=spec --test-reporter-destination=stdout \
            --test-reporter=vendor/base-webctl/scripts/strict-reporter.mjs \
            --test-reporter-destination=stderr
```

What it cannot see: a `"test"` script that never runs node (`echo ... && exit 0`).
See `.DEV_NOTES.md`, and k3wn *"Green with fewer tests than last time"*.
