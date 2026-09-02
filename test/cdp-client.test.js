// cdp-client.test.js — the extracted CDP client (item 3).
//
// The load-bearing behaviour is not "does it list targets" — it is that an
// ABSENCE must never be answered from the weaker source. `GET /json` does not
// reliably enumerate service_worker targets, so concluding "not running" from
// it produces a result indistinguishable from a real absence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  listTargets, listPageTargets, listTargetsViaBrowser, listTargetsCorroborated, getVersion,
} from '../lib/cdp-client.js';

const BASE = 'http://127.0.0.1:4327';

/** Install a fetch stub; returns a restore function. */
function stubFetch(routes) {
  const real = globalThis.fetch;
  globalThis.fetch = async (/** @type {any} */ url) => {
    const key = Object.keys(routes).find((k) => String(url).endsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const v = routes[key];
    if (v instanceof Error) throw v;
    return { ok: true, status: 200, json: async () => v };
  };
  return () => { globalThis.fetch = real; };
}

const PAGE = { id: 'p1', type: 'page', url: 'https://example.test/', webSocketDebuggerUrl: 'ws://localhost:4327/devtools/page/p1' };
const SW = { id: 'sw1', type: 'service_worker', url: 'chrome-extension://abc/sw.js' };

test('listTargets returns every type by default; types filters; requireWs filters', async () => {
  const restore = stubFetch({ '/json': [PAGE, SW] });
  try {
    assert.equal((await listTargets(BASE)).length, 2, 'no types = everything');
    assert.deepEqual((await listTargets(BASE, { types: ['service_worker'] })).map((t) => t.id), ['sw1']);
    // The service_worker entry has no webSocketDebuggerUrl, so requireWs drops it.
    assert.deepEqual((await listTargets(BASE, { requireWs: true })).map((t) => t.id), ['p1']);
  } finally { restore(); }
});

test('listPageTargets preserves the original per-site behaviour', async () => {
  // This is the call the existing consumers make. The extraction widened the
  // implementation underneath it; the wrapper must not change what they see.
  const restore = stubFetch({ '/json': [PAGE, SW] });
  try {
    const pages = await listPageTargets(BASE);
    assert.deepEqual(pages.map((t) => t.id), ['p1']);
  } finally { restore(); }
});

test('⭐ the HTTP list can MISS a service_worker the browser endpoint reports', async () => {
  // The defect the extraction exists to fix, as a test: same browser, two
  // sources, different answers — and the weaker one says "nothing here".
  const restore = stubFetch({ '/json': [PAGE] }); // no service_worker
  try {
    const viaHttp = await listTargets(BASE, { types: ['service_worker'] });
    assert.equal(viaHttp.length, 0, 'HTTP says the worker does not exist');
    // Asserting an absence on that would be indistinguishable from "not
    // running" — which is why listTargetsViaBrowser exists and is authoritative.
  } finally { restore(); }
});

test('listTargetsCorroborated answers from the BROWSER source, not HTTP', async () => {
  const restore = stubFetch({
    '/json': [PAGE],                                   // HTTP misses the worker
    '/json/version': { webSocketDebuggerUrl: 'ws://localhost:4327/devtools/browser/b1' },
  });
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = fakeBrowserWs([PAGE, SW]);
  try {
    const seen = [];
    const r = await listTargetsCorroborated(BASE, { onDisagree: (i) => seen.push(i) });
    assert.deepEqual(r.targets.map((t) => t.id).sort(), ['p1', 'sw1'],
      'the authoritative source must win');
    assert.equal(r.sourcesAgree, false);
    assert.equal(seen.length, 1, 'a disagreement must be reported, not just recorded');
  } finally { restore(); globalThis.WebSocket = realWS; }
});

test('a disagreement is LOUD by default — silence requires an explicit opt-out', async () => {
  // A sourcesAgree boolean nobody reads is the same silent winner-picking the
  // function exists to prevent. Default must warn; opting out must be a
  // decision (onDisagree: null), never an omission.
  const restore = stubFetch({
    '/json': [PAGE],
    '/json/version': { webSocketDebuggerUrl: 'ws://localhost:4327/devtools/browser/b1' },
  });
  const realWS = globalThis.WebSocket;
  const realWarn = console.warn;
  globalThis.WebSocket = fakeBrowserWs([PAGE, SW]);
  const warnings = [];
  console.warn = (/** @type {any} */ m) => warnings.push(String(m));
  try {
    await listTargetsCorroborated(BASE);
    assert.equal(warnings.length, 1, 'default must warn on disagreement');
    assert.match(warnings[0], /DISAGREE/);

    warnings.length = 0;
    await listTargetsCorroborated(BASE, { onDisagree: null });
    assert.equal(warnings.length, 0, 'explicit null opts out');
  } finally { restore(); globalThis.WebSocket = realWS; console.warn = realWarn; }
});

test('an unreadable HTTP list is NOT reported as agreement', async () => {
  // "Could not read it" must never render as "they match" — the two-absences
  // failure (t2wf).
  const restore = stubFetch({
    '/json': new Error('connection refused'),
    '/json/version': { webSocketDebuggerUrl: 'ws://localhost:4327/devtools/browser/b1' },
  });
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = fakeBrowserWs([]);
  try {
    const r = await listTargetsCorroborated(BASE, { onDisagree: null });
    assert.equal(r.sourcesAgree, false, 'both empty, but one is empty because it FAILED');
    assert.ok(r.httpError, 'the failure must be surfaced, not swallowed');
  } finally { restore(); globalThis.WebSocket = realWS; }
});

test('getVersion rewrites the browser ws URL to the host', async () => {
  const restore = stubFetch({
    '/json/version': { webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/b1' },
  });
  try {
    const v = await getVersion(BASE, { host: '127.0.0.1', port: 4327 });
    assert.match(v.webSocketDebuggerUrl, /127\.0\.0\.1:4327/,
      'container-internal host:port must be rewritten to the published one');
  } finally { restore(); }
});

test('the excluded parts are genuinely absent from the public surface', async () => {
  // The contributing lane marked three things as not-for-base and webctl:mgr
  // ruled the credential deny-list must not become a family default, because a
  // wired consumer legitimately reads cookies. Asserted rather than trusted,
  // since "we left it out" is exactly the kind of claim that rots.
  const mod = await import('../lib/cdp-client.js');
  const names = Object.keys(mod).join(' ');
  for (const forbidden of ['CREDENTIAL', 'ObserverOnly', 'readOnly', 'EXTENSION_BACKGROUND_TYPES', 'isObservational']) {
    assert.doesNotMatch(names, new RegExp(forbidden, 'i'), `${forbidden} must not be in base's surface`);
  }
});

/** Minimal browser-websocket double that answers Target.getTargets. */
function fakeBrowserWs(targetInfos) {
  return class {
    constructor() {
      this._listeners = {};
      setTimeout(() => (this._listeners.open || []).forEach((f) => f()), 0);
    }
    addEventListener(/** @type {string} */ ev, /** @type {Function} */ fn) {
      (this._listeners[ev] = this._listeners[ev] || []).push(fn);
    }
    send(/** @type {string} */ raw) {
      const msg = JSON.parse(raw);
      const reply = JSON.stringify({ id: msg.id, result: { targetInfos } });
      setTimeout(() => (this._listeners.message || []).forEach((f) => f({ data: reply })), 0);
    }
    close() {}
  };
}
