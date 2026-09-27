// cdp-close-clears-timers.test.js — a settled promise is not the end of the work.
//
// ⛔ THE DEFECT: `CdpSession`'s close handler rejected every in-flight call and never
// cleared its timer. The rejection was correct and arrived in milliseconds, so
// nothing looked broken — while an ARMED timer held the event loop open for the full
// command timeout. Found by a consumer's live QA: 15.7 s of wall clock for 0.39 s of
// work, after every command that had evaluated. `waitForEvent` had it worse: on a
// close its caller waited the entire timeout and then failed with "did not arrive",
// a true sentence naming the wrong cause.
//
// ⭐ "Clear timers on close" reads as bookkeeping. It is a LIVENESS bug, and the
// framing that makes it obvious came from another lane who found the same shape in
// their own code: **the promise settling is not the end of the work if a timer
// survives it.**
//
// ⛔ AND MY FIRST VERSION OF THIS FILE COULD NOT REPORT. It asserted in-process on
// `process.getActiveResourcesInfo()`. But `node --test` keeps its own loop alive and
// buffers a file's output until the file completes — so a leaked timer did not fail
// the test, it PREVENTED IT FROM REPORTING. Measured with the fix reverted: NO TAP
// output at all, killed at 25 s. ⇒ `npm test` would have HUNG rather than failed, and
// a suite that hangs has no verdict, which is worse than a red one. The same lane
// warned me: the regression test has to SPAWN, because the property is process
// liveness and only a process can observe it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'helpers', 'cdp-leak-probe.mjs');

/**
 * Run one scenario in a child and time its EXIT. The child arms a 10-minute timer,
 * so a surviving one cannot drain inside any plausible budget.
 * @param {string} mode
 * @param {number} budgetMs
 */
function exitTime(mode, budgetMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [PROBE, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), budgetMs);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ ms: Date.now() - started, code, signal, out, err });
    });
  });
}

test('⛔ a pending COMMAND rejected by close leaves no armed timer', async () => {
  const r = /** @type {any} */ (await exitTime('command'));
  // The scenario itself must have happened, or a fast exit proves nothing.
  assert.match(r.out, /SCENARIO-DONE/, `the scenario did not complete:\n${r.err}`);
  assert.equal(r.signal, null,
    `the child had to be KILLED after ${r.ms}ms — a timer survived the rejection and `
    + 'held the event loop open. That is the reported symptom.');
  assert.equal(r.code, 0, `child exited ${r.code}:\n${r.err}`);
  assert.ok(r.ms < 3000, `child took ${r.ms}ms to exit; it should drain immediately`);
});

test('⛔ a pending waitForEvent rejected by close exits promptly AND names the close', async () => {
  // The probe asserts the reason itself, so a wrong reason fails the child.
  const r = /** @type {any} */ (await exitTime('waiter'));
  assert.match(r.out, /SCENARIO-DONE/, `the scenario did not complete:\n${r.err}`);
  assert.equal(r.signal, null, `the child had to be KILLED after ${r.ms}ms — waiter timer survived`);
  assert.equal(r.code, 0, `child exited ${r.code}:\n${r.err}`);
  assert.ok(r.ms < 3000, `child took ${r.ms}ms to exit`);
});

test('⭐ CONTROL: a call that RECEIVES its reply also exits promptly', async () => {
  // ⇒ Without this, "the child exits fast" could be satisfied by a session that
  // never arms a timer at all, and both tests above would pass over a dead fixture.
  const r = /** @type {any} */ (await exitTime('reply'));
  assert.match(r.out, /SCENARIO-DONE/, `the scenario did not complete:\n${r.err}`);
  assert.equal(r.signal, null, `the happy path also leaked: killed after ${r.ms}ms`);
  assert.ok(r.ms < 3000, `child took ${r.ms}ms to exit`);
});
