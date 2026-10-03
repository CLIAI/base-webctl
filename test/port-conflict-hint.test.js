// port-conflict-hint.test.js — the "Inspect:" line a human copies must name the
// port's HOLDER, never its clients.
//
// `lsof -i :<port>` lists every process with a socket on that port — the
// listener AND everything connected to it. A consumer lane read that output,
// took a pid from it and SIGTERM'd its own test process, which was a client.
// The hint base prints on a port conflict was the same shape. It now prints the
// listener form: `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
//
// ⚠ This path had NO test: no existing suite reached the docker-up pre-flight
// with `force` off. So the fixture here first proves the conflict is REAL (two
// sockets this test holds), then asserts the hint's shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import { guardedDocker, assertHermetic, INSPECT_ABSENT } from './helpers/fake-docker-inspect.mjs';

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

/** Hold a listener on an OS-assigned loopback port; the test owns it. */
function hold() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve(srv));
  });
}

async function bringUp(cfg) {
  const C = fakeC();
  /** @type {any[]} */
  const runs = [];
  const { docker, violations } = guardedDocker({
    dockerAvailable: async () => true,
    containerExists: async () => false,
    containerRunning: async () => false,
    imageExists: async () => true,
    rm: async () => ({ code: 0 }),
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    runDetached: async (/** @type {any} */ a) => { runs.push(a); return { code: 0, stderr: '' }; },
  }, { run: { inspect: () => INSPECT_ABSENT } }); // the ownership inspect: no container exists
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker })
    .createDriver({ host: '127.0.0.1', slug: 'test', force: false, ...cfg });
  let error;
  try { await drv.ensureRunning(); } catch (e) { error = e; }
  assertHermetic(violations);
  return { error, runs };
}

test('a port conflict names the LISTENER, never the clients — and no container is started', async () => {
  const a = await hold();
  const b = await hold();
  try {
    const cdp = a.address().port;
    const xpra = b.address().port;
    const { error, runs } = await bringUp({ port: cdp, xpraTcpPort: xpra });

    // Positive control first: the conflict path was really taken.
    assert.ok(error, 'bring-up over two held ports must be refused');
    const msg = String(error.message);
    assert.match(msg, /port conflict/);
    assert.equal(runs.length, 0, 'the pre-flight refusal must come before any docker run');

    const line = msg.split('\n').find((l) => l.includes('Inspect:'));
    assert.ok(line, `no Inspect: line in:\n${msg}`);
    assert.match(line, new RegExp(`-iTCP:${cdp}\\b`));
    assert.match(line, new RegExp(`-iTCP:${xpra}\\b`));
    assert.match(line, /-sTCP:LISTEN\b/, 'the hint must restrict lsof to the listener');
    // The client-including form, which a lane acted on, must be gone.
    assert.doesNotMatch(line, /-i\s*:\d/, 'bare `-i :<port>` also lists connected clients');
  } finally {
    a.close(); b.close();
  }
});
