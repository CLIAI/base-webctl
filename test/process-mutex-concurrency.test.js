// REAL multi-process concurrency proof for createProcessMutex — promoted from
// linkedin's test/concurrency-lock-test.js pattern (the base mutex is importable,
// so workers just `import` the factory). Spawns genuine child processes that
// contend on a port lock and asserts the critical section actually holds.
//
// Coverage: (a) mutual exclusion under N-way contention, (b) dead-pid reclaim
// (SIGKILL a holder -> next acquires), (c) no false contention (distinct ports
// proceed concurrently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKER = path.join(import.meta.dirname, 'helpers', 'mutex-worker.mjs');

function tmpLockDir() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mutex-conc-')), 'locks'); }

function spawnWorker(o) {
  const args = [WORKER, '--port', String(o.port), '--lock-base-dir', o.lockBaseDir,
    '--hold-ms', String(o.holdMs ?? 120), '--timeout', String(o.timeout ?? 8000)];
  if (o.witness) args.push('--witness', o.witness);
  if (o.maxAgeSec) args.push('--max-age-sec', String(o.maxAgeSec));
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  /** @type {any[]} */ const events = [];
  let buf = '';
  let acqResolve; const acquired = new Promise((r) => { acqResolve = r; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.ev === 'acquired') acqResolve(ev);
    }
  });
  const exited = new Promise((res) => child.on('exit', (code) => res({ code, events, pid: child.pid })));
  return { child, events, acquired, exited, pid: child.pid };
}

test('mutual exclusion: 4 contending workers serialize; none ever sees a busy critical section', async () => {
  const lockBaseDir = tmpLockDir();
  const witness = path.join(path.dirname(lockBaseDir), 'witness');
  const workers = Array.from({ length: 4 }, () => spawnWorker({ port: 9222, lockBaseDir, witness, holdMs: 80, timeout: 12000 }));
  const results = await Promise.all(workers.map((w) => w.exited));
  for (const r of results) {
    assert.equal(r.code, 0, `worker ${r.pid} exited cleanly (no timeout)`);
    const acq = r.events.find((e) => e.ev === 'acquired');
    assert.ok(acq, `worker ${r.pid} acquired the lock`);
    assert.equal(acq.sawBusy, false, `worker ${r.pid} saw an empty critical section (mutual exclusion held)`);
    assert.ok(r.events.some((e) => e.ev === 'released'), `worker ${r.pid} released`);
  }
});

test('dead-pid reclaim: SIGKILL a holder, the next worker reclaims its lock', async () => {
  const lockBaseDir = tmpLockDir();
  const a = spawnWorker({ port: 9300, lockBaseDir, holdMs: 60000, timeout: 5000 }); // holds "forever"
  try {
    await a.acquired;                 // A owns the lock
    a.child.kill('SIGKILL');          // dies WITHOUT releasing (orphaned dir, dead pid)
    await new Promise((r) => a.child.on('exit', r));
    const b = spawnWorker({ port: 9300, lockBaseDir, holdMs: 30, timeout: 5000 });
    const rb = await b.exited;
    assert.equal(rb.code, 0, 'B exited cleanly');
    assert.ok(rb.events.some((e) => e.ev === 'acquired'), 'B reclaimed the dead holder\'s lock');
    assert.ok(!rb.events.some((e) => e.ev === 'timeout'), 'B did not time out');
  } finally {
    try { a.child.kill('SIGKILL'); } catch (_) { /* already dead */ }
  }
});

test('no false contention: distinct ports proceed concurrently', async () => {
  const lockBaseDir = tmpLockDir();
  const a = spawnWorker({ port: 9401, lockBaseDir, holdMs: 300, timeout: 2000 });
  const b = spawnWorker({ port: 9402, lockBaseDir, holdMs: 300, timeout: 2000 });
  const [ea, eb] = await Promise.all([a.acquired, b.acquired]);
  // both acquired (neither blocked the other) and roughly concurrently
  assert.ok(ea && eb, 'both distinct-port workers acquired');
  assert.ok(Math.abs(ea.t - eb.t) < 1500, 'acquired ~concurrently (no cross-port serialization)');
  const [ra, rb] = await Promise.all([a.exited, b.exited]);
  assert.equal(ra.code, 0); assert.equal(rb.code, 0);
});
