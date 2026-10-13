// isolation-machine-names.test.js — ib4k §3b "Machine names": the DATA goes in, not the tool, on every backend.
//
// The pure arms judge the host side (which xq is run, what its output yields, what reaches docker's argv). The real
// arm runs `isolated` under the docker backend on this host's daemon and reads back what the command sees.
// ⛔ No arm prints a machine name: the real one compares DIGESTS of the names, never the names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as harness from '../scripts/contract-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');
const { machineNamesFromXq, hostMachineNames, dockerCreateArgv, MACHINE_NAMES_ENV, MACHINE_NAMES_PATH } = harness;

const xqJson = (/** @type {any} */ machines, schema = 1) => JSON.stringify({ schema, path: '/x', present: true, machines });

test('machineNamesFromXq: alias + the HOST of each ssh target (user@ and :port removed), deduplicated', () => {
  const r = machineNamesFromXq(xqJson([
    { alias: 'box-a', ssh: 'someone@box-a.example:2222', shadows_local_zone: false },
    { alias: 'box-b', ssh: 'box-b' },
    { alias: 'box-c', ssh: '[2001:db8::1]:22' },
    { alias: 'bad\nname', ssh: 'ok-host' },
  ]));
  assert.equal(r.why, '');
  assert.deepEqual(r.names, ['box-a', 'box-a.example', 'box-b', 'box-c', '2001:db8::1', 'ok-host']);
});

test('⛔ machineNamesFromXq: an unknown schema, no JSON, or no machines list passes NOTHING — and the reason names no machine', () => {
  for (const [out, re] of /** @type {Array<[string, RegExp]>} */ ([
    [xqJson([{ alias: 'secret-box' }], 2), /schema 2, not 1 — refused, never guessed/],
    [JSON.stringify({ machines: [{ alias: 'secret-box' }] }), /schema null/],
    ['not json secret-box', /printed no JSON/],
    [JSON.stringify({ schema: 1, machines: 'secret-box' }), /no machines list/],
  ])) {
    const r = machineNamesFromXq(out);
    assert.equal(r.names, null, out);
    assert.match(r.why, re);
    assert.ok(!r.why.includes('secret-box'), `the reason printed a name: ${r.why}`);
  }
  // CONTROL: an xq with NO machines passes an empty list (the consumer's check then refuses "no names")
  assert.deepEqual(machineNamesFromXq(xqJson([])), { names: [], why: '' });
});

/** A fake `xq` in a fresh dir; `mode` its dir's mode. @param {number} mode */
function fakeXq(mode) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-fxq-')));
  fs.writeFileSync(path.join(dir, 'xq'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(dir, mode);
  return { dir, done: () => { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); } };
}
/** Run `f` with PATH = `dirs` only. @template T @param {string[]} dirs @param {() => T} f @returns {T} */
function withPath(dirs, f) {
  const old = process.env.PATH;
  process.env.PATH = dirs.join(':');
  try { return f(); } finally { process.env.PATH = old; }
}

test('⛔ hostMachineNames: an xq in a WRITABLE place is NEVER RUN on the host (it would be an escape) — CONTROL: a trusted one is', () => {
  const x = fakeXq(0o555);
  try {
    /** @type {string[]} */ const ran = [];
    const run = (/** @type {string} */ bin) => { ran.push(bin); return { status: 0, stdout: xqJson([{ alias: 'box-a' }]) }; };
    // the dir is listed writable (the cwd, a --keep, TMPDIR …): ignored, not run
    const planted = withPath([x.dir], () => hostMachineNames({ home: '/nonexistent-home', writable: [x.dir], outer: false, run }));
    assert.deepEqual(ran, [], 'a planted xq was RUN on the host');
    assert.equal(planted.names, null);
    assert.match(planted.why, /^xq ignored: found in a writable location$/);
    // CONTROL: the same xq, in a dir nobody listed and the caller cannot write — run, and its names passed
    const ok = withPath([x.dir], () => hostMachineNames({ home: '/nonexistent-home', writable: [], outer: false, run }));
    assert.deepEqual(ran, [path.join(x.dir, 'xq')]);
    assert.deepEqual(ok, { names: ['box-a'], why: '' });
  } finally { x.done(); }
});

test('hostMachineNames: no xq, a failing xq, and an outer call that passed none — each NAMED, nothing passed', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-noxq-'));
  const x = fakeXq(0o555);
  try {
    assert.deepEqual(withPath([empty], () => hostMachineNames({ home: '/h', writable: [], outer: false, run: () => { throw new Error('ran'); } })),
      { names: null, why: 'xq is not installed on the host' });
    const failed = withPath([x.dir], () => hostMachineNames({ home: '/h', writable: [], outer: false, run: () => ({ status: 3, stdout: '' }) }));
    assert.deepEqual(failed, { names: null, why: '`xq machine ls --json` failed (exit 3)' });
    if (!fs.existsSync(MACHINE_NAMES_PATH)) {
      assert.deepEqual(hostMachineNames({ home: '/h', writable: [], outer: true }), { names: null, why: 'the outer call passed none' });
    }
  } finally { x.done(); fs.rmSync(empty, { recursive: true, force: true }); }
});

test('⛔ docker argv: the names file is a READ-ONLY mount at the fixed path when names are passed — never a name, never -e', () => {
  const base = { name: 'webctl-iso-u1-x-1', uid: 1, gid: 1, limits: [], binds: [], masks: [], channel: '/c', image: 'img', inner: ['x'] };
  const on = dockerCreateArgv({ ...base, machineNames: true });
  const i = on.indexOf(`type=bind,src=/c/machine-names,dst=${MACHINE_NAMES_PATH},readonly`);
  assert.ok(i > 0 && on[i - 1] === '--mount', on.join(' '));
  assert.ok(!on.includes('-e') && !on.some((a) => a.startsWith('--env')), 'an env flag in the argv');
  // CONTROL: no names → no mount
  assert.ok(!dockerCreateArgv(base).some((a) => a.includes('machine-names')));
});

// ── the real docker backend ────────────────────────────────────────────────

const DOCKER = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'].map((d) => path.join(d, 'docker')).find((p) => fs.existsSync(p)) || '';
function unavailable() {
  if (!DOCKER) return 'SKIP (host): no docker CLI in the system dirs';
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) return 'SKIP (host): DOCKER_HOST/DOCKER_CONTEXT set';
  if (spawnSync(DOCKER, ['-H', 'unix:///var/run/docker.sock', 'version', '--format', '{{.Server.Version}}'], { timeout: 30_000 }).status !== 0) {
    return 'SKIP (host): the local docker daemon does not answer';
  }
  if (spawnSync(process.execPath, [TOOL, 'isolated-image'], { encoding: 'utf8' }).status !== 0) return 'SKIP (host): the docker backend\'s image is not built';
  return '';
}
const SKIP = unavailable();

/** sha256 of the names, one per line, as the file holds them. @param {string[]} names */
const digestOf = (names) => crypto.createHash('sha256').update(names.map((n) => `${n}\n`).join('')).digest('hex');

test('[docker] the command sees EXACTLY the host xq\'s names, read-only, at the fixed path — fresh AND nested; the verdict names none', SKIP ? { skip: SKIP } : { timeout: 120_000 }, async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-mn-')));
  try {
    // what the HOST's xq says right now (the harness asks the same one); a digest, never the names
    const xq = spawnSync('xq', ['machine', 'ls', '--json'], { encoding: 'utf8', timeout: 20_000 });
    const want = xq.status === 0 ? machineNamesFromXq(xq.stdout) : { names: null, why: '' };
    const probe = 'f="${WEBCTL_MACHINE_NAMES_FILE-}"; echo "VAR=${f:-UNSET}"; '
      + 'if [ -n "$f" ]; then echo "SHA=$(sha256sum < "$f" | cut -d" " -f1)"; '
      + '(echo x >> "$f") 2>/dev/null && echo WRITABLE || echo READONLY; fi';
    const script = `${probe}; echo NESTED; node "$1" isolated -- sh -c '${probe.replace(/'/g, "'\\''")}'`;
    const env = { ...process.env, WEBCTL_ISOLATION_BACKEND: 'docker', [MACHINE_NAMES_ENV]: '/etc/passwd' };
    for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'WEBCTL_HOST_NETNS', 'WEBCTL_HOST_MNTNS', 'WEBCTL_HOST_PIDNS']) delete env[k];
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [TOOL, 'isolated', '--', 'sh', '-c', script, 'arm', TOOL], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => resolve({ code, out, err }));
    });
    const { code, out, err } = /** @type {any} */ (r);
    assert.equal(code, 0, `${out}${err}`);
    const [fresh, nested] = out.split('NESTED\n');
    if (want.names) {
      assert.match(err, /; machine-names: passed/, err);
      for (const [where, o] of [['fresh', fresh], ['nested', nested]]) {
        assert.match(o, new RegExp(`^VAR=${MACHINE_NAMES_PATH.replace(/\./g, '\\.')}$`, 'm'), `${where}: ${o}`);
        assert.match(o, new RegExp(`^SHA=${digestOf(want.names)}$`, 'm'), `${where}: the names differ from the host xq's`);
        assert.match(o, /^READONLY$/m, `${where}: the names file is writable`);
      }
      for (const n of want.names) assert.ok(!err.includes(n) && !out.includes(n), 'a machine name reached the output');
    } else {
      // no trusted xq here: nothing passed, said by reason — and the CALLER's value (/etc/passwd) never got through
      assert.match(err, /; machine-names: none \(/, err);
      for (const o of [fresh, nested]) assert.match(o, /^VAR=UNSET$/m, o);
    }
    assert.ok(!out.includes('VAR=/etc/passwd'), 'the caller\'s own WEBCTL_MACHINE_NAMES_FILE reached the command');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
