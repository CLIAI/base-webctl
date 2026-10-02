// strict-reporter.mjs — a node:test reporter that fails the run on ANY failure
// event, including a describe() that threw while REGISTERING its tests.
//
// ⛔ THE DEFECT (node v22.23.2, reproduced by base, found by `chatgpt`):
//
//     describe('t', () => { fs.readFileSync('/missing'); it('x', () => {}); });
//
// prints `not ok 1 - t`, then `# tests 0`, `# fail 0`, and EXITS 0. The block's
// tests never registered, so they are not counted as failed — they VANISH. A
// fixture absent on a fresh clone (kept out of git by a local .gitignore) makes
// a whole block disappear from a green run. Zero-test guards do not catch it:
// the tests that DID register still count.
//
// ⇒ This reads node's own `test:fail` events — the suite-level failure IS one —
// rather than the summary counts or the exit code. TODO and SKIP are excepted.
//
// Use it ALONGSIDE a human reporter (each reporter needs its own destination):
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//               --test-reporter=<base>/scripts/strict-reporter.mjs \
//               --test-reporter-destination=stderr
//
// or simply run <base>/scripts/run-tests-strict.mjs, which does exactly that.

/**
 * @param {AsyncIterable<{type: string, data: any}>} source
 * @returns {AsyncGenerator<string>}
 */
export default async function* strictReporter(source) {
  /** @type {string[]} */
  const failed = [];
  let passed = 0;
  /** @type {string[]} */
  const empty = [];
  for await (const ev of source) {
    if (ev.type === 'test:pass' && !(ev.data && (ev.data.todo || ev.data.skip))) {
      // ⚠ A file that registered NO tests is reported by node as ONE passing "test" named
      // after the file — measured: `ℹ tests 1, pass 1` for an empty file. Counted, it
      // would hide the empty run it is. Recognised by its name being the file's own path.
      const d = ev.data || {};
      if (d.nesting === 0 && d.file && (d.file === d.name || d.file.endsWith(`/${d.name}`)
          || d.file.endsWith(`\\${d.name}`))) { empty.push(d.file); continue; }
      passed++;
    }
    if (ev.type !== 'test:fail') continue;
    const d = ev.data || {};
    if (d.todo || d.skip) continue;
    const kind = (d.details && d.details.type) || 'test';
    failed.push(`${kind} '${d.name}'${d.file ? ` (${d.file})` : ''}`);
  }
  if (failed.length) {
    yield `STRICT: ${failed.length} failure event(s) — the run FAILS even if the summary says "# fail 0":\n`;
    for (const f of failed) yield `  ✖ ${f}\n`;
    yield '  A failing SUITE usually means a describe() threw while registering: its tests vanished.\n';
    process.exitCode = 1;
  } else if (empty.length) {
    yield `STRICT: ${empty.length} test file(s) registered ZERO tests — node counts each as a pass:\n`;
    for (const f of empty) yield `  ∅ ${f}\n`;
    process.exitCode = 1;
  } else if (passed === 0) {
    // A run in which nothing passed and nothing failed tested nothing. (Not the only
    // vacuous green: a `"test": "echo No tests yet && exit 0"` never reaches node at all —
    // measured in a lane over a 114-test suite. Only the test SCRIPT can be checked for that.)
    yield 'STRICT: ZERO tests ran — a run that tested nothing is not a pass\n';
    process.exitCode = 1;
  } else {
    yield 'STRICT: 0 failure events\n';
  }
}
