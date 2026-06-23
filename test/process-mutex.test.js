// Unit tests for createProcessMutex(C, opts) — design p06y (expands v8m2).
// Hermetic: a temp lockBaseDir + injected clock; the real-contention multi-
// process proof lives in test/process-mutex-concurrency.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProcessMutex, LockTimeoutError } from '../lib/process-mutex.js';

function fakeC() {
  return { PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-', IMAGE_CHROMIUM_REPO: 'demo-webctl/chromium',
    IMAGE_XPRA: 'demo-webctl/xpra-ubuntu:latest', DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'www.demo.example', CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc',
    DOTENV_FILENAME: '.env.demo-webctl', DOTENV_TEMPLATE: '.env.demo-webctl.example',
    ENV_PREFIX: 'CLIAI_DEMO_WEBCTL_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [] };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mutex-')); }

// Real clock throughout (the acquire-timeout loop sleeps in real time, so the
// deadline must use real time). Old-lock scenarios are simulated by back-dating
// the lock dir's mtime with utimesSync — no clock injection needed.
function mk(extra = {}) {
  const lockBaseDir = path.join(tmpDir(), 'locks');
  const m = createProcessMutex(fakeC(), { lockBaseDir, signalCleanup: false, retryMs: 5, ...extra });
  return { m, lockBaseDir };
}

/** Back-date a path's mtime by `sec` seconds (to fake an aged lock). */
function agePath(p, sec) {
  const t = Date.now() / 1000 - sec;
  fs.utimesSync(p, t, t);
}

// ── factory + path ──────────────────────────────────────────────────────────

test('validates C; getLockPath under <lockBaseDir>/port-<PORT>.lock', () => {
  assert.throws(() => createProcessMutex(/** @type {any} */ ({})), /Invalid client-config constants/);
  const { m, lockBaseDir } = mk();
  assert.equal(m.getLockPath(9222), path.join(lockBaseDir, 'port-9222.lock'));
});

test("flock:'on' without flockImpl throws (base never deps fs-ext)", () => {
  assert.throws(() => createProcessMutex(fakeC(), { flock: 'on' }), /requires opts\.flockImpl/);
});

// ── mkdir acquire / release ─────────────────────────────────────────────────

test('mkdir: acquire creates lock dir + pid + meta; release removes it', async () => {
  const { m } = mk();
  const h = await m.acquireLock(9222, 1000, { command: 'click' });
  assert.equal(h.mode, 'mkdir');
  assert.ok(fs.existsSync(h.lockPath));
  assert.ok(fs.existsSync(path.join(h.lockPath, 'pid')));
  const info = m.readLockInfo(9222);
  assert.equal(info.tool, 'demo-webctl');
  assert.equal(info.command, 'click');
  assert.equal(info.pid, process.pid);
  m.releaseLock(h);
  assert.ok(!fs.existsSync(h.lockPath), 'released');
  assert.equal(m.readLockInfo(9222), null);
});

test('mkdir: second acquire times out while the first is held (mutual exclusion)', async () => {
  const { m } = mk();
  const h = await m.acquireLock(9222, 1000);
  await assert.rejects(() => m.acquireLock(9222, 30), (e) => {
    assert.ok(e instanceof LockTimeoutError);
    assert.equal(e.code, 'LOCK_TIMEOUT');
    return true;
  });
  m.releaseLock(h);
  // now free
  const h2 = await m.acquireLock(9222, 1000);
  assert.ok(h2.lockPath);
  m.releaseLock(h2);
});

test('timeoutExitCode is carried on the thrown error', async () => {
  const { m } = mk({ timeoutExitCode: 5 });
  const h = await m.acquireLock(9222, 1000);
  await assert.rejects(() => m.acquireLock(9222, 20), (e) => e.exitCode === 5);
  m.releaseLock(h);
});

// ── stale reclaim: dead pid ─────────────────────────────────────────────────

test('mkdir: reclaims a lock whose pid is dead', async () => {
  const { m, lockBaseDir } = mk();
  // fabricate a held lock owned by a surely-dead pid
  const dir = m.getLockPath(9300);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pid'), '999999999\n'); // not a live pid
  assert.equal(m.isStale(9300), true);
  const h = await m.acquireLock(9300, 1000); // should reclaim + acquire
  assert.equal(m.readLockInfo(9300).pid, process.pid);
  m.releaseLock(h);
});

test('mkdir: orphaned dir (no pid file) is stale -> reclaimed', async () => {
  const { m } = mk();
  fs.mkdirSync(m.getLockPath(9301), { recursive: true });
  assert.equal(m.isStale(9301), true);
  const h = await m.acquireLock(9301, 1000);
  m.releaseLock(h);
});

// ── stale reclaim: age (wedged-but-alive holder) ────────────────────────────

test('mkdir: staleAgeSec reclaims an aged lock even if the pid is alive', async () => {
  const { m } = mk({ staleAgeSec: 900 }); // 15 min
  const dir = m.getLockPath(9400);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid) + '\n'); // OUR pid = alive
  assert.equal(m.isStale(9400), false, 'fresh + alive -> not stale');
  agePath(dir, 901); // back-date past 15 min
  assert.equal(m.isStale(9400), true, 'aged past staleAgeSec -> stale despite alive pid');
});

test('staleAgeSec defaults OFF (0): an aged but alive lock is NOT reclaimed', async () => {
  const { m } = mk(); // no staleAgeSec
  const dir = m.getLockPath(9401);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid) + '\n');
  agePath(dir, 100000);
  assert.equal(m.isStale(9401), false, 'age-reclaim is opt-in; alive holder kept');
});

// ── symlink safety ──────────────────────────────────────────────────────────

test('mkdir: a symlinked lock path is NEVER treated as stale (no clobber)', async () => {
  const { m } = mk();
  const real = tmpDir();
  const link = m.getLockPath(9500);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  assert.equal(m.isStale(9500), false, 'refuse to follow/clobber a symlink');
});

// ── metadata off (telegram-minimal) ─────────────────────────────────────────

test('metadata:false writes no meta.json (minimal mode)', async () => {
  const { m } = mk({ metadata: false });
  const h = await m.acquireLock(9600, 1000);
  assert.ok(!fs.existsSync(path.join(h.lockPath, 'meta.json')));
  assert.ok(fs.existsSync(path.join(h.lockPath, 'pid')), 'pid still written');
  m.releaseLock(h);
});

// ── flock path via an injected fake impl ────────────────────────────────────

test('flock: uses an injected flockImpl; second acquire blocks; release unlocks', async () => {
  // a fake advisory-lock table keyed by fd-backed file path
  const held = new Set();
  const fdToPath = new Map();
  const realOpen = fs.openSync;
  // wrap openSync to remember which path each fd maps to
  const wrapFs = Object.create(fs);
  wrapFs.openSync = (p, ...a) => { const fd = realOpen.call(fs, p, ...a); fdToPath.set(fd, String(p)); return fd; };
  const flockImpl = (fd, op) => {
    const p = fdToPath.get(fd);
    if (op === 'un') { held.delete(p); return; }
    if (held.has(p)) { const e = new Error('would block'); /** @type {any} */ (e).code = 'EWOULDBLOCK'; throw e; }
    held.add(p);
  };
  const lockBaseDir = path.join(tmpDir(), 'locks');
  const m = createProcessMutex(fakeC(), { lockBaseDir, flock: 'on', flockImpl, fs: wrapFs, retryMs: 5 });
  const h = await m.acquireLock(9700, 1000);
  assert.equal(h.mode, 'flock');
  assert.ok(fs.existsSync(`${h.lockPath}.meta.json`));
  await assert.rejects(() => m.acquireLock(9700, 20), (e) => e instanceof LockTimeoutError);
  m.releaseLock(h);
  const h2 = await m.acquireLock(9700, 1000); // free again
  assert.equal(h2.mode, 'flock');
  m.releaseLock(h2);
});

test("flock:'auto' falls back to mkdir when no flockImpl injected", async () => {
  const { m } = mk(); // auto + no flockImpl
  const h = await m.acquireLock(9800, 1000);
  assert.equal(h.mode, 'mkdir', 'mkdir is the universal floor');
  m.releaseLock(h);
});
