// docker-up-lock-fails-closed.test.js — ow9k: the profile lock taken after
// bring-up is NOT forced, and failing to take it STOPS the start.
//
// The driver used to call `profileLock.acquire(…, { force: true })` and, on any
// error, log a WARN and continue. Step 0's holder check is a READ: between it
// and step 9 another runner can take the lock, and `force` overwrote that live
// claim. A swallowed write error left a browser running that no lock described.
// (Raised by `webctl:mgr` from `linkedin`'s re-shim, which had inherited the
// pattern in its local copy.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import * as realDocker from '../lib/browser-location/docker-ctl.js';
import { INSPECT_ABSENT, inspectPresent } from './helpers/fake-docker-inspect.mjs';

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
function hermeticMounts(C) {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  const fake = (/** @type {string} */ s, /** @type {string} */ u) => u || `/tmp/no-mkdir/${s}`;
  return { ...m, resolveChromiumProfile: fake, profilePathFor: fake, cacheRoot: () => '/tmp/cache' };
}

/**
 * A profile lock that records what the driver asked of it.
 * @param {{acquire: (opts: any) => any, current?: any}} b
 */
function recordingLock(b) {
  /** @type {any[]} */
  const acquires = [];
  let reads = 0;
  return {
    acquires,
    readLock: () => (reads++ === 0 ? null : (b.current ?? null)), // step 0 sees none
    isHolderAlive: async () => ({ alive: false, reason: 'test' }),
    acquire: async (/** @type {any} */ _p, /** @type {any} */ _info, /** @type {any} */ opts) => {
      acquires.push(opts);
      return b.acquire(opts);
    },
    describeHolder: (/** @type {any} */ l) => (l ? `container=${l.containerName}` : '(none)'),
    lockPath: (/** @type {string} */ p) => `${p}/.lock`,
    release: () => {},
  };
}

async function bringUp(/** @type {any} */ lock) {
  const C = fakeC();
  /** @type {string[]} */
  const removed = [];
  let started = 0;
  // The teardown proves the pair ours before removing it. Inspect reports what
  // THIS bring-up actually started, with the labels it actually passed — so the
  // teardown passes only because the driver labelled its own containers.
  /** @type {Map<string, Record<string,string>>} */
  const live = new Map();
  const docker = {
    ...realDocker,
    dockerAvailable: async () => true,
    containerExists: async () => false,
    containerRunning: async (/** @type {string} */ n) => started > 0 && n.includes('chromium'),
    imageExists: async () => true,
    rm: async (/** @type {string} */ n) => { removed.push(n); return { code: 0 }; },
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    run: async (/** @type {string[]} */ a) => {
      if (a[0] !== 'inspect') return { code: 0, stdout: '', stderr: '' };
      const n = a[a.length - 1];
      return live.has(n) ? inspectPresent(n, { labels: live.get(n) }) : INSPECT_ABSENT;
    },
    runDetached: async (/** @type {any} */ o) => {
      started++; live.set(o.name, o.labels || {}); return { code: 0, stderr: '' };
    },
  };
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker, profileLock: lock })
    // Portless: no CDP poll. force: skip the port pre-flight (a different `force`).
    .createDriver({ port: 45999, host: '127.0.0.1', slug: 'test', force: true,
      containerEnv: { LWC_CDP_PORT: null } });
  /** @type {any} */
  let result, error;
  try { result = await drv.ensureRunning(); } catch (e) { error = e; }
  // only removals AFTER containers were started count as teardown
  return { result, error, removed, started };
}

test('CONTROL: a free lock is acquired WITHOUT force and the start succeeds', async () => {
  const lock = recordingLock({ acquire: () => ({ ok: true, lock: {}, tookOver: false }) });
  const { result, error } = await bringUp(lock);
  assert.equal(error, undefined, error && error.message);
  assert.equal(result.ok, true);
  assert.equal(lock.acquires.length, 1);
  assert.equal(lock.acquires[0].force, false, 'no force when no lock names this container');
});

test('⛔ a live holder that appeared during bring-up STOPS the start — and our containers are removed', async () => {
  const lock = recordingLock({
    current: { containerName: 'someone-else' },
    acquire: () => ({ ok: false, conflict: true, previous: { containerName: 'someone-else' } }),
  });
  const { error, removed, started } = await bringUp(lock);
  assert.ok(started > 0, 'premise: containers were started before the lock step');
  assert.ok(error, 'must refuse');
  assert.match(String(error.message), /profile lock NOT acquired/);
  assert.match(String(error.message), /container=someone-else/);
  assert.equal(lock.acquires[0].force, false, 'a foreign lock is never forced');
  const tail = removed.slice(-2).join(' ');
  assert.match(tail, /chromium/);
  assert.match(tail, /xpra/);
});

test('⛔ a lock that cannot be WRITTEN stops the start (it used to be a WARN and continue)', async () => {
  const lock = recordingLock({ acquire: () => { throw new Error('EROFS: read-only file system'); } });
  const { error } = await bringUp(lock);
  assert.ok(error, 'must refuse');
  assert.match(String(error.message), /could not be written: EROFS/);
});

test('force is used ONLY when the existing lock names THIS container (idempotent up)', async () => {
  const lock = recordingLock({
    current: { containerName: 'demo-webctl-chromium-test' },
    acquire: () => ({ ok: true, lock: {}, tookOver: true, forced: true, previous: { containerName: 'x' } }),
  });
  const { error } = await bringUp(lock);
  assert.equal(error, undefined, error && error.message);
  assert.equal(lock.acquires[0].force, true);
});
