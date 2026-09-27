// cdp-leak-probe.mjs — a CHILD process whose EXIT TIME is the measurement.
//
// ⛔ WHY A CHILD AND NOT AN IN-PROCESS ASSERTION. `node --test` keeps its own event
// loop alive and buffers a file's output until the file completes. So a leaked
// timer inside a test does not fail it — it PREVENTS IT FROM REPORTING AT ALL.
// Measured: with the fix reverted, `node --test` on the in-process version emitted
// NO TAP output and had to be killed. ⇒ `npm test` would HANG rather than fail, and
// a suite that hangs has no verdict, which is worse than a red one.
//
// ⇒ The property is PROCESS LIVENESS, so the only instrument that can see it is a
// process. This script does the scenario and returns; the parent times its exit.
//
// argv[2]: 'command' | 'waiter' | 'reply'

import { CdpSession } from '../../lib/cdp-client.js';

/** A socket that opens, swallows sends, and closes on demand — never replying. */
function fakeSocket() {
  /** @type {Record<string, Function[]>} */
  const ls = {};
  const sock = {
    sent: /** @type {string[]} */ ([]),
    addEventListener(/** @type {string} */ ev, /** @type {Function} */ fn) { (ls[ev] ||= []).push(fn); },
    send(/** @type {string} */ d) { sock.sent.push(d); },
    fire(/** @type {string} */ ev, /** @type {any} */ a) { for (const fn of ls[ev] || []) fn(a); },
  };
  return sock;
}

const mode = process.argv[2];

// ⚠ `node --test` DISCOVERS EVERY .mjs UNDER test/, INCLUDING HELPERS. Run bare it
// must therefore exit cleanly, as the sibling helpers do — otherwise `npm test`
// reports a failing "test" that is really a fixture invoked without arguments.
// ⇒ Exiting 0 here is safe and does NOT weaken anything, because the parent asserts
// the `SCENARIO-DONE` sentinel: a silent no-op fails the parent, so a typo'd mode
// cannot pass as a green scenario.
if (mode !== 'command' && mode !== 'waiter' && mode !== 'reply') {
  process.exit(0);
}

const sock = fakeSocket();
// ⚠ Ten minutes on purpose: if a timer survives, this process cannot exit within
// any plausible test budget, so a leak is unmistakable rather than marginal.
const s = new CdpSession('ws://127.0.0.1:1/devtools/page/x',
  { defaultTimeout: 600000, WebSocketImpl: function () { return sock; } });

const connected = s.connect();
sock.fire('open');
await connected;

if (mode === 'command') {
  const call = s.cdp('Runtime.evaluate', { expression: '1' });
  sock.fire('close');
  await call.then(() => { throw new Error('expected rejection'); }, () => {});
} else if (mode === 'waiter') {
  const waiting = s.waitForEvent('Page.loadEventFired');
  sock.fire('close');
  await waiting.then(() => { throw new Error('expected rejection'); },
    (/** @type {any} */ e) => {
      // The reason must name the close, not a timeout that never happened.
      if (!/closed while waiting for event/.test(e.message)) {
        throw new Error(`wrong reason: ${e.message}`);
      }
    });
} else if (mode === 'reply') {
  // CONTROL: a call that RECEIVES its reply must also leave nothing armed.
  const call = s.cdp('Runtime.evaluate', { expression: '1+1' });
  const id = JSON.parse(sock.sent[0]).id;
  sock.fire('message', { data: JSON.stringify({ id, result: { result: { value: 2 } } }) });
  await call;
}

process.stdout.write('SCENARIO-DONE\n');
// ⇒ No explicit process.exit(): the whole point is whether the loop DRAINS on its
// own. Calling exit() would mask exactly the defect under test.
