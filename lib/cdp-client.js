// lib/cdp-client.js — zero-dependency Chrome DevTools Protocol client.
//
// base shipped the whole browser-location chain and no command client, so every
// tool in the family wrote its own. Four existed: substack's (built-in
// WebSocket), the extension lane's (substack's, widened), and hand-rolled
// RFC6455 implementations in chatgpt, linkedin and telegram. This is the
// extraction that stops that at four.
//
// PROVENANCE, because it matters for what is trustworthy here:
//   * the SESSION/TRANSPORT half is substack-webctl's, which runs in production
//     against real pages. It is carried over rather than rewritten.
//   * the TARGET-DISCOVERY half is the claude-chrome-extension lane's rewrite
//     of it, which fixed two defects in the original (below).
//
// ⚠ TWO DEFECTS THE DISCOVERY REWRITE FIXED, both of which failed SILENTLY:
//
//  1. `listPageTargets()` ended in `.filter(t => t.type === 'page')`. Correct
//     for a per-SITE tool, where the page IS the target. Wrong for anything
//     looking at an extension, which lives in a `service_worker` target and has
//     no page at all — so the thing being looked for was invisible, and the
//     symptom was an empty list rather than an error.
//
//  2. ⭐ `GET /json` IS NOT AUTHORITATIVE. Its membership has varied across
//     Chromium versions and it does not reliably enumerate service_worker
//     targets. The authoritative source is `Target.getTargets` on the BROWSER
//     websocket — what the browser itself uses. ⇒ ASSERTING AN ABSENCE ON THE
//     HTTP LIST YIELDS A RESULT INDISTINGUISHABLE FROM "NOT RUNNING", which for
//     any probe is the one wrong answer that looks like a finding.
//
// ⛔ THREE THINGS FROM THE CONTRIBUTED FILE ARE DELIBERATELY NOT HERE. The
// contributing lane marked them as not-for-base and I am treating that as
// binding rather than advisory:
//   * the OBSERVER-ONLY guard (`readOnly` + a method allowlist) — a capability
//     posture for one axis; every other consumer drives by design.
//   * the CREDENTIAL deny-list — ruled by webctl:mgr as scoped to one repo's
//     threat model. substack-webctl legitimately reads cookies to answer "am I
//     logged in" (anchor: `grep -rn 'XREF:substack-auth-status-cookie-read'`),
//     and promoting the list would break a wired, green consumer. Re-checked
//     2026-09-02: the `isAuthenticated()` replacement has NOT landed, so the
//     exclusion still stands. ⇒ A RULING MADE FOR ONE REPO'S THREAT MODEL IS
//     NOT A FAMILY DEFAULT.
//   * `EXTENSION_BACKGROUND_TYPES` — per-axis vocabulary. `types` is one
//     argument away, so a consumer supplies its own.
//
// Zero-dep: Node's built-in `WebSocket` and `fetch` (>=22.12). No top-level
// await, so consumers can `require()` this from CJS.
//
// Tag: [WEBCTL::CDP]

import { rewriteWsUrl, rewriteTargetList } from './browser-location/cdp-rewrite.js';

/** @typedef {{id?: string, type?: string, url?: string, title?: string, webSocketDebuggerUrl?: string}} TargetInfo */

/**
 * A single CDP websocket session. Carried over from substack-webctl unchanged
 * in behaviour: built-in WebSocket, id-correlated request/response, event
 * subscription, and eval helpers.
 */
export class CdpSession {
  /**
   * @param {string} wsUrl
   * @param {{defaultTimeout?: number}} [opts]
   */
  constructor(wsUrl, { defaultTimeout = 15000 } = {}) {
    this.wsUrl = wsUrl;
    this.defaultTimeout = defaultTimeout;
    this.ws = /** @type {any} */ (null);
    this._id = 0;
    this._pending = new Map();
    /** @type {Map<string, Function[]>} */
    this._handlers = new Map();
  }

  /** @returns {Promise<CdpSession>} */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', (/** @type {any} */ e) =>
        reject(new Error(`CDP websocket error for ${this.wsUrl}: ${e && e.message ? e.message : 'unknown'}`)));
      ws.addEventListener('close', () => {
        // Fail every in-flight call rather than leaving callers hanging on a
        // socket that will never answer.
        for (const [, p] of this._pending) {
          p.reject(new Error('CDP websocket closed before the reply arrived'));
        }
        this._pending.clear();
      });
      ws.addEventListener('message', (/** @type {any} */ ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer } = this._pending.get(msg.id);
          clearTimeout(timer);
          this._pending.delete(msg.id);
          if (msg.error) rej(new Error(`CDP ${msg.error.message || 'error'} (code ${msg.error.code})`));
          else res(msg.result);
          return;
        }
        if (msg.method && this._handlers.has(msg.method)) {
          for (const h of this._handlers.get(msg.method) || []) h(msg.params);
        }
      });
    });
  }

  /**
   * Send a CDP command.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeout]
   * @returns {Promise<any>}
   */
  cdp(method, params = {}, timeout = this.defaultTimeout) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeout}ms`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** @param {string} method @param {Function} handler */
  on(method, handler) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    (this._handlers.get(method) || []).push(handler);
  }

  /** @param {string} method @param {number} [timeout] */
  waitForEvent(method, timeout = this.defaultTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP event ${method} did not arrive within ${timeout}ms`)), timeout);
      this.on(method, (/** @type {any} */ params) => { clearTimeout(timer); resolve(params); });
    });
  }

  /** @param {string} expression @param {number} [timeout] */
  async eval(expression, timeout = this.defaultTimeout) {
    const r = await this.cdp('Runtime.evaluate', { expression, returnByValue: true }, timeout);
    return r && r.result ? r.result.value : undefined;
  }

  /** @param {string} expression @param {number} [timeout] */
  async evalAsync(expression, timeout = this.defaultTimeout) {
    const r = await this.cdp('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, timeout);
    return r && r.result ? r.result.value : undefined;
  }

  close() {
    try { this.ws && this.ws.close(); } catch { /* already gone */ }
  }
}

/**
 * `GET /json/version`, with the browser websocket URL host-rewritten.
 * @param {string} base
 * @param {{host?: string, port?: number|string}} [opts]
 */
export async function getVersion(base, { host = '127.0.0.1', port } = {}) {
  const p = port || new URL(base).port;
  const resp = await fetch(`${base}/json/version`);
  if (!resp.ok) throw new Error(`GET ${base}/json/version -> ${resp.status}`);
  const v = /** @type {{webSocketDebuggerUrl?: string, [k: string]: any}} */ (await resp.json());
  if (typeof v.webSocketDebuggerUrl === 'string') {
    v.webSocketDebuggerUrl = rewriteWsUrl(v.webSocketDebuggerUrl, host, p);
  }
  return v;
}

/**
 * Open a session on the BROWSER target rather than a page.
 * @param {string} base
 * @param {{host?: string, port?: number|string, defaultTimeout?: number}} [opts]
 */
export async function connectBrowser(base, { host = '127.0.0.1', port, defaultTimeout = 15000 } = {}) {
  const p = port || new URL(base).port;
  const v = await getVersion(base, { host, port: p });
  if (!v.webSocketDebuggerUrl) {
    throw new Error(`${base}/json/version has no webSocketDebuggerUrl — cannot reach the browser target`);
  }
  return new CdpSession(v.webSocketDebuggerUrl, { defaultTimeout }).connect();
}

/**
 * ⭐ AUTHORITATIVE target enumeration, via `Target.getTargets` on the browser
 * websocket. Use this — not the HTTP list — whenever an ABSENCE would be read
 * as a finding.
 *
 * @param {string} base
 * @param {{host?: string, port?: number|string, types?: string[]|null}} [opts]
 *   `types` omitted/null returns every type.
 * @returns {Promise<TargetInfo[]>}
 */
export async function listTargetsViaBrowser(base, { host = '127.0.0.1', port, types = null } = {}) {
  const session = await connectBrowser(base, { host, port });
  try {
    const r = await session.cdp('Target.getTargets', {});
    const infos = (r && r.targetInfos) || [];
    return types ? infos.filter((/** @type {TargetInfo} */ t) => types.includes(String(t.type))) : infos;
  } finally {
    session.close();
  }
}

/**
 * CONVENIENCE target enumeration via `GET /json`, host-rewritten.
 *
 * Kept because it is the only list carrying a per-target
 * `webSocketDebuggerUrl` you can attach to directly, and because corroborating
 * two independent sources beats trusting one. ⚠ Do NOT use it alone to conclude
 * something is ABSENT — see the header.
 *
 * @param {string} base
 * @param {{host?: string, port?: number|string, types?: string[]|null, requireWs?: boolean}} [opts]
 * @returns {Promise<TargetInfo[]>}
 */
export async function listTargets(base, { host = '127.0.0.1', port, types = null, requireWs = false } = {}) {
  const p = port || new URL(base).port;
  const resp = await fetch(`${base}/json`);
  if (!resp.ok) throw new Error(`GET ${base}/json -> ${resp.status}`);
  const json = /** @type {any[]} */ (await resp.json());
  const targets = rewriteTargetList(json, host, p).filter(Boolean);
  return targets.filter((/** @type {TargetInfo} */ t) =>
    (!types || types.includes(String(t.type))) && (!requireWs || !!t.webSocketDebuggerUrl));
}

/**
 * Page targets only — the original per-site behaviour, preserved by name so
 * existing callers are unchanged. A thin wrapper over `listTargets`.
 * @param {string} base
 * @param {{host?: string, port?: number|string}} [opts]
 */
export function listPageTargets(base, opts = {}) {
  return listTargets(base, { ...opts, types: ['page'], requireWs: true });
}

/**
 * Enumerate from BOTH sources and report them separately, because a
 * disagreement between them is itself a finding.
 *
 * `targets` comes from the AUTHORITATIVE browser endpoint. The HTTP list is
 * corroboration, never the answer.
 *
 * ⭐ A DISAGREEMENT IS LOUD BY DEFAULT, and that is the point rather than a
 * nicety. A `sourcesAgree` boolean that nobody reads — or that is logged at
 * debug level — is the same silent winner-picking this function exists to
 * prevent, with a paper trail nobody opens. So when the sources disagree it
 * WARNS through the injected logger unless the caller explicitly opts out by
 * passing `onDisagree: null`, which is a decision rather than an omission.
 *
 * @param {string} base
 * @param {{
 *   host?: string, port?: number|string, types?: string[]|null,
 *   onDisagree?: ((info: {viaBrowser: TargetInfo[], viaHttp: TargetInfo[], httpError: Error|null}) => void)|null,
 * }} [opts]
 * @returns {Promise<{targets: TargetInfo[], viaBrowser: TargetInfo[], viaHttp: TargetInfo[],
 *                    sourcesAgree: boolean, httpError: Error|null}>}
 */
export async function listTargetsCorroborated(base, opts = {}) {
  const { host = '127.0.0.1', port, types = null } = opts;
  const onDisagree = opts.onDisagree === undefined ? defaultOnDisagree : opts.onDisagree;

  const viaBrowser = await listTargetsViaBrowser(base, { host, port, types });

  /** @type {TargetInfo[]} */
  let viaHttp = [];
  /** @type {Error|null} */
  let httpError = null;
  try {
    viaHttp = await listTargets(base, { host, port, types });
  } catch (err) {
    // The HTTP list failing is NOT a reason to fail the call — it is the weaker
    // source. But it must not silently look like agreement either.
    httpError = /** @type {Error} */ (err);
  }

  const key = (/** @type {TargetInfo[]} */ ts) =>
    ts.map((t) => `${t.type}:${t.id || t.url || ''}`).sort().join('|');
  const sourcesAgree = httpError === null && key(viaBrowser) === key(viaHttp);

  if (!sourcesAgree && onDisagree) onDisagree({ viaBrowser, viaHttp, httpError });

  return { targets: viaBrowser, viaBrowser, viaHttp, sourcesAgree, httpError };
}

/** @param {{viaBrowser: TargetInfo[], viaHttp: TargetInfo[], httpError: Error|null}} info */
function defaultOnDisagree(info) {
  const why = info.httpError
    ? `the HTTP list could not be read (${info.httpError.message})`
    : `browser reports ${info.viaBrowser.length} target(s), HTTP reports ${info.viaHttp.length}`;
  // stderr, not a debug channel: the whole value of noticing a disagreement is
  // that somebody sees it.
  console.warn(
    `[WEBCTL::CDP] target sources DISAGREE — ${why}. ` +
    'The browser endpoint is authoritative; the HTTP list is not reliable for ' +
    'service_worker targets. Treating an absence here as a finding would be unsafe.',
  );
}

// ── page lifecycle ───────────────────────────────────────────────────────────
//
// Carried over from substack-webctl with its semantics intact. Three decisions
// in here are HARD-WON ENVIRONMENT KNOWLEDGE rather than style, and a
// reimplementation gets all three wrong by default — which is the whole
// argument for sharing them instead of each tool rediscovering them:
//
//  1. REUSE BEFORE MINTING. An existing page target is reused rather than a new
//     tab opened, because minting per operation leaks tabs across a long run
//     (measured over 220 pages). Re-navigating one tab is what a human does.
//  2. `/json/new` IS A FALLBACK, NOT THE PRIMARY PATH, and it tries PUT then
//     GET. ⭐ THAT ENDPOINT IS RESTRICTED OR DISABLED IN SOME CHROMIUM BUILDS.
//     A client that mints first works on the author's machine and fails on
//     someone else's build, which is the most expensive way to learn this.
//  3. ⛔ ONLY CLOSE THE TAB YOU MINTED. A reused tab is the browser's own —
//     frequently its ONLY page — and closing it tears down the session the
//     caller is standing on. `reused` is returned so the caller cannot get this
//     wrong by accident, and `close()` already encodes it.

/**
 * Open a page session: reuse an existing page target if there is one, else
 * mint a tab via `/json/new`.
 *
 * @param {string} base
 * @param {{host?: string, port?: number|string, startUrl?: string, defaultTimeout?: number}} [opts]
 * @returns {Promise<{session: CdpSession, targetId: string, reused: boolean}>}
 */
export async function openPage(base, { host = '127.0.0.1', port, startUrl = 'about:blank', defaultTimeout = 15000 } = {}) {
  const p = port || new URL(base).port;

  const existing = await listPageTargets(base, { host, port: p });
  if (existing.length > 0) {
    const target = existing[0];
    const session = await new CdpSession(String(target.webSocketDebuggerUrl), { defaultTimeout }).connect();
    return { session, targetId: String(target.id), reused: true };
  }

  /** @type {any} */
  let target;
  for (const method of ['PUT', 'GET']) {
    try {
      const resp = await fetch(`${base}/json/new?${encodeURIComponent(startUrl)}`, { method });
      if (resp.ok) { target = await resp.json(); break; }
    } catch { /* older builds reject one verb; try the other */ }
  }
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error(
      `No existing page target, and could not mint one via ${base}/json/new (tried PUT+GET). ` +
      'That endpoint is restricted or disabled in some chromium builds. ' +
      "Is the container's chromium up with at least one tab?",
    );
  }
  const session = await new CdpSession(rewriteWsUrl(target.webSocketDebuggerUrl, host, p), { defaultTimeout }).connect();
  return { session, targetId: String(target.id), reused: false };
}

/**
 * Close a page target by id. Best-effort — a failure here must not mask the
 * caller's actual result.
 * @param {string} base
 * @param {string} targetId
 */
export async function closePage(base, targetId) {
  try { await fetch(`${base}/json/close/${targetId}`); } catch { /* best-effort */ }
}

/**
 * Navigate to `url` and wait for load, optionally until an in-page predicate
 * holds or a settle timeout elapses (client-rendered content).
 *
 * Returns the session plus a `close()` that already encodes decision 3 above:
 * it closes the TAB only if this call minted it.
 *
 * @param {string} base
 * @param {string} url
 * @param {{host?: string, port?: number|string, loadTimeout?: number,
 *          waitForExpr?: string|null, waitForTimeout?: number, settleMs?: number}} [opts]
 */
export async function navigate(base, url, opts = {}) {
  const {
    host = '127.0.0.1', port, loadTimeout = 30000,
    waitForExpr = null, waitForTimeout = 15000, settleMs = 800,
  } = opts;
  const { session, targetId, reused } = await openPage(base, { host, port });
  await session.cdp('Page.enable');
  const loaded = session.waitForEvent('Page.loadEventFired', loadTimeout).catch(() => null);
  await session.cdp('Page.navigate', { url });
  await loaded;

  if (waitForExpr) {
    const deadline = Date.now() + waitForTimeout;
    for (;;) {
      let ok = false;
      try { ok = await session.eval(`!!(${waitForExpr})`); } catch { ok = false; }
      if (ok) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));

  const close = async () => {
    session.close();
    // ⛔ Only the minted tab. Closing a REUSED tab tears down the browser's own
    // page — often its only one — and with it the session the caller depends on.
    if (!reused) await closePage(base, targetId);
  };
  return { session, targetId, reused, close };
}
