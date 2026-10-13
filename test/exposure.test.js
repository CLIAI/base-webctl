// exposure.test.js — A10: what a RUNNING pair exposes, read with `docker inspect`
// and `stat` only (gvlx §9 Phase 0). Unknown is never reported as safe.
//
// ⛔ The arm that matters most: a pair with NO publish but an in-container 0.0.0.0
// listener without auth is LOCAL-USERS — the bridge address reaches it (gvlx §1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { judgeExposure, formatExposureLine } from '../lib/browser-location/owner-channels.js';
import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import { guardedDocker, assertHermetic, INSPECT_ABSENT } from './helpers/fake-docker-inspect.mjs';
import { TEST_CACHE_ROOT } from './helpers/test-cache-root.mjs';

/** A sealed scratch root with an owner-only channel dir and a profile dir in it. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-exp-'));
  const chan = path.join(root, 'run', 'k');
  const prof = path.join(root, 'prof');
  fs.mkdirSync(chan, { recursive: true, mode: 0o700 });
  fs.mkdirSync(prof, { recursive: true, mode: 0o700 });
  return { root, chan, prof, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * One container as `docker inspect` shows it (the fields exposure reads).
 * @param {{env?: Record<string,string>, binds?: Array<[string,string]>, ports?: Array<[string,number]>,
 *   labels?: Record<string,string>, running?: boolean}} o
 */
function ctr(o) {
  return {
    Config: { Env: Object.entries(o.env || {}).map(([k, v]) => `${k}=${v}`), Labels: o.labels || {} },
    State: { Running: o.running !== false },
    HostConfig: { PortBindings: Object.fromEntries((o.ports || []).map(([ip, p]) => [`${p}/tcp`, [{ HostIp: ip, HostPort: String(p) }]])) },
    Mounts: (o.binds || []).map(([src, dst]) => ({ Type: 'bind', Source: src, Destination: dst })),
  };
}

/** @param {string} chan @param {string} prof */
const ownerOnlyPair = (chan, prof) => ({
  xpra: ctr({ env: { XPRA_BIND: '/run/webctl/xpra.sock,auth=peercred',
    XPRA_TCP_BIND: '127.0.0.1:45999,auth=file,filename=/run/webctl-secret/xpra.pass' },
  binds: [[chan, '/run/webctl']], labels: { 'demo-webctl.channels': 'owner-only' } }),
  chromium: ctr({ env: { DISPLAY: ':99' }, binds: [[prof, '/home/user/.config/chromium']] }),
  relay: ctr({ binds: [[chan, '/run/webctl']] }),
});

test('A10 control: a fake OWNER-ONLY pair reads owner-only, sealed by its own dirs', () => {
  const s = scratch();
  try {
    const e = judgeExposure(ownerOnlyPair(s.chan, s.prof));
    assert.equal(e.level, 'owner-only', e.reasons.join('; '));
    assert.deepEqual(e.reasons, []);
    assert.equal(e.sealedBy.channelDir, fs.realpathSync(s.chan));
  } finally { s.done(); }
});

test('A10 ⛔: NO publish, but xpra TCP on 0.0.0.0 without auth ⇒ LOCAL-USERS (the bridge address)', () => {
  const s = scratch();
  try {
    const p = ownerOnlyPair(s.chan, s.prof);
    p.xpra = ctr({ env: { XPRA_TCP_BIND: '0.0.0.0:14327' } }); // today's shape, publish removed
    const e = judgeExposure(p);
    assert.equal(e.level, 'local-users');
    assert.ok(e.reasons.some((r) => /xpra.*0\.0\.0\.0.*no auth.*bridge/.test(r)), e.reasons.join('; '));
  } finally { s.done(); }
});

test('A10: XPRA_TCP_BIND ABSENT ⇒ the entrypoint\'s 0.0.0.0:14500 default, no auth ⇒ local-users', () => {
  const s = scratch();
  try {
    const p = ownerOnlyPair(s.chan, s.prof);
    p.xpra = ctr({ env: {} });
    const e = judgeExposure(p);
    assert.equal(e.level, 'local-users');
    assert.ok(e.reasons.some((r) => /entrypoint default/.test(r)));
  } finally { s.done(); }
});

test('A10: LWC_CDP_PORT set on chromium ⇒ an unauthenticated 0.0.0.0 CDP relay ⇒ local-users', () => {
  const s = scratch();
  try {
    const p = ownerOnlyPair(s.chan, s.prof);
    p.chromium = ctr({ env: { LWC_CDP_PORT: '4327' }, binds: [[s.prof, '/home/user/.config/chromium']] });
    assert.ok(judgeExposure(p).reasons.some((r) => /cdp.*LWC_CDP_PORT/.test(r)));
  } finally { s.done(); }
});

test('A10: a publish on a non-loopback HostIp (docker\'s "" is the wildcard) ⇒ local-users', () => {
  const s = scratch();
  try {
    for (const ip of ['0.0.0.0', '']) {
      const p = ownerOnlyPair(s.chan, s.prof);
      p.xpra.HostConfig.PortBindings = { '45999/tcp': [{ HostIp: ip, HostPort: '45999' }] };
      assert.ok(judgeExposure(p).reasons.some((r) => /not a loopback/.test(r)), JSON.stringify(ip));
    }
  } finally { s.done(); }
});

test('A10: an UNSEALED profile or channel dir ⇒ local-users, naming the dir — reported, never chmodded', () => {
  const s = scratch();
  try {
    fs.chmodSync(s.root, 0o755);
    fs.chmodSync(s.prof, 0o755);
    const e = judgeExposure(ownerOnlyPair(s.chan, s.prof));
    assert.ok(e.reasons.some((r) => /profile dir/.test(r) && r.includes(s.prof)), e.reasons.join('; '));
    assert.equal(fs.statSync(s.prof).mode & 0o777, 0o755);
    fs.chmodSync(s.chan, 0o755);
    fs.chmodSync(path.dirname(s.chan), 0o755);
    assert.ok(judgeExposure(ownerOnlyPair(s.chan, s.prof)).reasons.some((r) => /channel dir/.test(r)));
  } finally { s.done(); }
});

test('A10: nothing running ⇒ not-running; an inspect that FAILED ⇒ unknown, never safe', () => {
  assert.equal(judgeExposure({ xpra: null, chromium: null, relay: null }).level, 'not-running');
  const s = scratch();
  try {
    const p = ownerOnlyPair(s.chan, s.prof);
    const e = judgeExposure({ ...p, xpra: { failed: 'docker inspect exited 1: permission denied' } });
    assert.equal(e.level, 'unknown');
    assert.match(formatExposureLine(e), /UNKNOWN/);
  } finally { s.done(); }
});

test('formatExposureLine: the doctor / gui status line, loud when exposed', () => {
  assert.match(formatExposureLine({ level: 'owner-only', reasons: [] }), /^exposure\s+owner-only/);
  const bad = formatExposureLine({ level: 'local-users', reasons: ['xpra: tcp 0.0.0.0:1, no auth'] });
  assert.match(bad, /^exposure\s+LOCAL-USERS/);
  assert.match(bad, /restart.*owner|owner.*restart/i);
  assert.match(formatExposureLine({ level: 'not-running', reasons: [] }), /not-running/);
});

// ── driver.exposure(): read-only, through the injected docker ──────────────

function fakeC() {
  return {
    PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
    IMAGE_CHROMIUM_REPO: 'demo/chromium', IMAGE_XPRA: 'demo/xpra:latest',
    DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'demo.example', CONFIG_FILE_PROJECT: 'demo.config.jsonc',
    DOTENV_FILENAME: '.env.demo', DOTENV_TEMPLATE: '.env.demo.example',
    ENV_PREFIX: 'DEMO_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
  };
}

test('driver.exposure(): reads ONLY `docker inspect` — a legacy pair reads local-users', async () => {
  const s = scratch();
  try {
    const C = fakeC();
    const m = createMounts(C, { dockerfilesDir: '/df' });
    const mounts = { ...m, profilePathFor: () => s.prof, resolveChromiumProfile: () => s.prof, cacheRoot: () => TEST_CACHE_ROOT };
    /** @type {string[]} */
    const verbs = [];
    const legacy = {
      xpra: ctr({ env: { XPRA_TCP_BIND: '0.0.0.0:14999' }, ports: [['127.0.0.1', 4999], ['127.0.0.1', 14999]] }),
      chromium: ctr({ env: { LWC_CDP_PORT: '4999' }, binds: [[s.prof, '/home/user/.config/chromium']] }),
    };
    const { docker, violations } = guardedDocker({}, { run: {
      inspect: (/** @type {string[]} */ a) => {
        verbs.push(a.join(' '));
        const n = a[a.length - 1];
        const c = /-xpra-/.test(n) ? legacy.xpra : /-chromium-/.test(n) ? legacy.chromium : null;
        return c ? { code: 0, stderr: '', stdout: JSON.stringify([{ Name: `/${n}`, ...c }]) } : INSPECT_ABSENT;
      },
    } });
    const d = createChromiumDockerXpra(C, { mounts, docker, uid: 4242, stateRoot: path.join(s.root, 'state') })
      .createDriver({ port: 4999, host: '127.0.0.1', slug: 'e' });
    const e = await d.exposure();
    assertHermetic(violations);
    assert.equal(e.level, 'local-users');
    assert.ok(verbs.length >= 2 && verbs.every((v) => v.startsWith('inspect ')), 'inspect only');
  } finally { s.done(); }
});
