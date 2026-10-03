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
  const m = createMounts(fakeC(), { dockerfilesDir: null });
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
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  const n = m.names(SLUG, 'debian', 1234);
  assert.equal(n.xpraContainer, 'demo-webctl-u1234-xpra-testslug');
  assert.equal(n.chromiumContainer, 'demo-webctl-u1234-chromium-testslug');
  assert.equal(n.xpraSocketVolume, 'demo-webctl-u1234-x11-testslug');
  assert.equal(n.network, 'demo-webctl-u1234-net-testslug');
  assert.equal(n.owner, 'u1234');
  assert.equal(n.chromiumImage, 'demo-webctl/chromium-debian:latest');
  assert.equal(n.xpraImage, 'demo-webctl/xpra-ubuntu:latest');
});

test('⛔ names: the OWNER is in every per-instance name, so two accounts never collide', () => {
  // A name without an owner collided on a shared docker daemon: two accounts
  // with the same tool and slug asked for the identical name. (rx9q §5a)
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  const alice = m.names(SLUG, 'debian', 1000);
  const bob = m.names(SLUG, 'debian', 1001);
  for (const k of /** @type {const} */ (['xpraContainer', 'chromiumContainer', 'xpraSocketVolume', 'network'])) {
    assert.notEqual(alice[k], bob[k], `${k} must differ between accounts`);
  }
  // images are shared, deliberately
  assert.equal(alice.chromiumImage, bob.chromiumImage);
});

test('names: the owner uid defaults to process.getuid()', (t) => {
  if (typeof process.getuid !== 'function') { t.skip('no getuid on this platform'); return; }
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  assert.equal(m.names(SLUG, 'debian').chromiumContainer,
    `demo-webctl-u${process.getuid()}-chromium-testslug`);
});

test('names: a non-integer uid is refused (it becomes part of a docker name)', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  for (const bad of ['1000; rm', '-1', 'root', '']) {
    assert.throws(() => m.names(SLUG, 'debian', bad), /owner uid must be a non-negative integer/, JSON.stringify(bad));
  }
});

test('legacyNames: the PRE-OWNER names, exactly (read only to migrate)', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  assert.deepEqual(m.legacyNames(SLUG), {
    xpraContainer: 'demo-webctl-xpra-testslug',
    chromiumContainer: 'demo-webctl-chromium-testslug',
    xpraSocketVolume: 'demo-webctl-x11-testslug',
  });
});

test('names: defaults slug + base', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  const n = m.names(null);
  assert.equal(n.slug, 'default');
  assert.equal(n.base, 'debian');
  assert.equal(n.chromiumImage, 'demo-webctl/chromium-debian:latest');
});

// ── chromiumMounts: the upload-mount gate (the file-staging-agnostic core) ──

test('chromiumMounts: profile + X11 socket, no uploads without uploadHostPath', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  const mounts = m.chromiumMounts({ profileHostPath: '/host/profile', xpraSocketVolume: 'demo-x11' });
  assert.equal(mounts.length, 2);
  assert.ok(mounts.find(x => x[0] === '/host/profile' && x[1] === '/home/user/.config/chromium' && x[2] === 'rw'));
  assert.ok(mounts.find(x => x[0] === 'demo-x11' && x[1] === '/tmp/.X11-unix' && x[2] === 'rw'));
  assert.ok(!mounts.find(x => x[1] === CONTAINER_UPLOAD_DIR), 'no uploads mount (linkedin behaviour)');
});

test('chromiumMounts: adds dedicated read-only /cliai-uploads mount when uploadHostPath set', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
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
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  const mounts = m.xpraMounts({ xpraSocketVolume: 'demo-x11' });
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0][1], '/tmp/.X11-unix');
});

// ── normalizeBase ─────────────────────────────────────────────────────────

test('normalizeBase: defaults + validation', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  assert.equal(m.normalizeBase(null), 'debian');
  assert.equal(m.normalizeBase(''), 'debian');
  assert.equal(m.normalizeBase('UBUNTU'), 'ubuntu');
  assert.equal(m.normalizeBase('arch'), 'arch');
  assert.throws(() => m.normalizeBase('alpine'), /unknown chromium base/);
});

// ── path helpers read C.CACHE_DIRNAME ─────────────────────────────────────

test('cacheRoot + profileDir: under ~/.cache/CLIAI/<CACHE_DIRNAME>', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
  const root = m.cacheRoot();
  assert.ok(root.endsWith(path.join('.cache', 'CLIAI', 'demo-webctl')), `got ${root}`);
  assert.ok(m.profileDir('alice').endsWith(path.join('profiles', 'alice', 'chromium')));
  assert.ok(m.profileDir('').endsWith(path.join('profiles', 'default', 'chromium')));
});

test('expandHomePath: expands leading ~', () => {
  const m = createMounts(fakeC(), { dockerfilesDir: null });
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
  const m = createMounts(fakeC(), { dockerfilesDir: null });
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

test('⛔ dockerfilesDir OMITTED refuses construction, naming the option — control: injected or null constructs', () => {
  // The old test here asserted only that the fallback "ends with dockerfiles" — a
  // check that could not fail, blessing a path that exists in no layout (base ships
  // no dockerfiles). A shim that forgot the option then ran stale images silently.
  for (const opts of [{}, { dockerfilesDir: undefined }, { dockerfilesDir: '' }, { dockerfilesDir: 42 }]) {
    assert.throws(() => createMounts(fakeC(), /** @type {any} */ (opts)), /opts\.dockerfilesDir is required/,
      JSON.stringify(opts));
  }
  assert.throws(() => createMounts(fakeC()), /opts\.dockerfilesDir is required/, 'no opts at all');
  // controls
  assert.equal(createMounts(fakeC(), { dockerfilesDir: '/c/dockerfiles' }).dockerfilesDir(), '/c/dockerfiles');
  const none = createMounts(fakeC(), { dockerfilesDir: null });
  // null = "builds no images": constructs, and a build that needs Dockerfiles throws on USE
  assert.throws(() => none.dockerfilesDir(), /builds no\s+images/);
  assert.throws(() => none.dockerfilePath('chromium', 'debian'), /builds no\s+images/);
});
