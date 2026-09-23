// base-surface-tool.test.js — the enumerator must keep seeing what a grep cannot.
//
// ⛔ THE FAILURE IT GUARDS: if `base-surface.mjs` ever reports zero
// factory-return members, it has SILENTLY BECOME THE GREP IT REPLACES — same
// answers, same blind spot, and nothing about a clean run would say so.
//
// ⭐ IT ASSERTS A PROPERTY OF THE TOOL, NOT A SYMBOL. Pinning `inspect` by name
// would couple this to a surface base may legitimately change — and then the
// control fails for a CORRECT reason and gets deleted by whoever refactors that
// symbol. ⚠ Deleting a control that fails correctly looks like tidying, and is
// indistinguishable from tidying at review time. The only defence is this
// comment plus an assertion that cannot be satisfied by renaming anything.
// (linkedin-webctl's design; adopted rather than re-implemented.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'base-surface.mjs');

/** @returns {{stdout: string, stderr: string, status: number}} */
function run(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', status: 0 };
  } catch (/** @type {any} */ e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status == null ? 1 : e.status };
  }
}

test('⭐ at least one name is reachable ONLY by constructing', () => {
  // The property, stated without naming a symbol: a grep for `export` cannot
  // see the whole surface. If this ever holds vacuously the tool is broken,
  // which is what the exit-code assertion below covers.
  const { stdout, status } = run();
  assert.equal(status, 0, 'the tool must run clean against base itself');

  const constructed = stdout.split('\n').filter((l) => /^(factory return|driver surface)/.test(l));
  assert.ok(constructed.length > 0,
    'ZERO names reachable only by constructing — the tool has become the grep it replaces');

  // And the share is large enough that the distinction matters. Not pinned to
  // 46%: the number moves as base grows, and a test that fails on healthy
  // growth gets deleted.
  const exports_ = stdout.split('\n').filter((l) => /^module export/.test(l));
  assert.ok(exports_.length > 0, 'no module exports found at all — the walk is broken');
  assert.ok(constructed.length > exports_.length * 0.2,
    `only ${constructed.length} constructed vs ${exports_.length} exported — suspiciously few; `
    + 'the factory walk may have stopped matching');
});

test('⛔ the vacuity guard fires when the tool sees no factory returns', () => {
  // The control: make the factory walk find nothing, and require exit 1 with a
  // message naming what happened. Without this there is only evidence the tool
  // works when everything is fine — which is the state it is least needed in.
  const src = fs.readFileSync(TOOL, 'utf8');
  const broken = src.replace(/\/\^create\[A-Z\]\//, '/^__never_matches_anything__/');
  assert.notEqual(broken, src, 'the factory-name pattern moved; this control no longer mutates anything');

  const tmp = path.join(ROOT, 'scripts', '.tmp-base-surface-control.mjs');
  fs.writeFileSync(tmp, broken);
  try {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [tmp], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (/** @type {any} */ e) {
      status = e.status; stderr = e.stderr || '';
    }
    assert.equal(status, 1, 'a tool that sees no factory returns must EXIT 1, not report a smaller surface');
    assert.match(stderr, /become the grep it replaces/,
      'and it must say WHY, or the exit code is just another number');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('the tool does not write under the real HOME', () => {
  // ⚠ Enumerating by CALLING is not free: resolveChromiumProfile() mkdirs.
  // The tool constructs against a throwaway HOME — this asserts the claim
  // rather than trusting the comment that makes it.
  const home = process.env.HOME || '';
  const cacheDir = path.join(home, '.cache', 'CLIAI');
  const before = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : -1;
  const { status } = run();
  assert.equal(status, 0);
  const after = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : -1;
  assert.equal(after, before, 'the enumeration created entries under the real ~/.cache/CLIAI');
  assert.ok(!fs.existsSync(path.join(cacheDir, 'surface-probe')),
    'the probe constants leaked a real cache directory');
});
