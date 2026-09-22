// port-origin.test.js — "stated, never guessed", made shareable.
//
// The family rule is ⭐ *a CDP port must be STATED, never GUESSED*, with the
// docker verb exempt — requiring the port before you may start the thing that
// provides it is backwards.
//
// ⛔ The distinction a lane gets wrong first: DERIVING FROM A PROJECT CONSTANT
// IS NOT GUESSING. `C.DEFAULT_CDP_PORT` is a decision someone made and wrote
// down. `resolvePort()` has always reported that as `source: 'default'`, and
// 'default' is exactly the word that invites "so it was a guess".
//
// Every lane implementing the rule had to classify the source strings itself,
// and eight lanes would drift — the same gap as a severity vocabulary published
// without its classification, one day earlier and one module over.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClientConfig, PORT_ORIGINS, portOrigin } from '../lib/client-config.js';

const C = {
  PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
  IMAGE_CHROMIUM_REPO: 'demo/chromium', IMAGE_XPRA: 'demo/xpra:latest',
  DEFAULT_CDP_PORT: 4427, CACHE_DIRNAME: 'demo-webctl',
  ZOOM_DEFAULT_HOST: 'demo.example', CONFIG_FILE_PROJECT: 'demo.config.jsonc',
  DOTENV_FILENAME: '.env.demo', DOTENV_TEMPLATE: '.env.demo.example',
  ENV_PREFIX: 'DEMO_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
};

test('⭐ every channel resolvePort can emit is classifiable', () => {
  // ⛔ THE COVERAGE CHECK, not merely the drift one. Asserting
  // `PORT_ORIGINS.includes(x)` proves base agrees with itself; it proves
  // nothing about whether every source the resolver ACTUALLY emits can be
  // classified. A source added to the resolver without a rule here returns
  // null and would be refused by every consumer — so the two must be walked
  // together, from the resolver's real output.
  const c = createClientConfig(C);
  const channels = [
    ['constants', { args: {}, dotenv: {}, env: {}, jsonc: {} }, 'derived-from-constants'],
    ['flag',      { args: { port: 5000 }, dotenv: {}, env: {}, jsonc: {} }, 'stated'],
    ['env',       { args: {}, dotenv: {}, env: { DEMO_PORT: '5001' }, jsonc: {} }, 'stated'],
    ['dotenv',    { args: {}, dotenv: { DEMO_PORT: '5002' }, env: {}, jsonc: {} }, 'stated'],
    ['jsonc',     { args: {}, dotenv: {}, env: {}, jsonc: { port: 5003 } }, 'stated'],
  ];
  for (const [label, state, want] of channels) {
    const r = c.resolvePort(state);
    const o = portOrigin(r.source);
    assert.equal(o, want, `${label}: source '${r.source}' classified as ${o}, want ${want}`);
    assert.ok(PORT_ORIGINS.includes(String(o)),
      `${label}: '${o}' is not in the published vocabulary`);
  }
});

test('⛔ a STATED value always wins over the constant', () => {
  // The rule is not "prefer a flag"; it is that a run using a constant must be
  // distinguishable from one a human configured. If a stated value could lose,
  // the origin would describe the wrong thing.
  const c = createClientConfig(C);
  const r = c.resolvePort({ args: { port: 5000 }, dotenv: {}, env: { DEMO_PORT: '9999' }, jsonc: { port: 8888 } });
  assert.equal(r.value, 5000);
  assert.equal(portOrigin(r.source), 'stated');
});

test('⛔ an unrecognised source is NULL, never assumed stated', () => {
  // Fail-closed by asymmetry, not taste: a wrongly-refused run prints what to
  // do; a wrongly-ACCEPTED one is the bare-default ship the family rule exists
  // to forbid. A convenience default here would silently reclassify every
  // future source as "a human wrote this".
  for (const bad of ['something-new', '', null, undefined, 42, {}]) {
    assert.equal(portOrigin(/** @type {any} */ (bad)), null, `'${String(bad)}' must not classify`);
  }
});

test('the vocabulary is frozen and names the constant case honestly', () => {
  assert.ok(Object.isFrozen(PORT_ORIGINS));
  assert.ok(PORT_ORIGINS.includes('derived-from-constants'),
    'the constant case must not be called "default" — that word is what invites '
    + '"so it was a guess", which is the misreading this classification exists to stop');
  assert.ok(!PORT_ORIGINS.includes('default'));
});
