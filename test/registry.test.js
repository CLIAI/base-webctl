// Unit tests for createRegistry(C, opts) — the browser-location driver registry
// (sm2t seam). Byte-identical across consumers; becomes a factory only because it
// must build the C-bound driver surface (createChromiumDockerXpra) + reference the
// constants-free localhost-direct module. opts (fileStaging/dockerfilesDir/version)
// are forwarded to the driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRegistry } from '../lib/browser-location/registry.js';

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

test('createRegistry: validates C; surfaces the registry API', () => {
  assert.throws(() => createRegistry(/** @type {any} */ ({})), /Invalid client-config constants/);
  const r = createRegistry(fakeC());
  for (const k of ['REGISTRY', 'listModes', 'listAvailableModes', 'isKnown', 'getFactory']) {
    assert.ok(k in r, `expected export ${k}`);
  }
});

test('createRegistry: known modes + null future-stubs', () => {
  const r = createRegistry(fakeC());
  assert.ok(r.isKnown('localhost-direct'));
  assert.ok(r.isKnown('chromium-docker-xpra-debian-latest'));
  assert.ok(r.isKnown('chromium-docker-xpra-ubuntu-latest'));
  assert.ok(r.isKnown('chromium-docker-xpra-arch-latest'));
  assert.ok(!r.isKnown('nonsense-mode'));
  // future stubs are known-but-null
  assert.ok(r.isKnown('xpra-remote-host'));
  assert.equal(r.getFactory('xpra-remote-host'), null);
});

test('createRegistry: listAvailableModes excludes the null future-stubs', () => {
  const r = createRegistry(fakeC());
  const avail = r.listAvailableModes();
  assert.ok(avail.includes('localhost-direct'));
  assert.ok(avail.includes('chromium-docker-xpra-debian-latest'));
  assert.ok(!avail.includes('xpra-remote-host'));
  assert.ok(!avail.includes('x11-remote'));
  // listModes includes everything
  assert.ok(r.listModes().includes('x11-remote'));
});

test('createRegistry: docker-xpra factories are base-pinned + create drivers', () => {
  const r = createRegistry(fakeC());
  const f = r.getFactory('chromium-docker-xpra-arch-latest');
  assert.equal(f.base, 'arch');
  assert.equal(f.MODE, 'chromium-docker-xpra-arch-latest');
  const d = f.createDriver({ port: 4327, host: '127.0.0.1', slug: 'reg' });
  assert.equal(d.base, 'arch');
});

test('createRegistry: localhost-direct factory is the constants-free driver module', () => {
  const r = createRegistry(fakeC());
  const ld = r.getFactory('localhost-direct');
  assert.equal(ld.MODE, 'localhost-direct');
  assert.equal(typeof ld.createDriver, 'function');
});

test('createRegistry: opts.driver injection is honoured (test seam)', () => {
  const fakeDriver = { factoryForBase: (b) => ({ MODE: `m-${b}`, base: b, createDriver: () => ({}) }) };
  const r = createRegistry(fakeC(), { driver: fakeDriver });
  assert.equal(r.getFactory('chromium-docker-xpra-debian-latest').MODE, 'm-debian');
});
