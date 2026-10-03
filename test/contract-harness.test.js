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

test('⛔ pin: NO VERDICT only when the gate SAYS it swapped (WEBCTL_GATE_SWAPPED=1)', () => {
  // Generation 3 keyed this on "WEBCTL_DECLARED_PIN set and != worktree". Since v0.24
  // the gate sets DECLARED_PIN on EVERY run, so that is a declaration, not a swap —
  // the gate's own SWAPPED flag is the only signal. (Before it, WEBCTL_BASE_DIR was
  // the proxy; this is the fifth keying, and the first that asks the swapper.)
  const { dir, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

    const swapped = run(['pin', '--repo', dir],
      { WEBCTL_DECLARED_PIN: 'deadbeef'.repeat(5), WEBCTL_GATE_SWAPPED: '1' });
    assert.equal(swapped.status, 2, 'a swapped submodule must be NO VERDICT, never a FAIL');
    assert.match(swapped.stderr, /release gate has swapped/);

    // ⚠ DECLARED_PIN differing from the worktree WITHOUT the gate saying it swapped is
    // not a swap: here the worktree IS the gitlink, at a tag, so it is an ordinary pass.
    const declaredOnly = run(['pin', '--repo', dir],
      { WEBCTL_DECLARED_PIN: 'deadbeef'.repeat(5), WEBCTL_GATE_SWAPPED: '0' });
    assert.equal(declaredOnly.status, 0, 'DECLARED_PIN is a declaration, not a swap');

    // and SWAPPED=1 with nothing actually moved is not a swap either
    const declared = execFileSync('git', ['ls-tree', 'HEAD', 'vendor/base-webctl'],
      { cwd: dir, encoding: 'utf8' }).split(/\s+/)[2];
    const notMoved = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: declared, WEBCTL_GATE_SWAPPED: '1' });
    assert.equal(notMoved.status, 0, 'only declared != worktree under SWAPPED=1 is the carve-out');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ pin: DRIFT — worktree != gitlink with NO gate signal FAILS; control: equal passes, gate swap is NO VERDICT', () => {
  // Measured by `substack` at v0.22.0: a worktree at another commit, no gate env,
  // and the result was "PASS pin: declared gitlink … is tag", exit 0. The suite
  // then ran against code the repo did not declare — the drift `pin` exists for.
  const { dir, sub, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);
    const declared = execFileSync('git', ['ls-tree', 'HEAD', 'vendor/base-webctl'],
      { cwd: dir, encoding: 'utf8' }).split(/\s+/)[2];

    // control: worktree == gitlink (a tag) passes
    assert.equal(run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: '' }).status, 0);

    // move ONLY the checkout; the declaration still names the tag
    fs.writeFileSync(path.join(sub, 'lib', 'drift.js'), 'export const z = 3;\n');
    g(['-C', sub, 'add', '.']);
    g(['-C', sub, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'drift']);

    const drift = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: '', WEBCTL_GATE_SWAPPED: '' });
    assert.equal(drift.status, 1, `drift must FAIL; got ${drift.status}\n${drift.stderr}`);
    assert.match(drift.stderr, /DRIFT/);
    assert.match(drift.stderr, new RegExp(declared.slice(0, 7)));

    // the SAME tree under the gate's swap is NO VERDICT, not a drift failure
    const gated = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: declared, WEBCTL_GATE_SWAPPED: '1' });
    assert.equal(gated.status, 2, 'the gate swapping on purpose is not drift');
    assert.match(gated.stderr, /release gate has swapped/);

    // ⛔ THE fetlife ARM: under the gate, DECLARED_PIN set, but the gate did NOT swap
    // (SWAPPED=0). Generation 3 called this "the release gate has swapped" and gave NO
    // VERDICT — real drift passing, under a false statement. It is drift.
    const gateNoSwap = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: declared, WEBCTL_GATE_SWAPPED: '0' });
    assert.equal(gateNoSwap.status, 1, `drift under a non-swapping gate run must FAIL; got ${gateNoSwap.status}\n${gateNoSwap.stderr}`);
    assert.match(gateNoSwap.stderr, /DRIFT/);
    assert.doesNotMatch(gateNoSwap.stderr, /release gate has swapped/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ pin: UNDECLARED is its own verdict — a worktree never stands in for a missing gitlink', () => {
  const { dir } = fixture();
  try {
    // the sub repo exists and is at a TAG, but nothing is committed in the parent
    const r = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: '' });
    assert.equal(r.status, 1, `undeclared must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /UNDECLARED/);
    assert.doesNotMatch(r.stderr + r.stdout, /declared gitlink [0-9a-f]{7} is tag/,
      'it must not claim a declaration nobody made');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ pin: a plain vendored DIRECTORY is not a gitlink (ls-tree prints a TREE sha there)', () => {
  const { dir, sub, g } = fixture();
  try {
    // commit the files as a directory, not as a submodule
    fs.rmSync(path.join(sub, '.git'), { recursive: true, force: true });
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'vendored-copy']);
    const r = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: '' });
    assert.notEqual(r.status, 0, `a copied directory has no pin to pass; got ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr + r.stdout, /declared gitlink/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⚠ pin: SWAPPED=1 with NO declared pin is named INCONSISTENT, never reported as a swap', () => {
  // A lane's fixture scrubbed DECLARED_PIN but not SWAPPED, under the gate; the old
  // reason read "the release gate has swapped (declared , worktree …)".
  const { dir, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);
    const r = run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: '', WEBCTL_GATE_SWAPPED: '1' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /INCONSISTENT gate signal/);
    assert.doesNotMatch(r.stderr, /release gate has swapped/);
    // control: the same fixture with the variables scrubbed BOTH ways is an ordinary pass
    assert.equal(run(['pin', '--repo', dir], { WEBCTL_DECLARED_PIN: '', WEBCTL_GATE_SWAPPED: '' }).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ require-generation: a FLOOR that fails closed — including on harnesses that predate it', () => {
  const ok = run(['require-generation', '1']);
  assert.equal(ok.status, 0);
  assert.match(ok.stderr, /above the floor 1/, 'above the floor warns, so a stale floor is visible');
  const exact = run(['generation']);
  const gen = Number(JSON.parse(exact.stdout).generation);
  assert.equal(run(['require-generation', String(gen)]).status, 0, 'control: the exact generation passes');
  const below = run(['require-generation', String(gen + 1)]);
  assert.equal(below.status, 1, 'a floor above this harness FAILS');
  assert.match(below.stderr, /BELOW the required/);
  for (const bad of [[], ['0'], ['x'], ['3', 'extra']]) {
    assert.equal(run(['require-generation', ...bad]).status, 3, JSON.stringify(bad));
  }
});

test('⛔ DOWNGRADE: the floor fails closed on a generation-2 harness; a --min FLAG would have passed', () => {
  // The harness lives inside the submodule, so a downgrade replaces the checker too.
  // This runs base's REAL generation-2 harness (v0.22.0), from git, not a mock.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gen2-'));
  try {
    const src = execFileSync('git', ['show', 'v0.22.0:scripts/contract-harness.mjs'], { cwd: ROOT, encoding: 'utf8' });
    const file = path.join(old, 'contract-harness.mjs');
    fs.writeFileSync(file, src);
    const runOld = (/** @type {string[]} */ a) => spawnSync(process.execPath, [file, ...a], { encoding: 'utf8' });
    assert.match(runOld(['generation']).stdout, /"generation":2/, 'premise: this IS generation 2');
    // the VERB: unknown on gen 2 -> usage, non-zero -> a contract fails closed
    assert.equal(runOld(['require-generation', '4']).status, 3);
    // the FLAG that was proposed: gen 2 ignores it and passes. This is why it is a verb.
    assert.equal(runOld(['generation', '--min', '4']).status, 0, 'measured: a flag fails OPEN on old harnesses');
    // and the current harness refuses the flag form, so nobody adopts it
    assert.equal(run(['generation', '--min', '4']).status, 3);
  } finally { fs.rmSync(old, { recursive: true, force: true }); }
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

// ── no-revendor: a same-name EDITED copy (generation 5) ──────────────────────
//
// ⛔ THE NAME MATCH FOUND THE FILE AND THEN EXCUSED IT. Generation 4 cleared any
// same-named file that imported ANYTHING from base's lib — and an edited copy of
// a base module imports that module's SIBLINGS, exactly as the original does. So
// the realistic re-vendor was the case the excuse fired on. Measured 2026-10-03
// (`substack`): a stale local lib/cdp-client.js requiring base's cdp-rewrite.js
// reported PASS, "none is a copy by content or by name". ⇒ A shim is now
// recognised by WHAT IT WRAPS: it must import its own same-named base module.

/** revendorFixture() plus base's real cdp-client → cdp-rewrite sibling edge. */
function cdpFixture() {
  const fx = revendorFixture();
  fs.writeFileSync(path.join(fx.vlib, 'browser-location', 'cdp-rewrite.js'),
    'function rewriteWsUrl(u) { return u; }\nmodule.exports = { rewriteWsUrl };\n');
  fs.writeFileSync(path.join(fx.vlib, 'browser-location', 'docker-ctl.js'),
    'function createDockerCtl() { return { run() { return 0; } }; }\nmodule.exports = { createDockerCtl };\n');
  fs.writeFileSync(path.join(fx.vlib, 'cdp-client.js'),
    "'use strict';\nconst { rewriteWsUrl } = require('./browser-location/cdp-rewrite.js');\n"
    + 'class CdpSession { send(m) { return rewriteWsUrl(m); } }\nmodule.exports = { CdpSession };\n');
  return fx;
}

test('⛔ MUTATION: a same-name EDITED copy that imports a base SIBLING is caught (the shape that shipped)', () => {
  const { dir } = cdpFixture();
  try {
    // Content differs from base's (send() changed), so the hash cannot see it —
    // and it requires base's cdp-rewrite.js, which is what excused it before.
    fs.writeFileSync(path.join(dir, 'lib', 'cdp-client.js'),
      "'use strict';\nconst { rewriteWsUrl } = require('../vendor/base-webctl/lib/browser-location/cdp-rewrite.js');\n"
      + "class CdpSession { send(m) { return rewriteWsUrl(m) + '!'; } }\nmodule.exports = { CdpSession };\n");
    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 1, `a same-name edited copy must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /lib\/cdp-client\.js <- lib\/cdp-client\.js/, 'it must name the file and the base module');
    assert.match(r.stderr, /does not import base's own lib\/cdp-client\.js/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ MUTATION: a same-name edited copy in a SUBDIRECTORY is caught', () => {
  const { dir } = cdpFixture();
  try {
    fs.mkdirSync(path.join(dir, 'lib', 'browser-location'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'browser-location', 'docker-ctl.js'),
      "const { rewriteWsUrl } = require('../../vendor/base-webctl/lib/browser-location/cdp-rewrite.js');\n"
      + 'function createDockerCtl() { return { run() { return rewriteWsUrl(1); } }; }\n'
      + 'module.exports = { createDockerCtl };\n');
    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /lib\/browser-location\/docker-ctl\.js <- lib\/browser-location\/docker-ctl\.js/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ CONTROL: same-name WRAPPERS that import their own base module pass (CJS, ESM, nested, with extras)', () => {
  // The shapes the fleet actually ships (surveyed 2026-10-03): a bare re-export,
  // a factory bound to local constants, and a wrapper that ADDS functions. All
  // import their same-named base module, so all are shims.
  const { dir } = cdpFixture();
  try {
    fs.mkdirSync(path.join(dir, 'lib', 'browser-location'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'cdp-client.js'),
      "module.exports = require('../vendor/base-webctl/lib/cdp-client.js');\n");
    fs.writeFileSync(path.join(dir, 'lib', 'browser-location', 'docker-ctl.js'),
      "const _base = require('../../vendor/base-webctl/lib/browser-location/docker-ctl.js');\n"
      + 'function extra() { return 1; }\nmodule.exports = Object.assign(_base.createDockerCtl(), { extra });\n');
    fs.writeFileSync(path.join(dir, 'lib', 'client-config.js'),
      "import { createClientConfig } from '../vendor/base-webctl/lib/client-config.js';\n"
      + 'export default createClientConfig({});\n');
    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 0, `wrappers must pass; got ${r.status}\n${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ a vendor path to the SAME module inside a COMMENT does not make a copy a shim', () => {
  // Prose must not satisfy the counterpart test either — the original defect.
  const { dir } = cdpFixture();
  try {
    fs.writeFileSync(path.join(dir, 'lib', 'cdp-client.js'),
      "// was: require('../vendor/base-webctl/lib/cdp-client.js')\n"
      + "/* from '../vendor/base-webctl/lib/cdp-client.js' */\n"
      + "class CdpSession { send(m) { return m + '!'; } }\nmodule.exports = { CdpSession };\n");
    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
