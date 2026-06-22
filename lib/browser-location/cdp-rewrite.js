// Rewrite CDP WebSocket URLs so they point at the host-side
// loopback rather than the container's view of itself.
//
// Why this exists
// ---------------
// Chromium's /json/version response embeds a `webSocketDebuggerUrl`
// computed from the address it bound to. In our docker-xpra mode that
// address is the container-internal loopback (127.0.0.1:9222 inside
// the chromium netns); after the socat relay forwards it out through
// `docker run -p 127.0.0.1:4327:4327`, the host sees the listener on
// 127.0.0.1:4327. The host-side CDP client must connect there.
//
// Puppeteer does the same trick — it fetches /json/version, then
// rewrites the host portion of every ws:// URL to the desired
// host:port before opening the WebSocket. Pure function, easy to test.
//
// Tag: [TOOL::*] [WEBCTL::CDP]
//
// base-webctl ESM port (sb7q): zero-dep, JSDoc-typed, no top-level await
// (keeps the synchronous require(esm) consumption path valid).

/**
 * Rewrite a single ws:// (or wss://) URL's authority to `host:port`.
 * Preserves the path and query string.
 *
 * @param {string} wsUrl
 * @param {string} host
 * @param {number|string} port
 * @returns {string}
 */
export function rewriteWsUrl(wsUrl, host, port) {
  if (typeof wsUrl !== 'string') return wsUrl;
  const m = wsUrl.match(/^(wss?:\/\/)([^\/]+)(\/.*)?$/);
  if (!m) return wsUrl;
  const scheme = m[1];
  const rest = m[3] || '';
  return `${scheme}${host}:${port}${rest}`;
}

/**
 * Rewrite the host:port in a /json/version response object.
 * Returns a NEW object (does not mutate input).
 *
 * @param {Record<string, any>} versionResp  parsed JSON from GET /json/version
 * @param {string} host
 * @param {number|string} port
 * @returns {Record<string, any>}
 */
export function rewriteVersionResponse(versionResp, host, port) {
  if (!versionResp || typeof versionResp !== 'object') return versionResp;
  const out = Object.assign({}, versionResp);
  if (typeof out.webSocketDebuggerUrl === 'string') {
    out.webSocketDebuggerUrl = rewriteWsUrl(out.webSocketDebuggerUrl, host, port);
  }
  return out;
}

/**
 * Rewrite host:port across a /json/list response array (each target
 * has its own webSocketDebuggerUrl and devtoolsFrontendUrl).
 *
 * @param {Array<Record<string, any>>} targets
 * @param {string} host
 * @param {number|string} port
 * @returns {Array<Record<string, any>>}
 */
export function rewriteTargetList(targets, host, port) {
  if (!Array.isArray(targets)) return targets;
  return targets.map(t => {
    if (!t || typeof t !== 'object') return t;
    const out = Object.assign({}, t);
    if (typeof out.webSocketDebuggerUrl === 'string') {
      out.webSocketDebuggerUrl = rewriteWsUrl(out.webSocketDebuggerUrl, host, port);
    }
    if (typeof out.devtoolsFrontendUrl === 'string') {
      // The frontend URL embeds the ws host as `?ws=host:port/...` —
      // rewrite the embedded ws= host portion. Best-effort regex.
      out.devtoolsFrontendUrl = out.devtoolsFrontendUrl.replace(
        /(\bws=)[^\/&]+/, `$1${host}:${port}`
      );
    }
    return out;
  });
}
