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

test('⛔ attach: html5Port defaults to the SAME port — html5 rides the bind-tcp socket (was port+1, a dead URL)', async () => {
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
  assert.match(captured, /http:\/\/127\.0\.0\.1:14500\//, 'default html5Port = port');
  assert.doesNotMatch(captured, /14501/, 'the derived +1 port is gone — nothing listens there');
});

test('attachArgs: desktopScaling maps to --desktop-scaling, in every form xpra accepts — junk throws', () => {
  const x = createXpraAttach(fakeC());
  assert.deepEqual(x.attachArgs({ port: 20000, desktopScaling: 1.5 }),
    ['attach', 'tcp://127.0.0.1:20000/', '--desktop-scaling=1.5']);
  for (const v of ['1.5', '3/2', '1024x768', '2x1.5', 'auto', 'on', 'off']) {
    assert.deepEqual(x.attachArgs({ port: 20000, desktopScaling: v }).slice(-1), [`--desktop-scaling=${v}`], v);
  }
  assert.deepEqual(x.attachArgs({ port: 20000 }), ['attach', 'tcp://127.0.0.1:20000/'], 'control');
  for (const bad of [0, -1, NaN, 'big', '1.5; rm -rf', '--x', '3/', 'x2']) {
    assert.throws(() => x.attachArgs({ port: 20000, desktopScaling: bad }), /desktopScaling must be/, String(bad));
  }
  assert.equal(x.attachCommand({ port: 20000, desktopScaling: '3/2' }), 'xpra attach tcp://127.0.0.1:20000/ --desktop-scaling=3/2');
});

test('⛔ a caller\'s OWN `scaling` field is untouched — base adds nothing for it (the v0.25 gate red)', () => {
  // Lanes pass their own `scaling` through and append the flag themselves. A base option
  // of the same name emitted it TWICE, and threw on '3/2', which the lane accepts.
  const x = createXpraAttach(fakeC());
  assert.deepEqual(x.attachArgs({ port: 20000, scaling: '3/2' }), ['attach', 'tcp://127.0.0.1:20000/']);
  assert.equal(x.attachCommand({ port: 20000, scaling: 2 }), 'xpra attach tcp://127.0.0.1:20000/');
});
