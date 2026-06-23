// Unit tests for the per-repo constants seam (sm2t): the template/validator
// and the three factories (createClientConfig / createChromiumPrefs /
// createProfileLock). No real consumer constants — a synthetic C is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertConstants, REQUIRED_KEYS, TEMPLATE } from '../lib/client-config.constants.template.js';
import { createClientConfig } from '../lib/client-config.js';
import { createChromiumPrefs } from '../lib/chromium-prefs.js';
import { createProfileLock } from '../lib/browser-location/profile-lock.js';

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

// ── template / validator ────────────────────────────────────────────────

test('assertConstants: passes a complete object, returns it', () => {
  const C = fakeC();
  assert.equal(assertConstants(C), C);
});

test('assertConstants: throws naming each missing/empty required key', () => {
  assert.throws(() => assertConstants(fakeC({ PROJECT: undefined })), /missing\/empty: PROJECT/);
  assert.throws(() => assertConstants(fakeC({ ARTIFACT_PREFIX: '' })), /missing\/empty: ARTIFACT_PREFIX/);
  assert.throws(() => assertConstants(/** @type {any} */ (null)), /expected an object/);
});

test('assertConstants: ENV_PREFIX_LEGACY may be null but must be PRESENT', () => {
  assert.doesNotThrow(() => assertConstants(fakeC({ ENV_PREFIX_LEGACY: null })));
  const missing = fakeC();
  delete /** @type {any} */ (missing).ENV_PREFIX_LEGACY;
  assert.throws(() => assertConstants(missing), /ENV_PREFIX_LEGACY/);
});

test('assertConstants: ENV_LEGACY_SUFFIXES must be an array; port must be number', () => {
  assert.throws(() => assertConstants(fakeC({ ENV_LEGACY_SUFFIXES: /** @type {any} */ ('nope') })), /ENV_LEGACY_SUFFIXES must be an array/);
  assert.throws(() => assertConstants(fakeC({ DEFAULT_CDP_PORT: /** @type {any} */ ('4999') })), /DEFAULT_CDP_PORT must be a number/);
});

test('REQUIRED_KEYS covers the non-nullable per-repo keys', () => {
  for (const k of ['PROJECT', 'ARTIFACT_PREFIX', 'DEFAULT_CDP_PORT', 'ENV_PREFIX', 'ZOOM_DEFAULT_HOST']) {
    assert.ok(REQUIRED_KEYS.includes(/** @type {any} */ (k)), `expected ${k} in REQUIRED_KEYS`);
  }
});

test('TEMPLATE: every property access throws (shape-only, impossible to misuse)', () => {
  assert.throws(() => TEMPLATE.PROJECT, /SHAPE ONLY/);
  assert.throws(() => TEMPLATE.ENV_PREFIX, /SHAPE ONLY/);
});

// ── factories: assert default-on + escape hatch ──────────────────────────

test('factories assert by default and reject a bad C', () => {
  assert.throws(() => createClientConfig(/** @type {any} */ ({})), /Invalid client-config constants/);
  assert.throws(() => createChromiumPrefs(/** @type {any} */ ({})), /Invalid client-config constants/);
  assert.throws(() => createProfileLock(/** @type {any} */ ({})), /Invalid client-config constants/);
});

test('factories honor the { assert: false } escape hatch', () => {
  assert.doesNotThrow(() => createClientConfig(/** @type {any} */ ({}), { assert: false }));
});

// ── createClientConfig behaviour (constants actually drive resolution) ────

test('createClientConfig: resolvePort precedence + default from C', () => {
  const cc = createClientConfig(fakeC());
  assert.equal(cc.resolvePort({}).value, 4999);                 // C.DEFAULT_CDP_PORT
  assert.equal(cc.resolvePort({ args: { port: 4327 } }).value, 4327); // CLI wins
  const env = { CLIAI_DEMO_WEBCTL_PORT: '5050' };
  assert.equal(cc.resolvePort({ env }).value, 5050);            // canonical env prefix
});

test('createClientConfig: envNames uses canonical prefix, legacy only when configured', () => {
  const cc = createClientConfig(fakeC());
  assert.deepEqual(cc.envNames('port'), ['CLIAI_DEMO_WEBCTL_PORT']);
  const ccLegacy = createClientConfig(fakeC({ ENV_PREFIX_LEGACY: 'DEMO_WEBCTL_', ENV_LEGACY_SUFFIXES: ['PORT'] }));
  assert.deepEqual(ccLegacy.envNames('port'), ['CLIAI_DEMO_WEBCTL_PORT', 'DEMO_WEBCTL_PORT']);
});

test('createClientConfig: deriveXpraPorts uses shared offsets (base-owned)', () => {
  const cc = createClientConfig(fakeC());
  const r = cc.deriveXpraPorts(4999, {});
  assert.equal(r.xpraTcpPort, 14999);    // 4999 + PORT_OFFSET_XPRA_TCP(10000)
  assert.equal(r.xpraHtml5Port, 15000);  // tcp + PORT_OFFSET_HTML5(1)
});

test('createClientConfig: exposes shared constants + CONSTANTS=C; parseJsonc pure', () => {
  const C = fakeC();
  const cc = createClientConfig(C);
  assert.equal(cc.CONSTANTS, C);
  assert.equal(cc.PORT_OFFSET_XPRA_TCP, 10000);
  assert.deepEqual(cc.parseJsonc('{ "a": 1, /* c */ "b": [2,], }'), { a: 1, b: [2] });
});

// ── createChromiumPrefs (constants → DEFAULT_HOST + tool name) ────────────

test('createChromiumPrefs: DEFAULT_HOST comes from C.ZOOM_DEFAULT_HOST', () => {
  const cp = createChromiumPrefs(fakeC());
  assert.equal(cp.DEFAULT_HOST, 'www.demo.example');
});

test('createChromiumPrefs: pure zoom encoders round-trip', () => {
  const cp = createChromiumPrefs(fakeC());
  assert.equal(cp.parseZoomInput('80%'), 0.8);
  assert.equal(cp.parseZoomInput('100'), 1);
  const lvl = cp.ratioToZoomLevel(0.8);
  assert.ok(Math.abs(cp.zoomLevelToRatio(lvl) - 0.8) < 1e-9);
});

// ── createProfileLock (constants → lock filename + recorded tool) ─────────

test('createProfileLock: lock filename derives from C.PROJECT', () => {
  const pl = createProfileLock(fakeC());
  assert.equal(pl.LOCK_FILENAME, '.demo-webctl.lock.json');
  assert.equal(pl.lockPath('/p'), '/p/.demo-webctl.lock.json');
  assert.equal(pl.SCHEMA_VERSION, 1);
});

test('createProfileLock: isHolderAlive container path honors injected dockerInspect', async () => {
  const pl = createProfileLock(fakeC());
  const running = await pl.isHolderAlive({ containerName: 'x' }, { dockerInspect: async () => ({ running: true, exists: true }) });
  assert.deepEqual(running, { alive: true, reason: 'container' });
  const stopped = await pl.isHolderAlive({ containerName: 'x' }, { dockerInspect: async () => ({ running: false, exists: true }) });
  assert.equal(stopped.alive, false);
  // No probe + docker lock → conservative "unknown"/alive.
  const unknown = await pl.isHolderAlive({ containerName: 'x' }, {});
  assert.deepEqual(unknown, { alive: true, reason: 'unknown' });
});

test('createProfileLock: two tools get DISTINCT lock filenames (multi-tenant)', () => {
  const a = createProfileLock(fakeC({ PROJECT: 'a-webctl' }));
  const b = createProfileLock(fakeC({ PROJECT: 'b-webctl' }));
  assert.notEqual(a.LOCK_FILENAME, b.LOCK_FILENAME);
});
