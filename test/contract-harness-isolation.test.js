// contract-harness-isolation.test.js — mutation arms run with NO HOST NETWORK.
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
  const r = spawnSync('unshare', ['-rn', 'sh', '-c', 'ip link set lo up 2>/dev/null || ifconfig lo up'],
    { encoding: 'utf8' });
  if (r.error) return `unshare not runnable here (${r.error.message})`;
  if (r.status !== 0) return `unprivileged user+net namespaces unavailable here: ${(r.stderr || '').trim()}`;
  return '';
}
const NO_ISOLATION = isolationUnavailable();
/** node:test skip option: a NAMED reason, never a silent pass. */
const needsIsolation = NO_ISOLATION ? { skip: `SKIP (isolation): ${NO_ISOLATION}` } : {};

/**
 * Run the harness ASYNC — a fake listener in this process must be able to
 * accept while the child runs. Never throws.
 * @param {string[]} args @param {Record<string,string>} [env] @param {string} [execPath]
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function run(args, env = {}, execPath = process.execPath) {
  return new Promise((resolve) => {
    const c = spawn(execPath, [TOOL, ...args], { cwd: ROOT, env: cleanEnv(env) });
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
    const r = await run(['isolated', '--', process.execPath, writeMutant(dir), String(fake.port)]);
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
    const r = await run(['isolated', '--', process.execPath, script]);
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
  fs.writeFileSync(path.join(bin, 'unshare'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
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

/**
 * Run `isolated -- <write marker>` with WEBCTL_HOST_NETNS set, optionally under a
 * prefix (e.g. `unshare -r`). @param {string} recorded @param {string[]} [prefix]
 */
async function nestedAttempt(recorded, prefix = []) {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  const argv = [...prefix, process.execPath, TOOL, 'isolated', '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
  const r = await new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env: cleanEnv({ WEBCTL_HOST_NETNS: recorded }) });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
  const ran = fs.existsSync(marker);
  fs.rmSync(dir, { recursive: true, force: true });
  return { .../** @type {{status:number, stdout:string, stderr:string}} */ (r), ran };
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
  assert.doesNotMatch(r.stderr, /EQUALS|uid_map is/, 'only the interface fact should have refused this');
  assert.equal(r.ran, false);
});

test('nesting CONTROL: a real nested `isolated` inside `isolated` proceeds WITHOUT unsharing again', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c',
    'readlink /proc/self/ns/net; "$0" "$1" isolated -- readlink /proc/self/ns/net', process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [outer, inner] = r.stdout.trim().split('\n');
  assert.notEqual(outer, HOST_NS, 'the outer level is not isolated');
  assert.equal(inner, outer, 'the nested call unshared AGAIN (or ran elsewhere)');
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
