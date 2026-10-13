// lib/unix-websocket.js — a minimal RFC 6455 CLIENT over a unix socket, zero-dep.
//
// Design: docs/design/infra-unix-control-endpoint-6gi0.md §1.
//
// WHY IT EXISTS. Node's built-in `WebSocket` refuses a unix socket (measured:
// "Expected a ws: or wss: protocol, got ws+unix:"), and undici's Agent — which could
// route it — is not reachable without a dependency. CDP over a unix socket therefore
// needs its own framing. `xpra-html5-gateway.js` is the precedent for raw upgrades,
// but it only PUMPS bytes; this FRAMES them, so it carries its own arms
// (test/cdp-unix-transport.test.js).
//
// SURFACE: exactly what `CdpSession` uses from a WebSocket — the constructor,
// addEventListener('open'|'message'|'error'|'close'), send(string), close(),
// readyState — so it drops in through CdpSession's existing `WebSocketImpl` seam.
//
// ⛔ ONLY THE URL'S PATH IS USED. A CDP websocket URL names Chromium's own
// `127.0.0.1:9222` — an address inside the container's network namespace, NOT on this
// host. Its host and port are never dialled; the socket path and the Host header come
// from the control endpoint.
//
// What it does: verifies Sec-WebSocket-Accept; masks every client frame; 7/16/64-bit
// lengths both ways; reassembles continuation frames; answers ping with pong; completes
// the close handshake. What it does NOT: extensions (none offered — one negotiated
// anyway is a protocol error), subprotocols, TLS.

import crypto from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class UnixWebSocket {
  /**
   * @param {string} url  ws:// URL; only its path and query are used
   * @param {{socketPath: string, hostHeader: string, maxMessageBytes?: number}} o
   */
  constructor(url, o) {
    if (!o || typeof o.socketPath !== 'string' || typeof o.hostHeader !== 'string') {
      throw new TypeError('UnixWebSocket: {socketPath, hostHeader} are required');
    }
    this.url = url;
    this.readyState = CONNECTING;
    /** @type {Map<string, Array<(ev: any) => void>>} */
    this._listeners = new Map();
    /** @type {import('node:net').Socket|null} */
    this._sock = null;
    /** @type {Buffer} */
    this._buf = Buffer.alloc(0);
    /** @type {Buffer[]|null} */
    this._frag = null;
    this._fragOp = 0;
    this._fragLen = 0;
    this._closeSent = false;
    this._closedEmitted = false;
    this._max = o.maxMessageBytes || 256 * 1024 * 1024;

    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      socketPath: o.socketPath,
      path: `${u.pathname}${u.search}`,
      headers: {
        Host: o.hostHeader,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    req.on('upgrade', (res, sock, head) => {
      const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== want) {
        sock.destroy();
        this._fail('Sec-WebSocket-Accept does not match the key sent — refusing the connection');
        return;
      }
      if (res.headers['sec-websocket-extensions']) {
        sock.destroy();
        this._fail('the server negotiated an extension none was offered for — refusing');
        return;
      }
      this._sock = sock;
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('close', () => this._onClose());
      sock.on('error', (e) => this._fail(e.message));
      this.readyState = OPEN;
      this._emit('open', {});
      if (head && head.length) this._onData(head);
    });
    req.on('response', (res) => {
      res.resume();
      this._fail(`websocket upgrade refused: HTTP ${res.statusCode}`);
    });
    req.on('error', (e) => this._fail(e.message));
    req.end();
  }

  /** @param {string} type @param {(ev: any) => void} fn */
  addEventListener(type, fn) {
    const l = this._listeners.get(type) || [];
    l.push(fn);
    this._listeners.set(type, l);
  }

  /** @param {string} type @param {(ev: any) => void} fn */
  removeEventListener(type, fn) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((f) => f !== fn));
  }

  /** @param {string} type @param {any} ev */
  _emit(type, ev) {
    for (const fn of [...(this._listeners.get(type) || [])]) fn(ev);
  }

  /** @param {string|Buffer} data */
  send(data) {
    if (this.readyState !== OPEN) throw new Error('UnixWebSocket: not open');
    this._sendFrame(0x1, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
  }

  /** @param {number} [code] */
  close(code = 1000) {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    if (this.readyState === CONNECTING || !this._sock) { this._onClose(); return; }
    this.readyState = CLOSING;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this._closeSent = true;
    try { this._sendFrame(0x8, p); } catch { /* socket already gone */ }
    // The server answers with its own close frame; do not wait forever for it.
    setTimeout(() => this._onClose(), 1000).unref();
  }

  /** @param {number} op @param {Buffer} payload */
  _sendFrame(op, payload) {
    if (!this._sock) throw new Error('UnixWebSocket: no socket');
    const n = payload.length;
    /** @type {Buffer} */
    let hdr;
    if (n < 126) {
      hdr = Buffer.from([0x80 | op, 0x80 | n]);
    } else if (n < 65536) {
      hdr = Buffer.alloc(4);
      hdr[0] = 0x80 | op; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(n, 2);
    } else {
      hdr = Buffer.alloc(10);
      hdr[0] = 0x80 | op; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(n), 2);
    }
    // ⛔ Every client frame is masked (RFC 6455 §5.1); a server MUST fail one that is not.
    const mask = crypto.randomBytes(4);
    const body = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    this._sock.write(Buffer.concat([hdr, mask, body]));
  }

  /** @param {Buffer} d */
  _onData(d) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    while (this.readyState !== CLOSED) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this._max)) { this._protocolError('frame larger than maxMessageBytes'); return; }
        len = Number(big); off = 10;
      }
      if (rsv) { this._protocolError('RSV bits set, but no extension was negotiated'); return; }
      if (masked) { this._protocolError('a server frame was masked'); return; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this._buf = b.subarray(off + len);

      if (op >= 0x8) {
        if (!fin || len > 125) { this._protocolError('fragmented or oversized control frame'); return; }
        if (op === 0x8) {
          if (!this._closeSent) {
            this._closeSent = true;
            try { this._sendFrame(0x8, Buffer.from(payload.subarray(0, 2))); } catch { /* gone */ }
          }
          this._onClose();
          return;
        }
        if (op === 0x9) { try { this._sendFrame(0xA, Buffer.from(payload)); } catch { /* gone */ } continue; }
        if (op === 0xA) continue;
        this._protocolError(`unknown control opcode ${op}`);
        return;
      }
      if (op === 0x0) {
        if (!this._frag) { this._protocolError('continuation frame without a message to continue'); return; }
        this._frag.push(Buffer.from(payload));
        this._fragLen += len;
      } else if (op === 0x1 || op === 0x2) {
        if (this._frag) { this._protocolError('a new message started inside a fragmented one'); return; }
        this._frag = [Buffer.from(payload)];
        this._fragOp = op;
        this._fragLen = len;
      } else {
        this._protocolError(`unknown opcode ${op}`);
        return;
      }
      if (this._fragLen > this._max) { this._protocolError('message larger than maxMessageBytes'); return; }
      if (fin) {
        const msg = Buffer.concat(this._frag);
        this._frag = null;
        this._emit('message', { data: this._fragOp === 0x1 ? msg.toString('utf8') : msg });
      }
    }
  }

  /** @param {string} why */
  _protocolError(why) {
    if (this._sock && !this._closeSent) {
      this._closeSent = true;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(1002);
      try { this._sendFrame(0x8, p); } catch { /* gone */ }
    }
    this._fail(`websocket protocol error: ${why}`);
  }

  /** @param {string} message */
  _fail(message) {
    if (this.readyState === CLOSED) return;
    this._emit('error', { message });
    this._onClose();
  }

  _onClose() {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.readyState = CLOSED;
    try { if (this._sock) this._sock.destroy(); } catch { /* gone */ }
    this._emit('close', {});
  }
}

/**
 * A `WebSocketImpl` for `CdpSession`, bound to one unix socket and Host header.
 * @param {{socketPath: string, hostHeader: string}} o
 * @returns {new (url: string) => UnixWebSocket}
 */
export function unixWebSocketImpl(o) {
  return class BoundUnixWebSocket extends UnixWebSocket {
    /** @param {string} url */
    constructor(url) { super(url, o); }
  };
}
