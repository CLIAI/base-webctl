// config-wrapper-trap.test.js — reading a config key off loadJsoncConfig()'s
// WRAPPER throws, instead of silently reading as "unset".
//
// `chatgpt` passed `{merged, layers}` to resolvers that read top-level keys, so
// every config value was undefined and nothing said so. Making the wrapper's
// fields non-enumerable would not have helped: an absent key is undefined
// either way. The guard is a THROW at the read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

import { createClientConfig } from '../lib/client-config.js';

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

/** Load with a throwaway HOME holding one project config file. */
function load(json) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-trap-'));
  const prev = process.env.HOME;
  try {
    const cc = /** @type {any} */ (createClientConfig(fakeC()));
    // discover the layer path the loader reads, then write there — no guessing the layout
    process.env.HOME = home;
    const probe = cc.loadJsoncConfig('default');
    const target = probe.layers.find((/** @type {any} */ l) => l.path.endsWith('demo.config.jsonc')).path;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(json));
    return cc.loadJsoncConfig('default');
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('⛔ reading a config key off the WRAPPER throws, naming .merged — control: .merged has it', () => {
  const w = load({ browser_location: 'workstation' });
  assert.equal(w.merged.browser_location, 'workstation', 'premise: the value WAS loaded');
  assert.throws(() => w.browser_location, /read 'browser_location' from \.merged/);
  assert.throws(() => 'browser_location' in w, /from \.merged/, 'an `in` check is the same mistake');
});

test('the wrapper stays usable: destructuring, await, JSON, inspection, spread', async () => {
  const w = load({ a: 1 });
  const { merged, layers } = w;
  assert.equal(merged.a, 1);
  assert.ok(Array.isArray(layers));
  const awaited = await Promise.resolve(w); // reads .then — must not throw
  assert.equal(awaited.merged.a, 1);
  assert.equal(JSON.parse(JSON.stringify(w)).merged.a, 1);
  assert.match(util.inspect(w), /merged/);
  assert.deepEqual(Object.keys({ ...w }).sort(), ['layers', 'merged']);
  assert.equal(typeof w.hasOwnProperty, 'function');
  assert.equal(String(w), '[object Object]');
});
