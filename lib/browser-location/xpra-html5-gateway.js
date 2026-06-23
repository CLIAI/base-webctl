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
 *   enabled?: boolean,               // initial toggle (default true; ignored when accessStore present)
 *   logger?: { info?: Function, warn?: Function, debug?: Function },
 *   accessStore?: any,               // P2: createAccessStore() — enables auth gating + REST. absent => P1 (proxy all tailnet peers)
 *   resolvePrincipal?: (ip: string) => string,  // P2: peer -> principal (default: the IP; whois resolver is P4)
 *   operatorToken?: string|null,     // P2: bearer token authorizing a non-loopback operator (loopback is always operator)
 *   htmlAuthPage?: (ctx: {principal: string, project: string}) => string,  // override the request-authorization page
 *   peerOf?: (req: any) => string,   // TEST seam: resolve the peer IP (default: socket remoteAddress; never a forwarded header)
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

  let enabledInMemory = o.enabled !== false;
  // P2 seams (all optional — absent => P1 behaviour: proxy every tailnet peer).
  const accessStore = o.accessStore || null;
  const resolvePrincipal = o.resolvePrincipal || ((/** @type {string} */ ip) => normalizePeerIp(ip));
  const operatorToken = o.operatorToken || null;
  const renderAuthPage = o.htmlAuthPage || defaultAuthPage;
  // Peer-IP resolver. Default = the real socket address (NEVER a forwarded header —
  // the gateway binds the tailnet iface directly). Injectable for hermetic tests.
  const peerOf = o.peerOf || ((/** @type {any} */ req) => normalizePeerIp(req.socket.remoteAddress || ''));
  /** @type {http.Server|null} */
  let server = null;

  function isEnabled() { return accessStore ? accessStore.isEnabled() : enabledInMemory; }
  function setEnabled(/** @type {boolean} */ b) {
    if (accessStore) accessStore.setEnabled(!!b);
    else enabledInMemory = !!b;
    logger.debug(`${LOG} enabled=${isEnabled()}`);
  }

  /** @param {string} ip @returns {boolean} */
  function isPeerAllowed(ip) {
    const peer = normalizePeerIp(ip);
    return cidrAllowlist.some(c => cidrContains(c, peer));
  }

  /** Loopback is always trusted (localhost-always-trusted; the local operator/CLI).
   * @param {string} ip */
  function isLoopback(ip) {
    const p = normalizePeerIp(ip);
    return p === '::1' || cidrContains('127.0.0.0/8', p);
  }

  /** Operator = loopback OR a matching bearer token.
   * @param {any} req @param {string} peer */
  function isOperator(req, peer) {
    if (isLoopback(peer)) return true;
    if (operatorToken && req.headers['x-xpra-access-token'] === operatorToken) return true;
    return false;
  }

  /** Does this principal currently have proxy access? loopback always; else a live grant.
   * @param {string} peer */
  function isAuthorized(peer) {
    if (isLoopback(peer)) return true;
    if (!accessStore) return true; // P1: no store => any tailnet peer is allowed
    return accessStore.isGranted(resolvePrincipal(peer));
  }

  /** @param {http.ServerResponse} res @param {number} code @param {any} obj */
  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body + '\n');
  }

  /** Emit an lszd audit envelope (attributable access events).
   * @param {string} action @param {any} fields */
  function audit(action, fields) {
    try {
      logger.info(JSON.stringify({ type: 'xpra-access', ts: new Date().toISOString(), tool: C.PROJECT, action, ...fields }));
    } catch (_) { /* never let audit break a request */ }
  }

  /**
   * Handle the /access/* REST surface. Returns true if it owned the request.
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} peer
   */
  async function handleRest(req, res, peer) {
    const url = (req.url || '').split('?')[0];
    const principalOfPeer = resolvePrincipal(peer);

    // The ONLY pre-auth-open path: a viewer requesting access.
    if (req.method === 'POST' && url === '/access/request') {
      const body = await readJsonBody(req);
      if (accessStore) accessStore.addRequest(principalOfPeer, { who: body.who, note: body.note });
      audit('request', { principal: principalOfPeer, who: body.who || null });
      sendJson(res, 200, { requested: true, principal: principalOfPeer });
      return true;
    }

    // Everything else under /access/ is operator-only.
    if (!isOperator(req, peer)) {
      sendJson(res, 403, { error: 'operator only (loopback or operator token)' });
      return true;
    }
    if (!accessStore) { sendJson(res, 501, { error: 'no access store configured' }); return true; }

    if (req.method === 'GET' && url === '/access/status') {
      sendJson(res, 200, { enabled: isEnabled(), grants: accessStore.listGrants(), requests: accessStore.listRequests() });
      return true;
    }
    if (req.method === 'GET' && url === '/access/requests') { sendJson(res, 200, { requests: accessStore.listRequests() }); return true; }
    if (req.method === 'GET' && url === '/access/grants')   { sendJson(res, 200, { grants: accessStore.listGrants() }); return true; }
    if (req.method === 'POST' && url === '/access/approve') {
      const b = await readJsonBody(req);
      if (!b.principal) { sendJson(res, 400, { error: 'principal required' }); return true; }
      const grant = accessStore.approve(b.principal, { ttl: b.ttl, grantedBy: principalOfPeer });
      audit('approve', { principal: b.principal, ttl: grant.ttl, grantedBy: principalOfPeer });
      sendJson(res, 200, { approved: true, principal: b.principal, grant });
      return true;
    }
    if (req.method === 'POST' && (url === '/access/reject' || url === '/access/revoke')) {
      const b = await readJsonBody(req);
      if (!b.principal) { sendJson(res, 400, { error: 'principal required' }); return true; }
      const ok = url === '/access/reject' ? accessStore.reject(b.principal) : accessStore.revoke(b.principal);
      audit(url.slice('/access/'.length), { principal: b.principal, by: principalOfPeer });
      sendJson(res, 200, { ok, principal: b.principal });
      return true;
    }
    if (req.method === 'POST' && (url === '/access/enable' || url === '/access/disable')) {
      setEnabled(url === '/access/enable');
      audit(url.slice('/access/'.length), { by: principalOfPeer });
      sendJson(res, 200, { enabled: isEnabled() });
      return true;
    }
    sendJson(res, 404, { error: `no such access endpoint: ${req.method} ${url}` });
    return true;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function onRequest(req, res) {
    const peer = peerOf(req);

    // 1. tailnet check (loopback always trusted), BEFORE anything else.
    if (!isLoopback(peer) && !isPeerAllowed(peer)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('network not allowed (off-tailnet)\n');
      return;
    }

    // 2. /access/* REST surface (works even when disabled, so the operator can enable).
    if ((req.url || '').startsWith('/access/')) {
      await handleRest(req, res, peer);
      return;
    }

    // 3. enabled? (proxy path only)
    if (!isEnabled()) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('remote access disabled\n');
      return;
    }

    // 4. authorized? else serve the request-authorization page (HTML) / JSON (API).
    if (!isAuthorized(peer)) {
      const principal = resolvePrincipal(peer);
      if (wantsHtml(req)) {
        const html = renderAuthPage({ principal, project: C.PROJECT });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        sendJson(res, 401, { error: 'authorization required', principal, requestPath: '/access/request' });
      }
      return;
    }

    // 5. proxy.
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
    const peer = peerOf(req);
    // Same gate as the proxy path, but a WS upgrade can't render an HTML auth
    // page — refuse with a status line. CIDR -> enabled -> authorized.
    let deny = null;
    if (!isLoopback(peer) && !isPeerAllowed(peer)) deny = { code: '403 Forbidden', msg: 'network not allowed (off-tailnet)' };
    else if (!isEnabled()) deny = { code: '503 Service Unavailable', msg: 'remote access disabled' };
    else if (!isAuthorized(peer)) deny = { code: '401 Unauthorized', msg: 'authorization required (POST /access/request)' };
    if (deny) {
      clientSocket.write(`HTTP/1.1 ${deny.code}\r\nConnection: close\r\n\r\n${deny.msg}\n`);
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
      const s = http.createServer((req, res) => {
        // onRequest is async; never let a rejection crash the server.
        Promise.resolve(onRequest(req, res)).catch((e) => {
          logger.warn(`${LOG} request handler error: ${e && e.message}`);
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          try { res.end('internal error\n'); } catch (_) { /* socket gone */ }
        });
      });
      s.on('upgrade', onUpgrade);
      s.on('error', reject);
      s.listen(listenPort, bindAddress, () => {
        server = s;
        const addr = /** @type {any} */ (s.address());
        logger.info(`${LOG} listening on ${bindAddress}:${addr.port} -> ${upstreamHost}:${upstreamPort} (enabled=${isEnabled()}, store=${!!accessStore}, allow=${cidrAllowlist.join(',')})`);
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
    setEnabled,
    isEnabled,
    isPeerAllowed,
    isAuthorized: (/** @type {string} */ ip) => isAuthorized(normalizePeerIp(ip)),
    port: () => (server ? /** @type {any} */ (server.address()).port : null),
  };
}

/** Does the request prefer an HTML response (a browser)? @param {http.IncomingMessage} req */
function wantsHtml(req) {
  return /\btext\/html\b/.test(String(req.headers.accept || ''));
}

/** Collect + JSON-parse a request body (tolerant: empty/invalid -> {}). @param {http.IncomingMessage} req @returns {Promise<any>} */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** Default request-authorization HTML page (a tiny form posting to /access/request). */
function defaultAuthPage(/** @type {{principal: string, project: string}} */ ctx) {
  const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ctx.project)} — request access</title>
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}
button{font:inherit;padding:.5rem 1rem}input,textarea{font:inherit;width:100%;margin:.3rem 0 1rem;padding:.4rem}</style>
</head><body>
<h1>Access requires authorization</h1>
<p>You reached <strong>${esc(ctx.project)}</strong>'s remote view as
<code>${esc(ctx.principal)}</code>. Request access; an operator will approve it
(time-limited).</p>
<form id="f"><label>Who are you?<input name="who" placeholder="name"></label>
<label>Note (optional)<textarea name="note" rows="2"></textarea></label>
<button type="submit">Request access</button></form>
<p id="msg"></p>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/access/request', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ who: fd.get('who'), note: fd.get('note') }) });
  document.getElementById('msg').textContent = r.ok
    ? 'Requested — ask the operator to approve, then refresh.' : 'Request failed.';
});
</script></body></html>`;
}
