// no-real-display.test.js — RULE ZERO's arms (AGENTS.md: nothing a test or agent starts may draw on a real display).
//
// ⛔ Measured 2026-10-13: a test ran the host's `xpra info` against an auth-protected server with no password file;
// the inherited DISPLAY let xpra's GTK client open its password dialog on a person's live desktop, over and over.
// These arms prove the three layers that stop it, each with a control that shows the arm can fail:
//   1. the strict runner scrubs DISPLAY/WAYLAND_DISPLAY/XAUTHORITY for every test file;
//   2. the test helper scrubs them on import and REFUSES any xpra spawn while one is set;
//   3. the product's `xpra info` presence probe never hands xpra a display.
// ⚠ Nothing here can draw: the only "xpra" ever run is a FAKE script that records its env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { xpraSpawnGuard, guiSpawnGuard, guardedSpawnSync, displayless, DISPLAY_VARS } from './helpers/no-real-display.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'test', 'helpers', 'no-real-display.mjs');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests-strict.mjs');
const PRESENCE = path.join(ROOT, 'lib', 'xpra-presence.js');
// a FAKE display name: nothing listens there, and nothing here connects to it
const FAKE = { DISPLAY: ':98765', WAYLAND_DISPLAY: 'wayland-arm-none', XAUTHORITY: '/nonexistent/arm-xauthority' };

/** @param {Record<string, string>} extra */
function envWith(extra) {
  const e = { ...process.env, ...extra };
  delete e.NODE_TEST_CONTEXT;
  return e;
}

test('⛔ the guard REFUSES xpra with a display set: the host binary, `docker run --entrypoint xpra`, a shell that calls it', () => {
  for (const argv of [['xpra', 'info', 'tcp://127.0.0.1:1/'], ['/usr/bin/xpra', 'attach'],
    ['docker', 'run', '--rm', '--entrypoint', 'xpra', 'img', 'info', 'socket:///s'],
    ['docker', 'run', '--rm', '--entrypoint', 'sh', 'img', '-c', 'timeout 20 xpra info socket:///s </dev/null']]) {
    for (const k of DISPLAY_VARS) {
      assert.throws(() => xpraSpawnGuard(argv, { [k]: FAKE[/** @type {keyof typeof FAKE} */ (k)] }), /RULE ZERO: refusing to spawn/, `${k}: ${argv.join(' ')}`);
    }
    // CONTROL: the same argv with no display is allowed
    assert.doesNotThrow(() => xpraSpawnGuard(argv, displayless({ ...FAKE })));
  }
  // CONTROL: a spawn that runs no xpra is not refused, display or not
  assert.doesNotThrow(() => xpraSpawnGuard(['docker', 'ps', '-q'], FAKE));
  assert.doesNotThrow(() => xpraSpawnGuard(['sh', '-c', 'echo xpra-like-word'], FAKE));
});

test('⛔ importing the helper SCRUBS every display var from process.env — CONTROL: without the import they stay', () => {
  const probe = 'process.stdout.write(JSON.stringify([process.env.DISPLAY, process.env.WAYLAND_DISPLAY, process.env.XAUTHORITY]))';
  const withImport = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(HELPER).href)}); ${probe}`],
    { env: envWith(FAKE), encoding: 'utf8' });
  assert.equal(withImport.status, 0, withImport.stderr);
  assert.deepEqual(JSON.parse(withImport.stdout), [null, null, null]);
  const without = spawnSync(process.execPath, ['-e', probe], { env: envWith(FAKE), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(without.stdout), [FAKE.DISPLAY, FAKE.WAYLAND_DISPLAY, FAKE.XAUTHORITY], 'CONTROL: the vars did not reach the child');
});

test('⛔ the strict runner scrubs the display vars for every test file — CONTROL: plain `node --test` passes them through', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-zero-'));
  try {
    const fixture = path.join(dir, 'display-free.test.js');
    fs.writeFileSync(fixture, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
      + "test('no display reaches a test', () => { for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) assert.equal(process.env[k], undefined, k); });\n");
    const strict = spawnSync(process.execPath, [RUNNER, fixture], { env: envWith(FAKE), encoding: 'utf8', cwd: dir });
    assert.equal(strict.status, 0, `${strict.stdout}${strict.stderr}`);
    const plain = spawnSync(process.execPath, ['--test', fixture], { env: envWith(FAKE), encoding: 'utf8', cwd: dir });
    assert.notEqual(plain.status, 0, 'CONTROL: the display vars did not reach a plain run, so the arm proves nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ product: the `xpra info` presence probe never hands xpra a display — CONTROL: the fake xpra ran and saw the rest of the env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-zero-xpra-'));
  try {
    const seen = path.join(dir, 'seen.json');
    fs.writeFileSync(path.join(dir, 'xpra'), `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(${JSON.stringify(seen)}, `
      + `JSON.stringify({display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY, xauth: process.env.XAUTHORITY, marker: process.env.ARM_MARKER}))'\n`
      + 'echo clients=0\n', { mode: 0o755 });
    // the socket target sits in this arm's own 0700 dir: an unsafe path is refused before xpra runs at all (review F4)
    for (const target of [12345, { port: 12345 }, { socketPath: path.join(dir, 'arm.sock') }]) {
      fs.rmSync(seen, { force: true });
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(pathToFileURL(PRESENCE).href)}); process.stdout.write(String(m.isXpraClientAttached(${JSON.stringify(target)}, { timeoutMs: 5000 })))`],
      { env: envWith({ ...FAKE, PATH: dir, ARM_MARKER: 'reached' }), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(fs.readFileSync(seen, 'utf8'));
      assert.equal(got.marker, 'reached', 'CONTROL: the fake xpra did not get the caller\'s env at all');
      assert.deepEqual([got.display, got.wayland, got.xauth], [undefined, undefined, undefined], `${JSON.stringify(target)}: xpra got a display`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⛔ review F12: the guard covers EVERY program that can draw — chromium, a browser, xdg-open — not only xpra; CONTROL: without a display they pass', () => {
  for (const argv of [['chromium', '--headless=new'], ['/usr/bin/google-chrome'], ['xdg-open', 'http://127.0.0.1:1/'], ['firefox'],
    ['docker', 'run', '--rm', '--entrypoint', 'chromium', 'img'], ['sh', '-c', 'xdg-open http://x/ &']]) {
    assert.throws(() => guiSpawnGuard(argv, { DISPLAY: FAKE.DISPLAY }), /RULE ZERO/, argv.join(' '));
    assert.doesNotThrow(() => guiSpawnGuard(argv, {}), `CONTROL: ${argv.join(' ')}`);
  }
});

test('⛔ review F12: guardedSpawnSync judges the env the child REALLY gets — a display in it is refused and NOTHING runs (the old helper scrubbed first, so its guard could never fail)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-zero-g-'));
  try {
    const marker = path.join(dir, 'RAN');
    const bin = path.join(dir, 'xpra');
    fs.writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    assert.throws(() => guardedSpawnSync(bin, ['info'], { env: { PATH: `${dir}:/usr/bin:/bin`, DISPLAY: FAKE.DISPLAY } }), /RULE ZERO/);
    assert.equal(fs.existsSync(marker), false, 'the program ran with a display in its env');
    // CONTROL: the same spawn without a display runs
    guardedSpawnSync(bin, ['info'], { env: { PATH: `${dir}:/usr/bin:/bin` } });
    assert.equal(fs.existsSync(marker), true, 'CONTROL: the guarded spawn did not run at all');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
