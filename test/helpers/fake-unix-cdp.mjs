// fake-unix-cdp.mjs — a fake CDP browser speaking REAL HTTP + server-side RFC 6455,
// on a unix socket (or, as the control, a TCP port the test opens itself on loopback).
//
// It behaves like the two strict peers base must satisfy:
//   * Firefox BiDi through xq's socket: any Host other than `hostHeader` gets 400
//     (6gi0 §1, bd1x) — so a client that sends the wrong Host fails here, not later.
//   * a server that ENFORCES client masking: an unmasked client frame is recorded as a
//     violation and the connection is failed (RFC 6455 §5.1).
// Knobs exercise what a minimal client gets wrong: a reply split into continuation
// frames, a reply long enough to need the 64-bit length, a ping that must be ponged,
// and a wrong Sec-WebSocket-Accept.

import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** @param {number} op @param {Buffer} payload @param {boolean} [fin] */
export function serverFrame(op, payload, fin = true) {
  const n = payload.length;
  /** @type {Buffer} */
  let hdr;
  if (n < 126) hdr = Buffer.from([(fin ? 0x80 : 0) | op, n]);
  else if (n < 65536) { hdr = Buffer.alloc(4); hdr[0] = (fin ? 0x80 : 0) | op; hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = (fin ? 0x80 : 0) | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([hdr, payload]);
}

/**
 * @param {{
 *   hostHeader?: string,               // unix: the Host to require; tcp: learned after listen
 *   socketPath?: string,               // unix (default) …
 *   tcp?: boolean,                     // … or TCP on 127.0.0.1:<ephemeral> (the control)
 *   badAccept?: boolean,
 *   fragmentReplies?: boolean,         // every reply in 3 frames: text + 2 continuations
 *   bigReplies?: boolean,              // pad replies past 65535 bytes (64-bit length)
 *   pingFirst?: boolean,               // ping right after the upgrade; expect a pong
 * }} o
 */
export async function startFakeCdp(o) {
  /** @type {string[]} */ const violations = [];
  /** @type {string[]} */ const hosts = [];
  /** @type {string[]} */ const methods = [];
  let pongs = 0;
  /** @type {Array<{targetId: string, type: string, url: string}>} */
  const targets = [{ targetId: 'HUMAN', type: 'page', url: 'https://human.example/' }];
  let expectHost = String(o.hostHeader);
  const wsBase = () => `ws://${expectHost}`;

  const server = http.createServer((req, res) => {
    hosts.push(String(req.headers.host));
    if (req.headers.host !== expectHost) { res.writeHead(400); res.end('Bad Host'); return; }
    const u = new URL(req.url || '/', 'http://x');
    const json = (/** @type {any} */ v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/json/version') {
      return json({ Browser: 'Fake/1.0', webSocketDebuggerUrl: `${wsBase()}/devtools/browser/B` });
    }
    if (u.pathname === '/json' || u.pathname === '/json/list') {
      return json(targets.map((t) => ({ id: t.targetId, type: t.type, url: t.url,
        webSocketDebuggerUrl: `${wsBase()}/devtools/page/${t.targetId}` })));
    }
    res.writeHead(404); res.end();
  });

  /** @type {Set<import('node:net').Socket>} */
  const upgraded = new Set();
  server.on('upgrade', (req, sock) => {
    upgraded.add(sock);
    sock.on('close', () => upgraded.delete(sock));
    hosts.push(String(req.headers.host));
    if (req.headers.host !== expectHost) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = o.badAccept ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' : crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (o.pingFirst) sock.write(serverFrame(0x9, Buffer.from('hb')));
    let buf = Buffer.alloc(0);
    /** @param {any} reply */
    const send = (reply) => {
      let s = JSON.stringify(reply);
      if (o.bigReplies) s = JSON.stringify({ ...reply, pad: 'x'.repeat(70000) });
      const b = Buffer.from(s);
      if (o.fragmentReplies && b.length >= 3) {
        const a = Math.floor(b.length / 3);
        sock.write(serverFrame(0x1, b.subarray(0, a), false));
        sock.write(serverFrame(0x0, b.subarray(a, 2 * a), false));
        sock.write(serverFrame(0x0, b.subarray(2 * a), true));
      } else sock.write(serverFrame(0x1, b));
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (!masked) { violations.push('client frame NOT masked'); sock.destroy(); return; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((x, i) => x ^ mask[i & 3]);
        buf = buf.subarray(off + 4 + len);
        if (op === 0x8) { sock.end(serverFrame(0x8, Buffer.from(payload))); return; }
        if (op === 0xA) { pongs++; continue; }
        if (op !== 0x1) continue;
        const msg = JSON.parse(Buffer.from(payload).toString('utf8'));
        methods.push(msg.method);
        /** @type {any} */
        let result = {};
        if (msg.method === 'Browser.getVersion') result = { product: 'Fake/1.0' };
        else if (msg.method === 'Target.getTargets') result = { targetInfos: targets.map((t) => ({ ...t })) };
        else if (msg.method === 'Target.createTarget') {
          const id = `MINT${targets.length}`;
          targets.push({ targetId: id, type: 'page', url: msg.params.url });
          result = { targetId: id };
        } else if (msg.method === 'Target.closeTarget') {
          const i = targets.findIndex((t) => t.targetId === msg.params.targetId);
          if (i >= 0) targets.splice(i, 1);
          result = { success: true };
        }
        send({ id: msg.id, result });
      }
    });
    sock.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    if (o.tcp) server.listen(0, '127.0.0.1', () => resolve(undefined));
    else server.listen(o.socketPath, () => resolve(undefined));
  });
  const addr = /** @type {any} */ (server.address());
  if (o.tcp) expectHost = `127.0.0.1:${addr.port}`;
  return {
    port: o.tcp ? addr.port : null,
    violations, hosts, methods,
    get pongs() { return pongs; },
    targets,
    // Upgraded sockets are detached from the server, so close() would wait on them forever.
    close: () => new Promise((r) => {
      for (const k of upgraded) k.destroy();
      server.closeAllConnections?.();
      server.close(() => r(undefined));
    }),
  };
}
