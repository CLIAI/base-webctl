// gate-scratch.test.js — `--against-head --scratch` runs each consumer's COMMITTED
// state in a throwaway, NETWORK-ISOLATED clone and NEVER writes the live tree.
//
// Why the mode exists: the in-place arm checks base's candidate out INSIDE a
// consumer's live tree for the length of its contract, and some live trees are
// what unattended timers run from — a timer firing in the gate window ran an
// untested candidate. Why isolated: twice on 2026-10-03 consumer tests reached a
// live, signed-in browser on the host's loopback.
//
// ⛔ FAKE consumers only, in temp dirs, through WEBCTL_CONSUMERS_FILE — never the
// fleet. ⛔ And a FAKE BASE too: --against-head refuses a dirty base, and the
// developer's tree is dirty while this file is being written. The gate is copied
// into a committed temp repo, so BASE_ROOT/BASE_HEAD are known and clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

// A scratch run needs a user+network namespace. Where the host has none, the arms
// that need a RUN are skipped with this reason — the GATE-ENVIRONMENT arms below
// still run, and on such a host they are exactly what the gate reports.
const USERNS = spawnSync('unshare', ['-rn', 'true']).status === 0;
const NEEDS_NS = USERNS ? false : 'no unprivileged user+network namespaces on this host (unshare -rn true failed)';

/** @param {string[]} a @param {string} cwd */
const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * The fake consumer's contract. It reports what reached it, WRITES into its own
 * cwd (as real contracts do — build output, caches), and states which version of
 * itself is running. Optional behaviours are switched by FAKE_* variables, which
 * pass through the gate (and through `isolated`) like any caller env.
 * @param {string} version
 */
const contract = (version) => `#!/usr/bin/env bash
if [ -n "\${FAKE_RAN:-}" ]; then : > "$FAKE_RAN"; fi
echo "VERSION=${version}"
[ -f local-override.sh ] && . ./local-override.sh
echo "PWD=$PWD"
echo "HOME=$HOME"
echo "BASE_DIR=$WEBCTL_BASE_DIR"
echo "DECLARED_PIN=$WEBCTL_DECLARED_PIN"
echo "SWAPPED=$WEBCTL_GATE_SWAPPED"
echo "SUB_HEAD=$(git -C vendor/base-webctl rev-parse HEAD)"
echo "ran" > gate-was-here.txt
if [ -n "\${FAKE_HOST_PORT:-}" ]; then
  node -e 'const s=require("net").connect(+process.env.FAKE_HOST_PORT,"127.0.0.1");s.on("connect",()=>{console.log("NET=REACHED");s.destroy()});s.on("error",e=>console.log("NET=BLOCKED "+e.code))'
fi
# Markers go in the CWD (the scratch clone): \`isolated\` gives the contract a fresh
# /tmp, so a host /tmp path written from in here would never be seen outside.
if [ -n "\${FAKE_PAUSE:-}" ]; then
  : > ./.fake-started
  for _ in $(seq 300); do [ -f ./.fake-go ] && break; sleep 0.1; done
fi
if [ -n "\${FAKE_STARTED:-}" ]; then : > ./.fake-started; sleep 30; fi
if [ -n "\${FAKE_DEPS:-}" ]; then if [ -f node_modules/dep/index.js ]; then echo DEPS=PRESENT; else echo DEPS=ABSENT; fi; fi
if [ -n "\${FAKE_WRITE_HOME:-}" ]; then if : > "$HOME/.gate-home-probe" 2>/dev/null; then echo HOME=WRITABLE; else echo HOME=READONLY; fi; fi
if [ -n "\${FAKE_WIPE_TMP:-}" ]; then c="$(cat code.txt)"; cat out.txt; rm -rf /tmp/* 2>/dev/null; exit "$c"; fi
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
  fs.writeFileSync(path.join(repo, '.gitignore'), 'gate-was-here.txt\nnode_modules/\n');
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
  const script = path.join(base, 'scripts', 'test-all-consumers.sh');
  return {
    dir, base, repo, sub, tmp,
    baseHead: git(['rev-parse', 'HEAD'], base),
    pinned: git(['rev-parse', 'HEAD'], sub),
    consumerHead: git(['rev-parse', 'HEAD'], repo),
    /** @param {Record<string,string>} [extra] */
    env(extra = {}) {
      const e = { ...process.env, WEBCTL_CONSUMERS_FILE: reg, WEBCTL_CONSUMERS_DIR: dir, TMPDIR: tmp,
        WEBCTL_GATE_LOG_DIR: path.join(dir, 'gate-logs'), ...extra };
      delete e.NODE_TEST_CONTEXT;
      delete e.WEBCTL_HOST_NETNS;
      return e;
    },
    /** @param {string[]} args @param {Record<string,string>} [extra] */
    gate(args, extra) {
      const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: this.env(extra) });
      return { status: r.status, stdout: r.stdout || '', out: (r.stdout || '') + (r.stderr || '') };
    },
    /**
     * Async, so a listener in THIS process can accept while the gate runs.
     * @param {string[]} args @param {Record<string,string>} [extra]
     * @returns {Promise<{status: number|null, stdout: string, out: string}>}
     */
    gateAsync(args, extra) {
      return new Promise((resolve) => {
        const c = spawn('bash', [script, ...args], { env: this.env(extra) });
        let so = ''; let se = '';
        c.stdout.on('data', (d) => { so += d; });
        c.stderr.on('data', (d) => { se += d; });
        c.on('close', (status) => resolve({ status, stdout: so, out: so + se }));
      });
    },
    scratchDirs() { return fs.readdirSync(tmp).filter((f) => f.startsWith('webctl-gate-scratch-')); },
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

/**
 * The four facts the fleet manager named, read the way the gate must NOT write:
 * HEAD, the submodule's HEAD, `git status --porcelain`, and the index bytes.
 * @param {ReturnType<typeof world>} w
 */
function liveFacts(w) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const g = (/** @type {string[]} */ a, /** @type {string} */ cwd) =>
    execFileSync('git', a, { cwd, env, encoding: 'utf8' });
  return {
    head: g(['rev-parse', 'HEAD'], w.repo),
    subHead: g(['rev-parse', 'HEAD'], w.sub),
    status: g(['status', '--porcelain'], w.repo),
    index: crypto.createHash('sha256').update(fs.readFileSync(path.join(w.repo, '.git', 'index'))).digest('hex'),
  };
}

/** @param {string} out @param {string} key */
const reported = (out, key) => (out.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1];

/** @param {string} stdout */
const envelopes = (stdout) => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A PATH holding every executable of the current PATH EXCEPT the named ones. @param {string} dir @param {string[]} drop */
function pathWithout(dir, drop) {
  const bin = path.join(dir, 'bin-without');
  fs.mkdirSync(bin);
  for (const d of (process.env.PATH || '').split(':')) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (drop.includes(n) || fs.existsSync(path.join(bin, n))) continue;
      try { fs.symlinkSync(path.join(d, n), path.join(bin, n)); } catch { /* dup */ }
    }
  }
  return bin;
}

test('--scratch without --against-head is refused (exit 2), naming why', () => {
  const w = world();
  try {
    const r = w.gate(['--scratch']);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /--scratch requires --against-head/);
  } finally { w.cleanup(); }
});

test('⛔ scratch: the live tree — HEAD, submodule HEAD, porcelain, index, every file — is byte-identical, and the GATE says so', { skip: NEEDS_NS }, () => {
  const w = world();
  try {
    const before = snapshot(w.repo);
    const facts = liveFacts(w);
    const r = w.gate(['--against-head', '--scratch']);
    // FIRST, so a sabotage that runs in the live tree is caught by THIS assertion
    // rather than by a side effect elsewhere (measured: it also trips the probe).
    assert.deepEqual(snapshot(w.repo), before, 'the live tree was written');
    assert.deepEqual(liveFacts(w), facts);
    assert.ok(!fs.existsSync(path.join(w.repo, 'gate-was-here.txt')));
    // POSITIVE CONTROL: the contract really ran, and it really writes into its cwd —
    // so an unchanged live tree is evidence, not the absence of a writer.
    assert.equal(r.status, 0, r.out);
    assert.equal(reported(r.out, 'VERSION'), 'committed', r.out);
    assert.match(r.out, /PASS {2}fake-webctl — tested [0-9a-f]{7} \(= the live HEAD; no uncommitted tracked changes\)/);
    // the gate's OWN verification, in its summary
    assert.match(r.out, /live trees verified byte-identical=1 CHANGED=0; gate-environment faults=0/);
  } finally { w.cleanup(); }
});

test('⛔ the gate FAILS LOUDLY when a live tree changes during its scratch run (untracked file; submodule HEAD)', { skip: NEEDS_NS }, async () => {
  // A CONCURRENT WRITER on the host changes the live tree while the contract runs.
  // (A contract inside \`isolated\` can no longer reach a live tree under /tmp, but
  // real live trees live outside /tmp and /run and stay writable from inside, so the
  // fingerprint is still what catches a breach.) The contract pauses until we write.
  for (const [what, move] of /** @type {[string, (w: ReturnType<typeof world>) => void][]} */ ([
    ['STATUS', (w) => fs.writeFileSync(path.join(w.repo, 'stray.txt'), 'x\n')],
    ['SUBHEAD', (w) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q',
      '--allow-empty', '-m', 'moved'], { cwd: w.sub, stdio: 'ignore' })],
  ])) {
    const w = world();
    try {
      const run = w.gateAsync(['--against-head', '--scratch'], { FAKE_PAUSE: '1' });
      const marker = () => w.scratchDirs().map((d) => path.join(w.tmp, d, 'repo', '.fake-started')).find((f) => fs.existsSync(f));
      for (let i = 0; i < 400 && !marker(); i++) await new Promise((r) => setTimeout(r, 50));
      const m = marker();
      assert.ok(m, 'positive control: the contract started inside the scratch clone');
      move(w);
      fs.writeFileSync(path.join(path.dirname(m), '.fake-go'), '');
      const r = await run;
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /⛔ LIVE TREE CHANGED {2}fake-webctl/);
      assert.match(r.out, new RegExp(`> ${what} `), `names the moved fact (${what})`);
      assert.match(r.out, /CHANGED=1/);
      assert.match(r.out, /BLOCKED: the scratch run CHANGED the live tree of fake-webctl/);
      const err = envelopes(r.stdout).find((e) => e.type === 'error');
      assert.equal(err?.code, 'ELIVETREE');
      // the contract's own verdict is still reported (it passed) — the block is separate
      assert.match(r.out, /PASS {2}fake-webctl/);
    } finally { w.cleanup(); }
  }
});

test('⛔ scratch: uncommitted TRACKED changes → SKIP naming why; nothing is cloned and nothing runs', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.repo, 'test-against-base.sh'), contract('uncommitted'), { mode: 0o755 });
    fs.writeFileSync(path.join(w.repo, 'code.txt'), '1\n');
    const before = snapshot(w.repo);
    const ran = path.join(w.dir, 'ran');
    const r = w.gate(['--against-head', '--scratch'], { FAKE_RAN: ran });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /SKIP {2}fake-webctl \(full\) — live tree has 2 uncommitted tracked change\(s\) — the committed HEAD would be tested, not what runs; commit or stash first/);
    const [env] = envelopes(r.stdout);
    assert.equal(env.result, 'skip');
    assert.match(env.reason, /2 uncommitted tracked change\(s\)/);
    assert.ok(!fs.existsSync(ran), 'the contract must not run');
    assert.deepEqual(w.scratchDirs(), []);
    assert.deepEqual(snapshot(w.repo), before);
  } finally { w.cleanup(); }
});

test('⛔ scratch: UNTRACKED files do not count — and the live tree\'s files are NOT what runs', { skip: NEEDS_NS }, () => {
  const w = world();
  try {
    // An untracked file the committed contract WOULD pick up if it ran in the live tree.
    fs.writeFileSync(path.join(w.repo, 'local-override.sh'), 'echo "VERSION=uncommitted"; exit 1\n');
    const before = snapshot(w.repo);
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /VERSION=uncommitted/);
    assert.equal(reported(r.out, 'VERSION'), 'committed');
    assert.match(r.out, new RegExp(`PASS {2}fake-webctl — tested ${w.consumerHead.slice(0, 7)}`));
    assert.deepEqual(snapshot(w.repo), before);
    // CONTROL: in place, the same untracked file IS what runs — the property scratch removes
    const inPlace = w.gate(['--against-head']);
    assert.match(inPlace.out, /SKIP {2}fake-webctl \(full\) — working tree DIRTY \(1 files\)/,
      'in-place is unchanged: any dirt, untracked included, is a SKIP');
  } finally { w.cleanup(); }
});

test('scratch: BASE_DIR / DECLARED_PIN / GATE_SWAPPED reach the contract, with a throwaway HOME', { skip: NEEDS_NS }, () => {
  const w = world();
  try {
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 0, r.out);
    const pwd = reported(r.out, 'PWD') || '';
    assert.ok(pwd.startsWith(path.join(w.tmp, 'webctl-gate-scratch-')), `ran in ${pwd}`);
    assert.equal(reported(r.out, 'BASE_DIR'), path.join(pwd, 'vendor', 'base-webctl'));
    assert.equal(reported(r.out, 'HOME'), `${pwd}-home`);
    // the declaration is the COMMITTED gitlink; the checkout in the clone is the candidate
    assert.equal(reported(r.out, 'DECLARED_PIN'), w.pinned);
    assert.equal(reported(r.out, 'SUB_HEAD'), w.baseHead);
    assert.equal(reported(r.out, 'SWAPPED'), '1');
    assert.match(r.out, new RegExp(`validated against: base HEAD .*\\(${w.baseHead}\\), in SCRATCH clones`));
    // the gate-probe ran IN THE CLONE, where the swap state exists
    assert.match(r.out, /PROBE fake-webctl — harness declined a verdict in the real swap window ✓/);
    assert.match(r.out, /harness gate-probe: ok=1 defect=0 no-verdict=0/);
  } finally { w.cleanup(); }
});

test('⛔ scratch is NETWORK-ISOLATED: a fake HOST listener sees ZERO connections (control: in place reaches it)', { skip: NEEDS_NS }, async () => {
  const w = world();
  let conns = 0;
  const server = net.createServer((s) => { conns++; s.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  try {
    const port = String(/** @type {net.AddressInfo} */ (server.address()).port);
    const r = await w.gateAsync(['--against-head', '--scratch'], { FAKE_HOST_PORT: port });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NET=BLOCKED ECONNREFUSED/, 'positive control: the probe ran and tried');
    assert.equal(conns, 0, 'the host listener was reached from a scratch run');
    // CONTROL: the same contract, in place (not isolated), DOES reach it — so zero
    // above is the namespace, not a probe that cannot connect.
    const c = await w.gateAsync(['--against-head'], { FAKE_HOST_PORT: port });
    await new Promise((res) => setTimeout(res, 100));
    assert.match(c.out, /NET=REACHED/);
    assert.ok(conns >= 1, `control reached the listener (${conns})`);
  } finally { server.close(); w.cleanup(); }
});

test('⛔ isolation UNAVAILABLE → GATE-ENVIRONMENT fault, consumer NOT run, never a lane FAIL/SKIP, never the host network', () => {
  const variants = /** @type {[string, (w: ReturnType<typeof world>) => string][]} */ ([
    // unshare present but refused (userns disabled shape)
    ['unshare refuses', (w) => {
      const fake = path.join(w.dir, 'fake-bin');
      fs.mkdirSync(fake);
      fs.writeFileSync(path.join(fake, 'unshare'),
        '#!/bin/sh\necho "unshare: write failed /proc/self/uid_map: Operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
      return `${fake}:${process.env.PATH}`;
    }],
    // no unshare on PATH at all
    ['no unshare on PATH', (w) => pathWithout(w.dir, ['unshare'])],
  ]);
  for (const [label, mkPath] of variants) {
    const w = world();
    try {
      const ran = path.join(w.dir, 'ran');
      const before = snapshot(w.repo);
      const r = w.gate(['--against-head', '--scratch'], { PATH: mkPath(w), FAKE_RAN: ran });
      assert.equal(r.status, 1, `${label}: ${r.out}`);
      assert.ok(!fs.existsSync(ran), `${label}: the consumer RAN although isolation was unavailable`);
      assert.match(r.out, /GATE-ENVIRONMENT {2}fake-webctl — NOT RUN: network isolation is unavailable/, label);
      assert.match(r.out, /isolated said: NOT RUN: /, `${label}: quotes the verb's own reason`);
      assert.match(r.out, /BLOCKED: GATE-ENVIRONMENT — fake-webctl NOT RUN/, label);
      assert.match(r.out, /gate-environment faults=1/, label);
      // named as the HOST's fault — not counted as a lane verdict of any kind
      assert.doesNotMatch(r.out, /^(FAIL|SKIP|PASS) {2}fake-webctl/m, label);
      assert.match(r.out, /gate summary: pass=0 skip=0 fail=0/, label);
      const env = envelopes(r.stdout);
      assert.deepEqual(env.map((e) => e.type), ['error'], label);
      assert.equal(env[0].code, 'EGATEENV');
      assert.deepEqual(w.scratchDirs(), [], `${label}: scratch left behind`);
      assert.deepEqual(snapshot(w.repo), before, label);
    } finally { w.cleanup(); }
  }
});

test('scratch: every scratch dir is removed — on PASS, on FAIL, and on a signal', { skip: NEEDS_NS }, async () => {
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
    const child = spawn('bash', [path.join(w.base, 'scripts', 'test-all-consumers.sh'), '--against-head', '--scratch'],
      { env: w.env({ FAKE_STARTED: '1' }), detached: true, stdio: 'ignore' });
    const done = new Promise((resolve) => child.on('exit', resolve));
    const started = () => w.scratchDirs().some((d) => fs.existsSync(path.join(w.tmp, d, 'repo', '.fake-started')));
    for (let i = 0; i < 200 && !started(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(started(), 'the contract never started');
    assert.equal(w.scratchDirs().length, 1, 'positive control: one scratch dir exists mid-run');
    process.kill(-(/** @type {number} */ (child.pid)), 'SIGTERM');
    await done;
    assert.deepEqual(w.scratchDirs(), []);
  } finally { w.cleanup(); }
});

test('⛔ scratch: a contract that wipes /tmp still counts as RUN — the start proof is a log line, not a file', { skip: NEEDS_NS }, () => {
  // Final review: the start marker was a file in the scratch dir, so a contract running
  // `rm -rf /tmp/*` (inside, its fresh /tmp holds the kept scratch tree) deleted it, and a
  // contract that really ran was reported as a GATE-ENVIRONMENT fault.
  const w = world();
  try {
    const r = w.gate(['--against-head', '--scratch'], { FAKE_WIPE_TMP: '1' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PASS {2}fake-webctl/);
    assert.doesNotMatch(r.out, /GATE-ENVIRONMENT/);
    // the proof line never leaks into the reason the gate quotes
    assert.doesNotMatch(r.stdout, /WEBCTL-GATE-CONTRACT-STARTED/);
  } finally { w.cleanup(); }
  // control: a contract that FAILS after the wipe is still a lane FAIL, not a gate fault
  const f = world({ code: 1, output: 'boom\n' });
  try {
    const r = f.gate(['--against-head', '--scratch'], { FAKE_WIPE_TMP: '1' });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /FAIL {2}fake-webctl \(exit 1\):.* boom/);
    assert.doesNotMatch(r.out, /GATE-ENVIRONMENT/);
  } finally { f.cleanup(); }
});

test('scratch: the live tree\'s installed node_modules is COPIED into the clone (no network to install)', { skip: NEEDS_NS }, () => {
  // First real scratch run: a lane with npm dependencies failed every test with
  // "Cannot find package". The clone has no node_modules and the arm has no network.
  const w = world();
  try {
    const dep = path.join(w.repo, 'node_modules', 'dep');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = 1;\n');
    const r = w.gate(['--against-head', '--scratch'], { FAKE_DEPS: '1' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /DEPS=PRESENT/);
    assert.match(r.out, /deps: node_modules copied from the live tree/);
    // a COPY: the live dir is untouched and is not what the arm saw through a link
    assert.equal(fs.readFileSync(path.join(dep, 'index.js'), 'utf8'), 'module.exports = 1;\n');
  } finally { w.cleanup(); }
  // control: no node_modules in the live tree → none in the clone, and no deps line
  const c = world();
  try {
    const r = c.gate(['--against-head', '--scratch'], { FAKE_DEPS: '1' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /DEPS=ABSENT/);
    assert.doesNotMatch(r.out, /deps: node_modules/);
  } finally { c.cleanup(); }
});

test('scratch: the throwaway HOME stays WRITABLE even when TMPDIR is under the read-only home', { skip: NEEDS_NS }, () => {
  // Final review, measured: \`isolated\` keeps a $HOME only under /tmp, so with TMPDIR
  // under the user's home the gate's throwaway HOME was read-only and a contract
  // writing $HOME (npm) went false red. A throwaway dir under the real home, removed.
  const underHome = fs.mkdtempSync(path.join(os.homedir(), '.webctl-gate-test-'));
  const w = world();
  try {
    const r = w.gate(['--against-head', '--scratch'], { FAKE_WRITE_HOME: '1', TMPDIR: underHome });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /HOME=WRITABLE/);
  } finally { w.cleanup(); fs.rmSync(underHome, { recursive: true, force: true }); }
});

test('scratch: TERM to the gate\'s process group ends it BY the signal, and its log keeps the last lines', { skip: NEEDS_NS }, async () => {
  // Final review: the log tees died with the group, the gate exited 141 (SIGPIPE) and
  // gate.err stopped short. The tees now ignore TERM/HUP/INT and end at EOF.
  const w = world();
  try {
    const child = spawn('bash', [path.join(w.base, 'scripts', 'test-all-consumers.sh'), '--against-head', '--scratch'],
      { env: w.env({ FAKE_STARTED: '1' }), detached: true, stdio: 'ignore' });
    const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const started = () => w.scratchDirs().some((d) => fs.existsSync(path.join(w.tmp, d, 'repo', '.fake-started')));
    for (let i = 0; i < 200 && !started(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(started(), 'positive control: the contract started');
    process.kill(-(/** @type {number} */ (child.pid)), 'SIGTERM');
    const end = /** @type {{code: number|null, signal: string|null}} */ (await done);
    assert.ok(end.signal === 'SIGTERM' || end.code === 143, `ended by TERM, not ${JSON.stringify(end)}`);
    const logs = path.join(w.dir, 'gate-logs');
    const [run] = fs.readdirSync(logs);
    const err = fs.readFileSync(path.join(logs, run, 'gate.err'), 'utf8');
    assert.match(err, /RUN {3}fake-webctl/, 'the kept log has the run, up to the signal');
  } finally { w.cleanup(); }
});

test('scratch: a hidden failure (exit 0 + TAP `not ok`) is a FAIL, reported exactly as in-place', { skip: NEEDS_NS }, () => {
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

test('scratch: a contract present ONLY as an untracked file is "not present" — committed state decides', { skip: NEEDS_NS }, () => {
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

test('scratch: a DIRTY live submodule pointer is FAIL, as in place — not swallowed by the tracked-change SKIP', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.sub, 'README.md'), 'moved\n');
    git([...GIT_ID, 'commit', '-qam', 'x'], w.sub); // checkout now != gitlink
    const before = snapshot(w.repo);
    for (const args of [['--against-head', '--scratch'], ['--against-head']]) {
      const r = w.gate(args);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /FAIL {2}fake-webctl \(full\) — DIRTY SUBMODULE POINTER/, args.join(' '));
      assert.doesNotMatch(r.out, /uncommitted tracked change/);
    }
    assert.deepEqual(snapshot(w.repo), before);
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
    assert.doesNotMatch(r.out, /SCRATCH|scratch:|GATE-ENVIRONMENT/);
    assert.equal(git(['rev-parse', 'HEAD'], w.sub), w.pinned, 'restored after');
    // the in-place arm DOES write the live tree — the property scratch mode removes
    assert.ok(fs.existsSync(path.join(w.repo, 'gate-was-here.txt')));
    assert.match(r.out, /PROBE fake-webctl — harness declined a verdict in the real swap window ✓/);
  } finally { w.cleanup(); }
});
