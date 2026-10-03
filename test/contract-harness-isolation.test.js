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

test('the new verbs are ADDITIVE: HARNESS_GENERATION is still 4', async () => {
  const r = await run(['generation']);
  assert.equal(JSON.parse(r.stdout.trim()).generation, 4);
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
 */
async function nestedAttempt(recorded, prefix = [], recordedMnt) {
  const argv = [...prefix, process.execPath, TOOL, 'isolated', '--', process.execPath, '-e',
    'console.log("RAN-" + "MARKER")'];
  const env = cleanEnv({ WEBCTL_HOST_NETNS: recorded, ...(recordedMnt ? { WEBCTL_HOST_MNTNS: recordedMnt } : {}) });
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
  assert.equal(res.stdout.trim(), 'IMPORTED 4', 'a verb ran on import');
  assert.equal(res.stderr, '');
});
