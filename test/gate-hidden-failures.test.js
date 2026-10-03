// gate-hidden-failures.test.js — the release gate FAILS a contract that exits 0
// while its output reports failures.
//
// node:test lets a describe() that throws while registering vanish: `not ok N -
// <suite>`, then "# fail 0", exit 0. The gate cannot make a contract use base's
// strict reporter, but it reads every contract's output. Runs against FAKE
// consumers through WEBCTL_CONSUMERS_FILE — never the fleet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'scripts', 'test-all-consumers.sh');

/**
 * One fake consumer whose contract prints `output` and exits `code`.
 * @param {string} output @param {number} code @param {string} [logDir] keep logs here (outlives the fixture)
 */
function runGate(output, code, logDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-hidden-'));
  try {
    const repo = path.join(dir, 'fake-webctl');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'out.txt'), output);
    fs.writeFileSync(path.join(repo, 'test-against-base.sh'),
      `#!/usr/bin/env bash\ncat out.txt\nexit ${code}\n`, { mode: 0o755 });
    const g = (/** @type {string[]} */ a, cwd = repo) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    // a mounted base: a nested repo committed as a gitlink, as a real consumer has it
    const sub = path.join(repo, 'vendor', 'base-webctl');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'README.md'), 'fake base\n');
    g(['init', '-q'], sub); g(['add', '.'], sub);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], sub);
    g(['init', '-q']); g(['add', '.']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fake']);
    const reg = path.join(dir, 'consumers.jsonc');
    fs.writeFileSync(reg, JSON.stringify({ consumers: [{
      name: 'fake-webctl', submodulePath: 'vendor/base-webctl', testCmd: './test-against-base.sh',
      tier: 'full', wired: true, localDir: repo,
    }] }));
    const env = { ...process.env, WEBCTL_CONSUMERS_FILE: reg, WEBCTL_CONSUMERS_DIR: dir,
      WEBCTL_GATE_LOG_DIR: logDir ?? path.join(dir, 'gate-logs') };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync('bash', [GATE], { encoding: 'utf8', env });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const VANISHED_TAP = 'not ok 1 - needs a fixture\nok 2 - survivor\n# tests 1\n# pass 1\n# fail 0\n';

test('CONTROL: a clean exit-0 contract PASSES — the fixture reaches the verdict at all', () => {
  const r = runGate('ok 1 - a\n# tests 1\n# pass 1\n# fail 0\n', 0);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS {2}fake-webctl/);
});

test('⛔ exit 0 with a TAP `not ok` line is a FAIL, naming the line', () => {
  const r = runGate(VANISHED_TAP, 0);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL {2}fake-webctl/);
  assert.match(r.out, /REPORTED FAILURES/);
  assert.match(r.out, /not ok 1 - needs a fixture/);
});

test('⛔ exit 0 with the spec reporter\'s "✖ failing tests:" is a FAIL too', () => {
  const r = runGate('✔ survivor\n✖ needs a fixture\n\n✖ failing tests:\n\n✖ needs a fixture\n', 0);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /spec: 1 failing-tests entries, 0 todo/);
});

test('TODO and SKIP `not ok` lines are not failures', () => {
  const r = runGate('not ok 1 - later # TODO\nnot ok 2 - off # SKIP\nok 3 - a\n', 0);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS {2}fake-webctl/, 'must reach a verdict — a SKIP would pass this vacuously');
});

test('a spec run whose ONLY failures are TODOs PASSES — the header alone is not a failure (ccew false red)', () => {
  const r = runGate('✔ real\n✖ injection probe # TODO\nℹ fail 0\nℹ todo 1\n\n✖ failing tests:\n\ntest at x.js:3:1\n✖ injection probe (0.2ms) # TODO\n  Error: known\n', 0);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS {2}fake-webctl/);
  // control: a real entry beside the TODO still fails
  const bad = runGate('ℹ fail 0\nℹ todo 1\n\n✖ failing tests:\n\n✖ injection probe (0.2ms) # TODO\n✖ vanished suite (0.1ms)\n', 0);
  assert.equal(bad.status, 1, bad.out);
});

test('⛔ a TODO with a REASON loses its "# TODO" in spec — counts decide, so it still PASSES (ccew, 2nd false red)', () => {
  // Measured: spec prints "✖ probe # BLOCKED ON PROBE 0" — the reason REPLACES the keyword.
  const r = runGate('✔ real\nℹ fail 0\nℹ todo 1\n\n✖ failing tests:\n\n✖ probe (0.3ms) # BLOCKED ON PROBE 0\n', 0);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS {2}fake-webctl/);
});

test('the strict reporter\'s verdict is authoritative: 0 failures PASSES; a failure verdict at exit 0 FAILS', () => {
  // even with a spec header and no todo count, the event-based verdict wins
  const ok = runGate('✖ failing tests:\n\n✖ probe # BLOCKED\nSTRICT: 0 failure events\n', 0);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /PASS {2}fake-webctl/);
  // a contract that swallowed the strict reporter's failure
  const swallowed = runGate('ok 1 - a\nSTRICT: 2 failure event(s) — the run FAILS even if the summary says "# fail 0":\n', 0);
  assert.equal(swallowed.status, 1, swallowed.out);
  assert.match(swallowed.out, /strict reporter/);
  const zero = runGate('STRICT: ZERO tests ran — a run that tested nothing is not a pass.\n', 0);
  assert.equal(zero.status, 1, zero.out);
});

test('every run KEEPS its logs in its own directory — a second run never overwrites the first', () => {
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-logs-'));
  try {
    const a = runGate('ok 1 - FIRST-RUN-MARKER\n# tests 1\n# pass 1\n# fail 0\n', 0, logs);
    const b = runGate('ok 1 - SECOND-RUN-MARKER\n# tests 1\n# pass 1\n# fail 0\n', 0, logs);
    assert.equal(a.status, 0, a.out); assert.equal(b.status, 0, b.out);
    const runs = fs.readdirSync(logs).sort();
    assert.equal(runs.length, 2, `two runs, two directories: ${runs.join(', ')}`);
    /** @param {string} run */
    const consumerLog = (run) => {
      const f = fs.readdirSync(path.join(logs, run)).filter((n) => /^fake-webctl\..*\.log$/.test(n));
      assert.equal(f.length, 1, `one consumer log in ${run}: ${f.join(', ')}`);
      return fs.readFileSync(path.join(logs, run, f[0]), 'utf8');
    };
    const texts = runs.map(consumerLog);
    // each run's evidence survives, and is that run's own
    assert.equal(texts.filter((t) => t.includes('FIRST-RUN-MARKER')).length, 1);
    assert.equal(texts.filter((t) => t.includes('SECOND-RUN-MARKER')).length, 1);
    for (const run of runs) {
      assert.equal(fs.statSync(path.join(logs, run)).mode & 0o777, 0o700, `${run} is private`);
      assert.match(fs.readFileSync(path.join(logs, run, 'gate.err'), 'utf8'), /gate summary: pass=1/);
      assert.match(fs.readFileSync(path.join(logs, run, 'gate.jsonl'), 'utf8'), /"result":"pass"/);
    }
    // the human report names where they are
    assert.match(a.out, /logs kept: /);
  } finally { fs.rmSync(logs, { recursive: true, force: true }); }
});
