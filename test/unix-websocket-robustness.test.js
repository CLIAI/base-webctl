// unix-websocket-robustness.test.js — review of v0.34.2, F2 and F10: the RFC 6455 client under a server that is
// slow, large, wrong or hostile. A RAW test server on a unix socket THIS file creates completes the handshake by hand
// (or deliberately does not) and then writes frames byte by byte, so each arm drives the real client end to end.
//
//   F2  — a large frame arriving in many chunks is reassembled in LINEAR time (it was O(n²): 4 MiB took 2 s, 32 MiB
//         did not finish);
//   F10 — a 1-byte close payload fails with 1002 (it was echoed); a listener that throws does not drop the frames
//         after it; the handshake is bounded; a 101 that is not a websocket upgrade is refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { UnixWebSocket } from '../lib/unix-websocket.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HOST = '127.0.0.1:9222';

/** A server frame (unmasked). @param {number} op @param {Buffer} payload */
function frame(op, payload) {
  const n = payload.length;
  /** @type {Buffer} */ let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, payload]);
}

/** Unmask the first client frame in `b` → {op, payload}. @param {Buffer} b */
function readClientFrame(b) {
  const op = b[0] & 0x0f;
  let len = b[1] & 0x7f; let off = 2;
  if (len === 126) { len = b.readUInt16BE(2); off = 4; }
  const mask = b.subarray(off, off + 4);
  const p = Buffer.alloc(len);
  for (let i = 0; i < len; i++) p[i] = b[off + 4 + i] ^ mask[i & 3];
  return { op, payload: p };
}

/**
 * A raw server: `answer` decides the handshake reply (null = never answer). After a good handshake `onOpen(sock)` gets
 * the socket to write frames to. @param {{answer?: (accept: string) => string|null, onOpen?: (s: net.Socket) => void}} o
 */
async function rawServer(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-wsr-'));
  const socketPath = path.join(dir, 's.sock');
  /** @type {Buffer[]} */ const fromClient = [];
  /** @type {Set<net.Socket>} */ const conns = new Set();
  const srv = net.createServer((sock) => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
    let req = '';
    let up = false;
    sock.on('data', (d) => {
      if (up) { fromClient.push(d); return; }
      req += d.toString('latin1');
      if (!req.includes('\r\n\r\n')) return;
      const key = (req.match(/^Sec-WebSocket-Key: (.+)$/mi) || [])[1]?.trim() || '';
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const reply = o.answer ? o.answer(accept)
        : `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
      if (reply === null) return; // never answer
      up = true;
      sock.write(reply);
      if (o.onOpen) setImmediate(() => o.onOpen && o.onOpen(sock));
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(socketPath, () => r(null)));
  // close() DESTROYS the connections: a red arm (a client the old code kept open) must fail, never hang the file
  return { socketPath, fromClient, close: () => new Promise((r) => {
    for (const c of conns) c.destroy();
    srv.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(null); });
  }) };
}

/** Open a client; resolve on 'open' or reject on 'error'. @param {string} socketPath @param {any} [extra] */
function client(socketPath, extra = {}) {
  const ws = new UnixWebSocket('ws://127.0.0.1:9222/devtools/browser/B', { socketPath, hostHeader: HOST, ...extra });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (/** @type {any} */ e) => reject(new Error(e.message)));
  });
  return { ws, opened };
}

test('⛔ review F2: a 32 MiB frame fed in EXACT 16 KiB chunks is reassembled in LINEAR time (measured on the old parser: 22 s; 4 KiB chunks: not done in 60 s)', { timeout: 120000 }, async () => {
  // ⚠ The chunks are fed to the parser DIRECTLY, after a real handshake: through a socket the kernel coalesces writes
  // into large reads, and the O(n²) path never showed (this arm was GREEN on the old code that way).
  const srv = await rawServer({});
  try {
    const { ws, opened } = client(srv.socketPath, { maxMessageBytes: 64 * 1024 * 1024 });
    await opened;
    const big = Buffer.alloc(32 * 1024 * 1024, 0x61);
    const f = frame(0x2, big);
    /** @type {any} */ let data = null;
    ws.addEventListener('message', (/** @type {any} */ e) => { data = e.data; });
    const t0 = Date.now();
    for (let i = 0; i < f.length && Date.now() - t0 < 60000; i += 16384) /** @type {any} */ (ws)._onData(f.subarray(i, i + 16384));
    const ms = Date.now() - t0;
    ws.close();
    assert.ok(data, 'the message never completed');
    assert.equal(data.length, big.length);
    assert.ok(ms < 3000, `a 32 MiB frame in 16 KiB chunks took ${ms} ms (fixed parser, measured: ~70 ms)`);
  } finally { await srv.close(); }
});

test('⛔ review F10: a close frame with a 1-BYTE payload fails with 1002 — it is never echoed', { timeout: 10000 }, async () => {
  const srv = await rawServer({ onOpen: (sock) => sock.write(frame(0x8, Buffer.from([0x03]))) });
  try {
    const { ws, opened } = client(srv.socketPath);
    // bounded: the old client echoed the close and never errored — that must FAIL here, not wait for the timeout
    const err = /** @type {Promise<string>} */ (new Promise((r) => {
      ws.addEventListener('error', (/** @type {any} */ e) => r(e.message));
      setTimeout(() => r('(no error within 3 s)'), 3000);
    }));
    await opened.catch(() => {});
    assert.match(await err, /1-byte payload/);
    await new Promise((r) => setTimeout(r, 100));
    const sent = Buffer.concat(srv.fromClient);
    assert.ok(sent.length >= 4, 'no close frame was sent');
    const c = readClientFrame(sent);
    assert.equal(c.op, 0x8);
    assert.equal(c.payload.readUInt16BE(0), 1002, `the close code sent was ${c.payload.readUInt16BE(0)}, not 1002`);
  } finally { await srv.close(); }
});

test('⛔ review F10: a listener that THROWS does not drop the frames after it in the same chunk — and its error still surfaces', { timeout: 20000 }, async () => {
  // in a CHILD process: the client rethrows a listener's error on a microtask (never swallowed), which this test runner
  // would count against the file
  const srv = await rawServer({ onOpen: (sock) => sock.write(Buffer.concat([frame(0x1, Buffer.from('one')), frame(0x1, Buffer.from('two'))])) });
  try {
    const { spawn } = await import('node:child_process');
    // ⚠ ASYNC: the raw server lives in THIS process — a spawnSync would block it, and no handshake would be answered
    const run = (/** @type {string[]} */ argv) => /** @type {Promise<{stdout: string, stderr: string}>} */ (new Promise((resolve) => {
      const c = spawn(process.execPath, argv);
      let stdout = ''; let stderr = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.stderr.on('data', (d) => { stderr += d; });
      const t = setTimeout(() => c.kill('SIGKILL'), 10000);
      c.on('close', () => { clearTimeout(t); resolve({ stdout, stderr }); });
    }));
    const lib = new URL('../lib/unix-websocket.js', import.meta.url).href;
    const r = await run(['--input-type=module', '-e', `
      const { UnixWebSocket } = await import(${JSON.stringify(lib)});
      const got = [];
      process.on('uncaughtException', (e) => { console.log('UNCAUGHT ' + e.message); });
      const ws = new UnixWebSocket('ws://127.0.0.1:9222/x', { socketPath: ${JSON.stringify(srv.socketPath)}, hostHeader: '127.0.0.1:9222' });
      ws.addEventListener('message', (e) => { got.push(e.data); if (e.data === 'one') throw new Error('listener boom'); });
      setTimeout(() => { console.log('GOT ' + JSON.stringify(got)); ws.close(); process.exit(0); }, 500);
    `]);
    assert.match(r.stdout, /^GOT \["one","two"\]$/m, `a frame after the throwing listener was dropped:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^UNCAUGHT listener boom$/m, 'the listener\'s error was swallowed instead of surfacing');
  } finally { await srv.close(); }
});

test('⛔ review F10: the handshake is BOUNDED — a server that accepts and never answers fails, never hangs', { timeout: 10000 }, async () => {
  const srv = await rawServer({ answer: () => null });
  try {
    const { opened } = client(srv.socketPath, { handshakeTimeoutMs: 300 });
    const t0 = Date.now();
    await assert.rejects(opened, /handshake timed out/);
    assert.ok(Date.now() - t0 < 3000);
  } finally { await srv.close(); }
});

test('⛔ review F10: a 101 that is not a websocket upgrade (Upgrade: h2c) is REFUSED, even with a correct accept — CONTROL: the right headers open', { timeout: 10000 }, async () => {
  const bad = await rawServer({ answer: (a) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${a}\r\n\r\n` });
  try {
    await assert.rejects(client(bad.socketPath).opened, /not a websocket upgrade/);
  } finally { await bad.close(); }
  const good = await rawServer({});
  try {
    const { ws, opened } = client(good.socketPath);
    await opened;
    ws.close();
  } finally { await good.close(); }
});
