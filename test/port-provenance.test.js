// port-provenance.test.js — each port, and WHERE IT CAME FROM.
//
// ⛔ THE GAP THIS CLOSES. `deriveXpraPorts()` and `resolvePort()` both compute
// provenance with care — 'derived', 'jsonc.ports[...]', 'env:FOO', 'cli' — and
// `buildDriverCfg()` took the numbers and dropped the sources on the next line.
// NOTHING in lib/ consumed them, so the provenance existed for exactly one
// statement and died at the seam into the driver.
//
// The consequence is not cosmetic: a caller could not tell a DERIVED port from
// a CONFIGURED one, and that is the distinction this family paid weeks for when
// a derived html5 port was published, pre-flight reserved and advertised
// through inspect() while answering nothing. Nothing in the output said "this
// number was computed, not chosen".
//
// ⭐ It is also the first field `gui status` needs and the one most likely to be
// dropped as redundant by a clean-surface extraction — "the port is right
// there, why carry a string about it" — which is exactly why it is asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createClientConfig } from '../lib/client-config.js';
import { createMounts } from '../lib/browser-location/mounts.js';

const C = {
  PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
  IMAGE_CHROMIUM_REPO: 'demo/chromium', IMAGE_XPRA: 'demo/xpra:latest',
  DEFAULT_CDP_PORT: 4427, CACHE_DIRNAME: 'demo-webctl',
  ZOOM_DEFAULT_HOST: 'demo.example', CONFIG_FILE_PROJECT: 'demo.config.jsonc',
  DOTENV_FILENAME: '.env.demo', DOTENV_TEMPLATE: '.env.demo.example',
  ENV_PREFIX: 'DEMO_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
};

/** Mounts that touch no filesystem, with BOTH resolvers stubbed consistently. */
function hermeticMounts() {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  const fake = (/** @type {string} */ s, /** @type {string} */ u) => u || `/tmp/no-mkdir/${s}`;
  return { ...m, resolveChromiumProfile: fake, profilePathFor: fake, cacheRoot: () => '/tmp/cache' };
}

/** @param {Record<string, any>} jsonc */
function inspectWith(jsonc) {
  const cfg = createClientConfig(C).buildDriverCfg({ args: {}, dotenv: {}, env: {}, jsonc });
  return createChromiumDockerXpra(C, { mounts: hermeticMounts() }).createDriver(cfg).inspect();
}

test('⭐ a DERIVED port and a CONFIGURED one are distinguishable', () => {
  const derived = inspectWith({});
  assert.equal(derived.ports['xpra-tcp'].value, 14427);
  assert.equal(derived.ports['xpra-tcp'].source, 'derived');

  const configured = inspectWith({ ports: { 'xpra-tcp': 19999 } });
  assert.equal(configured.ports['xpra-tcp'].value, 19999);
  assert.equal(configured.ports['xpra-tcp'].source, 'jsonc.ports["xpra-tcp"]');

  assert.notEqual(derived.ports['xpra-tcp'].source, configured.ports['xpra-tcp'].source,
    'if these agree the field carries no information — the whole point is that a '
    + 'caller can tell a computed number from a chosen one');
});

test('the html5 source states WHY it equals tcp, rather than only that it does', () => {
  // The value alone reads as a coincidence. Since v0.6.0 it is a consequence:
  // the html5 client rides the tcp socket, so there is no second port to derive.
  // A reader who does not know that sees two equal numbers and looks for a bug.
  const i = inspectWith({});
  assert.equal(i.ports['xpra-html5'].value, i.ports['xpra-tcp'].value);
  assert.match(i.ports['xpra-html5'].source, /rides the tcp socket/);
});

test('⛔ an EXPLICIT html5 override is reported verbatim, not collapsed', () => {
  // The driver refuses a differing html5 port rather than silently ignoring it,
  // and the source has to show the caller asked for something — otherwise the
  // refusal message describes a value the status output never admitted existed.
  const i = inspectWith({ ports: { 'xpra-html5': 14427 } });
  assert.equal(i.ports['xpra-html5'].source, 'jsonc.ports["xpra-html5"]');
});

test('⛔ provenance is ABSENT, never guessed, for a cfg that predates it', () => {
  // An older consumer hands the driver its own cfg object with no portSources.
  // `source: null` reads as "unknown"; a fabricated 'derived' would read as a
  // MEASUREMENT — asserting a fact about an origin nobody recorded. This is the
  // whole difference between a missing value and an invented one, and it is the
  // control that stops the convenience of a default being added later.
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts() })
    .createDriver({ port: 4427, host: '127.0.0.1', slug: 'legacy' });
  const i = drv.inspect();
  assert.equal(i.ports.cdp.value, 4427, 'the VALUE is still known');
  assert.equal(i.ports.cdp.source, null, 'the ORIGIN is not');
  assert.equal(i.ports['xpra-tcp'].source, null);
});

// ── the ABSENCE must explain itself ──────────────────────────────────────────
//
// ⛔ WHY: a lane measured `source: null` on all three ports of a LIVE LOCAL stack
// and reasonably concluded base had published a vocabulary nothing reads. It
// does read it — the control above proves that — but a bare `null` CONFLATES two
// causes: a pin that predates portSources, and a current pin whose consumer
// hand-built its driver cfg instead of calling buildDriverCfg(). base cannot tell
// them apart from inside, so it must not pretend to; what it can do is stop the
// reader guessing.

test('⛔ a cfg without portSources says WHY every source is null', () => {
  const withSources = createClientConfig(C).buildDriverCfg({ args: {}, dotenv: {}, env: {}, jsonc: {} });
  const handBuilt = { ...withSources };
  delete (/** @type {any} */ (handBuilt).portSources);

  const i = createChromiumDockerXpra(C, { mounts: hermeticMounts() }).createDriver(handBuilt).inspect();

  // The sources stay null — absent, never guessed.
  for (const k of ['cdp', 'xpra-tcp', 'xpra-html5']) {
    assert.equal(i.ports[k].source, null, `${k} source must be null, not fabricated`);
  }
  // ⇒ ...and the reason must be stated, naming BOTH causes and the remedy for each.
  assert.ok(i.portSourcesUnavailable, 'the absence must explain itself');
  assert.match(i.portSourcesUnavailable, /buildDriverCfg/,
    'it must name the hand-built-cfg cause and its remedy');
  assert.match(i.portSourcesUnavailable, /bump base|predates/,
    'it must name the stale-pin cause too — naming one of two causes is what sent a lane wrong');
});

test('⭐ CONTROL: a cfg WITH portSources carries no diagnostic at all', () => {
  // Otherwise the field is noise on every healthy call, and a field that is
  // always present stops being read — which is how the null went unnoticed.
  const cfg = createClientConfig(C).buildDriverCfg({ args: {}, dotenv: {}, env: {}, jsonc: {} });
  const i = createChromiumDockerXpra(C, { mounts: hermeticMounts() }).createDriver(cfg).inspect();
  assert.equal('portSourcesUnavailable' in i, false,
    'the healthy case must be silent, or the diagnostic becomes wallpaper');
  assert.equal(i.ports.cdp.source, 'default');
});
