// Unit tests for createXpraAttach(C) — host-side xpra attach/detach helpers
// (sm2t seam). Canonical = linkedin (it parameterizes opts.html5Port, default
// port+1, and interpolates it into the "xpra not installed" hint; chatgpt
// hardcoded 14501). Only attach() closes over C (the [C.PROJECT] hint prefix);
// attachArgs/attachCommand are pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createXpraAttach } from '../lib/browser-location/xpra-attach.js';

function fakeC(overrides = {}) {
  return {
    PROJECT: 'demo-webctl',
    ARTIFACT_PREFIX: 'demo-webctl-',
    IMAGE_CHROMIUM_REPO: 'demo-webctl/chromium',
    IMAGE_XPRA: 'demo-webctl/xpra-ubuntu:latest',
    DEFAULT_CDP_PORT: 4999,
    CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'www.demo.example',
    CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc',
    DOTENV_FILENAME: '.env.demo-webctl',
    DOTENV_TEMPLATE: '.env.demo-webctl.example',
    ENV_PREFIX: 'CLIAI_DEMO_WEBCTL_',
    ENV_PREFIX_LEGACY: null,
    ENV_LEGACY_SUFFIXES: [],
    ...overrides,
  };
}

test('createXpraAttach: validates C; surfaces attach/attachArgs/attachCommand', () => {
  assert.throws(() => createXpraAttach(/** @type {any} */ ({})), /Invalid client-config constants/);
  const x = createXpraAttach(fakeC());
  for (const k of ['attach', 'attachArgs', 'attachCommand']) {
    assert.equal(typeof x[k], 'function', `expected ${k}`);
  }
});

test('attachArgs: default port 14500, tcp url, readonly flag', () => {
  const x = createXpraAttach(fakeC());
  assert.deepEqual(x.attachArgs({}), ['attach', 'tcp://127.0.0.1:14500/']);
  assert.deepEqual(x.attachArgs({ port: 20000 }), ['attach', 'tcp://127.0.0.1:20000/']);
  assert.deepEqual(x.attachArgs({ port: 20000, readonly: true }),
    ['attach', 'tcp://127.0.0.1:20000/', '--readonly=yes']);
});

test('attachCommand: shell-quoted single string', () => {
  const x = createXpraAttach(fakeC());
  assert.equal(x.attachCommand({ port: 20000 }), 'xpra attach tcp://127.0.0.1:20000/');
});

test('attach: when xpra absent, hint interpolates the parameterized html5Port (linkedin canonical)', async () => {
  const x = createXpraAttach(fakeC());
  const origPath = process.env.PATH;
  const origWrite = process.stderr.write;
  let captured = '';
  try {
    process.env.PATH = ''; // force _which('xpra') → null (deterministic no-xpra path)
    // @ts-ignore - test stub
    process.stderr.write = (s) => { captured += s; return true; };
    const code = await x.attach({ port: 20000, html5Port: 20099 });
    assert.equal(code, 0, 'no-xpra path resolves 0 (UX nicety, not fatal)');
  } finally {
    process.stderr.write = origWrite;
    process.env.PATH = origPath;
  }
  assert.match(captured, /\[demo-webctl\] xpra not installed/);
  assert.match(captured, /http:\/\/127\.0\.0\.1:20099\//, 'hint shows the passed html5Port, not a hardcode');
});

test('attach: html5Port defaults to port+1 when omitted', async () => {
  const x = createXpraAttach(fakeC());
  const origPath = process.env.PATH;
  const origWrite = process.stderr.write;
  let captured = '';
  try {
    process.env.PATH = '';
    // @ts-ignore - test stub
    process.stderr.write = (s) => { captured += s; return true; };
    await x.attach({ port: 14500 });
  } finally {
    process.stderr.write = origWrite;
    process.env.PATH = origPath;
  }
  assert.match(captured, /http:\/\/127\.0\.0\.1:14501\//, 'default html5Port = port+1');
});
