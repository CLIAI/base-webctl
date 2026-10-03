// gate-scratch.test.js — `--against-head --scratch` runs each consumer's COMMITTED
// state in a throwaway clone and NEVER writes the live working tree.
//
// Why the mode exists: the in-place arm checks base's candidate out INSIDE a
// consumer's live tree for the length of its contract, and some live trees are
// what unattended timers run from — a timer firing in the gate window ran an
// untested candidate.
//
// ⛔ FAKE consumers only, in temp dirs, through WEBCTL_CONSUMERS_FILE — never the
// fleet. ⛔ And a FAKE BASE too: --against-head refuses a dirty base, and the
// developer's tree is dirty while this file is being written. The gate is copied
// into a committed temp repo, so BASE_ROOT/BASE_HEAD are known and clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

/** @param {string[]} a @param {string} cwd */
const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * The fake consumer's contract. It reports what reached it, WRITES into its own
 * cwd (as real contracts do — build output, caches), and states which version of
 * itself is running. The exit code and extra output come from committed files.
 * @param {string} version
 */
const contract = (version) => `#!/usr/bin/env bash
echo "VERSION=${version}"
echo "PWD=$PWD"
echo "HOME=$HOME"
echo "BASE_DIR=$WEBCTL_BASE_DIR"
echo "DECLARED_PIN=$WEBCTL_DECLARED_PIN"
echo "SWAPPED=$WEBCTL_GATE_SWAPPED"
echo "SUB_HEAD=$(git -C vendor/base-webctl rev-parse HEAD)"
echo "ran" > gate-was-here.txt
if [ -n "\${FAKE_STARTED:-}" ]; then : > "$FAKE_STARTED"; sleep 30; fi
cat out.txt
exit "$(cat code.txt)"
`;

/**
 * A temp world: a committed fake base (carrying the real gate scripts), and one
 * fake consumer whose vendor/base-webctl is a nested repo committed as a gitlink.
 * @param {{output?: string, code?: number}} [o]
 */
function world(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-scratch-'));
  const base = path.join(dir, 'base');
  fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
  for (const f of ['test-all-consumers.sh', 'read-consumers.mjs', 'contract-harness.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(base, 'scripts', f));
  }
  fs.writeFileSync(path.join(base, '.gitignore'), 'tmp/\n');
  git(['init', '-q'], base); git(['add', '.'], base);
  git([...GIT_ID, 'commit', '-qm', 'fake base'], base);

  const repo = path.join(dir, 'fake-webctl');
  const sub = path.join(repo, 'vendor', 'base-webctl');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'README.md'), 'the pinned base\n');
  git(['init', '-q'], sub); git(['add', '.'], sub);
  git([...GIT_ID, 'commit', '-qm', 'pinned'], sub);
  fs.writeFileSync(path.join(repo, '.gitmodules'),
    `[submodule "vendor/base-webctl"]\n\tpath = vendor/base-webctl\n\turl = ${sub}\n`);
  fs.writeFileSync(path.join(repo, 'test-against-base.sh'), contract('committed'), { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'out.txt'), o.output ?? 'ok 1 - a\n# tests 1\n# pass 1\n# fail 0\n');
  fs.writeFileSync(path.join(repo, 'code.txt'), `${o.code ?? 0}\n`);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'gate-was-here.txt\n');
  git(['init', '-q'], repo); git(['add', '.'], repo);
  git([...GIT_ID, 'commit', '-qm', 'fake consumer'], repo);
  // initialised, as a real consumer's is — else `submodule status` prints `-` and
  // no pointer state is ever visible to the gate
  git(['submodule', 'init', '-q'], repo);

  const reg = path.join(dir, 'consumers.jsonc');
  fs.writeFileSync(reg, JSON.stringify({ consumers: [{
    name: 'fake-webctl', submodulePath: 'vendor/base-webctl', testCmd: './test-against-base.sh',
    tier: 'full', wired: true, localDir: repo,
  }] }));
  const tmp = path.join(dir, 'tmpdir');
  fs.mkdirSync(tmp);
  return {
    dir, base, repo, sub, tmp,
    baseHead: git(['rev-parse', 'HEAD'], base),
    pinned: git(['rev-parse', 'HEAD'], sub),
    consumerHead: git(['rev-parse', 'HEAD'], repo),
    /** @param {Record<string,string>} [extra] */
    env(extra = {}) {
      const e = { ...process.env, WEBCTL_CONSUMERS_FILE: reg, WEBCTL_CONSUMERS_DIR: dir, TMPDIR: tmp, ...extra };
      delete e.NODE_TEST_CONTEXT;
      return e;
    },
    /** @param {string[]} args @param {Record<string,string>} [extra] */
    gate(args, extra) {
      const r = spawnSync('bash', [path.join(base, 'scripts', 'test-all-consumers.sh'), ...args],
        { encoding: 'utf8', env: this.env(extra) });
      return { status: r.status, stdout: r.stdout || '', out: (r.stdout || '') + (r.stderr || '') };
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Every file under `root` — .git dirs INCLUDED (the index, the submodule's HEAD)
 * — as path -> mode/size/mtime/sha256. mtime catches a rewrite to identical bytes,
 * which is what an opportunistic index refresh by `git status` would be.
 * @param {string} root
 */
function snapshot(root) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} d */
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p);
      const st = fs.lstatSync(p);
      if (e.isDirectory()) { out[rel + '/'] = `dir ${st.mode}`; walk(p); continue; }
      const body = e.isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p);
      out[rel] = `${st.mode} ${st.size} ${st.mtimeMs} ${crypto.createHash('sha256').update(body).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}

/** @param {string} out @param {string} key */
const reported = (out, key) => (out.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1];

/** @param {string} stdout */
const envelopes = (stdout) => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('--scratch without --against-head is refused (exit 2), naming why', () => {
  const w = world();
  try {
    const r = w.gate(['--scratch']);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /--scratch requires --against-head/);
  } finally { w.cleanup(); }
});

test('⛔ scratch: the live tree — files, index, submodule HEAD — is byte-identical after the run', () => {
  const w = world();
  try {
    const before = snapshot(w.repo);
    const subHeadBefore = git(['rev-parse', 'HEAD'], w.sub);
    const r = w.gate(['--against-head', '--scratch']);
    // FIRST, so a sabotage that runs in the live tree is caught by THIS assertion
    // rather than by a side effect elsewhere (measured: it also trips the probe).
    assert.deepEqual(snapshot(w.repo), before, 'the live tree was written');
    assert.equal(git(['rev-parse', 'HEAD'], w.sub), subHeadBefore);
    assert.ok(!fs.existsSync(path.join(w.repo, 'gate-was-here.txt')));
    // POSITIVE CONTROL: the contract really ran, and it really writes into its cwd —
    // so an unchanged live tree is evidence, not the absence of a writer.
    assert.equal(r.status, 0, r.out);
    assert.equal(reported(r.out, 'VERSION'), 'committed', r.out);
    assert.match(r.out, /PASS {2}fake-webctl — tested [0-9a-f]{7} \(live tree clean\)/);
  } finally { w.cleanup(); }
});

test('⛔ scratch runs the COMMITTED contract — an uncommitted edit in the live tree is NOT what runs', () => {
  const w = world();
  try {
    // the live edit would FAIL; the committed contract PASSES
    fs.writeFileSync(path.join(w.repo, 'test-against-base.sh'), contract('uncommitted'), { mode: 0o755 });
    fs.writeFileSync(path.join(w.repo, 'code.txt'), '1\n');
    const before = snapshot(w.repo);
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 0, r.out);
    assert.equal(reported(r.out, 'VERSION'), 'committed', r.out);
    assert.doesNotMatch(r.out, /VERSION=uncommitted/);
    assert.match(r.out, new RegExp(`tested ${w.consumerHead.slice(0, 7)} \\(live tree has 2 uncommitted change\\(s\\) — NOT tested\\)`));
    assert.match(r.out, /uncommitted live changes NOT tested: fake-webctl \(2\)/);
    // a dirty tree no longer forces a SKIP in scratch mode …
    assert.doesNotMatch(r.out, /SKIP {2}fake-webctl/);
    // … and the dirty live tree was not touched either
    assert.deepEqual(snapshot(w.repo), before);
    // CONTROL: the in-place arm still SKIPs the same dirty tree, unchanged
    const inPlace = w.gate(['--against-head']);
    assert.equal(inPlace.status, 0, inPlace.out);
    assert.match(inPlace.out, /SKIP {2}fake-webctl \(full\) — working tree DIRTY \(2 files\)/);
  } finally { w.cleanup(); }
});

test('scratch: BASE_DIR / DECLARED_PIN / GATE_SWAPPED reach the contract, with a throwaway HOME', () => {
  const w = world();
  try {
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 0, r.out);
    const pwd = reported(r.out, 'PWD') || '';
    assert.ok(pwd.startsWith(path.join(w.tmp, 'webctl-gate-scratch-')), `ran in ${pwd}`);
    assert.notEqual(fs.realpathSync(w.repo), pwd);
    assert.equal(reported(r.out, 'BASE_DIR'), path.join(pwd, 'vendor', 'base-webctl'));
    assert.equal(reported(r.out, 'HOME'), `${pwd}-home`);
    // the declaration is the COMMITTED gitlink; the checkout in the clone is the candidate
    assert.equal(reported(r.out, 'DECLARED_PIN'), w.pinned);
    assert.equal(reported(r.out, 'SUB_HEAD'), w.baseHead);
    assert.equal(reported(r.out, 'SWAPPED'), '1');
    // validated-against names the candidate AND the scratch arm
    assert.match(r.out, new RegExp(`validated against: base HEAD .*\\(${w.baseHead}\\), in SCRATCH clones`));
    // the gate-probe ran IN THE CLONE, where the swap state exists
    assert.match(r.out, /PROBE fake-webctl — harness declined a verdict in the real swap window ✓/);
    assert.match(r.out, /harness gate-probe: ok=1 defect=0 no-verdict=0/);
  } finally { w.cleanup(); }
});

test('scratch: every scratch dir is removed — on PASS, on FAIL, and on a signal', async () => {
  for (const code of [0, 1]) {
    const w = world({ code, output: code ? 'boom\n' : undefined });
    try {
      assert.deepEqual(fs.readdirSync(w.tmp), []);
      const r = w.gate(['--against-head', '--scratch']);
      assert.equal(r.status, code, r.out);
      const pwd = reported(r.out, 'PWD') || '';
      assert.ok(pwd.startsWith(w.tmp), 'positive control: the scratch dir existed under TMPDIR');
      assert.ok(!fs.existsSync(pwd));
      assert.deepEqual(fs.readdirSync(w.tmp), [], `left behind (exit ${code})`);
    } finally { w.cleanup(); }
  }
  // SIGTERM to the gate's process group mid-contract: the trap still cleans up
  const w = world();
  try {
    const started = path.join(w.dir, 'started');
    const child = spawn('bash', [path.join(w.base, 'scripts', 'test-all-consumers.sh'), '--against-head', '--scratch'],
      { env: w.env({ FAKE_STARTED: started }), detached: true, stdio: 'ignore' });
    const done = new Promise((resolve) => child.on('exit', resolve));
    for (let i = 0; i < 200 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(started), 'the contract never started');
    assert.equal(fs.readdirSync(w.tmp).filter((f) => f.startsWith('webctl-gate-scratch-')).length, 1,
      'positive control: one scratch dir exists mid-run');
    process.kill(-(/** @type {number} */ (child.pid)), 'SIGTERM');
    await done;
    assert.deepEqual(fs.readdirSync(w.tmp).filter((f) => f.startsWith('webctl-gate-scratch-')), []);
  } finally { w.cleanup(); }
});

test('scratch: a hidden failure (exit 0 + TAP `not ok`) is a FAIL, reported exactly as in-place', () => {
  const output = 'not ok 1 - needs a fixture\nok 2 - survivor\n# tests 1\n# pass 1\n# fail 0\n';
  const s = world({ output, code: 0 });
  const p = world({ output, code: 0 });
  try {
    const rs = s.gate(['--against-head', '--scratch']);
    const rp = p.gate(['--against-head']);
    for (const r of [rs, rp]) {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /FAIL {2}fake-webctl \(exit 1\): exit 0, but the run REPORTED FAILURES/);
      assert.match(r.out, /not ok 1 - needs a fixture/);
      assert.match(r.out, /BLOCKED: fake-webctl failed against this base/);
    }
    // the envelopes carry the same shape and the same verdict and reason
    const [es] = envelopes(rs.stdout); const [ep] = envelopes(rp.stdout);
    assert.deepEqual(Object.keys(es), Object.keys(ep));
    assert.equal(es.result, 'fail'); assert.equal(es.result, ep.result);
    assert.equal(es.reason, ep.reason);
  } finally { s.cleanup(); p.cleanup(); }
});

test('scratch: a contract present ONLY as an uncommitted file is "not present" — committed state decides', () => {
  const w = world();
  try {
    git(['rm', '-q', '--cached', 'test-against-base.sh'], w.repo);
    git([...GIT_ID, 'commit', '-qm', 'drop contract from HEAD'], w.repo);
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /SKIP {2}fake-webctl \(full\) — contract '.\/test-against-base.sh' not present in committed HEAD/);
    assert.deepEqual(fs.readdirSync(w.tmp), []);
  } finally { w.cleanup(); }
});

test('scratch: a path committed as a plain directory, not a gitlink, is FAIL UNDECLARED', () => {
  const w = world();
  try {
    fs.rmSync(path.join(w.sub, '.git'), { recursive: true, force: true });
    git(['rm', '-q', '--cached', 'vendor/base-webctl'], w.repo);
    git(['add', 'vendor/base-webctl'], w.repo);
    git([...GIT_ID, 'commit', '-qm', 'vendor a copy'], w.repo);
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL {2}fake-webctl \(full\) — UNDECLARED: 'vendor\/base-webctl' is committed at [0-9a-f]{7} as a tree \(mode 040000\), not a gitlink/);
  } finally { w.cleanup(); }
});

test('scratch: a live tree with a DIRTY submodule pointer is reported, not tested, and not touched', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.sub, 'README.md'), 'moved\n');
    git([...GIT_ID, 'commit', '-qam', 'x'], w.sub); // checkout now != gitlink
    const before = snapshot(w.repo);
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOTE {2}fake-webctl — the LIVE tree's submodule pointer is DIRTY/);
    assert.equal(reported(r.out, 'DECLARED_PIN'), w.pinned, 'the committed gitlink is what is declared');
    assert.deepEqual(snapshot(w.repo), before);
    // CONTROL: in-place still FAILs the same state, unchanged
    const inPlace = w.gate(['--against-head']);
    assert.equal(inPlace.status, 1, inPlace.out);
    assert.match(inPlace.out, /FAIL {2}fake-webctl \(full\) — DIRTY SUBMODULE POINTER/);
  } finally { w.cleanup(); }
});

test('CONTROL: in-place --against-head is unchanged — it runs IN the live tree and restores the submodule', () => {
  const w = world();
  try {
    const r = w.gate(['--against-head']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^PASS {2}fake-webctl$/m, 'in-place PASS line carries no scratch note');
    assert.equal(reported(r.out, 'PWD'), w.repo);
    assert.equal(reported(r.out, 'BASE_DIR'), w.base);
    assert.equal(reported(r.out, 'SUB_HEAD'), w.baseHead, 'swapped in place during the contract');
    assert.equal(reported(r.out, 'SWAPPED'), '1');
    assert.doesNotMatch(r.out, /SCRATCH|scratch:/);
    assert.equal(git(['rev-parse', 'HEAD'], w.sub), w.pinned, 'restored after');
    // the in-place arm DOES write the live tree — the property scratch mode removes
    assert.ok(fs.existsSync(path.join(w.repo, 'gate-was-here.txt')));
    assert.match(r.out, /PROBE fake-webctl — harness declined a verdict in the real swap window ✓/);
  } finally { w.cleanup(); }
});
