// contract-harness.test.js — the harness must be able to say NO.
//
// ⛔ A defective contract reports GREEN, which is why this library exists and
// why its own tests have to be sabotage-driven rather than happy-path. Every
// check below is exercised in BOTH directions against a hermetic fixture repo,
// and the re-vendor control replays THE SHAPE THAT SHIPPED — a vendor path
// appearing only inside a comment — rather than a synthetic mutation.
//
// ⭐ A synthetic mutation proves a check CAN fail. Replaying the shape that
// shipped proves it fails on the thing that happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');

/** Run the harness; never throws, so a control can assert on the code. */
function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    return { status: 0, stdout, stderr: '' };
  } catch (/** @type {any} */ e) {
    return { status: e.status == null ? -1 : e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

/** A throwaway consumer repo with a real submodule-shaped gitlink. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fx-'));
  const g = (/** @type {string[]} */ a, /** @type {string} */ cwd = dir) =>
    execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  // The "base" the fixture vendors.
  const sub = path.join(dir, 'vendor', 'base-webctl');
  fs.mkdirSync(path.join(sub, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'lib', 'client-config.js'), 'export const x = 1;\n');
  g(['init', '-q'], dir); g(['-C', sub, 'init', '-q']);
  g(['-C', sub, 'add', '.']);
  g(['-C', sub, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
  g(['-C', sub, 'tag', 'v1.0.0']);

  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  return { dir, sub, g };
}

test('⭐ pin: PASSES on a tagged gitlink, FAILS on a bare commit', () => {
  const { dir, sub, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

    const ok = run(['pin', '--repo', dir]);
    assert.equal(ok.status, 0, `tagged pin must pass; got ${ok.status}\n${ok.stderr}`);
    assert.match(ok.stdout, /"tag":"v1\.0\.0"/);

    // ⛔ THE OTHER ANSWER: move base one commit past the tag and re-mount, so
    // the declared gitlink is a bare commit. A check that cannot produce this
    // is not checking anything.
    fs.writeFileSync(path.join(sub, 'lib', 'extra.js'), 'export const y = 2;\n');
    g(['-C', sub, 'add', '.']);
    g(['-C', sub, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'past-tag']);
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bump-off-tag']);

    const bad = run(['pin', '--repo', dir]);
    assert.equal(bad.status, 1, `an untagged gitlink must FAIL; got ${bad.status}\n${bad.stderr}`);
    assert.match(bad.stderr, /not an exact tag/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ pin: NO VERDICT under the gate\'s swap, keyed on the DECLARED pin', () => {
  // Not on WEBCTL_BASE_DIR, which is a proxy the gate sets on every run — so
  // keying the skip on it skips a computable check every time. The declared pin
  // differing from the worktree is the actual signal, and it is the one the
  // gate can supply precisely because the swap takes it away.
  const { dir, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

    const swapped = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: 'deadbeef'.repeat(5) });
    assert.equal(swapped.status, 2, 'a swapped submodule must be NO VERDICT, never a FAIL');
    assert.match(swapped.stderr, /release gate has swapped/);

    // ⚠ And the carve-out must NOT fire merely because the variable is set to
    // the value already checked out — otherwise it skips on every gated run.
    const declared = execFileSync('git', ['ls-tree', 'HEAD', 'vendor/base-webctl'],
      { cwd: dir, encoding: 'utf8' }).split(/\s+/)[2];
    const notSwapped = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: declared });
    assert.equal(notSwapped.status, 0,
      'the variable being SET is not the signal — only declared != worktree is');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ no-revendor: catches THE SHAPE THAT SHIPPED — a vendor path in a COMMENT', () => {
  // The original check was `grep -q "$BASE_DIR" lib/client-config.js`, which
  // matched the string inside the shim's own explanatory comment and returned
  // PASS across a genuine re-vendor. This fixture reproduces exactly that: a
  // local file that DEFINES the surface while mentioning the vendor path only
  // in prose.
  const { dir, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

    fs.writeFileSync(path.join(dir, 'lib', 'client-config.js'),
      '// This module mirrors vendor/base-webctl/lib/client-config.js.\n'
      + '// See vendor/base-webctl/lib/ for the upstream original.\n'
      + 'export const x = 1;\n');

    const caught = run(['no-revendor', '--repo', dir]);
    assert.equal(caught.status, 1,
      'a local file DEFINING a base surface, mentioning the vendor path only in a '
      + 'comment, must FAIL — that is the defect that shipped');
    assert.match(caught.stderr, /re-vendor/);

    // The honest case: same filename, but it RE-EXPORTS base rather than
    // defining. That is a shim and must pass.
    fs.writeFileSync(path.join(dir, 'lib', 'client-config.js'),
      "export * from '../vendor/base-webctl/lib/client-config.js';\n");
    const shim = run(['no-revendor', '--repo', dir]);
    assert.equal(shim.status, 0, `a genuine shim must PASS; got ${shim.status}\n${shim.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ no-revendor: examining ZERO files FAILS rather than reporting clean', () => {
  // "No re-vendoring found" over nothing at all is the vacuity that let the
  // original grep pass. A moved lib/, a changed extension, a renamed dir — all
  // present as a clean run.
  const { dir, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);
    // lib/ exists and is empty.
    const vacuous = run(['no-revendor', '--repo', dir]);
    assert.equal(vacuous.status, 1, 'zero files examined must FAIL');
    assert.match(vacuous.stderr, /ZERO files/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the harness owns the exit codes, and publishes its generation', () => {
  // ⇒ A contract never re-implements `[ "$rc" = "2" ] && { … }`, which as an
  // arm's last statement returns 1 under `set -e` and turns a GREEN suite red.
  const gen = run(['generation']);
  assert.equal(gen.status, 0);
  assert.match(gen.stdout, /"generation":\d+/);

  const bad = run(['no-such-check']);
  assert.equal(bad.status, 3, 'usage errors are 3, distinct from fail(1) and no-verdict(2)');
});
