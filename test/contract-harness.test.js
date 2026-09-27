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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');

/**
 * Run the harness; never throws, so a control can assert on the code.
 *
 * ⚠ spawnSync, NOT execFileSync-in-try/catch. The earlier form returned
 * `stderr: ''` on every SUCCESSFUL run, because execFileSync returns stdout
 * only — so an assertion about a passing run's human-readable reason could not
 * match anything, and read as the probe being silent rather than as the helper
 * discarding the stream. A test helper that drops a stream on one path makes
 * whole assertions unexpressible on that path.
 */
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status == null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
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

// ── gate-probe ────────────────────────────────────────────────────────────────
//
// ⛔ THE FIRST DRAFT OF `gate-probe` COULD NOT FAIL, and that is why these tests
// exist in this shape. It decided "a swap is in effect" by computing
// `declaredEnv !== worktree` — the SAME comparison judgePin makes — and then
// asserted judgePin declines. The assertion was guaranteed true and the
// FAIL branch was unreachable. ⇒ The precondition now comes from the GATE
// (WEBCTL_GATE_SWAPPED), which is a different source, so the claim about
// judgePin's own comparison is falsifiable — and the MUTATION test below is the
// one the first design could not express at all.

test('gate-probe: NO VERDICT outside the gate — never a vacuous pass', () => {
  const { dir, g } = fixture();
  g(['add', 'vendor/base-webctl']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

  const r = run(['gate-probe', '--repo', dir]);
  assert.equal(r.status, 2,
    `must decline, not pass, when no swap window exists; got ${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /"result":"no-verdict"/);
  assert.match(r.stderr, /vacuous/i, 'the reason must say WHY it declined');
});

test('⭐ gate-probe: PASSES in a real swap window, and names both sides', () => {
  const { dir, sub, g } = fixture();
  g(['add', 'vendor/base-webctl']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);
  const declared = execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // The swap the gate performs: check the submodule out at an untagged candidate
  // WITHOUT touching the parent's committed gitlink.
  fs.writeFileSync(path.join(sub, 'lib', 'candidate.js'), 'export const c = 3;\n');
  g(['-C', sub, 'add', '.']);
  g(['-C', sub, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'candidate']);
  const worktree = execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notEqual(declared, worktree, 'the fixture must actually produce a disagreement');

  const r = run(['gate-probe', '--repo', dir],
    { WEBCTL_GATE_SWAPPED: '1', WEBCTL_DECLARED_PIN: declared });
  assert.equal(r.status, 0, `must pass in a real swap window; got ${r.status}\n${r.stderr}`);
  // ⚠ Assert the SHAs are named, not just that it passed: the reason is the only
  // thing that travels to a human (xrl4).
  assert.match(r.stderr, new RegExp(declared.slice(0, 7)));
  assert.match(r.stderr, new RegExp(worktree.slice(0, 7)));
});

test('⛔ MUTATION: gate-probe FAILS when pin returns a verdict under a gate-reported swap', () => {
  // ⇒ THE TEST THE FIRST DESIGN COULD NOT EXPRESS. The gate claims a swap while
  // the declared pin EQUALS the worktree, so judgePin takes its ordinary path and
  // returns a real verdict (here: pass, since the gitlink is a tag). A probe
  // whose precondition were the same comparison would silently decline instead.
  const { dir, sub, g } = fixture();
  g(['add', 'vendor/base-webctl']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);
  const same = execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const r = run(['gate-probe', '--repo', dir],
    { WEBCTL_GATE_SWAPPED: '1', WEBCTL_DECLARED_PIN: same });
  assert.equal(r.status, 1,
    `a verdict under a reported swap must FAIL the probe; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /returned PASS/, 'the probe must say WHAT pin returned');
});

test('⛔ gate-probe FAILS when the gate reports a swap but hands over no declared pin', () => {
  // The state WEBCTL_DECLARED_PIN exists to prevent. Declining here would leave
  // the gate's own omission unreported.
  const { dir, g } = fixture();
  g(['add', 'vendor/base-webctl']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

  const r = run(['gate-probe', '--repo', dir], { WEBCTL_GATE_SWAPPED: '1' });
  assert.equal(r.status, 1, `must FAIL, not decline; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /did not hand over WEBCTL_DECLARED_PIN/);
});

// ── no-revendor: recursion and content ───────────────────────────────────────
//
// ⛔ THE CHECK COULD NOT SEE THE CASE IT EXISTS FOR. Until generation 2 it read
// only the TOP LEVEL of both trees and matched only IDENTICAL FILENAMES — while
// HALF of base's own lib is nested (12 flat, 12 under lib/browser-location/). So
// `profile-lock.js`, `mounts.js` and `chromium-docker-xpra.js` were not even in
// the comparison set. Measured: three planted re-vendors all reported `pass` with
// the reason "3 local file(s) examined; none shadows a base module".
//
// ⭐ Reported by webctl:mgr's template survey, WITH the instruction to re-measure
// before acting — which is why it was caught as three concrete planted copies
// rather than adopted as a described defect.

/** A fixture whose vendored base mirrors base's real shape: some flat, some nested. */
function revendorFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revendor-'));
  const vlib = path.join(dir, 'vendor', 'base-webctl', 'lib');
  fs.mkdirSync(path.join(vlib, 'browser-location'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib', 'cdp'), { recursive: true });
  fs.writeFileSync(path.join(vlib, 'client-config.js'),
    '// base\nexport function createClientConfig(C) { return { C }; }\n');
  fs.writeFileSync(path.join(vlib, 'browser-location', 'profile-lock.js'),
    '// base nested\nexport function createProfileLock(C) { return { C }; }\n');
  return { dir, vlib };
}

test('⛔ MUTATION: a NESTED base module copied to the local top level is caught', () => {
  const { dir, vlib } = revendorFixture();
  // The case generation 1 was structurally blind to: the name is not in the
  // top-level listing of base's lib at all.
  fs.copyFileSync(path.join(vlib, 'browser-location', 'profile-lock.js'),
    path.join(dir, 'lib', 'profile-lock.js'));

  const r = run(['no-revendor', '--repo', dir]);
  assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /profile-lock\.js/);
  assert.match(r.stderr, /browser-location/, 'it must name WHICH base module was copied');
});

test('⛔ MUTATION: a copy into a SUBDIRECTORY under a NEW NAME is caught by content', () => {
  const { dir, vlib } = revendorFixture();
  fs.copyFileSync(path.join(vlib, 'client-config.js'), path.join(dir, 'lib', 'cdp', 'client.mjs'));

  const r = run(['no-revendor', '--repo', dir]);
  assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /client\.mjs/, 'the local path must be named');
  assert.match(r.stderr, /identical after normalisation/, 'and HOW it was detected');
});

test('⭐ a copy that was REFORMATTED and RE-COMMENTED is still caught', () => {
  // ⇒ What a re-vendor looks like after someone has "adapted" it. Normalisation
  // strips comments and collapses whitespace, so cosmetic edits do not hide it.
  const { dir, vlib } = revendorFixture();
  const src = fs.readFileSync(path.join(vlib, 'client-config.js'), 'utf8');
  fs.writeFileSync(path.join(dir, 'lib', 'adapted.js'),
    `// OUR adapted copy, reformatted\n\n${src.replace('// base\n', '').replace(/ /g, '  ')}\n`);

  const r = run(['no-revendor', '--repo', dir]);
  assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /adapted\.js/);
});

test('⭐ CONTROL: a legitimate RE-EXPORT shim is not flagged', () => {
  // The pattern consumers are SUPPOSED to use. A check that flagged this would be
  // overridden within a day, which is worse than one that misses a copy.
  const { dir } = revendorFixture();
  fs.writeFileSync(path.join(dir, 'lib', 'profile-lock.js'),
    "export { createProfileLock } from '../vendor/base-webctl/lib/browser-location/profile-lock.js';\n");
  fs.writeFileSync(path.join(dir, 'lib', 'own.js'), 'export const mine = 1;\n');

  const r = run(['no-revendor', '--repo', dir]);
  assert.equal(r.status, 0, `a shim must pass; got ${r.status}\n${r.stderr}`);
});

test('⛔ a base lib with ZERO modules FAILS rather than finding nothing to report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revendor-empty-'));
  fs.mkdirSync(path.join(dir, 'vendor', 'base-webctl', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'own.js'), 'export const mine = 1;\n');

  const r = run(['no-revendor', '--repo', dir]);
  assert.equal(r.status, 1, 'losing the comparison set is a FAIL, not a clean bill');
  assert.match(r.stderr, /lost its comparison set|ZERO modules/);
});

test('the reason states what this check does NOT cover', () => {
  // ⇒ An edited copy under a different name still escapes. Saying so in the PASS
  // reason is the difference between a limit and a false impression of coverage.
  const { dir } = revendorFixture();
  fs.writeFileSync(path.join(dir, 'lib', 'own.js'), 'export const mine = 1;\n');
  const r = run(['no-revendor', '--repo', dir]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /EDITED copy under a DIFFERENT name is\s+not detected/);
});
