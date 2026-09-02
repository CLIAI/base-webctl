// storage-paths.test.js — createStoragePaths(C, opts) (v59v).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createStoragePaths } from '../lib/storage-paths.js';
import { createMounts } from '../lib/browser-location/mounts.js';

const C = {
  PROJECT: 'demo-webctl',
  ARTIFACT_PREFIX: 'demo-webctl-',
  IMAGE_CHROMIUM_REPO: 'demo/chromium',
  IMAGE_XPRA: 'demo/xpra:latest',
  DEFAULT_CDP_PORT: 4999,
  CACHE_DIRNAME: 'demo-webctl',
  ZOOM_DEFAULT_HOST: 'demo.example',
  CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc',
  DOTENV_FILENAME: '.env.demo-webctl',
  DOTENV_TEMPLATE: '.env.demo-webctl.example',
  ENV_PREFIX: 'DEMO_',
  ENV_PREFIX_LEGACY: null,
  ENV_LEGACY_SUFFIXES: [],
};

/** env with every XDG var absent — the state most consumers are actually in. */
const noXdg = { HOME: '/home/u' };

// ── the one that matters most: don't move anyone's files by accident ─────────

test('with XDG unset, cacheRoot is BYTE-IDENTICAL to what consumers use today', () => {
  // base derives this path in three separate hardcoded places today. If the
  // resolver disagrees with any of them, adopting it silently relocates a
  // consumer's cache, profiles and locks — the failure this standard exists to
  // prevent, caused by the fix for it.
  const sp = createStoragePaths(C, { env: noXdg });
  assert.equal(sp.cacheRoot, '/home/u/.cache/CLIAI/demo-webctl');
  assert.equal(sp.locksDir, '/home/u/.cache/CLIAI/demo-webctl/locks');
  assert.equal(sp.logsDir, '/home/u/.cache/CLIAI/demo-webctl/logs');
  assert.equal(sp.profilesRoot, '/home/u/.cache/CLIAI/demo-webctl/profiles');
});

test('it agrees with mounts.cacheRoot(), the de-facto reference implementation', () => {
  // Compared against the REAL function rather than a restatement of it, so the
  // two cannot drift apart while both look right in isolation.
  const realHome = process.env.HOME || process.env.USERPROFILE;
  const sp = createStoragePaths(C, { env: { HOME: realHome } });
  const m = createMounts(C, { assert: false, dockerfilesDir: '/df' });
  assert.equal(sp.cacheRoot, m.cacheRoot());
});

// ── XDG, implemented rather than assumed ────────────────────────────────────

test('XDG roots are honoured when absolute', () => {
  const sp = createStoragePaths(C, {
    env: {
      HOME: '/home/u',
      XDG_CONFIG_HOME: '/cfg',
      XDG_CACHE_HOME: '/cache',
      XDG_STATE_HOME: '/state',
    },
  });
  assert.equal(sp.configRoot, '/cfg/CLIAI/demo-webctl');
  assert.equal(sp.cacheRoot, '/cache/CLIAI/demo-webctl');
  assert.equal(sp.stateRoot, '/state/CLIAI/demo-webctl');
  assert.equal(sp.gatewayStatePath(), '/state/CLIAI/demo-webctl/xpra-access.json');
});

test('a RELATIVE XDG value is ignored, per the spec, not resolved against cwd', () => {
  // Resolving it would place secret-grade material wherever the process happens
  // to be cwd'd, which is attacker-influencable in some invocations.
  const sp = createStoragePaths(C, { env: { HOME: '/home/u', XDG_CACHE_HOME: 'relative/path' } });
  assert.equal(sp.cacheRoot, '/home/u/.cache/CLIAI/demo-webctl');
});

test('no HOME and no XDG throws rather than inventing /tmp', () => {
  assert.throws(
    () => createStoragePaths(C, { env: {} }),
    /Refusing to guess/,
    'defaulting to /tmp would put profiles and grants somewhere world-readable',
  );
});

// ── locks: the relocation that would break mutual exclusion ─────────────────

test('locks do NOT move to XDG_RUNTIME_DIR just because it is set', () => {
  // $XDG_RUNTIME_DIR is set on virtually every desktop session, so "use it when
  // present" would silently relocate locks for nearly everyone. During a rollout
  // that means one process on the old base and one on the new take locks in two
  // different directories and BOTH believe they hold it — the exact
  // mutual-exclusion failure the mutex exists to prevent, caused by upgrading.
  const sp = createStoragePaths(C, { env: { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' } });
  assert.equal(sp.locksDir, '/home/u/.cache/CLIAI/demo-webctl/locks');
});

test('locks move only on explicit opt-in', () => {
  const sp = createStoragePaths(C, {
    env: { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' },
    preferRuntimeDirForLocks: true,
  });
  assert.equal(sp.locksDir, '/run/user/1000/CLIAI/demo-webctl/locks');
});

test('opting in without XDG_RUNTIME_DIR falls back rather than failing', () => {
  const sp = createStoragePaths(C, { env: { HOME: '/home/u' }, preferRuntimeDirForLocks: true });
  assert.equal(sp.locksDir, '/home/u/.cache/CLIAI/demo-webctl/locks');
});

// ── migration: read both, move nothing ──────────────────────────────────────

/** @param {string[]} existing */
function fakeFs(existing) {
  return { existsSync: (/** @type {string} */ p) => existing.includes(p) };
}

test('resolveExisting prefers canonical, falls back to legacy, never deletes', () => {
  const legacy = '/home/u/.cache/CLIAI/default/webctl/ledger.jsonl';
  const canonical = '/home/u/.cache/CLIAI/demo-webctl/ledger.jsonl';

  // Only the legacy file exists -> read it. A file written before the migration
  // must not become invisible; that is the whole failure mode being avoided.
  const onlyLegacy = createStoragePaths(C, { env: noXdg, fs: fakeFs([legacy]) });
  assert.equal(onlyLegacy.resolveExisting('ledger.jsonl'), legacy);
  assert.equal(onlyLegacy.isLegacy('ledger.jsonl'), true);

  // Both exist -> canonical wins, and the legacy file is left alone.
  const both = createStoragePaths(C, { env: noXdg, fs: fakeFs([legacy, canonical]) });
  assert.equal(both.resolveExisting('ledger.jsonl'), canonical);
  assert.equal(both.isLegacy('ledger.jsonl'), false);

  // Neither exists -> canonical, so writers always write canonically.
  const neither = createStoragePaths(C, { env: noXdg, fs: fakeFs([]) });
  assert.equal(neither.resolveExisting('ledger.jsonl'), canonical);
});

test('the surface exposes NO delete/move/clean operation at all', () => {
  // Enforced, not just documented: the standard says the migration must never
  // delete, and the cheapest way to keep that true is to ship no verb that can.
  const sp = createStoragePaths(C, { env: noXdg });
  for (const name of Object.keys(sp)) {
    assert.doesNotMatch(
      name,
      /^(rm|remove|delete|unlink|clean|purge|prune|move|rename|migrate)/i,
      `storage-paths must expose no mutating verb; found "${name}"`,
    );
  }
});

// ── config + dotenv ─────────────────────────────────────────────────────────

test('configFile places the client segment inside the per-tool root', () => {
  const sp = createStoragePaths(C, { env: noXdg });
  assert.equal(sp.configFile(), '/home/u/.config/CLIAI/demo-webctl/demo-webctl.config.jsonc');
  assert.equal(
    sp.configFile('acme'),
    '/home/u/.config/CLIAI/demo-webctl/acme/webctl/demo-webctl.config.jsonc',
  );
});

test('config is keyed on PROJECT, cache on CACHE_DIRNAME — pinned while they agree', () => {
  // In all four real consumers these fields are EQUAL, so any divergence is
  // invisible today and would surface as config silently relocating for the
  // first consumer that sets them apart. Pinned here with them deliberately
  // different, so the resolver's choice is asserted rather than coincidental.
  const split = { ...C, PROJECT: 'the-project', CACHE_DIRNAME: 'the-cache-dir' };
  const sp = createStoragePaths(split, { env: noXdg });
  assert.equal(sp.configRoot, '/home/u/.config/CLIAI/the-project');
  assert.equal(sp.cacheRoot, '/home/u/.cache/CLIAI/the-cache-dir');
  assert.equal(sp.stateRoot, '/home/u/.local/state/CLIAI/the-cache-dir');
});

test('dotenv candidates are project-root FIRST, then the XDG location', () => {
  const sp = createStoragePaths(C, { env: noXdg });
  const cands = sp.dotenvCandidates('/repo');
  assert.deepEqual(cands, [
    path.join('/repo', '.env.demo-webctl'),
    '/home/u/.config/CLIAI/demo-webctl/.env.demo-webctl',
  ]);
});
