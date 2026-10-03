// driver-refuses-remote-docker.test.js — the docker driver refuses a REMOTE docker-ctl.
//
// createDockerCtl({dockerHost}) binds docker-ctl to a remote daemon, but this driver's
// profile path, owner uid, port check, prefs and lock are local. Given one, it used to run
// half-local: containers on the remote named after the LOCAL uid, a LOCAL bind path, a
// LOCAL lock (measured by webctl:mgr). An option it cannot honour is refused (v7x3);
// remote containers are xq's (rx9q).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import { createDockerCtl } from '../lib/browser-location/docker-ctl.js';

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
const mounts = (/** @type {any} */ C) => createMounts(C, { dockerfilesDir: '/df' });

/** A docker double that RECORDS every call, so "refused before any docker verb" is provable. */
function recordingDocker(extra = {}) {
  /** @type {string[]} */
  const calls = [];
  const handler = {
    get(/** @type {any} */ t, /** @type {string} */ k) {
      if (k in t) return t[k];
      return (...args) => { calls.push(`${k}:${JSON.stringify(args[0] ?? null)}`); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); };
    },
  };
  return { docker: new Proxy({ ...extra }, handler), calls };
}

test('⛔ a docker-ctl bound to a REMOTE daemon is refused at construction — zero docker calls', () => {
  const C = fakeC();
  const { docker, calls } = recordingDocker({ dockerHost: 'ssh://browserhost' });
  assert.throws(
    () => createChromiumDockerXpra(C, { mounts: mounts(C), docker }),
    (/** @type {any} */ e) => e.exitCode === 4 && /runs containers on THIS machine only/.test(e.message) && /xq/.test(e.message),
  );
  assert.deepEqual(calls, [], 'refused before ANY docker verb');
});

test('the REAL createDockerCtl({dockerHost}) is refused the same way (no stub shortcut)', () => {
  const C = fakeC();
  const remote = createDockerCtl({ dockerHost: 'ssh://browserhost' });
  assert.throws(() => createChromiumDockerXpra(C, { mounts: mounts(C), docker: remote }), /remote\s+docker/);
});

test('CONTROL: a local docker-ctl (no dockerHost) constructs as before', () => {
  const C = fakeC();
  const { docker, calls } = recordingDocker();
  const factory = createChromiumDockerXpra(C, { mounts: mounts(C), docker });
  assert.equal(typeof factory.createDriver, 'function');
  assert.deepEqual(calls, [], 'construction itself stays side-effect free');
});
