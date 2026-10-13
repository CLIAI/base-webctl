// xpra-socket-attach.test.js — A13: under owner-only channels, attach and presence go
// over the peercred unix socket, never tcp:// (gvlx §5.3). TCP attach (remote, or the
// html5-on fallback) carries --password-file — the path, never the secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createXpraAttach } from '../lib/browser-location/xpra-attach.js';
import { xpraInfoArgs } from '../lib/xpra-presence.js';

const C = {
  PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
  IMAGE_CHROMIUM_REPO: 'demo/chromium', IMAGE_XPRA: 'demo/xpra:latest',
  DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
  ZOOM_DEFAULT_HOST: 'demo.example', CONFIG_FILE_PROJECT: 'demo.config.jsonc',
  DOTENV_FILENAME: '.env.demo', DOTENV_TEMPLATE: '.env.demo.example',
  ENV_PREFIX: 'DEMO_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
};
const SOCK = '/state/run/0123456789ab/xpra.sock';

test('A13: attachArgs({socketPath}) attaches over socket://, never tcp://', () => {
  const x = createXpraAttach(/** @type {any} */ (C));
  assert.deepEqual(x.attachArgs({ socketPath: SOCK }), ['attach', `socket://${SOCK}`]);
  assert.deepEqual(x.attachArgs({ socketPath: SOCK, readonly: true }), ['attach', `socket://${SOCK}`, '--readonly=yes']);
  assert.ok(!x.attachArgs({ socketPath: SOCK }).join(' ').includes('tcp://'));
});

test('A13: a socketPath AND a port are refused — two ways to say where', () => {
  const x = createXpraAttach(/** @type {any} */ (C));
  assert.throws(() => x.attachArgs({ socketPath: SOCK, port: 14327 }), /not both/);
  assert.throws(() => x.attachArgs({ socketPath: 'relative.sock' }), /absolute/);
});

test('A13: TCP attach carries --password-file (the path), never the secret', () => {
  const x = createXpraAttach(/** @type {any} */ (C));
  assert.deepEqual(x.attachArgs({ port: 14327, passwordFile: '/state/auth/k/xpra.pass' }),
    ['attach', 'tcp://127.0.0.1:14327/', '--password-file=/state/auth/k/xpra.pass']);
});

test('A13 control: the legacy tcp form is unchanged', () => {
  const x = createXpraAttach(/** @type {any} */ (C));
  assert.deepEqual(x.attachArgs({ port: 20000 }), ['attach', 'tcp://127.0.0.1:20000/']);
});

test('A13: presence asks xpra over the socket; the tcp form is unchanged', () => {
  assert.deepEqual(xpraInfoArgs({ socketPath: SOCK }), ['info', `socket://${SOCK}`]);
  assert.deepEqual(xpraInfoArgs(14327), ['info', 'tcp://127.0.0.1:14327/']);
  assert.deepEqual(xpraInfoArgs({ port: 14327, passwordFile: '/p' }),
    ['info', 'tcp://127.0.0.1:14327/', '--password-file=/p']);
  assert.equal(xpraInfoArgs(0), null);
  assert.equal(xpraInfoArgs({}), null);
});
