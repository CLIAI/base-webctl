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

/**
 * Wait until \`pred()\` holds, polling; return its final value. A DEADLINE, not an iteration
 * count: a passing run returns the moment the condition holds, and only a run that will never
 * get there waits the full bound. ⚠ The bound is generous on purpose: under a heavy host load
 * (load average ~50–118 from other lanes' suites, measured) a contract inside \`isolated\` took
 * longer than the old 10 s to start, and the signal tests failed their own positive control.
 * @template T @param {() => T} pred @param {number} [ms]
 */
async function waitUntil(pred, ms = 120000) {
  const end = Date.now() + ms;
  let v = pred();
  while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, 50)); v = pred(); }
  return v;
}

/** @param {string[]} a @param {string} cwd */
const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * The fake consumer's contract. It reports what reached it, WRITES into its own
 * cwd (as real contracts do — build output, caches), and states which version of
 * itself is running. Optional behaviours are switched by FAKE_* variables — which the
 * tests name, and world().env() RENAMES to WEBCTL_TEST_FAKE_*, the name the contract reads.
 * ⛔ Why renamed: since v0.33.0 `isolated` passes an env ALLOWLIST, and the gate's production
 * call passes no `--pass-env` (it must not: a contract's secrets are the caller's env). The
 * WEBCTL_* prefix is default-passed, so the fakes reach the contract with the gate unchanged.
 * Without the rename the FAKE_* behaviours switched OFF under `--scratch` (measured: 7 tests red).
 * @param {string} version
 */
const contract = (version) => `#!/usr/bin/env bash
if [ -n "\${WEBCTL_TEST_FAKE_RAN:-}" ]; then : > "$WEBCTL_TEST_FAKE_RAN"; fi
echo "VERSION=${version}"
[ -f local-override.sh ] && . ./local-override.sh
echo "PWD=$PWD"
echo "HOME=$HOME"
echo "BASE_DIR=$WEBCTL_BASE_DIR"
echo "DECLARED_PIN=$WEBCTL_DECLARED_PIN"
echo "SWAPPED=$WEBCTL_GATE_SWAPPED"
echo "SUB_HEAD=$(git -C vendor/base-webctl rev-parse HEAD)"
echo "ran" > gate-was-here.txt
if [ -n "\${WEBCTL_TEST_FAKE_HOST_PORT:-}" ]; then
  node -e 'const s=require("net").connect(+process.env.WEBCTL_TEST_FAKE_HOST_PORT,"127.0.0.1");s.on("connect",()=>{console.log("NET=REACHED");s.destroy()});s.on("error",e=>console.log("NET=BLOCKED "+e.code))'
fi
# Markers go in the CWD (the scratch clone): \`isolated\` gives the contract a fresh
# /tmp, so a host /tmp path written from in here would never be seen outside.
if [ -n "\${WEBCTL_TEST_FAKE_PAUSE:-}" ]; then
  : > ./.fake-started
  for _ in $(seq 300); do [ -f ./.fake-go ] && break; sleep 0.1; done
fi
if [ -n "\${WEBCTL_TEST_FAKE_STARTED:-}" ]; then : > ./.fake-started; sleep 30; fi
if [ -n "\${WEBCTL_TEST_FAKE_DEPS:-}" ]; then if [ -f node_modules/dep/index.js ]; then echo DEPS=PRESENT; else echo DEPS=ABSENT; fi; fi
if [ -n "\${WEBCTL_TEST_FAKE_WRITE_HOME:-}" ]; then if : > "$HOME/.gate-home-probe" 2>/dev/null; then echo HOME=WRITABLE; else echo HOME=READONLY; fi; fi
if [ -n "\${WEBCTL_TEST_FAKE_WIPE_TMP:-}" ]; then c="$(cat code.txt)"; cat out.txt; rm -rf /tmp/* 2>/dev/null; exit "$c"; fi
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
      const renamed = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.startsWith('FAKE_') ? `WEBCTL_TEST_${k}` : k, v]));
      const e = { ...process.env, WEBCTL_CONSUMERS_FILE: reg, WEBCTL_CONSUMERS_DIR: dir, TMPDIR: tmp,
        WEBCTL_GATE_SCRATCH_DIR: tmp,
        WEBCTL_GATE_LOG_DIR: path.join(dir, 'gate-logs'), ...renamed };
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
    // ⭐ ib4k §4: the backend per consumer (its envelope) and the mix (the summary) — read from the
    // gate's own `isolated` verdict, nothing the consumer prints
    assert.match(r.out, /^----- isolation backends: unshare=1 -----$/m, r.out);
    assert.deepEqual(envelopes(r.stdout).filter((e) => e.type === 'consumer-test').map((e) => e.isolation), ['unshare']);
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
      await waitUntil(marker);
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
  // ⚠ v0.33.0: `isolated` takes unshare from the SYSTEM dirs or WEBCTL_UNSHARE_BIN — never PATH (a
  // fake first on PATH is exactly what it must ignore) — so the variants name it through the override
  const variants = /** @type {[string, (w: ReturnType<typeof world>) => string][]} */ ([
    // unshare present but refused (userns disabled shape)
    ['unshare refuses', (w) => {
      const fake = path.join(w.dir, 'fake-unshare');
      fs.writeFileSync(fake, '#!/bin/sh\necho "unshare: write failed /proc/self/uid_map: Operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
      return fake;
    }],
    // no usable unshare at all
    ['no unshare', (w) => path.join(w.dir, 'no-such-unshare')],
  ]);
  for (const [label, mkBin] of variants) {
    const w = world();
    try {
      const ran = path.join(w.dir, 'ran');
      const before = snapshot(w.repo);
      const r = w.gate(['--against-head', '--scratch'], { WEBCTL_UNSHARE_BIN: mkBin(w), FAKE_RAN: ran });
      assert.equal(r.status, 1, `${label}: ${r.out}`);
      assert.ok(!fs.existsSync(ran), `${label}: the consumer RAN although isolation was unavailable`);
      assert.match(r.out, /GATE-ENVIRONMENT {2}fake-webctl — NOT RUN: network isolation is unavailable/, label);
      assert.match(r.out, /isolated said: NOT RUN: /, `${label}: quotes the verb's own reason`);
      assert.match(r.out, /BLOCKED: GATE-ENVIRONMENT — fake-webctl NOT RUN/, label);
      assert.match(r.out, /gate-environment faults=1/, label);
      // named as the HOST's fault — not counted as a lane verdict of any kind
      assert.doesNotMatch(r.out, /^(FAIL|SKIP|PASS) {2}fake-webctl/m, label);
      assert.match(r.out, /gate summary: pass=0 skip=0 fail=0/, label);
      // ib4k §4: refused isolation is recorded as backend "none" in the mix
      assert.match(r.out, /^----- isolation backends: none=1 -----$/m, label);
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
      assert.ok(pwd.startsWith(w.tmp), 'positive control: the scratch dir existed under WEBCTL_GATE_SCRATCH_DIR');
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
    await waitUntil(started);
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

test('⛔ scratch: clones go OUTSIDE /tmp by default — lanes mask /tmp in their own sandboxes', { skip: NEEDS_NS }, () => {
  // Second real scratch run: three lanes that mask /tmp themselves could not see a clone
  // under /tmp ("Cannot find module …/repo/…"), and one asserts its repo is outside /tmp.
  const w = world();
  try {
    const cache = path.join(w.dir, 'xdg-cache');
    const r = w.gate(['--against-head', '--scratch'], { WEBCTL_GATE_SCRATCH_DIR: '', XDG_CACHE_HOME: cache });
    assert.equal(r.status, 0, r.out);
    const pwd = reported(r.out, 'PWD') || '';
    assert.ok(pwd.startsWith(path.join(cache, 'webctl-base', 'gate-scratch', 'webctl-gate-scratch-')), `ran in ${pwd}`);
    assert.ok(!pwd.startsWith(w.tmp), 'not under TMPDIR');
    assert.deepEqual(fs.readdirSync(path.join(cache, 'webctl-base', 'gate-scratch')), [], 'and it is removed after');
  } finally { w.cleanup(); }
});

test('scratch: the throwaway HOME stays WRITABLE when the scratch dir is under the read-only home (the default)', { skip: NEEDS_NS }, () => {
  // Final review, measured: \`isolated\` keeps a $HOME only under /tmp, so with the
  // scratch dir under the user's home (now the DEFAULT) the gate's throwaway HOME was
  // read-only and a contract writing $HOME (npm) went false red. A throwaway dir under
  // the real home, removed.
  const underHome = fs.mkdtempSync(path.join(os.homedir(), '.webctl-gate-test-'));
  const w = world();
  try {
    const r = w.gate(['--against-head', '--scratch'], { FAKE_WRITE_HOME: '1', WEBCTL_GATE_SCRATCH_DIR: underHome });
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
    await waitUntil(started);
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

test('⛔ scratch: Ctrl-C (INT to the process group) ends the gate by the signal — never a lane FAIL', { skip: NEEDS_NS }, async () => {
  // A REGRESSION GUARD, not proof of a fix. The final review reported an interrupt
  // turning into "FAIL fake-webctl … failed against this base". Re-measured: its probe
  // started the gate with SIGINT already IGNORED (bash does that to background jobs
  // of a script), so no trap could run. In the real shape the gate's INT trap fires.
  // This test passes against the harness from BEFORE the re-raise fix as well (checked
  // by hand). It pins the property: a human's interrupt is never a verdict about a lane.
  const w = world();
  try {
    let out = '';
    const child = spawn('bash', [path.join(w.base, 'scripts', 'test-all-consumers.sh'), '--against-head', '--scratch'],
      { env: w.env({ FAKE_STARTED: '1' }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const started = () => w.scratchDirs().some((d) => fs.existsSync(path.join(w.tmp, d, 'repo', '.fake-started')));
    await waitUntil(started);
    assert.ok(started(), 'positive control: the contract started');
    process.kill(-(/** @type {number} */ (child.pid)), 'SIGINT');
    const end = /** @type {{code: number|null, signal: string|null}} */ (await done);
    assert.ok(end.signal === 'SIGINT' || end.code === 130, `ended by INT, not ${JSON.stringify(end)}\n${out}`);
    assert.doesNotMatch(out, /FAIL {2}fake-webctl/, 'an interrupt is not reported as the lane failing');
    assert.doesNotMatch(out, /BLOCKED: fake-webctl failed/);
    assert.deepEqual(w.scratchDirs(), [], 'the scratch dir is still removed');
  } finally { w.cleanup(); }
});

test('⛔ scratch: an UNWRITABLE scratch root is a named setup FAIL — never a clone at the filesystem root', () => {
  // Final review: an unchecked mktemp left SCRATCH_TMP="", and the gate tried
  // \`mkdir -p /repo-home\` and \`git clone … /repo\`, reporting "git clone failed".
  const w = world();
  try {
    const ro = path.join(w.dir, 'ro-root');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o500);
    const r = w.gate(['--against-head', '--scratch'], { WEBCTL_GATE_SCRATCH_DIR: path.join(ro, 'sub') });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /SCRATCH SETUP FAILED: cannot create a scratch dir under .*ro-root\/sub/);
    assert.doesNotMatch(r.out, /git clone of the live repo failed/);
    fs.chmodSync(ro, 0o700);
  } finally { w.cleanup(); }
});

test('scratch: ORPHANED clones (their gate is gone) are pruned at start; a LIVE gate\'s clone and a fresh legacy one are kept', () => {
  // Final review: clones now live in ~/.cache, not /tmp, so a SIGKILLed gate's clone
  // (node_modules copy included) would stay forever.
  const w = world();
  try {
    const mk = (/** @type {string} */ name, /** @type {string|null} */ owner) => {
      const d = path.join(w.tmp, `webctl-gate-scratch-${name}`);
      fs.mkdirSync(path.join(d, 'repo'), { recursive: true });
      if (owner !== null) fs.writeFileSync(path.join(d, '.gate-owner'), owner);
      return d;
    };
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const myStart = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
    const dead = mk('DEAD01', '2147483646 1\n');               // no such pid
    const recycled = mk('RECY01', `${process.pid} 1\n`);        // a live pid, a different start time
    const live = mk('LIVE01', `${process.pid} ${myStart}\n`);   // this test process: alive
    const legacy = mk('LEGC01', null);                          // no owner record, fresh
    const r = w.gate(['--against-head', '--scratch']);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(dead), false, 'a dead gate\'s clone is pruned');
    assert.equal(fs.existsSync(recycled), false, 'a recycled pid does not keep a clone alive');
    assert.equal(fs.existsSync(live), true, 'CONTROL: a live gate\'s clone is never touched');
    assert.equal(fs.existsSync(legacy), true, 'CONTROL: a fresh clone with no owner record is kept');
    assert.match(r.out, /pruned an orphaned scratch clone \(its gate is gone\): webctl-gate-scratch-DEAD01/);
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
    // the envelopes carry the same shape and the same verdict and reason — plus, in scratch mode only,
    // the backend that isolated it (ib4k §4; in place nothing is isolated)
    const [es] = envelopes(rs.stdout); const [ep] = envelopes(rp.stdout);
    assert.deepEqual(Object.keys(es).filter((k) => k !== 'isolation'), Object.keys(ep));
    assert.equal(es.isolation, 'unshare');
    assert.equal(ep.isolation, undefined);
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

test('⛔ the per-consumer backend is the verdict\'s OWN `; backend:` clause (review F8): a keep path containing "; backend: docker" does not win — CONTROL: a plain verdict', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'test-all-consumers.sh'), 'utf8');
  const fn = src.match(/^isolation_backend_of\(\) \{\n[\s\S]*?\n\}\n/m);
  assert.ok(fn, 'scripts/test-all-consumers.sh defines no isolation_backend_of() { … } — the parse is not a testable unit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-backend-parse-'));
  const start = 'WEBCTL-GATE-CONTRACT-STARTED x';
  /** @param {string[]} lines */
  const parse = (lines) => {
    const log = path.join(dir, 'run.log');
    fs.writeFileSync(log, `${lines.join('\n')}\n`);
    return execFileSync('bash', ['-c', `${fn[0]}\nisolation_backend_of "$1" "$2"`, 'parse', log, start], { encoding: 'utf8' }).trim();
  };
  try {
    // a named keep under the home is listed BY PATH in the verdict, before the backend clause
    assert.equal(parse(['isolated: home HIDDEN; re-bound read-only: nothing; writable: ~/w/a; backend: docker; x; backend: unshare', start]), 'unshare');
    assert.equal(parse(['isolated: home HIDDEN; re-bound read-only: ~/r; backend: docker; writable: ~/w; backend: unshare (skipped x: y); keyring: unverified (keyctl show failed)', start]), 'unshare');
    // CONTROL: a plain verdict; the contract's own nested verdict AFTER the start line is not the gate's
    assert.equal(parse(['isolated: home HIDDEN; re-bound read-only: nothing; writable: nothing; backend: unshare', start,
      'isolated: home HIDDEN; re-bound read-only: nothing; writable: nothing; backend: docker']), 'unshare');
    assert.equal(parse([start]), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
