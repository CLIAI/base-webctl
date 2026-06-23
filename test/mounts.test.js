// Unit tests for createMounts(C) — the docker-xpra path + mount-layout builder
// (sm2t seam). File-staging-AGNOSTIC: base owns CONTAINER_UPLOAD_DIR and gates
// the upload mount on cfg.uploadHostPath, so a consumer that never sets it gets
// byte-identical behaviour to the pre-upload world (the linkedin case), while a
// consumer that DOES set it gets the dedicated read-only mount (the chatgpt case).
// No real consumer constants — a synthetic C is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMounts, CONTAINER_UPLOAD_DIR } from '../lib/browser-location/mounts.js';

/** A complete, valid synthetic per-repo constants object. */
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

const SLUG = 'testslug';

// ── factory contract ──────────────────────────────────────────────────────

test('createMounts: validates C by default; surfaces the expected functions', () => {
  assert.throws(() => createMounts(/** @type {any} */ ({})), /Invalid client-config constants/);
  const m = createMounts(fakeC());
  for (const fn of ['cacheRoot', 'expandHomePath', 'profileDir', 'ensureProfileDir',
    'resolveChromiumProfile', 'migrationBannerMarker', 'names', 'chromiumMounts',
    'xpraMounts', 'dockerfilesDir', 'dockerfilePath', 'normalizeBase']) {
    assert.equal(typeof m[fn], 'function', `expected function ${fn}`);
  }
  assert.deepEqual(m.CHROMIUM_BASES, ['ubuntu', 'debian', 'arch']);
  assert.equal(m.DEFAULT_BASE, 'debian');
  assert.equal(m.CONTAINER_UPLOAD_DIR, '/cliai-uploads');
});

test('CONTAINER_UPLOAD_DIR is base-owned and fixed', () => {
  assert.equal(CONTAINER_UPLOAD_DIR, '/cliai-uploads');
});

// ── names() reads the injected constants ──────────────────────────────────

test('names: artifact names carry C.ARTIFACT_PREFIX; images from C', () => {
  const m = createMounts(fakeC());
  const n = m.names(SLUG, 'debian');
  assert.equal(n.xpraContainer, 'demo-webctl-xpra-testslug');
  assert.equal(n.chromiumContainer, 'demo-webctl-chromium-testslug');
  assert.equal(n.xpraSocketVolume, 'demo-webctl-x11-testslug');
  assert.equal(n.network, 'demo-webctl-net-testslug');
  assert.equal(n.chromiumImage, 'demo-webctl/chromium-debian:latest');
  assert.equal(n.xpraImage, 'demo-webctl/xpra-ubuntu:latest');
});

test('names: defaults slug + base', () => {
  const m = createMounts(fakeC());
  const n = m.names(null);
  assert.equal(n.slug, 'default');
  assert.equal(n.base, 'debian');
  assert.equal(n.chromiumImage, 'demo-webctl/chromium-debian:latest');
});

// ── chromiumMounts: the upload-mount gate (the file-staging-agnostic core) ──

test('chromiumMounts: profile + X11 socket, no uploads without uploadHostPath', () => {
  const m = createMounts(fakeC());
  const mounts = m.chromiumMounts({ profileHostPath: '/host/profile', xpraSocketVolume: 'demo-x11' });
  assert.equal(mounts.length, 2);
  assert.ok(mounts.find(x => x[0] === '/host/profile' && x[1] === '/home/user/.config/chromium' && x[2] === 'rw'));
  assert.ok(mounts.find(x => x[0] === 'demo-x11' && x[1] === '/tmp/.X11-unix' && x[2] === 'rw'));
  assert.ok(!mounts.find(x => x[1] === CONTAINER_UPLOAD_DIR), 'no uploads mount (linkedin behaviour)');
});

test('chromiumMounts: adds dedicated read-only /cliai-uploads mount when uploadHostPath set', () => {
  const m = createMounts(fakeC());
  const mounts = m.chromiumMounts({
    profileHostPath: '/host/profile',
    xpraSocketVolume: 'demo-x11',
    uploadHostPath: '/host/.cache/CLIAI/demo/uploads/testslug',
  });
  const up = mounts.find(x => x[1] === CONTAINER_UPLOAD_DIR);
  assert.ok(up, 'dedicated /cliai-uploads mount present (chatgpt behaviour)');
  assert.equal(up[0], '/host/.cache/CLIAI/demo/uploads/testslug');
  assert.equal(up[2], 'ro', 'read-only: chromium only reads staged files');
});

test('xpraMounts: only the X11 socket', () => {
  const m = createMounts(fakeC());
  const mounts = m.xpraMounts({ xpraSocketVolume: 'demo-x11' });
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0][1], '/tmp/.X11-unix');
});

// ── normalizeBase ─────────────────────────────────────────────────────────

test('normalizeBase: defaults + validation', () => {
  const m = createMounts(fakeC());
  assert.equal(m.normalizeBase(null), 'debian');
  assert.equal(m.normalizeBase(''), 'debian');
  assert.equal(m.normalizeBase('UBUNTU'), 'ubuntu');
  assert.equal(m.normalizeBase('arch'), 'arch');
  assert.throws(() => m.normalizeBase('alpine'), /unknown chromium base/);
});

// ── path helpers read C.CACHE_DIRNAME ─────────────────────────────────────

test('cacheRoot + profileDir: under ~/.cache/CLIAI/<CACHE_DIRNAME>', () => {
  const m = createMounts(fakeC());
  const root = m.cacheRoot();
  assert.ok(root.endsWith(path.join('.cache', 'CLIAI', 'demo-webctl')), `got ${root}`);
  assert.ok(m.profileDir('alice').endsWith(path.join('profiles', 'alice', 'chromium')));
  assert.ok(m.profileDir('').endsWith(path.join('profiles', 'default', 'chromium')));
});

test('expandHomePath: expands leading ~', () => {
  const m = createMounts(fakeC());
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = '/tmp/fake-home';
    assert.equal(m.expandHomePath('~'), '/tmp/fake-home');
    assert.equal(m.expandHomePath('~/priv/x'), path.join('/tmp/fake-home', 'priv', 'x'));
    assert.equal(m.expandHomePath('/abs/x'), '/abs/x');
  } finally {
    process.env.HOME = oldHome;
  }
});

test('resolveChromiumProfile: honours explicit userDataDir, mkdir -p', () => {
  const m = createMounts(fakeC());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-mounts-'));
  try {
    const explicit = path.join(tmp, 'explicit', 'profile');
    assert.equal(m.resolveChromiumProfile(SLUG, explicit), explicit);
    assert.ok(fs.existsSync(explicit), 'explicit profile dir mkdir -p\'d');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── dockerfilesDir: consumer-owned, injected via opts ─────────────────────

test('dockerfilesDir: uses injected opts.dockerfilesDir (consumer-owned path)', () => {
  const injected = '/some/consumer/repo/dockerfiles';
  const m = createMounts(fakeC(), { dockerfilesDir: injected });
  assert.equal(m.dockerfilesDir(), injected);
  assert.equal(m.dockerfilePath('chromium', 'debian'), path.join(injected, 'chromium', 'debian.Dockerfile'));
  assert.equal(m.dockerfilePath('chromium', null), path.join(injected, 'chromium', 'debian.Dockerfile'));
  assert.equal(m.dockerfilePath('xpra', 'arch'), path.join(injected, 'xpra', 'ubuntu.Dockerfile'));
});

test('dockerfilesDir: accepts a thunk resolver', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: () => '/lazy/dockerfiles' });
  assert.equal(m.dockerfilesDir(), '/lazy/dockerfiles');
});

test('dockerfilesDir: without injection falls back to module-relative ../../dockerfiles', () => {
  const m = createMounts(fakeC());
  // base ships no dockerfiles dir; the fallback still RESOLVES (consumers vendoring
  // base MUST inject their own — see the JSDoc). We only assert the shape here.
  assert.ok(m.dockerfilesDir().endsWith('dockerfiles'));
});
