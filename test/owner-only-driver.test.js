// owner-only-driver.test.js — `channels: 'owner-only'` in the docker-xpra driver
// (gvlx §5.2, §6.1, §8, §9): arms A1–A4, A9, A11, A15, the reuse rules, shutdown, and
// inspect()'s endpoint (6gi0 §2).
//
// The fake docker is STATEFUL and HERMETIC (guardedDocker). Its runDetached creates the
// sockets a real pair would — an xpra socket and, behind the "relay", a fake CDP — in
// this test's own temp state root. Nothing here touches a real container or a port the
// test did not open itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import { channelPaths } from '../lib/browser-location/owner-channels.js';
import { getVersion } from '../lib/cdp-client.js';
import { guardedDocker, assertHermetic, INSPECT_ABSENT, inspectPresent } from './helpers/fake-docker-inspect.mjs';
import { startFakeCdp } from './helpers/fake-unix-cdp.mjs';
import { TEST_CACHE_ROOT } from './helpers/test-cache-root.mjs';

const ME = String(process.getuid ? process.getuid() : 1000);
const TEST_CDP_PORT = Number(process.env.WEBCTL_TEST_CDP_PORT || 45327);

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
/** @param {any} C */
function hermeticMounts(C) {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  const fake = (/** @type {string} */ s, /** @type {string} */ u) => u || `/tmp/no-mkdir/${s}`;
  return { ...m, resolveChromiumProfile: (/** @type {string} */ s, /** @type {string} */ u) => {
    const p = fake(s, u); fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return p;
  }, profilePathFor: fake, cacheRoot: () => TEST_CACHE_ROOT };
}

/**
 * @param {{
 *   imageLabels?: Record<string,string>,
 *   preRunning?: Array<{name: string, labels: Record<string,string>, binds: string[], cdpTcpPort?: number}>,
 *   noXpraSocket?: boolean,
 * }} [o]
 */
function harness(o = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-oo-'));
  const stateRoot = path.join(root, 'state');
  const udd = path.join(root, 'prof', 'chromium');
  /** @type {Map<string, {args: any, up: boolean}>} */
  const running = new Map();
  /** @type {any[]} */ const calls = [];
  /** @type {string[]} */ const stops = [];
  /** @type {string[]} */ const removed = [];
  /** @type {Array<() => Promise<any>>} */ const closers = [];
  for (const p of o.preRunning || []) {
    running.set(p.name, { up: true, args: { name: p.name, labels: p.labels,
      mounts: p.binds.map((b) => [b, '/x', 'rw']) } });
  }
  const C = fakeC();
  const CH = channelPaths({ stateRoot, profilePath: udd });

  const { docker, violations } = guardedDocker({
    dockerAvailable: async () => true,
    imageExists: async () => true,
    containerExists: async (/** @type {string} */ n) => running.has(n),
    containerRunning: async (/** @type {string} */ n) => !!(running.get(n) && running.get(n)?.up),
    rm: async (/** @type {string} */ n) => { if (running.delete(n)) removed.push(n); return { code: 0 }; },
    stop: async (/** @type {string} */ n) => { stops.push(n); const r = running.get(n); if (r) r.up = false; return { code: 0 }; },
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    runDetached: async (/** @type {any} */ a) => {
      calls.push(a);
      running.set(a.name, { args: a, up: true });
      if (/-xpra-/.test(a.name) && a.env && a.env.XPRA_BIND && !o.noXpraSocket) {
        const srv = net.createServer((s) => s.end());
        await new Promise((r) => srv.listen(CH.xpraSock, () => r(undefined)));
        closers.push(() => new Promise((r) => srv.close(() => r(undefined))));
      }
      if (/-cdprelay-/.test(a.name)) {
        const f = await startFakeCdp({ hostHeader: '127.0.0.1:9222', socketPath: CH.cdpSock });
        closers.push(() => f.close());
      }
      return { code: 0, stderr: '' };
    },
  }, { run: {
    inspect: (/** @type {string[]} */ args) => {
      const name = args[args.length - 1];
      const r = running.get(name);
      if (!r) return INSPECT_ABSENT;
      const binds = (r.args.mounts || []).map((/** @type {any[]} */ m) => m[0]).filter((/** @type {string} */ s) => s.startsWith('/'));
      return inspectPresent(name, { labels: r.args.labels || {}, binds });
    },
    logs: () => ({ code: 0, stdout: 'logs', stderr: '' }),
    image: () => ({ code: 0, stdout: JSON.stringify(o.imageLabels || {}) + '\n', stderr: '' }),
  } });

  /** @type {string[]} */
  const logs = [];
  const logger = { info: (/** @type {string} */ m) => logs.push(m), warn: (/** @type {string} */ m) => logs.push(`WARN ${m}`), debug: (/** @type {string} */ m) => logs.push(m) };
  /** @param {any} [cfg] @param {any} [dopts] */
  const driver = (cfg = {}, dopts = {}) => createChromiumDockerXpra(C, {
    mounts: hermeticMounts(C), docker, stateRoot, uid: ME, ...dopts,
  }).createDriver({ port: TEST_CDP_PORT, host: '127.0.0.1', slug: 'oo', userDataDir: udd, logger, ...cfg });
  return {
    root, stateRoot, udd, CH, calls, stops, removed, running, logs, violations, driver,
    byRole: (/** @type {string} */ re) => calls.find((c) => new RegExp(re).test(c.name)),
    done: async () => {
      for (const c of closers) await c();
      assertHermetic(violations);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const OO = { channels: 'owner-only' };

// ── A1 / A2 / A3 / A4 — what a bring-up passes to docker ────────────────────

test('A1: owner-only publishes NOTHING (html5 off by default)', async () => {
  const h = harness();
  try {
    await h.driver(OO).ensureRunning();
    for (const c of h.calls) assert.deepEqual(c.publish || [], [], `${c.name} must publish nothing`);
  } finally { await h.done(); }
});

test('A1 control: html5 on ⇒ exactly ONE publish, 127.0.0.1:<xpraTcpPort>', async () => {
  const h = harness();
  try {
    const d = h.driver({ ...OO, html5: true });
    await d.ensureRunning();
    const pubs = h.calls.flatMap((c) => c.publish || []);
    assert.deepEqual(pubs, [['127.0.0.1', String(d.inspect().xpraTcpPort), d.inspect().xpraTcpPort]]);
  } finally { await h.done(); }
});

test('A2: xpra binds — peercred socket; TCP auth=file (comma form) on the netns loopback', async () => {
  const h = harness();
  try {
    await h.driver(OO).ensureRunning();
    const env = h.byRole('-xpra-').env;
    assert.equal(env.XPRA_BIND, '/run/webctl/xpra.sock,auth=peercred');
    assert.match(env.XPRA_TCP_BIND, /^127\.0\.0\.1:\d+,auth=file,filename=\/run\/webctl-secret\/xpra\.pass$/);
    assert.doesNotMatch(env.XPRA_TCP_BIND, /auth=file:/);
  } finally { await h.done(); }
});

test('A2: html5 on ⇒ the TCP bind is the wildcard docker can publish — still auth=file', async () => {
  const h = harness();
  try {
    await h.driver({ ...OO, html5: true }).ensureRunning();
    assert.match(h.byRole('-xpra-').env.XPRA_TCP_BIND, /^0\.0\.0\.0:\d+,auth=file,filename=/);
  } finally { await h.done(); }
});

test('A2 control: tcp-legacy keeps 0.0.0.0 without auth — and inspect() SAYS local-users', async () => {
  const fake = await startFakeCdp({ tcp: true }); // a CDP that answers, on a port THIS test opened
  const h = harness();
  try {
    const d = h.driver({ port: fake.port, force: true });
    await d.ensureRunning();
    assert.equal(h.byRole('-xpra-').env.XPRA_TCP_BIND, `0.0.0.0:${d.inspect().xpraTcpPort}`);
    assert.equal(d.inspect().exposure.level, 'local-users');
    assert.ok(h.logs.some((l) => /^WARN .*LOCAL-USERS/.test(l)), 'a legacy bring-up WARNS that it is exposed');
  } finally { await h.done(); await fake.close(); }
});

test('A3: channel dir on xpra AND relay; the secret DIRECTORY on xpra only, read-only; chromium gets neither', async () => {
  const h = harness();
  try {
    await h.driver(OO).ensureRunning();
    const mountsOf = (/** @type {string} */ re) => h.byRole(re).mounts.map((/** @type {any[]} */ m) => m.join(':'));
    assert.ok(mountsOf('-xpra-').includes(`${h.CH.channelDir}:/run/webctl:rw`));
    assert.ok(mountsOf('-cdprelay-').includes(`${h.CH.channelDir}:/run/webctl:rw`));
    assert.ok(mountsOf('-xpra-').includes(`${h.CH.secretDir}:/run/webctl-secret:ro`));
    assert.ok(fs.statSync(h.CH.secretDir).isDirectory(), 'the mounted secret source is a DIRECTORY (gvlx §8.2)');
    for (const m of mountsOf('-chromium-')) {
      assert.ok(!m.startsWith(h.CH.channelDir) && !m.startsWith(h.CH.secretDir), `chromium must not mount ${m}`);
    }
    assert.equal(mountsOf('-cdprelay-').length, 1, 'the relay mounts the channel dir and nothing else');
  } finally { await h.done(); }
});

test('A4: no LWC_CDP_PORT; chromium gets the debug flag as args; a socat relay sidecar serves the socket', async () => {
  const h = harness();
  try {
    await h.driver(OO).ensureRunning();
    const ch = h.byRole('-chromium-');
    assert.ok(!('LWC_CDP_PORT' in ch.env), 'LWC_CDP_PORT starts the 0.0.0.0 TCP relay — it must be ABSENT');
    assert.deepEqual(ch.cmd, ['--remote-debugging-port=9222', '--remote-allow-origins=*']);
    const relay = h.byRole('-cdprelay-');
    assert.ok(relay, 'a relay sidecar is started');
    assert.deepEqual(relay.extra.slice(-2), ['--entrypoint', 'socat']);
    assert.match(relay.cmd[0], /^UNIX-LISTEN:\/run\/webctl\/cdp\.sock,fork,mode=0600,unlink-early$/);
    assert.equal(relay.cmd[1], 'TCP:127.0.0.1:9222,retry=30,interval=1');
    assert.ok(relay.extra.includes(`container:${h.byRole('-xpra-').name}`), 'it shares the pair\'s netns');
    const order = h.calls.map((c) => c.name.replace(/.*-(xpra|chromium|cdprelay)-.*/, '$1'));
    assert.deepEqual(order, ['xpra', 'chromium', 'cdprelay']);
  } finally { await h.done(); }
});

test('A4 control: tcp-legacy sets LWC_CDP_PORT and starts NO relay', async () => {
  const fake = await startFakeCdp({ tcp: true });
  const h = harness();
  try {
    await h.driver({ port: fake.port, force: true }).ensureRunning();
    assert.equal(h.byRole('-chromium-').env.LWC_CDP_PORT, String(fake.port));
    assert.equal(h.byRole('-cdprelay-'), undefined);
  } finally { await h.done(); await fake.close(); }
});

test('portless owner-only: no relay, no debug flag — and still a peercred xpra', async () => {
  const h = harness();
  try {
    const r = await h.driver({ ...OO, containerEnv: { LWC_CDP_PORT: null } }).ensureRunning();
    assert.equal(h.byRole('-cdprelay-'), undefined);
    assert.deepEqual(h.byRole('-chromium-').cmd || [], []);
    assert.equal(r.endpoint, null);
  } finally { await h.done(); }
});

// ── the endpoint (6gi0 §2) ─────────────────────────────────────────────────

test('owner-only: ensureRunning and inspect() report xq\'s unix endpoint shape; URLs are null', async () => {
  const h = harness();
  try {
    const d = h.driver(OO);
    const r = await d.ensureRunning();
    const want = { name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'unix', host: null, port: null,
      path: h.CH.cdpSock, host_header: '127.0.0.1:9222' };
    assert.deepEqual(r.endpoint, want);
    const i = d.inspect();
    assert.deepEqual(i.ports.cdp.endpoint, want);
    assert.equal(i.cdpHttpUrl, null, 'never a URL that answers nothing (t2wf)');
    assert.equal(i.cdpWsBase, null);
    assert.equal(i.channels, 'owner-only');
    assert.equal(i.exposure.level, 'owner-only');
    assert.deepEqual(i.xpra.socket, h.CH.xpraSock);
    // and base's own client speaks to it end to end
    assert.equal((await getVersion(r.endpoint)).Browser, 'Fake/1.0');
  } finally { await h.done(); }
});

test('tcp-legacy inspect(): the tcp endpoint, with nulls where it does not apply', () => {
  const h = harness();
  try {
    const i = h.driver({}).inspect();
    assert.deepEqual(i.ports.cdp.endpoint, { name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'tcp',
      host: '127.0.0.1', port: TEST_CDP_PORT, path: null, host_header: null });
    assert.equal(i.channels, 'tcp-legacy');
  } finally { void h.done(); }
});

// ── A9: the secret is never disclosed ──────────────────────────────────────

/** @param {string} secret @param {unknown[]} haystacks */
function leaks(secret, haystacks) {
  return haystacks.filter((x) => JSON.stringify(x).includes(secret));
}

test('A9: the secret\'s bytes appear in NO docker arg, log line, inspect() or result', async () => {
  const h = harness();
  try {
    const d = h.driver({ ...OO, html5: true });
    const r = await d.ensureRunning();
    const secret = fs.readFileSync(h.CH.secretFile, 'utf8');
    assert.ok(secret.length >= 40);
    assert.deepEqual(leaks(secret, [h.calls, h.logs, d.inspect(), r]), []);
  } finally { await h.done(); }
});

test('A9 self-test: the leak check DOES fire on a planted secret', () => {
  assert.equal(leaks('S3CR3T', [['a line with S3CR3T in it']]).length, 1);
});

// ── A11: the uid gates ─────────────────────────────────────────────────────

test('A11: an image built for ANOTHER uid is refused before any container starts', async () => {
  const h = harness({ imageLabels: { 'demo-webctl.image-uid': String(Number(ME) + 1) } });
  try {
    await assert.rejects(h.driver(OO).ensureRunning(), (/** @type {any} */ e) => {
      assert.equal(e.exitCode, 4);
      assert.match(e.message, /built for uid/);
      return true;
    });
    assert.deepEqual(h.calls, []);
  } finally { await h.done(); }
});

test('A11 control: an image labelled with OUR uid proceeds', async () => {
  const h = harness({ imageLabels: { 'demo-webctl.image-uid': ME } });
  try { await h.driver(OO).ensureRunning(); assert.ok(h.calls.length >= 3); } finally { await h.done(); }
});

test('A11: a socket owned by another uid is not declared up — the pair is removed, refused', async () => {
  const h = harness();
  try {
    const realLstat = fs.lstatSync;
    const lstat = (/** @type {string} */ p) => {
      const st = realLstat(p);
      return p === h.CH.cdpSock ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: Number(ME) + 1 }) : st;
    };
    await assert.rejects(h.driver(OO, { lstat }).ensureRunning(), /owned by uid/);
    for (const n of h.calls.map((c) => c.name)) assert.ok(h.removed.includes(n), `${n} must be removed`);
  } finally { await h.done(); }
});

test('A11: an xpra socket that never appears names the cause instead of timing out silently', async () => {
  const h = harness({ noXpraSocket: true });
  try {
    await assert.rejects(h.driver(OO, { socketWaitMs: 300 }).ensureRunning(), /xpra\.sock|entrypoint|XPRA_BIND/);
  } finally { await h.done(); }
});

// ── construction refusals ──────────────────────────────────────────────────

test('refused at construction: an unknown channels value; LWC_CDP_PORT with owner-only; html5:false on legacy', () => {
  const h = harness();
  try {
    assert.throws(() => h.driver({ channels: 'tcp' }), (/** @type {any} */ e) => e.exitCode === 4 && /channels/.test(e.message));
    assert.throws(() => h.driver({ ...OO, containerEnv: { LWC_CDP_PORT: '4327' } }),
      (/** @type {any} */ e) => e.exitCode === 4 && /LWC_CDP_PORT/.test(e.message));
    assert.throws(() => h.driver({ html5: false }), (/** @type {any} */ e) => e.exitCode === 4 && /html5/.test(e.message));
  } finally { void h.done(); }
});

test('A7 (driver): a socket path too long for sun_path is refused BEFORE any docker run', async () => {
  const h = harness();
  try {
    const deep = path.join(h.root, 'd'.repeat(120));
    await assert.rejects(h.driver(OO, { stateRoot: deep }).ensureRunning(), /108 bytes/);
    assert.deepEqual(h.calls, []);
  } finally { await h.done(); }
});

test('A6 (driver): a loosened channel dir is refused before any container starts — and left as found', async () => {
  const h = harness();
  try {
    fs.mkdirSync(h.CH.channelDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(h.CH.channelDir, 0o755);
    await assert.rejects(h.driver(OO).ensureRunning(), /0755/);
    assert.deepEqual(h.calls, []);
    assert.equal(fs.statSync(h.CH.channelDir).mode & 0o777, 0o755);
  } finally { await h.done(); }
});

// ── reuse rules (gvlx §9, §12) ─────────────────────────────────────────────

/** labels a pair started by this driver carries @param {string} role @param {string} [channels] */
const L = (role, channels) => ({ 'demo-webctl.role': role, 'demo-webctl.slug': 'oo', 'demo-webctl.owner.uid': ME,
  ...(channels ? { 'demo-webctl.channels': channels } : {}) });

test('a RUNNING legacy pair under an explicit owner-only cfg is REFUSED — never restarted', async () => {
  const pre = harness();
  const names = pre.driver(OO).inspect().names;
  await pre.done();
  const h = harness({ preRunning: [
    { name: names.xpraContainer, labels: L('xpra'), binds: [] },
    { name: names.chromiumContainer, labels: L('chromium'), binds: [] },
  ] });
  try {
    // the chromium must mount OUR profile to be ours: rebuild its binds with this harness's udd
    h.running.get(names.chromiumContainer).args.mounts = [[h.udd, '/x', 'rw']];
    await assert.rejects(h.driver(OO).ensureRunning(), (/** @type {any} */ e) => {
      assert.equal(e.exitCode, 4);
      assert.match(e.message, /tcp-legacy/);
      assert.match(e.message, /restart/i);
      return true;
    });
    assert.deepEqual(h.calls, []); assert.deepEqual(h.stops, []); assert.deepEqual(h.removed, []);
  } finally { await h.done(); }
});

test('a RUNNING owner-only pair under a tcp-legacy cfg is REFUSED — never recreated', async () => {
  const pre = harness();
  const names = pre.driver(OO).inspect().names;
  await pre.done();
  const h = harness({ preRunning: [
    { name: names.xpraContainer, labels: L('xpra', 'owner-only'), binds: [] },
    { name: names.chromiumContainer, labels: L('chromium', 'owner-only'), binds: [] },
  ] });
  try {
    h.running.get(names.chromiumContainer).args.mounts = [[h.udd, '/x', 'rw']];
    await assert.rejects(h.driver({}).ensureRunning(), /owner-only/);
    assert.deepEqual(h.calls, []); assert.deepEqual(h.stops, []); assert.deepEqual(h.removed, []);
  } finally { await h.done(); }
});

test('a running owner-only pair under owner-only cfg is REUSED when its socket answers', async () => {
  const h = harness();
  try {
    const d = h.driver(OO);
    await d.ensureRunning();
    const n = h.calls.length;
    const r = await h.driver(OO).ensureRunning();
    assert.equal(h.calls.length, n, 'nothing new started');
    assert.equal(r.endpoint.transport, 'unix');
  } finally { await h.done(); }
});

// ── shutdown ───────────────────────────────────────────────────────────────

test('shutdown (owner-only): stops relay, chromium, xpra — in that order', async () => {
  const h = harness();
  try {
    const d = h.driver(OO);
    await d.ensureRunning();
    await d.shutdown();
    assert.deepEqual(h.stops.map((s) => s.replace(/.*-(xpra|chromium|cdprelay)-.*/, '$1')),
      ['cdprelay', 'chromium', 'xpra']);
  } finally { await h.done(); }
});

test('shutdown: a relay-named container NOT mounting our channel dir is not ours — refused', async () => {
  const h = harness();
  try {
    const d = h.driver(OO);
    await d.ensureRunning();
    const relay = d.inspect().names.cdpRelayContainer;
    h.running.get(relay).args.mounts = [['/somewhere/else', '/run/webctl', 'rw']];
    await assert.rejects(d.shutdown(), /REFUSING to stop/);
    assert.deepEqual(h.stops, []);
  } finally { await h.done(); }
});

// ── A15: X11 stays on the named volume ─────────────────────────────────────

test('A15: /tmp/.X11-unix (and any pulse path) is mounted from the NAMED VOLUME, never a host path', async () => {
  const h = harness();
  try {
    await h.driver(OO).ensureRunning();
    for (const c of h.calls) {
      for (const m of c.mounts || []) {
        if (m[1] === '/tmp/.X11-unix' || /pulse/.test(m[1])) {
          assert.ok(!String(m[0]).startsWith('/'),
            `${c.name}: ${m[1]} from host path ${m[0]} — the X socket is 0777 with no X auth (gvlx §3); `
            + 'only the named volume under docker\'s 0710 data root keeps it from other users');
        }
      }
    }
    assert.ok(h.calls.some((c) => (c.mounts || []).some((/** @type {any[]} */ m) => m[1] === '/tmp/.X11-unix')),
      'the scan found the X11 mount (not vacuous)');
  } finally { await h.done(); }
});
