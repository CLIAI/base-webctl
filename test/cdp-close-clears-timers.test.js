// cdp-close-clears-timers.test.js — a rejected call must not leave an ARMED timer.
//
// ⛔ WHY: `CdpSession`'s close handler rejected every in-flight call and never
// cleared its timer. The rejection was correct and arrived on time, so nothing
// looked broken — while an armed timer held the event loop open for the full
// command timeout. Found by a consumer's LIVE QA, not here: 15.7 s of wall clock
// for 0.39 s of work, after every command that had evaluated.
//
// ⚠ AND THE PATH HAD NO TEST BECAUSE THE SOCKET WAS NOT INJECTABLE. The defect
// lived in exactly the branch that could not be reached from a test, which is the
// week's recurring shape. `WebSocketImpl` was added for this.
//
// ⭐ The assertion is on `process.getActiveResourcesInfo()` — public since Node 17
// — because that measures THE REPORTED SYMPTOM (a live timer keeping the process
// up) rather than a proxy for it. Asserting only that the promise rejects would
// have passed against the defect: it always did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession } from '../lib/cdp-client.js';

/** Count live Timeout handles. */
const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

/**
 * A socket that opens, swallows sends, and closes on demand — never replying.
 * Deliberately minimal: the point is a reply that never comes.
 */
function fakeSocket() {
  /** @type {Record<string, Function[]>} */
  const ls = {};
  const sock = {
    sent: /** @type {string[]} */ ([]),
    addEventListener(/** @type {string} */ ev, /** @type {Function} */ fn) {
      (ls[ev] ||= []).push(fn);
    },
    send(/** @type {string} */ d) { sock.sent.push(d); },
    fire(/** @type {string} */ ev, /** @type {any} */ arg) { for (const fn of ls[ev] || []) fn(arg); },
  };
  return sock;
}

/** @param {{sock?: any}} [out] */
function session(out = {}) {
  const sock = fakeSocket();
  if (out) out.sock = sock;
  // A long timeout so a leaked timer is unmistakable: if the fix is absent, the
  // handle is still armed when we assert, exactly as in production.
  return new CdpSession('ws://127.0.0.1:1/devtools/page/x',
    { defaultTimeout: 600000, WebSocketImpl: function () { return sock; } });
}

test('⛔ a pending COMMAND rejected by close leaves no armed timer', async () => {
  /** @type {any} */ const out = {};
  const s = session(out);
  const connected = s.connect();
  out.sock.fire('open');
  await connected;

  const before = timers();
  const call = s.cdp('Runtime.evaluate', { expression: '1' });
  assert.equal(timers(), before + 1, 'the fixture must actually arm a timer, or this test proves nothing');

  out.sock.fire('close');
  await assert.rejects(call, /closed before the reply arrived/);

  // ⇒ THE ASSERTION THAT FAILS AGAINST THE DEFECT. The rejection above passed
  // before the fix too; only the handle count distinguishes them.
  assert.equal(timers(), before,
    'the timer of a rejected call is still armed — it will hold the event loop '
    + 'open until the command timeout, which is the reported symptom');
});

test('⛔ a pending waitForEvent rejected by close leaves no armed timer, and says WHY', async () => {
  /** @type {any} */ const out = {};
  const s = session(out);
  const connected = s.connect();
  out.sock.fire('open');
  await connected;

  const before = timers();
  const waiting = s.waitForEvent('Page.loadEventFired');
  assert.equal(timers(), before + 1, 'the fixture must arm a timer');

  out.sock.fire('close');
  // ⚠ Before the fix this did not reject at all on close: the caller waited the
  // whole timeout and then failed with "did not arrive within Nms" — a true
  // sentence naming the wrong cause.
  await assert.rejects(waiting, /closed while waiting for event Page\.loadEventFired/);
  assert.equal(timers(), before, 'the waiter timer is still armed after close');
});

test('⭐ CONTROL: a call that RECEIVES its reply also leaves no armed timer', async () => {
  // Otherwise "no armed timers" could be satisfied by a session that never arms
  // any, and both tests above would pass over a broken fixture.
  /** @type {any} */ const out = {};
  const s = session(out);
  const connected = s.connect();
  out.sock.fire('open');
  await connected;

  const before = timers();
  const call = s.cdp('Runtime.evaluate', { expression: '1+1' });
  const id = JSON.parse(out.sock.sent[0]).id;
  out.sock.fire('message', { data: JSON.stringify({ id, result: { result: { value: 2 } } }) });

  assert.deepEqual(await call, { result: { value: 2 } });
  assert.equal(timers(), before, 'the happy path must also clear its timer');
});
