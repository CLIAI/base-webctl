// owner-channels.test.js — A6 (channel/secret dir modes), A7 (sun_path), A8 (secret
// creation), and the bind strings A2 asserts on (gvlx §5.2, §8).
//
// Every arm runs in a fresh mkdtemp root and writes nothing outside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  channelPaths, ensurePrivateDir, ensureSecret, rotateSecret, xpraChannelEnv, parseXpraTcpBind,
  CONTAINER_CHANNEL_DIR, CONTAINER_SECRET_DIR, SECRET_BYTES,
} from '../lib/browser-location/owner-channels.js';
import { SUN_PATH_MAX } from '../lib/control-endpoint.js';

/** @param {(root: string) => any} fn */
async function inRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-och-'));
  try { return await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
/** @param {string} p */
const modeOf = (p) => fs.lstatSync(p).mode & 0o777;

// ── paths ──────────────────────────────────────────────────────────────────

test('channelPaths: keyed on the TARGET (path.resolve of the profile), stable, distinct per profile', () => {
  const a = channelPaths({ stateRoot: '/s', profilePath: '/p/one/chromium' });
  const b = channelPaths({ stateRoot: '/s', profilePath: '/p/one/../one/chromium' });
  const c = channelPaths({ stateRoot: '/s', profilePath: '/p/two/chromium' });
  assert.equal(a.key, b.key, 'the same target, spelled differently, is one key');
  assert.notEqual(a.key, c.key);
  assert.match(a.key, /^[0-9a-f]{12}$/);
  assert.equal(a.channelDir, path.join('/s', 'run', a.key));
  assert.equal(a.secretDir, path.join('/s', 'auth', a.key));
  assert.equal(a.cdpSock, path.join(a.channelDir, 'cdp.sock'));
  assert.equal(a.xpraSock, path.join(a.channelDir, 'xpra.sock'));
  assert.equal(a.secretFile, path.join(a.secretDir, 'xpra.pass'));
});

// ── A7: sun_path ───────────────────────────────────────────────────────────

test('A7: a socket path over 107 bytes is refused, naming its length; 107 is accepted', () => {
  // channelDir = <stateRoot>/run/<12hex>; socket = <channelDir>/xpra.sock (longest name)
  const fixed = '/run/'.length + 12 + '/xpra.sock'.length;
  const rootOf = (/** @type {number} */ total) => '/' + 'r'.repeat(total - fixed - 1);
  assert.doesNotThrow(() => channelPaths({ stateRoot: rootOf(SUN_PATH_MAX), profilePath: '/p' }).assertFits());
  assert.throws(() => channelPaths({ stateRoot: rootOf(SUN_PATH_MAX + 1), profilePath: '/p' }).assertFits(),
    /108 bytes/);
});

// ── A6: private dirs ───────────────────────────────────────────────────────

test('A6 control: an absent dir is created 0700 (parents too); an own 0700 dir is accepted', async () => {
  await inRoot((root) => {
    const d = path.join(root, 'state', 'run', 'k');
    ensurePrivateDir(d);
    assert.equal(modeOf(d), 0o700);
    assert.equal(modeOf(path.dirname(d)), 0o700);
    assert.doesNotThrow(() => ensurePrivateDir(d));
  });
});

test('A6: a pre-existing LOOSENED dir is REFUSED — and NOT chmodded', async () => {
  await inRoot((root) => {
    const d = path.join(root, 'loose');
    fs.mkdirSync(d);
    fs.chmodSync(d, 0o755);
    assert.throws(() => ensurePrivateDir(d), /0755|group\/other/);
    assert.equal(modeOf(d), 0o755, 'tightening it silently would hide whoever loosened it');
  });
});

test('A6: a symlink in place of the dir is refused, not followed', async () => {
  await inRoot((root) => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    assert.throws(() => ensurePrivateDir(link), /symlink/);
  });
});

test('A6: a dir owned by ANOTHER uid is refused (injected lstat)', () => {
  const me = process.getuid ? process.getuid() : 1000;
  const lstat = () => ({ uid: me + 1, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false });
  assert.throws(() => ensurePrivateDir('/x', { lstat, mkdir: () => {} }), /owned by uid/);
});

// ── A8: the secret ─────────────────────────────────────────────────────────

test('A8: the secret is created 0600 in a 0700 dir, ≥32 random bytes, no newline', async () => {
  await inRoot((root) => {
    const dir = path.join(root, 'auth', 'k');
    const f = ensureSecret(dir);
    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(f), 0o600);
    const v = fs.readFileSync(f, 'utf8');
    assert.ok(Buffer.from(v, 'base64url').length >= SECRET_BYTES);
    assert.ok(SECRET_BYTES >= 32);
    assert.doesNotMatch(v, /\s/);
    assert.equal(ensureSecret(dir), f, 'an existing good secret is reused');
    assert.equal(fs.readFileSync(f, 'utf8'), v, '… unchanged');
  });
});

test('A8: a secret created under umask 0000 is still 0600', async () => {
  await inRoot((root) => {
    const prev = process.umask(0);
    try { assert.equal(modeOf(ensureSecret(path.join(root, 'a'))), 0o600); } finally { process.umask(prev); }
  });
});

test('A8: a PLANTED SYMLINK at the secret path is refused, never followed', async () => {
  await inRoot((root) => {
    const dir = path.join(root, 'auth');
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(root, 'elsewhere');
    fs.writeFileSync(target, 'x'.repeat(64));
    fs.symlinkSync(target, path.join(dir, 'xpra.pass'));
    assert.throws(() => ensureSecret(dir), /symlink|regular file/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'x'.repeat(64), 'the link target is untouched');
  });
});

test('A8: an existing secret that is group/other-readable, or too short, is refused', async () => {
  await inRoot((root) => {
    const dir = path.join(root, 'auth');
    fs.mkdirSync(dir, { mode: 0o700 });
    const f = path.join(dir, 'xpra.pass');
    fs.writeFileSync(f, 'a'.repeat(64), { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    assert.throws(() => ensureSecret(dir), /0644|group\/other/);
    fs.chmodSync(f, 0o600);
    fs.writeFileSync(f, 'short');
    assert.throws(() => ensureSecret(dir), /bytes/);
  });
});

test('rotateSecret: atomic rename in the same dir — new content, still 0600, same inode path', async () => {
  await inRoot((root) => {
    const dir = path.join(root, 'auth');
    const f = ensureSecret(dir);
    const before = fs.readFileSync(f, 'utf8');
    const ino = fs.statSync(f).ino;
    rotateSecret(dir);
    const after = fs.readFileSync(f, 'utf8');
    assert.notEqual(after, before);
    assert.equal(modeOf(f), 0o600);
    assert.notEqual(fs.statSync(f).ino, ino, 'a NEW inode — which is why the DIRECTORY is mounted (gvlx §8.2)');
    assert.deepEqual(fs.readdirSync(dir), ['xpra.pass'], 'no temp file left behind');
  });
});

// ── bind strings (A2 asserts these through the driver) ─────────────────────

test('xpraChannelEnv: peercred unix socket; TCP always auth=file (comma form); loopback unless html5', () => {
  const off = xpraChannelEnv({ xpraTcpPort: 45999, html5: false });
  assert.equal(off.XPRA_BIND, `${CONTAINER_CHANNEL_DIR}/xpra.sock,auth=peercred`);
  assert.equal(off.XPRA_TCP_BIND, `127.0.0.1:45999,auth=file,filename=${CONTAINER_SECRET_DIR}/xpra.pass`);
  const on = xpraChannelEnv({ xpraTcpPort: 45999, html5: true });
  assert.equal(on.XPRA_TCP_BIND, `0.0.0.0:45999,auth=file,filename=${CONTAINER_SECRET_DIR}/xpra.pass`);
  for (const v of [off.XPRA_TCP_BIND, on.XPRA_TCP_BIND]) {
    assert.doesNotMatch(v, /auth=file:/, 'the colon form inside a bind string refuses EVERY password (gvlx §5.1)');
  }
});

test('parseXpraTcpBind: reads host, port and auth from a bind string (exposure() relies on it)', () => {
  assert.deepEqual(parseXpraTcpBind('0.0.0.0:14327'), { host: '0.0.0.0', port: 14327, auth: null });
  assert.deepEqual(parseXpraTcpBind('127.0.0.1:1,auth=file,filename=/x'), { host: '127.0.0.1', port: 1, auth: 'file' });
  assert.deepEqual(parseXpraTcpBind('0.0.0.0:2,auth=file:filename=/x'), { host: '0.0.0.0', port: 2, auth: 'file:filename=/x' });
  assert.equal(parseXpraTcpBind(undefined), null);
});
