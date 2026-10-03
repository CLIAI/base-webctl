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
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

    const r = run(['gate-probe', '--repo', dir]);
    assert.equal(r.status, 2,
      `must decline, not pass, when no swap window exists; got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /"result":"no-verdict"/);
    assert.match(r.stderr, /vacuous/i, 'the reason must say WHY it declined');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ gate-probe: PASSES in a real swap window, and names both sides', () => {
  const { dir, sub, g } = fixture();
  try {
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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ MUTATION: gate-probe FAILS when pin returns a verdict under a gate-reported swap', () => {
  // ⇒ THE TEST THE FIRST DESIGN COULD NOT EXPRESS. The gate claims a swap while
  // the declared pin EQUALS the worktree, so judgePin takes its ordinary path and
  // returns a real verdict (here: pass, since the gitlink is a tag). A probe
  // whose precondition were the same comparison would silently decline instead.
  const { dir, sub, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);
    const same = execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const r = run(['gate-probe', '--repo', dir],
      { WEBCTL_GATE_SWAPPED: '1', WEBCTL_DECLARED_PIN: same });
    assert.equal(r.status, 1,
      `a verdict under a reported swap must FAIL the probe; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /returned PASS/, 'the probe must say WHAT pin returned');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ gate-probe FAILS when the gate reports a swap but hands over no declared pin', () => {
  // The state WEBCTL_DECLARED_PIN exists to prevent. Declining here would leave
  // the gate's own omission unreported.
  const { dir, g } = fixture();
  try {
    g(['add', 'vendor/base-webctl']);
    g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mount']);

    const r = run(['gate-probe', '--repo', dir], { WEBCTL_GATE_SWAPPED: '1' });
    assert.equal(r.status, 1, `must FAIL, not decline; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /did not hand over WEBCTL_DECLARED_PIN/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
  try {
    // The case generation 1 was structurally blind to: the name is not in the
    // top-level listing of base's lib at all.
    fs.copyFileSync(path.join(vlib, 'browser-location', 'profile-lock.js'),
      path.join(dir, 'lib', 'profile-lock.js'));

    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /profile-lock\.js/);
    assert.match(r.stderr, /browser-location/, 'it must name WHICH base module was copied');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ MUTATION: a copy into a SUBDIRECTORY under a NEW NAME is caught by content', () => {
  const { dir, vlib } = revendorFixture();
  try {
    fs.copyFileSync(path.join(vlib, 'client-config.js'), path.join(dir, 'lib', 'cdp', 'client.mjs'));

    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /client\.mjs/, 'the local path must be named');
    assert.match(r.stderr, /identical after normalisation/, 'and HOW it was detected');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ a copy that was REFORMATTED and RE-COMMENTED is still caught', () => {
  // ⇒ What a re-vendor looks like after someone has "adapted" it. Normalisation
  // strips comments and collapses whitespace, so cosmetic edits do not hide it.
  const { dir, vlib } = revendorFixture();
  try {
    const src = fs.readFileSync(path.join(vlib, 'client-config.js'), 'utf8');
    fs.writeFileSync(path.join(dir, 'lib', 'adapted.js'),
      `// OUR adapted copy, reformatted\n\n${src.replace('// base\n', '').replace(/ /g, '  ')}\n`);

    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /adapted\.js/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ CONTROL: a legitimate RE-EXPORT shim is not flagged', () => {
  // The pattern consumers are SUPPOSED to use. A check that flagged this would be
  // overridden within a day, which is worse than one that misses a copy.
  const { dir } = revendorFixture();
  try {
    fs.writeFileSync(path.join(dir, 'lib', 'profile-lock.js'),
      "export { createProfileLock } from '../vendor/base-webctl/lib/browser-location/profile-lock.js';\n");
    fs.writeFileSync(path.join(dir, 'lib', 'own.js'), 'export const mine = 1;\n');

    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 0, `a shim must pass; got ${r.status}\n${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
  try {
    fs.mkdirSync(path.join(dir, 'vendor', 'base-webctl', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'own.js'), 'export const mine = 1;\n');

    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 1, 'losing the comparison set is a FAIL, not a clean bill');
    assert.match(r.stderr, /lost its comparison set|ZERO modules/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the reason states what this check does NOT cover', () => {
  // ⇒ An edited copy under a different name still escapes. Saying so in the PASS
  // reason is the difference between a limit and a false impression of coverage.
  const { dir } = revendorFixture();
  try {
    fs.writeFileSync(path.join(dir, 'lib', 'own.js'), 'export const mine = 1;\n');
    const r = run(['no-revendor', '--repo', dir]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /EDITED copy under a DIFFERENT name is\s+not detected/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── no-revendor: specifiers are read from TOKENS, never from prose ───────────
//
// ⛔ "COMMENTS STRIPPED" MEANT WHOLE-LINE `//` ONLY. A copy ending in
// `// forked from require('…/cdp-client.js')`, or carrying that text inside a
// string literal, PASSED (measured in review, 2026-10-03: exit 0 on both). The
// regex found the specifier in prose that survived the line filter. ⇒ Every
// arm below is a COPY whose only mention of its base module is non-code.

const CDP = '../vendor/base-webctl/lib/cdp-client.js';
const COPY = "class CdpSession { send(m) { return m + '!'; } }\nmodule.exports = { CdpSession };\n";

/**
 * Write `files` (lib-relative path -> source) into a fresh cdpFixture, run
 * no-revendor, clean up, and return the result.
 * @param {Record<string,string>} files @param {(vlib: string) => void} [base]
 */
function judge(files, base) {
  const { dir, vlib } = cdpFixture();
  try {
    if (base) base(vlib);
    for (const [rel, src] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, 'lib', rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib', rel), src);
    }
    return run(['no-revendor', '--repo', dir]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('⛔ a specifier in a TRAILING comment, a BLOCK comment, a STRING or a TEMPLATE does not make a copy a shim', () => {
  const fakes = {
    'trailing comment': `${COPY.trimEnd()} // forked from require('${CDP}')\n`,
    'string literal': `const note = "forked from '${CDP}'";\n${COPY}`,
    'inline block comment': `${COPY.trimEnd()} /* require('${CDP}') */\n`,
    'multi-line block comment': `/*\n * export * from '${CDP}';\n */\n${COPY}`,
    'template literal': `const t = \`require('${CDP}')\`;\n${COPY}`,
    'template expression text': `const t = \`\${1} from '${CDP}'\`;\n${COPY}`,
    'from as a plain identifier (ASI)': `const from = 1;\nfrom\n'${CDP}'\n${COPY}`,
    'a .require method': `const x = { require() { return 0; } };\nx.require('${CDP}');\n${COPY}`,
    'a computed require': `require('../vendor/base-webctl/lib/cdp-' + 'client.js');\n${COPY}`,
  };
  for (const [what, src] of Object.entries(fakes)) {
    const r = judge({ 'cdp-client.js': src });
    assert.equal(r.status, 1, `${what}: a copy must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /lib\/cdp-client\.js <- lib\/cdp-client\.js/, what);
  }
});

test('⭐ CONTROL: every REAL module-syntax form of the counterpart passes — and the lexer survives regex, template and URL text', () => {
  const shims = {
    'require': `module.exports = require('${CDP}');\n`,
    'import-from, then extends': `import { CdpSession } from '${CDP}';\nexport class Mine extends CdpSession {}\n`,
    'export-star-from': `export * from '${CDP}';\n`,
    'export-clause-from, double quotes': `export { CdpSession as default } from "${CDP}";\n`,
    'side-effect import': `import '${CDP}';\nexport const ready = true;\n`,
    'dynamic import': `const m = await import('${CDP}');\nexport default m;\n`,
    // If `/["'\`]/` were read as division, the backtick would open a template
    // that swallows the rest of the file; if strings were not lexed, `//` in the
    // URL would comment out the require on the same line.
    // Discriminating arm for regex lexing: misread as division, this backtick
    // opens a template running to EOF, and the require below is never seen.
    'after a regex containing a backtick': `const q = /\`/;\nmodule.exports = require('${CDP}');\n`,
    'after a regex with quotes, a nested template and a URL':
      "const q = /[\"'`]/g; const t = `a${ { b: '}' }.b }c`;\n"
      + `const u = 'http://example.invalid/*'; module.exports = require('${CDP}');\n`,
  };
  for (const [what, src] of Object.entries(shims)) {
    const r = judge({ 'cdp-client.js': src });
    assert.equal(r.status, 0, `${what}: a real shim must PASS; got ${r.status}\n${r.stderr}`);
  }
});

// ── no-revendor: barrels — base's house rule, and a consumer's own index.js ──
//
// ⭐ base's AGENTS.md tells consumers to import ONLY lib/index.js, so a pure
// re-export through that barrel is the sanctioned shape and must not go red.
// ⛔ But the barrel reaches every sibling, so a file that imports it AND defines
// code is still a possible copy. "Defines nothing" is what separates the two.

const INDEX = '../vendor/base-webctl/lib/index.js';
/** @param {string} vlib */
const withBarrel = (vlib) => fs.writeFileSync(path.join(vlib, 'index.js'),
  "module.exports = { ...require('./cdp-client.js'), ...require('./client-config.js') };\n");

test('⭐ a same-named PURE re-export through base\'s lib/index.js passes; the same file defining code FAILS', () => {
  const pure = {
    'CJS property': `module.exports = require('${INDEX}').CdpSession;\n`,
    'ESM re-export clause': `export { CdpSession as default } from '${INDEX}';\n`,
  };
  for (const [what, src] of Object.entries(pure)) {
    const r = judge({ 'cdp-client.js': src }, withBarrel);
    assert.equal(r.status, 0, `${what}: a pure barrel shim must PASS; got ${r.status}\n${r.stderr}`);
  }
  const defining = {
    'a function': `const { CdpSession } = require('${INDEX}');\nfunction send(m) { return m; }\nmodule.exports = { CdpSession, send };\n`,
    'an arrow': `const { CdpSession } = require('${INDEX}');\nconst send = (m) => m;\nmodule.exports = { CdpSession, send };\n`,
    'a method shorthand': `module.exports = { ...require('${INDEX}'), send(m) { return m; } };\n`,
    'a class': `import { CdpSession } from '${INDEX}';\nexport class Mine extends CdpSession {}\n`,
  };
  for (const [what, src] of Object.entries(defining)) {
    const r = judge({ 'cdp-client.js': src }, withBarrel);
    assert.equal(r.status, 1, `barrel import + ${what}: must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /rename it/, what);
    assert.doesNotMatch(r.stderr, /index\.js, does not count/, 'the old, wrong advice is gone');
  }
});

test('⭐ a consumer\'s OWN index.js that only re-exports LOCAL modules is a barrel, not a copy', () => {
  const own = { 'own.js': 'export const mine = 1;\n', 'cdp/thing.js': 'export const x = 2;\n' };
  for (const [what, src] of Object.entries({
    'ESM': "export * from './own.js';\nexport { x } from './cdp/thing.js';\n",
    'CJS': "module.exports = { ...require('./own.js'), ...require('./cdp/thing') };\n",
  })) {
    const r = judge({ ...own, 'index.js': src }, withBarrel);
    assert.equal(r.status, 0, `${what} local barrel must PASS; got ${r.status}\n${r.stderr}`);
  }
  for (const [what, src] of Object.entries({
    'defines a function': "export * from './own.js';\nexport function extra() { return 1; }\n",
    're-exports a base SIBLING': `export * from './own.js';\nexport * from '${CDP}';\n`,
    'a bare specifier (fails closed)': "export * from './own.js';\nexport * from 'some-package';\n",
  })) {
    const r = judge({ ...own, 'index.js': src }, withBarrel);
    assert.equal(r.status, 1, `local index.js that ${what}: must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /lib\/index\.js <- lib\/index\.js/, what);
  }
});

test('⛔ an UNRELATED module sharing a generic base name FAILS — and the message says to rename it', () => {
  const r = judge({ 'registry.js': 'export function createRegistry() { return new Map(); }\n' },
    (vlib) => fs.writeFileSync(path.join(vlib, 'registry.js'),
      'export function createRegistry(C) { return { C, all: [] }; }\n'));
  assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /unrelated module that only shares a name with base's, rename it/);
});

test('⛔ byName is MULTI-VALUED: a shim of EITHER of two same-named base modules passes', () => {
  // A single-valued map keeps whichever module the walk reached last, so a shim
  // of the OTHER one goes red. Both arms run, so one of them catches that
  // whatever order the walk takes.
  /** @param {string} vlib */
  const twoUtils = (vlib) => {
    for (const d of ['a', 'z']) {
      fs.mkdirSync(path.join(vlib, d), { recursive: true });
      fs.writeFileSync(path.join(vlib, d, 'util.js'), `export const which = '${d}';\n`);
    }
  };
  for (const d of ['a', 'z']) {
    const r = judge({ 'util.js': `export * from '../vendor/base-webctl/lib/${d}/util.js';\n` }, twoUtils);
    assert.equal(r.status, 0, `a shim of lib/${d}/util.js must PASS; got ${r.status}\n${r.stderr}`);
  }
});

// ── no-revendor: the lexer fails CLOSED (re-review of generation 5) ──────────
//
// ⛔ THE FIRST LEXER FAILED OPEN. It read every `/` after `)`, `}` or `${` as
// division, so a regex holding a quote or a backtick opened a PHANTOM string or
// template: comment text became code (a fake specifier), real code vanished (a
// hidden `function` made a file "define nothing"), and a comment stayed in the
// content hash. Its own comment called that limit a false FAIL. ⇒ Every probe
// the re-review sent is an arm here, with the verdict it SHOULD get, verbatim.

/** The re-review's base: index → two modules. */
const PROBE_BASE = {
  'index.js': "export * from './cdp-client.js'; export * from './cdp-rewrite.js';\n",
  'cdp-rewrite.js': 'export function rewrite(){ return 2 }\n',
  'cdp-client.js': 'export function createCdpClient(){ return 1 }\n',
};

/**
 * Lay `local` (lib-relative -> source) beside a vendored `base`, run no-revendor,
 * clean up. @param {Record<string,string>} local @param {Record<string,string>} [base]
 */
function probe(local, base = PROBE_BASE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revendor-probe-'));
  try {
    for (const [root, files] of [[path.join(dir, 'vendor', 'base-webctl', 'lib'), base], [path.join(dir, 'lib'), local]]) {
      for (const [rel, src] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), src);
      }
    }
    return run(['no-revendor', '--repo', dir]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A same-named EDITED copy: it requires a base SIBLING, never its own module. */
const HEAD = "const { rewrite } = require('../vendor/base-webctl/lib/cdp-rewrite.js');\n"
  + 'function createCdpClient(){ return rewrite() + 41 }\n'
  + 'module.exports = { createCdpClient };\n';
const SAME = "require('../vendor/base-webctl/lib/cdp-client.js')";
const IDX = "require('../vendor/base-webctl/lib/index.js')";
const SPREAD = (/** @type {string} */ extra) => `module.exports = { ...${IDX}, ${extra} };\n`;

/** Each probe: [expected exit, source of lib/cdp-client.js]. */
const PROBES = {
  // a — prose that names the same module: never a specifier.
  a1: [1, `${HEAD.replace('{ createCdpClient };', `{ createCdpClient }; // forked from ${SAME}`)}`],
  a2: [1, `${HEAD}const note = "forked from ${SAME}";\n`],
  a3: [1, `${HEAD}/* forked from\n   ${SAME} */\n`],
  a4: [1, HEAD + 'const note = `forked from ' + SAME + ' ${1}`;\n'],
  a5: [1, HEAD + 'const note = `x ${"' + SAME + '"}`;\n'],
  // b — a regex where the old lexer saw division (b1–b4), and lexer controls (b5–b9).
  b1: [1, HEAD + "if (process.env.X) /'/.test('a') // ' ; " + SAME + '\n'],
  b2: [1, HEAD + "if (process.env.X) /`/.test('a') // ` ; " + SAME + ' /* `\n'],
  b3: [1, HEAD + "const s = `${/'/.test(k) ? 1 : 2}`; // ' ; " + SAME + '\n'],
  b4: [1, HEAD + "{ } /\"/.test('a') // \" ; " + SAME + '\n'],
  b5: [1, "const re = /['\"`]/g; const r2 = /\\/\\//;\n" + HEAD],
  b6: [1, 'const t = `${`${1}`}`;\n' + HEAD],
  b7: [1, '#!/usr/bin/env node\n' + HEAD],
  b8: [1, 'const u = import.meta.url;\n' + HEAD],
  b9: [1, 'const m = import(p);\n' + HEAD],
  // c — "defines nothing", so the barrel exception: only c1 and c9 own no logic.
  c0: [1, `const base = ${IDX};\nfunction q(s) { if (s.includes('x')) /[\`]/.test(s); return s; }\n`
    + 'function createCdpClient(url) { return base.rewrite(url) + 41; }\n'
    + "module.exports = { createCdpClient, label: `cdp ${q('a')}` };\n"],
  // c0b: NO prose at all — a backtick in a regex hid the function AND the class.
  c0b: [1, `const base = ${IDX};\nconst name = process.env.CDP_NAME || '';\n`
    + 'if (name) /[`]/.test(name) && console.log(name);\n'
    + 'function createCdpClient(url) { return base.rewrite(url) + 41; }\n'
    + 'class Session { send() { return 1; } }\nmodule.exports = { createCdpClient, Session, label: `cdp` };\n'],
  'c0b-control': [1, `const base = ${IDX};\nconst name = process.env.CDP_NAME || '';\n`
    + 'function createCdpClient(url) { return base.rewrite(url) + 41; }\n'
    + 'class Session { send() { return 1; } }\nmodule.exports = { createCdpClient, Session, label: `cdp` };\n'],
  c1: [0, `module.exports = { ...${IDX}.x, extra: 1 };\n`],
  c2: [1, SPREAD('f() { return 1 }')],
  c3: [1, SPREAD('f: function(){ return 1 }')],
  c4: [1, SPREAD('f: x => x')],
  c5: [1, SPREAD("['createCdpClient']() { return 42 }")],
  c6: [1, SPREAD("'createCdpClient'(u) { return 42 }")],
  c7: [1, SPREAD("createCdpClient: new Function('u', 'return 42')")],
  c8: [1, SPREAD("get ['x']() { return 42 }")],
  c9: [0, SPREAD('f: Math.max.bind(null, 41)')],
};

test('⛔ RE-REVIEW PROBES: every one gets the verdict it should — none passes by a misread', () => {
  for (const [id, [want, src]] of Object.entries(PROBES)) {
    const r = probe({ 'cdp-client.js': /** @type {string} */ (src) });
    assert.equal(r.status, want, `${id}: want exit ${want}, got ${r.status}\n${src}\n${r.stderr}`);
  }
});

test('⛔ h1: a COMMENT after a regex is stripped from the HASH, so a renamed copy is still a copy', () => {
  // The old lexer read `/'/` after `)` as division; the `'` opened a phantom
  // string that KEPT the comment, so changing the comment changed the hash.
  const r = probe({ 'other.js': "if (a) /'/.test(b) // ' different comment\nexport function z(){}\n" },
    { ...PROBE_BASE, 'cdp-rewrite.js': "if (a) /'/.test(b) // ' x\nexport function z(){}\n" });
  assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /lib\/other\.js <- lib\/cdp-rewrite\.js \(identical after normalisation\)/);
});

test('⛔ h1 after a `}`: a copy matching base under its SECOND reading only is still a copy', () => {
  // `{ } /'/…` forks. The first (division) reading keeps the comment, so the
  // copy's changed comment changes that hash; the regex reading strips it, and
  // matches. ⇒ Every reading's hash is compared, on both sides.
  const r = probe({ 'other.js': "{ } /'/.test(b) // ' different comment\nexport function z(){}\n" },
    { ...PROBE_BASE, 'cdp-rewrite.js': "{ } /'/.test(b) // ' x\nexport function z(){}\n" });
  assert.equal(r.status, 1, `must FAIL; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /lib\/other\.js <- lib\/cdp-rewrite\.js \(identical after normalisation\)/);
});

test('⛔ an AMBIGUOUS same-named file gets NO exception, and the FAIL names the line and the fix', () => {
  // `{ } /"/…` — a block then a regex, or an object then a division: undecidable
  // from tokens, so both readings are taken. One sees a require of the same
  // module (inside what is really a comment); they disagree ⇒ no shim excuse.
  const r = probe({ 'cdp-client.js': PROBES.b4[1] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /AMBIGUOUS at line 4/);
  assert.match(r.stderr, /assign the regex to a variable first/);
});

test('⭐ CONTROL: an ambiguous point whose two readings AGREE is judged normally', () => {
  // `{ } /x/.test('a')` reads as block+regex or object+division — but nothing
  // in it is a quote, a comment or a definition, so every derived fact agrees.
  const r = probe({ 'cdp-client.js': `module.exports = ${SAME};\n{ } /x/.test('a');\n` });
  assert.equal(r.status, 0, `a real shim must PASS; got ${r.status}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /AMBIGUOUS|more than one way/);
});

test('⭐ an ambiguous file NOT named like a base module still passes — and the reason names it', () => {
  const r = probe({ 'own.js': "{ } /\"/.test('a') // \" ;\nexport const mine = 1;\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /1 file\(s\) read more than one way \(lib\/own\.js line 1\)/);
});

test('⭐ CONTROL: a legitimate wrapper full of DIVISION and regex is not a false FAIL', () => {
  // Precision arms: each line is decided from tokens, so none of them forks.
  // Mutating the bracket stack, the `${` rule or `++` turns one of them red.
  const wrappers = {
    'division after a paren': `const base = ${SAME};\nconst mid = (a, b) => (a + b) / 2;\n`
      + 'const ratio = (mid(1, 3) - 1) / (2) / 3;\nmodule.exports = { ...base, mid, ratio };\n',
    'regex after if (…)': `const base = ${SAME};\n`
      + "function q(s) { if (s) /['\"]/.test(s) && console.log(s); return s; } // don't\n"
      + 'module.exports = { ...base, q };\n',
    'regex after ${': `const base = ${SAME};\nconst k = 'a';\n`
      + "const label = `${/'/.test(k) ? 'q' : ''}`;\nmodule.exports = { ...base, label };\n",
    'division after ++': `const base = ${SAME};\nlet n = 4;\nconst half = n++ / 2;\nmodule.exports = { ...base, half };\n`,
    'regex in a normal position': `const base = ${SAME};\nconst re = /['"\`]/g;\nmodule.exports = { ...base, re };\n`,
    // Here the division reading is VALID too (it keeps the comment), so reading
    // `)` both ways instead of deciding it would disagree and false-FAIL.
    'regex after if (…), apostrophe in a trailing comment': `const base = ${SAME};\n`
      + "if (process.env.Q) /'/.test('a') && console.log('x'); // it's\nmodule.exports = base;\n",
    // A `}` fork whose regex reading is fine and whose division reading opens a
    // string that cannot close on the line (and swallows the comment): invalid
    // JS, so it is dropped rather than counted as a disagreeing reading.
    'a fork with one invalid reading': `const base = ${SAME};\n`
      + "function f(s) { if (s) { s = 1 } /'/.test(s) && console.log(\"it's\"); } // x\n"
      + 'module.exports = { ...base, f };\n',
  };
  for (const [what, src] of Object.entries(wrappers)) {
    const r = probe({ 'cdp-client.js': src });
    assert.equal(r.status, 0, `${what}: a real wrapper must PASS; got ${r.status}\n${src}\n${r.stderr}`);
  }
});

test('⛔ HTML-like comments are read BOTH ways: a comment in CommonJS, code in an ES module', () => {
  // Node runs a .js CommonJS file as a script, where `<!--` and a line-leading
  // `-->` start a comment (Annex B). A specifier after one is NOT code there.
  for (const [what, src] of Object.entries({
    '<!--': `${HEAD}x <!-- ${SAME}\n`,
    '-->': `${HEAD}--> ${SAME}\n`,
  })) {
    const r = probe({ 'cdp-client.js': src });
    assert.equal(r.status, 1, `${what}: must FAIL; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /AMBIGUOUS at line 4/, what);
  }
});

test('⛔ "defines nothing" is not fooled by escapes or string-to-code routes', () => {
  // `\u0046unction` IS `Function` — escapes are legal in identifiers.
  for (const [what, extra] of Object.entries({
    'escaped Function': "f: new \\u0046unction('return 42')",
    'eval by string key': "f: globalThis['eval']('1')",
    'constructor chain': "f: [].constructor.constructor('return 42')",
    'data: import': "f: import('data:text/javascript,export default 42')",
    'computed import': "f: import('da' + 'ta:text/javascript,1')",
  })) {
    const r = probe({ 'cdp-client.js': SPREAD(extra) });
    assert.equal(r.status, 1, `${what}: must FAIL; got ${r.status}\n${r.stderr}`);
  }
  // …and an escaped `require` IS require: a real shim, so it passes.
  const r = probe({ 'cdp-client.js': `module.exports = \\u0072equire('../vendor/base-webctl/lib/cdp-client.js');\n` });
  assert.equal(r.status, 0, `an escaped require is a require; got ${r.status}\n${r.stderr}`);
});

// ── no-revendor: the final review (ASI regexes, line terminators, cost) ──────
//
// ⛔ Three more ways the lexer failed OPEN, each measured as a false PASS: a `/`
// after `break`/`continue`/`debugger` (and every other spot where ASI ends the
// statement — a label, an uninitialised binding, a module specifier, a prefix
// `++`) was read as division; a line comment ran to `\n` when node ends it at
// `\r`, U+2028 or U+2029 too; and a file with thousands of forks cost O(F²).

/**
 * Is `src` valid JavaScript to node? Every "must FAIL" arm below that claims node
 * reads it differently from the old lexer is checked here first — an arm node
 * rejects would prove nothing about a file node would run.
 * @param {string} src @param {string} [ext]
 */
function nodeAccepts(src, ext = '.js') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revendor-check-'));
  try {
    const f = path.join(dir, `probe${ext}`);
    fs.writeFileSync(f, src);
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    return { ok: r.status === 0, err: r.stderr || '' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A comment that the old lexer read as `'…'` + a require of the SAME module. */
const TAIL = "/'/.test('a') // ' ; " + SAME;
/** The ESM shape: an edited copy importing a SIBLING. */
const ESM_SIB = "import { rewrite } from '../vendor/base-webctl/lib/cdp-rewrite.js'";
const ESM_SAME = "export * from '../vendor/base-webctl/lib/cdp-client.js'";

/** [extension for node --check, source of lib/cdp-client.js] — each must FAIL. */
const ASI_ARMS = {
  'n9 break⏎/': ['.js', `${HEAD}for (const k of []) { break\n${TAIL}\n}\n`],
  'n10 continue⏎/': ['.js', `${HEAD}for (const k of []) { continue\n${TAIL}\n}\n`],
  'n11 debugger⏎/': ['.js', `${HEAD}debugger\n${TAIL}\n`],
  'extends /': ['.js', `${HEAD}class X extends /'/.constructor {} // ' ; ${SAME}\n`],
  'break label⏎/': ['.js', `${HEAD}l: for (;;) { break l\n${TAIL}\n}\n`],
  'let x⏎/': ['.js', `${HEAD}let w\n${TAIL}\n`],
  'var a = 1, b⏎/ (forked)': ['.js', `${HEAD}var u = 1, w\n${TAIL}\n`],
  'x⏎++/ (prefix)': ['.js', `${HEAD}let q = 1\n++/'/.lastIndex // ' ; ${SAME}\n`],
  "from '…'⏎/ (ESM)": ['.mjs', `${ESM_SIB}\n/'/.test('a') // ' ; ${ESM_SAME}\n`
    + 'export function createCdpClient(){ return rewrite() + 41 }\n'],
};

test('⛔ n9–n11: a `/` where ASI ends the statement is a REGEX — the require after it is a comment', () => {
  // Every arm is judged before asserting, so a regression names ALL it broke.
  /** @type {string[]} */
  const wrong = [];
  for (const [id, [ext, src]] of Object.entries(ASI_ARMS)) {
    const c = nodeAccepts(src, ext);
    assert.ok(c.ok, `${id}: the arm must be valid JS to node\n${src}\n${c.err}`);
    const r = probe({ 'cdp-client.js': src });
    if (r.status !== 1) wrong.push(`${id}: got ${r.status}`);
  }
  assert.deepEqual(wrong, [], `each must FAIL:\n${wrong.join('\n')}`);
});

/** Unicode whitespace / line terminators INSIDE what the old lexer took for an identifier. */
const UNICODE_WS_ARMS = {
  'break + U+2028 + /': ['.js', `${HEAD}for (const k of []) { break\u2028${TAIL}\n}\n`],
  'return + NBSP + /': ['.js', `${HEAD}function f() { return\u00a0/'/.test('a') // ' ; ${SAME}\n}\n`],
  'typeof + BOM + /': ['.js', `${HEAD}typeof\ufeff/'/.test('a') // ' ; ${SAME}\n`],
  'else + NBSP + /': ['.js', `${HEAD}if (0) {} else\u00a0/'/.test('a') // ' ; ${SAME}\n`],
  'a + U+2028 + ++/ (prefix)': ['.js', `${HEAD}let q = 1\u2028++/'/.lastIndex // ' ; ${SAME}\n`],
  'U+2028 + --> (HTML comment)': ['.js', `${HEAD}module.exports = 1\u2028--> ${SAME}\n`],
};

test('⛔ identifiers end at Unicode WHITESPACE and LINE TERMINATORS (NBSP, BOM, U+2028) — each FAILs', () => {
  // The identifier class once spanned \u0080+ and swallowed these, so `break`+NBSP was one
  // non-keyword word and the regex that followed was read as division (final re-review).
  /** @type {string[]} */
  const wrong = [];
  for (const [id, [ext, src]] of Object.entries(UNICODE_WS_ARMS)) {
    const c = nodeAccepts(src, ext);
    assert.ok(c.ok, `${id}: the arm must be valid JS to node\n${c.err}`);
    const r = probe({ 'cdp-client.js': src });
    if (r.status !== 1) wrong.push(`${id}: got ${r.status}`);
  }
  assert.deepEqual(wrong, [], `each must FAIL:\n${wrong.join('\n')}`);
});

test('CONTROL: Unicode IDENTIFIERS (café, π) and NBSP as plain whitespace in a real wrapper still PASS', () => {
  const src = `const base = ${SAME};\nconst café = 1, π = 3;\u00a0const w = (café + π) / 2;\nmodule.exports = { ...base, w };\n`;
  const c = nodeAccepts(src, '.js');
  assert.ok(c.ok, c.err);
  assert.equal(probe({ 'cdp-client.js': src }).status, 0);
});

test('⭐ CONTROL: the ASI rules leave real code alone — division after a label use, a binding, a postfix ++', () => {
  const wrappers = {
    'binding WITH an initializer': `const base = ${SAME};\nlet w = 6\n/ 2;\nmodule.exports = { ...base, w };\n`,
    'postfix ++ then division': `const base = ${SAME};\nlet n = 4;\nconst h = n++ / 2 / 1;\nmodule.exports = { ...base, h };\n`,
    'a break with no label, then code': `const base = ${SAME};\nfor (const k of []) { break }\nmodule.exports = base;\n`,
    'a real ESM shim after a specifier': `${ESM_SAME}\nexport const one = 6 / 3 / 2;\n`,
  };
  for (const [what, src] of Object.entries(wrappers)) {
    assert.ok(nodeAccepts(src, what.includes('ESM') ? '.mjs' : '.js').ok, `${what}: must be valid JS`);
    const r = probe({ 'cdp-client.js': src });
    assert.equal(r.status, 0, `${what}: a real wrapper must PASS; got ${r.status}\n${src}\n${r.stderr}`);
  }
});

/** A barrel re-export, then a definition the old lexer hid in the comment. */
const BARREL_THEN = (/** @type {string} */ eol) => `module.exports = { ...${IDX} }; // x${eol}`
  + `function createCdpClient(){ return 42 }${eol}module.exports.createCdpClient = createCdpClient;${eol}`;

test('⛔ n12/n13: a line comment ends at CR, U+2028 and U+2029 — the code after it is CODE', () => {
  /** @type {string[]} */
  const wrong = [];
  for (const [id, eol] of Object.entries({ 'n12 CR-only': '\r', 'n13 U+2028': '\u2028', 'U+2029': '\u2029' })) {
    const src = BARREL_THEN(eol);
    assert.ok(nodeAccepts(src).ok, `${id}: must be valid JS`);
    const r = probe({ 'cdp-client.js': src });
    if (r.status !== 1) wrong.push(`${id}: got ${r.status}`);
  }
  assert.deepEqual(wrong, [], `a barrel that DEFINES a function must FAIL:\n${wrong.join('\n')}`);
  // A line-leading `-->` after a CR is an HTML-like comment in CommonJS: forked.
  const html = `${HEAD}x = 1\r--> ${SAME}\n`;
  assert.ok(nodeAccepts(html).ok, '--> after CR: must be valid JS');
  const h = probe({ 'cdp-client.js': html });
  assert.equal(h.status, 1, `--> after CR: must FAIL; got ${h.status}\n${h.stderr}`);
  assert.match(h.stderr, /AMBIGUOUS at line 5/, 'the line count honours the CR');
  // A string ends (unterminated) at CR: node rejects the file, so it is no barrel.
  const str = `module.exports = { ...${IDX} }; const s = 'x\rfunction createCdpClient(){}\r';\r`;
  assert.ok(!nodeAccepts(str).ok, 'a CR inside a quoted string is a syntax error to node');
  assert.equal(probe({ 'cdp-client.js': str }).status, 1, 'a string spanning a CR hides nothing');
});

test('⭐ CONTROL: a CRLF file is read exactly like an LF one', () => {
  const crlf = (/** @type {string} */ s) => s.replace(/\n/g, '\r\n');
  for (const [what, src] of Object.entries({
    'shim': `module.exports = ${SAME}; // shim\n`,
    'barrel': `module.exports = { ...${IDX} }; // x\nmodule.exports.y = 1;\n`,
    'string with a CRLF line continuation': `const s = 'a\\\nb'; // it's\nmodule.exports = ${SAME};\n`,
  })) {
    assert.ok(nodeAccepts(crlf(src)).ok, `${what}: must be valid JS`);
    const r = probe({ 'cdp-client.js': crlf(src) });
    assert.equal(r.status, 0, `${what} (CRLF): must PASS; got ${r.status}\n${r.stderr}`);
  }
  const r = probe({ 'cdp-client.js': crlf(`${HEAD}`) });
  assert.equal(r.status, 1, `an edited copy (CRLF) still FAILS; got ${r.status}`);
});

test('⛔ COST: 6000 forks on one line finish fast, in bounded memory, and the file is AMBIGUOUS', () => {
  // The review's file: 132 KB, 6000 forks, 91 s and 4.3 GB. Every `{}/x/g…`
  // forks (a block then a regex, or an object then a division).
  const src = `module.exports = ${SAME};\n${'if(a){}/x/g.test(b);'.repeat(6000)}\n`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revendor-cost-'));
  try {
    for (const [root, files] of [[path.join(dir, 'vendor', 'base-webctl', 'lib'), PROBE_BASE],
      [path.join(dir, 'lib'), { 'cdp-client.js': src }]]) {
      fs.mkdirSync(root, { recursive: true });
      for (const [rel, s] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), s);
    }
    // The child reports its own CPU time and PEAK resident memory: wall time on a
    // shared, loaded machine measures the machine, not the lexer.
    const pre = path.join(dir, 'usage.cjs');
    fs.writeFileSync(pre, "process.on('exit', () => { const u = process.resourceUsage();"
      + " process.stderr.write(`\\nUSAGE ${(u.userCPUTime + u.systemCPUTime) / 1000} ${u.maxRSS}\\n`); });\n");
    const r = spawnSync(process.execPath, ['--require', pre, TOOL, 'no-revendor', '--repo', dir],
      { cwd: ROOT, encoding: 'utf8' });
    const m = /USAGE ([\d.]+) (\d+)/.exec(r.stderr || '');
    assert.ok(m, `no usage line\n${r.stderr}`);
    const [cpuMs, rssKb] = [Number(m[1]), Number(m[2])];
    assert.equal(r.status, 1, `must FAIL (ambiguous, no exception); got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /AMBIGUOUS at line 2: it has more than 32 readings/);
    assert.ok(cpuMs < 3000, `took ${cpuMs} ms of CPU; the bound is 3000`);
    assert.ok(rssKb < 300 * 1024, `peak RSS ${Math.round(rssKb / 1024)} MB; the bound is 300 MB`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
