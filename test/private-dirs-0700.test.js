// private-dirs-0700.test.js — A14: every directory base CREATES is 0700 (gvlx §3).
//
// Measured on running pairs: profile dirs were 0755 (mkdirSync with no mode under
// umask 022), protected only because an ancestor happened to be 0700. A profile
// under a 0755 home has no such ancestor. ⇒ Base creates its own dirs 0700, under
// ANY umask, and never chmods a directory it did not create.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMounts } from '../lib/browser-location/mounts.js';
import { createProfileLock } from '../lib/browser-location/profile-lock.js';
import { createProcessMutex } from '../lib/process-mutex.js';
import { applyStartupPolicyToPreferences, preferencesPath } from '../lib/chromium-prefs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeC() {
  return {
    PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
    IMAGE_CHROMIUM_REPO: 'demo/chromium', IMAGE_XPRA: 'demo/xpra:latest',
    DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'demo.example', CONFIG_FILE_PROJECT: 'demo.config.jsonc',
    DOTENV_FILENAME: '.env.demo', DOTENV_TEMPLATE: '.env.demo.example',
    ENV_PREFIX: 'DEMO_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
  };
}

/** @param {string} p */
const modeOf = (p) => fs.statSync(p).mode & 0o777;

/**
 * Run `fn(root)` once per umask, in a fresh scratch root, restoring the umask.
 * @param {(root: string, umask: number) => Promise<void>|void} fn
 */
async function underUmasks(fn) {
  for (const um of [0o022, 0o000]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-0700-'));
    const prev = process.umask(um);
    try { await fn(root, um); } finally {
      process.umask(prev);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

test('A14: the profile dir base creates is 0700 — leaf AND the parents it creates', async () => {
  await underUmasks((root, um) => {
    const m = createMounts(fakeC(), { dockerfilesDir: '/df' });
    const udd = path.join(root, 'made', 'by', 'base', 'chromium');
    m.resolveChromiumProfile('s', udd);
    for (const d of [udd, path.dirname(udd), path.join(root, 'made')]) {
      assert.equal(modeOf(d), 0o700, `${path.relative(root, d)} under umask ${um.toString(8)}`);
    }
  });
});

test('A14 control: a directory base did NOT create is never chmodded', async () => {
  await underUmasks((root) => {
    const existing = path.join(root, 'theirs');
    fs.mkdirSync(existing, { mode: 0o755 });
    fs.chmodSync(existing, 0o755);
    const m = createMounts(fakeC(), { dockerfilesDir: '/df' });
    m.resolveChromiumProfile('s', path.join(existing, 'chromium'));
    assert.equal(modeOf(existing), 0o755, 'an existing parent keeps its mode');
    assert.equal(modeOf(path.join(existing, 'chromium')), 0o700);
  });
});

test('A14: the profile lock\'s directory is created 0700', async () => {
  await underUmasks(async (root) => {
    const pl = createProfileLock(fakeC(), { assert: false });
    const prof = path.join(root, 'p', 'chromium');
    const r = await pl.acquire(prof, { mode: 'test', pid: process.pid });
    assert.ok(r && r.ok);
    assert.equal(modeOf(prof), 0o700);
    assert.equal(modeOf(path.dirname(prof)), 0o700);
  });
});

test('A14: the process mutex\'s lock base dir is created 0700', async () => {
  await underUmasks(async (root) => {
    const base = path.join(root, 'locks', 'here');
    const mx = createProcessMutex(fakeC(), { assert: false, lockBaseDir: base, signalCleanup: false });
    const h = await mx.acquireLock(45999, 0, {});
    try {
      assert.equal(modeOf(base), 0o700);
      assert.equal(modeOf(path.dirname(base)), 0o700);
      assert.equal(modeOf(h.lockPath), 0o700, 'the lock dir itself');
    } finally { mx.releaseLock(h); }
  });
});

test('A14: the Preferences dir chromium-prefs creates is 0700', async () => {
  await underUmasks((root) => {
    const prof = path.join(root, 'prof');
    applyStartupPolicyToPreferences(preferencesPath(prof));
    assert.equal(modeOf(path.join(prof, 'Default')), 0o700);
    assert.equal(modeOf(prof), 0o700);
  });
});

test('A14 (source arm): EVERY mkdirSync in lib/ passes mode 0o700', () => {
  /** @type {string[]} */
  const files = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'lib'));
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const missing = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l) || !/\bmkdirSync\(/.test(l)) return;
      const where = `${path.relative(ROOT, f)}:${i + 1}`;
      calls.push(where);
      if (!/mode:\s*0o700/.test(l)) missing.push(`${where}: ${l.trim()}`);
    });
  }
  // ⛔ A source arm that finds nothing passes vacuously; at v0.34.2 there are ≥ 9 sites.
  assert.ok(calls.length >= 9, `found only ${calls.length} mkdirSync call(s) — the scan has lost its subject`);
  assert.deepEqual(missing, [], 'every directory base creates must be created 0700');
});
