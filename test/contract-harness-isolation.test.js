// contract-harness-isolation.test.js — mutation arms run with NO HOST NETWORK and
// NO HOST UNIX SOCKETS (see the "no host UNIX SOCKETS" section below).
//
// ⛔ INCIDENT (2026-10-02, a consumer lane's mutation control): a mutant re-derived
// the default port, the arm attached to the REAL signed-in browser on the host's
// loopback, closed its last tab, and Chromium exited. A mutant does not refuse.
//
// ⇒ These tests NEVER touch a real browser port. Every listener here is an
// ephemeral FAKE this file opens and closes itself.
//
// ⭐ The QA arm is paired with a CONTROL that runs the same mutant WITHOUT
// isolation and must reach the fake — otherwise "zero connections" could mean
// the mutant was broken, not that it was contained.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');

/** Env for spawned processes: never leak the parent test protocol. */
function cleanEnv(/** @type {Record<string,string>} */ extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Can this machine make an unprivileged user+network namespace AND bring its lo up?
 * Measured, not assumed. @returns {string} '' when yes, else the named reason to skip
 */
function isolationUnavailable() {
  // ⇩ the SAME namespaces `isolated` makes, plus one tmpfs mount — measured, not assumed.
  const r = spawnSync('unshare', ['-rnm', '--propagation=private', 'sh', '-c',
    '(ip link set lo up 2>/dev/null || ifconfig lo up) && mount -t tmpfs probe /tmp'],
  { encoding: 'utf8' });
  if (r.error) return `unshare not runnable here (${r.error.message})`;
  if (r.status !== 0) return `unprivileged user+net+mount namespaces or tmpfs mounts unavailable here: ${(r.stderr || '').trim()}`;
  return '';
}
const NO_ISOLATION = isolationUnavailable();
/** node:test skip option: a NAMED reason, never a silent pass. */
const needsIsolation = NO_ISOLATION ? { skip: `SKIP (isolation): ${NO_ISOLATION}` } : {};

/**
 * Run the harness ASYNC — a fake listener in this process must be able to
 * accept while the child runs. Never throws.
 * @param {string[]} args @param {Record<string,string>} [env] @param {string} [execPath]
 * @param {string} [cwd]
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function run(args, env = {}, execPath = process.execPath, cwd = ROOT) {
  return new Promise((resolve) => {
    const c = spawn(execPath, [TOOL, ...args], { cwd, env: cleanEnv(env) });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code, sig) => resolve({ status: code ?? (sig ? -1 : -1), stdout, stderr }));
  });
}

/**
 * A FAKE listener on host 127.0.0.1:<ephemeral>, counting connections.
 * @param {(s: net.Socket) => void} [onConn]
 */
async function fakeListener(onConn = (s) => s.destroy()) {
  let connections = 0;
  const srv = net.createServer((s) => { connections++; onConn(s); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (srv.address()).port;
  return {
    port,
    count: () => connections,
    close: () => new Promise((r) => srv.close(() => r(undefined))),
  };
}

/** A fake that answers `GET /json/version` with 200, like a CDP endpoint would. */
async function fakeCdp() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"Browser":"Fake/1.0"}');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (srv.address()).port;
  return { port, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r(undefined)); }) };
}

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-iso-')); }

/**
 * The MUTANT: connects to 127.0.0.1:<port> from argv — the shape of an arm that
 * re-derived the default port. Exit 0 = it reached something, 1 = it did not.
 */
const MUTANT = `
const net = require('node:net');
const s = net.connect(Number(process.argv[2]), '127.0.0.1');
s.on('connect', () => { console.log('MUTANT REACHED'); s.destroy(); process.exit(0); });
s.on('error', (e) => { console.log('MUTANT BLOCKED ' + e.code); process.exit(1); });
`;

function writeMutant(/** @type {string} */ dir) {
  const f = path.join(dir, 'mutant.cjs');
  fs.writeFileSync(f, MUTANT);
  return f;
}

/** Let any in-flight accept events land before counting. */
const settle = () => new Promise((r) => setTimeout(r, 150));

// ── isolated ─────────────────────────────────────────────────────────────────

test('⭐ QA: a mutant under `isolated` cannot reach a host listener — the fake sees ZERO', needsIsolation, async () => {
  const dir = tmpdir();
  const fake = await fakeListener();
  try {
    // --keep: the mutant lives under /tmp, which `isolated` masks.
    const r = await run(['isolated', '--keep', dir, '--', process.execPath, writeMutant(dir), String(fake.port)]);
    await settle();
    assert.equal(fake.count(), 0, `the host fake was reached from inside isolation:\n${r.stdout}${r.stderr}`);
    assert.equal(r.status, 1, `the mutant's connect must FAIL inside:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /MUTANT BLOCKED/);
  } finally { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ CONTROL: the SAME mutant without `isolated` reaches the fake (the QA arm can fail)', async () => {
  const dir = tmpdir();
  const fake = await fakeListener();
  try {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [writeMutant(dir), String(fake.port)], { env: cleanEnv() });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', (code) => resolve({ status: code, out }));
    });
    await settle();
    assert.equal(/** @type {any} */ (r).status, 0, /** @type {any} */ (r).out);
    assert.equal(fake.count(), 1, 'the control mutant must reach the fake, or the QA zero proves nothing');
  } finally { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isolated: the namespace\'s OWN loopback is up — a local listener + client work inside', needsIsolation, async () => {
  const dir = tmpdir();
  const script = path.join(dir, 'local.cjs');
  fs.writeFileSync(script, `
const net = require('node:net');
const srv = net.createServer((s) => { s.end('pong'); });
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1');
  let got = '';
  c.on('data', (d) => { got += d; });
  c.on('end', () => { console.log('LOCAL ' + got); srv.close(); process.exit(got === 'pong' ? 0 : 1); });
  c.on('error', (e) => { console.log('LOCAL FAIL ' + e.code); process.exit(1); });
});
`);
  try {
    const r = await run(['isolated', '--keep', dir, '--', process.execPath, script]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /LOCAL pong/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isolated: propagates the command\'s exit code (0 and 3), argv passed as an ARRAY', needsIsolation, async () => {
  const ok = await run(['isolated', '--', process.execPath, '-e', 'process.exit(0)']);
  assert.equal(ok.status, 0, ok.stderr);
  const three = await run(['isolated', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(three.status, 3, three.stderr);
  // No shell sees the command: a metacharacter arrives literally.
  const lit = await run(['isolated', '--', process.execPath, '-e', 'console.log(process.argv[1])', '$(echo x); y']);
  assert.equal(lit.stdout.trim(), '$(echo x); y');
  // A successful run prints NOTHING of its own on stdout: the command's output is the output.
  assert.ok(!/contract-check/.test(ok.stdout + three.stdout + lit.stdout));
});

test('⛔ fail closed: no `unshare` on PATH → FAIL, reason printed, the command NOT run', async () => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  const emptyBin = path.join(dir, 'bin');
  fs.mkdirSync(emptyBin);
  try {
    const r = await run(['isolated', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { PATH: emptyBin });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: unshare could not be started/);
    assert.match(r.stdout, /"check":"isolated","result":"fail"/);
    assert.equal(fs.existsSync(marker), false, 'the command ran although isolation was unavailable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: an `unshare` that does NOT isolate → FAIL, command NOT run (the property is checked, not the exit)', async () => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // A fake `unshare`: drops its flags and execs the rest ON THE HOST.
  fs.writeFileSync(path.join(bin, 'unshare'),
    '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n', { mode: 0o755 });
  try {
    const r = await run(['isolated', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: still in the CALLER'S network namespace/);
    assert.equal(fs.existsSync(marker), false, 'the command ran on the host');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: neither `ip` nor `ifconfig` → FAIL naming it, command NOT run', needsIsolation, async () => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const realUnshare = spawnSync('sh', ['-c', 'command -v unshare'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(realUnshare, path.join(bin, 'unshare'));
  try {
    const r = await run(['isolated', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { PATH: bin });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot bring the namespace loopback up \(ip: not found; ifconfig: not found\)/);
    assert.equal(fs.existsSync(marker), false, 'the command ran without a working loopback');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: no `mount` → FAIL naming it, command NOT run (no socket masking, no run)', needsIsolation, async () => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const which = (/** @type {string} */ b) => spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(which('unshare'), path.join(bin, 'unshare'));
  fs.symlinkSync(which('ip') || which('ifconfig'), path.join(bin, which('ip') ? 'ip' : 'ifconfig'));
  try {
    const r = await run(['isolated', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { PATH: bin });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: cannot cover \/run with a fresh tmpfs: 'mount' not found/);
    assert.equal(fs.existsSync(marker), false, 'the command ran with the host\'s unix sockets unmasked');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the inner half refuses when called directly on the host (it is not a bypass)', async () => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  try {
    const r = await run(['__isolated-inner', 'net:[0]', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isolated: usage without `--` or without a command → exit 3', async () => {
  assert.equal((await run(['isolated'])).status, 3);
  assert.equal((await run(['isolated', '--'])).status, 3);
  assert.equal((await run(['isolated', 'true'])).status, 3);
});

// ── sandbox-port ─────────────────────────────────────────────────────────────

test('sandbox-port: returns a port with NOTHING listening (JSONL + human line; --bare = number)', async () => {
  const r = await run(['sandbox-port']);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout.trim());
  assert.equal(rec.check, 'sandbox-port');
  assert.equal(rec.result, 'pass');
  assert.ok(Number.isInteger(rec.port) && rec.port > 0);
  assert.match(r.stderr, /^PASS {2}sandbox-port: 127\.0\.0\.1:\d+/);
  // Assert the property ourselves rather than trusting the verb.
  const refused = await new Promise((resolve) => {
    const s = net.connect(rec.port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', (e) => resolve(/** @type {any} */ (e).code === 'ECONNREFUSED'));
  });
  assert.equal(refused, true, `something listens on the sandbox port ${rec.port}`);

  const bare = await run(['sandbox-port', '--bare']);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /^\d+\n$/);
  assert.equal((await run(['sandbox-port', 'junk'])).status, 3);
});

// ── guard-live-port ──────────────────────────────────────────────────────────

test('⛔ guard-live-port: a plain listener → REFUSED, naming listening=yes and CDP=no', async () => {
  const fake = await fakeListener();
  try {
    const r = await run(['guard-live-port', String(fake.port)]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`FAIL {2}guard-live-port: REFUSED 127\\.0\\.0\\.1:${fake.port} — listening: yes, CDP answering: no`));
    const rec = JSON.parse(r.stdout.trim());
    assert.equal(rec.listening, 'yes');
    assert.equal(rec.cdp, false);
  } finally { await fake.close(); }
});

test('⛔ guard-live-port: a fake answering /json/version → REFUSED, naming CDP=yes', async () => {
  const fake = await fakeCdp();
  try {
    const r = await run(['guard-live-port', String(fake.port)]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /REFUSED .* — listening: yes, CDP answering: yes/);
    assert.equal(JSON.parse(r.stdout.trim()).cdp, true);
  } finally { await fake.close(); }
});

test('guard-live-port: --pin-verified → PASS over a listener, still naming both facts', async () => {
  const fake = await fakeCdp();
  try {
    const r = await run(['guard-live-port', String(fake.port), '--pin-verified']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /PASS {2}guard-live-port: .* listening: yes, CDP answering: yes; proceeding ONLY because --pin-verified/);
  } finally { await fake.close(); }
});

test('guard-live-port: no listener → PASS; a bad port → usage', async () => {
  // A port we just held and released: nothing listens on it.
  const fake = await fakeListener();
  const port = fake.port;
  await fake.close();
  const r = await run(['guard-live-port', String(port)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /listening: no, CDP answering: no/);
  assert.equal((await run(['guard-live-port'])).status, 3);
  assert.equal((await run(['guard-live-port', '70000'])).status, 3);
  assert.equal((await run(['guard-live-port', 'abc'])).status, 3);
});

test('the new verbs are ADDITIVE: HARNESS_GENERATION stays at 5 (set by the no-revendor change; isolation adds none)', async () => {
  const r = await run(['generation']);
  assert.equal(JSON.parse(r.stdout.trim()).generation, 5);
});

// ── isolation-check: the precondition a lane runs INSIDE `isolated` ───────────

const HOST_NS = fs.readlinkSync('/proc/self/ns/net');

test('⭐ isolation-check under `isolated`: a HOST fake\'s port → ECONNREFUSED inside, control reachable → PASS', needsIsolation, async () => {
  const fake = await fakeListener();
  try {
    const r = await run(['isolated', '--', process.execPath, TOOL, 'isolation-check', String(fake.port)]);
    await settle();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`PASS {2}isolation-check: 127\\.0\\.0\\.1:${fake.port} → ECONNREFUSED`));
    const rec = JSON.parse(r.stdout.trim());
    assert.equal(rec.ports[0].error, 'ECONNREFUSED');
    assert.equal(rec.control, 'reachable');
    assert.equal(fake.count(), 0, 'the host fake was reached from inside');
  } finally { await fake.close(); }
});

test('⭐ CONTROL: isolation-check of that port WITHOUT `isolated` → FAIL, naming it REACHABLE', async () => {
  const fake = await fakeListener();
  try {
    const r = await run(['isolation-check', String(fake.port)]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${fake.port} is REACHABLE from here`));
    assert.match(r.stderr, /not provably inside a private network namespace/);
  } finally { await fake.close(); }
});

test('⛔ isolation-check asserts the EXACT errno: a netns with lo DOWN → FAIL naming ENETUNREACH', needsIsolation, async () => {
  // `unshare -rn` WITHOUT bringing lo up: "unreachable" here is not isolation-and-up.
  const fake = await fakeListener();
  try {
    const r = await new Promise((resolve) => {
      const c = spawn('unshare', ['-rn', process.execPath, TOOL, 'isolation-check', String(fake.port)],
        { env: cleanEnv({ WEBCTL_HOST_NETNS: HOST_NS }) });
      let stdout = ''; let stderr = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.stderr.on('data', (d) => { stderr += d; });
      c.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
    const res = /** @type {{status:number, stdout:string, stderr:string}} */ (r);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ENETUNREACH: the loopback is DOWN/);
    assert.match(res.stderr, /control listener on the namespace loopback is NOT reachable/);
    assert.equal(fake.count(), 0);
  } finally { await fake.close(); }
});

test('isolation-check: usage without ports or with a bad port → exit 3', async () => {
  assert.equal((await run(['isolation-check'])).status, 3);
  assert.equal((await run(['isolation-check', '0'])).status, 3);
  assert.equal((await run(['isolation-check', '80', 'x'])).status, 3);
});

// ── nesting: "already inside" is proven from the KERNEL, never from env ─────

const HOST_MNT = fs.readlinkSync('/proc/self/ns/mnt');

/**
 * Run `isolated -- <print a marker>` with WEBCTL_HOST_NETNS (and optionally
 * WEBCTL_HOST_MNTNS) set, optionally under a prefix (e.g. `unshare -r`).
 *
 * ⚠ The marker goes to STDOUT, not to a file: a prefix that masks /tmp would hide a
 * marker FILE from this test, and "no marker" would then pass whether or not it ran.
 * @param {string} recorded @param {string[]} [prefix] @param {string} [recordedMnt]
 * @param {Record<string,string>} [extraEnv]
 */
async function nestedAttempt(recorded, prefix = [], recordedMnt, extraEnv = {}) {
  const argv = [...prefix, process.execPath, TOOL, 'isolated', '--', process.execPath, '-e',
    'console.log("RAN-" + "MARKER")'];
  const env = cleanEnv({ WEBCTL_HOST_NETNS: recorded, ...(recordedMnt ? { WEBCTL_HOST_MNTNS: recordedMnt } : {}), ...extraEnv });
  if (!recordedMnt) delete env.WEBCTL_HOST_MNTNS;
  const r = /** @type {{status:number, stdout:string, stderr:string}} */ (await new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code, stdout, stderr }));
  }));
  return { ...r, ran: r.stdout.includes('RAN-MARKER') };
}

test('⛔ nesting: the marker set on the HOST (= the real host id) → refused rc 2, nothing run', async () => {
  const r = await nestedAttempt(HOST_NS);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED, nothing run/);
  assert.equal(r.ran, false, 'a host-set marker skipped isolation and ran the command');
});

test('⛔ nesting: a FABRICATED host id on the host → refused rc 2 (uid_map is the identity map), nothing run', async () => {
  const r = await nestedAttempt('net:[1]');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /uid_map is identity/);
  assert.equal(r.ran, false);
});

test('⛔ nesting: inside `unshare -r` (NO -n) with the recorded id = current netns → refused rc 2', needsIsolation, async () => {
  const r = await nestedAttempt(HOST_NS, ['unshare', '-r']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /EQUALS the recorded host one/);
  assert.equal(r.ran, false, 'a user namespace alone was accepted as network isolation');
});

test('⛔ nesting: `unshare -r` + a fabricated id that DIFFERS beats netns+uid_map — the interface fact refuses it', needsIsolation, async () => {
  // netns ≠ recorded ✓ (fabricated), uid_map mapped ✓ (user ns) — both of the first
  // two facts pass. Only "nothing but lo is visible" stands between this and the host.
  const r = await nestedAttempt('net:[1]', ['unshare', '-r']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /interface\(s\) besides 'lo' are visible/);
  assert.doesNotMatch(r.stderr, /EQUALS|uid_map is/, 'the first two NETWORK facts should have passed');
  assert.equal(r.ran, false);
});

// ── nesting: the old NET-ONLY namespace is no longer "inside" ────────────────

test('⛔ nesting: the OLD `unshare -rn` (no -m) + fabricated ids → refused rc 2 by the MOUNT fact alone, nothing run', needsIsolation, async () => {
  // Every NETWORK fact passes here: netns ≠ the fabricated id, uid_map mapped, only
  // 'lo' visible. This is exactly what generation-4 `isolated` made — and it leaves
  // every host path socket reachable. Only the tmpfs fact stands in the way.
  const r = await nestedAttempt('net:[1]', ['unshare', '-rn'], 'mnt:[1]');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no 'webctl-isolated' tmpfs on top of \/run, .*\/tmp/);
  assert.doesNotMatch(r.stderr, /EQUALS|uid_map is|interface\(s\) besides/, 'only the mount fact should have refused this');
  assert.equal(r.ran, false, 'a net-only namespace was accepted as no-host-sockets');
});

test('⛔ nesting: `unshare -rn` with the REAL host mount-ns id recorded → refused naming it EQUAL', needsIsolation, async () => {
  const r = await nestedAttempt('net:[1]', ['unshare', '-rn'], HOST_MNT);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the current mount namespace .* EQUALS the recorded host one/);
  assert.equal(r.ran, false);
});

test('⛔ nesting: `unshare -rnm` (a mount ns, NOTHING masked) + fabricated ids → refused by the tmpfs fact', needsIsolation, async () => {
  const r = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--propagation=private'], 'mnt:[1]');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no 'webctl-isolated' tmpfs on top of/);
  assert.doesNotMatch(r.stderr, /EQUALS/);
  assert.equal(r.ran, false, 'a fresh mount ns with the host /run and /tmp was accepted');
});

test('nesting CONTROL: a real nested `isolated` inside `isolated` proceeds WITHOUT unsharing again', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c',
    'readlink /proc/self/ns/net /proc/self/ns/mnt; "$0" "$1" isolated -- readlink /proc/self/ns/net /proc/self/ns/mnt',
    process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [outerNet, outerMnt, innerNet, innerMnt] = r.stdout.trim().split('\n');
  assert.notEqual(outerNet, HOST_NS, 'the outer level is not network-isolated');
  assert.notEqual(outerMnt, HOST_MNT, 'the outer level has no mount namespace');
  assert.equal(innerNet, outerNet, 'the nested call unshared AGAIN (or ran elsewhere)');
  assert.equal(innerMnt, outerMnt, 'the nested call made another mount namespace');
});

test('nesting: the kernel proof holds from inside the uid-mapped CHILD user namespace — and from a nested call\'s', needsIsolation, async () => {
  // The command's uid_map is now the child's (real uid → outer root, count 1), not the
  // outer `unshare -r` one; the netns, mntns and pidns facts are those of the outer level.
  // `isolation-check` runs kernelInsideProof at both levels: both must PASS.
  const r = await run(['isolated', '--', 'sh', '-c',
    'awk \'{print "MAPLINES", NR, ($3 == 1 ? "count1" : "other")}\' /proc/self/uid_map; '
    + '"$0" "$1" isolation-check 1 >/dev/null && echo "CHILD-PROOF ok"; '
    + '"$0" "$1" isolated -- "$0" "$1" isolation-check 1 >/dev/null && echo "NESTED-PROOF ok"',
    process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^MAPLINES 1 count1$/m, 'the command is not in a single-id child user namespace');
  assert.doesNotMatch(r.stdout, /^MAPLINES 2/m);
  assert.match(r.stdout, /^CHILD-PROOF ok$/m, `the kernel proof failed in the child namespace:\n${r.stderr}`);
  assert.match(r.stdout, /^NESTED-PROOF ok$/m, `the kernel proof failed under a nested call:\n${r.stderr}`);
});

// ── no host UNIX SOCKETS ─────────────────────────────────────────────────────
//
// ⛔ `unshare -rn` hides TCP listeners but not PATH unix sockets — they are files.
// Measured by the coordinator: inside it, docker.sock answered. ⇒ The guard LOGIC is
// tested with sockets THIS FILE creates; the host's real sockets are separate
// precondition arms that skip, by name, where absent. (A consumer's first version of
// such a test tripped on the host's own socket — a guard's test must not depend on
// the host it guards.)

/** Prints `OUTCOME <CONNECTED|errno>` for a connect to the unix socket in argv[1]. */
const UNIX_CONNECT = `
const s = require('node:net').connect({ path: process.argv[1] });
s.on('connect', () => { console.log('OUTCOME CONNECTED'); s.destroy(); });
s.on('error', (e) => console.log('OUTCOME ' + e.code));
`;
/** @param {string} out */
const outcomeOf = (out) => (out.match(/OUTCOME (\S+)/) || [])[1] || `none in: ${out}`;

/** A unix-socket server THIS test owns, counting connections. @param {string} p */
async function unixServer(p) {
  let connections = 0;
  const srv = net.createServer((s) => { connections++; s.destroy(); });
  await new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(p, () => resolve(undefined)); });
  return { count: () => connections, close: () => new Promise((r) => srv.close(() => r(undefined))) };
}

/** Run argv directly (no harness). @param {string[]} argv @param {{cwd?: string}} [o] */
function runRaw(argv, o = {}) {
  return /** @type {Promise<{status:number, stdout:string, stderr:string}>} */ (new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env: cleanEnv(), cwd: o.cwd });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  }));
}

test('⭐ QA: a self-made socket under an UNKEPT /tmp dir → ENOENT inside (the fresh /tmp has no such path); server sees ZERO', needsIsolation, async () => {
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  const srv = await unixServer(sock);
  try {
    const r = await run(['isolated', '--', process.execPath, '-e', UNIX_CONNECT, sock]);
    await settle();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // ENOENT, not ECONNREFUSED: the path itself is gone — /tmp is a fresh tmpfs.
    assert.equal(outcomeOf(r.stdout), 'ENOENT');
    assert.equal(srv.count(), 0, 'the host socket was reached from inside');
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ CONTROL: the same connect on the host → CONNECTED (the QA arm can fail)', async () => {
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  const srv = await unixServer(sock);
  try {
    const r = await runRaw([process.execPath, '-e', UNIX_CONNECT, sock]);
    await settle();
    assert.equal(outcomeOf(r.stdout), 'CONNECTED');
    assert.equal(srv.count(), 1);
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ MUTANT: the OLD `unshare -rn` form still reaches that socket → CONNECTED (why -n alone was not enough)', needsIsolation, async () => {
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  const srv = await unixServer(sock);
  try {
    const r = await runRaw(['unshare', '-rn', process.execPath, '-e', UNIX_CONNECT, sock]);
    await settle();
    assert.equal(outcomeOf(r.stdout), 'CONNECTED', 'the net-only namespace did not reach it — this arm no longer discriminates');
    assert.equal(srv.count(), 1);
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ a self-made socket in the KEPT cwd still answers before masking → covered with /dev/null → ECONNREFUSED; a file beside it reads', needsIsolation, async () => {
  // The cwd is re-exposed (it must be — the arm lives there) but it is NOT exempt:
  // a socket in it is connect-tested inside, and covered because it answers.
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  fs.writeFileSync(path.join(dir, 'data.txt'), 'kept');
  const srv = await unixServer(sock);
  try {
    const r = await run(['isolated', '--', process.execPath, '-e',
      `${UNIX_CONNECT}; console.log('READ ' + require('fs').readFileSync('data.txt', 'utf8'))`, sock],
    {}, process.execPath, dir);
    await settle();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // ECONNREFUSED: the path exists, but it is /dev/null now, not a socket.
    assert.equal(outcomeOf(r.stdout), 'ECONNREFUSED');
    assert.match(r.stdout, /READ kept/);
    assert.equal(srv.count(), 1, 'exactly ONE connect: the harness\'s own probe that found it open; the command\'s never landed');
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('`--keep` EXEMPTS its sockets: a self-made socket under an explicit keep → CONNECTED inside', needsIsolation, async () => {
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  const srv = await unixServer(sock);
  try {
    const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e', UNIX_CONNECT, sock]);
    await settle();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(outcomeOf(r.stdout), 'CONNECTED');
    assert.equal(srv.count(), 1, 'the harness probed an exempt socket, or the command did not reach it');
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CONTROL: a socket created INSIDE (server and client both inside, in the fresh /tmp) works', needsIsolation, async () => {
  const r = await run(['isolated', '--', process.execPath, '-e', `
const net = require('node:net'); const p = require('node:path').join(require('node:os').tmpdir(), 'in.sock');
const srv = net.createServer((s) => s.end('pong')).listen(p, () => {
  const c = net.connect({ path: p }); let got = '';
  c.on('data', (d) => { got += d; });
  c.on('end', () => { console.log('INSIDE ' + got + ' ' + p); srv.close(); });
  c.on('error', (e) => { console.log('INSIDE FAIL ' + e.code); srv.close(); });
});`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /INSIDE pong \/tmp\/in\.sock/);
  assert.equal(fs.existsSync('/tmp/in.sock'), false, 'the inside /tmp leaked onto the host');
});

/**
 * A HOST socket precondition arm: skip (named) unless the host has it AND it answers
 * here; then assert the exact errno inside — ENOENT when it lives under a masked
 * directory (the path is gone), ECONNREFUSED otherwise (covered with /dev/null).
 * @param {string} name @param {() => string} find
 */
function hostSocketArm(name, find) {
  test(`host precondition: ${name} → unreachable inside, exact errno`, needsIsolation, async (t) => {
    const p = find();
    if (!p) { t.skip(`SKIP (host): no ${name} on this host`); return; }
    const host = outcomeOf((await runRaw([process.execPath, '-e', UNIX_CONNECT, p])).stdout);
    if (host !== 'CONNECTED') { t.skip(`SKIP (host): ${name} exists but does not answer here (${host})`); return; }
    const real = fs.realpathSync(p);
    const masked = ['/run', '/tmp'].map((d) => fs.realpathSync(d)).some((d) => real.startsWith(`${d}/`));
    const want = masked ? 'ENOENT' : 'ECONNREFUSED';
    const r = await run(['isolated', '--', process.execPath, '-e', UNIX_CONNECT, p]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(outcomeOf(r.stdout), want, `${name}: on the host CONNECTED, inside must be ${want}`);
  });
}
hostSocketArm('the docker socket (/var/run/docker.sock)',
  () => (fs.existsSync('/var/run/docker.sock') ? '/var/run/docker.sock' : ''));
hostSocketArm('an X11 display socket (/tmp/.X11-unix/X*)', () => {
  try { const x = fs.readdirSync('/tmp/.X11-unix').find((f) => /^X\d+$/.test(f)); return x ? `/tmp/.X11-unix/${x}` : ''; } catch { return ''; }
});
hostSocketArm('the ssh-agent ($SSH_AUTH_SOCK)', () => process.env.SSH_AUTH_SOCK || '');

// ── env scrub ────────────────────────────────────────────────────────────────

const SCRUBBED = ['DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'DOCKER_HOST', 'XDG_RUNTIME_DIR'];
const PRINT_ENV = `console.log('ENV ' + JSON.stringify(Object.fromEntries(${JSON.stringify([...SCRUBBED, 'TMPDIR'])}.map((k) => [k, process.env[k] ?? null]))))`;
const HOSTILE_ENV = { DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-9', SSH_AUTH_SOCK: '/nonexistent/agent',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus', DOCKER_HOST: 'unix:///nonexistent/docker.sock',
  XDG_RUNTIME_DIR: '/nonexistent/xdg', TMPDIR: '/nonexistent/tmp' };

/** @param {string} out @returns {Record<string, string|null>[]} every ENV line */
const envLines = (out) => [...out.matchAll(/^ENV (.*)$/gm)].map((m) => JSON.parse(m[1]));

test('⛔ env scrub: socket/display vars are ABSENT inside and TMPDIR=/tmp — fresh AND nested paths', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c',
    `"$0" -e "$2"; DISPLAY=:98 SSH_AUTH_SOCK=/nonexistent/again TMPDIR=/nonexistent "$0" "$1" isolated -- "$0" -e "$2"`,
    process.execPath, TOOL, PRINT_ENV], HOSTILE_ENV);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = envLines(r.stdout);
  assert.equal(lines.length, 2, r.stdout);
  for (const [i, e] of lines.entries()) {
    for (const k of SCRUBBED) assert.equal(e[k], null, `${['fresh', 'nested'][i]} path: ${k} reached the command`);
    assert.equal(e.TMPDIR, '/tmp', `${['fresh', 'nested'][i]} path: TMPDIR not reset`);
  }
});

test('env scrub CONTROL: the same vars DO reach a command run without `isolated`', async () => {
  const c = await new Promise((resolve) => {
    const ch = spawn(process.execPath, ['-e', PRINT_ENV], { env: cleanEnv(HOSTILE_ENV) });
    let out = ''; ch.stdout.on('data', (d) => { out += d; });
    ch.on('close', () => resolve(envLines(out)[0]));
  });
  assert.equal(/** @type {any} */ (c).DISPLAY, ':99', 'the printer cannot see env at all — the scrub arm proves nothing');
  assert.equal(/** @type {any} */ (c).TMPDIR, '/nonexistent/tmp');
});

// ── keep-binds: /tmp is masked, the arm's own paths are not ──────────────────

test('⭐ keep-binds: cwd under /tmp + an absolute /tmp path work inside; an UNKEPT sibling under /tmp is invisible', needsIsolation, async () => {
  // ⚠ The cwd is TWO levels below /tmp, with the unkept sibling beside it. From a
  // direct child of /tmp, `..` lands on a dentry the new tmpfs is mounted on, and the
  // walk crosses INTO the new /tmp — which hid a missing re-chdir (measured: the
  // mutation survived). One level deeper, `..` is an ordinary directory of the OLD /tmp.
  const parent = tmpdir();
  const cwd = path.join(parent, 'cwd');
  const sibling = path.join(parent, 'sibling');
  fs.mkdirSync(cwd);
  fs.mkdirSync(sibling);
  const kept = tmpdir();
  fs.writeFileSync(path.join(cwd, 'rel.txt'), 'cwd-file');
  fs.writeFileSync(path.join(kept, 'abs.txt'), 'kept-file');
  fs.writeFileSync(path.join(sibling, 'hidden.txt'), 'must-not-see');
  const show = `const fs = require('fs'); const t = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return e.code; } };
console.log('CWD ' + process.cwd()); console.log('REL ' + t('rel.txt')); console.log('ABS ' + t(process.argv[1]));
console.log('SIB ' + t(process.argv[2])); console.log('UP ' + t(process.argv[3]));`;
  try {
    const r = await run(['isolated', '--keep', kept, '--', process.execPath, '-e', show,
      path.join(kept, 'abs.txt'), path.join(sibling, 'hidden.txt'),
      path.join('..', path.basename(sibling), 'hidden.txt')], {}, process.execPath, cwd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^CWD ${fs.realpathSync(cwd)}$`, 'm'), 'the cwd moved');
    assert.match(r.stdout, /^REL cwd-file$/m);
    assert.match(r.stdout, /^ABS kept-file$/m);
    assert.match(r.stdout, /^SIB ENOENT$/m, 'an unkept /tmp directory was visible inside');
    // ⛔ `..` from the cwd: an INHERITED cwd still points into the OLD /tmp, so this is
    // how a missing re-chdir would show — relative paths walking out under the mask.
    assert.match(r.stdout, /^UP ENOENT$/m, 'the old /tmp is reachable through the cwd');
    // CONTROL: on the host the sibling IS readable — so ENOENT above is the mask.
    assert.equal(fs.readFileSync(path.join(sibling, 'hidden.txt'), 'utf8'), 'must-not-see');
    // and the writes a command makes through a keep land on the host (it is a bind, not a copy)
    const w = await run(['isolated', '--', process.execPath, '-e', 'require("fs").writeFileSync("out.txt", "w")'],
      {}, process.execPath, cwd);
    assert.equal(w.status, 0, w.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8'), 'w');
  } finally {
    for (const d of [parent, kept]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⛔ keep refusals: /tmp, /run, an ancestor of them, a path under /run, $HOME, a missing path → usage 3, nothing run', async () => {
  const dir = tmpdir();
  try {
    for (const k of ['/tmp', '/run', '/', os.userInfo().homedir, path.join(dir, 'missing')]) {
      const r = await run(['isolated', '--keep', k, '--', process.execPath, '-e', 'console.log("RAN-" + "MARKER")']);
      assert.equal(r.status, 3, `--keep <${k === os.userInfo().homedir ? 'HOME' : k}>: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /RAN-MARKER/);
    }
    if (fs.existsSync('/run/user') && fs.statSync('/run/user').isDirectory()) {
      const r = await run(['isolated', '--keep', '/run/user', '--', 'true']);
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, /beneath \/run, where host sockets live/);
    }
    assert.equal((await run(['isolated', '--keep', '--', 'true'])).status, 3, '--keep without a value');
    assert.equal((await run(['isolated', '--bogus', '--', 'true'])).status, 3, 'an unknown option');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keep-binds: a throwaway HOME under /tmp stays visible inside without --keep (the gate\'s layout)', needsIsolation, async () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, '.rc'), 'home-file');
  try {
    const r = await run(['isolated', '--', process.execPath, '-e',
      'console.log("HOME " + require("fs").readFileSync(require("path").join(process.env.HOME, ".rc"), "utf8"))'],
    { HOME: home });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^HOME home-file$/m);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ a cwd that IS /tmp → FAIL, not run (re-exposing it would undo the mask)', async () => {
  const r = await run(['isolated', '--', process.execPath, '-e', 'console.log("RAN-" + "MARKER")'], {}, process.execPath, '/tmp');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /NOT RUN: the working directory is \/tmp itself, which is masked/);
  assert.doesNotMatch(r.stdout, /RAN-MARKER/);
});

// ── the home directory is READ-ONLY (profiles, ~/.config, ~/.ssh) ────────────
//
// ⛔ A mutant restoring a LITERAL path corrupts a signed-in browser profile under
// ~/.cache with no network at all. ⇒ `isolated` makes the PASSWD home read-only, with
// every submount, and re-opens only the cwd and each `--keep` writable.
//
// ⚠ These arms must not write into the real home: the arm tries to create a NEW, uniquely
// named file (EROFS inside = never created) and deletes it in `finally` should the arm
// ever unexpectedly succeed; the controls use a throwaway dir they create and remove.

const PW_HOME = fs.realpathSync(os.userInfo().homedir);
/** A name that cannot collide with a real file. */
const probeName = () => `.webctl-ro-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** Prints `WRITE <ok|errno>` for an exclusive create of argv[1]. */
const TRY_CREATE = `
try { require('fs').writeFileSync(process.argv[1], 'x', { flag: 'wx' }); console.log('WRITE ok'); }
catch (e) { console.log('WRITE ' + e.code); }`;
/** @param {string} out */
const writeOf = (out) => (out.match(/WRITE (\S+)/) || [])[1] || `none in: ${out}`;
/** A throwaway dir directly under the passwd home — the controls' ONLY footprint there. */
const homeTmpdir = () => fs.mkdtempSync(path.join(PW_HOME, '.webctl-iso-test-'));

test('⭐ ARM: creating a new file directly under the passwd home → EROFS inside; it does NOT exist on the host', needsIsolation, async () => {
  const target = path.join(PW_HOME, probeName());
  try {
    const r = await run(['isolated', '--', process.execPath, '-e', TRY_CREATE, target]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(writeOf(r.stdout), 'EROFS', 'the home directory is writable inside `isolated`');
    assert.equal(fs.existsSync(target), false, 'the file reached the real home directory');
  } finally { fs.rmSync(target, { force: true }); }
});

test('⭐ CONTROL: the same create WITHOUT `isolated` succeeds (the arm can fail) — into a throwaway dir, removed', async () => {
  const dir = homeTmpdir();
  const target = path.join(dir, probeName());
  try {
    const r = await runRaw([process.execPath, '-e', TRY_CREATE, target]);
    assert.equal(writeOf(r.stdout), 'ok');
    assert.equal(fs.existsSync(target), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ CONTROL: a `--keep` dir under home is WRITABLE inside, and the write lands on the host', needsIsolation, async () => {
  const dir = homeTmpdir();
  const target = path.join(dir, 'written-inside.txt');
  try {
    const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e', TRY_CREATE, target]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(writeOf(r.stdout), 'ok', 'a --keep under home was not re-opened writable');
    assert.equal(fs.readFileSync(target, 'utf8'), 'x', 'the write did not reach the host (a copy, not a bind?)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ a cwd under home is writable; `..` out of it is EROFS — the cwd is re-entered BY PATH', needsIsolation, async () => {
  // ⚠ The inherited cwd is a reference into the OLD, writable home mount: without the
  // re-chdir, `../x` resolves through it and lands on the writable tree.
  // ⛔ The cwd is TWO levels below home. From a DIRECT child, `..` is the home dentry —
  // now a mount point — and the walk crosses INTO the new ro mount, which hid a missing
  // re-chdir (measured: the mutation SURVIVED; the same trap the /tmp keep-bind test hit).
  // One level deeper, `..` is an ordinary directory of the OLD mount. It is the throwaway
  // dir, so even a failing arm writes nowhere but there.
  const dir = homeTmpdir();
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  const name = probeName();
  try {
    const r = await run(['isolated', '--', process.execPath, '-e',
      `${TRY_CREATE}; try { require('fs').writeFileSync(process.argv[2], 'x', { flag: 'wx' }); console.log('UP ok'); } catch (e) { console.log('UP ' + e.code); }`,
      'in-cwd.txt', path.join('..', name)], {}, process.execPath, cwd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(writeOf(r.stdout), 'ok', 'the cwd under home is not writable');
    assert.equal(fs.readFileSync(path.join(cwd, 'in-cwd.txt'), 'utf8'), 'x');
    assert.match(r.stdout, /^UP EROFS$/m, 'a relative path out of the cwd reached the writable tree');
    assert.equal(fs.existsSync(path.join(dir, name)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ base\'s repo root is READ-ONLY unless it is the cwd (the gate shares it across consumers)', needsIsolation, async () => {
  const cwd = tmpdir();
  const name = probeName();
  const target = path.join(ROOT, name);
  try {
    const ro = await run(['isolated', '--', process.execPath, '-e', TRY_CREATE, target], {}, process.execPath, cwd);
    assert.equal(ro.status, 0, ro.stdout + ro.stderr);
    assert.equal(writeOf(ro.stdout), 'EROFS', 'a mutant can write into base\'s tree');
    assert.equal(fs.existsSync(target), false);
    // CONTROL: cwd = base's root (base's own suite) → writable through the cwd
    const rw = await run(['isolated', '--', process.execPath, '-e', TRY_CREATE, target], {}, process.execPath, ROOT);
    assert.equal(writeOf(rw.stdout), 'ok', rw.stdout + rw.stderr);
    assert.equal(fs.existsSync(target), true);
  } finally { fs.rmSync(target, { force: true }); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('⛔ a cwd that IS (or contains) the home directory → FAIL, not run (it would re-open all of it)', async () => {
  for (const cwd of [PW_HOME, '/']) {
    const r = await run(['isolated', '--', process.execPath, '-e', 'console.log("RAN-" + "MARKER")'], {}, process.execPath, cwd);
    assert.equal(r.status, 1, `cwd ${cwd === PW_HOME ? '<HOME>' : cwd}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /NOT RUN: the working directory contains the home directory, which isolation makes READ-ONLY/);
    assert.doesNotMatch(r.stdout, /RAN-MARKER/);
  }
});

test('⛔ a `--keep` SYMLINK to the home directory is realpath\'d → refused as containing it (usage 3)', async () => {
  const dir = tmpdir();
  const link = path.join(dir, 'innocent');
  fs.symlinkSync(PW_HOME, link);
  try {
    const r = await run(['isolated', '--keep', link, '--', process.execPath, '-e', 'console.log("RAN-" + "MARKER")']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /--keep #1 contains the home directory/);
    assert.doesNotMatch(r.stdout, /RAN-MARKER/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a `--keep` inside ~/.cache is ALLOWED but NAMED on stderr (the caller\'s choice, made visible)', needsIsolation, async (t) => {
  const cache = path.join(PW_HOME, '.cache');
  if (!fs.existsSync(cache)) { t.skip('SKIP (host): no ~/.cache here'); return; }
  const dir = fs.mkdtempSync(path.join(cache, '.webctl-iso-test-'));
  try {
    const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e', TRY_CREATE, path.join(dir, 'f')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /isolated: note: --keep #1 is in ~\/\.cache — re-exposed WRITABLE/);
    assert.equal(writeOf(r.stdout), 'ok');
    // CONTROL: an unremarkable keep gets no note
    const plain = tmpdir();
    try {
      const q = await run(['isolated', '--keep', plain, '--', 'true']);
      assert.equal(q.status, 0, q.stderr);
      assert.doesNotMatch(q.stderr, /note:/);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── submounts: a ro remount hits only the TOP mount ──────────────────────────

/**
 * Run `inner` (sh) with a tmpfs SUBMOUNT at <dir>/sub that exists only in an OUTER mount
 * namespace — so nothing written to it ever reaches the disk — and as the caller's own
 * uid there (a second userns maps 0 back), so the passwd lookup still names the real home.
 * @param {string} dir @param {string} inner
 */
function withHomeSubmount(dir, inner) {
  return runRaw(['unshare', '-rm', '--propagation=private', 'sh', '-c',
    'mount -t tmpfs webctl-test-sub "$0/sub" && exec unshare --map-user="$1" --map-group="$2" sh -c "$3" "$0"',
    dir, String(process.getuid?.()), String(process.getgid?.()), inner]);
}
const SUBMOUNT_UNAVAILABLE = NO_ISOLATION || (() => {
  const r = spawnSync('unshare', ['-r', 'unshare', `--map-user=${process.getuid?.()}`, 'true'], { encoding: 'utf8' });
  return r.status === 0 ? '' : `nested userns with --map-user unavailable: ${(r.stderr || '').trim()}`;
})();
const needsSubmount = SUBMOUNT_UNAVAILABLE ? { skip: `SKIP (submount probe): ${SUBMOUNT_UNAVAILABLE}` } : {};

test('⭐ CONTROL: a submount under home is WRITABLE without `isolated` (in a throwaway outer namespace)', needsSubmount, async () => {
  const dir = homeTmpdir();
  fs.mkdirSync(path.join(dir, 'sub'));
  try {
    const r = await withHomeSubmount(dir, 'touch "$0/sub/f" && echo WRITE ok');
    assert.equal(writeOf(r.stdout), 'ok', r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), [], 'the tmpfs submount leaked onto the disk');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ ARM: that submount under home is EROFS inside `isolated` — every submount is remounted, not just the top', needsSubmount, async () => {
  const dir = homeTmpdir();
  fs.mkdirSync(path.join(dir, 'sub'));
  // readable inside (home is ro, not hidden); argv[2], since argv[1] is the script itself
  fs.writeFileSync(path.join(dir, 'try.cjs'), TRY_CREATE.replace('process.argv[1]', 'process.argv[2]'));
  try {
    const r = await withHomeSubmount(dir,
      `"${process.execPath}" "${TOOL}" isolated -- "${process.execPath}" "$0/try.cjs" "$0/sub/f"`);
    assert.equal(writeOf(r.stdout), 'EROFS', `a submount under home stayed writable:\n${r.stdout}${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the submount LOGIC, from an explicit mountinfo (no host dependency) ──────

const { parseMountinfo, reachableMountsUnder, readOnlyGaps } = await import(pathToFileURL(TOOL).href);

/** One mountinfo line. @param {number} id @param {number} parent @param {string} at @param {string} [o] */
const mi = (id, parent, at, o = 'rw,relatime') => `${id} ${parent} 0:${id} / ${at} ${o} shared:1 - tmpfs src rw`;
const MOUNTINFO = [
  mi(1, 0, '/'),
  mi(30, 1, '/home'),
  mi(50, 30, '/home/u/data'),           // the ORIGINAL submount, under the bind: unreachable
  mi(100, 30, '/home/u'),               // our rbind of the home onto itself
  mi(101, 100, '/home/u/data'),         // its copy of the submount
  mi(102, 101, '/home/u/data/deep'),    // a submount of a submount
  mi(103, 100, '/home/u/with\\040space'), // octal-escaped in mountinfo
  mi(104, 100, '/home/u/stack'),        // a stack: 105 on top of 104 at the same path
  mi(105, 104, '/home/u/stack'),
  mi(106, 100, '/home/u/a/b'),          // shadowed by 107, mounted later on its ancestor
  mi(107, 100, '/home/u/a'),
  mi(108, 30, '/home/uu'),              // a PREFIX trap: not under /home/u
].join('\n');

test('⭐ logic: EVERY reachable submount under the home is selected for the ro remount (and nothing else)', () => {
  const mounts = parseMountinfo(MOUNTINFO);
  const got = reachableMountsUnder(mounts, '/home/u').map((/** @type {any} */ m) => m.id).sort((a, b) => a - b);
  assert.deepEqual(got, ['100', '101', '102', '103', '105', '107'],
    'submount, nested submount, escaped path, top of a stack, the shadowing sibling — and not 50/104/106/108');
  assert.equal(mounts.find((/** @type {any} */ m) => m.id === '103').at, '/home/u/with space', 'octal escapes decoded');
  assert.equal(reachableMountsUnder(mounts, '/home/v'), null, 'nothing mounted at a root → null, not []');
});

test('⭐ logic: readOnlyGaps names every writable reachable mount, exempts writable keeps, and passes an all-ro tree', () => {
  const allRw = parseMountinfo(MOUNTINFO);
  assert.equal(readOnlyGaps(allRw, ['/home/u'], []).length, 6);
  // a writable keep exempts itself and everything beneath it — and nothing that merely shares a prefix
  const keep = readOnlyGaps(allRw, ['/home/u'], ['/home/u/data']).map((/** @type {any} */ g) => g.at).sort();
  assert.deepEqual(keep, ['/home/u', '/home/u/a', '/home/u/stack', '/home/u/with space']);
  const ro = parseMountinfo(MOUNTINFO.replace(/ rw,relatime /g, ' ro,relatime '));
  assert.deepEqual(readOnlyGaps(ro, ['/home/u'], []), []);
  // CONTROL: only the TOP ro (what a single `remount,bind,ro` of the rbind does) → the submounts are gaps
  const topOnly = parseMountinfo(MOUNTINFO.replace(`100 30 0:100 / /home/u rw,relatime`, `100 30 0:100 / /home/u ro,relatime`));
  assert.equal(readOnlyGaps(topOnly, ['/home/u'], []).length, 5);
  assert.deepEqual(readOnlyGaps(ro, ['/home/v'], []), [{ root: '/home/v', at: '' }], 'an unmounted root is a gap');
});

// ── nesting: the previous `isolated` (writable home) is not "inside" ─────────

test('⛔ nesting: every OLD fact satisfied (netns, mntns, our tmpfs on /run+/tmp) but home WRITABLE → refused by the home fact alone', needsIsolation, async () => {
  // What the PREVIOUS `isolated` produced: a full mask, no read-only home.
  const stage = 'mount -t tmpfs webctl-isolated /run && mkdir /run/k && mount --rbind "$0" /run/k'
    + ' && { [ -L /var/run ] || mount -t tmpfs webctl-isolated /var/run; }'
    + ' && mount -t tmpfs webctl-isolated /tmp && mkdir -p "$0" && mount --move /run/k "$0" && exec "$@"';
  const r = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--propagation=private', 'sh', '-c', stage, ROOT],
    'mnt:[1]', { WEBCTL_RO_ROOTS: JSON.stringify([PW_HOME]), WEBCTL_HOST_PIDNS: 'pid:[1]' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /1 of 1 protected root\(s\) — the home directory — are WRITABLE here/);
  assert.doesNotMatch(r.stderr, /EQUALS|uid_map is|interface\(s\) besides|no 'webctl-isolated' tmpfs|PID namespace/, 'only the home fact should refuse');
  assert.equal(r.ran, false, 'a namespace with a writable home was accepted as `isolated`');
});

// ── the command runs with NO capabilities (it cannot undo the masks) ────────
//
// ⛔ Measured by the final review: inside `isolated` the command was namespace root with
// CapEff 000001ffffffffff — `umount -l /tmp` and `umount <covered socket>` re-exposed host
// sockets, and CAP_DAC_OVERRIDE read a chmod-000 file.
// ⛔ The first fix (setpriv dropping every capability set, a28b280) REGRESSED the release
// gate: a capless namespace ROOT cannot write a nested user namespace's uid_map, so a lane
// self-isolating with `unshare -rn` failed and Chromium's sandbox could not start.
// ⇒ The command runs in a CHILD user namespace as the REAL uid/gid (no_new_privs, read back):
// no capabilities over the masks, yet free to make namespaces of its own.
// Each CONTROL runs the same act in a raw `unshare` WITH capabilities, to show it works
// there — so the arm's refusal is the privilege drop, not some other accident.

/** `unshare -rnm` + a fresh /tmp, NOT via the harness: namespace root with every cap. */
const RAW_NS = ['unshare', '-rnm', '--propagation=private', 'sh', '-c'];
const PRINT_CAPS = 'grep -E "^(CapInh|CapPrm|CapEff|CapAmb|NoNewPrivs):" /proc/self/status | tr "\\t" " "';
/** Prints `LOOP ok` when a listener + client on 127.0.0.1 work in this network namespace. */
const LOOP_SELF_TEST = `
const net = require('node:net');
const srv = net.createServer((s) => s.destroy()).listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1');
  c.on('connect', () => { console.log('LOOP ok'); c.destroy(); srv.close(); });
  c.on('error', (e) => { console.log('LOOP ' + e.code); srv.close(); });
});`;

test('⭐ ARM: inside `isolated` CapInh, CapPrm, CapEff, CapAmb are 0 and NoNewPrivs is 1', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c', PRINT_CAPS]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
    assert.match(r.stdout, new RegExp(`^${k}: 0{16}$`, 'm'), `the command holds capabilities (${k}):\n${r.stdout}`);
  }
  assert.match(r.stdout, /^NoNewPrivs: 1$/m);
});

test('⭐ CONTROL: a raw `unshare -rnm` gives the command EVERY capability (what the arm removes)', needsIsolation, async () => {
  const r = await runRaw([...RAW_NS, PRINT_CAPS]);
  assert.doesNotMatch(r.stdout, /^CapEff: 0{16}$/m, r.stdout + r.stderr);
});

test('⭐ ARM: `id -u`/`id -g` inside are the REAL uid/gid (compared here, never printed) — CONTROL: raw unshare is 0', needsIsolation, async () => {
  // ⚠ assertion messages carry stderr only: stdout holds the ids, and test logs get pasted
  const r = await run(['isolated', '--', 'sh', '-c', 'id -u; id -g']);
  assert.equal(r.status, 0, r.stderr);
  const [uid, gid] = r.stdout.trim().split('\n');
  assert.ok(uid === String(process.getuid?.()), 'the command does not run as the real uid inside');
  assert.ok(gid === String(process.getgid?.()), 'the command does not run as the real gid inside');
  const c = await runRaw([...RAW_NS, 'id -u']);
  assert.equal(c.stdout.trim(), '0', `CONTROL: namespace root should be uid 0:\n${c.stderr}`);
});

test('⭐ ARM: `umount -l /tmp` FAILS inside, and a host socket under an unkept /tmp dir stays ENOENT', needsIsolation, async () => {
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  const srv = await unixServer(sock);
  try {
    const r = await run(['isolated', '--', 'sh', '-c',
      'umount -l /tmp; echo "UMOUNT $?"; "$0" -e "$1" "$2"', process.execPath, UNIX_CONNECT, sock]);
    await settle();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^UMOUNT [1-9]\d*$/m, 'the command could unmount the /tmp mask');
    assert.equal(outcomeOf(r.stdout), 'ENOENT');
    assert.equal(srv.count(), 0, 'the host socket was reached from inside');
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ CONTROL: WITH capabilities, `umount -l /tmp` re-exposes that socket → CONNECTED (why the drop matters)', needsIsolation, async () => {
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  const srv = await unixServer(sock);
  try {
    const r = await runRaw([...RAW_NS,
      'mount -t tmpfs t /tmp && "$0" -e "$1" "$2" && umount -l /tmp && "$0" -e "$1" "$2"', process.execPath, UNIX_CONNECT, sock]);
    await settle();
    const outs = [...r.stdout.matchAll(/OUTCOME (\S+)/g)].map((m) => m[1]);
    assert.deepEqual(outs, ['ENOENT', 'CONNECTED'], r.stdout + r.stderr);
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ ARM: `mount -o remount,bind,rw <home>` FAILS inside, and the home stays EROFS', needsIsolation, async () => {
  // ⚠ `remount,BIND,rw` — the per-mount flag the ro step set. A plain `remount,rw` is a
  // SUPERBLOCK remount, which needs init-namespace CAP_SYS_ADMIN and fails even WITH every
  // namespace capability: an arm using it SURVIVED the no-setpriv mutation (measured).
  const target = path.join(PW_HOME, probeName());
  try {
    const r = await run(['isolated', '--', 'sh', '-c',
      'mount -o remount,bind,rw "$3"; echo "REMOUNT $?"; "$0" -e "$1" "$2"', process.execPath, TRY_CREATE, target, PW_HOME]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^REMOUNT [1-9]\d*$/m, 'the command could remount the home read-write');
    assert.equal(writeOf(r.stdout), 'EROFS');
    assert.equal(fs.existsSync(target), false);
  } finally { fs.rmSync(target, { force: true }); }
});

test('⭐ CONTROL: WITH capabilities, a ro bind of the home CAN be remounted rw (nothing is written)', needsIsolation, async () => {
  const r = await runRaw([...RAW_NS,
    'mount --rbind "$0" "$0" && mount -o remount,bind,ro "$0" && mount -o remount,bind,rw "$0"; echo "REMOUNT $?"', PW_HOME]);
  assert.match(r.stdout, /^REMOUNT 0$/m, r.stdout + r.stderr);
});

test('⛔ LOCKING: a NESTED `unshare -rnm` IS made, yet its `umount -l /tmp` and `remount,bind,rw <home>` are refused', needsIsolation, async () => {
  // The command CAN now make a nested user+mount namespace (it is root with every cap
  // there) — so this is no longer vacuous: the inherited mounts are LOCKED in a mount
  // namespace owned by a less privileged user namespace. `NESTED-IN` proves it ran.
  const dir = tmpdir();
  const sock = path.join(dir, 's.sock');
  const srv = await unixServer(sock);
  const target = path.join(PW_HOME, probeName());
  try {
    const r = await run(['isolated', '--', 'sh', '-c',
      'unshare -rnm sh -c \'echo NESTED-IN; umount -l /tmp; echo "UMOUNT $?"; "$0" -e "$1" "$2"; '
      + 'mount -o remount,bind,rw "$5"; echo "REMOUNT $?"; "$0" -e "$3" "$4"\' "$0" "$1" "$2" "$3" "$4" "$5"; echo "NESTED $?"',
      process.execPath, UNIX_CONNECT, sock, TRY_CREATE, target, PW_HOME]);
    await settle();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^NESTED-IN$/m, `the nested namespace was not even made (vacuous):\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^UMOUNT [1-9]\d*$/m, 'a nested namespace could unmount the /tmp mask');
    assert.equal(outcomeOf(r.stdout), 'ENOENT');
    assert.equal(srv.count(), 0);
    assert.match(r.stdout, /^REMOUNT [1-9]\d*$/m, 'a nested namespace could remount the home read-write');
    assert.equal(writeOf(r.stdout), 'EROFS');
    assert.equal(fs.existsSync(target), false);
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(target, { force: true }); }
});

test('⭐ REGRESSION ARM: a nested `unshare -rn` WORKS inside and brings its own lo UP (lanes self-isolate; Chromium needs a userns)', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'unshare', '-rn', 'sh', '-c',
    '(ip link set lo up 2>/dev/null || ifconfig lo up) && echo LO-UP; "$0" -e "$1"', process.execPath, LOOP_SELF_TEST]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^LO-UP$/m, `a nested network namespace could not bring its lo up:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^LOOP ok$/m);
});

test('⭐ CONTROL: under a28b280\'s `setpriv --bounding-set=-all` drop, that nested `unshare -rn` FAILS (why it was replaced)', needsIsolation, async (t) => {
  if (spawnSync('sh', ['-c', 'command -v setpriv']).status !== 0) { t.skip('SKIP (host): no setpriv here'); return; }
  const r = await runRaw([...RAW_NS, 'setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- '
    + 'unshare -rn true; echo "NESTED $?"']);
  assert.match(r.stdout, /^NESTED [1-9]\d*$/m, r.stdout + r.stderr);
  assert.match(r.stderr, /uid_map/, r.stderr);
});

test('⭐ ARM: a nested PID namespace works inside (`unshare -Ur --pid --fork --mount-proc` → pid 1)', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'unshare', '-Ur', '--pid', '--fork', '--mount-proc', 'sh', '-c', 'echo "PID $$"']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PID 1$/m, r.stdout + r.stderr);
});

test('⭐ ARM: a chmod-000 file is NOT readable inside (no CAP_DAC_OVERRIDE: no false greens) — CONTROL: raw unshare reads it', needsIsolation, async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'locked');
  fs.writeFileSync(f, 'secret');
  fs.chmodSync(f, 0o000);
  const READ = `try { require('fs').readFileSync(process.argv[1]); console.log('READ ok'); } catch (e) { console.log('READ ' + e.code); }`;
  try {
    const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e', READ, f]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^READ EACCES$/m, 'a chmod-000 file was readable inside: a test asserting EACCES goes false-red only here');
    const c = await runRaw(['unshare', '-r', process.execPath, '-e', READ, f]);
    assert.match(c.stdout, /^READ ok$/m, `CONTROL: namespace root WITH caps should read it:\n${c.stdout}${c.stderr}`);
  } finally { fs.chmodSync(f, 0o600); fs.rmSync(dir, { recursive: true, force: true }); }
});

/** Run `isolated --keep <dir> -- <write a marker>` with PATH set; resolve with the result + whether it ran. */
async function markerRun(/** @type {string} */ dir, /** @type {string} */ PATH) {
  const marker = path.join(dir, 'RAN');
  const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { PATH });
  return { ...r, ran: fs.existsSync(marker) };
}
const which = (/** @type {string} */ b) => spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim();

test('⛔ fail closed: no `setpriv` → FAIL naming it, command NOT run (never with capabilities)', needsIsolation, async () => {
  // ⚠ the PATH dir lives in a throwaway HOME dir: one under /tmp vanishes while /tmp is
  // masked, and `mount` itself would go missing first (measured)
  const dir = tmpdir();
  const binHome = homeTmpdir();
  const bin = path.join(binHome, 'bin');
  fs.mkdirSync(bin);
  for (const b of ['unshare', 'mount', which('ip') ? 'ip' : 'ifconfig']) fs.symlinkSync(which(b), path.join(bin, b));
  try {
    const r = await markerRun(dir, bin);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: cannot enter the uid-mapped child user namespace: 'setpriv' not found/);
    assert.equal(r.ran, false, 'the command ran with capabilities');
  } finally { for (const d of [dir, binHome]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('⛔ fail closed: a `setpriv` that ignores its flags (runs its argv as-is) → FAIL naming NoNewPrivs, command NOT run', needsIsolation, async () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'setpriv'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
  try {
    const r = await markerRun(dir, `${bin}:${process.env.PATH}`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /after entering the uid-mapped child user namespace, NoNewPrivs is not set/);
    assert.equal(r.ran, false, 'the command ran without no_new_privs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: a too-old `unshare` (no --map-user) → FAIL naming util-linux, command NOT run, no id printed', needsIsolation, async () => {
  // the fake passes every OTHER call (the outer -rnm) to the real unshare
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'unshare'), `#!/bin/sh
for a in "$@"; do case "$a" in --map-user*) echo "unshare: unrecognized option '$a'" >&2; exit 1;; --) break;; esac; done
exec ${JSON.stringify(which('unshare'))} "$@"
`, { mode: 0o755 });
  try {
    const r = await markerRun(dir, `${bin}:${process.env.PATH}`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: cannot enter the uid-mapped child user namespace: .* exited 1 .*util-linux ≥ 2\.38/);
    assert.ok(!new RegExp(`\\b${process.getuid?.()}\\b`).test(r.stderr), 'the refusal printed the real uid');
    assert.equal(r.ran, false, 'the command ran without the child user namespace');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: an `unshare` that accepts --map-user but makes NO child namespace → FAIL (the property is read back)', needsIsolation, async () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'unshare'), `#!/bin/sh
case " $* " in *" --map-user "*) while [ "$1" != "--" ]; do shift; done; shift; exec "$@";; esac
exec ${JSON.stringify(which('unshare'))} "$@"
`, { mode: 0o755 });
  try {
    const r = await markerRun(dir, `${bin}:${process.env.PATH}`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /after entering the uid-mapped child user namespace, it would still hold CapPrm, CapEff; its uid\/gid are not the real ones; its uid_map\/gid_map are not exactly the one expected mapping/);
    assert.equal(r.ran, false, 'the command ran as namespace root');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: a NESTED call without the recorded real ids (WEBCTL_HOST_IDS unset) → FAIL, nothing run', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c',
    'env -u WEBCTL_HOST_IDS "$0" "$1" isolated -- echo RAN-NESTED; echo "NESTED $?"', process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^NESTED 1$/m, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^RAN-NESTED$/m); // (the JSONL record names the command)
  assert.match(r.stderr, /the real uid\/gid were not recorded at entry/);
});

// ── WHO the arm runs as, under an OUTER `unshare -r` ────────────────────────
//
// ⛔ Measured by the final review: lanes self-isolate with `unshare -rn` and may call
// `isolated` inside it. There getuid() is 0 and os.userInfo() is ROOT, so the "read-only
// home" was root's and a file appeared in the REAL home. ⇒ realIdentity(): the ids from the
// OUTSIDE of /proc/self/{uid,gid}_map, the home from passwd for that uid.

test('⭐ ARM: `isolated` inside `unshare -r` → a write into the REAL home is EROFS (absent on the host), uid is the real one, nesting still works — CONTROL: the same write without `isolated` lands', needsIsolation, async () => {
  const dir = homeTmpdir(); // a throwaway dir under the real home — removed in finally
  const target = path.join(dir, 'arm');
  const ctl = path.join(dir, 'control');
  try {
    const r = await runRaw(['unshare', '-r', process.execPath, TOOL, 'isolated', '--', 'sh', '-c',
      '"$0" -e "$1" "$2"; id -u; unshare -rn sh -c "(ip link set lo up 2>/dev/null || ifconfig lo up) && echo NESTED-RN-OK"',
      process.execPath, TRY_CREATE, target], { cwd: ROOT });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(writeOf(r.stdout), 'EROFS', `a write into the real home was not EROFS under an outer unshare -r:\n${r.stderr}`);
    assert.equal(fs.existsSync(target), false, 'the file appeared in the real home');
    assert.ok(r.stdout.split('\n').includes(String(process.getuid?.())), 'the command does not run as the real uid');
    assert.match(r.stdout, /^NESTED-RN-OK$/m, r.stderr);
    const c = await runRaw(['unshare', '-r', process.execPath, '-e', TRY_CREATE, ctl]);
    assert.equal(writeOf(c.stdout), 'ok', `CONTROL: inside the same unshare -r the write should land:\n${c.stderr}`);
    assert.equal(fs.existsSync(ctl), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: inside a STACK of `unshare -r` (the real uid is two levels up) → FAIL, nothing run', needsIsolation, async () => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  try {
    const r = await runRaw(['unshare', '-r', 'unshare', '-r', process.execPath, TOOL, 'isolated', '--keep', dir, '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { cwd: ROOT });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: cannot resolve the real uid: this user namespace maps uid 0 onto uid 0 of its PARENT/);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: the real uid has NO passwd entry → FAIL (the home cannot be protected), nothing run', needsIsolation, async (t) => {
  // an empty file bound over /etc/passwd in a throwaway `unshare -rm`; skipped when NSS
  // (LDAP, sssd…) still answers for the uid, since then there IS an entry
  const dir = tmpdir();
  const empty = path.join(dir, 'passwd');
  fs.writeFileSync(empty, '');
  const marker = path.join(dir, 'RAN');
  try {
    const r = await runRaw(['unshare', '-rm', '--propagation=private', 'sh', '-c',
      'mount --bind "$0" /etc/passwd || exit 9; getent passwd "$1" >/dev/null && { echo NSS-STILL-ANSWERS; exit 0; }; shift; exec "$@"',
      empty, String(process.getuid?.()), process.execPath, TOOL, 'isolated', '--keep', dir, '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { cwd: ROOT });
    if (/NSS-STILL-ANSWERS/.test(r.stdout)) { t.skip('SKIP (host): NSS answers for this uid without /etc/passwd'); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: the real user has NO passwd entry/);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ ARM: the command cannot bind a port below 1024 (the netns belongs to the OUTER user namespace) — EACCES', needsIsolation, async (t) => {
  const BIND = `const s = require('net').createServer().on('error', (e) => console.log('BIND ' + e.code))
  .listen(Number(process.argv[1]), '127.0.0.1', () => { console.log('BIND ok'); s.close(); });`;
  const r = await run(['isolated', '--', 'sh', '-c', 'cat /proc/sys/net/ipv4/ip_unprivileged_port_start; "$0" -e "$1" 80',
    process.execPath, BIND]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  if (Number(r.stdout.split('\n')[0]) <= 80) { t.skip('SKIP (host): ip_unprivileged_port_start allows port 80 here'); return; }
  assert.match(r.stdout, /^BIND EACCES$/m, r.stdout + r.stderr);
});

// ── signals and exit codes reach through the namespaces ─────────────────────

/**
 * Wait for READY, SIGTERM the process, resolve with its exit code + stdout. The command
 * gives up by itself after ~10 s, so a LOST signal ends as `TIMEOUT` rc 9 — never as an
 * orphan looping forever. @param {string[]} argv
 */
function termAfterReady(argv) {
  return /** @type {Promise<{status: number|null, signal: string|null, stdout: string}>} */ (new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env: cleanEnv() });
    let stdout = ''; let sent = false;
    c.stdout.on('data', (d) => {
      stdout += d;
      if (!sent && /READY/.test(stdout)) { sent = true; c.kill('SIGTERM'); }
    });
    c.on('close', (status, signal) => resolve({ status, signal, stdout }));
  }));
}
const TRAPPER = 'trap "echo GOT-TERM; exit 7" TERM; echo READY; i=0; '
  + 'while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; echo TIMEOUT; exit 9';

test('⭐ SIGTERM to the harness reaches the command inside (its trap runs, its exit code comes back)', needsIsolation, async () => {
  const r = await termAfterReady([process.execPath, TOOL, 'isolated', '--', 'sh', '-c', TRAPPER]);
  assert.match(r.stdout, /GOT-TERM/, `the command never saw the SIGTERM:\n${r.stdout}`);
  assert.equal(r.status, 7, r.stdout);
});

test('⭐ CONTROL: the same trapper WITHOUT `isolated` → GOT-TERM, rc 7', async () => {
  const r = await termAfterReady(['sh', '-c', TRAPPER]);
  assert.match(r.stdout, /GOT-TERM/);
  assert.equal(r.status, 7);
});

test('isolated: a command killed by a signal → 128+signal (143 for SIGTERM)', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c', 'kill -TERM $$']);
  assert.equal(r.status, 143, r.stdout + r.stderr);
});

/**
 * A parent BASH runs `shape` (which starts `isolated` in the foreground); once READY shows,
 * INT goes to the whole process group (Ctrl-C). Resolves with how bash ended + stdout.
 * @param {string} shape bash source; `H …` runs the harness, `$N`/`$T` are node and the harness path @param {boolean} sendInt
 */
function bashParent(shape, sendInt) {
  return /** @type {Promise<{status: number|null, signal: string|null, stdout: string}>} */ (new Promise((resolve) => {
    const c = spawn('bash', ['-c', `N="$0"; T="$1"; H() { "$N" "$T" "$@"; }; ${shape}`, process.execPath, TOOL],
      { env: cleanEnv(), cwd: ROOT, detached: true });
    let stdout = ''; let sent = false;
    c.stdout.on('data', (d) => {
      stdout += d;
      if (sendInt && !sent && /READY/.test(stdout)) {
        sent = true;
        setTimeout(() => { try { process.kill(-(c.pid ?? 0), 'SIGINT'); } catch { /* gone */ } }, 300);
      }
    });
    c.on('close', (status, signal) => resolve({ status, signal, stdout }));
  }));
}
const SLEEPER = `sh -c 'echo READY; exec sleep 20'`;

// ⛔ Ctrl-C: `isolated` forwarded SIGINT and then EXITED NORMALLY with 130. bash's
// wait-and-cooperative-exit rule reads that as "the child HANDLED the INT", so a parent
// script WITHOUT an INT trap carried on to its next command (measured: `AFTER rc=130`).
// ⚠ A parent WITH an INT trap runs it either way on bash 5.3 (measured) — that arm is not
// the discriminating one. And a gate started as an async job (`setsid bash … &` from a
// script) has INT IGNORED from entry: its trap cannot even be installed.

test('⭐ Ctrl-C: INT to the group → `isolated` DIES BY SIGINT, so a parent bash without a trap stops too (no next command)', needsIsolation, async () => {
  const r = await bashParent(`H isolated -- ${SLEEPER}; echo "AFTER rc=$?"`, true);
  assert.doesNotMatch(r.stdout, /AFTER rc=/, `the parent carried on as if the command had merely exited:\n${r.stdout}`);
  assert.equal(r.signal, 'SIGINT', `the parent did not die by SIGINT (status ${r.status})`);
});

test('⭐ Ctrl-C, the GATE\'s shape `( isolated … ) 2>&1 | tee` → the parent stops by SIGINT', needsIsolation, async () => {
  const r = await bashParent(`( H isolated -- ${SLEEPER} ) 2>&1 | cat; echo "AFTER rc=\${PIPESTATUS[0]}"`, true);
  assert.doesNotMatch(r.stdout, /AFTER rc=/, r.stdout);
  assert.equal(r.signal, 'SIGINT');
});

test('⭐ Ctrl-C on the NESTED path (runCommand) → the parent stops by SIGINT', needsIsolation, async () => {
  const r = await bashParent(`H isolated -- "$N" "$T" isolated -- ${SLEEPER}; echo "AFTER rc=$?"`, true);
  assert.doesNotMatch(r.stdout, /AFTER rc=/, r.stdout);
  assert.equal(r.signal, 'SIGINT');
});

test('Ctrl-C, the gate\'s shape WITH its INT trap → the trap runs (true with or without the fix on bash 5.3)', needsIsolation, async () => {
  const r = await bashParent(`trap 'echo TRAPPED-INT; exit 42' INT; ( H isolated -- ${SLEEPER} ) 2>&1 | cat; `
    + 'echo "AFTER rc=${PIPESTATUS[0]}"', true);
  assert.match(r.stdout, /^TRAPPED-INT$/m, r.stdout);
  assert.equal(r.status, 42);
});

test('⭐ CONTROL: a command that EXITS 130 with no signal → `isolated` returns 130 and the parent carries on', needsIsolation, async () => {
  const r = await bashParent(`H isolated -- sh -c 'exit 130'; echo "AFTER rc=$?"`, false);
  assert.match(r.stdout, /^AFTER rc=130$/m, r.stdout);
  assert.equal(r.status, 0);
});

// ── no host PROCESSES: a private PID namespace ───────────────────────────────
//
// ⛔ Measured by the final review: `kill -0 <host pid>` SUCCEEDED from inside (same kuid,
// no PID namespace) and /proc listed every host process. A mutant of an ownership check
// ("is this browser mine?", ow9k) that kills by pid would kill the human's live browser.
// These arms only ever signal 0 at a `sleep` THIS test started.

/** Prints `KILL0 <ok|errno>` for kill(argv[1], 0), and `PROC <yes|no>` for /proc/<pid>. */
const KILL0 = `const p = Number(process.argv[1]);
try { process.kill(p, 0); console.log('KILL0 ok'); } catch (e) { console.log('KILL0 ' + e.code); }
console.log('PROC ' + (require('fs').existsSync('/proc/' + p) ? 'yes' : 'no'));`;

test('⭐ ARM: a host process this test started → kill(pid, 0) is ESRCH inside, and /proc does not list it', needsIsolation, async () => {
  const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const r = await run(['isolated', '--', process.execPath, '-e', KILL0, String(victim.pid)]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^KILL0 ESRCH$/m, `a host process can be signalled from inside:\n${r.stdout}`);
    assert.match(r.stdout, /^PROC no$/m, 'host processes are visible in /proc inside');
    // CONTROL: on the host the same pid is alive and signalable — ESRCH above is the namespace
    const c = await runRaw([process.execPath, '-e', KILL0, String(victim.pid)]);
    assert.match(c.stdout, /^KILL0 ok$/m);
    assert.match(c.stdout, /^PROC yes$/m);
  } finally { victim.kill('SIGKILL'); }
});

test('⛔ nesting: every other fact satisfied (full mask, ro home) but the HOST PID namespace → refused by the pid fact alone', needsIsolation, async () => {
  const stage = 'mount -t tmpfs webctl-isolated /run && mkdir /run/k && mount --rbind "$0" /run/k'
    + ' && { [ -L /var/run ] || mount -t tmpfs webctl-isolated /var/run; }'
    + ' && mount -t tmpfs webctl-isolated /tmp && mkdir -p "$0" && mount --move /run/k "$0"'
    + ' && mount --rbind "$1" "$1" && mount -o remount,bind,ro "$1" && shift && exec "$@"';
  const r = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--propagation=private', 'sh', '-c', stage, ROOT, PW_HOME],
    'mnt:[1]', { WEBCTL_RO_ROOTS: JSON.stringify([PW_HOME]), WEBCTL_HOST_PIDNS: fs.readlinkSync('/proc/self/ns/pid') });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the current PID namespace .* EQUALS the recorded host one/);
  assert.doesNotMatch(r.stderr, /uid_map is|interface\(s\) besides|no 'webctl-isolated' tmpfs|WRITABLE here|mount namespace .* EQUALS/,
    'only the pid fact should refuse');
  assert.equal(r.ran, false, 'a namespace sharing the host PIDs was accepted as `isolated`');
});

// ── every refusal is a tagged report line (what the gate greps for) ──────────

/** The release gate's own grep for an isolation refusal (test-all-consumers.sh). */
const GATE_REFUSAL = /^(FAIL|NO VERDICT) +isolated: /m;

test('⛔ every `isolated` USAGE refusal prints a `FAIL  isolated: NOT RUN (usage):` line + JSONL, and keeps exit 3', async () => {
  const dir = tmpdir();
  const link = path.join(dir, 'to-home');
  fs.symlinkSync(PW_HOME, link);
  const cases = /** @type {[string, string[]][]} */ ([
    ['no `--`', ['isolated', 'true']],
    ['no command', ['isolated', '--']],
    ['an unknown option', ['isolated', '--bogus', '--', 'true']],
    ['a missing keep', ['isolated', '--keep', path.join(dir, 'missing'), '--', 'true']],
    ['a keep that is /tmp', ['isolated', '--keep', '/tmp', '--', 'true']],
    ['a keep symlinked to the home', ['isolated', '--keep', link, '--', 'true']],
    ...(fs.existsSync('/run/user') ? [/** @type {[string, string[]]} */ (['a keep beneath /run', ['isolated', '--keep', '/run/user', '--', 'true']])] : []),
  ]);
  try {
    for (const [what, args] of cases) {
      const r = await run(args);
      assert.equal(r.status, 3, `${what}: ${r.stderr}`);
      assert.match(r.stderr, GATE_REFUSAL, `${what}: the gate's grep would miss this refusal:\n${r.stderr}`);
      assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN \(usage\): /m, what);
      const rec = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
      assert.equal(rec.check, 'isolated', what);
      assert.equal(rec.result, 'fail', what);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ a NESTED usage refusal and the inner half called on the host are tagged too', needsIsolation, async () => {
  const nested = await run(['isolated', '--', process.execPath, TOOL, 'isolated', '--keep', '/tmp', '--', 'true']);
  assert.equal(nested.status, 3, nested.stdout + nested.stderr);
  assert.match(nested.stderr, /^FAIL {2}isolated: NOT RUN \(usage\): --keep #1 is \/tmp/m);
  const inner = await run(['__isolated-inner', 'net:[0]', '--', 'true']);
  assert.equal(inner.status, 1);
  assert.match(inner.stderr, /^FAIL {2}isolated: NOT RUN: /m, inner.stderr);
});

test('CONTROL: the gate\'s grep DOES miss the old untagged shape (so the arm above can fail)', () => {
  assert.doesNotMatch('isolated: --keep #1 is beneath /run, where host sockets live\n', GATE_REFUSAL);
  assert.match('FAIL  isolated: NOT RUN (usage): --keep #1 is beneath /run\n', GATE_REFUSAL);
});

// ── import guard ─────────────────────────────────────────────────────────────

test('⛔ importing the harness runs NO verb, even when the importer\'s argv names one', async () => {
  const url = pathToFileURL(TOOL).href;
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e',
      'const m = await import(process.env.HARNESS_URL); console.log("IMPORTED " + m.HARNESS_GENERATION);',
      'x', 'generation'], { env: cleanEnv({ HARNESS_URL: url }) });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
  const res = /** @type {{status:number, stdout:string, stderr:string}} */ (r);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), 'IMPORTED 5', 'a verb ran on import');
  assert.equal(res.stderr, '');
});
