// cdp-unix-transport.test.js — A12 + A18: base's CDP client speaks CDP over a unix
// socket, zero-dep, and touches NO TCP on the way (6gi0 §1).
//
// The peer is a fake on a socket THIS test creates, inside a fresh 0700 mkdtemp dir.
// Nothing here connects to any port the test did not open itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  getVersion, connectBrowser, listTargets, listTargetsViaBrowser, openPage, closePage,
} from '../lib/cdp-client.js';
import { UnixWebSocket } from '../lib/unix-websocket.js';
import { startFakeCdp } from './helpers/fake-unix-cdp.mjs';

const HOST_HEADER = '127.0.0.1:9222';

/** A sealed scratch dir with a fake CDP on `<dir>/cdp.sock`. @param {any} [knobs] */
async function unixFake(knobs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-cdpu-'));
  const socketPath = path.join(dir, 'cdp.sock');
  const fake = await startFakeCdp({ hostHeader: HOST_HEADER, socketPath, ...knobs });
  const endpoint = { name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'unix',
    host: null, port: null, path: socketPath, host_header: HOST_HEADER };
  return { dir, endpoint, fake, done: async () => { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * ⛔ Spy on every TCP connect and listen in this process. The unix transport must
 * produce NONE — not to the host:port inside webSocketDebuggerUrl, not anywhere.
 * @param {() => Promise<void>} fn
 */
async function noTcp(fn) {
  /** @type {string[]} */
  const tcp = [];
  const origConnect = net.Socket.prototype.connect;
  const origListen = net.Server.prototype.listen;
  net.Socket.prototype.connect = /** @type {any} */ (function (/** @type {any[]} */ ...args) {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof a === 'number' || (a && typeof a === 'object' && a.port !== undefined && !a.path)) {
      tcp.push(`connect ${JSON.stringify(a && a.port !== undefined ? { host: a.host, port: a.port } : a)}`);
    }
    // @ts-ignore — forwarding to the real method
    return origConnect.apply(this, args);
  });
  net.Server.prototype.listen = /** @type {any} */ (function (/** @type {any[]} */ ...args) {
    const a = args[0];
    if (typeof a === 'number' || (a && typeof a === 'object' && a.port !== undefined)) tcp.push(`listen ${JSON.stringify(a)}`);
    // @ts-ignore
    return origListen.apply(this, args);
  });
  try { await fn(); } finally {
    net.Socket.prototype.connect = origConnect;
    net.Server.prototype.listen = origListen;
  }
  assert.deepEqual(tcp, [], 'the unix transport must not touch TCP at all');
}

test('A12: getVersion + a browser session + CDP round-trip over the unix socket, no TCP', async () => {
  const u = await unixFake();
  try {
    await noTcp(async () => {
      const v = await getVersion(u.endpoint);
      assert.equal(v.Browser, 'Fake/1.0');
      const s = await connectBrowser(u.endpoint);
      try {
        const r = await s.cdp('Browser.getVersion');
        assert.equal(r.product, 'Fake/1.0');
      } finally { s.close(); }
      assert.equal((await listTargets(u.endpoint)).length, 1);
      assert.equal((await listTargetsViaBrowser(u.endpoint)).length, 1);
    });
    assert.deepEqual(u.fake.violations, []);
  } finally { await u.done(); }
});

test('A12: openPage MINTS over the socket and close() closes only that tab', async () => {
  const u = await unixFake();
  try {
    await noTcp(async () => {
      const p = await openPage(u.endpoint);
      assert.equal(p.reused, false);
      assert.ok(u.fake.targets.some((t) => t.targetId === p.targetId));
      const r = await p.close();
      assert.deepEqual(r, { closed: true });
      assert.ok(u.fake.targets.some((t) => t.targetId === 'HUMAN'), 'the human\'s tab is untouched');
    });
  } finally { await u.done(); }
});

test('A18: every request and upgrade carries Host: host_header (a fake that 400s any other Host)', async () => {
  const u = await unixFake();
  try {
    await (await connectBrowser(u.endpoint)).close();
    await getVersion(u.endpoint);
    assert.ok(u.fake.hosts.length >= 3);
    assert.deepEqual([...new Set(u.fake.hosts)], [HOST_HEADER]);
  } finally { await u.done(); }
});

test('A18 control: a client that sent another Host would be refused by this fake', async () => {
  const u = await unixFake();
  try {
    await assert.rejects(getVersion({ ...u.endpoint, host_header: '127.0.0.1:1' }), /400/);
  } finally { await u.done(); }
});

test('A18 (tcp): a tcp endpoint WITH host_header sends it as the Host header — every request and upgrade — dialling host:port, never the URL authority', async () => {
  // An app behind a forward: it listens on an ephemeral loopback port THIS test opened, and checks Host against its
  // OWN port (127.0.0.1:9222). fetch and the built-in WebSocket would send the dialled authority and get 400.
  const tcpFake = await startFakeCdp({ tcp: true, hostHeader: HOST_HEADER });
  try {
    const ep = { name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'tcp', host: '127.0.0.1',
      port: /** @type {number} */ (tcpFake.port), path: null, host_header: HOST_HEADER };
    assert.equal((await getVersion(ep)).Browser, 'Fake/1.0');
    const s = await connectBrowser(ep);
    try { assert.equal((await s.cdp('Browser.getVersion')).product, 'Fake/1.0'); } finally { s.close(); }
    const p = await openPage(ep);
    assert.deepEqual(await p.close(), { closed: true });
    assert.ok(tcpFake.hosts.length >= 4, 'not every request reached the fake');
    assert.deepEqual([...new Set(tcpFake.hosts)], [HOST_HEADER], 'a request carried a Host other than host_header');
  } finally { await tcpFake.close(); }
});

test('A18 (tcp) control: WITHOUT host_header the same fake refuses (the dialled authority is sent, as fetch does) — the arm can fail', async () => {
  const tcpFake = await startFakeCdp({ tcp: true, hostHeader: HOST_HEADER });
  try {
    const ep = { name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'tcp', host: '127.0.0.1',
      port: /** @type {number} */ (tcpFake.port), path: null, host_header: null };
    await assert.rejects(getVersion(ep), /400|Bad Host|Unexpected token|JSON/);
    assert.deepEqual([...new Set(tcpFake.hosts)], [`127.0.0.1:${tcpFake.port}`]);
  } finally { await tcpFake.close(); }
});

test('UnixWebSocket: exactly ONE way to dial — a socketPath AND a host/port together are refused, and neither is', () => {
  for (const o of [{ socketPath: '/x.sock', host: '127.0.0.1', port: 1, hostHeader: HOST_HEADER }, { hostHeader: HOST_HEADER }]) {
    assert.throws(() => new UnixWebSocket('ws://127.0.0.1:9222/devtools/browser/B', /** @type {any} */ (o)), /exactly one of/);
  }
});

test('A12: replies split into continuation frames are reassembled', async () => {
  const u = await unixFake({ fragmentReplies: true });
  try {
    const s = await connectBrowser(u.endpoint);
    try { assert.equal((await s.cdp('Browser.getVersion')).product, 'Fake/1.0'); } finally { s.close(); }
  } finally { await u.done(); }
});

test('A12: a reply past 65535 bytes (64-bit length) is read whole', async () => {
  const u = await unixFake({ bigReplies: true });
  try {
    const s = await connectBrowser(u.endpoint);
    try { assert.equal((await s.cdp('Browser.getVersion')).product, 'Fake/1.0'); } finally { s.close(); }
  } finally { await u.done(); }
});

test('A12: a large CLIENT message uses the 16- and 64-bit lengths, masked', async () => {
  const u = await unixFake();
  try {
    const s = await connectBrowser(u.endpoint);
    try {
      await s.cdp('Browser.getVersion', { pad: 'y'.repeat(300) });     // 16-bit length
      await s.cdp('Browser.getVersion', { pad: 'z'.repeat(70000) });   // 64-bit length
    } finally { s.close(); }
    assert.deepEqual(u.fake.violations, [], 'the server saw only masked client frames');
    assert.ok(u.fake.methods.filter((m) => m === 'Browser.getVersion').length >= 2);
  } finally { await u.done(); }
});

test('A12: a server ping is answered with a pong', async () => {
  const u = await unixFake({ pingFirst: true });
  try {
    const s = await connectBrowser(u.endpoint);
    try {
      await s.cdp('Browser.getVersion');
      assert.equal(u.fake.pongs, 1);
    } finally { s.close(); }
  } finally { await u.done(); }
});

test('A12: a wrong Sec-WebSocket-Accept is REFUSED', async () => {
  const u = await unixFake({ badAccept: true });
  try {
    await assert.rejects(connectBrowser(u.endpoint), /Sec-WebSocket-Accept/);
  } finally { await u.done(); }
});

test('A12: an endpoint AND host/port together are refused — two ways to say where', async () => {
  const u = await unixFake();
  try {
    await assert.rejects(connectBrowser(u.endpoint, { port: 9222 }), /not both/);
  } finally { await u.done(); }
});

test('A17 (consumer): a socket in an UNSEALED dir is refused before any connect', async () => {
  const u = await unixFake();
  try {
    fs.chmodSync(u.dir, 0o755); // tmpdir above is root-owned: nothing seals it now
    await noTcp(async () => {
      await assert.rejects(getVersion(u.endpoint), /no sealed ancestor/);
    });
    assert.deepEqual(u.fake.hosts, [], 'refused before the socket was touched');
  } finally { fs.chmodSync(u.dir, 0o700); await u.done(); }
});

test('A12: closePage over the socket reaches the fake (best-effort, never throws)', async () => {
  const u = await unixFake();
  try { await closePage(u.endpoint, 'NOPE'); } finally { await u.done(); }
});

test('A12 control: the SAME calls over {transport:"tcp"} against a TCP fake succeed', async () => {
  // A port THIS test opened (ephemeral, loopback) — never a fleet port.
  const tcpFake = await startFakeCdp({ tcp: true });
  try {
    const ep = { name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'tcp', host: '127.0.0.1',
      port: /** @type {number} */ (tcpFake.port), path: null, host_header: null };
    assert.equal((await getVersion(ep)).Browser, 'Fake/1.0');
    const s = await connectBrowser(ep);
    try { assert.equal((await s.cdp('Browser.getVersion')).product, 'Fake/1.0'); } finally { s.close(); }
    const p = await openPage(ep);
    assert.deepEqual(await p.close(), { closed: true });
  } finally { await tcpFake.close(); }
});

test('UnixWebSocket: not usable before open; refuses send', () => {
  const ws = new UnixWebSocket('ws://127.0.0.1:9222/devtools/browser/B',
    { socketPath: path.join(os.tmpdir(), 'webctl-does-not-exist.sock'), hostHeader: HOST_HEADER });
  ws.addEventListener('error', () => {});
  assert.throws(() => ws.send('x'), /not open/);
  ws.close();
});

test('A12 self-test: the TCP spy DOES fail when a call goes over TCP (it is not vacuous)', async () => {
  const tcpFake = await startFakeCdp({ tcp: true });
  try {
    const ep = { name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'tcp', host: '127.0.0.1',
      port: /** @type {number} */ (tcpFake.port) };
    await assert.rejects(noTcp(async () => { await getVersion(ep); }), /must not touch TCP/);
  } finally { await tcpFake.close(); }
});
