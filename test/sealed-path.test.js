// sealed-path.test.js — review of v0.34.2, F3 and F4: a unix control socket's PATH, judged whole.
//
// ⛔ The seal used to be judged ALONE: everything above the sealed dir and every symlink in the path as given were
// ignored, and the client then dialled the unresolved original path. Two layouts let another user plant an IMPOSTOR
// that receives cookies, typed input and passwords:
//   (a) <a 0777 dir another user owns>/sealed/cdp.sock — its owner renames `sealed` away and plants one;
//   (b) <another user's symlink>/cdp.sock, pointing into our 0700 dir — re-pointed later.
// And xpra attach / presence did not check the socket path at all (F4). These arms run each layout PURELY (injected
// lstat, another uid) and on the real filesystem (a group/other-writable dir of OUR OWN — the same exposure, no other
// uid needed). isolation-free; the real other-uid layouts run in sealed-path-real.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { findSealedAncestor, assertSealedPath, inspectSocketPath } from '../lib/control-endpoint.js';
import { ensurePrivateDir } from '../lib/browser-location/owner-channels.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ME = typeof process.getuid === 'function' ? process.getuid() : 1000;
const OTHER = 65534;

/**
 * A fake filesystem for the pure arms: path → {uid, mode, kind, to?}. lstat as the kernel would; realpath follows links.
 * @param {Record<string, {uid: number, mode: number, kind: 'dir'|'link'|'sock', to?: string}>} fsmap
 */
function fakeFs(fsmap) {
  const lstat = (/** @type {string} */ p) => {
    const e = fsmap[p];
    if (!e) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return { uid: e.uid, mode: e.mode, isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'link', isSocket: () => e.kind === 'sock' };
  };
  const realpath = (/** @type {string} */ p) => {
    let out = '';
    for (const part of p.split('/').filter(Boolean)) {
      out = `${out}/${part}`;
      const e = fsmap[out];
      if (e && e.kind === 'link') out = /** @type {string} */ (e.to);
    }
    return out || '/';
  };
  return { uid: ME, lstat, realpath };
}
const ROOTS = { '/': { uid: 0, mode: 0o755, kind: /** @type {const} */ ('dir') }, '/t': { uid: 0, mode: 0o1777, kind: /** @type {const} */ ('dir') } };

test('⛔ review F3 (a), pure: a seal under a 0777 dir ANOTHER user owns is refused — its owner can rename the seal away', () => {
  const f = fakeFs({ ...ROOTS, '/t/x': { uid: OTHER, mode: 0o777, kind: 'dir' }, '/t/x/sealed': { uid: ME, mode: 0o700, kind: 'dir' } });
  assert.equal(findSealedAncestor('/t/x/sealed/cdp.sock', f), null);
  assert.match(inspectSocketPath('/t/x/sealed/cdp.sock', f).why, /\/t\/x is owned by uid 65534/);
  // CONTROL: the same seal under a root-owned sticky dir is fine
  const g = fakeFs({ ...ROOTS, '/t/sealed': { uid: ME, mode: 0o700, kind: 'dir' } });
  assert.equal(findSealedAncestor('/t/sealed/cdp.sock', g), '/t/sealed');
});

test('⛔ review F3 (b), pure: a path through ANOTHER user\'s symlink into our 0700 dir is refused — it can be re-pointed', () => {
  const f = fakeFs({ ...ROOTS, '/t/evil-link': { uid: OTHER, mode: 0o777, kind: 'link', to: '/t/ours' }, '/t/ours': { uid: ME, mode: 0o700, kind: 'dir' } });
  assert.equal(findSealedAncestor('/t/evil-link/cdp.sock', f), null);
  assert.match(inspectSocketPath('/t/evil-link/cdp.sock', f).why, /evil-link is owned by uid 65534/);
  // CONTROL: OUR OWN symlink into the same dir is accepted — and the REAL path is what is returned
  const g = fakeFs({ ...ROOTS, '/t/my-link': { uid: ME, mode: 0o777, kind: 'link', to: '/t/ours' }, '/t/ours': { uid: ME, mode: 0o700, kind: 'dir' } });
  assert.equal(assertSealedPath('/t/my-link/cdp.sock', g), '/t/ours/cdp.sock');
});

test('⛔ review F3, pure: the socket itself must be a socket we own — a foreign socket or a link in the sealed dir is refused', () => {
  const base = { ...ROOTS, '/t/s': { uid: ME, mode: 0o700, kind: /** @type {const} */ ('dir') } };
  assert.equal(findSealedAncestor('/t/s/cdp.sock', fakeFs({ ...base, '/t/s/cdp.sock': { uid: OTHER, mode: 0o666, kind: 'sock' } })), null);
  assert.equal(findSealedAncestor('/t/s/cdp.sock', fakeFs({ ...base, '/t/s/cdp.sock': { uid: ME, mode: 0o777, kind: 'link', to: '/x' } })), null);
  assert.equal(findSealedAncestor('/t/s/cdp.sock', fakeFs({ ...base, '/t/s/cdp.sock': { uid: ME, mode: 0o600, kind: 'sock' } })), '/t/s', 'CONTROL');
});

/** A real scratch dir with an UNSAFE parent of our own: `<tmp>/open` is 0777 (not sticky), `<tmp>/open/sealed` 0700. */
function openLayout() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-seal-')));
  const open = path.join(tmp, 'open');
  const sealed = path.join(open, 'sealed');
  fs.mkdirSync(sealed, { recursive: true, mode: 0o700 });
  fs.chmodSync(open, 0o777);
  return { tmp, open, sealed, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('⛔ review F3, real fs: a sealed dir under a group/other-WRITABLE parent is refused — CONTROL: the parent at 0700 seals', () => {
  const l = openLayout();
  try {
    assert.throws(() => assertSealedPath(path.join(l.sealed, 'cdp.sock')), /writable by group or others/);
    fs.chmodSync(l.open, 0o700);
    assert.equal(assertSealedPath(path.join(l.sealed, 'cdp.sock')), path.join(l.sealed, 'cdp.sock'));
  } finally { l.done(); }
});

test('⛔ review F3: ensurePrivateDir refuses a 0700 dir whose PARENT is loosened — CONTROL: a sealed parent passes', () => {
  const l = openLayout();
  try {
    assert.throws(() => ensurePrivateDir(l.sealed), /its path is not safe: .*writable by group or others/);
    fs.chmodSync(l.open, 0o700);
    assert.doesNotThrow(() => ensurePrivateDir(l.sealed));
  } finally { l.done(); }
});

/** A fake `xpra` that records each invocation's argv. @param {string} dir */
function fakeXpra(dir) {
  const log = path.join(dir, 'xpra.log');
  fs.writeFileSync(path.join(dir, 'xpra'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho clients=1\n`, { mode: 0o755 });
  return { log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

test('⛔ review F4: xpra ATTACH refuses an unsafe socket path before spawning xpra (exit 4) — CONTROL: a safe one spawns with the REAL path', () => {
  const l = openLayout();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-xbin-'));
  try {
    const x = fakeXpra(bin);
    const mod = pathToFileURL(path.join(ROOT, 'lib', 'browser-location', 'xpra-attach.js')).href;
    const tpl = pathToFileURL(path.join(ROOT, 'lib', 'client-config.constants.template.js')).href;
    const run = (/** @type {string} */ sock) => spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { createXpraAttach } = await import(${JSON.stringify(mod)});
      const T = await import(${JSON.stringify(tpl)});
      const C = T.EXAMPLE_CONSTANTS || T.default || {};
      const a = createXpraAttach(C, { assert: false });
      process.stdout.write('RC=' + await a.attach({ socketPath: ${JSON.stringify(sock)} }));
    `], { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
    const bad = run(path.join(l.sealed, 'xpra.sock'));
    assert.match(bad.stdout, /RC=4/, bad.stderr);
    assert.match(bad.stderr, /xpra attach REFUSED/);
    assert.deepEqual(x.calls(), [], 'xpra was spawned at an unsafe path');
    fs.chmodSync(l.open, 0o700);
    const ok = run(path.join(l.sealed, 'xpra.sock'));
    assert.match(ok.stdout, /RC=0/, ok.stderr);
    assert.deepEqual(x.calls(), [`attach socket://${path.join(l.sealed, 'xpra.sock')}`]);
  } finally { l.done(); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('⛔ review F4: the xpra PRESENCE probe asks nothing at an unsafe socket path (false, no spawn) — CONTROL: a safe one is asked', () => {
  const l = openLayout();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-xbin-'));
  try {
    const x = fakeXpra(bin);
    const mod = pathToFileURL(path.join(ROOT, 'lib', 'xpra-presence.js')).href;
    const ask = (/** @type {string} */ sock) => spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(mod)}); process.stdout.write(String(m.isXpraClientAttached({ socketPath: ${JSON.stringify(sock)} })))`],
    { env: { ...process.env, PATH: bin }, encoding: 'utf8' }).stdout;
    assert.equal(ask(path.join(l.sealed, 'xpra.sock')), 'false');
    assert.deepEqual(x.calls(), [], 'xpra info was spawned at an unsafe path');
    fs.chmodSync(l.open, 0o700);
    assert.equal(ask(path.join(l.sealed, 'xpra.sock')), 'true', 'CONTROL');
    assert.equal(x.calls().length, 1);
  } finally { l.done(); fs.rmSync(bin, { recursive: true, force: true }); }
});
