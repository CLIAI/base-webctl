// Unit tests for createChromiumDockerXpra(C, opts) — the docker-xpra browser
// driver (sm2t seam). The upload-staging feature is injected via opts.fileStaging
// (no-op default → a consumer without file-staging, i.e. linkedin, is
// byte-unchanged); a consumer that injects it (chatgpt) gets WAY-1 attach staging.
// Construction-time fs/docker side effects are avoided by injecting a hermetic
// `mounts` (real createMounts with resolveChromiumProfile/cacheRoot overridden).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';

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

/** Real mounts surface (pure name/port logic) with fs-touching calls neutered. */
function hermeticMounts(C) {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  return {
    ...m,
    resolveChromiumProfile: (slug, udd) => udd || `/tmp/no-mkdir/${slug}`,
    cacheRoot: () => '/tmp/cache',
  };
}

/** Stub file-staging seam recording ensureUploadHostDir calls. */
function stubFileStaging(calls) {
  return {
    UPLOAD_STAGE_ENV: 'LWC_UPLOAD_DIR',
    resolveUploadDirs: ({ slug }) => ({
      uploadHostDir: `/tmp/uploads/${slug}`,
      uploadContainerDir: '/cliai-uploads',
    }),
    ensureUploadHostDir: (d) => { calls.push(d); },
  };
}

const HOSTCFG = { port: 4327, host: '127.0.0.1', slug: 'test' };

// ── factory contract ──────────────────────────────────────────────────────

test('createChromiumDockerXpra: validates C; surfaces the module API', () => {
  assert.throws(() => createChromiumDockerXpra(/** @type {any} */ ({})), /Invalid client-config constants/);
  const drv = createChromiumDockerXpra(fakeC(), { mounts: hermeticMounts(fakeC()) });
  for (const k of ['MODE', 'createDriver', 'factoryForBase', 'modeForBase',
    'baseFromMode', 'BrowserLocationError', '_docker', '_mounts', '_profileLock',
    '_httpGet', '_pollCdp']) {
    assert.ok(k in drv, `expected export ${k}`);
  }
  assert.equal(drv.MODE, 'chromium-docker-xpra-ubuntu-latest');
  assert.equal(typeof drv.createDriver, 'function');
});

test('createDriver: returns the documented driver contract shape', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const d = drv.createDriver(HOSTCFG);
  for (const k of ['mode', 'base', 'ensureRunning', 'healthCheck', 'shutdown', 'describe', 'inspect']) {
    assert.ok(k in d, `expected driver method ${k}`);
  }
  assert.equal(d.base, 'ubuntu');
});

test('createDriver: missing cfg → throws', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  assert.throws(() => drv.createDriver(null), /missing config/);
});

// ── base / mode derivation (pure) ─────────────────────────────────────────

test('createDriver: no base → legacy ubuntu base/mode (back-compat)', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const i = drv.createDriver(HOSTCFG).inspect();
  assert.equal(i.base, 'ubuntu');
  assert.equal(i.mode, 'chromium-docker-xpra-ubuntu-latest');
  assert.equal(i.names.chromiumImage, 'demo-webctl/chromium-ubuntu:latest');
});

test('createDriver: cfg.base selects base + mode + image tag', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  for (const base of ['ubuntu', 'debian', 'arch']) {
    const i = drv.createDriver({ ...HOSTCFG, slug: 'b', base }).inspect();
    assert.equal(i.base, base);
    assert.equal(i.mode, `chromium-docker-xpra-${base}-latest`);
    assert.equal(i.names.chromiumImage, `demo-webctl/chromium-${base}:latest`);
  }
});

test('createDriver: cfg.mode (no base) derives base from mode key', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const i = drv.createDriver({ ...HOSTCFG, mode: 'chromium-docker-xpra-debian-latest' }).inspect();
  assert.equal(i.base, 'debian');
});

test('createDriver: slug sanitizes shell-unsafe chars', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const i = drv.createDriver({ ...HOSTCFG, slug: 'a b/c$d' }).inspect();
  assert.equal(i.slug, 'a-b-c-d');
});

test('baseFromMode / modeForBase round-trip', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  assert.equal(drv.baseFromMode('chromium-docker-xpra-debian-latest'), 'debian');
  assert.equal(drv.baseFromMode('localhost-direct'), null);
  assert.equal(drv.baseFromMode(null), null);
  assert.equal(drv.modeForBase('arch'), 'chromium-docker-xpra-arch-latest');
});

test('factoryForBase: pins base; createDriver injects it', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const f = drv.factoryForBase('arch');
  assert.equal(f.base, 'arch');
  assert.equal(f.MODE, 'chromium-docker-xpra-arch-latest');
  assert.equal(f.createDriver({ ...HOSTCFG, slug: 'fac' }).base, 'arch');
});

// ── port derivation (pure) ─────────────────────────────────────────────────

test('createDriver: ports fall back to derived defaults (port+10000, +1)', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const i = drv.createDriver({ ...HOSTCFG, port: 4327 }).inspect();
  assert.equal(i.xpraTcpPort, 14327);
  assert.equal(i.xpraHtml5Port, 14328);
});

test('createDriver: explicit xpra ports override; html5 derives from tcp+1', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const i1 = drv.createDriver({ ...HOSTCFG, xpraTcpPort: 20000, xpraHtml5Port: 20009 }).inspect();
  assert.equal(i1.xpraTcpPort, 20000);
  assert.equal(i1.xpraHtml5Port, 20009);
  const i2 = drv.createDriver({ ...HOSTCFG, xpraTcpPort: 20000 }).inspect();
  assert.equal(i2.xpraHtml5Port, 20001);
});

// ── the upload-staging seam (file-staging-agnostic gate) ───────────────────

test('upload gate OFF: no opts.fileStaging → inspect omits upload dirs (linkedin)', () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const i = drv.createDriver(HOSTCFG).inspect();
  assert.ok(!('uploadHostDir' in i), 'no uploadHostDir without fileStaging');
  assert.ok(!('uploadContainerDir' in i), 'no uploadContainerDir without fileStaging');
});

test('upload gate ON: opts.fileStaging → staging resolved + inspect exposes dirs (chatgpt)', () => {
  const C = fakeC();
  const calls = [];
  const drv = createChromiumDockerXpra(C, {
    mounts: hermeticMounts(C),
    fileStaging: stubFileStaging(calls),
  });
  const i = drv.createDriver(HOSTCFG).inspect();
  assert.equal(i.uploadHostDir, '/tmp/uploads/test');
  assert.equal(i.uploadContainerDir, '/cliai-uploads');
  assert.deepEqual(calls, ['/tmp/uploads/test'], 'ensureUploadHostDir called with resolved host dir');
});
