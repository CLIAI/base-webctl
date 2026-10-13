// isolation-backend-select.test.js — which backend `isolated` uses, and why the others were not
// (ib4k §2, §4).
//
// ⛔ THE RULE: unshare → bwrap → docker → REFUSE, never unisolated. Probing is side-effect free and
// a probe failure is a RECORDED reason, never a crash. WEBCTL_ISOLATION_BACKEND pins one backend;
// a pinned backend that cannot be used is a REFUSAL naming why — never a silent fallback.
//
// v0.34.0 (unshare only): bwrap and docker answered "not implemented yet (v0.35.0)". v0.35.0 phase 2:
// bwrap has its probe and runner (ib4k §2a); phase 3: docker too (ib4k §3b). ⚠ A test that needs EVERY backend
// refused plants a remote DOCKER_HOST (NO_DOCKER): docker is then refused by name before any call, on a host
// with a daemon and the image as on one without — never "selected, and the command ran".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectBackend, ISOLATION_BACKENDS, userNamespaceRefusal } from '../scripts/contract-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');

/** @param {Record<string, string>} [extra] */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.WEBCTL_ISOLATION_BACKEND;
  for (const k of Object.keys(extra)) env[k] = extra[k];
  return env;
}

/** @param {string[]} argv @param {{env?: NodeJS.ProcessEnv, cwd?: string}} [o] */
function runRaw(argv, o = {}) {
  return /** @type {Promise<{status: number, stdout: string, stderr: string}>} */ (new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env: o.env || cleanEnv(), cwd: o.cwd || ROOT });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  }));
}
/** @param {string[]} args @param {Record<string, string>} [env] */
const run = (args, env = {}) => runRaw([process.execPath, TOOL, ...args], { env: cleanEnv(env) });

/** The `isolated` JSONL refusal record on stdout, or null. @param {string} out */
const recordOf = (out) => {
  const l = out.split('\n').find((x) => x.includes('"check":"isolated"'));
  return l ? JSON.parse(l) : null;
};

const NS_OK = spawnSync('unshare', ['-rnm', '--uts', '--ipc', '--pid', '--fork', 'true']).status === 0;
const needsNs = NS_OK ? {} : { skip: 'SKIP (host): unprivileged user namespaces unavailable here' };
const TOOL_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'];
const sysTool = (/** @type {string} */ n) => TOOL_DIRS.map((d) => path.join(d, n)).find((p) => fs.existsSync(p)) || '';
const BWRAP = sysTool('bwrap');
const MOUNT_BIN = sysTool('mount') || 'mount';
const BWRAP_OK = !!BWRAP && spawnSync(BWRAP, ['--unshare-user', '--uid', '0', '--gid', '0', '--cap-add', 'ALL', '--unshare-net', '--unshare-pid',
  '--as-pid-1', '--dev-bind', '/', '/', '--proc', '/proc', '--', sysTool('true') || '/bin/true']).status === 0;
const needsBwrap = !NS_OK ? needsNs : BWRAP_OK ? {} : { skip: `SKIP (host): ${BWRAP ? 'bwrap cannot make its namespaces here' : 'bwrap not installed'}` };

/** One bind per distinct real copy of `name` in the system dirs (merged-/usr: one). @param {string} src @param {string} name */
function overTool(src, name) {
  const reals = new Set();
  for (const d of TOOL_DIRS) { try { reals.add(fs.realpathSync(path.join(d, name))); } catch { /* absent */ } }
  return [...reals].map((r) => /** @type {[string, string]} */ ([src, r]));
}
/**
 * Run `argv` in a throwaway `unshare -rm`, after bind-mounting each [src, dst] — a FAKE tool where the
 * harness looks for it (the system dirs; never PATH). Nothing outside it changes. null: binds impossible.
 * @param {[string, string][]} binds @param {string[]} argv @param {NodeJS.ProcessEnv} [env]
 */
async function withBinds(binds, argv, env = cleanEnv()) {
  const r = await runRaw(['unshare', '-rm', '--propagation=private', 'sh', '-c',
    'm=$0; while [ "$1" != -- ]; do "$m" --bind "$1" "$2" || exit 97; shift 2; done; shift; exec "$@"',
    MOUNT_BIN, ...binds.flat(), '--', ...argv], { env });
  return r.status === 97 ? null : r;
}
const NO_BINDS = 'SKIP (host): cannot bind a fake tool in a throwaway `unshare -rm` here';
/** Docker refused by name on ANY host (ib4k §3a.1): a remote endpoint planted. TEST-NET, never contacted. */
const NO_DOCKER = { DOCKER_HOST: 'ssh://192.0.2.1' };
/** docker's skip reason under NO_DOCKER — or, on a host without the CLI, its absence. */
const DOCKER_SKIP = String.raw`docker: (?:DOCKER_HOST names another docker endpoint[^\n]*?|'docker' not found[^\n]*?)`;
/**
 * A fake `unshare` (for WEBCTL_UNSHARE_BIN) that FAILS the selection probe — `-rnm …`, printing the
 * EPERM a host that forbids user namespaces prints — and runs the real one for everything else (the
 * privilege drop: `-U --map-user …`). ⇒ unshare is skipped, and bwrap, which still drops through it, runs.
 * @param {string} dir
 */
function probeFailingUnshare(dir) {
  const fake = path.join(dir, 'fake-unshare');
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = -rnm ]; then echo "unshare: unshare failed: Operation not permitted" >&2; exit 1; fi\n`
    + `exec ${JSON.stringify(sysTool('unshare'))} "$@"\n`, { mode: 0o755 });
  return fake;
}

// ── logic: selectBackend ─────────────────────────────────────────────────────

/** probes in the real order with fixed answers, recording which were CALLED. @param {Record<string, string | Error>} ans */
function probes(ans) {
  /** @type {string[]} */ const called = [];
  return { called, list: ISOLATION_BACKENDS.map((name) => ({ name, probe: () => {
    called.push(name);
    const a = ans[name] ?? '';
    if (a instanceof Error) throw a;
    return a;
  } })) };
}

test('⭐ logic: the order is unshare → bwrap → docker, and the FIRST available one is used; nothing after it is probed', () => {
  assert.deepEqual([...ISOLATION_BACKENDS], ['unshare', 'bwrap', 'docker']);
  const p = probes({});
  const c = selectBackend(undefined, p.list);
  assert.deepEqual(c, { backend: 'unshare', skipped: [], refuse: '' });
  assert.deepEqual(p.called, ['unshare'], 'a later backend was probed although an earlier one is available');
  // CONTROL: with unshare unavailable the next one is used, and unshare's reason is RECORDED
  const q = probes({ unshare: 'EPERM (because)' });
  const d = selectBackend('', q.list);
  assert.equal(d.backend, 'bwrap');
  assert.deepEqual(d.skipped, [{ backend: 'unshare', why: 'EPERM (because)' }]);
  assert.deepEqual(q.called, ['unshare', 'bwrap']);
});

test('⛔ logic: no backend available → REFUSED naming EVERY backend and its reason; never "run unisolated"', () => {
  const c = selectBackend(undefined, probes({ unshare: 'u-why', bwrap: 'b-why', docker: 'd-why' }).list);
  assert.equal(c.backend, '');
  assert.deepEqual(c.skipped.map((s) => s.backend), ['unshare', 'bwrap', 'docker']);
  assert.match(c.refuse, /^no isolation backend can be used here — unshare: u-why; bwrap: b-why; docker: d-why \(the command is never run unisolated\)$/);
});

test('⛔ logic: a probe that THROWS is a recorded reason, never a crash — and the next backend is still tried', () => {
  const p = probes({ unshare: new Error('boom') });
  const c = selectBackend(undefined, p.list);
  assert.equal(c.backend, 'bwrap');
  assert.deepEqual(c.skipped, [{ backend: 'unshare', why: 'its probe failed (boom)' }]);
});

test('⛔ logic: a PINNED backend that cannot be used is a REFUSAL — no other backend is even probed (no silent fallback)', () => {
  const p = probes({ bwrap: 'not here' });
  const c = selectBackend('bwrap', p.list);
  assert.equal(c.backend, '');
  assert.deepEqual(p.called, ['bwrap'], 'another backend was probed for a pinned run');
  assert.match(c.refuse, /WEBCTL_ISOLATION_BACKEND pins the bwrap backend, which cannot be used here — bwrap: not here \(a pinned backend never falls back/);
  // CONTROL: pinned AND available → used, even when an earlier one would also work
  const q = probes({});
  assert.equal(selectBackend('docker', q.list).backend, 'docker');
  assert.deepEqual(q.called, ['docker']);
});

test('⛔ logic: a pin naming no backend is refused by RULE — the value is never printed', () => {
  const c = selectBackend('evil-$(id)', probes({}).list);
  assert.equal(c.backend, '');
  assert.match(c.refuse, /WEBCTL_ISOLATION_BACKEND must name one isolation backend — unshare, bwrap, docker — or be unset/);
  assert.doesNotMatch(c.refuse, /evil/);
});

test('⭐ logic: the AppArmor case keeps v0.33\'s HOST-POLICY text (the sysctl and both remedies) as the unshare reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const sysctl = path.join(dir, 'apparmor');
    fs.writeFileSync(sysctl, '1\n');
    const why = userNamespaceRefusal('unshare: write failed /proc/self/uid_map: Operation not permitted', sysctl);
    const c = selectBackend(undefined, probes({ unshare: why, bwrap: 'b', docker: 'd' }).list);
    assert.match(c.refuse, /unshare: HOST POLICY, not a fault of this lane: .*apparmor_restrict_unprivileged_userns = 1.*sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0.*WEBCTL_UNSHARE_BIN=/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── end to end: the verdict line, the JSONL record, the pin ─────────────────

test('⭐ the verdict line names the backend used: `backend: unshare` (nothing skipped before it)', needsNs, async () => {
  const r = await run(['isolated', '--', 'true']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^isolated: home HIDDEN; .*; backend: unshare; cgroup2: nsdelegate; machine-names: (?:passed|none \([^\n]*?\))(?: —|$)/m);
  assert.doesNotMatch(r.stderr, /skipped/);
  // CONTROL: a successful run prints NO record of its own on stdout (the command's output is the output)
  assert.equal(r.stdout, '');
});

test('⭐ WEBCTL_ISOLATION_BACKEND=unshare pins the implemented backend → runs, verdict names it', needsNs, async () => {
  const r = await run(['isolated', '--', 'true'], { WEBCTL_ISOLATION_BACKEND: 'unshare' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /; backend: unshare; cgroup2: nsdelegate; machine-names: (?:passed|none \([^\n]*?\))(?: —|$)/m);
});

test('⛔ WEBCTL_ISOLATION_BACKEND=docker where docker cannot be used (a remote endpoint planted) → REFUSED naming why, the command NOT run, no fallback to unshare', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const marker = path.join(dir, 'RAN-docker');
    const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      { WEBCTL_ISOLATION_BACKEND: 'docker', ...NO_DOCKER });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^FAIL {2}isolated: NOT RUN: WEBCTL_ISOLATION_BACKEND pins the docker backend, which cannot be used here — `
      + `${DOCKER_SKIP} \\(a pinned backend never falls back`, 'm'));
    assert.doesNotMatch(r.stderr, /^isolated: home HIDDEN/m, 'a verdict was printed, so something ran');
    assert.doesNotMatch(r.stderr + r.stdout, /192\.0\.2\.1/, 'the endpoint is printed');
    assert.equal(fs.existsSync(marker), false, 'the command ran');
    const rec = recordOf(r.stdout);
    assert.equal(rec?.backend, null);
    assert.deepEqual(rec?.skipped.map((/** @type {{backend: string}} */ s) => s.backend), ['docker']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ an unknown WEBCTL_ISOLATION_BACKEND → refused by rule (value not printed) — fresh AND nested', needsNs, async () => {
  const r = await run(['isolated', '--', 'true'], { WEBCTL_ISOLATION_BACKEND: 'zzz-unknown' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /NOT RUN: WEBCTL_ISOLATION_BACKEND must name one isolation backend — unshare, bwrap, docker — or be unset/);
  assert.doesNotMatch(r.stderr + r.stdout, /zzz-unknown/);
  // nested: the outer runs unpinned; the inner call sees the bad pin
  const n = await run(['isolated', '--', 'sh', '-c', 'WEBCTL_ISOLATION_BACKEND=zzz-unknown "$0" "$1" isolated -- true; echo "rc=$?"',
    process.execPath, TOOL]);
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, /^rc=1$/m);
  assert.match(n.stderr, /NOT RUN: WEBCTL_ISOLATION_BACKEND must name one isolation backend/);
  // CONTROL: a valid pin on the NESTED path selects nothing (it runs inside its outer call's sandbox)
  const v = await run(['isolated', '--', 'sh', '-c', 'WEBCTL_ISOLATION_BACKEND=unshare "$0" "$1" isolated -- true; echo "rc=$?"',
    process.execPath, TOOL]);
  assert.match(v.stdout, /^rc=0$/m, v.stderr);
});

test('⛔ unshare unavailable (a bad WEBCTL_UNSHARE_BIN) → REFUSED naming all three backends; the JSONL record lists each skip', async () => {
  const r = await run(['isolated', '--', 'true'], { WEBCTL_UNSHARE_BIN: '/nonexistent/unshare', ...NO_DOCKER });
  assert.equal(r.status, 1, r.stderr);
  // ⚠ bwrap is skipped for the SAME reason: its privilege drop runs that unshare too (ib4k §2a)
  assert.match(r.stderr, new RegExp(String.raw`^FAIL {2}isolated: NOT RUN: WEBCTL_UNSHARE_BIN must be an ABSOLUTE path to an EXECUTABLE regular file — it does not exist; no isolation backend can be used here — bwrap: WEBCTL_UNSHARE_BIN must be an ABSOLUTE path to an EXECUTABLE regular file — it does not exist \(bwrap's privilege drop runs it too\), ${DOCKER_SKIP} \(the command is never run unisolated\)`, 'm'));
  assert.doesNotMatch(r.stderr, /nonexistent/, 'the path is printed');
  const rec = recordOf(r.stdout);
  assert.equal(rec?.backend, null);
  assert.deepEqual(rec?.skipped.map((/** @type {{backend: string}} */ s) => s.backend), ['unshare', 'bwrap', 'docker']);
});

test('⛔ end to end: uid_map EPERM with the AppArmor sysctl at 1 → the unshare skip reason is v0.33\'s HOST-POLICY text; nothing run', needsNs, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const fake = path.join(dir, 'fake-unshare');
    fs.writeFileSync(fake, '#!/bin/sh\necho "unshare: write failed /proc/self/uid_map: Operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
    const marker = path.join(dir, 'RAN');
    // ⚠ the sysctl is FAKED in a throwaway `unshare -rm`: a tmpfs over /proc/sys/kernel holding it at 1
    const r = await runRaw(['unshare', '-rm', 'sh', '-c',
      'mount -t tmpfs fake /proc/sys/kernel || exit 97; echo 1 > /proc/sys/kernel/apparmor_restrict_unprivileged_userns || exit 97; exec "$@"',
      'sh', process.execPath, TOOL, 'isolated', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
    { env: cleanEnv({ WEBCTL_UNSHARE_BIN: fake, ...NO_DOCKER }) });
    if (r.status === 97) { t.skip('SKIP (host): cannot fake the AppArmor sysctl in a throwaway namespace here'); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: HOST POLICY, not a fault of this lane: .*kernel\.apparmor_restrict_unprivileged_userns = 1.*\(1\) `sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0`.*\(2\) an AppArmor profile .*WEBCTL_UNSHARE_BIN=.*; no isolation backend can be used here — bwrap: /);
    assert.equal(fs.existsSync(marker), false, 'the command ran');
    // CONTROL: the same fake WITHOUT the sysctl → the generic kernel reason, not HOST POLICY
    // (only where the HOST's sysctl is not 1 itself — then the control cannot be made here)
    let hostSysctl = '';
    try { hostSysctl = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim(); } catch { /* absent */ }
    if (hostSysctl === '1') { t.diagnostic('control not run: the host sysctl is 1'); return; }
    const c = await run(['isolated', '--', 'true'], { WEBCTL_UNSHARE_BIN: fake, ...NO_DOCKER });
    assert.equal(c.status, 1, c.stderr);
    assert.match(c.stderr, /NOT RUN: unshare exited 1 before the isolated side reported in/);
    assert.doesNotMatch(c.stderr, /HOST POLICY/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ v0.33\'s refusal text is KEPT (review F4): a fake WEBCTL_UNSHARE_BIN printing EPERM and exiting 1 → the perplexity lane\'s own regex `/NOT RUN: unshare exited 1/` still matches; the backend summary is APPENDED', async (t) => {
  let hostSysctl = '';
  try { hostSysctl = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim(); } catch { /* absent */ }
  if (hostSysctl === '1') { t.skip('SKIP (host): the AppArmor sysctl is 1 here — the refusal is HOST POLICY (its own arm)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const fake = path.join(dir, 'fake-unshare');
    fs.writeFileSync(fake, '#!/bin/sh\necho "unshare: unshare failed: Operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
    const r = await run(['isolated', '--', 'true'], { WEBCTL_UNSHARE_BIN: fake, ...NO_DOCKER });
    assert.equal(r.status, 1, r.stderr);
    // the lane's regex, verbatim
    assert.match(r.stderr, /NOT RUN: unshare exited 1/);
    // ⚠ bwrap (v0.35.0) is skipped too: its probe runs the privilege drop — this fake unshare — inside bwrap
    assert.match(r.stderr, new RegExp(String.raw`^FAIL {2}isolated: NOT RUN: unshare exited 1 before the isolated side reported in — unprivileged user namespaces may be disabled \(kernel\.unprivileged_userns_clone \/ user\.max_user_namespaces\); unshare's own message, if any, is above; no isolation backend can be used here — bwrap: [^\n]*, ${DOCKER_SKIP} \(the command is never run unisolated\)\. The command was NOT started\.$`, 'm'));
    // "unshare's own message … is above" stays TRUE: the probe's stderr is printed before the FAIL line
    assert.ok(r.stderr.indexOf('unshare: unshare failed: Operation not permitted') >= 0
      && r.stderr.indexOf('unshare: unshare failed: Operation not permitted') < r.stderr.indexOf('FAIL  isolated:'), r.stderr);
    const rec = recordOf(r.stdout);
    assert.equal(rec?.backend, null);
    assert.deepEqual(rec?.skipped.map((/** @type {{backend: string}} */ s) => s.backend), ['unshare', 'bwrap', 'docker']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ a selected backend with NO RUNNER is refused (review F7) — never run on another backend\'s runner under its name: a mutant whose docker probe passes', needsNs, async () => {
  // the MUTANT: a copy of the harness (in a scratch tree, so its SELF_ROOT is the copy's) whose docker
  // probe answers '' — the state phase 3 will be in between "probe lands" and "runner lands"
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-norunner-'));
  try {
    fs.mkdirSync(path.join(tree, 'scripts'));
    const src = fs.readFileSync(TOOL, 'utf8');
    // phase 3: the docker runner landed — the mutant REMOVES it again, so its probe passes with no runner behind it
    const mutant = src.replace("{ name: 'docker', probe: () => { dcli = dockerCli(dockerBin); return probeDocker(dcli, dseen); } }", "{ name: 'docker', probe: () => '' }")
      .replace("  if (choice.backend === 'docker') {\n    // the unshare probe's own message", "  if (false) {\n    // the unshare probe's own message");
    assert.notEqual(mutant, src, 'the mutation did not apply — the probe list changed shape');
    assert.ok(mutant.includes("  if (false) {\n    // the unshare probe's own message"), 'the mutation did not remove the docker runner');
    const tool = path.join(tree, 'scripts', 'contract-harness.mjs');
    fs.writeFileSync(tool, mutant);
    const marker = path.join(tree, 'RAN');
    const r = await runRaw([process.execPath, tool, 'isolated', '--keep', tree, '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { env: cleanEnv({ WEBCTL_ISOLATION_BACKEND: 'docker' }) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: internal: backend docker has no runner yet — backend: docker\. The command was NOT started\.$/m);
    assert.doesNotMatch(r.stderr, /^isolated: home HIDDEN/m, 'a verdict was printed, so something ran');
    assert.equal(fs.existsSync(marker), false, 'the command ran (on another backend\'s runner, named docker)');
    const rec = recordOf(r.stdout);
    assert.equal(rec?.backend, null);
    assert.deepEqual(rec?.skipped, []);
  } finally { fs.rmSync(tree, { recursive: true, force: true }); }
});

// ── v0.35.0 phase 2: bwrap (ib4k §2a) ───────────────────────────────────────

/** The marker command: proves the command RAN (and nothing else). @param {string} marker */
const markerCmd = (marker) => [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];

test('⭐ WEBCTL_ISOLATION_BACKEND=bwrap → bwrap RUNS the command; the verdict names it (nothing skipped before a pin)', needsBwrap, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const marker = path.join(dir, 'RAN');
    const r = await run(['isolated', '--keep', dir, '--', ...markerCmd(marker)], { WEBCTL_ISOLATION_BACKEND: 'bwrap' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^isolated: home HIDDEN; .*; backend: bwrap; cgroup2: nsdelegate; machine-names: (?:passed|none \([^\n]*?\))(?: —|$)/m);
    assert.doesNotMatch(r.stderr, /skipped/);
    assert.equal(fs.existsSync(marker), true, 'the command did not run');
    assert.equal(r.stdout, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ unshare\'s probe FAILS (EPERM) → bwrap is selected and RUNS the command; the verdict says why unshare was skipped, and unshare\'s own message is above it', needsBwrap, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const marker = path.join(dir, 'RAN');
    const r = await run(['isolated', '--keep', dir, '--', ...markerCmd(marker)], { WEBCTL_UNSHARE_BIN: probeFailingUnshare(dir) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^isolated: home HIDDEN; .*; backend: bwrap \(skipped unshare: unshare exited 1 before the isolated side reported in — [^\n]*\); cgroup2: nsdelegate; machine-names: (?:passed|none \([^\n]*?\))(?: —|$)/m);
    // "unshare's own message, if any, is above" stays TRUE on this path too
    const own = r.stderr.indexOf('unshare: unshare failed: Operation not permitted');
    assert.ok(own >= 0 && own < r.stderr.indexOf('isolated: home HIDDEN'), r.stderr);
    assert.equal(fs.existsSync(marker), true, 'the command did not run');
    // CONTROL: the same host, the real unshare → unshare, nothing skipped
    const c = await run(['isolated', '--', 'true']);
    assert.match(c.stderr, /; backend: unshare; /);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ unshare fails AND bwrap is absent → REFUSED: unshare\'s v0.33 reason leads, then `bwrap: … not found …`, then docker; nothing run', needsNs, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const noexec = path.join(dir, 'noexec');
    fs.writeFileSync(noexec, '', { mode: 0o644 });
    const marker = path.join(dir, 'RAN');
    if (!BWRAP) { t.diagnostic('bwrap is not installed here: the bind is not even needed'); }
    const r = await withBinds(BWRAP ? overTool(noexec, 'bwrap') : [], [process.execPath, TOOL, 'isolated', '--', ...markerCmd(marker)],
      cleanEnv({ WEBCTL_UNSHARE_BIN: probeFailingUnshare(dir), ...NO_DOCKER }));
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(String.raw`^FAIL {2}isolated: NOT RUN: unshare exited 1 before the isolated side reported in — [^\n]*; no isolation backend can be used here — bwrap: 'bwrap' not found in \/usr\/sbin, \/usr\/bin, \/sbin, \/bin — install bubblewrap [^\n]*, ${DOCKER_SKIP} \(the command is never run unisolated\)\. The command was NOT started\.$`, 'm'));
    assert.equal(fs.existsSync(marker), false, 'the command ran');
    assert.deepEqual(recordOf(r.stdout)?.skipped.map((/** @type {{backend: string}} */ s) => s.backend), ['unshare', 'bwrap', 'docker']);
    // pinned: the pin's text, naming bwrap's reason — never a fallback to the unshare that works here
    const p = await withBinds(BWRAP ? overTool(noexec, 'bwrap') : [], [process.execPath, TOOL, 'isolated', '--', ...markerCmd(marker)],
      cleanEnv({ WEBCTL_ISOLATION_BACKEND: 'bwrap' }));
    assert.match(String(p?.stderr), /NOT RUN: WEBCTL_ISOLATION_BACKEND pins the bwrap backend, which cannot be used here — bwrap: 'bwrap' not found in/);
    assert.equal(fs.existsSync(marker), false, 'the command ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ F7: bwrap\'s privilege drop fails with WEBCTL_UNSHARE_BIN set → bwrap\'s part of the refusal says WHICH unshare: `(WEBCTL_UNSHARE_BIN)`; nothing run', needsBwrap, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    // fails unshare's probe (EPERM on -rnm) AND the drop inside bwrap (a too-old unshare: no --map-user)
    const fake = path.join(dir, 'old-unshare');
    fs.writeFileSync(fake, '#!/bin/sh\nif [ "$1" = -rnm ]; then echo "unshare: unshare failed: Operation not permitted" >&2; exit 1; fi\n'
      + 'for a in "$@"; do case "$a" in --map-user*) echo "unshare: unrecognized option \'$a\'" >&2; exit 1;; --) break;; esac; done\n'
      + `exec ${JSON.stringify(sysTool('unshare'))} "$@"\n`, { mode: 0o755 });
    const marker = path.join(dir, 'RAN');
    const r = await run(['isolated', '--keep', dir, '--', ...markerCmd(marker)], { WEBCTL_UNSHARE_BIN: fake, ...NO_DOCKER });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /; no isolation backend can be used here — bwrap: the privilege drop \(`setpriv … unshare -U --map-user`\) fails inside bwrap \([^\n]*\) — util-linux ≥ 2\.38 \(unshare --map-user\) is required \(WEBCTL_UNSHARE_BIN\), docker: /);
    assert.equal(fs.existsSync(marker), false, 'the command ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Pin bwrap with a FAKE bwrap over the system one (in a throwaway `unshare -rm`), and the real one
 * reachable at `<dir>/real-bwrap` — `$REAL` in `body` (the fake may exec it). The fake records every run
 * in `<dir>/fake-ran`. @param {string} dir @param {string} body the fake's shell body @param {number} [mode]
 */
async function withFakeBwrap(dir, body, mode = 0o755) {
  const real = path.join(dir, 'real-bwrap');
  fs.writeFileSync(real, '');
  const fake = path.join(dir, 'fake-bwrap');
  fs.writeFileSync(fake, `#!/bin/sh\necho ran >> ${JSON.stringify(path.join(dir, 'fake-ran'))}\n${body.split('$REAL').join(JSON.stringify(real))}\n`);
  fs.chmodSync(fake, mode);
  const marker = path.join(dir, 'RAN');
  const r = await withBinds([[BWRAP, real], ...overTool(fake, 'bwrap')], [process.execPath, TOOL, 'isolated', '--keep', dir, '--', ...markerCmd(marker)],
    cleanEnv({ WEBCTL_ISOLATION_BACKEND: 'bwrap' }));
  return { r, ran: fs.existsSync(marker), fakeRan: fs.existsSync(path.join(dir, 'fake-ran')) };
}

test('⛔ a SETUID bwrap is refused by RULE, before it is ever run (ib4k §2a) — CONTROL: the same fake without the bit is run', needsBwrap, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const { r, ran, fakeRan } = await withFakeBwrap(dir, 'exec $REAL "$@"', 0o4755);
    if (!r) { t.skip(NO_BINDS); return; }
    if (!(fs.statSync(path.join(dir, 'fake-bwrap')).mode & 0o4000)) { t.skip('SKIP (host): cannot set the setuid bit on a file here'); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: WEBCTL_ISOLATION_BACKEND pins the bwrap backend, which cannot be used here — bwrap: setuid — refused by rule/);
    assert.equal(fakeRan, false, 'the setuid bwrap was EXECUTED');
    assert.equal(ran, false, 'the command ran');
    const c = await withFakeBwrap(fs.mkdtempSync(path.join(dir, 'c-')), 'exec $REAL "$@"');
    assert.equal(c.r?.status, 0, `${c.r?.stdout}${c.r?.stderr}`);
    assert.equal(c.fakeRan && c.ran, true, 'control: the same fake without the setuid bit did not run the command');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ bwrap that cannot make its namespaces (the kernel\'s refusal) → REFUSED naming bwrap\'s own last line; nothing run', needsBwrap, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    const { r, ran } = await withFakeBwrap(dir, 'echo "bwrap: No permissions to create a new namespace, likely because the kernel does not allow '
      + 'non-privileged user namespaces." >&2; exit 1');
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /pins the bwrap backend, which cannot be used here — bwrap: bwrap exited 1 before the isolated side reported in \(bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces\.\)/);
    assert.equal(ran, false, 'the command ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ bwrap whose namespace root holds NO capability (as under Ubuntu\'s bwrap-userns-restrict) → REFUSED by the probe\'s mount, named; nothing run', needsBwrap, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    // the fake drops `--cap-add ALL` and execs the real bwrap with `--cap-drop ALL` (here the test runs as uid 0
    // of a throwaway namespace, where bwrap KEEPS every capability unless told to drop them): its namespaces
    // are made, its children are capless
    const { r, ran } = await withFakeBwrap(dir, 'n=$#; i=0; while [ $i -lt $n ]; do a=$1; shift; i=$((i+1)); '
      + 'if [ "$a" = --cap-add ]; then shift; i=$((i+1)); continue; fi; set -- "$@" "$a"; done; exec $REAL --cap-drop ALL "$@"');
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /pins the bwrap backend, which cannot be used here — bwrap: its namespace root cannot mount \(/);
    assert.equal(ran, false, 'the command ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
