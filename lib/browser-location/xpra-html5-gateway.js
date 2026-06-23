// xpra-html5 Tailnet Remote-Access Gateway — P1 (design: infra-xpra-remote-access-gateway-f6rd).
//
// A zero-dependency, WebSocket-aware reverse proxy that sits IN FRONT of the
// UNCHANGED loopback xpra-html5 server (127.0.0.1:<html5Port>) and exposes it on
// the tailnet interface only, behind a CIDR allowlist + an `enabled` toggle.
// Because the gateway is separate from the xpra session, toggling/stopping it
// never disturbs the running browser (xpra is multi-client): "toggle the gateway,
// not the session".
//
// P1 SCOPE: the proxy + tailnet-iface bind + CIDR pre-check + enabled flag. It is
// topology-agnostic (one upstream target; the per-host slug multiplexer is later).
// NOT in P1: grant store / TTL / request-authorization page / REST / CLI / the
// `tailscale whois` principal resolver (P2-P4). Every tailnet peer that passes the
// CIDR check is proxied in P1 (auth lands in P2).
//
// ZERO-DEP (sb7q/v8p3): Node stdlib only — `http` for the proxied HTTP requests,
// and on the `'upgrade'` event a raw `net.connect` to the loopback html5 + a
// bidirectional socket pump. We PROXY ws frames, we don't parse them, so no `ws`
// dependency is needed.
//
// CONSTANTS-ISOLATED (sm2t): `createXpraHtml5Gateway(C, opts)`; `C` supplies the
// log/identity prefix (more per-repo bits — default TTL, state path — arrive in P2).
//
// Tag: [WEBCTL] [WEBCTL::CDP] — remote-VIEW only; never proxies CDP or cookies.

import http from 'node:http';
import net from 'node:net';

import { assertConstants } from '../client-config.constants.template.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

/** Tailscale CGNAT range (RFC 6598) — the base-owned default tailnet allowlist. */
export const DEFAULT_CIDR_ALLOWLIST = ['100.64.0.0/10'];

/**
 * Strip an IPv6-mapped-IPv4 prefix (`::ffff:100.64.1.2` -> `100.64.1.2`).
 * @param {string|undefined|null} ip
 * @returns {string}
 */
export function normalizePeerIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Parse a dotted IPv4 to a uint32, or null if not a valid IPv4.
 * @param {string} ip
 * @returns {number|null}
 */
function ip4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}

/**
 * Is `ip` inside the IPv4 `cidr` (e.g. "100.64.0.0/10")? IPv6 peers return false
 * (P1 matches the IPv4 CGNAT default; IPv6 tailnet support is a follow-up).
 * @param {string} cidr
 * @param {string} ip
 * @returns {boolean}
 */
export function cidrContains(cidr, ip) {
  const slash = String(cidr).indexOf('/');
  if (slash < 0) return false;
  const range = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  const rInt = ip4ToInt(range);
  const ipInt = ip4ToInt(normalizePeerIp(ip));
  if (rInt === null || ipInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (rInt & mask) === (ipInt & mask);
}

/**
 * Create the xpra-html5 access-gateway controller (P1).
 *
 * @param {ClientConfigConstants} C
 * @param {{
 *   assert?: boolean,
 *   upstreamPort: number,            // the loopback xpra-html5 port (required)
 *   upstreamHost?: string,           // default '127.0.0.1'
 *   bindAddress: string,             // tailnet interface IP to listen on (required)
 *   listenPort?: number,             // gateway listen port (default 0 = ephemeral)
 *   cidrAllowlist?: string[],        // default DEFAULT_CIDR_ALLOWLIST
 *   enabled?: boolean,               // initial toggle (default true)
 *   logger?: { info?: Function, warn?: Function, debug?: Function },
 * }} opts
 * @returns {object}
 */
export function createXpraHtml5Gateway(C, opts) {
  const o = opts || /** @type {any} */ ({});
  if (o.assert !== false) assertConstants(C, { context: 'createXpraHtml5Gateway' });
  if (typeof o.upstreamPort !== 'number') throw new Error('createXpraHtml5Gateway: opts.upstreamPort (number) required');
  if (!o.bindAddress) throw new Error('createXpraHtml5Gateway: opts.bindAddress required (the tailnet interface IP)');

  const upstreamHost = o.upstreamHost || '127.0.0.1';
  const upstreamPort = o.upstreamPort;
  const bindAddress  = o.bindAddress;
  const listenPort   = typeof o.listenPort === 'number' ? o.listenPort : 0;
  const cidrAllowlist = Array.isArray(o.cidrAllowlist) && o.cidrAllowlist.length
    ? o.cidrAllowlist.slice() : DEFAULT_CIDR_ALLOWLIST.slice();
  const LOG = `[${C.PROJECT}][xpra-gateway]`;
  const _L = o.logger || {};
  const logger = {
    info:  _L.info  || ((/** @type {string} */ m) => process.stderr.write(m + '\n')),
    warn:  _L.warn  || ((/** @type {string} */ m) => process.stderr.write(m + '\n')),
    debug: _L.debug || (() => {}),
  };

  let enabled = o.enabled !== false;
  /** @type {http.Server|null} */
  let server = null;

  /** @param {string} ip @returns {boolean} */
  function isPeerAllowed(ip) {
    const peer = normalizePeerIp(ip);
    return cidrAllowlist.some(c => cidrContains(c, peer));
  }

  /**
   * Gate a connection: returns null if allowed, else {code, msg} to refuse with.
   * Order matches the design: CIDR pre-check, then enabled.
   * @param {string} ip
   */
  function gate(ip) {
    if (!isPeerAllowed(ip)) return { code: 403, msg: 'network not allowed (off-tailnet)' };
    if (!enabled) return { code: 503, msg: 'remote access disabled' };
    return null;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function onRequest(req, res) {
    const peer = normalizePeerIp(req.socket.remoteAddress || '');
    const deny = gate(peer);
    if (deny) {
      res.writeHead(deny.code, { 'content-type': 'text/plain' });
      res.end(deny.msg + '\n');
      return;
    }
    const proxyReq = http.request({
      host: upstreamHost, port: upstreamPort, method: req.method,
      path: req.url, headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (/** @type {any} */ e) => {
      logger.warn(`${LOG} upstream HTTP error: ${e && e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream error\n');
    });
    req.pipe(proxyReq);
  }

  /** @param {http.IncomingMessage} req @param {import('node:stream').Duplex} clientSocket @param {Buffer} head */
  function onUpgrade(req, clientSocket, head) {
    const peer = normalizePeerIp(req.socket.remoteAddress || '');
    const deny = gate(peer);
    if (deny) {
      const status = deny.code === 403 ? '403 Forbidden' : '503 Service Unavailable';
      clientSocket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n${deny.msg}\n`);
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      // Replay the upgrade request verbatim, then pump bytes both ways. We never
      // parse WS frames — pure transport relay (zero-dep).
      let head_ = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        head_ += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      head_ += '\r\n';
      upstream.write(head_);
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', (/** @type {any} */ e) => {
      logger.warn(`${LOG} upstream WS error: ${e && e.message}`);
      clientSocket.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
  }

  /** @returns {Promise<{host: string, port: number}>} */
  function start() {
    if (server) return Promise.resolve({ host: bindAddress, port: /** @type {any} */ (server.address()).port });
    return new Promise((resolve, reject) => {
      const s = http.createServer(onRequest);
      s.on('upgrade', onUpgrade);
      s.on('error', reject);
      s.listen(listenPort, bindAddress, () => {
        server = s;
        const addr = /** @type {any} */ (s.address());
        logger.info(`${LOG} listening on ${bindAddress}:${addr.port} -> ${upstreamHost}:${upstreamPort} (enabled=${enabled}, allow=${cidrAllowlist.join(',')})`);
        resolve({ host: bindAddress, port: addr.port });
      });
    });
  }

  /** @returns {Promise<void>} */
  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = null;
      s.close(() => resolve());
    });
  }

  return {
    start,
    stop,
    setEnabled: (/** @type {boolean} */ b) => { enabled = !!b; logger.debug(`${LOG} enabled=${enabled}`); },
    isEnabled: () => enabled,
    isPeerAllowed,
    port: () => (server ? /** @type {any} */ (server.address()).port : null),
  };
}
