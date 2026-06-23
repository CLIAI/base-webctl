// Unit tests for createBrowserLocation(C, opts) — the browser-location resolver
// entry point / orchestrator (sm2t seam, extracted LAST). Byte-identical across
// consumers; a factory because it builds the C-bound registry (→ driver) and
// references mounts.migrationBannerMarker. Driver opts (fileStaging /
// dockerfilesDir / version) thread through registry → driver. A hermetic mounts
// is injected to keep resolveBrowserLocation()'s driver construction side-effect
// free.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserLocation } from '../lib/browser-location/index.js';
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

function hermeticMounts(C) {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  return {
    ...m,
    resolveChromiumProfile: (slug, udd) => udd || `/tmp/no-mkdir/${slug}`,
    cacheRoot: () => '/tmp/cache',
    migrationBannerMarker: () => '/tmp/no-mkdir/.banner-marker',
  };
}

function make(C = fakeC()) {
  return createBrowserLocation(C, { mounts: hermeticMounts(C) });
}

test('createBrowserLocation: validates C; surfaces the resolver API', () => {
  assert.throws(() => createBrowserLocation(/** @type {any} */ ({})), /Invalid client-config constants/);
  const bl = make();
  for (const k of ['resolveBrowserLocation', 'resolveMode', 'isUnsetByUser',
    'maybeShowMigrationBanner', 'DEFAULT_MODE', 'LEGACY_DEFAULT_MODE', 'ENV_VAR', 'DOTENV_KEY']) {
    assert.ok(k in bl, `expected export ${k}`);
  }
  assert.equal(bl.DEFAULT_MODE, 'chromium-docker-xpra-debian-latest');
  assert.equal(bl.LEGACY_DEFAULT_MODE, 'localhost-direct');
  assert.equal(bl.ENV_VAR, 'CLIAI_DEMO_WEBCTL_BROWSER_LOCATION');
  assert.equal(bl.DOTENV_KEY, 'browser_location');
});

test('ENV_VAR uses the legacy prefix when present', () => {
  const bl = make(fakeC({ ENV_PREFIX_LEGACY: 'LWC_' }));
  assert.equal(bl.ENV_VAR, 'LWC_BROWSER_LOCATION');
});

test('resolveMode: precedence cli > env > dotenv > jsonc > default', () => {
  const bl = make();
  const E = bl.ENV_VAR;
  assert.equal(bl.resolveMode({ cli: 'localhost-direct' }), 'localhost-direct');
  assert.equal(bl.resolveMode({ env: { [E]: 'chromium-docker-xpra-arch-latest' } }), 'chromium-docker-xpra-arch-latest');
  assert.equal(bl.resolveMode({ dotenv: { browser_location: 'localhost-direct' } }), 'localhost-direct');
  assert.equal(bl.resolveMode({ dotenv: { [E]: 'localhost-direct' } }), 'localhost-direct');
  assert.equal(bl.resolveMode({ jsonc: { browserLocation: 'localhost-direct' } }), 'localhost-direct');
  assert.equal(bl.resolveMode({ jsonc: { browser_location: 'localhost-direct' } }), 'localhost-direct');
  assert.equal(bl.resolveMode({}), 'chromium-docker-xpra-debian-latest');
  // cli wins over env
  assert.equal(bl.resolveMode({ cli: 'localhost-direct', env: { [E]: 'chromium-docker-xpra-arch-latest' } }), 'localhost-direct');
});

test('isUnsetByUser: true only for the built-in default', () => {
  const bl = make();
  const E = bl.ENV_VAR;
  assert.equal(bl.isUnsetByUser({}), true);
  assert.equal(bl.isUnsetByUser({ cli: 'x' }), false);
  assert.equal(bl.isUnsetByUser({ env: { [E]: 'x' } }), false);
  assert.equal(bl.isUnsetByUser({ jsonc: { browserLocation: 'x' } }), false);
});

test('resolveBrowserLocation: known mode → {mode, driver}', () => {
  const bl = make();
  const r = bl.resolveBrowserLocation({ browserLocation: 'chromium-docker-xpra-arch-latest', driverConfig: { port: 4327, host: '127.0.0.1', slug: 's' } });
  assert.equal(r.mode, 'chromium-docker-xpra-arch-latest');
  assert.equal(r.driver.base, 'arch');
});

test('resolveBrowserLocation: unknown mode → onError(msg, 4)', () => {
  const bl = make();
  let captured;
  const r = bl.resolveBrowserLocation({
    browserLocation: 'no-such-mode',
    onError: (msg, code) => { captured = { msg, code }; return 'HANDLED'; },
  });
  assert.equal(r, 'HANDLED');
  assert.equal(captured.code, 4);
  assert.match(captured.msg, /Unknown --browser-location mode/);
});

test('resolveBrowserLocation: known-but-future-stub mode → not-implemented onError', () => {
  const bl = make();
  let captured;
  bl.resolveBrowserLocation({
    browserLocation: 'x11-remote',
    onError: (msg, code) => { captured = { msg, code }; },
  });
  assert.equal(captured.code, 4);
  assert.match(captured.msg, /not yet implemented/);
});

test('maybeShowMigrationBanner: writes once, mentions project + env var', () => {
  const C = fakeC();
  const calls = [];
  const m = hermeticMounts(C);
  // make the marker path report "absent" the first time, "present" after — and
  // capture the banner text via a fake stderr.
  let markerWritten = false;
  const blMounts = { ...m, migrationBannerMarker: () => '/tmp/no-mkdir/.banner' };
  const bl = createBrowserLocation(C, {
    mounts: blMounts,
    fs: {
      existsSync: () => markerWritten,
      mkdirSync: () => {},
      writeFileSync: () => { markerWritten = true; },
    },
  });
  let out = '';
  const fakeStderr = /** @type {any} */ ({ write: (s) => { out += s; calls.push(s); return true; } });
  const shown1 = bl.maybeShowMigrationBanner({ stderr: fakeStderr });
  assert.equal(shown1, true, 'first call shows the banner');
  assert.match(out, /\[demo-webctl\] Default browser mode changed/);
  assert.match(out, /CLIAI_DEMO_WEBCTL_BROWSER_LOCATION=localhost-direct/);
  const shown2 = bl.maybeShowMigrationBanner({ stderr: fakeStderr });
  assert.equal(shown2, false, 'second call is idempotent (marker present)');
});
