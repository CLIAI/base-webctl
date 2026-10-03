// fake-cdp-browser.mjs — a RECORDING fake Chromium DevTools endpoint, for tests.
//
// ⛔ Tests never connect to a real browser. Everything here listens on 127.0.0.1
// with an EPHEMERAL port (listen(0)) and is closed by `stop()`.
//
// What it fakes, and only that:
//   HTTP  GET /json/version, GET /json and /json/list, PUT|GET /json/new?<url>,
//         GET /json/close/<id>
//   WS    /devtools/browser/<id>  Target.createTarget, Target.closeTarget,
//                                 Target.getTargets
//         /devtools/page/<id>     Page.enable, Page.navigate (+ Page.loadEventFired),
//                                 Runtime.evaluate
//
// ⭐ EVERYTHING IS RECORDED IN ONE ORDERED `log`, so a test can assert ORDER across
// HTTP, websocket connections and CDP calls — and a test's own hook can push into
// the same log (that is how "recorded strictly before the first attach" is read).
//
// `advertise` is the authority the fake PRINTS in every webSocketDebuggerUrl. It
// defaults to its own; a test of the tunnel case sets it to a TRAP (startTrap())
// that records every TCP connection made to it, so "the raw authority is never
// dialled" is a measured zero, not an assumption.
//
// The WebSocket server is a minimal RFC 6455 implementation (no dependency):
// handshake, masked client text frames, unmasked server text frames, close/ping.
//
// ⚠ This file registers no tests. Run bare, it exports and exits 0.

import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @typedef {{id: string, type?: string, url?: string, title?: string}} FakeTarget
 * @typedef {{t: string, [k: string]: any}} LogEntry
 */

/** @param {string} text */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const n = payload.length;
  /** @type {Buffer} */
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

/**
 * Parse as many complete client frames as `buf` holds.
 * @param {Buffer} buf
 * @returns {{frames: {opcode: number, payload: Buffer}[], rest: Buffer}}
 */
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off]; const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < p + maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * A listener that ACCEPTS and RECORDS every TCP connection and answers nothing
 * useful. Stands in for the remote authority behind an ssh forward.
 * @returns {Promise<{authority: string, port: number, connections: number, stop: () => Promise<void>}>}
 */
export async function startTrap() {
  /** @type {Set<net.Socket>} */
  const socks = new Set();
  const trap = { authority: '', port: 0, connections: 0, stop: async () => {} };
  const srv = net.createServer((s) => {
    trap.connections += 1;
    socks.add(s);
    s.on('error', () => {});
    s.on('close', () => socks.delete(s));
    s.destroy();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {net.AddressInfo} */ (srv.address());
  trap.port = addr.port;
  trap.authority = `127.0.0.1:${addr.port}`;
  trap.stop = () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(() => r(undefined)); });
  return trap;
}

/**
 * @param {{
 *   targets?: FakeTarget[],
 *   createTarget?: boolean,      // Target.createTarget succeeds (default true)
 *   jsonNew?: string[],          // verbs /json/new accepts (default ['PUT'])
 *   advertise?: string,          // authority printed in ws URLs (default: own)
 * }} [opts]
 */
export async function startFakeBrowser(opts = {}) {
  /** @type {Map<string, Required<FakeTarget>>} */
  const targets = new Map();
  for (const t of opts.targets || []) {
    targets.set(t.id, { id: t.id, type: t.type || 'page', url: t.url || 'about:blank', title: t.title || '' });
  }
  const cfg = {
    createTarget: opts.createTarget !== false,
    jsonNew: opts.jsonNew || ['PUT'],
  };
  /** @type {LogEntry[]} */
  const log = [];
  const state = { browserExited: false, minted: 0 };
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const BROWSER_ID = 'fake-browser-0';

  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  const own = `127.0.0.1:${port}`;
  const advertise = opts.advertise || own;

  /** @param {Required<FakeTarget>} t */
  const httpRow = (t) => ({
    id: t.id, type: t.type, url: t.url, title: t.title,
    ...(t.type === 'page' ? { webSocketDebuggerUrl: `ws://${advertise}/devtools/page/${t.id}` } : {}),
  });

  /** @param {string} url */
  const mint = (url) => {
    state.minted += 1;
    const t = { id: `MINTED-${state.minted}`, type: 'page', url, title: '' };
    targets.set(t.id, t);
    return t;
  };

  /** @param {string} id */
  const remove = (id) => {
    const had = targets.delete(id);
    // A real Chromium EXITS when its last page closes — the failure the last-page
    // rule exists to prevent. Record it so a test can assert it did not happen.
    if (had && ![...targets.values()].some((t) => t.type === 'page')) state.browserExited = true;
    return had;
  };

  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  server.on('request', (req, res) => {
    const u = new URL(String(req.url), `http://${own}`);
    const method = String(req.method);
    log.push({ t: 'http', method, path: u.pathname, query: u.search });
    /** @param {number} code @param {any} body */
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/json/version') {
      return send(200, { Browser: 'FakeChromium/1.0', webSocketDebuggerUrl: `ws://${advertise}/devtools/browser/${BROWSER_ID}` });
    }
    if (u.pathname === '/json' || u.pathname === '/json/list') {
      return send(200, [...targets.values()].map(httpRow));
    }
    if (u.pathname === '/json/new') {
      if (!cfg.jsonNew.includes(method)) return send(405, { error: 'method not allowed' });
      const url = u.search ? decodeURIComponent(u.search.slice(1)) : 'about:blank';
      return send(200, httpRow(mint(url)));
    }
    if (u.pathname.startsWith('/json/close/')) {
      const id = decodeURIComponent(u.pathname.slice('/json/close/'.length));
      return remove(id) ? send(200, 'Target is closing') : send(404, { error: `no target ${id}` });
    }
    return send(404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    const path = new URL(String(req.url), `http://${own}`).pathname;
    const m = path.match(/^\/devtools\/(browser|page)\/(.+)$/);
    const kind = m ? m[1] : 'unknown';
    const id = m ? decodeURIComponent(m[2]) : '';
    log.push({ t: 'ws', kind, id });
    if (!m || (kind === 'page' && !targets.has(id)) || (kind === 'browser' && id !== BROWSER_ID)) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
    /** @param {any} obj */
    const reply = (obj) => { if (!socket.destroyed) socket.write(encodeText(JSON.stringify(obj))); };

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = parseFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 0x8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (f.opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload])); continue; }
        if (f.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
        log.push({ t: 'cdp', kind, target: id, method: msg.method, params: msg.params });
        handle(kind, id, msg, reply);
      }
    });
  });

  /**
   * @param {string} kind @param {string} id @param {any} msg @param {(o: any) => void} reply
   */
  function handle(kind, id, msg, reply) {
    const err = (/** @type {number} */ code, /** @type {string} */ message) => reply({ id: msg.id, error: { code, message } });
    const ok = (/** @type {any} */ result) => reply({ id: msg.id, result });
    const p = msg.params || {};
    if (kind === 'browser') {
      if (msg.method === 'Target.createTarget') {
        if (!cfg.createTarget) return err(-32000, 'Target.createTarget is not allowed in this build');
        return ok({ targetId: mint(String(p.url)).id });
      }
      if (msg.method === 'Target.closeTarget') {
        return remove(String(p.targetId)) ? ok({ success: true }) : err(-32602, `No target with given id ${p.targetId}`);
      }
      if (msg.method === 'Target.getTargets') {
        return ok({ targetInfos: [...targets.values()].map((t) => ({ targetId: t.id, type: t.type, url: t.url, title: t.title, attached: false })) });
      }
      return err(-32601, `'${msg.method}' wasn't found`);
    }
    const t = targets.get(id);
    if (!t) return err(-32000, 'target gone');
    if (msg.method === 'Page.enable') return ok({});
    if (msg.method === 'Page.navigate') {
      t.url = String(p.url);
      ok({ frameId: `frame-${id}` });
      reply({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
      return;
    }
    if (msg.method === 'Runtime.evaluate') return ok({ result: { type: 'boolean', value: true } });
    return err(-32601, `'${msg.method}' wasn't found`);
  }

  return {
    base: `http://${own}`,
    port,
    advertise,
    log,
    targets,
    state,
    /** URL of a target, or undefined when it no longer exists. @param {string} id */
    urlOf: (id) => targets.get(id)?.url,
    /** Every websocket attach to a PAGE target, in order. */
    pageAttaches: () => log.filter((e) => e.t === 'ws' && e.kind === 'page'),
    /** Every CDP call of `method`, in order. @param {string} method */
    calls: (method) => log.filter((e) => e.t === 'cdp' && e.method === method),
    /** @param {Partial<typeof cfg>} c */
    configure: (c) => Object.assign(cfg, c),
    stop: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r(undefined));
    }),
  };
}
