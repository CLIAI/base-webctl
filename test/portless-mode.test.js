// portless-mode.test.js — the browser "without CDP" that Greg asked for.
//
// The image always supported it (the entrypoint adds --remote-debugging-port
// only when LWC_CDP_PORT is set); the driver set the variable unconditionally,
// so the no-port branch existed and had never been taken. Filed by the
// claude-chrome-extension-webctl lane, whose framing is the one that matters:
// ⭐ IT IS AN UNTESTED AXIS, NOT AN EXISTING ONE.
//
// The hard part was never "stop setting the variable" — it is that FIVE places
// treat CDP-unreachable as a fault, so without them "no CDP was requested" and
// "CDP is down" are the SAME OBSERVATION. A check that cannot distinguish two
// states where one is healthy is the failure this repo has spent a week on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import * as realDocker from '../lib/browser-location/docker-ctl.js';

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
  return { ...m, resolveChromiumProfile: (s, u) => u || `/tmp/no-mkdir/${s}`, cacheRoot: () => '/tmp/cache' };
}

const PORTLESS = { containerEnv: { LWC_CDP_PORT: null } };

/**
 * Bring a stack up with a docker stub that NEVER answers CDP — which is the
 * real situation in portless mode, since nothing is listening.
 * @param {object} cfg
 * @param {{chromiumStaysUp?: boolean}} [o]
 */
async function bringUp(cfg, o = {}) {
  const C = fakeC();
  /** @type {any[]} */
  const calls = [];
  const docker = {
    ...realDocker,
    dockerAvailable: async () => true,
    containerExists: async () => false,
    containerRunning: async (/** @type {string} */ n) =>
      n.includes('chromium') ? (o.chromiumStaysUp !== false) : false,
    imageExists: async () => true,
    rm: async () => ({ code: 0 }),
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    run: async () => ({ code: 0, stdout: 'container logs', stderr: '' }),
    runDetached: async (/** @type {any} */ a) => { calls.push(a); return { code: 0, stderr: '' }; },
  };
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker })
    .createDriver({ port: 4327, host: '127.0.0.1', slug: 'test', force: true, ...cfg });
  let result, error;
  try { result = await drv.ensureRunning(); } catch (e) { error = e; }
  return { calls, result, error, drv };
}

test('portless bring-up SUCCEEDS even though CDP never answers', async () => {
  // The whole point. With CDP enabled this same stub would fail bring-up after
  // 15s of polling a port nothing is listening on.
  const { result, error } = await bringUp(PORTLESS);
  assert.equal(error, undefined, `bring-up must not fail: ${error && error.message}`);
  assert.equal(result?.ok, true);
});

test('CONTROL: with CDP enabled the same stub FAILS — so the test is not vacuous', async () => {
  // If this passed too, the test above would prove nothing about portless: it
  // would just mean the stub happens to satisfy everything.
  const { error } = await bringUp({});
  assert.ok(error, 'CDP-enabled bring-up must fail when nothing answers CDP');
  assert.match(String(error.message), /CDP not reachable/);
});

test('the CDP port is neither PUBLISHED nor pre-flight reserved', async () => {
  // Publishing a port nothing listens on is exactly the xpra-html5 defect
  // v0.6.0 removed. Declining to open it and then advertising it anyway would
  // reintroduce that, in a place a caller has more reason to trust.
  const { calls } = await bringUp(PORTLESS);
  const xpra = calls.find((c) => String(c.name).includes('xpra'));
  const published = (xpra.publish || []).map((/** @type {any[]} */ p) => Number(p[2]));
  assert.ok(!published.includes(4327), `CDP port must not be published, got ${published.join(',')}`);
  assert.ok(published.includes(14327), 'the xpra port must still be published');
});

test('LWC_CDP_PORT really is absent from the container env', async () => {
  const { calls } = await bringUp(PORTLESS);
  const chromium = calls.find((c) => String(c.name).includes('chromium'));
  assert.ok(!('LWC_CDP_PORT' in chromium.env), 'absent, not empty — the entrypoint tests for SET');
});

test('inspect() and describe() say which mode this is, rather than implying it', async () => {
  const { drv } = await bringUp(PORTLESS);
  const i = drv.inspect();
  assert.equal(i.cdpEnabled, false);
  assert.equal(i.cdpHttpUrl, null, 'must not hand back a URL for a port we did not open');
  assert.match(drv.describe(), /PORTLESS/);

  const { drv: withCdp } = await bringUp({});
  const j = withCdp.inspect();
  assert.equal(j.cdpEnabled, true);
  assert.equal(j.cdpHttpUrl, 'http://127.0.0.1:4327');
});

test('healthCheck reports a portless stack HEALTHY, not permanently down', async () => {
  const { drv } = await bringUp(PORTLESS);
  assert.equal(await drv.healthCheck(), true);
});

test('a portless stack that DIES is still reported as a failure', async () => {
  // The mode must not become an excuse to stop noticing real faults — the
  // criterion moved from "CDP answers" to "chromium is running", and that
  // second one still has to be able to say no.
  const { error } = await bringUp(PORTLESS, { chromiumStaysUp: false });
  assert.ok(error, 'a chromium that exits must fail bring-up even portless');
  assert.match(String(error.message), /portless mode/);

  const { drv } = await bringUp(PORTLESS, { chromiumStaysUp: false });
  assert.equal(await drv.healthCheck(), false);
});
