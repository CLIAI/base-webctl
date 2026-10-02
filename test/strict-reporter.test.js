// strict-reporter.test.js — a describe() that throws while registering must FAIL
// the run, not vanish from a green one.
//
// ⭐ The hole is generated LIVE from the installed Node, and its PREMISE is asserted
// ("plain node --test exits 0 and says # fail 0"). If a future Node fixes the hole,
// the premise assertion fails and says so, instead of this test silently proving
// nothing. (Shape from `substack`.)
//
// ⚠ Every spawn deletes NODE_TEST_CONTEXT. This file runs INSIDE node:test, and a
// child `node --test` inheriting it emits the parent protocol rather than TAP, with
// different exit semantics — so both arms would fail for that reason alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests-strict.mjs');

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

/** @param {string} name @param {string} body */
function fixture(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return { dir, file };
}
const VANISH = `const { describe, it } = require('node:test');
const fs = require('node:fs');
describe('needs a fixture', () => { fs.readFileSync('/nonexistent-fixture-for-strict-test'); it('x', () => {}); });
it('survivor', () => {});
`;
const CLEAN = `const { it } = require('node:test');
it('a', () => {});
it.todo('later', () => { throw new Error('todo failures do not count'); });
it.skip('skipped', () => { throw new Error('nor skips'); });
`;

test('PREMISE: plain node --test lets a throwing describe() VANISH — exit 0, "# fail 0"', () => {
  const fx = fixture('v.test.cjs', VANISH);
  try {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fx.file], { encoding: 'utf8', env });
    assert.match(r.stdout, /^not ok \d+ - needs a fixture/m, 'node does report the suite as not ok…');
    assert.match(r.stdout, /^# fail 0$/m, '…while its summary counts zero failures');
    assert.equal(r.status, 0,
      'PREMISE CHANGED: this Node now exits non-zero for a throwing describe(). The hole may be '
      + 'fixed upstream; re-check whether strict-reporter is still needed. This is NOT a base defect.');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⛔ run-tests-strict FAILS the same fixture, naming the vanished suite', () => {
  const fx = fixture('v.test.cjs', VANISH);
  try {
    const r = spawnSync(process.execPath, [RUNNER, fx.file], { encoding: 'utf8', env });
    assert.equal(r.status, 1, `must fail; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /STRICT: 1 failure event/);
    assert.match(r.stderr, /suite 'needs a fixture'/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('CONTROL: a clean file passes — and failing TODO / SKIP tests do not count', () => {
  const fx = fixture('ok.test.cjs', CLEAN);
  try {
    const r = spawnSync(process.execPath, [RUNNER, fx.file], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `clean must pass; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /STRICT: 0 failure events/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the runner strips NODE_TEST_CONTEXT from its child (the nested-runner trap)', () => {
  const fx = fixture('v.test.cjs', VANISH);
  try {
    // Pass the variable deliberately: the runner must remove it, or the child would speak
    // the parent protocol and the strict reporter would not decide the outcome.
    const r = spawnSync(process.execPath, [RUNNER, fx.file],
      { encoding: 'utf8', env: { ...env, NODE_TEST_CONTEXT: 'child-v8' } });
    assert.equal(r.status, 1, `must still fail with the variable set; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /STRICT: 1 failure event/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⛔ a test file that registers ZERO tests fails — node itself counts it as "tests 1, pass 1"', () => {
  const fx = fixture('empty.test.cjs', "require('node:test');\n");
  try {
    const plain = spawnSync(process.execPath, ['--test', fx.file], { encoding: 'utf8', env });
    assert.equal(plain.status, 0, 'premise: plain node passes an empty file');
    const r = spawnSync(process.execPath, [RUNNER, fx.file], { encoding: 'utf8', env });
    assert.equal(r.status, 1, `an empty file must fail; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /registered ZERO tests/);
    assert.match(r.stderr, /empty\.test\.cjs/);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

// ── linkedin's compat points: direct-script suites, and files that must not overlap ──

const PLAIN_SCRIPT = "const assert = require('node:assert'); assert.equal(1 + 1, 2);\n";

test('--allow-plain-scripts: a direct-script suite (no node:test) passes — control: without it, EMPTY fails', () => {
  const fx = fixture('plain.test.cjs', PLAIN_SCRIPT);
  try {
    const strict = spawnSync(process.execPath, [RUNNER, fx.file], { encoding: 'utf8', env });
    assert.equal(strict.status, 1, 'control: by default a zero-test file fails as EMPTY');
    assert.match(strict.stderr, /--allow-plain-scripts/, 'and the refusal names the way out');
    const allowed = spawnSync(process.execPath, [RUNNER, '--allow-plain-scripts', fx.file], { encoding: 'utf8', env });
    assert.equal(allowed.status, 0, `allowed must pass; got ${allowed.status}\n${allowed.stderr}`);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('--allow-plain-scripts still FAILS a script that exits non-zero, and a vanished describe()', () => {
  const bad = fixture('bad.test.cjs', "process.exit(3);\n");
  const van = fixture('v.test.cjs', VANISH);
  try {
    assert.equal(spawnSync(process.execPath, [RUNNER, '--allow-plain-scripts', bad.file], { encoding: 'utf8', env }).status, 1);
    assert.equal(spawnSync(process.execPath, [RUNNER, '--allow-plain-scripts', van.file], { encoding: 'utf8', env }).status, 1);
  } finally {
    fs.rmSync(bad.dir, { recursive: true, force: true }); fs.rmSync(van.dir, { recursive: true, force: true });
  }
});

test('⛔ an INHERITED WEBCTL_STRICT_ALLOW_PLAIN_SCRIPTS does not switch the empty-file guard off', () => {
  const fx = fixture('empty.test.cjs', "require('node:test');\n");
  try {
    const r = spawnSync(process.execPath, [RUNNER, fx.file],
      { encoding: 'utf8', env: { ...env, WEBCTL_STRICT_ALLOW_PLAIN_SCRIPTS: '1' } });
    assert.equal(r.status, 1, 'only the flag may enable it');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('--serial: two files contending for ONE lock pass serially — control: they collide in parallel', () => {
  // Each file takes a lock dir, announces itself, waits, and fails if the OTHER announced
  // meanwhile — the shape of a suite that spawns processes or takes a real lock.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-serial-'));
  const body = (/** @type {string} */ me, /** @type {string} */ other) => `const { test } = require('node:test');
const fs = require('node:fs'); const path = require('node:path');
const D = ${JSON.stringify(dir)};
test('${me} holds the lock alone', async () => {
  fs.mkdirSync(path.join(D, 'lock'));                  // throws EEXIST if the other holds it
  fs.writeFileSync(path.join(D, '${me}'), '');
  await new Promise((r) => setTimeout(r, 700));
  const overlap = fs.existsSync(path.join(D, '${other}'));
  fs.rmSync(path.join(D, '${me}')); fs.rmdirSync(path.join(D, 'lock'));
  if (overlap) throw new Error('the other file ran at the same time');
});
`;
  try {
    const a = path.join(dir, 'a.test.cjs'); const b = path.join(dir, 'b.test.cjs');
    fs.writeFileSync(a, body('A', 'B')); fs.writeFileSync(b, body('B', 'A'));
    // `--serial` AFTER an explicit concurrency of 2: it must win, or on a one-core box the
    // serial arm would pass merely because the default was already serial.
    const serial = spawnSync(process.execPath, [RUNNER, '--test-concurrency=2', '--serial', a, b], { encoding: 'utf8', env });
    assert.equal(serial.status, 0, `serial must pass; got ${serial.status}\n${serial.stderr}`);
    // ⚠ The control FORCES concurrency. node's default is availableParallelism() - 1, and on
    // a box reporting 1 the default never overlaps — the first draft returned early there,
    // so its serial arm passed without any evidence that order mattered.
    const parallel = spawnSync(process.execPath, [RUNNER, '--test-concurrency=2', a, b], { encoding: 'utf8', env });
    assert.equal(parallel.status, 1,
      'control: run concurrently, the same two files must collide — else this test cannot tell serial from lucky');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── gemini's compat points: a pattern that matches nothing; the gate's view ──────

test('⛔ a file pattern that matches NOTHING fails, naming the pattern — control: a match runs', () => {
  const fx = fixture('a-test.js', "const { it } = require('node:test'); it('a', () => {});\n");
  try {
    const none = spawnSync(process.execPath, [RUNNER, path.join(fx.dir, '*.test.js')], { encoding: 'utf8', env });
    const plain = spawnSync(process.execPath, ['--test', path.join(fx.dir, '*.test.js')], { encoding: 'utf8', env });
    assert.equal(plain.status, 0, 'premise: plain node passes a pattern that matched nothing');
    assert.equal(none.status, 1, `zero matches must FAIL; got ${none.status}\n${none.stderr}`);
    assert.match(none.stderr, /file pattern matched NOTHING/);
    const some = spawnSync(process.execPath, [RUNNER, path.join(fx.dir, '*-test.js')], { encoding: 'utf8', env });
    assert.equal(some.status, 0, `control: the lane's own pattern runs; got ${some.status}\n${some.stderr}`);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('⛔ --tap streams TAP for the gate; the default stays spec (a lane parses it) — both show failures', () => {
  const fx = fixture('v.test.cjs', VANISH);
  try {
    const tap = spawnSync(process.execPath, [RUNNER, '--tap', fx.file], { encoding: 'utf8', env });
    assert.equal(tap.status, 1);
    assert.match(tap.stdout, /^not ok \d+ - needs a fixture/m, '--tap streams TAP the gate reads');
    assert.match(tap.stdout, /^ok \d+ - survivor/m);
    assert.doesNotMatch(tap.stdout, /✔/, '--tap replaces spec, it does not stack on it');
    const spec = spawnSync(process.execPath, [RUNNER, fx.file], { encoding: 'utf8', env });
    assert.equal(spec.status, 1);
    assert.match(spec.stdout, /^ℹ tests \d+/m, 'the DEFAULT is spec — fetlife parses this line');
    assert.match(spec.stdout, /^✖ failing tests:/m, 'spec still carries the marker the gate also matches');
    assert.doesNotMatch(spec.stdout, /^not ok /m);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a run of ONLY skipped or todo tests fails — it tested nothing; one passing test beside them is fine', () => {
  const onlySkip = fixture('s.test.cjs', "const { it } = require('node:test'); it.skip('later', () => {}); it.todo('also later');\n");
  const mixed = fixture('m.test.cjs', "const { it } = require('node:test'); it('real', () => {}); it.skip('later', () => {});\n");
  try {
    const r1 = spawnSync(process.execPath, [RUNNER, onlySkip.file], { encoding: 'utf8', env });
    assert.equal(r1.status, 1, 'skip/todo-only: nothing ran');
    assert.match(r1.stderr, /ZERO tests ran/);
    assert.equal(spawnSync(process.execPath, [RUNNER, mixed.file], { encoding: 'utf8', env }).status, 0);
  } finally {
    fs.rmSync(onlySkip.dir, { recursive: true, force: true }); fs.rmSync(mixed.dir, { recursive: true, force: true });
  }
});

test('the "vanished suite" hint appears only when a SUITE failed — not for an ordinary failing test', () => {
  const plainFail = fixture('f.test.cjs', "const { it } = require('node:test'); it('broken', () => { throw new Error('x'); });\n");
  const vanish = fixture('v.test.cjs', VANISH);
  try {
    const r1 = spawnSync(process.execPath, [RUNNER, plainFail.file], { encoding: 'utf8', env });
    assert.equal(r1.status, 1);
    assert.doesNotMatch(r1.stderr, /describe\(\) threw while registering/);
    const r2 = spawnSync(process.execPath, [RUNNER, vanish.file], { encoding: 'utf8', env });
    assert.match(r2.stderr, /describe\(\) threw while registering/, 'control: the hint where it applies');
  } finally {
    fs.rmSync(plainFail.dir, { recursive: true, force: true }); fs.rmSync(vanish.dir, { recursive: true, force: true });
  }
});
