// container-env-seam.test.js — cfg.containerEnv on the docker-xpra driver.
//
// Requested by the claude-chrome-extension-webctl lane, which is genuinely
// unblocked on MOUNTS (its opts.mounts wrapper works) and genuinely blocked on
// ENV — because the driver sets LWC_CDP_PORT unconditionally, and the portless
// mode Greg asked for needs a caller able to DECLINE it.
//
// The seam copies the in-tree uploadDirs spread-gate: absent means
// byte-unchanged, so a consumer that does not participate sees no difference.

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

/** Capture the CHROMIUM container's docker-run args (the second runDetached). */
async function captureChromiumEnv(cfg) {
  const C = fakeC();
  /** @type {any[]} */
  const calls = [];
  const docker = {
    ...realDocker,
    dockerAvailable: async () => true,
    containerExists: async () => false,
    containerRunning: async () => false,
    imageExists: async () => true,
    rm: async () => ({ code: 0 }),
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    // The X-server wait polls `xdpyinfo ... && echo ok` and checks stdout for
    // 'ok' — an empty stdout with code 0 is NOT success, and would have stalled
    // bring-up until its poll timed out. Answering the probe rather than just
    // returning zero.
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    runDetached: async (/** @type {any} */ a) => {
      calls.push(a);
      // Let the xpra container "succeed" so bring-up reaches chromium; fail the
      // chromium one so it unwinds right after we have its args.
      return a.name.includes('chromium') ? { code: 1, stderr: 'halted by test' } : { code: 0, stderr: '' };
    },
  };
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker })
    .createDriver({ port: 4327, host: '127.0.0.1', slug: 'test', force: true, ...cfg });
  try { await drv.ensureRunning(); } catch { /* expected */ }
  const chromium = calls.find((c) => String(c.name).includes('chromium'));
  if (!chromium) {
    throw new Error(
      `chromium container was never started, so nothing was captured — ` +
      `any assertion below would be vacuous (captured: ${calls.map((c) => c.name).join(', ') || 'nothing'})`,
    );
  }
  return chromium.env;
}

test('no containerEnv -> byte-unchanged (the gate)', async () => {
  const env = await captureChromiumEnv({});
  assert.equal(env.DISPLAY, ':99');
  assert.equal(env.LWC_CDP_PORT, '14327' in env ? env.LWC_CDP_PORT : String(4327));
  assert.equal(env.LWC_CHROMIUM_PROFILE, '/home/user/.config/chromium');
});

test('a string value adds a key', async () => {
  const env = await captureChromiumEnv({ containerEnv: { LWC_LOAD_EXTENSION: '/ext/claude' } });
  assert.equal(env.LWC_LOAD_EXTENSION, '/ext/claude');
  assert.equal(env.LWC_CDP_PORT, String(4327), 'adding a key must not disturb the others');
});

test('⭐ null REMOVES a driver-set key — this is what makes portless possible', async () => {
  // The entrypoint adds --remote-debugging-port ONLY when LWC_CDP_PORT is set,
  // so "no CDP" is expressed by the variable being ABSENT. An additive-only
  // seam could never express that, which is why deletion is in the contract.
  const env = await captureChromiumEnv({ containerEnv: { LWC_CDP_PORT: null } });
  assert.ok(!('LWC_CDP_PORT' in env), 'LWC_CDP_PORT must be absent, not empty-string');
  assert.equal(env.DISPLAY, ':99', 'removing one key must not disturb the wiring');
});

test('the driver WIRING is refused at construction, not silently honoured', () => {
  // DISPLAY and LWC_CHROMIUM_PROFILE are correspondences with decisions made
  // elsewhere in the same function (the netns/Xvfb setup, the profile
  // bind-mount). Overriding either does not error at runtime — it produces a
  // black screen, or a browser writing where nothing is mounted.
  // Refused at CONSTRUCTION, before any container exists — a typo must not
  // cost a half-built stack, and the error must arrive instead of a bring-up
  // rather than after one.
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  for (const key of ['DISPLAY', 'LWC_CHROMIUM_PROFILE']) {
    assert.throws(
      () => drv.createDriver({ port: 4327, host: '127.0.0.1', slug: 'test', containerEnv: { [key]: '/x' } }),
      /refusing to override/,
      `${key} is wiring and must be refused`,
    );
  }
});

test('invalid keys and non-string values are refused at construction', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const mk = (containerEnv) => () =>
    drv.createDriver({ port: 4327, host: '127.0.0.1', slug: 'test', containerEnv });
  assert.throws(mk({ 'not-a-valid-name': 'x' }), /not a valid environment variable name/);
  assert.throws(mk({ LWC_THING: 42 }), /must be a string \(or null to remove\)/,
    'a number would be stringified by docker and silently mean something else');
  assert.throws(mk(['NOT', 'AN', 'OBJECT']), /must be an object/);
});
