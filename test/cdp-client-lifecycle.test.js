// cdp-client-lifecycle.test.js — openPage / closePage / navigate.
//
// These test the three decisions that are ENVIRONMENT KNOWLEDGE rather than
// style, because a reimplementation gets all three wrong by default and each
// failure is expensive somewhere other than where it is written:
//
//   1. reuse before minting          -> otherwise tabs leak across a long run
//   2. /json/new is a FALLBACK       -> that endpoint is restricted/disabled in
//                                       some chromium builds, so minting-first
//                                       works for the author and fails elsewhere
//   3. close only the tab you minted -> closing a REUSED tab tears down the
//                                       browser's own page, and the session the
//                                       caller is standing on
//
// This is the half that makes the extraction able to REPLACE a hand-rolled
// client rather than merely sit beside one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openPage, closePage, navigate } from '../lib/cdp-client.js';

const BASE = 'http://127.0.0.1:4527';
const PAGE = {
  id: 'existing-1', type: 'page', url: 'https://example.test/',
  webSocketDebuggerUrl: 'ws://localhost:4527/devtools/page/existing-1',
};
const MINTED = {
  id: 'minted-1', type: 'page', url: 'about:blank',
  webSocketDebuggerUrl: 'ws://localhost:4527/devtools/page/minted-1',
};

/**
 * fetch double that records every call.
 * @param {{pages: any[], newOk?: string[]}} o  `newOk` = verbs /json/new accepts
 */
function stubFetch(o) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET' });
    if (u.endsWith('/json')) return { ok: true, status: 200, json: async () => o.pages };
    if (u.includes('/json/new')) {
      const verb = (init && init.method) || 'GET';
      const accepts = o.newOk || ['PUT'];
      return accepts.includes(verb)
        ? { ok: true, status: 200, json: async () => MINTED }
        : { ok: false, status: 405, json: async () => ({}) };
    }
    if (u.includes('/json/close/')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function stubWs() {
  const real = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {
      this._l = {};
      setTimeout(() => (this._l.open || []).forEach((f) => f()), 0);
    }
    addEventListener(/** @type {string} */ e, /** @type {Function} */ f) { (this._l[e] = this._l[e] || []).push(f); }
    send(/** @type {string} */ raw) {
      const m = JSON.parse(raw);
      setTimeout(() => (this._l.message || []).forEach((f) => f({ data: JSON.stringify({ id: m.id, result: {} }) })), 0);
    }
    close() {}
  };
  return () => { globalThis.WebSocket = real; };
}

test('⭐ 1. an existing page is REUSED — /json/new is never called', async () => {
  // Minting per operation leaks a tab per page across a long run.
  const f = stubFetch({ pages: [PAGE] });
  const restoreWs = stubWs();
  try {
    const r = await openPage(BASE);
    assert.equal(r.reused, true);
    assert.equal(r.targetId, 'existing-1');
    assert.ok(!f.calls.some((c) => c.url.includes('/json/new')),
      `must not mint when a page exists; calls: ${f.calls.map((c) => c.url).join(', ')}`);
  } finally { f.restore(); restoreWs(); }
});

test('⭐ 2. with ZERO pages it mints, trying PUT then GET', async () => {
  // PUT first, GET as the older-build fallback.
  const f = stubFetch({ pages: [], newOk: ['PUT'] });
  const restoreWs = stubWs();
  try {
    const r = await openPage(BASE);
    assert.equal(r.reused, false);
    assert.equal(r.targetId, 'minted-1');
    const verbs = f.calls.filter((c) => c.url.includes('/json/new')).map((c) => c.method);
    assert.deepEqual(verbs, ['PUT'], 'PUT succeeds, so GET must not be attempted');
  } finally { f.restore(); restoreWs(); }
});

test('2b. a build that REJECTS PUT falls back to GET rather than failing', async () => {
  const f = stubFetch({ pages: [], newOk: ['GET'] });
  const restoreWs = stubWs();
  try {
    const r = await openPage(BASE);
    assert.equal(r.targetId, 'minted-1');
    const verbs = f.calls.filter((c) => c.url.includes('/json/new')).map((c) => c.method);
    assert.deepEqual(verbs, ['PUT', 'GET'], 'must try PUT, then GET');
  } finally { f.restore(); restoreWs(); }
});

test('2c. a build where /json/new is DISABLED fails with a message naming why', async () => {
  // The endpoint being restricted is the documented reason it is not primary,
  // so the error has to say that rather than "404".
  const f = stubFetch({ pages: [], newOk: [] });
  const restoreWs = stubWs();
  try {
    await assert.rejects(() => openPage(BASE), /restricted or disabled in some chromium builds/);
  } finally { f.restore(); restoreWs(); }
});

test('⛔ 3. close() closes a MINTED tab and NEVER a reused one', async () => {
  // Closing a reused tab tears down the browser's own page — frequently its
  // only one — and with it the session the caller is standing on.
  const restoreWs = stubWs();

  const fMint = stubFetch({ pages: [], newOk: ['PUT'] });
  try {
    const n = await navigate(BASE, 'https://example.test/', { settleMs: 0 });
    assert.equal(n.reused, false);
    await n.close();
    assert.ok(fMint.calls.some((c) => c.url.includes('/json/close/minted-1')),
      'a minted tab MUST be closed, else it leaks');
  } finally { fMint.restore(); }

  const fReuse = stubFetch({ pages: [PAGE] });
  try {
    const n = await navigate(BASE, 'https://example.test/', { settleMs: 0 });
    assert.equal(n.reused, true);
    await n.close();
    assert.ok(!fReuse.calls.some((c) => c.url.includes('/json/close/')),
      'a REUSED tab must never be closed — that is the browser session itself');
  } finally { fReuse.restore(); restoreWs(); }
});

test('closePage is best-effort and does not throw when the endpoint fails', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  try {
    await closePage(BASE, 'whatever'); // must not throw
  } finally { globalThis.fetch = real; }
});

test('the surface is a SUPERSET of the client it replaces', async () => {
  // The extraction exists to retire hand-rolled clients. A client missing
  // openPage/navigate cannot replace one, which is how v0.9.0 shipped half a
  // lift — so the completeness is asserted rather than assumed.
  const mod = await import('../lib/cdp-client.js');
  for (const name of ['CdpSession', 'getVersion', 'listPageTargets', 'openPage', 'closePage', 'navigate']) {
    assert.ok(name in mod, `missing ${name} — cannot replace the original client`);
  }
});
