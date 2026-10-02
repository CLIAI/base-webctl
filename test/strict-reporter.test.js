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
