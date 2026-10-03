// cdp-open-page-own-tab.test.js — v7x3 §"base drives only a tab base opened" (v0.32.0).
//
// ⛔ THE INCIDENT THESE ARMS EXIST FOR: `openPage()` took `listPageTargets()[0]`
// by default, and a consumer's mutation arm navigated the human's ONLY tab in a
// signed-in browser. The tab a person is reading is, by construction, the first
// page target. ⇒ Each arm below is the spec's QA list item of the same number,
// and each carries its CONTROL, so a refusal cannot pass by refusing everything.
//
// Every endpoint here is a RECORDING FAKE on an ephemeral port
// (helpers/fake-cdp-browser.mjs). No test touches a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  openPage, navigate, listPageTargets, connectBrowser, listTargetsCorroborated,
} from '../lib/cdp-client.js';
import { startFakeBrowser, startTrap } from './helpers/fake-cdp-browser.mjs';

const HUMAN_URL = 'https://human.example.test/inbox';
const WORK_URL = 'https://work.example.test/page';
const HUMAN = { id: 'HUMAN-1', type: 'page', url: HUMAN_URL };
const NAV = { settleMs: 0, loadTimeout: 2000 };

/**
 * Run `fn` against a fresh fake browser and always stop it.
 * @param {Parameters<typeof startFakeBrowser>[0]} opts
 * @param {(fake: Awaited<ReturnType<typeof startFakeBrowser>>) => Promise<void>} fn
 */
async function withFake(opts, fn) {
  const fake = await startFakeBrowser(opts);
  try { await fn(fake); } finally { await fake.stop(); }
}

// ── 1 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA1: with one human tab, openPage()/navigate() MINT a background tab; the human tab is untouched', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    const n = await navigate(fake.base, WORK_URL, NAV);
    try {
      assert.equal(n.reused, false);
      assert.notEqual(n.targetId, 'HUMAN-1', 'the default must never drive the existing tab');
      const mints = fake.calls('Target.createTarget');
      assert.equal(mints.length, 1, 'exactly one mint');
      assert.equal(mints[0].params.background, true, 'a foreground mint steals the human\'s focus');
      assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL, 'the human tab\'s URL must be unchanged');
      assert.equal(fake.urlOf(n.targetId), WORK_URL, 'the navigation went to OUR tab');
      assert.ok(!fake.pageAttaches().some((a) => a.id === 'HUMAN-1'), 'never attached to the human tab');
    } finally { await n.close(); }
    assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL);
  });
});

test('QA1 control: {targetId: <human tab>, owner: \'adopted\'} DOES drive it, and close() leaves it open', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    const n = await navigate(fake.base, WORK_URL, { ...NAV, targetId: 'HUMAN-1', owner: 'adopted' });
    assert.equal(n.reused, true);
    assert.equal(n.targetId, 'HUMAN-1');
    assert.equal(fake.urlOf('HUMAN-1'), WORK_URL, 'an explicit adoption is driven');
    assert.equal(fake.calls('Target.createTarget').length, 0, 'an adoption mints nothing');
    const r = await n.close();
    assert.deepEqual(r, { closed: false, reason: 'adopted' });
    assert.ok(fake.targets.has('HUMAN-1'), 'an adopted tab is NEVER closed by base');
    assert.equal(fake.calls('Target.closeTarget').length, 0);
  });
});

// ── 2 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA2: a listPageTargets() id passed as owner:\'minted\', or with NO owner, is refused; its URL is unchanged', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    const [first] = await listPageTargets(fake.base);
    assert.equal(first.id, 'HUMAN-1', 'precondition: the copied id is the human tab');
    const id = String(first.id);

    await assert.rejects(() => openPage(fake.base, { targetId: id, owner: 'minted' }),
      (e) => /HUMAN-1/.test(e.message) && /ownedTargets/.test(e.message));
    await assert.rejects(() => navigate(fake.base, WORK_URL, { ...NAV, targetId: id }),
      (e) => /'minted'/.test(e.message) && /'adopted'/.test(e.message),
      'a missing owner must be refused, naming BOTH choices');
    await assert.rejects(() => openPage(fake.base, { targetId: id, owner: 'mine' }),
      (e) => /'minted'/.test(e.message) && /'adopted'/.test(e.message),
      'an unknown owner value is refused the same way');

    assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL);
    assert.equal(fake.pageAttaches().length, 0, 'nothing was attached to');
    assert.equal(fake.calls('Target.createTarget').length, 0, 'a refusal does not quietly mint instead');
  });
});

test('QA2 control: the id THIS process minted is driven as owner:\'minted\'; so is an id in a caller ownedTargets', async () => {
  await withFake({ targets: [HUMAN, { id: 'LEDGER-1', type: 'page', url: 'about:blank' }] }, async (fake) => {
    const mine = await openPage(fake.base, { keep: true });
    mine.session.close();
    const again = await navigate(fake.base, WORK_URL, { ...NAV, targetId: mine.targetId, owner: 'minted' });
    assert.equal(again.reused, true);
    assert.equal(again.targetId, mine.targetId);
    assert.equal(fake.urlOf(mine.targetId), WORK_URL);
    assert.deepEqual(await again.close(), { closed: false, reason: 'owned-reuse' },
      'an owned reuse is left open unless close: true');
    assert.ok(fake.targets.has(mine.targetId));

    // A durable ledger from an earlier process: a Set, and any object with has().
    for (const ownedTargets of [new Set(['LEDGER-1']), { has: (/** @type {string} */ x) => x === 'LEDGER-1' }]) {
      const led = await openPage(fake.base, { targetId: 'LEDGER-1', owner: 'minted', ownedTargets });
      assert.equal(led.reused, true);
      assert.equal(led.targetId, 'LEDGER-1');
      await led.close();
    }
    // …and that ledger does not vouch for the human tab.
    await assert.rejects(() => openPage(fake.base,
      { targetId: 'HUMAN-1', owner: 'minted', ownedTargets: new Set(['LEDGER-1']) }), /HUMAN-1/);
    assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL);
  });
});

// ── 3 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA3: minting unavailable on BOTH paths -> refused with the opt-in hint, never a fallback to an existing tab', async () => {
  await withFake({ targets: [HUMAN], createTarget: false, jsonNew: [] }, async (fake) => {
    await assert.rejects(() => navigate(fake.base, WORK_URL, NAV),
      (e) => /owner: 'adopted'/.test(e.message) && /restricted or disabled in some chromium builds/.test(e.message));
    assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL, 'the human tab\'s URL is unchanged');
    assert.equal(fake.pageAttaches().length, 0, 'no target was attached to');
    // Both paths were really tried, so the refusal is not a short-circuit.
    assert.equal(fake.calls('Target.createTarget').length, 1);
    assert.deepEqual(fake.log.filter((e) => e.t === 'http' && e.path === '/json/new').map((e) => e.method), ['PUT', 'GET']);
  });
});

test('QA3 control: with createTarget refused, the /json/new fallback mints (PUT, then GET)', async () => {
  for (const verbs of [['PUT'], ['GET']]) {
    await withFake({ targets: [HUMAN], createTarget: false, jsonNew: verbs }, async (fake) => {
      const p = await openPage(fake.base);
      assert.equal(p.reused, false);
      assert.match(p.targetId, /^MINTED-/);
      const tried = fake.log.filter((e) => e.t === 'http' && e.path === '/json/new').map((e) => e.method);
      assert.deepEqual(tried, verbs[0] === 'PUT' ? ['PUT'] : ['PUT', 'GET']);
      assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL);
      await p.close();
    });
  }
});

// ── 4 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA4: through a forward whose /json/version names a REMOTE authority, the mint dials the local forward; the raw authority is never dialled', async () => {
  const trap = await startTrap();
  try {
    await withFake({ targets: [HUMAN], advertise: trap.authority }, async (fake) => {
      // Precondition, else this arm is vacuous: the endpoint really advertises the trap.
      const v = await (await fetch(`${fake.base}/json/version`)).json();
      assert.ok(String(v.webSocketDebuggerUrl).includes(trap.authority));

      const n = await navigate(fake.base, WORK_URL, NAV);
      assert.equal(fake.urlOf(n.targetId), WORK_URL);
      await n.close();

      // The fallback path mints through the forward too.
      fake.configure({ createTarget: false });
      const f = await openPage(fake.base);
      await f.close();

      // An adopted reuse attaches through the forward.
      const a = await openPage(fake.base, { targetId: 'HUMAN-1', owner: 'adopted' });
      await a.close();

      assert.equal(trap.connections, 0, 'the raw (remote) authority must never be dialled');
      assert.ok(fake.log.some((e) => e.t === 'ws' && e.kind === 'browser'), 'the browser endpoint was reached locally');
    });
    // Control: the trap DOES record a connection, so the zero above is a measurement.
    await new Promise((r) => { const s = net.connect(trap.port, '127.0.0.1'); s.on('error', () => {}); s.on('close', r); });
    assert.equal(trap.connections, 1);
  } finally { await trap.stop(); }
});

// ── 5 ──────────────────────────────────────────────────────────────────────────
test('QA5: keep: true -> the minted tab survives close(); control: without it, it is closed', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    const kept = await navigate(fake.base, WORK_URL, { ...NAV, keep: true });
    assert.deepEqual(await kept.close(), { closed: false, reason: 'keep' });
    assert.ok(fake.targets.has(kept.targetId), 'keep: true must leave the tab open');

    const plain = await navigate(fake.base, WORK_URL, NAV);
    assert.deepEqual(await plain.close(), { closed: true });
    assert.ok(!fake.targets.has(plain.targetId), 'a minted tab without keep is closed, else it leaks');
    assert.ok(fake.targets.has('HUMAN-1'));
  });
});

// ── 6 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA6: the mint request is EXACTLY {url, background: true, newWindow: false} — no browserContextId', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    const a = await openPage(fake.base);
    await a.close();
    const b = await openPage(fake.base, { startUrl: WORK_URL });
    await b.close();
    const sent = fake.calls('Target.createTarget').map((c) => c.params);
    assert.deepEqual(sent, [
      { url: 'about:blank', background: true, newWindow: false },
      { url: WORK_URL, background: true, newWindow: false },
    ]);
    assert.ok(sent.every((p) => !('browserContextId' in p)), 'a fresh context lacks the human\'s sign-in');
  });
});

// ── 7 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA7: one page target, ours -> close() leaves it at about:blank and returns reason: \'last-page\'', async () => {
  await withFake({ targets: [{ id: 'SW-1', type: 'service_worker', url: 'chrome-extension://x/sw.js' }] }, async (fake) => {
    const n = await navigate(fake.base, WORK_URL, NAV);
    assert.deepEqual(await n.close(), { closed: false, reason: 'last-page' });
    assert.ok(fake.targets.has(n.targetId), 'closing the last page exits Chromium');
    assert.equal(fake.urlOf(n.targetId), 'about:blank');
    assert.equal(fake.state.browserExited, false);
  });
});

test('QA7: "last" is read at CLOSE time — a human tab closed meanwhile makes ours the last', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    const n = await navigate(fake.base, WORK_URL, NAV);
    fake.targets.delete('HUMAN-1'); // the person closed their tab while we worked
    assert.deepEqual(await n.close(), { closed: false, reason: 'last-page' });
    assert.equal(fake.urlOf(n.targetId), 'about:blank');
    assert.equal(fake.state.browserExited, false);
  });
});

test('QA7: an owned reuse with close: true is also bound by the last-page rule', async () => {
  await withFake({ targets: [] }, async (fake) => {
    const mine = await openPage(fake.base, { keep: true, startUrl: WORK_URL });
    mine.session.close();
    const r = await openPage(fake.base, { targetId: mine.targetId, owner: 'minted', close: true });
    assert.deepEqual(await r.close(), { closed: false, reason: 'last-page' });
    assert.equal(fake.urlOf(mine.targetId), 'about:blank');
    assert.equal(fake.state.browserExited, false);
  });
});

test('QA7 control: with a second page present, ours IS closed', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    const n = await navigate(fake.base, WORK_URL, NAV);
    assert.deepEqual(await n.close(), { closed: true });
    assert.ok(!fake.targets.has(n.targetId));
    assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL);

    const mine = await openPage(fake.base, { keep: true });
    mine.session.close();
    const r = await openPage(fake.base, { targetId: mine.targetId, owner: 'minted', close: true });
    assert.deepEqual(await r.close(), { closed: true }, 'close: true on an owned reuse closes it');
    assert.ok(!fake.targets.has(mine.targetId));
  });
});

// ── 8 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA8: onMinted throws -> no attach, the minted target is closed, foreign tabs unchanged, the hook\'s error is carried', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    await assert.rejects(() => navigate(fake.base, WORK_URL, { ...NAV, onMinted: () => { throw new Error('ledger write failed'); } }),
      /ledger write failed/);
    const minted = fake.calls('Target.createTarget');
    assert.equal(minted.length, 1);
    assert.equal(fake.pageAttaches().length, 0, 'a tab that could not be recorded is never attached to');
    assert.equal(fake.calls('Target.closeTarget').length, 1, 'the unrecorded tab is closed, not orphaned');
    assert.deepEqual([...fake.targets.keys()], ['HUMAN-1']);
    assert.equal(fake.urlOf('HUMAN-1'), HUMAN_URL);
  });
});

test('QA8: an async onMinted rejection behaves the same, and under the last-page rule the tab is blanked, not closed', async () => {
  await withFake({ targets: [] }, async (fake) => {
    await assert.rejects(() => openPage(fake.base, { startUrl: WORK_URL, onMinted: async () => { throw new Error('disk full'); } }),
      /disk full/);
    const ids = [...fake.targets.keys()];
    assert.equal(ids.length, 1, 'the only page must not be closed');
    assert.equal(fake.urlOf(ids[0]), 'about:blank');
    assert.equal(fake.state.browserExited, false);
  });
});

test('QA8 control: onMinted resolves, and the record lands strictly AFTER createTarget and BEFORE the first attach', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    /** @type {string[]} */
    const ledger = [];
    const n = await navigate(fake.base, WORK_URL, {
      ...NAV, keep: true,
      onMinted: async (/** @type {string} */ id) => {
        await new Promise((r) => setTimeout(r, 20)); // a slow write must still be awaited
        ledger.push(id);
        fake.log.push({ t: 'record', id });
      },
    });
    await n.close();
    assert.deepEqual(ledger, [n.targetId]);
    const iMint = fake.log.findIndex((e) => e.t === 'cdp' && e.method === 'Target.createTarget');
    const iRecord = fake.log.findIndex((e) => e.t === 'record');
    const iAttach = fake.log.findIndex((e) => e.t === 'ws' && e.kind === 'page' && e.id === n.targetId);
    assert.ok(iMint >= 0 && iRecord >= 0 && iAttach >= 0, JSON.stringify({ iMint, iRecord, iAttach }));
    assert.ok(iMint < iRecord && iRecord < iAttach, `order was mint=${iMint} record=${iRecord} attach=${iAttach}`);
  });
});

// ── 9 ──────────────────────────────────────────────────────────────────────────
test('⛔ QA9: a targetId naming an ABSENT id, or a non-page target, is refused, naming it', async () => {
  await withFake({ targets: [HUMAN, { id: 'SW-1', type: 'service_worker', url: 'chrome-extension://x/sw.js' }] }, async (fake) => {
    await assert.rejects(() => openPage(fake.base, { targetId: 'NOPE-404', owner: 'adopted' }), /NOPE-404/);
    await assert.rejects(() => openPage(fake.base, { targetId: 'SW-1', owner: 'adopted' }),
      (e) => /SW-1/.test(e.message) && /service_worker/.test(e.message));
    assert.equal(fake.pageAttaches().length, 0);
    // Control: the same call with an existing page is accepted.
    const ok = await openPage(fake.base, { targetId: 'HUMAN-1', owner: 'adopted' });
    assert.equal(ok.targetId, 'HUMAN-1');
    await ok.close();
  });
});

test('⛔ QA9: an UNKNOWN option is refused, naming it — a stale reuse: true is told so, never given a new tab', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    await assert.rejects(() => openPage(fake.base, /** @type {any} */ ({ reuse: true })), /reuse/);
    await assert.rejects(() => navigate(fake.base, WORK_URL, /** @type {any} */ ({ ...NAV, reuse: true })), /reuse/);
    await assert.rejects(() => connectBrowser(fake.base, /** @type {any} */ ({ readOnly: true })), /readOnly/);
    await assert.rejects(() => listTargetsCorroborated(fake.base, /** @type {any} */ ({ readOnly: true })), /readOnly/);
    assert.equal(fake.calls('Target.createTarget').length, 0, 'refused BEFORE anything was minted');
    assert.equal(fake.log.length, 0, 'refused before any contact at all');
    // Control: the known options are accepted.
    const p = await openPage(fake.base, { startUrl: 'about:blank', defaultTimeout: 5000 });
    await p.close();
    const b = await connectBrowser(fake.base, { defaultTimeout: 5000 });
    b.close();
  });
});

test('options that cannot be honoured TOGETHER are refused, not silently resolved', async () => {
  await withFake({ targets: [HUMAN] }, async (fake) => {
    await assert.rejects(() => openPage(fake.base, { targetId: 'HUMAN-1', owner: 'adopted', close: true }),
      /adopted.*never closed|never closes an adopted/);
    await assert.rejects(() => openPage(fake.base, { targetId: 'HUMAN-1', owner: 'adopted', onMinted: () => {} }),
      /onMinted/);
    await assert.rejects(() => openPage(fake.base, { keep: true, close: true }), /keep.*close|close.*keep/);
    await assert.rejects(() => openPage(fake.base, { owner: 'minted' }), /targetId/);
    assert.equal(fake.log.length, 0);
  });
});
