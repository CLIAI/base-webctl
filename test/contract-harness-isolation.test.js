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
 * ⛔ Since the re-review of v0.33.0 a privileged half's tools come from FIXED system dirs, never
 * PATH — so an arm puts a FAKE tool where the harness looks: bind-mounted over the system copy,
 * in a throwaway `unshare -rm` (nothing outside it changes). These are those dirs; `overTool`
 * gives one bind per distinct real copy of `name` (on a merged-/usr host they are all one file).
 */
const TOOL_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'];
/** @param {string} src @param {string} name @returns {[string, string][]} */
function overTool(src, name) {
  const reals = new Set();
  for (const d of TOOL_DIRS) { try { reals.add(fs.realpathSync(path.join(d, name))); } catch { /* absent */ } }
  return [...reals].map((r) => /** @type {[string, string]} */ ([src, r]));
}
/** A NON-executable empty file in `dir`: bound over a tool, the harness no longer finds it. @param {string} dir */
function noexecFile(dir) {
  const f = path.join(dir, 'noexec');
  fs.writeFileSync(f, '', { mode: 0o644 });
  return f;
}
/** An empty file bound onto by `[realTool, it]`: a path the REAL tool stays reachable at once a fake covers it. @param {string} dir @param {string} name */
function realCopyAt(dir, name) {
  const at = path.join(dir, `real-${name}`);
  fs.writeFileSync(at, '');
  return at;
}
const MOUNT_BIN = TOOL_DIRS.map((d) => path.join(d, 'mount')).find((p) => fs.existsSync(p)) || 'mount';
/**
 * Run `argv` in a throwaway `unshare -rm` after bind-mounting each [src, dst] IN ORDER (a bind
 * over `mount` itself must come last). With `home`, the real uid's passwd home is pointed at it
 * first (as underFakeHome). Resolves null when this host cannot make the binds (skip by name).
 * @param {[string, string][]} binds @param {string[]} argv @param {{home?: string, cwd?: string, env?: NodeJS.ProcessEnv}} [o]
 */
async function withBinds(binds, argv, o = {}) {
  const dir = tmpdir();
  /** @type {[string, string][]} */
  const all = [];
  if (o.home) {
    const pw = path.join(dir, 'passwd');
    fs.writeFileSync(pw, `x:x:${process.getuid?.()}:${process.getgid?.()}::${o.home}:/bin/sh\n`);
    all.push([pw, '/etc/passwd']);
  }
  all.push(...binds);
  try {
    const r = await runRaw(['unshare', '-rm', '--propagation=private', 'sh', '-c',
      'm=$0; h=$1; u=$2; shift 2; while [ "$1" != -- ]; do "$m" --bind "$1" "$2" || exit 97; shift 2; done; shift; '
        + '[ -z "$h" ] || [ "$(getent passwd "$u" | cut -d: -f6)" = "$h" ] || exit 98; exec "$@"',
      MOUNT_BIN, o.home || '', String(process.getuid?.()), ...all.flat(), '--', ...argv], { cwd: o.cwd || ROOT, env: o.env });
    return r.status === 97 || r.status === 98 ? null : r;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const NO_BINDS = 'SKIP (host): cannot bind a fake tool (or passwd) in a throwaway `unshare -rm` here';

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

test('⛔ fail closed: no `unshare` in the system dirs → FAIL, reason printed, the command NOT run', needsIsolation, async (t) => {
  // ⚠ a throwaway `unshare -rm` hides the system unshare (PATH is never consulted for it)
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  try {
    const r = await withBinds(overTool(noexecFile(dir), 'unshare'), [process.execPath, TOOL, 'isolated', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: no isolation backend can be used here — unshare: 'unshare' not found in \/usr\/sbin, \/usr\/bin, \/sbin, \/bin — install util-linux, or name one with WEBCTL_UNSHARE_BIN/);
    assert.match(r.stdout, /"check":"isolated","result":"fail"/);
    assert.equal(fs.existsSync(marker), false, 'the command ran although isolation was unavailable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: an `unshare` that does NOT isolate → FAIL, command NOT run (the property is checked, not the exit)', needsIsolation, async (t) => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  // A fake `unshare` over the system one: drops its flags and execs the rest ON THE "HOST" (here:
  // the throwaway namespace the fake is bound in — the caller's network namespace)
  const fake = path.join(dir, 'unshare');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n', { mode: 0o755 });
  try {
    const r = await withBinds(overTool(fake, 'unshare'), [process.execPath, TOOL, 'isolated', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: still in the CALLER'S network namespace/);
    assert.equal(fs.existsSync(marker), false, 'the command ran on the host');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: neither `ip` nor `ifconfig` in the system dirs → FAIL naming it, command NOT run', needsIsolation, async (t) => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  const none = noexecFile(dir);
  try {
    const r = await withBinds([...overTool(none, 'ip'), ...overTool(none, 'ifconfig')], [process.execPath, TOOL, 'isolated', '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: no isolation backend can be used here — unshare: cannot bring the namespace loopback up: neither 'ip' nor 'ifconfig' found in \/usr\/sbin, \/usr\/bin, \/sbin, \/bin — install iproute2/);
    assert.equal(fs.existsSync(marker), false, 'the command ran without a working loopback');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: no `mount` in the system dirs → FAIL naming it, command NOT run (no socket masking, no run)', needsIsolation, async (t) => {
  const dir = tmpdir();
  const marker = path.join(dir, 'RAN');
  try {
    const r = await withBinds(overTool(noexecFile(dir), 'mount'), [process.execPath, TOOL, 'isolated', '--', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT RUN: no isolation backend can be used here — unshare: cannot mask the host's sockets: 'mount' not found in \/usr\/sbin, \/usr\/bin, \/sbin, \/bin — install util-linux/);
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

test('HARNESS_GENERATION is 6: `isolated` CHANGED behaviour in v0.33.0 (env allowlist, hidden home) — lanes key `--pass-env` on it', async () => {
  const r = await run(['generation']);
  assert.equal(JSON.parse(r.stdout.trim()).generation, 6);
  // the shape lanes copy (CHANGELOG v0.33.0): `require-generation 6` gates `--pass-env`
  assert.equal((await run(['require-generation', '6'])).status, 0);
  assert.equal((await run(['require-generation', '7'])).status, 1);
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
/**
 * The v0.34 scratch masks a fixture's fake OUTER sandbox needs (ib4k row 8): our tmpfs on /var/tmp
 * and /dev/shm, where they exist — the nesting proof requires them since v0.34.0.
 */
const SCRATCH_MASKS = ' && { [ ! -d /var/tmp ] || mount -t tmpfs webctl-isolated /var/tmp; }'
  + ' && { [ ! -d /dev/shm ] || mount -t tmpfs webctl-isolated /dev/shm; }';

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

const NESTED_KILL0 = 'try { process.kill(Number(process.argv[1]), 0); console.log("PID REACHABLE"); } catch (e) { console.log("PID " + e.code); }';

test('⛔ a NESTED `isolated` gets its own PID namespace: its command cannot signal its CALLER (ESRCH) — CONTROL: without the nested call it can', needsIsolation, async () => {
  // Measured on the v0.32.0 gate run: two lanes call `isolated` from their contract, and under
  // the gate that call is NESTED. It shared the caller's PID namespace, so their arm "a pid
  // outside cannot be signalled" saw the contract's own pid as REACHABLE.
  const r = await run(['isolated', '--', 'sh', '-c', '"$0" "$1" isolated -- "$0" -e "$2" $$',
    process.execPath, TOOL, NESTED_KILL0]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PID ESRCH$/m, `the nested command could see its caller:\n${r.stdout}${r.stderr}`);
  const c = await run(['isolated', '--', 'sh', '-c', '"$0" -e "$1" $$', process.execPath, NESTED_KILL0]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^PID REACHABLE$/m, 'CONTROL: in the SAME namespace the caller is reachable — the probe works');
});

test('a NESTED `isolated` still passes signals through its pid 1: TERM ends the command, exit 143', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c',
    '"$0" "$1" isolated -- sleep 30 & p=$!; sleep 2; kill -TERM $p; wait $p; echo "RC=$?"', process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^RC=143$/m, `${r.stdout}${r.stderr}`);
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

test('nesting CONTROL: a real nested `isolated` inside `isolated` keeps the outer NETWORK and MASKS (no second isolation of either)', needsIsolation, async () => {
  // A nested call now makes a PID namespace (and a mount namespace only to mount its /proc),
  // so the mount ns id differs — what must NOT change is the network, and the masks must be
  // the SAME ones, inherited (locked), not re-made: our tmpfs tag is still on /run and /tmp.
  const MASKS = 'awk \'$5 == "/run" || $5 == "/tmp" {for (i = 7; i <= NF; i++) if ($i == "-") {print "MASK", $5, $(i + 2); break}}\' /proc/self/mountinfo';
  const r = await run(['isolated', '--', 'sh', '-c',
    `readlink /proc/self/ns/net /proc/self/ns/mnt; echo OUTER; ${MASKS}; "$0" "$1" isolated -- sh -c 'readlink /proc/self/ns/net; echo INNER; ${MASKS.replace(/'/g, "'\\''")}'`,
    process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [outerNet, outerMnt] = r.stdout.trim().split('\n');
  const innerNet = (r.stdout.split('OUTER')[1] || '').split('\n').find((l) => l.startsWith('net:')) || '';
  assert.notEqual(outerNet, HOST_NS, 'the outer level is not network-isolated');
  assert.notEqual(outerMnt, HOST_MNT, 'the outer level has no mount namespace');
  assert.equal(innerNet, outerNet, 'the nested call unshared the network AGAIN (or ran elsewhere)');
  const inner = r.stdout.split('INNER')[1] || '';
  for (const at of ['/run', '/tmp']) {
    assert.match(inner, new RegExp(`^MASK ${at} webctl-isolated$`, 'm'), `the nested level lost the ${at} mask:\n${r.stdout}`);
  }
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

/** Run argv directly (no harness). @param {string[]} argv @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [o] */
function runRaw(argv, o = {}) {
  return /** @type {Promise<{status:number, stdout:string, stderr:string}>} */ (new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env: o.env || cleanEnv(), cwd: o.cwd });
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

const SCRUBBED = ['DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'DOCKER_HOST', 'XDG_RUNTIME_DIR',
  // state roots: base's storage paths prefer these over $HOME (a temp HOME was silently bypassed)
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME',
  // a live tmux server (send-keys into the human's panes), an X cookie, the agent's pid, a
  // docker context naming a remote daemon — and three that carry the operator's ADDRESSES
  'TMUX', 'TMUX_PANE', 'XAUTHORITY', 'SSH_AGENT_PID', 'DOCKER_CONTEXT', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'];
const PRINT_ENV = `console.log('ENV ' + JSON.stringify(Object.fromEntries(${JSON.stringify([...SCRUBBED, 'TMPDIR'])}.map((k) => [k, process.env[k] ?? null]))))`;
const HOSTILE_ENV = { DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-9', SSH_AUTH_SOCK: '/nonexistent/agent',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus', DOCKER_HOST: 'unix:///nonexistent/docker.sock',
  XDG_RUNTIME_DIR: '/nonexistent/xdg', TMPDIR: '/nonexistent/tmp',
  XDG_CACHE_HOME: '/nonexistent/real-cache', XDG_CONFIG_HOME: '/nonexistent/real-config',
  XDG_STATE_HOME: '/nonexistent/real-state', XDG_DATA_HOME: '/nonexistent/real-data',
  TMUX: '/nonexistent/tmux-sock,1,0', TMUX_PANE: '%99', XAUTHORITY: '/nonexistent/Xauthority',
  SSH_AGENT_PID: '99999', DOCKER_CONTEXT: 'nonexistent-context',
  SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22', SSH_CLIENT: '192.0.2.1 50000 22', SSH_TTY: '/nonexistent/pts' };

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
  assert.equal(/** @type {any} */ (c).XDG_CACHE_HOME, '/nonexistent/real-cache', 'CONTROL: an XDG state root is inherited without `isolated`');
  for (const k of SCRUBBED) assert.equal(/** @type {any} */ (c)[k], HOSTILE_ENV[/** @type {keyof typeof HOSTILE_ENV} */ (k)], `CONTROL: ${k} is inherited without \`isolated\``);
});

// ── env ALLOWLIST (v0.33.0, BREAKING): only named vars reach the command ─────
//
// ⛔ Measured by the review: 37 vars matching *_API_KEY / *_TOKEN / *SECRET reached the arm
// inside `isolated` on an operator host, and the gate passes its full env. A denylist cannot
// keep up with names nobody has thought of yet. ⇒ An ALLOWLIST, plus `--pass-env NAME|PREFIX_*`.

/** argv[1] = JSON list of names: prints `ENVSET {name: value|null}`. */
const PRINT_NAMED = 'const n = JSON.parse(process.argv[1]); console.log("ENVSET " + JSON.stringify(Object.fromEntries(n.map((k) => [k, process.env[k] ?? null]))))';
/** @param {string} out @returns {Record<string, string|null>[]} */
const envSets = (out) => [...out.matchAll(/^ENVSET (.*)$/gm)].map((m) => JSON.parse(m[1]));
/** Planted on the caller: must NOT reach the command unless passed. Fake values only. */
const PLANTED = { FAKE_API_KEY: 'planted-not-a-real-key', FAKE_OTHER: 'planted-2', CLIAI_FAKE_TOOL_BROWSER_TARGET: 'planted-target',
  SESSION_MANAGER: 'local/planted:@/tmp/.ICE-unix/1,unix/planted:/tmp/.ICE-unix/1', ICEAUTHORITY: '/nonexistent/ICEauthority',
  BASH_ENV: '/nonexistent/bash-env', SHELLOPTS: 'xtrace' };
/** Default-passed names, planted so their presence is the allowlist's doing. */
const ALLOWED = { LANG: 'C.UTF-8', LC_PLANTED: 'lc-planted', TERM: 'dumb', TZ: 'UTC', NODE_PATH: '/nonexistent/node-path',
  npm_config_planted: 'npm-planted', WEBCTL_PLANTED: 'webctl-planted', USER: 'planted-user', LOGNAME: 'planted-user', SHELL: '/bin/sh' };
const ALL_NAMES = JSON.stringify([...Object.keys(PLANTED), ...Object.keys(ALLOWED), 'PATH', 'HOME', 'TMPDIR']);

test('⛔ env ALLOWLIST: planted FAKE_API_KEY, CLIAI_*, SESSION_MANAGER, ICEAUTHORITY, BASH_ENV, SHELLOPTS are ABSENT — the default-passed names arrive', needsIsolation, async () => {
  const r = await run(['isolated', '--', process.execPath, '-e', PRINT_NAMED, ALL_NAMES], { ...PLANTED, ...ALLOWED });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [e] = envSets(r.stdout);
  assert.ok(e, r.stdout);
  for (const k of Object.keys(PLANTED)) assert.equal(e[k], null, `${k} reached the command`);
  for (const [k, v] of Object.entries(ALLOWED)) assert.equal(e[k], v, `${k} (default-passed) did not arrive`);
  assert.ok(e.PATH === process.env.PATH, 'PATH changed inside (not printed: it names home paths)');
  assert.equal(e.TMPDIR, '/tmp');
  assert.ok(e.HOME, 'HOME is default-passed');
});

test('env ALLOWLIST CONTROL: the planted vars DO reach a command run without `isolated`', async () => {
  const r = await runRaw([process.execPath, '-e', PRINT_NAMED, ALL_NAMES], { env: cleanEnv({ ...PLANTED, ...ALLOWED }) });
  const [e] = envSets(r.stdout);
  for (const [k, v] of Object.entries(PLANTED)) assert.equal(e[k], v, `CONTROL: ${k} not inherited without isolated — the arm proves nothing`);
});

test('⭐ --pass-env NAME passes exactly that name; --pass-env PREFIX_* passes the prefix — repeatable', needsIsolation, async () => {
  const one = await run(['isolated', '--pass-env', 'FAKE_API_KEY', '--', process.execPath, '-e', PRINT_NAMED, ALL_NAMES], PLANTED);
  assert.equal(one.status, 0, one.stdout + one.stderr);
  const [a] = envSets(one.stdout);
  assert.equal(a.FAKE_API_KEY, PLANTED.FAKE_API_KEY);
  assert.equal(a.FAKE_OTHER, null, 'a NAME pass let a sibling through');
  const pre = await run(['isolated', '--pass-env', 'FAKE_*', '--pass-env', 'CLIAI_FAKE_TOOL_BROWSER_TARGET', '--',
    process.execPath, '-e', PRINT_NAMED, ALL_NAMES], PLANTED);
  assert.equal(pre.status, 0, pre.stdout + pre.stderr);
  const [b] = envSets(pre.stdout);
  assert.equal(b.FAKE_API_KEY, PLANTED.FAKE_API_KEY);
  assert.equal(b.FAKE_OTHER, PLANTED.FAKE_OTHER);
  assert.equal(b.CLIAI_FAKE_TOOL_BROWSER_TARGET, PLANTED.CLIAI_FAKE_TOOL_BROWSER_TARGET);
  assert.equal(b.SESSION_MANAGER, null);
  // ⛔ a PREFIX pass cannot bring a scrubbed socket name back
  const xdg = await run(['isolated', '--pass-env', 'XDG_*', '--', process.execPath, '-e', PRINT_NAMED,
    JSON.stringify(['XDG_RUNTIME_DIR', 'XDG_PLANTED'])], { XDG_RUNTIME_DIR: '/nonexistent/xdg', XDG_PLANTED: 'x' });
  assert.equal(xdg.status, 0, xdg.stderr);
  assert.deepEqual(envSets(xdg.stdout)[0], { XDG_RUNTIME_DIR: null, XDG_PLANTED: 'x' });
});

test('⛔ the NESTED path keeps the allowlist (its own --pass-env) and the markers', needsIsolation, async () => {
  const MARKERS = JSON.stringify(['WEBCTL_HOST_NETNS', 'WEBCTL_HOST_MNTNS', 'WEBCTL_HOST_PIDNS', 'WEBCTL_RO_ROOTS', 'WEBCTL_HIDDEN_DIRS',
    'WEBCTL_HOST_IDS', 'FAKE_API_KEY', 'FAKE_OTHER']);
  const r = await run(['isolated', '--pass-env', 'FAKE_*', '--', 'sh', '-c',
    '"$0" "$1" isolated -- "$0" -e "$2" "$3"; "$0" "$1" isolated --pass-env FAKE_OTHER -- "$0" -e "$2" "$3"',
    process.execPath, TOOL, PRINT_NAMED, MARKERS], PLANTED);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [plain, passed] = envSets(r.stdout);
  assert.equal(plain.FAKE_API_KEY, null, 'the nested call passed a var it was not asked to');
  assert.equal(passed.FAKE_OTHER, PLANTED.FAKE_OTHER, 'the nested --pass-env did not pass');
  assert.equal(passed.FAKE_API_KEY, null);
  for (const e of [plain, passed]) {
    for (const k of ['WEBCTL_HOST_NETNS', 'WEBCTL_HOST_MNTNS', 'WEBCTL_HOST_PIDNS', 'WEBCTL_RO_ROOTS', 'WEBCTL_HIDDEN_DIRS', 'WEBCTL_HOST_IDS']) {
      assert.ok(e[k] !== null, `the nested command lost the marker ${k}`);
    }
  }
});

test('⛔ --pass-env is VALIDATED: not NAME or PREFIX_*, or a scrubbed socket/display name → usage 3, nothing run', async () => {
  for (const bad of ['*', '', 'A-B', 'FOO*', '1ABC', 'FOO_*_BAR', 'FOO BAR', 'DISPLAY', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR']) {
    const r = await run(['isolated', '--pass-env', bad, '--', process.execPath, '-e', 'console.log("RAN-" + "MARKER")']);
    assert.equal(r.status, 3, `--pass-env ${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN \(usage\): --pass-env #1 /m, `--pass-env ${JSON.stringify(bad)}`);
    assert.doesNotMatch(r.stdout, /RAN-MARKER/);
  }
});

// ── loader-injection vars never reach a PRIVILEGED half (review of 5773fb8, finding 1) ──
//
// ⛔ Measured by the review: NODE_OPTIONS=--require <preload> ran the preload in pid 2 — the
// `__isolated-inner` node — as namespace root with a FULL CapEff, before any mask (the real
// home readable, the host's X11 socket dir reachable). NODE_OPTIONS is default-passed to the
// COMMAND; it reached the halves that run before the drop because they got the command's env.
// ⇒ unshare, pid 1's bash, the inner node, setpriv/unshare of the drop and the pid-1 helper get
// a fixed short env (PRIVILEGED_PASS_ENV); the command's env travels in a pipe and is applied
// only when the command is spawned.

/** A NODE_OPTIONS preload: appends {argv, CapEff} of every node that loads it to `hits` beside it. */
const PRELOAD = `const fs = require('fs');
const cap = (fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\\s*(\\S+)/m) || [])[1];
try { fs.appendFileSync(require('path').join(__dirname, 'hits'), JSON.stringify({ argv: process.argv.slice(1), cap }) + '\\n'); } catch { /* not visible here */ }
`;
/** @param {string} dir @returns {{argv: string[], cap: string}[]} */
const hitsIn = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'hits'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const SEES_NODE_OPTIONS = 'console.log(process.env.NODE_OPTIONS ? "SEES-NODE-OPTIONS" : "NO-NODE-OPTIONS")';

test('⛔ NODE_OPTIONS never reaches a PRIVILEGED half (the inner node, the pid-1 helper) — the COMMAND gets it and its preload runs — fresh AND nested', needsIsolation, async () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'preload.cjs'), PRELOAD);
    const r = await run(['isolated', '--keep', dir, '--', 'sh', '-c',
      '"$0" -e "$2" CMD-FRESH; "$0" "$1" isolated -- "$0" -e "$2" CMD-NESTED', process.execPath, TOOL, SEES_NODE_OPTIONS],
    { NODE_OPTIONS: `--require ${path.join(dir, 'preload.cjs')}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const hits = hitsIn(dir);
    const privileged = hits.filter((h) => h.argv.some((a) => /^__isolated-/.test(a)) || !/^0+$/.test(h.cap || 'x'));
    assert.deepEqual(privileged, [], 'a NODE_OPTIONS preload ran in a privileged half (an `__isolated-*` node, or with capabilities)');
    // CONTROL: the command itself still sees NODE_OPTIONS and its preload ran there — fresh AND nested
    assert.equal((r.stdout.match(/^SEES-NODE-OPTIONS$/gm) || []).length, 2, r.stdout);
    assert.ok(hits.some((h) => h.argv.includes('CMD-FRESH')), `the preload did not run in the fresh command:\n${JSON.stringify(hits)}`);
    assert.ok(hits.some((h) => h.argv.includes('CMD-NESTED')), `the preload did not run in the nested command:\n${JSON.stringify(hits)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** `transferring control: <prog>` from glibc's LD_DEBUG=files per-pid files under `dir` (basenames). */
const ldPrograms = (/** @type {string} */ dir) => fs.readdirSync(dir).filter((f) => f.startsWith('ld.'))
  .flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/transferring control: (\S+)/g)].map((m) => path.basename(m[1])));
// ⚠ not `command -v true`: in sh that answers the BUILTIN's name, not a dynamically linked binary
const TRUE_BIN = ['/usr/bin/true', '/bin/true'].find((p) => fs.existsSync(p)) || '';
const LD_DEBUG_UNAVAILABLE = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ld-probe-'));
  try {
    spawnSync(TRUE_BIN || '/bin/true', [], { env: { ...process.env, LD_DEBUG: 'files', LD_DEBUG_OUTPUT: path.join(d, 'ld') } });
    return ldPrograms(d).length ? '' : 'glibc LD_DEBUG=files output not produced here (not glibc?)';
  } catch (e) { return String(e); } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

test('⛔ `--pass-env LD_*` never reaches a privileged half (unshare, pid 1 bash, the inner node, mount, setpriv) — the COMMAND gets it', needsIsolation, async (t) => {
  if (LD_DEBUG_UNAVAILABLE || !path.isAbsolute(TRUE_BIN)) { t.skip(`SKIP (host): ${LD_DEBUG_UNAVAILABLE || 'no absolute `true`'}`); return; }
  const dir = tmpdir();
  try {
    const r = await run(['isolated', '--keep', dir, '--pass-env', 'LD_*', '--', TRUE_BIN],
      { LD_DEBUG: 'files', LD_DEBUG_OUTPUT: path.join(dir, 'ld') });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const progs = ldPrograms(dir);
    for (const p of ['unshare', 'bash', 'setpriv', 'mount', 'ip', 'ifconfig']) {
      assert.ok(!progs.includes(p), `LD_* reached ${p} (a privileged half): ${[...new Set(progs)].join(' ')}`);
    }
    // the harness itself (the caller's own process) loads it; no OTHER node does
    assert.equal(progs.filter((p) => p === 'node' || p === path.basename(process.execPath)).length, 1, `LD_* reached a node half: ${[...new Set(progs)].join(' ')}`);
    // CONTROL: the command DOES get the passed LD_* (so the arm can fail)
    assert.ok(progs.includes(path.basename(TRUE_BIN)), `the command did not get LD_*: ${[...new Set(progs)].join(' ')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── PATH never picks the binary a PRIVILEGED half runs (re-review of v0.33.0) ──
//
// ⛔ Measured by the re-review: a fake `ip` in the cwd + `PATH=":$PATH" isolated -- true` → the
// fake ran as namespace root, CapEff full, BEFORE the masks, listing the real home. A command can
// write ./ip (or node_modules/.bin/ip — npm PREPENDS that absolute dir) into its writable cwd, and
// the NEXT run executes it privileged. ⇒ every tool a privileged half runs comes from a FIXED
// system dir list, resolved on the host; the COMMAND still gets the caller's PATH.

/** The fixed dirs the harness takes its privileged tools from (SYSTEM_TOOL_DIRS). */
const SYSTEM_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'];
/** Every tool a privileged half runs, today or plausibly tomorrow. */
const PRIV_TOOLS = ['unshare', 'bash', 'mount', 'umount', 'ip', 'ifconfig', 'setpriv', 'getent'];
/** The real system copy of `name`, or ''. @param {string} name */
const systemCopy = (name) => SYSTEM_DIRS.map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) || '';

/**
 * Plant, in `dir`, a fake of every PRIV_TOOLS name that appends `HIT <name>` to `log` and then
 * execs the real one (so a run that uses it still works — and says so), plus `caller-tool`: the
 * CALLER's own tool, which the COMMAND must still find through its PATH.
 * @param {string} dir @param {string} log
 */
function plantFakeTools(dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of PRIV_TOOLS) {
    const real = systemCopy(t);
    fs.writeFileSync(path.join(dir, t), `#!/bin/sh\necho "HIT ${t}" >> ${JSON.stringify(log)}\n`
      + `${real ? `exec ${JSON.stringify(real)} "$@"` : 'exit 127'}\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'caller-tool'), '#!/bin/sh\necho CALLER-TOOL-RAN\n', { mode: 0o755 });
}

/** argv[1] = the PATH the caller gave: `PATH-SAME` when the command got exactly it; then runs `caller-tool` by PATH. */
const CALLER_PATH_PROBE = `const { spawnSync } = require('child_process');
console.log(process.env.PATH === process.argv[1] ? 'PATH-SAME' : 'PATH-CHANGED');
const r = spawnSync('caller-tool', { encoding: 'utf8' });
process.stdout.write(r.stdout || ('CALLER-TOOL-MISSING ' + (r.error && r.error.code) + '\\n'));`;

test('⛔ a tool planted in the cwd (empty / relative PATH entry) or in an absolute dir FIRST on PATH is never run by a privileged half — fresh AND nested; CONTROL: the command still gets the caller\'s PATH and runs its tools', needsIsolation, async () => {
  const dir = tmpdir();
  const log = path.join(dir, 'log', 'hits');
  fs.mkdirSync(path.dirname(log));
  plantFakeTools(path.join(dir, 'work'), log); // the cwd
  plantFakeTools(path.join(dir, 'bin'), log); // an absolute dir (npm's node_modules/.bin shape)
  const hits = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const cases = /** @type {[string, string, string][]} */ ([
    ['empty entry + fakes in the cwd', `:${process.env.PATH}`, path.join(dir, 'work')],
    ['relative entry', `bin:${process.env.PATH}`, dir],
    ['absolute dir first', `${path.join(dir, 'bin')}:${process.env.PATH}`, ROOT],
  ]);
  /** @type {string[]} */
  const ranPlanted = [];
  try {
    for (const [what, PATH, cwd] of cases) {
      for (const nested of [false, true]) {
        fs.rmSync(log, { force: true });
        const label = `${what}, ${nested ? 'nested' : 'fresh'}`;
        // nested: the OUTER call runs with the ordinary PATH; only the inner one gets the planted PATH
        const r = nested
          ? await run(['isolated', '--keep', dir, '--', 'sh', '-c', 'cd "$1" && PATH="$2" exec "$0" "$3" isolated --keep "$4" -- "$0" -e "$5" "$2"',
            process.execPath, cwd, PATH, TOOL, dir, CALLER_PATH_PROBE])
          : await run(['isolated', '--keep', dir, '--', process.execPath, '-e', CALLER_PATH_PROBE, PATH], { PATH }, process.execPath, cwd);
        assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
        if (hits().length) ranPlanted.push(`${label}: ${[...new Set(hits())].join(', ')}`);
        // CONTROL: the command sees the caller's PATH, unchanged, and runs the caller's own tool by it
        assert.match(r.stdout, /^PATH-SAME$/m, `${label}: ${r.stdout}`);
        assert.match(r.stdout, /^CALLER-TOOL-RAN$/m, `${label}: ${r.stdout}${r.stderr}`);
      }
    }
    assert.deepEqual(ranPlanted, [], `a privileged half ran a PATH-planted tool:\n${ranPlanted.join('\n')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ a planted XDG_CACHE_HOME cannot redirect base\'s storage paths out of a temp HOME under `isolated`', needsIsolation, async () => {
  // base's storage paths PREFER XDG_*_HOME over $HOME: a test that set a temp HOME but
  // inherited an exported XDG_CACHE_HOME resolved to the REAL dirs (`perplexity`).
  const home = tmpdir();
  try {
    const sp = pathToFileURL(path.join(ROOT, 'lib', 'storage-paths.js')).href;
    const RESOLVE = `import(${JSON.stringify(sp)}).then((m) => { const p = m.createStoragePaths({ CACHE_DIRNAME: 'probe', PROJECT: 'probe' });
      console.log('ROOTS ' + JSON.stringify([p.cacheRoot, p.configRoot, p.stateRoot])); })`;
    const planted = { HOME: home, XDG_CACHE_HOME: '/nonexistent/real-cache', XDG_CONFIG_HOME: '/nonexistent/real-config',
      XDG_STATE_HOME: '/nonexistent/real-state' };
    const r = await run(['isolated', '--keep', home, '--', process.execPath, '-e', RESOLVE], planted);
    assert.equal(r.status, 0, r.stderr);
    const roots = JSON.parse((r.stdout.match(/^ROOTS (.*)$/m) || [])[1] || '[]');
    assert.equal(roots.length, 3, r.stdout);
    for (const p of roots) assert.ok(p.startsWith(home + path.sep), `resolved outside the temp HOME: ${p}`);
    // control: the same resolver WITHOUT `isolated` follows the planted XDG root
    const c = spawnSync(process.execPath, ['-e', RESOLVE], { encoding: 'utf8', env: cleanEnv(planted) });
    assert.match(c.stdout, /\/nonexistent\/real-cache/, 'CONTROL: without the scrub the planted root wins');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
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

// ── /var/tmp and /dev/shm: private like /tmp (v0.34.0, ib4k §1 row 8) ──────
//
// ⛔ Measured open in v0.33: a file planted in the host's /dev/shm or /var/tmp was readable inside,
// and a write there landed on the host. Each now gets a fresh tmpfs. ⇒ The KEEP RULES are /tmp's
// (ruled in ib4k §1 row 8): a keep BENEATH one is re-bound (writable, or read-only for --keep-ro);
// a keep that IS one, or an ancestor, is a usage error; a cwd beneath one works, a cwd AT one fails.
// The deeper property (planted file absent, writes not visible, fresh/nested/stripped) is row 8 of
// isolation-arm-table.test.js, run in a throwaway world; these arms touch only test-owned subdirs.

/** Test-owned dirs under each REAL scratch dir that exists here, removed by the caller. */
const scratchHomes = () => ['/dev/shm', '/var/tmp'].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
  .map((d) => fs.mkdtempSync(path.join(d, 'harness-iso-')));

test('⭐ a --keep BENEATH /dev/shm or /var/tmp is re-bound WRITABLE (the write lands on the host), --keep-ro read-only; an UNKEPT sibling is invisible', needsIsolation, async (t) => {
  const dirs = scratchHomes();
  if (!dirs.length) { t.skip('SKIP (host): neither /dev/shm nor /var/tmp exists here'); return; }
  try {
    for (const d of dirs) {
      for (const sub of ['rw', 'ro', 'sib']) { fs.mkdirSync(path.join(d, sub)); fs.writeFileSync(path.join(d, sub, 'f'), sub); }
      const probe = `const fs = require('fs'); const p = require('path'); const d = process.argv[1];
const o = (f) => { try { const v = f(); return v === undefined ? 'ok' : String(v); } catch (e) { return e.code; } };
console.log('RW ' + o(() => fs.readFileSync(p.join(d, 'rw', 'f'), 'utf8')) + ' ' + o(() => fs.writeFileSync(p.join(d, 'rw', 'new'), 'x')));
console.log('RO ' + o(() => fs.readFileSync(p.join(d, 'ro', 'f'), 'utf8')) + ' ' + o(() => fs.writeFileSync(p.join(d, 'ro', 'new'), 'x')));
console.log('SIB ' + o(() => fs.readFileSync(p.join(d, 'sib', 'f'), 'utf8')));`;
      const r = await run(['isolated', '--keep', path.join(d, 'rw'), '--keep-ro', path.join(d, 'ro'), '--', process.execPath, '-e', probe, d]);
      const at = path.dirname(d);
      assert.equal(r.status, 0, `${at}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^RW rw ok$/m, `${at}: the --keep is not readable+writable inside`);
      assert.match(r.stdout, /^RO ro EROFS$/m, `${at}: the --keep-ro is not readable-only inside`);
      assert.match(r.stdout, /^SIB ENOENT$/m, `${at}: an UNKEPT dir in the host's ${at} is visible inside`);
      assert.equal(fs.readFileSync(path.join(d, 'rw', 'new'), 'utf8'), 'x', `${at}: the --keep write did not land on the host`);
      assert.equal(fs.existsSync(path.join(d, 'ro', 'new')), false);
      // CONTROL: on the host the sibling IS there — so ENOENT above is the mask
      assert.equal(fs.readFileSync(path.join(d, 'sib', 'f'), 'utf8'), 'sib');
    }
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});

test('⛔ a --keep that IS /dev/shm or /var/tmp → usage 3 (it would undo the mask); a cwd AT one → FAIL; a cwd BENEATH one runs', needsIsolation, async (t) => {
  const dirs = scratchHomes();
  if (!dirs.length) { t.skip('SKIP (host): neither /dev/shm nor /var/tmp exists here'); return; }
  try {
    for (const d of dirs) {
      const at = path.dirname(d);
      const k = await run(['isolated', '--keep', at, '--', process.execPath, '-e', 'console.log("RAN-" + "MARKER")']);
      assert.equal(k.status, 3, `--keep ${at}: ${k.stderr}`);
      assert.match(k.stderr, /keeping it would undo the masking/);
      assert.doesNotMatch(k.stdout, /RAN-MARKER/);
      const c = await run(['isolated', '--', process.execPath, '-e', 'console.log("RAN-" + "MARKER")'], {}, process.execPath, at);
      assert.equal(c.status, 1, `cwd ${at}: ${c.stderr}`);
      assert.match(c.stderr, /the working directory is .* itself, which is masked/);
      assert.doesNotMatch(c.stdout, /RAN-MARKER/);
      // CONTROL: a cwd BENEATH it is re-bound writable, like one under /tmp
      const b = await run(['isolated', '--', process.execPath, '-e', 'require("fs").writeFileSync("w.txt", "w")'], {}, process.execPath, d);
      assert.equal(b.status, 0, `cwd beneath ${at}: ${b.stderr}`);
      assert.equal(fs.readFileSync(path.join(d, 'w.txt'), 'utf8'), 'w');
    }
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
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
    // the cwd is a path the CALLER named: the verdict lists it (as ~/…), it is not merely counted
    const rel = `~/${path.relative(PW_HOME, fs.realpathSync(cwd))}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(r.stderr, new RegExp(`^isolated: home HIDDEN; .*; writable: ${rel}( — |$)`, 'm'), r.stderr);
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
    assert.match(r.stderr, /NOT RUN: the working directory contains the home directory, which isolation HIDES/);
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

test('a CWD inside ~/.cache is noted for what it is — writable because the command runs there, not "at the caller\'s request"; a --keep keeps that wording', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  const cwd = path.join(home, '.cache', 'work');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.cache', 'kept'));
  try {
    const q = await underFakeHome(home, ['sh', '-c', 'cd "$0" && exec "$@"', cwd, process.execPath, TOOL, 'isolated',
      '--keep', path.join(home, '.cache', 'kept'), '--', 'true']);
    if (!q) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(q.status, 0, q.stdout + q.stderr);
    assert.match(q.stderr, /^isolated: note: the working directory is in ~\/\.cache — re-exposed WRITABLE because the command runs there$/m, q.stderr);
    assert.doesNotMatch(q.stderr, /the working directory .*at the caller's request/, q.stderr);
    assert.match(q.stderr, /^isolated: note: --keep #1 is in ~\/\.cache — re-exposed WRITABLE, and its sockets exempt from the socket check, at the caller's request$/m, q.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
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

// ── the secret dot-dirs are HIDDEN, not just read-only ──────────────────────
//
// ⛔ Measured (`perplexity`): the read-only home still let a mutated test READ and print the
// operator's ssh keys, live ControlMaster socket paths, an install salt and target configs
// naming remote hosts. ⇒ ~/.ssh, ~/.gnupg, ~/.cache/CLIAI, ~/.config/CLIAI,
// ~/.local/state/CLIAI and ~/.config/webctl each get an EMPTY, READ-ONLY tmpfs on top.
// ⚠ These arms never plant anything in the real home's dot-dirs: a FAKE passwd home (a
// throwaway dir) is given to the real uid by binding a fake /etc/passwd in a throwaway
// `unshare -rm`, exactly as the passwd-home refusals above do.

/** The planted secrets: [hidden dir, file inside it], relative to the (fake) home. */
const SECRETS = /** @type {[string, string][]} */ ([['.ssh', 'id_test'], ['.gnupg', 'pubring.kbx'],
  ['.cache/CLIAI', 'salt'], ['.config/CLIAI', 'targets.toml'], ['.local/state/CLIAI', 'ledger.json'],
  ['.config/webctl', 'x.toml']]);
/** argv[1] = home: prints `READ <dir> <ok|errno>`; with argv[2] = 'probe' also `DIR <dir> <entries|errno> <create ok|errno>`. */
const READ_SECRETS = `const fs = require('fs'); const p = require('path'); const h = process.argv[1];
for (const [d, f] of ${JSON.stringify(SECRETS)}) {
  let r; try { fs.readFileSync(p.join(h, d, f)); r = 'ok'; } catch (e) { r = e.code; }
  console.log('READ ' + d + ' ' + r);
  if (process.argv[2] !== 'probe') continue;
  let n; try { n = String(fs.readdirSync(p.join(h, d)).length); } catch (e) { n = e.code; }
  let w; try { fs.writeFileSync(p.join(h, d, '.webctl-probe'), 'x', { flag: 'wx' }); w = 'ok'; } catch (e) { w = e.code; }
  console.log('DIR ' + d + ' ' + n + ' ' + w);
}`;
/** @param {string} out @returns {Record<string, string>} dir → READ outcome */
const readsOf = (out) => Object.fromEntries([...out.matchAll(/^READ (\S+) (\S+)$/gm)].map((m) => [m[1], m[2]]));
/** @param {string} out @returns {Record<string, string>} dir → `<entries> <create>` */
const dirsOf = (out) => Object.fromEntries([...out.matchAll(/^DIR (\S+) (\S+ \S+)$/gm)].map((m) => [m[1], m[2]]));

/** A throwaway FAKE passwd home holding every SECRETS file. @returns {string} */
function fakeSecretHome() {
  const home = homeTmpdir();
  for (const [d, f] of SECRETS) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, d, f), 'planted-by-test\n');
  }
  return home;
}

/**
 * Run `argv` with the real uid's passwd home pointed at `home` (a fake /etc/passwd bound in a
 * throwaway `unshare -rm`). Resolves null when the host cannot bind over /etc/passwd or NSS
 * answers for the uid from elsewhere (the caller skips, by name).
 * @param {string} home @param {string[]} argv
 */
async function underFakeHome(home, argv) {
  const dir = tmpdir();
  const pw = path.join(dir, 'passwd');
  fs.writeFileSync(pw, `x:x:${process.getuid?.()}:${process.getgid?.()}::${home}:/bin/sh\n`);
  try {
    const r = await runRaw(['unshare', '-rm', '--propagation=private', 'sh', '-c',
      'mount --bind "$0" /etc/passwd || exit 9; [ "$(getent passwd "$1" | cut -d: -f6)" = "$2" ] || exit 8; shift 2; exec "$@"',
      pw, String(process.getuid?.()), home, ...argv], { cwd: ROOT });
    return r.status === 9 || r.status === 8 ? null : r;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const NO_FAKE_HOME = 'SKIP (host): cannot point the passwd home at a fake one here (bind over /etc/passwd, or NSS answers elsewhere)';

test('⭐ ARM: ~/.ssh, ~/.gnupg and the state roots are ABSENT inside (the home is hidden whole) — fresh AND nested — nothing reaches the fake home', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--', 'sh', '-c',
      '"$0" -e "$2" "$3" probe; echo NESTED; "$0" "$1" isolated -- "$0" -e "$2" "$3"', process.execPath, TOOL, READ_SECRETS, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [fresh, nested] = r.stdout.split(/^NESTED$/m);
    const reads = readsOf(fresh);
    const dirs = dirsOf(fresh);
    for (const [d] of SECRETS) {
      assert.equal(reads[d], 'ENOENT', `${d}: the planted secret is READABLE inside:\n${r.stdout}${r.stderr}`);
      // v0.33.0: under the hidden home the dir does not exist at all (≤ the 4285c61 branch: an empty ro dir)
      assert.equal(dirs[d], 'ENOENT ENOENT', `${d}: the dir is visible inside:\n${r.stdout}`);
      assert.equal(readsOf(nested || '')[d], 'ENOENT', `${d}: readable under a NESTED call:\n${r.stdout}`);
      assert.equal(fs.existsSync(path.join(home, d, '.webctl-probe')), false, `${d}: a write reached the fake home`);
    }
    assert.doesNotMatch(r.stderr, /note:/, 'no keep was given, so nothing should be named');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⭐ CONTROL: the same reads WITHOUT `isolated` (same fake home) succeed — the arm can fail', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  try {
    const r = await underFakeHome(home, [process.execPath, '-e', READ_SECRETS, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    const reads = readsOf(r.stdout);
    for (const [d] of SECRETS) assert.equal(reads[d], 'ok', `CONTROL: ${d} unreadable without isolation:\n${r.stdout}${r.stderr}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⭐ KEEP EXCEPTION: `--keep <home>/.cache/CLIAI` re-exposes THAT dir (named on stderr); the others stay hidden', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--keep', path.join(home, '.cache/CLIAI'), '--',
      process.execPath, '-e', READ_SECRETS, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const reads = readsOf(r.stdout);
    assert.equal(reads['.cache/CLIAI'], 'ok', `the explicit keep was not re-exposed:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /isolated: note: --keep #1 is in ~\/\.cache — re-exposed WRITABLE/);
    for (const [d] of SECRETS.filter(([x]) => x !== '.cache/CLIAI')) assert.equal(reads[d], 'ENOENT', `${d} leaked through another dir's keep`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ a keep BENEATH a hidden dir shows only itself; a keep CONTAINING one does not unhide it; a command beneath one still works', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  const sub = path.join(home, '.config/webctl/fixture');
  const work = path.join(home, '.local/state/CLIAI/work');
  const tool = path.join(home, '.cache/CLIAI/bin/tool.sh');
  fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'f'), 'fixture\n');
  fs.mkdirSync(work);
  fs.mkdirSync(path.dirname(tool)); fs.writeFileSync(tool, '#!/bin/sh\necho "TOOL ran in $(pwd)"\n', { mode: 0o755 });
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--keep', sub, '--keep', path.join(home, '.config'), '--',
      'sh', '-c', 'cat "$0/f"; "$1" -e "$2" "$3"', sub, process.execPath, READ_SECRETS, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixture$/m, `a keep beneath ~/.config/webctl was hidden by its mask:\n${r.stderr}`);
    const reads = readsOf(r.stdout);
    assert.equal(reads['.config/webctl'], 'ENOENT', 'a keep BENEATH ~/.config/webctl re-exposed its siblings');
    assert.equal(reads['.config/CLIAI'], 'ENOENT', 'a keep CONTAINING ~/.config/CLIAI unhid it');
    // an absolute command beneath a hidden dir is re-exposed read-only, not hidden (a cwd there is
    // REFUSED — see the next arm; this one runs from an ordinary dir under the home)
    const plain = path.join(home, 'plain');
    fs.mkdirSync(plain);
    const c = await underFakeHome(home, ['sh', '-c', 'cd "$0" && exec "$@"', plain, process.execPath, TOOL, 'isolated', '--', tool]);
    assert.ok(c);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(c.stdout.trim(), `TOOL ran in ${plain}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ⛔ hiddenGaps exempted EVERY bind at a hidden dir, and the cwd is a WRITABLE bind: a cwd at
// ~/.ssh re-exposed it writable; one beneath ~/.config/webctl re-exposed that subtree writable —
// contrary to "only an explicit --keep re-exposes a hidden dir" (review of 5773fb8, finding 8b).
test('⛔ a cwd AT or BENEATH a hidden dir → FAIL naming the rule and no path, nothing run — CONTROL: an ordinary cwd under the home runs', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  const deep = path.join(home, '.config/webctl/fixture');
  fs.mkdirSync(deep);
  const plain = path.join(home, 'plain');
  fs.mkdirSync(plain);
  const cmd = [process.execPath, '-e', 'require("fs").writeFileSync("RAN-HERE", "x"); console.log("RAN")'];
  try {
    for (const cwd of [path.join(home, '.ssh'), deep]) {
      const r = await underFakeHome(home, ['sh', '-c', 'cd "$0" && exec "$@"', cwd, process.execPath, TOOL, 'isolated', '--', ...cmd]);
      if (!r) { t.skip(NO_FAKE_HOME); return; }
      const what = path.relative(home, cwd);
      assert.equal(r.status, 1, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: the working directory lies inside a HIDDEN dir /m, `${what}: ${r.stderr}`);
      assert.ok(!r.stderr.includes(home), `${what}: the refusal printed a path`);
      assert.doesNotMatch(r.stdout, /^RAN$/m, `${what}: ran`);
      assert.equal(fs.existsSync(path.join(cwd, 'RAN-HERE')), false, `${what}: the command wrote into the hidden dir`);
    }
    const c = await underFakeHome(home, ['sh', '-c', 'cd "$0" && exec "$@"', plain, process.execPath, TOOL, 'isolated', '--', ...cmd]);
    assert.ok(c);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(fs.existsSync(path.join(plain, 'RAN-HERE')), true, 'CONTROL: an ordinary cwd under the home is not writable');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ the post-check exempts ONLY an explicit --keep: base\'s root AT a hidden dir (an implicit re-bind) → refused, nothing run', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  const base = path.join(home, '.config/webctl');
  fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
  fs.copyFileSync(TOOL, path.join(base, 'scripts', 'contract-harness.mjs'));
  const marker = path.join(home, 'RAN');
  try {
    const r = await underFakeHome(home, [process.execPath, path.join(base, 'scripts', 'contract-harness.mjs'), 'isolated', '--',
      process.execPath, '-e', `require('fs').readdirSync(${JSON.stringify(base)}); console.log('SAW-HIDDEN')`]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: after hiding, 1 of \d+ hidden dir\(s\)/m, r.stderr);
    assert.doesNotMatch(r.stdout, /^SAW-HIDDEN$/m, `an implicit re-bind exposed a hidden dir:\n${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ fail closed: a `mount` that silently SKIPS one hide → refused by the post-check (read back from mountinfo), nothing run', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  const binHome = homeTmpdir(); // not under /tmp: the fake must outlive the /tmp mask
  const bin = path.join(binHome, 'bin');
  fs.mkdirSync(bin);
  // ⚠ v0.33.0: under the hidden home, ~/.ssh gets no mount of its own unless a re-bind contains it —
  // so keep ~/.config, whose ~/.config/webctl IS hidden by its own tmpfs on top, and skip THAT
  const skip = path.join(home, '.config', 'webctl');
  // pretends to hide ~/.config/webctl (exit 0, nothing mounted) and to make that non-mask read-only;
  // bound over the system `mount` (PATH is never consulted), the real one reachable at a copy
  const real = realCopyAt(bin, 'mount');
  const fake = path.join(bin, 'mount');
  fs.writeFileSync(fake, `#!/bin/sh
for a in "$@"; do last="$a"; done
[ "$last" = ${JSON.stringify(skip)} ] && exit 0
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
  const marker = path.join(binHome, 'RAN');
  try {
    const r = await withBinds([[MOUNT_BIN, real], ...overTool(fake, 'mount')], [process.execPath, TOOL, 'isolated', '--keep', binHome,
      '--keep', path.join(home, '.config'), '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { home });
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: after hiding, 1 of 7 hidden dir\(s\) \(the home, ~\/\.ssh, ~\/\.gnupg, the state roots\) do not resolve to the read-only 'webctl-isolated-hidden' tmpfs/);
    assert.equal(fs.existsSync(marker), false, 'the command ran with ~/.config/webctl visible');
    assert.ok(!r.stderr.includes(home), 'the refusal printed a home path');
  } finally { for (const d of [home, binHome]) fs.rmSync(d, { recursive: true, force: true }); }
});

// ── the WHOLE passwd home is HIDDEN (v0.33.0, BREAKING) ──────────────────────
//
// ⛔ A fixed hidden list misses every secret nobody listed — a read-only home is still a
// READABLE home. ⇒ an empty read-only tmpfs over the whole passwd home; only what the arm
// needs is re-bound on top: READ-ONLY base's root, node, the absolute command, every PATH
// entry under the home, each `--keep-ro`; WRITABLE the cwd and each `--keep`. ⚠ A FAKE passwd
// home throughout (underFakeHome): nothing here reads or plants anything in the real one.

/** A fake home holding .ssh/config, .config/webctl/config.toml, an ordinary file, a PATH dir and two work dirs. */
function fakeWholeHome() {
  const home = homeTmpdir();
  const put = (/** @type {string} */ rel, /** @type {string} */ txt, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), txt, { mode });
  };
  put('.ssh/config', 'Host planted-by-test\n');
  put('.config/webctl/config.toml', 'planted = "by-test"\n');
  put('notes.txt', 'an ordinary file nobody listed\n');
  put('bin/hello-from-home', '#!/bin/sh\necho "HELLO from a PATH dir under the home"\n', 0o755);
  put('data/ro.txt', 'read-only data\n');
  fs.mkdirSync(path.join(home, 'work'));
  return home;
}
/** argv[1] = home: `R <rel> <ok|errno>` per read; `W <rel> <ok|errno>` per exclusive create. */
const PROBE_HOME = `const fs = require('fs'); const p = require('path'); const h = process.argv[1];
for (const r of ['.ssh/config', '.config/webctl/config.toml', 'notes.txt', 'data/ro.txt']) {
  let o; try { fs.readFileSync(p.join(h, r)); o = 'ok'; } catch (e) { o = e.code; } console.log('R ' + r + ' ' + o); }
for (const w of ['data/new.txt', 'work/new.txt', 'new.txt']) {
  let o; try { fs.writeFileSync(p.join(h, w), 'x', { flag: 'wx' }); o = 'ok'; } catch (e) { o = e.code; } console.log('W ' + w + ' ' + o); }`;
/** @param {string} out @param {'R'|'W'} k @returns {Record<string, string>} */
const probed = (out, k) => Object.fromEntries([...out.matchAll(new RegExp(`^${k} (\\S+) (\\S+)$`, 'gm'))].map((m) => [m[1], m[2]]));

test('⭐ ARM: the WHOLE home is hidden — .ssh/config, .config/webctl/config.toml AND an unlisted file are ENOENT; --keep-ro is readable but EROFS; --keep is writable — fresh AND nested', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--keep-ro', path.join(home, 'data'), '--keep', path.join(home, 'work'), '--',
      'sh', '-c', '"$0" -e "$2" "$3"; echo NESTED; "$0" "$1" isolated -- "$0" -e "$2" "$3"', process.execPath, TOOL, PROBE_HOME, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const [label, out] of r.stdout.split(/^NESTED$/m).map((o, i) => /** @type {[string, string]} */ ([['fresh', 'nested'][i], o]))) {
      const R = probed(out, 'R');
      const W = probed(out, 'W');
      assert.equal(R['.ssh/config'], 'ENOENT', `${label}: ~/.ssh/config readable`);
      assert.equal(R['.config/webctl/config.toml'], 'ENOENT', `${label}: ~/.config/webctl readable`);
      assert.equal(R['notes.txt'], 'ENOENT', `${label}: an UNLISTED file in the home is readable — only the listed dirs are hidden`);
      assert.equal(R['data/ro.txt'], 'ok', `${label}: a --keep-ro path is not readable:\n${r.stderr}`);
      assert.equal(W['data/new.txt'], 'EROFS', `${label}: a --keep-ro path is WRITABLE`);
      assert.equal(W['new.txt'], 'EROFS', `${label}: the hidden home is writable`);
    }
    assert.equal(probed(r.stdout.split(/^NESTED$/m)[0], 'W')['work/new.txt'], 'ok', 'a --keep under the home is not writable');
    assert.equal(fs.readFileSync(path.join(home, 'work', 'new.txt'), 'utf8'), 'x', 'the --keep write did not reach the host');
    assert.equal(fs.existsSync(path.join(home, 'data', 'new.txt')), false);
    assert.equal(fs.existsSync(path.join(home, 'new.txt')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⭐ CONTROL: the same probe WITHOUT `isolated` (same fake home) reads everything and writes everywhere', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  try {
    const r = await underFakeHome(home, [process.execPath, '-e', PROBE_HOME, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    for (const v of Object.values(probed(r.stdout, 'R'))) assert.equal(v, 'ok', r.stdout + r.stderr);
    for (const v of Object.values(probed(r.stdout, 'W'))) assert.equal(v, 'ok', r.stdout + r.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⭐ a PATH dir under the hidden home is re-bound read-only: a script in it RUNS inside; the verdict lists NAMED re-binds as ~/… only', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  try {
    const r = await underFakeHome(home, ['env', `PATH=${path.join(home, 'bin')}:${process.env.PATH}`, process.execPath, TOOL, 'isolated',
      '--keep-ro', path.join(home, 'data'), '--keep', path.join(home, 'work'), '--', 'sh', '-c', 'hello-from-home; ( : > "$0/bin/x" ) 2>/dev/null || echo "BIN-RO"', home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^HELLO from a PATH dir under the home$/m, r.stderr);
    assert.match(r.stdout, /^BIN-RO$/m, 'a PATH dir under the home was re-bound WRITABLE');
    assert.match(r.stderr, /^isolated: home HIDDEN; re-bound read-only: ~\/data, 1 PATH entry; writable: ~\/work — WEBCTL_ISOLATED_VERBOSE=1 lists every path$/m, r.stderr);
    assert.ok(!r.stderr.includes(home), 'the verdict printed the home path');
    // CONTROL: without the PATH entry the same name is not found inside
    const c = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--', 'sh', '-c', 'hello-from-home || echo "NOT-FOUND $?"']);
    assert.ok(c);
    assert.match(c.stdout, /^NOT-FOUND 127$/m, c.stdout + c.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ⛔ The verdict line used to list EVERY `~/…` PATH re-bind — ~95 on an operator host, naming
// private repos — and the gate tees it into logs; base is PUBLIC and its rule is that verdicts
// carry COUNTS, never paths. ⇒ implicit re-binds are COUNTED; only what the caller NAMED (cwd,
// --keep, --keep-ro) is listed; WEBCTL_ISOLATED_VERBOSE=1 lists everything (review of 5773fb8).
test('⛔ the verdict COUNTS implicit PATH re-binds — a distinctive PATH dir name never reaches stderr by default; CONTROL: WEBCTL_ISOLATED_VERBOSE=1 lists it', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  const secretName = 'private-repo-zq7x';
  fs.mkdirSync(path.join(home, secretName, 'bin'), { recursive: true });
  try {
    const argv = (/** @type {string[]} */ pre) => [...pre, 'env', `PATH=${path.join(home, secretName, 'bin')}:${path.join(home, 'bin')}:${process.env.PATH}`,
      process.execPath, TOOL, 'isolated', '--keep-ro', path.join(home, 'data'), '--keep', path.join(home, 'work'), '--', 'sh', '-c', 'hello-from-home'];
    const r = await underFakeHome(home, argv([]));
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^HELLO from a PATH dir under the home$/m, 'the PATH dir was not re-bound (the count would be vacuous)');
    assert.ok(!r.stderr.includes(secretName), `an implicit PATH re-bind was NAMED on stderr:\n${r.stderr}`);
    assert.ok(!r.stderr.includes('~/bin'), `an implicit PATH re-bind was NAMED on stderr:\n${r.stderr}`);
    assert.match(r.stderr, /^isolated: home HIDDEN; re-bound read-only: ~\/data, 2 PATH entries; writable: ~\/work — WEBCTL_ISOLATED_VERBOSE=1 lists every path$/m, r.stderr);
    // CONTROL: the opt-in lists every path (so the default's silence is the fix, not a missing bind)
    const v = await underFakeHome(home, argv(['env', 'WEBCTL_ISOLATED_VERBOSE=1']));
    assert.ok(v);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stderr, new RegExp(`^isolated: home HIDDEN; re-bound read-only: ~/bin, ~/data, ~/${secretName}/bin; writable: ~/work$`, 'm'), v.stderr);
    assert.ok(!v.stderr.includes(home), 'even verbose, the home itself is printed as ~');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// A NESTED `--keep <path under the outer's hidden home>` used to fail "--keep #1 does not exist"
// (exit 3) — true, but it sent people looking for a typo. The path is HIDDEN by the outer call,
// and only the outer call can re-bind it (review of 5773fb8, finding 8a).
// ⛔ GATE REGRESSION (measured): `xq` (base's runtime layer, rx9q) was unusable inside — the
// usual install is ~/.local/bin/xq, a SYMLINK into a git checkout elsewhere under the (hidden)
// home, and xq imports its repo's lib/ ("No module named 'lib'" with only the script re-bound).
// Two private consumers' no-host-literals check went PASS → NO VERDICT / FAIL, and a lane cannot
// fix it under the gate. ⇒ the git root of xq's REAL path is re-bound READ-ONLY — for `xq` ONLY:
// following every PATH symlink would re-expose dozens of repos on an operator host.

/**
 * A fake repo at `<home>/<rel>` (with `.git` unless `git` is false) holding lib/data.txt and an
 * executable bin/<name> that prints that lib file through its OWN real path; `<home>/.local/bin/<name>`
 * symlinks to it. @param {string} home @param {string} rel @param {string} name @param {boolean} [git]
 */
function fakeRepoTool(home, rel, name, git = true) {
  const root = path.join(home, rel);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  if (git) fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'data.txt'), `${name.toUpperCase()}-LIB-READ\n`);
  fs.writeFileSync(path.join(root, 'bin', name), '#!/bin/sh\nd=$(dirname "$(readlink -f "$0")")\ncat "$d/../lib/data.txt"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(root, 'bin', name), path.join(home, '.local', 'bin', name));
  return root;
}
/**
 * The fake ~/.local/bin, then the system dirs ONLY: a real `xq` elsewhere on the caller's PATH must
 * neither answer for the fake (a dangling first candidate falls through to the next) nor run.
 * @param {string} home
 */
const xqPath = (home) => `${path.join(home, '.local', 'bin')}:/usr/bin:/bin`;
/** argv[1] = home, argv[2] = xq's repo, argv[3] = the other repo: runs both tools, tries a write into xq's lib. */
const XQ_PROBE = `const { spawnSync } = require('child_process'); const fs = require('fs'); const p = require('path');
const [h, xr, or] = process.argv.slice(1);
for (const t of ['xq', 'other']) { const r = spawnSync(t, { encoding: 'utf8' }); console.log(t.toUpperCase() + ' ' + (String(r.stdout || '').trim() || ('FAILED ' + (r.error ? r.error.code : r.status)))); }
const o = (f) => { try { f(); return 'ok'; } catch (e) { return e.code; } };
console.log('XQ-WRITE ' + o(() => fs.writeFileSync(p.join(xr, 'lib', 'w-' + process.pid), 'x')));
console.log('OTHER-READ ' + o(() => fs.readFileSync(p.join(or, 'lib', 'data.txt'))));
console.log('SSH ' + o(() => fs.readFileSync(p.join(h, '.ssh', 'id_test'))));`;

test('⛔ xq: a ~/.local/bin/xq SYMLINK into a git checkout under the hidden home → that checkout\'s root is re-bound READ-ONLY (xq runs, nothing writable); another PATH symlink\'s repo stays HIDDEN', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  const xr = fakeRepoTool(home, 'src/xq-checkout', 'xq');
  const or = fakeRepoTool(home, 'src/other-checkout', 'other');
  try {
    const r = await underFakeHome(home, ['env', `PATH=${xqPath(home)}`,
      process.execPath, TOOL, 'isolated', '--', process.execPath, '-e', XQ_PROBE, home, xr, or]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^XQ XQ-LIB-READ$/m, `xq could not read its own repo's lib/ inside:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^XQ-WRITE EROFS$/m, `xq's root is WRITABLE inside:\n${r.stdout}`);
    // CONTROL: the other PATH symlink's repo is NOT followed — it stays hidden
    assert.match(r.stdout, /^OTHER FAILED /m, `another PATH symlink's repo was re-bound:\n${r.stdout}`);
    assert.match(r.stdout, /^OTHER-READ ENOENT$/m, r.stdout);
    assert.match(r.stdout, /^SSH ENOENT$/m, r.stdout);
    // named by LABEL, never by path (the checkout's name is private)
    assert.match(r.stderr, /^isolated: home HIDDEN; re-bound read-only: [^;]*xq's root/m, r.stderr);
    assert.ok(!r.stderr.includes('xq-checkout'), `xq's root was named by path:\n${r.stderr}`);
    // CONTROL: with WEBCTL_ISOLATED_VERBOSE=1 it is listed by path
    const v = await underFakeHome(home, ['env', `PATH=${xqPath(home)}`, 'WEBCTL_ISOLATED_VERBOSE=1',
      process.execPath, TOOL, 'isolated', '--', 'true']);
    assert.ok(v && v.stderr.includes('~/src/xq-checkout'), v ? v.stderr : 'skipped');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ xq: a root that IS, CONTAINS or lies INSIDE a hidden dir (or is the home) is NOT re-bound — said on stderr, no path; the hidden dirs stay hidden', needsIsolation, async (t) => {
  for (const [what, rel] of [['inside ~/.ssh', '.ssh/xq-checkout'], ['containing ~/.config/webctl', '.config'], ['the home itself (a dotfiles repo)', '']]) {
    const home = fakeSecretHome();
    const xr = fakeRepoTool(home, rel, 'xq');
    try {
      const r = await underFakeHome(home, ['env', `PATH=${xqPath(home)}`,
        process.execPath, TOOL, 'isolated', '--', process.execPath, '-e', XQ_PROBE, home, xr, xr]);
      if (!r) { t.skip(NO_FAKE_HOME); return; }
      assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^XQ FAILED /m, `${what}: xq's root was re-bound:\n${r.stdout}`);
      assert.match(r.stdout, /^SSH ENOENT$/m, `${what}: ${r.stdout}`);
      assert.match(r.stderr, /^isolated: note: xq's root .* — NOT re-bound/m, `${what}: ${r.stderr}`);
      assert.ok(!r.stderr.includes(home) && !(rel && r.stderr.includes(rel)), `${what}: a path was printed:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /re-bound read-only: [^;]*xq's root/, `${what}: ${r.stderr}`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

// ⛔ MEASURED by review (v0.33.0, F1): xqRoot took the first `xq` on the CALLER's PATH — npm puts
// the writable `<cwd>/node_modules/.bin` there. A mutated test wrote `node_modules/.bin/xq -> <any
// repo under the home>/<some executable>`, and the NEXT run re-bound that repo's whole git root
// read-only: a private repo went from hidden to 11 entries visible, the verdict saying only "xq's
// root". ⇒ xq is accepted only if no hop of its path (the PATH entry, each symlink, the real file)
// lies somewhere writable inside a run (the cwd, a --keep / --keep-ro, /tmp, TMPDIR, /var/tmp,
// /dev/shm), AND the real file is named exactly `xq` (a mutant can only point at what exists).
/** argv[1] = a repo's root: `SECRET-READ <ok|errno>` for its lib/data.txt. */
const SECRET_PROBE = `const fs = require('fs'); const p = require('path');
let r; try { fs.readFileSync(p.join(process.argv[1], 'lib', 'data.txt')); r = 'ok'; } catch (e) { r = e.code; }
console.log('SECRET-READ ' + r);`;

test('⛔ xq: a planted `xq` in a WRITABLE place (cwd node_modules/.bin, a --keep — relative too, /tmp, an intermediate link in /tmp, a user-writable dir outside the home, `..` through a link) or not named xq → NOT re-bound, the repo it points into stays HIDDEN, a note by LABEL — CONTROL: the ~/.local/bin shape re-binds it', needsIsolation, async (t) => {
  const scratch = tmpdir();
  try {
    /** @type {[string, (home: string, target: string) => {path: string, cwd?: string, keep?: string[], pre?: string}, string][]} */
    const cases = [
      ['cwd node_modules/.bin', (home, target) => {
        const bin = path.join(home, 'proj', 'node_modules', '.bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.symlinkSync(target, path.join(bin, 'xq'));
        return { path: `${bin}:/usr/bin:/bin`, cwd: path.join(home, 'proj') };
      }, 'found in a writable location'],
      ['a --keep dir', (home, target) => {
        const bin = path.join(home, 'kept', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.symlinkSync(target, path.join(bin, 'xq'));
        return { path: `${bin}:/usr/bin:/bin`, keep: ['--keep', path.join(home, 'kept')] };
      }, 'found in a writable location'],
      ['a --keep-ro dir', (home, target) => {
        const bin = path.join(home, 'keptro', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.symlinkSync(target, path.join(bin, 'xq'));
        return { path: `${bin}:/usr/bin:/bin`, keep: ['--keep-ro', path.join(home, 'keptro')] };
      }, 'found in a writable location'],
      ['/tmp', (home, target) => {
        const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
        fs.symlinkSync(target, path.join(bin, 'xq'));
        return { path: `${bin}:/usr/bin:/bin` };
      }, 'found in a writable location'],
      ['an intermediate link in /tmp', (home, target) => {
        const hop = fs.mkdtempSync(path.join(scratch, 'hop-'));
        fs.symlinkSync(target, path.join(hop, 'xq'));
        fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
        fs.symlinkSync(path.join(hop, 'xq'), path.join(home, '.local', 'bin', 'xq'));
        return { path: xqPath(home) };
      }, 'found in a writable location'],
      // F1: a RELATIVE --keep is bound read-write at path.resolve() — it is writable all the same
      ['a RELATIVE --keep dir', (home, target) => {
        const bin = path.join(home, 'sibling', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.mkdirSync(path.join(home, 'proj'));
        fs.symlinkSync(target, path.join(bin, 'xq'));
        return { path: `${bin}:/usr/bin:/bin`, cwd: path.join(home, 'proj'), keep: ['--keep', '../sibling'] };
      }, 'found in a writable location'],
      // F3: a dir OUTSIDE the home the real uid can write (a user-owned /opt/x, /mnt/data) — here
      // a tmpfs over /mnt in the throwaway namespace only, owned by the mapped real uid
      ['a user-writable dir outside the home', (home, target) => ({ path: '/mnt/webctl-test-bin:/usr/bin:/bin',
        pre: `mount -t tmpfs webctl-test-w /mnt && mkdir /mnt/webctl-test-bin && ln -s '${target}' /mnt/webctl-test-bin/xq` }),
      'found in a writable location'],
      // F4: `..` after a symlink resolves PHYSICALLY (the kernel), not lexically (path.resolve): the
      // link below is judged as itself lexically, but resolves through /tmp
      ['a link target with `..` through a symlink into /tmp', (home, target) => {
        const w = fs.mkdtempSync(path.join(scratch, 'dotdot-'));
        fs.mkdirSync(path.join(w, 'd'));
        fs.symlinkSync(target, path.join(w, 'xq'));
        const lb = path.join(home, '.local', 'bin');
        fs.mkdirSync(lb, { recursive: true });
        fs.symlinkSync(path.join(w, 'd'), path.join(lb, 'sym'));
        fs.symlinkSync('sym/../xq', path.join(lb, 'xq'));
        return { path: xqPath(home) };
      }, 'found in a writable location'],
      ['a PATH entry with `..` through a symlink into /tmp', (home, target) => {
        const w = fs.mkdtempSync(path.join(scratch, 'dotdot-'));
        fs.mkdirSync(path.join(w, 'd'));
        fs.symlinkSync(target, path.join(w, 'xq'));
        const lb = path.join(home, '.local', 'bin');
        fs.mkdirSync(lb, { recursive: true });
        fs.symlinkSync(path.join(w, 'd'), path.join(lb, 'sym'));
        return { path: `${path.join(lb, 'sym')}/..:/usr/bin:/bin` };
      }, 'found in a writable location'],
      ['a link named xq whose target is not', (home, target) => {
        fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
        fs.symlinkSync(target, path.join(home, '.local', 'bin', 'xq'));
        return { path: xqPath(home) };
      }, 'not named xq'],
    ];
    for (const [what, plant, label] of cases) {
      const home = fakeSecretHome();
      try {
        // the target: an EXISTING executable in a private git repo under the home
        const repo = path.join(home, 'src', 'secret-checkout');
        fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
        fs.mkdirSync(path.join(repo, '.git'));
        fs.mkdirSync(path.join(repo, 'bin'));
        fs.writeFileSync(path.join(repo, 'lib', 'data.txt'), 'private\n');
        const exe = path.join(repo, 'bin', label === 'not named xq' ? 'some-tool' : 'xq');
        fs.writeFileSync(exe, '#!/bin/sh\necho hi\n', { mode: 0o755 });
        const pl = plant(home, exe);
        const r = await underFakeHome(home, ['sh', '-c', `${pl.pre || ':'} && cd "$0" && exec "$@"`, pl.cwd || ROOT, 'env', `PATH=${pl.path}`,
          process.execPath, TOOL, 'isolated', ...(pl.keep || []), '--', process.execPath, '-e', SECRET_PROBE, repo]);
        if (!r) { t.skip(NO_FAKE_HOME); return; }
        assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /^SECRET-READ ENOENT$/m, `${what}: the repo a planted xq points into was RE-BOUND:\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, new RegExp(`^isolated: note: xq ignored: ${label}`, 'm'), `${what}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /xq's root/, `${what}: ${r.stderr}`);
        assert.ok(!r.stderr.includes(home) && !r.stderr.includes('secret-checkout') && !r.stderr.includes(scratch), `${what}: a path was printed:\n${r.stderr}`);
        // CONTROL: the same repo through the legitimate shape (a read-only ~/.local/bin/xq → <repo>/bin/xq) IS re-bound
        if (label !== 'not named xq') {
          fs.rmSync(path.join(home, '.local', 'bin', 'xq'), { force: true });
          fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
          fs.symlinkSync(exe, path.join(home, '.local', 'bin', 'xq'));
          const c = await underFakeHome(home, ['env', `PATH=${xqPath(home)}`,
            process.execPath, TOOL, 'isolated', '--', process.execPath, '-e', SECRET_PROBE, repo]);
          assert.ok(c);
          assert.match(c.stdout, /^SECRET-READ ok$/m, `${what} CONTROL: the legitimate shape no longer re-binds:\n${c.stdout}${c.stderr}`);
          assert.doesNotMatch(c.stderr, /xq ignored/, `${what} CONTROL: ${c.stderr}`);
        }
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('⛔ a NESTED --keep / --keep-ro under the OUTER call\'s hidden home → usage 3 saying the OUTER call hides it (no path) — CONTROL: kept by the outer, it works', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  const work = path.join(home, 'work');
  const nested = (/** @type {string} */ opt) => ['"$0" "$1" isolated', opt, '"$2" -- "$0" -e "console.log(\'NESTED-RAN\')"'].join(' ');
  try {
    for (const opt of ['--keep', '--keep-ro']) {
      const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--', 'sh', '-c', nested(opt), process.execPath, TOOL, work]);
      if (!r) { t.skip(NO_FAKE_HOME); return; }
      assert.equal(r.status, 3, `${opt}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`^FAIL {2}isolated: NOT RUN \\(usage\\): ${opt} #1 lies under a dir the OUTER \`isolated\` call HIDES`, 'm'), `${opt}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /does not exist/, `${opt}: still the misleading reason`);
      assert.ok(!r.stderr.includes(home), `${opt}: the refusal printed a path`);
      assert.doesNotMatch(r.stdout, /^NESTED-RAN$/m);
      // CONTROL: the same nested keep, with the OUTER call keeping it → runs
      const c = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--keep', work, '--', 'sh', '-c', nested(opt), process.execPath, TOOL, work]);
      assert.ok(c);
      assert.equal(c.status, 0, `${opt} CONTROL: ${c.stdout}${c.stderr}`);
      assert.match(c.stdout, /^NESTED-RAN$/m);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ base\'s root UNDER the hidden home is re-bound READ-ONLY (the harness runs from it; a write is EROFS)', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  const base = path.join(home, 'base-copy');
  fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
  fs.copyFileSync(TOOL, path.join(base, 'scripts', 'contract-harness.mjs'));
  try {
    const r = await underFakeHome(home, [process.execPath, path.join(base, 'scripts', 'contract-harness.mjs'), 'isolated', '--',
      process.execPath, '-e', TRY_CREATE, path.join(base, 'x')]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(writeOf(r.stdout), 'EROFS', 'base\'s root under the home is writable inside');
    // base's root is not a path the caller named: it is named by its LABEL, never by its path
    assert.match(r.stderr, /^isolated: home HIDDEN; re-bound read-only: base's repo root; writable: nothing — WEBCTL_ISOLATED_VERBOSE=1 lists every path$/m, r.stderr);
    assert.equal(fs.existsSync(path.join(base, 'x')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ REFUSED, naming the rule and NO path: a PATH entry or --keep-ro that IS the home, contains a hidden dir, or lies inside one', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  const marker = path.join(home, 'work', 'RAN');
  const cmd = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
  try {
    const cases = /** @type {[string, string[], number, RegExp][]} */ ([
      ['PATH = the home', ['env', `PATH=${home}:${process.env.PATH}`], 1, /PATH entry #1 is the home directory/],
      ['PATH inside ~/.ssh', ['env', `PATH=${path.join(home, '.ssh')}:${process.env.PATH}`], 1, /PATH entry #1 lies inside a HIDDEN dir/],
      ['PATH containing ~/.config/webctl', ['env', `PATH=${path.join(home, '.config')}:${process.env.PATH}`], 1, /PATH entry #1 contains a HIDDEN dir/],
    ]);
    for (const [what, pre, code, msg] of cases) {
      const r = await underFakeHome(home, [...pre, process.execPath, TOOL, 'isolated', '--keep', path.join(home, 'work'), '--', ...cmd]);
      if (!r) { t.skip(NO_FAKE_HOME); return; }
      assert.equal(r.status, code, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, msg, what);
      assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN/m, what);
      assert.ok(!r.stderr.includes(home), `${what}: the refusal printed the path`);
      assert.equal(fs.existsSync(marker), false, `${what}: ran`);
    }
    for (const [what, ro, msg] of /** @type {[string, string, RegExp][]} */ ([
      ['--keep-ro = the home', home, /--keep-ro #1 is the home directory/],
      ['--keep-ro inside ~/.ssh', path.join(home, '.ssh'), /--keep-ro #1 lies inside a HIDDEN dir/],
      ['--keep-ro containing ~/.config/webctl', path.join(home, '.config'), /--keep-ro #1 contains a HIDDEN dir/]])) {
      const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--keep-ro', ro, '--keep', path.join(home, 'work'), '--', ...cmd]);
      assert.ok(r);
      assert.equal(r.status, 3, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, msg, what);
      assert.ok(!r.stderr.includes(home), `${what}: the refusal printed the path`);
      assert.equal(fs.existsSync(marker), false, `${what}: ran`);
    }
    // CONTROL: an ordinary PATH dir and --keep-ro under the home are accepted
    const c = await underFakeHome(home, ['env', `PATH=${path.join(home, 'bin')}:${process.env.PATH}`, process.execPath, TOOL, 'isolated',
      '--keep-ro', path.join(home, 'data'), '--keep', path.join(home, 'work'), '--', ...cmd]);
    assert.ok(c);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(fs.existsSync(marker), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ PEEL: a NESTED `unshare -rm` inside cannot unmount the hidden home (locked) — CONTROL: with capabilities over a plain tmpfs it can', needsIsolation, async (t) => {
  const home = fakeWholeHome();
  const PEEL = 'unshare -rm sh -c \'echo NESTED-IN; umount -l "$0"; echo "UMOUNT $?"; umount -l "$0"; cat "$0/.ssh/config" >/dev/null 2>&1; echo "CAT $?"\' "$0"';
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--', 'sh', '-c', PEEL, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^NESTED-IN$/m, `the nested namespace was not even made (vacuous):\n${r.stderr}`);
    assert.match(r.stdout, /^UMOUNT [1-9]\d*$/m, 'a nested namespace could unmount the hidden home');
    assert.match(r.stdout, /^CAT [1-9]\d*$/m, '~/.ssh/config became readable after a nested unmount');
    // CONTROL: namespace root WITH capabilities, over a tmpfs it mounted itself, peels it
    const c = await underFakeHome(home, ['unshare', '-rm', 'sh', '-c',
      'mount -t tmpfs t "$0" && { cat "$0/.ssh/config" >/dev/null 2>&1; echo "BEFORE $?"; } && umount -l "$0"; echo "UMOUNT $?"; cat "$0/.ssh/config" >/dev/null 2>&1; echo "CAT $?"', home]);
    assert.ok(c);
    assert.match(c.stdout, /^BEFORE [1-9]\d*$/m, c.stdout + c.stderr);
    assert.match(c.stdout, /^UMOUNT 0$/m, c.stdout + c.stderr);
    assert.match(c.stdout, /^CAT 0$/m, c.stdout + c.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
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
      // v0.33.0: the home is hidden, so the dir comes back as a READ-ONLY re-bind — and that re-bind's
      // submounts must be ro too (the rbind copies them writable)
      `"${process.execPath}" "${TOOL}" isolated --keep-ro "$0" -- "${process.execPath}" "$0/try.cjs" "$0/sub/f"`);
    assert.equal(writeOf(r.stdout), 'EROFS', `a submount under home stayed writable:\n${r.stdout}${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the submount LOGIC, from an explicit mountinfo (no host dependency) ──────

const { parseMountinfo, reachableMountsUnder, readOnlyGaps, hiddenGaps, resolveMount } = await import(pathToFileURL(TOOL).href);

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

// ⛔ Measured while fixing the stripped-markers carry: a call nested in `isolated` masks /tmp AGAIN,
// and a re-bind at a path the OUTER call had a mount at leaves TWO stacks at that path — the
// outer's, under the old (now shadowed) /tmp, and ours, under the new one. Walking both reported
// the unreachable outer one as "still WRITABLE": a false FAIL of base's own read-only root.
test('⭐ logic: a stack at the same path whose ANCESTOR is shadowed (a re-masked /tmp) is not reachable — only the live one is checked', () => {
  const mounts = parseMountinfo([
    mi(1, 0, '/'),
    mi(10, 1, '/tmp'), // the OUTER call's /tmp mask
    mi(20, 10, '/tmp/x/root'), // the outer's writable re-bind — shadowed once /tmp is masked again
    mi(30, 10, '/tmp'), // OUR /tmp mask, stacked on the outer's
    mi(40, 30, '/tmp/x/root', 'ro,relatime'), // our read-only re-bind, moved in under the new /tmp
    mi(41, 40, '/tmp/x/root/sub'), // a writable submount of OURS — reachable, and a gap
  ].join('\n'));
  assert.deepEqual(reachableMountsUnder(mounts, '/tmp/x/root').map((/** @type {any} */ m) => m.id), ['40', '41']);
  assert.deepEqual(readOnlyGaps(mounts, ['/tmp/x/root'], []), [{ root: '/tmp/x/root', at: '/tmp/x/root/sub' }]);
  // CONTROL: with OUR /tmp mask gone, the outer's stack is the live one again
  const noRemask = mounts.filter((/** @type {any} */ m) => !['30', '40', '41'].includes(m.id));
  assert.deepEqual(reachableMountsUnder(noRemask, '/tmp/x/root').map((/** @type {any} */ m) => m.id), ['20']);
});

const { outerRebinds } = await import(pathToFileURL(TOOL).href);
/** One mountinfo line with a SOURCE. @param {number} id @param {number} parent @param {string} at @param {string} o @param {string} src */
const mis = (id, parent, at, o, src) => `${id} ${parent} 0:${id} / ${at} ${o} shared:1 - tmpfs ${src} rw`;

test('⭐ logic: outerRebinds carries what an OUTER call re-bound (same modes), only with the PROOF — our masks on /run and /tmp AND our read-only hide AT the home', () => {
  const H = '/home/u';
  const lines = [
    mis(1, 0, '/', 'rw', 'root'),
    mis(2, 1, '/home', 'rw', 'disk'), // the home's PARENT: never carried
    mis(10, 1, '/run', 'rw', 'webctl-isolated'),
    mis(11, 1, '/tmp', 'rw', 'webctl-isolated'),
    mis(12, 2, H, 'ro', 'webctl-isolated-hidden'), // the outer's hide of the home
    mis(20, 12, `${H}/keep-rw`, 'rw', 'disk'),
    mis(21, 12, `${H}/keep-ro`, 'ro', 'disk'),
    mis(22, 20, `${H}/keep-rw/.config/webctl`, 'ro', 'webctl-isolated-hidden'), // a hide: re-made, not carried
    mis(23, 12, `${H}/gone`, 'rw', 'disk'),
    mis(24, 23, `${H}/gone`, 'ro', 'disk'), // stacked over 23: only the top (24) is visible
    mis(30, 11, '/tmp/work', 'rw', 'disk'), // the outer's cwd under its /tmp mask
  ];
  const ok = outerRebinds(parseMountinfo(lines.join('\n')), H, ['/run', '/tmp'], '/tmp');
  assert.deepEqual(ok, [{ p: `${H}/keep-rw`, rw: true }, { p: `${H}/keep-ro`, rw: false }, { p: `${H}/gone`, rw: false },
    { p: '/tmp/work', rw: true }]);
  // ⛔ NO PROOF, NOTHING CARRIED: the home not hidden (a plain mount there), our tag missing on /tmp, a
  // hide that is not read-only, or a hide stacked UNDER something else at the home
  const without = (/** @type {number} */ id, /** @type {string} */ line = '') => parseMountinfo(lines.map((l) => (l.startsWith(`${id} `) ? line : l)).filter(Boolean).join('\n'));
  assert.equal(outerRebinds(without(12, mis(12, 2, H, 'ro', 'disk')), H, ['/run', '/tmp'], '/tmp'), null, 'home not hidden by us');
  assert.equal(outerRebinds(without(11, mis(11, 1, '/tmp', 'rw', 'tmpfs')), H, ['/run', '/tmp'], '/tmp'), null, '/tmp not ours');
  assert.equal(outerRebinds(without(12, mis(12, 2, H, 'rw', 'webctl-isolated-hidden')), H, ['/run', '/tmp'], '/tmp'), null, 'hide not ro');
  assert.equal(outerRebinds(parseMountinfo([...lines, mis(40, 12, H, 'rw', 'disk')].join('\n')), H, ['/run', '/tmp'], '/tmp'), null,
    'something on top of the hide AT the home');
  assert.equal(outerRebinds(parseMountinfo(lines.join('\n')), '', ['/run', '/tmp'], '/tmp'), null, 'no home');
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

test('⭐ logic: hiddenGaps — a hidden dir passes only with OUR read-only tmpfs on TOP (or a keep exactly there)', () => {
  /** @param {number} id @param {number} parent @param {string} at @param {string} o @param {string} src */
  const row = (id, parent, at, o, src) => `${id} ${parent} 0:${id} / ${at} ${o},relatime shared:1 - tmpfs ${src} rw`;
  const base = [mi(1, 0, '/'), mi(100, 1, '/home/u')];
  const m = (/** @type {string[]} */ extra) => parseMountinfo([...base, ...extra].join('\n'));
  const H = '/home/u/.ssh';
  assert.deepEqual(hiddenGaps(m([row(200, 100, H, 'ro', 'webctl-isolated-hidden')]), [H], []), []);
  assert.deepEqual(hiddenGaps(m([row(200, 100, H, 'rw', 'webctl-isolated-hidden')]), [H], []), [H], 'a WRITABLE mask is a gap');
  assert.deepEqual(hiddenGaps(m([row(200, 100, H, 'ro', 'other')]), [H], []), [H], 'someone else\'s tmpfs is a gap');
  assert.deepEqual(hiddenGaps(m([]), [H], []), [H], 'no mask at all is a gap');
  assert.deepEqual(hiddenGaps(m([row(200, 100, H, 'ro', 'webctl-isolated-hidden'), row(201, 200, H, 'rw', 'x')]), [H], []), [H],
    'a mount stacked ON TOP of the mask re-exposes something — a gap unless it is a keep');
  assert.deepEqual(hiddenGaps(m([row(200, 100, H, 'ro', 'webctl-isolated-hidden'), row(201, 200, H, 'rw', 'x')]), [H], [H]), [],
    'a keep exactly at the hidden dir is the caller\'s exception');
  assert.deepEqual(hiddenGaps(m([row(200, 100, '/home/u/.sshx', 'ro', 'webctl-isolated-hidden')]), [H], []), [H], 'a PREFIX is not the dir');
});

test('⭐ logic: hiddenGaps RESOLVES the path — a later mount on an ANCESTOR shadows a hide (review finding 7); a dir under the hidden home is covered by the home\'s mask', () => {
  /** @param {number} id @param {number} parent @param {string} at @param {string} o @param {string} src */
  const row = (id, parent, at, o, src) => `${id} ${parent} 0:${id} / ${at} ${o},relatime shared:1 - tmpfs ${src} rw`;
  const HIDE = 'webctl-isolated-hidden';
  const m = (/** @type {string[]} */ extra) => parseMountinfo([mi(1, 0, '/'), mi(30, 1, '/home'), ...extra].join('\n'));
  const W = '/home/u/.config/webctl';
  // the hidden home (100), a writable keep of ~/.config on it (150), webctl's own hide on that (200)
  const good = [row(100, 30, '/home/u', 'ro', HIDE), row(150, 100, '/home/u/.config', 'rw', 'keep'), row(200, 150, W, 'ro', HIDE)];
  assert.deepEqual(hiddenGaps(m(good), ['/home/u', W, '/home/u/.ssh'], ['/home/u/.config']), [],
    '~/.ssh (no mount of its own) resolves to the home\'s mask');
  assert.equal(resolveMount(m(good), '/home/u/.ssh/id').id, '100');
  assert.equal(resolveMount(m(good), `${W}/x`).id, '200');
  // ⛔ a LATER mount on the ANCESTOR ~/.config (stacked on the keep) — webctl's hide is still on top of ITS
  // stack, so the old top-of-stack-at-the-path check passed; the path now resolves past it
  const shadowed = [...good, row(300, 150, '/home/u/.config', 'rw', 'later')];
  assert.deepEqual(hiddenGaps(m(shadowed), [W], ['/home/u/.config']), [W], 'an ancestor mount shadowed the hide');
  const atPath = parseMountinfo([mi(1, 0, '/'), mi(30, 1, '/home'), ...shadowed].join('\n')).filter((r) => r.at === W);
  assert.equal(atPath[atPath.length - 1].source, HIDE, 'CONTROL: at the path itself the hide IS still the top of its stack');
  // …and a later mount on the HOME (shadowing everything under it)
  assert.deepEqual(hiddenGaps(m([...good, row(400, 100, '/home/u', 'rw', 'later')]), ['/home/u', '/home/u/.ssh'], []), ['/home/u', '/home/u/.ssh']);
  // a keep re-binding ~/.config WITHOUT webctl's own hide → webctl resolves to the keep: a gap
  assert.deepEqual(hiddenGaps(m(good.slice(0, 2)), [W], ['/home/u/.config']), [W]);
});

// ── nesting: the previous `isolated` (writable home) is not "inside" ─────────

test('⛔ nesting: every OLD fact satisfied (netns, mntns, our tmpfs on /run+/tmp) but home WRITABLE → refused by the home fact alone', needsIsolation, async () => {
  // What the PREVIOUS `isolated` produced: a full mask, no read-only home.
  const stage = 'mount -t tmpfs webctl-isolated /run && mkdir /run/k && mount --rbind "$0" /run/k'
    + ' && { [ -L /var/run ] || mount -t tmpfs webctl-isolated /var/run; }'
    + ' && mount -t tmpfs webctl-isolated /tmp' + SCRATCH_MASKS + ' && mkdir -p "$0" && mount --move /run/k "$0" && exec "$@"';
  const r = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--propagation=private', 'sh', '-c', stage, ROOT],
    'mnt:[1]', { WEBCTL_RO_ROOTS: JSON.stringify([PW_HOME]), WEBCTL_HOST_PIDNS: 'pid:[1]', WEBCTL_HIDDEN_DIRS: '[]' });
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

/**
 * Run `isolated --keep <dir> -- <write a marker>` after the `binds` (fake tools over the system
 * ones, withBinds); resolve with the result + whether it ran, or null (skip) when binds are impossible.
 * @param {string} dir @param {[string, string][]} binds
 */
async function markerRun(dir, binds) {
  const marker = path.join(dir, 'RAN');
  const r = await withBinds(binds, [process.execPath, TOOL, 'isolated', '--keep', dir, '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
  return r && { ...r, ran: fs.existsSync(marker) };
}
const which = (/** @type {string} */ b) => spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim();

test('⛔ fail closed: no `setpriv` in the system dirs → FAIL naming it, command NOT run (never with capabilities)', needsIsolation, async (t) => {
  const dir = tmpdir();
  try {
    const r = await markerRun(dir, overTool(noexecFile(dir), 'setpriv'));
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: no isolation backend can be used here — unshare: cannot enter the uid-mapped child user namespace: 'setpriv' not found in \/usr\/sbin, \/usr\/bin, \/sbin, \/bin/);
    assert.equal(r.ran, false, 'the command ran with capabilities');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: a `setpriv` that ignores its flags (runs its argv as-is) → FAIL naming NoNewPrivs, command NOT run', needsIsolation, async (t) => {
  const dir = tmpdir();
  const fake = path.join(dir, 'setpriv');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
  try {
    const r = await markerRun(dir, overTool(fake, 'setpriv'));
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /after entering the uid-mapped child user namespace, NoNewPrivs is not set/);
    assert.equal(r.ran, false, 'the command ran without no_new_privs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: a too-old `unshare` (no --map-user) → FAIL naming util-linux, command NOT run, no id printed', needsIsolation, async (t) => {
  // the fake (over the system unshare) passes every OTHER call — the outer -rnm, made on the host
  // side before any mask — to the real one, reachable at a copy
  const dir = tmpdir();
  const real = realCopyAt(dir, 'unshare');
  const fake = path.join(dir, 'unshare');
  fs.writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in --map-user*) echo "unshare: unrecognized option '$a'" >&2; exit 1;; --) break;; esac; done
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
  try {
    const r = await markerRun(dir, [[systemCopy('unshare'), real], ...overTool(fake, 'unshare')]);
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: cannot enter the uid-mapped child user namespace: .* exited 1 .*util-linux ≥ 2\.38/);
    assert.ok(!new RegExp(`\\b${process.getuid?.()}\\b`).test(r.stderr), 'the refusal printed the real uid');
    assert.equal(r.ran, false, 'the command ran without the child user namespace');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ fail closed: an `unshare` that accepts --map-user but makes NO child namespace → FAIL (the property is read back)', needsIsolation, async (t) => {
  const dir = tmpdir();
  const real = realCopyAt(dir, 'unshare');
  const fake = path.join(dir, 'unshare');
  fs.writeFileSync(fake, `#!/bin/sh
case " $* " in *" --map-user "*) while [ "$1" != "--" ]; do shift; done; shift; exec "$@";; esac
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
  try {
    const r = await markerRun(dir, [[systemCopy('unshare'), real], ...overTool(fake, 'unshare')]);
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /after entering the uid-mapped child user namespace, it would still hold CapPrm, CapEff; its uid\/gid are not the real ones; its uid_map\/gid_map are not exactly the one expected mapping/);
    assert.equal(r.ran, false, 'the command ran as namespace root');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── STRIPPED markers, and an outer older than v0.33.0 ────────────────────────
//
// The markers are the only thing that makes a call take the nested path. A command that strips
// them (`env -u`, `env -i`) must never get "only inherited isolation" — and it does not: with no
// HOST_NETNS the call takes the FRESH path, inside, and isolates AGAIN (measured: a new netns and
// pidns, the home hidden again, the kernel proof PASSes). The kernel alone says where it is: our
// tmpfs tag on /run and /tmp plus a lo-only network ⇒ the verdict states "already inside".

const ALL_MARKERS = ['WEBCTL_HOST_NETNS', 'WEBCTL_HOST_MNTNS', 'WEBCTL_HOST_PIDNS', 'WEBCTL_RO_ROOTS', 'WEBCTL_HIDDEN_DIRS', 'WEBCTL_HOST_IDS'];
const STRIP = ALL_MARKERS.map((k) => `-u ${k}`).join(' ');

test('⛔ STRIPPED markers inside `isolated` → the call isolates AGAIN, fully (fresh path: own netns, kernel proof holds) and SAYS it is already inside', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c',
    `readlink /proc/self/ns/net; env ${STRIP} "$0" "$1" isolated -- sh -c 'echo "INNER $(readlink /proc/self/ns/net)"; env | grep -c "^WEBCTL_HOST_" ; "$0" "$1" isolation-check 1 >/dev/null && echo PROOF-OK' "$0" "$1"; echo "RC $?"`,
    process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^RC 0$/m, r.stdout + r.stderr);
  const outer = r.stdout.split('\n')[0];
  const inner = (r.stdout.match(/^INNER (\S+)$/m) || [])[1];
  assert.ok(inner && inner !== outer, `the stripped call did not make its own network namespace (only inherited):\n${r.stdout}`);
  assert.match(r.stdout, /^PROOF-OK$/m, `the kernel proof failed after a stripped re-isolation:\n${r.stderr}`);
  assert.match(r.stderr, /^isolated: home HIDDEN; .*; ALREADY INSIDE an isolated namespace whose markers were stripped — isolated AGAIN, fully, keeping what the outer call re-bound \(same modes\); backend: unshare( — WEBCTL_ISOLATED_VERBOSE=1 lists every path)?$/m, r.stderr);
  // CONTROL: from the host the verdict does not claim it
  const c = await run(['isolated', '--', 'true']);
  assert.equal(c.status, 0, c.stderr);
  assert.doesNotMatch(c.stderr, /ALREADY INSIDE/);
});

// ⛔ GATE REGRESSION (measured on the release gate): a call whose markers were stripped takes the
// FRESH path inside and HID THE HOME AGAIN — so what the OUTER call had re-bound under it (the
// gate keeps the consumer repo and its run home; the outer's cwd) vanished: a consumer suite
// failed 8 tests with "Cannot find module '<repo under ~/.cache>/…'". ⇒ when the KERNEL shows we
// are inside an `isolated` sandbox, the fresh hide re-binds what the outer had visible under the
// home (and under its /tmp), each with the SAME mode — never more.

/** argv[1] = the fake home: RW/RO reads and creates in keep-rw / keep-ro, and a read of ~/.ssh/id_test. */
const OUTER_KEEP_PROBE = `const fs = require('fs'); const p = require('path'); const h = process.argv[1];
const o = (f) => { try { f(); return 'ok'; } catch (e) { return e.code; } };
console.log('RW-READ ' + o(() => fs.readFileSync(p.join(h, 'keep-rw', 'f'))));
console.log('RW-WRITE ' + o(() => fs.writeFileSync(p.join(h, 'keep-rw', 'new-' + process.pid), 'x')));
console.log('RO-READ ' + o(() => fs.readFileSync(p.join(h, 'keep-ro', 'f'))));
console.log('RO-WRITE ' + o(() => fs.writeFileSync(p.join(h, 'keep-ro', 'new-' + process.pid), 'x')));
console.log('SSH ' + o(() => fs.readFileSync(p.join(h, '.ssh', 'id_test'))));
console.log('SUB ' + o(() => fs.readFileSync(p.join(h, 'sub', 'f'))));`;
/** @param {string} out @returns {Record<string, string>} */
const probeOf = (out) => Object.fromEntries([...out.matchAll(/^(RW-READ|RW-WRITE|RO-READ|RO-WRITE|SSH|SUB) (\S+)$/gm)].map((m) => [m[1], m[2]]));

// ⛔ GATE REGRESSION (measured by the lead: 8 of a consumer lane's 10 gate failures): the hide
// tmpfs was mode 0555, so access(home, W_OK) answered EACCES — DAC runs before the read-only
// check — not EROFS. A ≤ v0.32 harness nested with its markers stripped records the home as a
// read-only ROOT and judges it by access(W_OK): anything but EROFS/ENOENT is "WRITABLE" →
// "1 of 1 protected root(s) — the home directory — are WRITABLE here". ≤ v0.32's read-only home
// answered EROFS. ⇒ the hides are owner-writable in their MODE, read-only by their MOUNT.
/** argv[1] = home: access(W_OK) and a create, on the home and on a hidden dir kept-around (~/.config/webctl). */
const HOME_WRITE_PROBE = `const fs = require('fs'); const p = require('path'); const h = process.argv[1];
const o = (f) => { try { f(); return 'ok'; } catch (e) { return e.code; } };
console.log('HOME-ACCESS ' + o(() => fs.accessSync(h, fs.constants.W_OK)));
console.log('HOME-CREATE ' + o(() => fs.writeFileSync(p.join(h, 'probe-' + process.pid), 'x', { flag: 'wx' })));
console.log('HIDE-ACCESS ' + o(() => fs.accessSync(p.join(h, '.config', 'webctl'), fs.constants.W_OK)));
console.log('HIDE-CREATE ' + o(() => fs.writeFileSync(p.join(h, '.config', 'webctl', 'probe-' + process.pid), 'x', { flag: 'wx' })));`;

test('⛔ the hidden home (and a hidden dir) answer a write CHECK with EROFS, like a read-only home — not EACCES — fresh AND nested', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  try {
    // --keep ~/.config: ~/.config/webctl then gets its OWN hide tmpfs (it is under a re-bind)
    const r = await underFakeHome(home, ['sh', '-c', '"$0" "$1" isolated --keep "$2/.config" -- sh -c \'"$0" -e "$1" "$2"; '
      + '"$0" "$3" isolated -- "$0" -e "$1" "$2"\' "$0" "$3" "$2" "$1"', process.execPath, TOOL, home, HOME_WRITE_PROBE]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.split('\n').filter((l) => /^(HOME|HIDE)-/.test(l));
    assert.deepEqual(lines, ['HOME-ACCESS EROFS', 'HOME-CREATE EROFS', 'HIDE-ACCESS EROFS', 'HIDE-CREATE EROFS',
      'HOME-ACCESS EROFS', 'HOME-CREATE EROFS', 'HIDE-ACCESS EROFS', 'HIDE-CREATE EROFS'], `${r.stdout}${r.stderr}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ STRIPPED markers under an outer that re-bound paths under the home: the inner call KEEPS them, same mode (rw stays rw, ro stays ro); ~/.ssh stays hidden', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  for (const d of ['keep-rw', 'keep-ro']) { fs.mkdirSync(path.join(home, d)); fs.writeFileSync(path.join(home, d, 'f'), 'x'); }
  const scratch = tmpdir(); // the inner call's cwd: kept by the outer, NOT under the home
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--keep', path.join(home, 'keep-rw'),
      '--keep-ro', path.join(home, 'keep-ro'), '--keep', scratch, '--', 'sh', '-c',
      `cd "$1" && env ${STRIP} "$0" "$2" isolated -- "$0" -e "$3" "$4"`, process.execPath, scratch, TOOL, OUTER_KEEP_PROBE, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /ALREADY INSIDE an isolated namespace whose markers were stripped/, 'premise: the inner call took the fresh path');
    assert.deepEqual(probeOf(r.stdout), { 'RW-READ': 'ok', 'RW-WRITE': 'ok', 'RO-READ': 'ok', 'RO-WRITE': 'EROFS', SSH: 'ENOENT', SUB: 'ENOENT' },
      `${r.stdout}${r.stderr}`);
    // ⚠ by COUNT, never the path (the gate tees stderr into logs)
    assert.match(r.stderr, /^isolated: home HIDDEN; re-bound read-only: [^;]*\b1 outer re-bind\b[^;]*; writable: [^;]*\b1 outer re-bind\b/m, r.stderr);
    assert.ok(!/keep-r[ow]/.test(r.stderr.split('\n').filter((l) => /ALREADY INSIDE/.test(l)).join('\n')), r.stderr);
  } finally { for (const d of [home, scratch]) fs.rmSync(d, { recursive: true, force: true }); }
});

// ⛔ Review F2 (reasoned, v0.33.0): an outer re-bind exactly AT a hidden dir was dropped with a
// note, but one strictly INSIDE a hidden dir (an outer explicit `--keep ~/.ssh/<sub>`) was carried
// writable SILENTLY. ⇒ the carry drops anything AT or WITHIN a hidden dir, with the same note.
/** argv[1..]: dirs; prints `KEPT <n> <ok|errno>` per dir for reading its file `f`. */
const KEPT_PROBE = `const fs = require('fs'); const p = require('path');
for (const [i, d] of process.argv.slice(1).entries()) { let r; try { fs.readFileSync(p.join(d, 'f')); r = 'ok'; } catch (e) { r = e.code; } console.log('KEPT ' + i + ' ' + r); }`;

test('⛔ STRIPPED markers: an outer --keep strictly INSIDE a hidden dir (~/.ssh/sub, ~/.config/webctl/sub) is NOT carried — hidden again, said by count — CONTROL: an outer keep outside the hidden dirs still is', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  const subs = [path.join(home, '.ssh', 'sub'), path.join(home, '.config', 'webctl', 'sub'), path.join(home, 'plain')];
  for (const d of subs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f'), 'x'); }
  const scratch = tmpdir(); // the inner call's cwd: kept by the outer, NOT under the home
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', ...subs.flatMap((d) => ['--keep', d]), '--keep', scratch,
      '--', 'sh', '-c', `"$0" -e "$3" "$4" "$5" "$6"; echo INNER; cd "$1" && env ${STRIP} "$0" "$2" isolated -- "$0" -e "$3" "$4" "$5" "$6"`,
      process.execPath, scratch, TOOL, KEPT_PROBE, ...subs]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /ALREADY INSIDE an isolated namespace whose markers were stripped/, 'premise: the inner call took the fresh path');
    const [outerOut, innerOut] = r.stdout.split(/^INNER$/m);
    assert.match(outerOut, /^KEPT 0 ok\nKEPT 1 ok\nKEPT 2 ok$/m, `premise: the OUTER call re-bound all three:\n${r.stdout}${r.stderr}`);
    assert.match(innerOut || '', /^KEPT 0 ENOENT\nKEPT 1 ENOENT\nKEPT 2 ok$/m,
      `an outer re-bind INSIDE a hidden dir was carried (or the control was not):\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^isolated: note: 2 outer re-bind\(s\) AT or WITHIN a hidden dir .* not carried/m, r.stderr);
    assert.ok(!r.stderr.split('\n').filter((l) => /not carried/.test(l)).join('\n').includes(home), `the note printed a path:\n${r.stderr}`);
  } finally { for (const d of [home, scratch]) fs.rmSync(d, { recursive: true, force: true }); }
});

// ⛔ Review F2 (v0.33.0, round 4): with ~/.ssh a SYMLINK (dotfiles) to a dir elsewhere under the home,
// an outer `--keep ~/.ssh/sub` is bound at its REAL path. Inside, the hidden home makes ~/.ssh
// unresolvable, so hideRule held only the nominal path and the carry kept `sub` writable, silently.
// The recorded WEBCTL_HIDDEN_DIRS cannot help: it is stripped with the rest of the markers.
test('⛔ STRIPPED markers: an outer --keep beneath a SYMLINKED ~/.ssh (bound at its real path) is NOT carried — CONTROL: an outer keep outside the hidden dirs still is', needsIsolation, async (t) => {
  const home = homeTmpdir();
  const subs = [path.join(home, 'dotfiles', 'ssh', 'sub'), path.join(home, 'plain')];
  for (const d of subs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f'), 'x'); }
  fs.symlinkSync(path.join('dotfiles', 'ssh'), path.join(home, '.ssh'));
  const scratch = tmpdir(); // the inner call's cwd: kept by the outer, NOT under the home
  try {
    const r = await underFakeHome(home, [process.execPath, TOOL, 'isolated', '--keep', path.join(home, '.ssh', 'sub'), '--keep', subs[1],
      '--keep', scratch, '--', 'sh', '-c', `"$0" -e "$3" "$4" "$5"; echo INNER; cd "$1" && env ${STRIP} "$0" "$2" isolated -- "$0" -e "$3" "$4" "$5"`,
      process.execPath, scratch, TOOL, KEPT_PROBE, ...subs]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /ALREADY INSIDE an isolated namespace whose markers were stripped/, 'premise: the inner call took the fresh path');
    const [outerOut, innerOut] = r.stdout.split(/^INNER$/m);
    assert.match(outerOut, /^KEPT 0 ok\nKEPT 1 ok$/m, `premise: the OUTER call re-bound both:\n${r.stdout}${r.stderr}`);
    assert.match(innerOut || '', /^KEPT 0 ENOENT\nKEPT 1 ok$/m,
      `an outer re-bind beneath a symlinked hidden dir was carried (or the control was not):\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^isolated: note: 1 outer re-bind\(s\) AT or WITHIN a hidden dir .* not carried/m, r.stderr);
    assert.ok(!r.stderr.split('\n').filter((l) => /not carried/.test(l)).join('\n').includes(home), `the note printed a path:\n${r.stderr}`);
  } finally { for (const d of [home, scratch]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('CONTROL: NOT nested, a mount under the home is NOT re-bound (nothing is carried without the kernel\'s proof of an outer sandbox)', needsIsolation, async (t) => {
  const home = fakeSecretHome();
  try {
    // a writable tmpfs under the fake home, in the throwaway namespace only — visible to the caller
    const r = await underFakeHome(home, ['sh', '-c', 'mkdir -p "$1/sub" && mount -t tmpfs webctl-test-sub "$1/sub" && echo x > "$1/sub/f" && cat "$1/sub/f" >/dev/null '
      + '&& echo HOST-SEES-SUB; shift; exec "$@"', 'sh', home, process.execPath, TOOL, 'isolated', '--', process.execPath, '-e', OUTER_KEEP_PROBE, home]);
    if (!r) { t.skip(NO_FAKE_HOME); return; }
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^HOST-SEES-SUB$/m, 'premise: the caller sees the mount under the home');
    assert.equal(probeOf(r.stdout).SUB, 'ENOENT', `a mount under the home was carried into a call that is NOT nested:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /outer re-bind/, r.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⛔ VERSION SKEW: a v0.33 call nested under a ≤ v0.32 outer (no WEBCTL_HIDDEN_DIRS) → refused rc 2 saying "upgrade the outer", nothing run', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c',
    'env -u WEBCTL_HIDDEN_DIRS "$0" "$1" isolated -- echo RAN-NESTED; echo "NESTED $?"', process.execPath, TOOL]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^NESTED 2$/m, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^RAN-NESTED$/m);
  assert.match(r.stderr, /the OUTER `isolated` is older than v0\.33\.0: it recorded no WEBCTL_HIDDEN_DIRS .* upgrade the outer one/);
  // CONTROL: the same marker missing on the HOST (with others forged) is NOT read as version skew
  const h = await nestedAttempt('net:[1]');
  assert.equal(h.status, 2);
  assert.doesNotMatch(h.stderr, /upgrade the outer/, 'a forged marker on the host was diagnosed as version skew');
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
    // v0.33.0: the throwaway dir is not even there (the home is HIDDEN): ENOENT, not EROFS
    assert.equal(writeOf(r.stdout), 'ENOENT', `a write into the real home was not refused under an outer unshare -r:\n${r.stderr}`);
    assert.equal(fs.existsSync(target), false, 'the file appeared in the real home');
    assert.ok(r.stdout.split('\n').includes(String(process.getuid?.())), 'the command does not run as the real uid');
    assert.match(r.stdout, /^NESTED-RN-OK$/m, r.stderr);
    const c = await runRaw(['unshare', '-r', process.execPath, '-e', TRY_CREATE, ctl]);
    assert.equal(writeOf(c.stdout), 'ok', `CONTROL: inside the same unshare -r the write should land:\n${c.stderr}`);
    assert.equal(fs.existsSync(ctl), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ a PATH-shadowed `getent` cannot redirect the read-only home (under an outer `unshare -r`) — the real home stays EROFS', needsIsolation, async () => {
  // Final review, measured: a fake \`getent\` first on PATH answered a self-owned dir under
  // /tmp; that "home" was then dropped as hidden by the mask, nothing was protected, and a
  // file APPEARED in the real home. getent is now run by absolute path, and a home under a
  // mask is refused. Either way, nothing may land in the real home.
  const dir = homeTmpdir(); // a throwaway dir under the real home — removed in finally
  const fake = tmpdir();
  const decoy = tmpdir();
  const target = path.join(dir, 'arm');
  try {
    fs.writeFileSync(path.join(fake, 'getent'),
      `#!/bin/sh\necho "x:x:${process.getuid?.()}:${process.getgid?.()}::${decoy}:/bin/sh"\n`, { mode: 0o755 });
    const r = await runRaw(['unshare', '-r', 'env', `PATH=${fake}:${process.env.PATH}`, process.execPath, TOOL,
      'isolated', '--', process.execPath, '-e', TRY_CREATE, target], { cwd: ROOT });
    assert.equal(fs.existsSync(target), false, `the file appeared in the real home:\n${r.stdout}${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(writeOf(r.stdout), 'ENOENT', 'the fake getent was ignored, so the real home is the HIDDEN one');
    // control: the fake really answers when called by name, so the arm is not vacuous
    const c = spawnSync('sh', ['-c', 'getent passwd 0'], { encoding: 'utf8', env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } });
    assert.match(c.stdout, new RegExp(`::${decoy}:`), 'CONTROL: the fake getent shadows the real one by PATH');
  } finally {
    for (const d of [dir, fake, decoy]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⛔ fail closed: a passwd home under /tmp (it would protect NOTHING) → FAIL, nothing run', needsIsolation, async (t) => {
  // A fake /etc/passwd bound in a throwaway \`unshare -rm\` gives the real uid a self-owned
  // home under /tmp: the mask would hide it and the real files would stay writable.
  const dir = tmpdir();
  const fakeHome = tmpdir();
  const pw = path.join(dir, 'passwd');
  fs.writeFileSync(pw, `x:x:${process.getuid?.()}:${process.getgid?.()}::${fakeHome}:/bin/sh\n`);
  const marker = path.join(dir, 'RAN');
  try {
    const r = await runRaw(['unshare', '-rm', '--propagation=private', 'sh', '-c',
      'mount --bind "$0" /etc/passwd || exit 9; shift; exec "$@"',
      pw, 'x', process.execPath, TOOL, 'isolated', '--keep', dir, '--',
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { cwd: ROOT });
    if (r.status === 9) { t.skip('SKIP (host): cannot bind over /etc/passwd here'); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL {2}isolated: NOT RUN: .*(lies under \/run or \/tmp|DISAGREE)/);
    assert.equal(fs.existsSync(marker), false);
  } finally { for (const d of [dir, fakeHome]) fs.rmSync(d, { recursive: true, force: true }); }
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
function termAfterReady(argv, env = {}, sig = /** @type {NodeJS.Signals} */ ('SIGTERM')) {
  return /** @type {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string}>} */ (new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env: cleanEnv(env) });
    let stdout = ''; let stderr = ''; let sent = false;
    c.stderr.on('data', (d) => { stderr += d; });
    c.stdout.on('data', (d) => {
      stdout += d;
      if (!sent && /READY/.test(stdout)) { sent = true; c.kill(sig); }
    });
    c.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  }));
}
const TRAPPER = 'trap "echo GOT-TERM; exit 7" TERM; echo READY; i=0; '
  + 'while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; echo TIMEOUT; exit 9';
const HUP_TRAPPER = TRAPPER.replace('GOT-TERM', 'GOT-HUP').replace('" TERM;', '" HUP;');

test('⭐ SIGHUP to the harness reaches the command inside (its trap runs, its exit code comes back) — CONTROL without `isolated`', needsIsolation, async () => {
  const r = await termAfterReady([process.execPath, TOOL, 'isolated', '--', 'sh', '-c', HUP_TRAPPER], {}, 'SIGHUP');
  assert.match(r.stdout, /GOT-HUP/, `the command never saw the SIGHUP:\n${r.stdout}${r.stderr}`);
  assert.equal(r.status, 7, r.stdout);
  const c = await termAfterReady(['sh', '-c', HUP_TRAPPER], {}, 'SIGHUP');
  assert.match(c.stdout, /GOT-HUP/);
  assert.equal(c.status, 7);
});

// ── pid 1 is `bash --norc -p -c`: the caller's shell config never runs as pid 1 ──
//
// ⛔ Measured by the review: pid 1 was `bash -c`, so a BASH_ENV script ran as pid 1 WITH full
// namespace capabilities BEFORE any mask; SHELLOPTS=xtrace traced the reaper; an exported
// `wait()` REPLACED it; SHELLOPTS=errexit + TERM ended the namespace before the command's own
// trap (rc 143, not 7, cleanup skipped). ⇒ `-p` (privileged mode) ignores all three.
// ⛔ AND ~/.bashrc (measured while fixing it): with SHLVL unset — the env allowlist drops it —
// and stdin a SOCKET (node's stdio pipes are socketpairs), bash believes rshd started it and
// sources ~/.bashrc, `-p` or not. ⇒ `--norc` too.
// Each arm passes the var with --pass-env: without it the ALLOWLIST already stops it, and the
// arm would pass whatever pid 1 is.

/** A throwaway dir holding a BASH_ENV script and a $HOME/.bashrc that each announce themselves. */
function shellConfigDir() {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'bash-env.sh'), 'echo "BASH_ENV-SOURCED $$" >&2\n');
  fs.writeFileSync(path.join(dir, '.bashrc'), 'echo "BASHRC-SOURCED $$" >&2\n');
  return dir;
}
const CMD_OK = 'console.log("CMD-RAN"); process.exit(5)';
/** argv for: fresh `isolated` running node CMD_OK, and a NESTED one under it. @param {string[]} o outer opts @param {string[]} i inner opts */
const freshAndNested = (o, i) => [['isolated', ...o, '--', process.execPath, '-e', CMD_OK],
  ['isolated', ...o, '--', process.execPath, TOOL, 'isolated', ...i, '--', process.execPath, '-e', CMD_OK]];

test('⛔ pid 1 ignores BASH_ENV (it would run as pid 1 with every capability, before any mask) — fresh AND nested', needsIsolation, async () => {
  const dir = shellConfigDir();
  // ⚠ SHLVL passed too: with it unset and stdin a socket, bash takes the rshd branch, sources
  // ~/.bashrc and RETURNS before BASH_ENV — the arm passed vacuously without it (measured)
  const env = { BASH_ENV: path.join(dir, 'bash-env.sh'), SHLVL: '5' };
  const pe = ['--pass-env', 'BASH_ENV', '--pass-env', 'SHLVL'];
  try {
    for (const args of freshAndNested(['--keep', dir, ...pe], pe)) {
      const r = await run(args, env);
      assert.equal(r.status, 5, r.stdout + r.stderr);
      assert.match(r.stdout, /^CMD-RAN$/m);
      assert.doesNotMatch(r.stderr, /BASH_ENV-SOURCED/, `pid 1 sourced BASH_ENV (${args.length > 6 ? 'nested' : 'fresh'})`);
    }
    // CONTROL: the same BASH_ENV IS honoured by a plain `bash -c` — the arm can fail
    const c = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8', env: cleanEnv(env) });
    assert.match(c.stderr, /BASH_ENV-SOURCED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ pid 1 ignores SHELLOPTS=xtrace (no reaper trace) and an exported `wait` function — fresh AND nested', needsIsolation, async () => {
  const env = { SHELLOPTS: 'xtrace', 'BASH_FUNC_wait%%': '() { echo HIJACKED-WAIT >&2; return 0; }' };
  for (const args of freshAndNested(['--pass-env', 'SHELLOPTS', '--pass-env', 'BASH_FUNC_*'], ['--pass-env', 'SHELLOPTS', '--pass-env', 'BASH_FUNC_*'])) {
    const r = await run(args, env);
    assert.equal(r.status, 5, `an exported wait() replaced the reaper's (the exit code is lost):\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /HIJACKED-WAIT/);
    assert.doesNotMatch(r.stderr, /^\++ /m, `pid 1 honoured SHELLOPTS=xtrace:\n${r.stderr}`);
  }
  // CONTROL: a plain `bash -c` with the same env traces AND calls the exported wait
  const c = spawnSync('bash', ['-c', 'sleep 0 & wait $!'], { encoding: 'utf8', env: cleanEnv(env) });
  assert.match(c.stderr, /^\+ /m);
  assert.match(c.stderr, /HIJACKED-WAIT/);
});

test('⛔ pid 1 ignores SHELLOPTS=errexit: TERM → the command\'s OWN trap runs and its code 7 comes back (not 143)', needsIsolation, async () => {
  const r = await termAfterReady([process.execPath, TOOL, 'isolated', '--pass-env', 'SHELLOPTS', '--', 'sh', '-c', TRAPPER],
    { SHELLOPTS: 'errexit' });
  assert.match(r.stdout, /GOT-TERM/, `the command's trap never ran:\n${r.stdout}${r.stderr}`);
  assert.equal(r.status, 7, `${r.status} ${r.signal}`);
});

test('⛔ pid 1 does not source ~/.bashrc when stdin is a SOCKET and SHLVL is unset (bash\'s "run by rshd" rule) — fresh AND nested', needsIsolation, async () => {
  const home = shellConfigDir(); // a throwaway HOME under /tmp: kept by `isolated` as the arm's own
  try {
    for (const args of freshAndNested([], [])) {
      const r = await run(args, { HOME: home });
      assert.equal(r.status, 5, r.stdout + r.stderr);
      assert.doesNotMatch(r.stderr, /BASHRC-SOURCED/, `pid 1 sourced $HOME/.bashrc (${args.length > 6 ? 'nested' : 'fresh'})`);
    }
    // CONTROL: `bash -c` with stdin a socket, SHLVL unset, sources it; `--norc` does not; `-p` alone still does
    const ctl = (/** @type {string[]} */ flags) => spawnSync('bash', [...flags, 'true'], { encoding: 'utf8',
      env: { PATH: String(process.env.PATH), HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }).stderr;
    assert.match(ctl(['-c']), /BASHRC-SOURCED/, 'CONTROL: bash did not take the rshd branch here — the arm proves nothing');
    assert.match(ctl(['-p', '-c']), /BASHRC-SOURCED/, 'CONTROL: -p alone does not stop it (why --norc)');
    assert.doesNotMatch(ctl(['--norc', '-p', '-c']), /BASHRC-SOURCED/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('⭐ SIGTERM to the harness reaches the command inside (its trap runs, its exit code comes back)', needsIsolation, async () => {
  const r = await termAfterReady([process.execPath, TOOL, 'isolated', '--', 'sh', '-c', TRAPPER]);
  assert.match(r.stdout, /GOT-TERM/, `the command never saw the SIGTERM:\n${r.stdout}`);
  assert.equal(r.status, 7, r.stdout);
});

test('⭐ SIGTERM reaches the command\'s OWN trap through a NESTED call too (rc 7) — not a SIGKILL of the namespace', needsIsolation, async () => {
  // Once the nested pid-1 helper has reported `started`, a TERM must be FORWARDED (the trap
  // runs), not turned into the early-window SIGKILL.
  const r = await termAfterReady([process.execPath, TOOL, 'isolated', '--', process.execPath, TOOL, 'isolated', '--', 'sh', '-c', TRAPPER]);
  assert.match(r.stdout, /GOT-TERM/, `the nested command's trap never ran:\n${r.stdout}${r.stderr}`);
  assert.equal(r.status, 7, `${r.status} ${r.signal}`);
});

test('⭐ CONTROL: the same trapper WITHOUT `isolated` → GOT-TERM, rc 7', async () => {
  const r = await termAfterReady(['sh', '-c', TRAPPER]);
  assert.match(r.stdout, /GOT-TERM/);
  assert.equal(r.status, 7);
});

// ── the EARLY-signal window: a TERM before pid 1 has its traps is not lost ──
//
// ⛔ Measured by the review: a TERM sent the moment unshare's child appears was LOST in 24 of 40
// runs (v0.32.0: 15/40) — pid 1 of a new PID namespace IGNORES a signal it has no handler for,
// and bash installs its traps a moment after it starts — so the command RAN and exited 0 after
// the caller gave up. ⇒ Until the inner side reports `started` (fd 3), a forwarded signal
// SIGKILLs unshare instead, and `--kill-child` takes the namespace with it; the harness then
// dies by the signal. Nested path: the pid-1 helper reports `started` the same way.

/**
 * argv[2] = N, argv[3…] = a harness invocation. N times: start it, poll /proc until the
 * `unshare` that carries pid 1's reaper (its argv names `webctl-isolated-pid1`) HAS A CHILD,
 * TERM the harness at once, and classify the end. Prints one line:
 * `EARLY term=<n> notrun=<n> bad=<n> other=<n> missed=<n>` — bad = the command RAN and the
 * harness exited 0; missed = the moment was never seen (the run finished first).
 */
const EARLY_PROBE = `
const fs = require('fs'); const { spawn } = require('child_process');
const [n, ...argv] = process.argv.slice(2);
const kids = (p) => { try { return fs.readFileSync('/proc/' + p + '/task/' + p + '/children', 'utf8').trim().split(/\\s+/).filter(Boolean).map(Number); } catch { return []; } };
const cmd = (p) => { try { return fs.readFileSync('/proc/' + p + '/cmdline', 'utf8'); } catch { return ''; } };
const desc = (p) => { const out = []; const q = [p]; while (q.length) { const x = q.shift(); for (const k of kids(x)) { out.push(k); q.push(k); } } return out; };
const tally = { term: 0, notrun: 0, bad: 0, other: 0, missed: 0 };
const once = () => new Promise((resolve) => {
  const c = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; let sent = false; let done = false;
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const poll = () => {
    if (done || sent) return;
    const u = desc(c.pid).find((p) => /^(?:[^\\0]*\\/)?unshare\\0/.test(cmd(p)) && cmd(p).includes('webctl-isolated-pid1') && kids(p).length > 0);
    if (u) { sent = true; c.kill('SIGTERM'); return; }
    setImmediate(poll);
  };
  poll();
  c.on('close', (code, sig) => {
    done = true;
    if (!sent) tally.missed++;
    else if (sig === 'SIGTERM') tally.term++;
    else if (/NOT RUN/.test(err)) tally.notrun++;
    else if (code === 0 && /^RAN$/m.test(out)) tally.bad++;
    else { tally.other++; process.stderr.write('OTHER code=' + code + ' sig=' + sig + ' ' + err.slice(-300) + '\\n'); }
    resolve();
  });
});
(async () => { for (let i = 0; i < Number(n); i++) await once();
  console.log('EARLY ' + Object.entries(tally).map(([k, v]) => k + '=' + v).join(' ')); })();
`;
/** @param {string} out */
const earlyOf = (out) => Object.fromEntries([...(out.match(/^EARLY (.*)$/m) || ['', ''])[1].matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
/** Runs per path. With SLOW_BASH the window is ~300 ms wide, so every run lands in it. */
const EARLY_N = 8;
// ⚠ node, not `sh`: `sh` is bash on some hosts, and bash is the slowed shim below
const EARLY_CMD = [process.execPath, '-e', 'console.log("RAN"); setTimeout(() => {}, 1000)'];
/**
 * A dir holding EARLY_PROBE and a `bash` that sleeps 0.3 s before exec'ing the real one — pid 1
 * then sits WITHOUT its traps for 300 ms, as on a loaded host. ⚠ Without it the window is a race
 * this host hit in 4/40 fresh runs (the review: 24/40) — too rare for a 8-run arm to be sure
 * of failing; with it, 16/20 fresh and 20/20 nested runs were lost before the fix (measured).
 * ⚠ pid 1's bash comes from the SYSTEM dirs, never PATH: `slowBinds(dir)` binds the shim over it
 * (withBinds), the real bash reachable at a copy — which is also the shim's interpreter, since
 * `/bin/sh` may itself be bash.
 */
function earlyDir() {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'early.cjs'), EARLY_PROBE);
  const real = realCopyAt(dir, 'bash');
  fs.writeFileSync(path.join(dir, 'slow-bash'), `#!${real}\nsleep 0.3\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  return dir;
}
/** @param {string} dir an earlyDir() @returns {[string, string][]} */
const slowBinds = (dir) => [[systemCopy('bash'), path.join(dir, 'real-bash')], ...overTool(path.join(dir, 'slow-bash'), 'bash')];

test('⛔ EARLY TERM, fresh path: a TERM the moment unshare\'s child appears → the harness DIES BY TERM — never "ran and exited 0"', needsIsolation, async (tt) => {
  const dir = earlyDir();
  try {
    const r = await withBinds(slowBinds(dir), [process.execPath, path.join(dir, 'early.cjs'), String(EARLY_N), process.execPath, TOOL, 'isolated', '--', ...EARLY_CMD]);
    if (!r) { tt.skip(NO_BINDS); return; }
    const t = earlyOf(r.stdout);
    assert.equal(t.bad, 0, `the command RAN after the caller's TERM in ${t.bad} of ${EARLY_N} runs:\n${r.stdout}${r.stderr}`);
    assert.equal(t.other, 0, `${r.stdout}${r.stderr}`);
    assert.ok(t.term + t.notrun >= EARLY_N / 2, `the window was hit too rarely to judge (missed ${t.missed}):\n${r.stdout}`);
    // ⭐ and it DIES BY the signal (no verdict), as a Ctrl-C must — a NOT RUN exit 1 would be a lane FAIL upstream
    assert.equal(t.notrun, 0, `a caller's TERM became an ordinary NOT RUN exit:\n${r.stdout}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ EARLY TERM, NESTED path: the same, for an `isolated` called inside `isolated`', needsIsolation, async () => {
  const dir = earlyDir();
  try {
    // inside the outer call: a throwaway `unshare -rm` binds the slow shim over the system bash
    const binds = slowBinds(dir);
    const r = await run(['isolated', '--keep', dir, '--', 'unshare', '-rm', '--propagation=private', 'sh', '-c',
      'm=$0; while [ "$1" != -- ]; do "$m" --bind "$1" "$2" || exit 97; shift 2; done; shift; exec "$@"', MOUNT_BIN, ...binds.flat(), '--',
      process.execPath, path.join(dir, 'early.cjs'), String(EARLY_N), process.execPath, TOOL, 'isolated', '--', ...EARLY_CMD]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const t = earlyOf(r.stdout);
    assert.equal(t.bad, 0, `the nested command RAN after the caller's TERM in ${t.bad} of ${EARLY_N} runs:\n${r.stdout}`);
    assert.equal(t.other, 0, `${r.stdout}${r.stderr}`);
    assert.ok(t.term + t.notrun >= EARLY_N / 2, `the window was hit too rarely to judge (missed ${t.missed}):\n${r.stdout}`);
    // ⭐ and it DIES BY the signal (no verdict), as a Ctrl-C must — a NOT RUN exit 1 would be a lane FAIL upstream
    assert.equal(t.notrun, 0, `a caller's TERM became an ordinary NOT RUN exit:\n${r.stdout}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    + ' && mount -t tmpfs webctl-isolated /tmp' + SCRATCH_MASKS + ' && mkdir -p "$0" && mount --move /run/k "$0"'
    + ' && mount --rbind "$1" "$1" && mount -o remount,bind,ro "$1" && shift && exec "$@"';
  const r = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--propagation=private', 'sh', '-c', stage, ROOT, PW_HOME],
    'mnt:[1]', { WEBCTL_RO_ROOTS: JSON.stringify([PW_HOME]), WEBCTL_HOST_PIDNS: fs.readlinkSync('/proc/self/ns/pid'),
      WEBCTL_HIDDEN_DIRS: '[]' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the current PID namespace .* EQUALS the recorded host one/);
  assert.doesNotMatch(r.stderr, /uid_map is|interface\(s\) besides|no 'webctl-isolated' tmpfs|WRITABLE here|mount namespace .* EQUALS/,
    'only the pid fact should refuse');
  assert.equal(r.ran, false, 'a namespace sharing the host PIDs was accepted as `isolated`');
});

test('⛔ VERSION SKEW (v0.34): every v0.33 fact satisfied but /var/tmp and /dev/shm NOT masked → refused rc 2 saying "upgrade the outer", nothing run — CONTROL: masked, it runs', needsIsolation, async () => {
  const stage = (/** @type {boolean} */ scratch) => 'mount -t tmpfs webctl-isolated /run && mkdir /run/k && mount --rbind "$0" /run/k'
    + ' && { [ -L /var/run ] || mount -t tmpfs webctl-isolated /var/run; }'
    + ` && mount -t tmpfs webctl-isolated /tmp${scratch ? SCRATCH_MASKS : ''} && mkdir -p "$0" && mount --move /run/k "$0"`
    + ' && mount --rbind "$1" "$1" && mount -o remount,bind,ro "$1" && shift && exec "$@"';
  const env = { WEBCTL_RO_ROOTS: JSON.stringify([PW_HOME]), WEBCTL_HOST_PIDNS: 'pid:[1]', WEBCTL_HIDDEN_DIRS: '[]',
    WEBCTL_HOST_IDS: JSON.stringify({ uid: process.getuid?.(), gid: process.getgid?.() }) };
  const r = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--pid', '--fork', '--mount-proc', '--propagation=private', 'sh', '-c', stage(false), ROOT, PW_HOME],
    'mnt:[1]', env);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the OUTER `isolated` is older than v0\.34\.0: .*(\/var\/tmp|\/dev\/shm).* the HOST's there .* upgrade the outer one to v0\.34\.0/);
  assert.equal(r.ran, false, 'a nested call ran with the host\'s /dev/shm and /var/tmp');
  const c = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--pid', '--fork', '--mount-proc', '--propagation=private', 'sh', '-c', stage(true), ROOT, PW_HOME],
    'mnt:[1]', env);
  assert.doesNotMatch(c.stderr, /older than v0\.34|REFUSED/, `CONTROL: with the scratch masks the proof should pass:\n${c.stderr}`);
  assert.equal(c.ran, true, `CONTROL: with the scratch masks the nested call should RUN:\n${c.stdout}${c.stderr}`);
});

test('⛔ nesting: every other fact satisfied (full mask, ro home, own PIDs) but a recorded hidden dir NOT masked → refused by the hidden fact alone — CONTROL: masked, that fact passes', needsIsolation, async () => {
  const dir = homeTmpdir(); // stands in for ~/.ssh: only its PATH is recorded and mounted on, in a throwaway mount ns
  const stage = (/** @type {boolean} */ hide) => 'mount -t tmpfs webctl-isolated /run && mkdir /run/k && mount --rbind "$0" /run/k'
    + ' && { [ -L /var/run ] || mount -t tmpfs webctl-isolated /var/run; }'
    + ' && mount -t tmpfs webctl-isolated /tmp' + SCRATCH_MASKS + ' && mkdir -p "$0" && mount --move /run/k "$0"'
    + (hide ? ' && mount -t tmpfs -o ro webctl-isolated-hidden "$2"' : '')
    + ' && mount --rbind "$1" "$1" && mount -o remount,bind,ro "$1" && shift 2 && exec "$@"';
  const env = { WEBCTL_RO_ROOTS: JSON.stringify([PW_HOME]), WEBCTL_HOST_PIDNS: 'pid:[1]', WEBCTL_HIDDEN_DIRS: JSON.stringify([dir]) };
  try {
    const r = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--propagation=private', 'sh', '-c', stage(false), ROOT, PW_HOME, dir], 'mnt:[1]', env);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /1 of 1 hidden dir\(s\) — the home, ~\/\.ssh, the state roots — lack the 'webctl-isolated-hidden' mask here/);
    assert.doesNotMatch(r.stderr, /EQUALS|uid_map is|interface\(s\) besides|no 'webctl-isolated' tmpfs|WRITABLE here/, 'only the hidden fact should refuse');
    assert.equal(r.ran, false, 'a namespace with the secret dirs visible was accepted as `isolated`');
    const c = await nestedAttempt('net:[1]', ['unshare', '-rnm', '--propagation=private', 'sh', '-c', stage(true), ROOT, PW_HOME, dir], 'mnt:[1]', env);
    assert.doesNotMatch(c.stderr, /hidden home dir|REFUSED/, `CONTROL: with the mask in place the hidden fact should pass:\n${c.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── pid 1 REAPS orphans ──────────────────────────────────────────────────────
//
// ⛔ Measured (`perplexity`, then by the lead): node as pid 1 of the PID namespace leaves an
// orphaned, exited grandchild as a ZOMBIE — libuv waits only for the pids IT spawned, and
// node exposes no waitpid(-1). A test that daemonises a helper and checks "it is gone"
// (`kill -0`) then sees a zombie as ALIVE. ⇒ pid 1 is a small bash that runs the real work
// in the background and `wait`s on it: bash's SIGCHLD handler reaps ANY child, re-parented
// orphans included.

/**
 * $1 = arm|control. Daemonises `sleep 30` through an intermediate sh that exits at once (so
 * the sleep is re-parented to the namespace's pid 1), checks it EXISTS, kills it, then polls
 * /proc/<pid> for ≤ 10 s: `gone` = reaped. control: stops once it has been a zombie for 1 s.
 */
const ORPHAN_PROBE = `gp=$(sh -c 'sleep 30 >/dev/null 2>&1 & echo $!')
first=$(awk '{print $3}' "/proc/$gp/stat" 2>/dev/null) || first=gone
kill "$gp"
i=0; z=0; st=$first
while [ $i -lt 100 ]; do
  st=$(awk '{print $3}' "/proc/$gp/stat" 2>/dev/null) || st=gone
  [ -n "$st" ] || st=gone
  [ "$st" = gone ] && break
  if [ "$st" = Z ]; then z=$((z+1)); [ "$1" = control ] && [ $z -ge 10 ] && break; fi
  sleep 0.1; i=$((i+1))
done
echo "ORPHAN first=$first final=$st"`;
/** @param {string} out @returns {{first: string, final: string}} */
const orphanOf = (out) => {
  const m = out.match(/^ORPHAN first=(\S+) final=(\S+)$/m);
  return { first: m ? m[1] : `none in: ${out}`, final: m ? m[2] : `none in: ${out}` };
};

test('⭐ ARM: an orphaned, exited grandchild is REAPED by pid 1 (it disappears) — fresh path', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c', ORPHAN_PROBE, 'probe', 'arm']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const o = orphanOf(r.stdout);
  assert.match(o.first, /^[RSD]$/, `the probe never saw its orphan alive — the arm proves nothing:\n${r.stdout}`);
  assert.equal(o.final, 'gone', `the orphan was left as ${o.final} (a zombie is not reaped)`);
});

test('⭐ ARM: … and by the NESTED call\'s pid 1', needsIsolation, async () => {
  const r = await run(['isolated', '--', 'sh', '-c', '"$0" "$1" isolated -- sh -c "$2" probe arm',
    process.execPath, TOOL, ORPHAN_PROBE]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const o = orphanOf(r.stdout);
  assert.match(o.first, /^[RSD]$/, r.stdout);
  assert.equal(o.final, 'gone', `the nested orphan was left as ${o.final}`);
});

test('⭐ CONTROL: under a raw `unshare -rf --pid --mount-proc` with NODE as pid 1 the same orphan stays a ZOMBIE', needsIsolation, async () => {
  // node as pid 1 spawning the command as the previous nested path did (a spawn + wait for IT only)
  const r = await runRaw(['unshare', '-rf', '--pid', '--mount-proc', process.execPath, '-e',
    'require("child_process").spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" }).on("close", (c) => process.exit(c ?? 1))',
    'sh', '-c', ORPHAN_PROBE, 'probe', 'control']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const o = orphanOf(r.stdout);
  assert.match(o.first, /^[RSD]$/, r.stdout);
  assert.equal(o.final, 'Z', `CONTROL: node as pid 1 did not leave a zombie (${o.final}) — the arm cannot fail`);
});

/** Run the harness with `input` on stdin. @param {string[]} args @param {string} input */
function runWithStdin(args, input) {
  return /** @type {Promise<{status:number, stdout:string, stderr:string}>} */ (new Promise((resolve) => {
    const c = spawn(process.execPath, [TOOL, ...args], { cwd: ROOT, env: cleanEnv() });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
    c.stdin.end(input);
  }));
}

test('⭐ stdin reaches the command through the reaping pid 1 — fresh AND nested paths', needsIsolation, async () => {
  // ⚠ bash gives a background job /dev/null as stdin unless it is redirected explicitly
  // (measured): a reaper that forgot `<&0` would starve every command reading stdin.
  const r = await runWithStdin(['isolated', '--', 'sh', '-c', 'read a; echo "FRESH $a"; "$0" "$1" isolated -- sh -c \'read b; echo "NESTED $b"\'',
    process.execPath, TOOL], 'line-one\nline-two\n');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^FRESH line-one$/m, r.stdout);
  assert.match(r.stdout, /^NESTED line-two$/m, r.stdout);
});

test('⛔ fail closed: no `bash` in the system dirs (pid 1 must reap) → FAIL naming it, command NOT run — fresh AND nested', needsIsolation, async (t) => {
  // ⚠ a non-executable file bound over the system bash (PATH is never consulted for pid 1)
  const dir = tmpdir();
  const none = noexecFile(dir);
  const NO_BASH_RE = /FAIL {2}isolated: NOT RUN: (?:no isolation backend can be used here — unshare: )?'bash' not found in \/usr\/sbin, \/usr\/bin, \/sbin, \/bin — pid 1/;
  try {
    const r = await markerRun(dir, overTool(none, 'bash'));
    if (!r) { t.skip(NO_BINDS); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, NO_BASH_RE);
    // the FRESH path probes its backend: the reason is unshare's skip reason (ib4k §2)
    assert.match(r.stderr, /NOT RUN: no isolation backend can be used here — unshare: 'bash' not found/);
    assert.equal(r.ran, false, 'the command ran without a reaping pid 1');
    // nested: the outer call is ordinary; inside it, a throwaway `unshare -rm` hides bash from the inner one
    const marker = path.join(dir, 'RAN-NESTED');
    const n = await run(['isolated', '--keep', dir, '--', 'sh', '-c',
      'n=$0; h=$1; mk=$2; m=$3; shift 3; '
        + 'unshare -rm --propagation=private sh -c \'m=$0; while [ "$1" != -- ]; do "$m" --bind "$1" "$2" || exit 97; shift 2; done; shift; exec "$@"\' '
        + '"$m" "$@" -- "$n" "$h" isolated -- "$n" -e "require(\'fs\').writeFileSync(process.argv[1], \'x\')" "$mk"; echo "NESTED-RC $?"',
      process.execPath, TOOL, marker, MOUNT_BIN, ...overTool(none, 'bash').flat()]);
    assert.equal(n.status, 0, n.stdout + n.stderr);
    assert.match(n.stdout, /^NESTED-RC 1$/m, n.stdout + n.stderr);
    assert.match(n.stderr, NO_BASH_RE);
    assert.equal(fs.existsSync(marker), false, 'the nested command ran without a reaping pid 1');
    // CONTROL: the same run WITHOUT the bind runs the command (the arm's refusal is the missing bash)
    const c = await markerRun(dir, []);
    assert.ok(c, NO_BINDS);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(c.ran, true, 'CONTROL: with bash present the command should run');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── HOST POLICY: AppArmor's userns restriction, and WEBCTL_UNSHARE_BIN ───────
//
// Measured on an Ubuntu 24.04 host: kernel.apparmor_restrict_unprivileged_userns=1 makes
// `unshare -r` fail with uid_map EPERM. That is the HOST's policy, not a lane fault — the
// refusal must say so and give the two fixes. ⚠ The sysctl path is a function PARAMETER, so
// these arms never depend on (or change) the host's real setting.

// ── review of 5773fb8, finding 5: every forwarder is installed BEFORE its child exists ──
//
// ⛔ The inner half removed its early handler before runCommand installed its forwarder, and the
// pid-1 helper wrote `started` before it had any handler: a TERM in either gap met node's DEFAULT
// disposition — the half died, the command was orphaned and SIGKILLed with the namespace, its
// trap never ran. The gaps are a few synchronous statements wide and cannot be widened from
// outside (DEV_NOTES), so the integration arms cannot hit them on demand; this pins the
// mechanism: a forwarder made before the spawn BUFFERS a signal and delivers it on attach.
// ⚠ SIGHUP only: the test runner may own INT/TERM handlers in this process.
const { forwarderBeforeSpawn } = await import(pathToFileURL(TOOL).href);

test('⭐ logic: a forwarder installed BEFORE the spawn buffers a signal and delivers it to the child on attach', () => {
  assert.equal(typeof forwarderBeforeSpawn, 'function', 'no forwarderBeforeSpawn export');
  /** @type {[string, string][]} */ const got = [];
  const fwd = forwarderBeforeSpawn((/** @type {string} */ s, /** @type {{id: string}} */ c) => { got.push([s, c.id]); });
  try {
    process.emit('SIGHUP', 'SIGHUP');
    assert.deepEqual(got, [], 'delivered with no child');
    assert.equal(fwd.last(), 'SIGHUP', 'the signal was not recorded (exitOrDieBy would not re-raise it)');
    fwd.attach({ id: 'child-1' });
    assert.deepEqual(got, [['SIGHUP', 'child-1']], 'a signal that came BEFORE the spawn was LOST');
    process.emit('SIGHUP', 'SIGHUP');
    assert.deepEqual(got, [['SIGHUP', 'child-1'], ['SIGHUP', 'child-1']], 'after attach, delivered at once');
  } finally { fwd.remove(); }
  assert.equal(process.listenerCount('SIGHUP'), 0, 'remove() left a handler installed');
});

// ⛔ TERM ×3 at 60 ms → the harness died by TERM instead of returning the trap's 7 (measured: 9/25
// fresh, 10/25 nested; the re-review saw 4/25 with no gap control). A LATE signal — after the
// command started and pid 1 already EXITED — found unshare childless and was treated as EARLY:
// SIGKILL unshare, die by the signal. The logic arm drives the forwarder with a stand-in for
// unshare that is a real, CHILDLESS process: started → nothing killed, not early; not started →
// SIGKILL and early (the window the early-TERM arms guard).
const { forwardSignalsPastUnshare } = await import(pathToFileURL(TOOL).href);

test('⭐ logic: a signal AFTER `started` to an unshare whose pid 1 is gone is NOT "early" (no SIGKILL, no death by it) — before `started` it is', async () => {
  assert.equal(typeof forwardSignalsPastUnshare, 'function', 'no forwardSignalsPastUnshare export');
  const sleeper = spawn('sleep', ['5'], { stdio: 'ignore' }); // real and childless: "pid 1 has exited"
  try {
    for (const started of [true, false]) {
      /** @type {string[]} */ const killed = [];
      const fwd = forwardSignalsPastUnshare(() => started);
      try {
        fwd.attach(/** @type {any} */ ({ pid: sleeper.pid, kill: (/** @type {string} */ s) => { killed.push(s); } }));
        process.emit('SIGHUP', 'SIGHUP');
        if (started) {
          assert.deepEqual(killed, [], 'a late signal SIGKILLed unshare (the namespace was ending with the command\'s own status)');
          assert.equal(fwd.early(), false, 'a late signal was taken for an EARLY one (the harness would die by it)');
          assert.equal(fwd.last(), 'SIGHUP', 'the late signal was not recorded');
        } else {
          // CONTROL: before `started` the same signal IS early — the arm can fail
          assert.deepEqual(killed, ['SIGKILL']);
          assert.equal(fwd.early(), true);
        }
      } finally { fwd.remove(); }
    }
  } finally { sleeper.kill('SIGTERM'); }
  assert.equal(process.listenerCount('SIGHUP'), 0, 'remove() left a handler installed');
});

/**
 * TERM ×3, `gap` ms apart, after the command's TERM trap is set: `TERM3 <code|signal>` per run.
 * @param {number} n @param {number} gap @param {string[]} argv
 */
const TERM3_PROBE = `const { spawn } = require('child_process');
const [n, gap, ...argv] = process.argv.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => { for (let i = 0; i < Number(n); i++) await new Promise((resolve) => {
  const c = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
  let sent = false;
  c.stdout.on('data', async (d) => { if (sent || !/READY/.test(String(d))) return; sent = true;
    for (let k = 0; k < 3; k++) { try { c.kill('SIGTERM'); } catch {} await sleep(Number(gap)); } });
  c.on('close', (code, sig) => { console.log('TERM3 ' + (sig || code)); resolve(); });
}); })();`;

test('⛔ TERM ×3 (60 ms apart) → the command\'s trap code 7, never death by TERM — fresh AND nested', needsIsolation, async () => {
  for (const nested of [false, true]) {
    const inner = ['sh', '-c', TRAPPER];
    const argv = nested ? [process.execPath, TOOL, 'isolated', '--', process.execPath, TOOL, 'isolated', '--', ...inner]
      : [process.execPath, TOOL, 'isolated', '--', ...inner];
    const r = await runRaw([process.execPath, '-e', TERM3_PROBE, '6', '60', ...argv], { cwd: ROOT });
    const got = [...r.stdout.matchAll(/^TERM3 (\S+)$/gm)].map((m) => m[1]);
    assert.equal(got.length, 6, r.stdout);
    assert.deepEqual(got.filter((x) => x !== '7'), [], `${nested ? 'nested' : 'fresh'}: a late TERM changed the outcome: ${got.join(' ')}`);
  }
});

// ⛔ PID1_REAPER lost the command's status to a LATE signal (measured: `TERM ×3` → 127 in 1 of 150
// runs under load; `wait: pid 2 is not a child of this shell`). Traced with strace: the blocking
// wait4 inside bash's `wait` RETURNED the child (7) just as a trapped TERM arrived; the trap
// handler jumped out of `wait` before bash recorded the status — `wait` said 143, the child was
// already reaped, and the 7 existed nowhere. The window is inside bash, so no splice can widen
// it; a BURST of TERMs hits it often: 30 TERMs 1 ms apart at a child that traps TERM and exits 7
// → 8 of 100 runs wrong (127 or 143) with the old loop, here, sequential. Plain bash, no
// namespace: what is under test is the reaper's own logic.
const { PID1_REAPER } = await import(pathToFileURL(TOOL).href);
/** Run PID1_REAPER over `cmd`; once it prints READY, `n` TERMs `gap` ms apart. @returns {Promise<{status: string, out: string}>} */
const reaperBurst = (/** @type {string[]} */ cmd, /** @type {number} */ n, /** @type {number} */ gap) => new Promise((resolve) => {
  const c = spawn('/bin/bash', ['--norc', '-p', '-c', PID1_REAPER, 'webctl-isolated-pid1', ...cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let sent = false;
  c.stderr?.on('data', (d) => { out += d; });
  c.stdout?.on('data', async (d) => {
    out += d;
    if (sent || !/READY/.test(out)) return;
    sent = true;
    for (let k = 0; k < n; k++) { try { c.kill('SIGTERM'); } catch { /* gone */ } await new Promise((r) => setTimeout(r, gap)); }
  });
  c.on('close', (code, sig) => resolve({ status: String(sig || code), out }));
});

test('⛔ pid 1\'s reaper: a BURST of TERMs as the child exits never loses its status — 150 runs, every one the child\'s 7 (never 127 or 143)', async () => {
  /** @type {Record<string, number>} */ const tally = {};
  let odd = '';
  for (let i = 0; i < 150; i++) {
    const r = await reaperBurst(['sh', '-c', 'trap "exit 7" TERM; echo READY; while :; do sleep 0.01; done'], 30, 1);
    tally[r.status] = (tally[r.status] || 0) + 1;
    if (r.status !== '7' && !odd) odd = r.out;
  }
  assert.deepEqual(tally, { 7: 150 }, `the reaper lost the child's status (before the fix: ~8% of runs):\n${odd}`);
});

test('pid 1\'s reaper: the child\'s status as is (no signal), and its sleep fd (9) is NOT inherited by the child', async () => {
  const r = await reaperBurst(['sh', '-c', 'echo READY; if [ -e /proc/$$/fd/9 ]; then echo FD9-LEAKED; fi; exit 5'], 0, 0);
  assert.equal(r.status, '5', r.out);
  assert.doesNotMatch(r.out, /FD9-LEAKED/, r.out);
});

const { userNamespaceRefusal } = await import(pathToFileURL(TOOL).href);
const UID_MAP_EPERM = 'unshare: write failed /proc/self/uid_map: Operation not permitted';

test('⭐ logic: uid_map EPERM + apparmor_restrict_unprivileged_userns=1 → a HOST-POLICY refusal naming the sysctl and both fixes', () => {
  const dir = tmpdir();
  const sysctl = path.join(dir, 'apparmor_restrict_unprivileged_userns');
  try {
    fs.writeFileSync(sysctl, '1\n');
    const why = userNamespaceRefusal(UID_MAP_EPERM, sysctl);
    assert.match(why, /HOST POLICY/);
    assert.match(why, /not a fault of this lane/);
    assert.match(why, /kernel\.apparmor_restrict_unprivileged_userns = 1/);
    assert.match(why, /sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
    assert.match(why, /AppArmor profile/);
    assert.match(why, /WEBCTL_UNSHARE_BIN/);
    // ⚠ the other EPERM shapes unshare prints
    for (const e of ['unshare: write failed /proc/self/gid_map: Operation not permitted',
      'unshare: setgroups failed: Operation not permitted', 'unshare: unshare failed: Operation not permitted']) {
      assert.match(userNamespaceRefusal(e, sysctl), /HOST POLICY/, e);
    }
    // CONTROLS: sysctl 0, sysctl absent, and a different failure → '' (the caller's generic reason stands)
    fs.writeFileSync(sysctl, '0\n');
    assert.equal(userNamespaceRefusal(UID_MAP_EPERM, sysctl), '');
    assert.equal(userNamespaceRefusal(UID_MAP_EPERM, path.join(dir, 'absent')), '');
    fs.writeFileSync(sysctl, '1\n');
    assert.equal(userNamespaceRefusal("unshare: unrecognized option '--map-user'", sysctl), '');
    assert.equal(userNamespaceRefusal('', sysctl), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ a bad WEBCTL_UNSHARE_BIN (relative, missing, a directory, not executable) → FAIL naming the rule, no path, nothing run', async () => {
  const dir = tmpdir();
  const noexec = path.join(dir, 'unshare-noexec');
  fs.writeFileSync(noexec, '#!/bin/sh\nexec unshare "$@"\n', { mode: 0o644 });
  const marker = path.join(dir, 'RAN');
  try {
    for (const bin of ['unshare', path.join(dir, 'missing'), dir, noexec]) {
      const r = await run(['isolated', '--keep', dir, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        { WEBCTL_UNSHARE_BIN: bin });
      assert.equal(r.status, 1, `${bin === dir ? '<dir>' : path.basename(bin)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: no isolation backend can be used here — unshare: WEBCTL_UNSHARE_BIN must be an ABSOLUTE path to an EXECUTABLE regular file/m);
      assert.ok(!r.stderr.includes(dir), 'the refusal printed the path');
      assert.equal(fs.existsSync(marker), false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ WEBCTL_UNSHARE_BIN is used for EVERY unshare: the outer namespace, the privilege drop and the nested call', needsIsolation, async () => {
  const dir = tmpdir(); // the wrapper (re-bound read-only inside) and its log (kept)
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  const wrapper = path.join(dir, 'unshare-wrapper');
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "USED $1" >> "$WEBCTL_TEST_UNSHARE_LOG"\nexec ${JSON.stringify(which('unshare'))} "$@"\n`, { mode: 0o755 });
  try {
    const r = await run(['isolated', '--keep', log, '--', process.execPath, TOOL, 'isolated', '--', 'true'],
      { WEBCTL_UNSHARE_BIN: wrapper, WEBCTL_TEST_UNSHARE_LOG: path.join(log, 'used') });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const used = fs.readFileSync(path.join(log, 'used'), 'utf8').trim().split('\n');
    // the backend probe (side-effect free: `-rnm --uts --pid --fork true`) and the outer namespace
    assert.equal(used.filter((l) => l === 'USED -rnm').length, 2, `the probe and the outer namespace did not both use it:\n${used.join('\n')}`);
    // outer: the drop's probe + the command; nested: its drop's probe + its command
    assert.equal(used.filter((l) => l === 'USED -U').length, 4, `the privilege drops did not all use it:\n${used.join('\n')}`);
    // CONTROL: without the var, the wrapper is never called
    fs.rmSync(path.join(log, 'used'));
    const c = await run(['isolated', '--keep', log, '--', 'true'], { WEBCTL_TEST_UNSHARE_LOG: path.join(log, 'used') });
    assert.equal(c.status, 0, c.stderr);
    assert.equal(fs.existsSync(path.join(log, 'used')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

// ── runCommand: a SYNCHRONOUS spawn throw fails cleanly (re-review, LOW) ─────
//
// spawn() THROWS (rather than emitting 'error') for an argv node refuses (a NUL byte) and for exec
// failures outside its "run-time" list (E2BIG: an argv over the kernel's limit — the chain adds
// pid 1's reaper and the helper's argv to the command's). runCommand had installed its signal
// forwarder first, so the throw rejected its Promise — a crash with a stack, not a FAIL line — and
// left the forwarder's listeners on the process. Run in a child: report() writes to stdout/stderr.
// ⛔ Review F3: it resolved 127 — "command not found" — while the fresh path's equivalent (unshare
// cannot be spawned) is EXIT.fail; argv[0] here is the privilege-drop chain, not the command.
test('⛔ runCommand: a SYNCHRONOUS spawn throw → FAIL (exit 1, not 127) "NOT RUN: cannot start", no rejection, and no signal forwarder left installed', async () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
const m = await import(process.env.HARNESS_URL);
const count = () => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
const before = count();
let code = null; let threw = '';
try { code = await m.runCommand(['/bin/true', 'nul\\u0000inside']); } catch (e) { threw = String((e && e.code) || e); }
console.log('RESULT ' + JSON.stringify({ code, threw, before, after: count() }));
console.log('ASYNC ' + await m.runCommand(['/nonexistent-webctl-chain'])); // ENOENT: 'error', not a throw`], { encoding: 'utf8', env: cleanEnv({ HARNESS_URL: pathToFileURL(TOOL).href }) });
  const line = (r.stdout.match(/^RESULT (.*)$/m) || [])[1];
  assert.ok(line, `no result:\n${r.stdout}${r.stderr}`);
  const res = JSON.parse(line);
  assert.equal(res.threw, '', `runCommand REJECTED instead of failing cleanly:\n${r.stderr}`);
  assert.equal(res.code, 1, `not the harness's FAIL code:\n${r.stdout}${r.stderr}`);
  assert.deepEqual(res.after, res.before, 'the signal forwarder was left installed');
  assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: cannot start '\/bin\/true' \(the isolation chain\): /m, r.stderr);
  // the ASYNC 'error' (ENOENT) likewise: the harness's FAIL code, never 127
  assert.match(r.stdout, /^ASYNC 1$/m, r.stdout + r.stderr);
});

// ⛔ Review F3: runPid1 (the helper that finally spawns the COMMAND) had no try/catch around its
// spawn, so a synchronous throw — E2BIG from an env var over the kernel's per-string limit
// (MAX_ARG_STRLEN, 128 KiB), which the env PIPE does not have — rejected its Promise: a stack,
// no FAIL line, the forwarder left installed. In a child that imports it (report() writes to
// stdout/stderr); the env arrives on fd 3, as the chain sends it.
test('⛔ runPid1: a SYNCHRONOUS spawn throw (E2BIG: a 256 KiB env var) → FAIL (exit 1) "NOT RUN: cannot start", no rejection, no forwarder left installed', async () => {
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', `
const m = await import(process.env.HARNESS_URL);
const count = () => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
const before = count();
let code = null; let threw = '';
try { code = await m.runPid1(['--env', '3', '--', '/bin/true']); } catch (e) { threw = String((e && e.code) || e); }
console.log('RESULT ' + JSON.stringify({ code, threw, before, after: count() }));`], {
      env: cleanEnv({ HARNESS_URL: pathToFileURL(TOOL).href }), stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout?.on('data', (d) => { stdout += d; });
    c.stderr?.on('data', (d) => { stderr += d; });
    const envPipe = /** @type {import('node:stream').Writable} */ (c.stdio[3]);
    envPipe.on('error', () => {});
    envPipe.end(JSON.stringify({ PATH: '/usr/bin:/bin', BIG: 'x'.repeat(256 * 1024) }));
    c.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
  const res0 = /** @type {{status: number, stdout: string, stderr: string}} */ (r);
  const line = (res0.stdout.match(/^RESULT (.*)$/m) || [])[1];
  assert.ok(line, `no result:\n${res0.stdout}${res0.stderr}`);
  const res = JSON.parse(line);
  assert.equal(res.threw, '', `runPid1 REJECTED instead of failing cleanly:\n${res0.stderr}`);
  assert.equal(res.code, 1, res0.stdout + res0.stderr);
  assert.deepEqual(res.after, res.before, 'the signal forwarder was left installed');
  assert.match(res0.stderr, /^FAIL {2}isolated: NOT RUN: cannot start '\/bin\/true': .*E2BIG/m, res0.stderr);
});

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
  assert.equal(res.stdout.trim(), 'IMPORTED 6', 'a verb ran on import');
  assert.equal(res.stderr, '');
});
