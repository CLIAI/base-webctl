#!/usr/bin/env node
// test/helpers/mutex-worker.mjs — a child-process worker that exercises the REAL
// createProcessMutex factory under genuine multi-process contention (the base
// analogue of linkedin's test/lock-helper.js, simplified because base's mutex is
// a clean importable module — no source-slicing needed).
//
// It acquires the port lock, optionally checks/updates a shared WITNESS counter
// (which must always be 0 at entry if mutual exclusion holds), holds for
// --hold-ms, then releases. Emits one JSON line per lifecycle event so the parent
// synchronises without sleeps:
//   {"pid":P,"t":MS,"ev":"acquired","port":N,"sawBusy":false,"lockPath":"..."}
//   {"pid":P,"t":MS,"ev":"released","port":N}
//   {"pid":P,"t":MS,"ev":"timeout","port":N}     (exit 7)
//
// Usage: node mutex-worker.mjs --port N --lock-base-dir D [--hold-ms M]
//        [--timeout T] [--witness FILE] [--max-age-sec A]
import { createProcessMutex } from '../../lib/process-mutex.js';
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port'));
const holdMs = Number(arg('hold-ms', '150'));
const timeout = Number(arg('timeout', '5000'));
const lockBaseDir = arg('lock-base-dir');
const witness = arg('witness', null);
const staleAgeSec = Number(arg('max-age-sec', '0'));

const C = {
  PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-', IMAGE_CHROMIUM_REPO: 'demo-webctl/chromium',
  IMAGE_XPRA: 'demo-webctl/xpra-ubuntu:latest', DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
  ZOOM_DEFAULT_HOST: 'www.demo.example', CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc',
  DOTENV_FILENAME: '.env.demo-webctl', DOTENV_TEMPLATE: '.env.demo-webctl.example',
  ENV_PREFIX: 'CLIAI_DEMO_WEBCTL_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
};

const emit = (o) => process.stdout.write(JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\n');
const m = createProcessMutex(C, { lockBaseDir, staleAgeSec, retryMs: 20, signalCleanup: true });

try {
  const h = await m.acquireLock(port, timeout);
  let sawBusy = false;
  if (witness) {
    // Only the lock holder runs this, so the read-modify-write is serialized BY
    // the lock — if mutual exclusion holds, the counter is always 0 at entry.
    let n = 0;
    try { n = Number(fs.readFileSync(witness, 'utf8').trim() || '0'); } catch (_) { n = 0; }
    if (n !== 0) sawBusy = true;
    fs.writeFileSync(witness, String(n + 1));
  }
  emit({ ev: 'acquired', port, sawBusy, lockPath: h.lockPath });
  await new Promise((r) => setTimeout(r, holdMs));
  if (witness) {
    let n = 1;
    try { n = Number(fs.readFileSync(witness, 'utf8').trim() || '1'); } catch (_) { n = 1; }
    fs.writeFileSync(witness, String(Math.max(0, n - 1)));
  }
  m.releaseLock(h);
  emit({ ev: 'released', port });
  process.exit(0);
} catch (/** @type {any} */ e) {
  if (e && e.code === 'LOCK_TIMEOUT') { emit({ ev: 'timeout', port }); process.exit(7); }
  emit({ ev: 'error', msg: String(e && e.message) });
  process.exit(1);
}
