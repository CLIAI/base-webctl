// control-endpoint.test.js — the endpoint shape xq ships, consumed EXACTLY (6gi0 §2),
// the loopback rule behind B4 (gvlx §7), and the sealed-ancestor check (6gi0 §2).
//
// The two schema-1 fixtures below are xq's own literals, copied from xq's
// `scripts/tests/wait_ready_json_test.py` at xq main 0a4fab6. If xq changes its
// shape, these stop matching xq — they do not silently follow it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseControlEndpoint, isLoopbackHost, findSealedAncestor, assertSealedPath, SUN_PATH_MAX,
} from '../lib/control-endpoint.js';

const XQ_TCP = Object.freeze({
  name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'tcp', host: '127.0.0.1', port: 47010,
});
const XQ_UNIX = Object.freeze({
  name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'unix', host: null, port: null,
  path: '/z/w/control/c/cdp.sock', host_header: '127.0.0.1:9222',
});

// ── A16: parseControlEndpoint consumes xq's shape exactly ───────────────────

test('A16 control: xq\'s literal schema-1 endpoints parse UNCHANGED (same object back)', () => {
  assert.equal(parseControlEndpoint(XQ_TCP), XQ_TCP);
  assert.equal(parseControlEndpoint(XQ_UNIX), XQ_UNIX);
  // xq reports docker's binding, which can be the v6 loopback
  assert.doesNotThrow(() => parseControlEndpoint({ ...XQ_TCP, host: '::1' }));
  // base's own tcp form carries explicit nulls for the unix-only fields
  assert.doesNotThrow(() => parseControlEndpoint({ ...XQ_TCP, path: null, host_header: null }));
  // kind is null when an image declares none (xq: labels.get → None)
  assert.doesNotThrow(() => parseControlEndpoint({ ...XQ_UNIX, kind: null }));
});

test('A16 control: an unknown EXTRA field is ignored (schema 1 is additive)', () => {
  assert.doesNotThrow(() => parseControlEndpoint({ ...XQ_UNIX, someday: { a: 1 } }));
});

test('A16: an unknown transport is REFUSED, never read as tcp', () => {
  assert.throws(() => parseControlEndpoint({ ...XQ_TCP, transport: 'vsock' }), /transport/);
  assert.throws(() => parseControlEndpoint({ ...XQ_TCP, transport: undefined }), /transport/);
});

test('A16: unix with a non-null host or port beside the path is REFUSED (t2wf)', () => {
  assert.throws(() => parseControlEndpoint({ ...XQ_UNIX, host: '127.0.0.1' }), /host/);
  assert.throws(() => parseControlEndpoint({ ...XQ_UNIX, port: 9222 }), /port/);
});

test('A16: unix WITHOUT host_header is REFUSED — never defaulted', () => {
  const { host_header, ...rest } = XQ_UNIX; // eslint-disable-line no-unused-vars
  assert.throws(() => parseControlEndpoint(rest), /host_header/);
  assert.throws(() => parseControlEndpoint({ ...XQ_UNIX, host_header: null }), /host_header/);
  assert.throws(() => parseControlEndpoint({ ...XQ_UNIX, host_header: 'not a host' }), /host_header/);
});

test('A16: a relative path, or one that cannot fit sun_path, is REFUSED', () => {
  assert.throws(() => parseControlEndpoint({ ...XQ_UNIX, path: 'rel/cdp.sock' }), /absolute/);
  const at = (n) => '/' + 'a'.repeat(n - 1);
  assert.equal(at(SUN_PATH_MAX).length, SUN_PATH_MAX);
  assert.doesNotThrow(() => parseControlEndpoint({ ...XQ_UNIX, path: at(SUN_PATH_MAX) }));
  assert.throws(() => parseControlEndpoint({ ...XQ_UNIX, path: at(SUN_PATH_MAX + 1) }), /108|bytes/);
});

test('A16: a non-loopback tcp host, or a bad port, is REFUSED', () => {
  for (const host of ['0.0.0.0', '::', '192.0.2.10', 'localhost', '']) {
    assert.throws(() => parseControlEndpoint({ ...XQ_TCP, host }), /loopback/, host);
  }
  for (const port of [0, 70000, '47010', 1.5, null]) {
    assert.throws(() => parseControlEndpoint({ ...XQ_TCP, port }), /port/, String(port));
  }
});

test('A16: a known field with a value of the wrong type is REFUSED', () => {
  assert.throws(() => parseControlEndpoint(null), /object/);
  assert.throws(() => parseControlEndpoint({ ...XQ_TCP, name: 5 }), /name/);
  assert.throws(() => parseControlEndpoint({ ...XQ_TCP, adapter: 7 }), /adapter/);
  assert.throws(() => parseControlEndpoint({ ...XQ_TCP, path: '/x.sock' }), /path/);
});

// ── B4's rule ──────────────────────────────────────────────────────────────

test('isLoopbackHost: 127/8 and ::1 only — never a name, a wildcard or another address', () => {
  for (const h of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ['0.0.0.0', '::', '', 'localhost', '192.0.2.10', '127.0.0.256', '127.1',
    '1127.0.0.1', '127.0.0.1 ', ' 127.0.0.1', null, undefined, 127]) {
    assert.equal(isLoopbackHost(/** @type {any} */ (h)), false, String(h));
  }
});

// ── A17: the sealed-ancestor check ─────────────────────────────────────────

/** A scratch tree under a fresh 0700 mkdtemp, removed afterwards. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-seal-'));
  return { root, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('A17 control: an xq-like layout passes — sealed 0700 zone dir above a 0755 control dir', () => {
  const { root, done } = scratch();
  try {
    const zone = path.join(root, 'zones', 'z');
    const ctl = path.join(zone, 'control', 'c');
    fs.mkdirSync(ctl, { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(root, 'zones'), 0o755);
    fs.chmodSync(zone, 0o700);
    fs.chmodSync(path.join(zone, 'control'), 0o755);
    fs.chmodSync(ctl, 0o755);
    const sock = path.join(ctl, 'cdp.sock');
    assert.equal(findSealedAncestor(sock), fs.realpathSync(zone));
    assert.doesNotThrow(() => assertSealedPath(sock));
  } finally { done(); }
});

test('A17 control: base\'s own 0700 channel dir seals itself', () => {
  const { root, done } = scratch();
  try {
    const dir = path.join(root, 'run', 'k');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(path.join(root, 'run'), 0o755);
    assert.equal(findSealedAncestor(path.join(dir, 'cdp.sock')), fs.realpathSync(dir));
  } finally { done(); }
});

test('A17: every ancestor 0755 up to a foreign-owned parent ⇒ NOT sealed, refused', () => {
  const { root, done } = scratch();
  try {
    const dir = path.join(root, 'a', 'b');
    fs.mkdirSync(dir, { recursive: true });
    for (const d of [root, path.join(root, 'a'), dir]) fs.chmodSync(d, 0o755);
    // os.tmpdir() is root-owned (1777), so the walk stops there unsealed
    assert.equal(findSealedAncestor(path.join(dir, 'cdp.sock')), null);
    assert.throws(() => assertSealedPath(path.join(dir, 'cdp.sock')), /sealed|other users/);
  } finally { done(); }
});

test('A17: a FOREIGN-owned sealed-looking ancestor does not seal (injected lstat)', () => {
  const me = process.getuid ? process.getuid() : 1000;
  /** @type {Record<string, {uid:number, mode:number}>} */
  const tree = {
    '/s': { uid: me + 1, mode: 0o40700 },          // 0700 — but not ours
    '/s/c': { uid: me, mode: 0o40755 },
  };
  const lstat = (/** @type {string} */ p) => {
    const e = tree[p] || { uid: 0, mode: 0o40755 };
    return { uid: e.uid, mode: e.mode, isSymbolicLink: () => false, isDirectory: () => true };
  };
  assert.equal(findSealedAncestor('/s/c/cdp.sock', { uid: me, lstat, realpath: (p) => p }), null);
});

test('A17: a foreign-owned component BELOW the seal ⇒ refused (it could swap the socket)', () => {
  const me = process.getuid ? process.getuid() : 1000;
  /** @type {Record<string, {uid:number, mode:number}>} */
  const tree = {
    '/s': { uid: me, mode: 0o40700 },              // our seal …
    '/s/c': { uid: me + 1, mode: 0o40755 },        // … with someone else's dir under it
  };
  const lstat = (/** @type {string} */ p) => {
    const e = tree[p] || { uid: 0, mode: 0o40755 };
    return { uid: e.uid, mode: e.mode, isSymbolicLink: () => false, isDirectory: () => true };
  };
  assert.equal(findSealedAncestor('/s/c/cdp.sock', { uid: me, lstat, realpath: (p) => p }), null);
});
