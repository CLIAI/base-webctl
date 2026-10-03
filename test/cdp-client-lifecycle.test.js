// cdp-client-lifecycle.test.js — openPage / closePage / navigate.
//
// These test the decisions that are ENVIRONMENT KNOWLEDGE rather than style,
// because a reimplementation gets them wrong by default and each failure is
// expensive somewhere other than where it is written:
//
//   1. ⛔ MINT BY DEFAULT (v0.32.0) -> SUPERSEDES "reuse before minting". The first
//                                       page target is, by construction, the tab a
//                                       person is reading; reusing it navigated a
//                                       human's only tab (v7x3 incident, 2026-10-03).
//                                       Full QA arms: cdp-open-page-own-tab.test.js.
//   2. /json/new is a FALLBACK       -> that endpoint is restricted/disabled in
//                                       some chromium builds; Target.createTarget
//                                       is primary
//   3. close only a tab you own      -> an adopted tab is the browser's own, and
//                                       closing it tears down the session the
//                                       caller is standing on
//
// ⚠ BREAKING in v0.32.0: arm 1 used to assert the OPPOSITE ("an existing page is
// REUSED — /json/new is never called"), and arm 3's reuse half drove an existing
// page by default. Both now have to say whose tab it is.
//
// Every endpoint is a recording FAKE on an ephemeral port. No real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openPage, closePage, navigate } from '../lib/cdp-client.js';
import { startFakeBrowser } from './helpers/fake-cdp-browser.mjs';

const EXISTING = { id: 'existing-1', type: 'page', url: 'https://example.test/' };

/**
 * @param {Parameters<typeof startFakeBrowser>[0]} opts
 * @param {(fake: Awaited<ReturnType<typeof startFakeBrowser>>) => Promise<void>} fn
 */
async function withFake(opts, fn) {
  const fake = await startFakeBrowser(opts);
  try { await fn(fake); } finally { await fake.stop(); }
}

const newVerbs = (/** @type {any} */ fake) =>
  fake.log.filter((/** @type {any} */ e) => e.t === 'http' && e.path === '/json/new').map((/** @type {any} */ e) => e.method);

test('⛔ 1. an existing page is NOT reused by default — a new background tab is minted (BREAKING, v0.32.0)', async () => {
  await withFake({ targets: [EXISTING] }, async (fake) => {
    const r = await openPage(fake.base);
    assert.equal(r.reused, false);
    assert.notEqual(r.targetId, 'existing-1');
    assert.equal(fake.calls('Target.createTarget').length, 1);
    assert.deepEqual(newVerbs(fake), [], 'createTarget worked, so /json/new is not touched');
    await r.close();
  });
});

test('⭐ 2. Target.createTarget is primary; when it is refused, /json/new is tried PUT first', async () => {
  await withFake({ targets: [EXISTING], createTarget: false, jsonNew: ['PUT'] }, async (fake) => {
    const r = await openPage(fake.base);
    assert.equal(r.reused, false);
    assert.deepEqual(newVerbs(fake), ['PUT'], 'PUT succeeds, so GET must not be attempted');
    await r.close();
  });
});

test('2b. a build that REJECTS PUT falls back to GET rather than failing', async () => {
  await withFake({ targets: [EXISTING], createTarget: false, jsonNew: ['GET'] }, async (fake) => {
    const r = await openPage(fake.base);
    assert.match(r.targetId, /^MINTED-/);
    assert.deepEqual(newVerbs(fake), ['PUT', 'GET'], 'must try PUT, then GET');
    await r.close();
  });
});

test('2c. a build where minting is DISABLED fails with a message naming why — and the opt-in', async () => {
  // The endpoint being restricted is the documented reason it is not primary,
  // so the error has to say that rather than "404".
  await withFake({ targets: [EXISTING], createTarget: false, jsonNew: [] }, async (fake) => {
    await assert.rejects(() => openPage(fake.base),
      (e) => /restricted or disabled in some chromium builds/.test(e.message) && /owner: 'adopted'/.test(e.message));
    assert.equal(fake.urlOf('existing-1'), EXISTING.url);
  });
});

test('⛔ 3. close() closes a MINTED tab and NEVER an adopted one', async () => {
  await withFake({ targets: [EXISTING] }, async (fake) => {
    const n = await navigate(fake.base, 'https://example.test/next', { settleMs: 0, loadTimeout: 2000 });
    assert.equal(n.reused, false);
    assert.deepEqual(await n.close(), { closed: true });
    assert.ok(!fake.targets.has(n.targetId), 'a minted tab MUST be closed, else it leaks');

    const a = await navigate(fake.base, 'https://example.test/next',
      { settleMs: 0, loadTimeout: 2000, targetId: 'existing-1', owner: 'adopted' });
    assert.equal(a.reused, true);
    assert.deepEqual(await a.close(), { closed: false, reason: 'adopted' });
    assert.ok(fake.targets.has('existing-1'),
      'an adopted tab must never be closed — that is the browser session itself');
  });
});

test('closePage is best-effort and does not throw when the endpoint fails', async () => {
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error('connection refused'); };
  try {
    await closePage('http://fake.invalid', 'whatever'); // must not throw
    assert.equal(called, 1, 'it did try');
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
