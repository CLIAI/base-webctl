// isolation-backend-select.test.js — which backend `isolated` uses, and why the others were not
// (ib4k §2, §4).
//
// ⛔ THE RULE: unshare → bwrap → docker → REFUSE, never unisolated. Probing is side-effect free and
// a probe failure is a RECORDED reason, never a crash. WEBCTL_ISOLATION_BACKEND pins one backend;
// a pinned backend that cannot be used is a REFUSAL naming why — never a silent fallback.
//
// v0.34 phase 1: only `unshare` is implemented. bwrap and docker answer "not implemented yet"
// as their reason, so a pin to either is refused and a host where unshare cannot run is refused
// naming all three.

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
  assert.match(r.stderr, /^isolated: home HIDDEN; .*; backend: unshare(?: —|$)/m);
  assert.doesNotMatch(r.stderr, /skipped/);
  // CONTROL: a successful run prints NO record of its own on stdout (the command's output is the output)
  assert.equal(r.stdout, '');
});

test('⭐ WEBCTL_ISOLATION_BACKEND=unshare pins the implemented backend → runs, verdict names it', needsNs, async () => {
  const r = await run(['isolated', '--', 'true'], { WEBCTL_ISOLATION_BACKEND: 'unshare' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /; backend: unshare(?: —|$)/m);
});

test('⛔ WEBCTL_ISOLATION_BACKEND=bwrap / docker (phase 1: not implemented) → REFUSED naming why, the command NOT run, no fallback to unshare', needsNs, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-select-'));
  try {
    for (const [b, phase] of [['bwrap', 2], ['docker', 3]]) {
      const marker = path.join(dir, `RAN-${b}`);
      const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        { WEBCTL_ISOLATION_BACKEND: String(b) });
      assert.equal(r.status, 1, `${b}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`^FAIL {2}isolated: NOT RUN: WEBCTL_ISOLATION_BACKEND pins the ${b} backend, which cannot be used here — `
        + `${b}: not implemented yet \\(v0\\.34 phase ${phase}\\) \\(a pinned backend never falls back`, 'm'));
      assert.doesNotMatch(r.stderr, /^isolated: home HIDDEN/m, `${b}: a verdict was printed, so something ran`);
      assert.equal(fs.existsSync(marker), false, `${b}: the command ran`);
      const rec = recordOf(r.stdout);
      assert.equal(rec?.backend, null);
      assert.deepEqual(rec?.skipped, [{ backend: b, why: `not implemented yet (v0.34 phase ${phase})` }]);
    }
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
  const r = await run(['isolated', '--', 'true'], { WEBCTL_UNSHARE_BIN: '/nonexistent/unshare' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: WEBCTL_UNSHARE_BIN must be an ABSOLUTE path to an EXECUTABLE regular file — it does not exist; no isolation backend can be used here — bwrap: not implemented yet \(v0\.34 phase 2\), docker: not implemented yet \(v0\.34 phase 3\) \(the command is never run unisolated\)/m);
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
    { env: cleanEnv({ WEBCTL_UNSHARE_BIN: fake }) });
    if (r.status === 97) { t.skip('SKIP (host): cannot fake the AppArmor sysctl in a throwaway namespace here'); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: HOST POLICY, not a fault of this lane: .*kernel\.apparmor_restrict_unprivileged_userns = 1.*\(1\) `sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0`.*\(2\) an AppArmor profile .*WEBCTL_UNSHARE_BIN=.*; no isolation backend can be used here — bwrap: not implemented yet/);
    assert.equal(fs.existsSync(marker), false, 'the command ran');
    // CONTROL: the same fake WITHOUT the sysctl → the generic kernel reason, not HOST POLICY
    // (only where the HOST's sysctl is not 1 itself — then the control cannot be made here)
    let hostSysctl = '';
    try { hostSysctl = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim(); } catch { /* absent */ }
    if (hostSysctl === '1') { t.diagnostic('control not run: the host sysctl is 1'); return; }
    const c = await run(['isolated', '--', 'true'], { WEBCTL_UNSHARE_BIN: fake });
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
    const r = await run(['isolated', '--', 'true'], { WEBCTL_UNSHARE_BIN: fake });
    assert.equal(r.status, 1, r.stderr);
    // the lane's regex, verbatim
    assert.match(r.stderr, /NOT RUN: unshare exited 1/);
    assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: unshare exited 1 before the isolated side reported in — unprivileged user namespaces may be disabled \(kernel\.unprivileged_userns_clone \/ user\.max_user_namespaces\); unshare's own message, if any, is above; no isolation backend can be used here — bwrap: not implemented yet \(v0\.34 phase 2\), docker: not implemented yet \(v0\.34 phase 3\) \(the command is never run unisolated\)\. The command was NOT started\.$/m);
    // "unshare's own message … is above" stays TRUE: the probe's stderr is printed before the FAIL line
    assert.ok(r.stderr.indexOf('unshare: unshare failed: Operation not permitted') >= 0
      && r.stderr.indexOf('unshare: unshare failed: Operation not permitted') < r.stderr.indexOf('FAIL  isolated:'), r.stderr);
    const rec = recordOf(r.stdout);
    assert.equal(rec?.backend, null);
    assert.deepEqual(rec?.skipped.map((/** @type {{backend: string}} */ s) => s.backend), ['unshare', 'bwrap', 'docker']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
