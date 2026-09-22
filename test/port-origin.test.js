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

test('⭐ EVERY source that reaches inspect() is classifiable — all producers', () => {
  // ⛔ THERE ARE TWO PRODUCERS OF PORT SOURCES, and v0.13.0 shipped classifying
  // only one. resolvePort() emits 'default'/'cli'/'env:FOO'/'jsonc:port';
  // deriveXpraPorts() emits 'derived', 'derived (== tcp; …)',
  // 'jsonc.ports["xpra-tcp"]'. So TWO OF THE THREE PORTS inspect() carries
  // returned null, and a fail-closed consumer would have refused every
  // ordinary bring-up.
  //
  // ⭐ The previous version of this test listed resolvePort's channels BY HAND
  // and I described it as walking "the resolver's real output". It walked ONE
  // resolver's. ⇒ This one enumerates `cfg.portSources` — the object that
  // actually reaches inspect() — so a producer added later cannot be missed by
  // a hand-maintained list, which is the whole failure being repaired.
  const c = createClientConfig(C);
  const matrix = [
    ['defaults',        { args: {}, dotenv: {}, env: {}, jsonc: {} }],
    ['cdp by flag',     { args: { port: 5000 }, dotenv: {}, env: {}, jsonc: {} }],
    ['cdp by env',      { args: {}, dotenv: {}, env: { DEMO_PORT: '5001' }, jsonc: {} }],
    ['cdp by dotenv',   { args: {}, dotenv: { DEMO_PORT: '5002' }, env: {}, jsonc: {} }],
    ['cdp by jsonc',    { args: {}, dotenv: {}, env: {}, jsonc: { port: 5003 } }],
    ['xpra tcp bag',    { args: {}, dotenv: {}, env: {}, jsonc: { ports: { 'xpra-tcp': 19999 } } }],
    ['xpra tcp camel',  { args: {}, dotenv: {}, env: {}, jsonc: { xpraTcpPort: 18888 } }],
    ['xpra tcp snake',  { args: {}, dotenv: {}, env: {}, jsonc: { xpra_tcp_port: 18887 } }],
    ['xpra html5 bag',  { args: {}, dotenv: {}, env: {}, jsonc: { ports: { 'xpra-html5': 17777 } } }],
    ['xpra html5 camel',{ args: {}, dotenv: {}, env: {}, jsonc: { xpraHtml5Port: 17776 } }],
  ];
  let checked = 0;
  for (const [label, state] of matrix) {
    const cfg = c.buildDriverCfg(state);
    assert.ok(cfg.portSources, `${label}: no portSources at all`);
    for (const [key, source] of Object.entries(cfg.portSources)) {
      const o = portOrigin(/** @type {string} */ (source));
      assert.ok(o !== null,
        `${label}: port '${key}' has source ${JSON.stringify(source)} which `
        + 'portOrigin cannot classify — a fail-closed consumer refuses this run');
      assert.ok(PORT_ORIGINS.includes(o), `${label}/${key}: '${o}' not in the vocabulary`);
      checked++;
    }
  }
  // ⛔ COUNT THE ASSERTIONS. A matrix that silently produced no sources would
  // pass every loop body zero times.
  assert.ok(checked >= 30, `only ${checked} sources checked — the matrix is not exercising the producers`);
});

test('a CONFIGURED xpra port reads as stated; a computed one does not', () => {
  // The distinction has to survive both producers, not only the cdp one.
  const c = createClientConfig(C);
  const derived = c.buildDriverCfg({ args: {}, dotenv: {}, env: {}, jsonc: {} });
  assert.equal(portOrigin(derived.portSources['xpra-tcp']), 'derived-from-constants');

  const stated = c.buildDriverCfg({ args: {}, dotenv: {}, env: {}, jsonc: { ports: { 'xpra-tcp': 19999 } } });
  assert.equal(portOrigin(stated.portSources['xpra-tcp']), 'stated');
});

test('⚠ the API is reachable from the FACTORY surface, not only the module', () => {
  // Consumers' shims re-export what createClientConfig() returns. A
  // module-level-only API is unreachable from the lane that needs it — shipped
  // that way in v0.13.0 and reported within the hour. A published API a
  // consumer cannot reach is not published.
  const c = /** @type {any} */ (createClientConfig(C));
  assert.equal(typeof c.portOrigin, 'function');
  assert.ok(Array.isArray(c.PORT_ORIGINS));
  assert.equal(c.portOrigin('derived'), 'derived-from-constants');
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
