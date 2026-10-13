// publish-loopback-b4.test.js — B4: a port is published on LOOPBACK or not at all
// (gvlx §7). Refused at BOTH layers: the driver's ensureRunning(), before any docker
// call, and docker-ctl's runDetached(), which every caller passes through.
//
// ⚠ Loopback is not the whole boundary (gvlx §1: the bridge address) — but a
// non-loopback publish hands an unauthenticated browser to every machine that can
// route here, which is strictly worse, and it is refused outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import child_process from 'node:child_process';

import * as dockerCtl from '../lib/browser-location/docker-ctl.js';
import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import { createClientConfig } from '../lib/client-config.js';
import { TEST_CACHE_ROOT } from './helpers/test-cache-root.mjs';

const BAD = ['0.0.0.0', '::', '', 'localhost', '192.0.2.10'];
const GOOD = ['127.0.0.1', '127.0.0.2', '::1'];

/** @param {(args: string[]) => void} onSpawn */
function fakeSpawn(onSpawn) {
  return (/** @type {string} */ _cmd, /** @type {string[]} */ args) => {
    onSpawn(args);
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  };
}

/** @param {(args: string[]) => void} onSpawn @param {() => Promise<any>} fn */
async function withSpawn(onSpawn, fn) {
  const orig = child_process.spawn;
  // @ts-expect-error — test monkey-patch of the builtin docker-ctl spawns through
  child_process.spawn = fakeSpawn(onSpawn);
  try { return await fn(); } finally { child_process.spawn = orig; }
}

test('B4 docker-ctl: runDetached REFUSES a non-loopback publish host, spawning nothing', async () => {
  for (const host of BAD) {
    const spawned = [];
    await withSpawn((a) => spawned.push(a), async () => {
      await assert.rejects(
        dockerCtl.runDetached({ name: 'x', image: 'i', publish: [[host, '45001', 45001]] }),
        /not a loopback address/, `host ${JSON.stringify(host)} must be refused`);
    });
    assert.equal(spawned.length, 0, `nothing may be spawned for ${JSON.stringify(host)}`);
  }
});

test('B4 docker-ctl control: loopback publish hosts still run', async () => {
  for (const host of GOOD) {
    const spawned = [];
    await withSpawn((a) => spawned.push(a), () =>
      dockerCtl.runDetached({ name: 'x', image: 'i', publish: [[host, '45001', 45001]] }));
    assert.equal(spawned.length, 1, host);
    assert.ok(spawned[0].join(' ').includes(`-p ${host}:45001:45001`), host);
  }
});

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
/** @param {any} C */
function hermeticMounts(C) {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  const fake = (/** @type {string} */ s, /** @type {string} */ u) => u || `/tmp/no-mkdir/${s}`;
  return { ...m, resolveChromiumProfile: fake, profilePathFor: fake, cacheRoot: () => TEST_CACHE_ROOT };
}

/** A docker whose EVERY member access is recorded — B4 must refuse before any. */
function recordingDocker() {
  /** @type {string[]} */
  const touched = [];
  const docker = new Proxy({}, {
    get(_t, p) {
      if (typeof p === 'symbol' || p === 'then') return undefined;
      touched.push(String(p));
      return async () => false; // dockerAvailable() → false, so a control stops early
    },
  });
  return { docker, touched };
}

test('B4 driver: ensureRunning REFUSES a non-loopback host before ANY docker call (exit 4)', async () => {
  const C = fakeC();
  for (const host of BAD) {
    const { docker, touched } = recordingDocker();
    const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker })
      .createDriver({ port: 45327, host, slug: 'b4', hostSource: 'jsonc:host' });
    await assert.rejects(drv.ensureRunning(), (/** @type {any} */ e) => {
      assert.equal(e.exitCode, 4, `exit code for ${JSON.stringify(host)}`);
      assert.match(e.message, /not a loopback address/);
      assert.match(e.message, /came from jsonc:host/, 'the refusal names where the host came from');
      assert.match(e.message, /gui expose/);
      return true;
    });
    assert.deepEqual(touched, [], `no docker member may be touched for ${JSON.stringify(host)}`);
  }
});

test('B4 driver control: a loopback host passes the check (and fails later, for an unrelated reason)', async () => {
  const C = fakeC();
  for (const host of GOOD) {
    const { docker, touched } = recordingDocker();
    const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker })
      .createDriver({ port: 45327, host, slug: 'b4' });
    await assert.rejects(drv.ensureRunning(), (/** @type {any} */ e) => {
      assert.doesNotMatch(e.message, /not a loopback address/, host);
      return true;
    });
    assert.ok(touched.includes('dockerAvailable'), 'it reached docker — so the check let it through');
  }
});

test('B4 driver: a read-only caller can still CONSTRUCT and inspect a bad-host driver', () => {
  const C = fakeC();
  const { docker, touched } = recordingDocker();
  const d = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker })
    .createDriver({ port: 45327, host: '0.0.0.0', slug: 'b4' });
  const i = d.inspect();
  assert.equal(i.host, '0.0.0.0');
  assert.ok(i.exposure.reasons.some((/** @type {string} */ r) => /not a loopback address/.test(r)),
    'inspect().exposure names the bad host rather than construction refusing');
  assert.deepEqual(touched, []);
});

test('B4: buildDriverCfg carries hostSource, so a refusal can say where the host came from', () => {
  const c = createClientConfig(/** @type {any} */ ({ ...fakeC() }));
  assert.equal(c.buildDriverCfg({ args: {}, dotenv: {}, env: {}, jsonc: {} }).hostSource, 'default');
  assert.equal(c.buildDriverCfg({ args: {}, dotenv: {}, env: {}, jsonc: { host: '0.0.0.0' } }).hostSource, 'jsonc:host');
});

// ── review of v0.34.2, F6: `extra` and the network are not a way around `publish` ──

import { exposureFlagsWhy as reviewExposureFlagsWhy, runDetached as reviewRunDetached } from '../lib/browser-location/docker-ctl.js';
import { readdirSync as reviewReaddir, readFileSync as reviewRead, statSync as reviewStat } from 'node:fs';
import { join as reviewJoin, dirname as reviewDirname } from 'node:path';
import { fileURLToPath as reviewF2p } from 'node:url';

test('⛔ review F6: runDetached refuses a wildcard/LAN publish, -P or the host network smuggled in `extra` or `network` — before docker is touched', async () => {
  const cases = [['-p', '8080:80'], ['-p', '80'], ['-p8080:80'], ['--publish', '0.0.0.0:8080:80'], ['--publish=192.0.2.5:8080:80'],
    ['-P'], ['--publish-all'], ['--network', 'host'], ['--net=host'], ['--network=host']];
  for (const extra of cases) {
    await assert.rejects(reviewRunDetached({ name: 'webctl-it-never', image: 'never/runs', extra }), /refusing/, extra.join(' '));
  }
  await assert.rejects(reviewRunDetached({ name: 'webctl-it-never', image: 'never/runs', network: 'host' }), /refusing/);
});

test('review F6, logic: loopback publishes and a pair namespace pass — CONTROL for the refusals above', () => {
  for (const ok of [['-p', '127.0.0.1:8080:80'], ['--publish=127.0.0.1:1:2'], ['-p', '[::1]:8080:80'], ['--network', 'container:webctl-x-xpra'],
    ['--network', 'none'], ['--shm-size=1g']]) {
    assert.equal(reviewExposureFlagsWhy(ok), '', ok.join(' '));
  }
});

test('⛔ review F6, source: no lib code starts a container with a raw `run([\'run\'|\'create\', …])` — runDetached is the one way (its B4 claim depends on it)', () => {
  const lib = reviewJoin(reviewDirname(reviewF2p(import.meta.url)), '..', 'lib');
  /** @type {string[]} */ const hits = [];
  const walk = (/** @type {string} */ d) => {
    for (const n of reviewReaddir(d)) {
      const p = reviewJoin(d, n);
      if (reviewStat(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) {
        // CODE only: a comment may name the forbidden shape (docker-ctl's own does, to forbid it)
        const code = reviewRead(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        if (/\brun\(\s*\[\s*['"](run|create)['"]|['"]container['"]\s*,\s*['"](run|create)['"]/.test(code)) hits.push(p);
      }
    }
  };
  walk(lib);
  assert.deepEqual(hits, []);
});
