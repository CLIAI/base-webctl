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

/**
 * ⚠ THE TWO SOURCES NAME THE SAME FIELD DIFFERENTLY. `Target.getTargets` (the
 * browser endpoint) returns rows keyed `targetId`; `GET /json` returns rows
 * keyed `id`. Both are carried here, and `listTargetsViaBrowser` NORMALISES so
 * that `id` is always populated — otherwise anything comparing the two sources
 * is comparing different key spaces.
 * @typedef {{id?: string, targetId?: string, type?: string, url?: string,
 *            title?: string, webSocketDebuggerUrl?: string}} TargetInfo
 */

/**
 * A single CDP websocket session. Carried over from substack-webctl unchanged
 * in behaviour: built-in WebSocket, id-correlated request/response, event
 * subscription, and eval helpers.
 */
export class CdpSession {
  /**
   * @param {string} wsUrl
   * @param {{defaultTimeout?: number, WebSocketImpl?: any}} [opts]
   *
   * ⚠ `WebSocketImpl` exists so the close/error paths can be tested at all.
   * They had no test because the socket was not injectable, and the defect below
   * lived in exactly that untested path — found by a consumer's live QA, not here.
   *
   * ⛔ Unknown option keys are REFUSED (v7x3), as in the factories:
   * `new CdpSession(url, {readOnly: true})` used to return an unguarded session
   * that looked guarded. A subclass strips its own keys before `super()`.
   */
  constructor(wsUrl, opts = {}) {
    refuseUnknownOptions('CdpSession', opts, CDP_SESSION_OPTIONS);
    const { defaultTimeout = 15000, WebSocketImpl } = opts;
    this.wsUrl = wsUrl;
    this.defaultTimeout = defaultTimeout;
    this.WebSocketImpl = WebSocketImpl || WebSocket;
    this.ws = /** @type {any} */ (null);
    this._id = 0;
    this._pending = new Map();
    /**
     * Timers owned by pending `waitForEvent` calls. ⛔ These were untracked, so a
     * socket close could not clear them — see the close handler.
     * @type {Set<{timer: any, reject: Function, method: string}>}
     */
    this._waiters = new Set();
    /** @type {Map<string, Function[]>} */
    this._handlers = new Map();
  }

  /** @returns {Promise<CdpSession>} */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', (/** @type {any} */ e) =>
        reject(new Error(`CDP websocket error for ${this.wsUrl}: ${e && e.message ? e.message : 'unknown'}`)));
      ws.addEventListener('close', () => {
        // Fail every in-flight call rather than leaving callers hanging on a
        // socket that will never answer.
        //
        // ⛔ AND CLEAR THEIR TIMERS. Rejecting a pending call without clearing its
        // timer leaves an ARMED timer holding the event loop open until it fires,
        // so a process that finished its work in under a second stayed alive for
        // the full command timeout. Measured by a consumer's live QA: 15.7 s of
        // wall clock for 0.39 s of work, after every command that had evaluated.
        // ⇒ The rejection was correct and the cleanup was missing, which is why
        // nothing looked broken — the caller got its error, on time.
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error('CDP websocket closed before the reply arrived'));
        }
        this._pending.clear();

        // ⚠ waitForEvent() had the SAME defect and a worse symptom: its timer was
        // cleared only when the event ARRIVED, so on a close its caller waited the
        // entire timeout and then failed with "did not arrive" — a true sentence
        // that names the wrong cause.
        for (const w of this._waiters) {
          clearTimeout(w.timer);
          w.reject(new Error(
            `CDP websocket closed while waiting for event ${w.method}`));
        }
        this._waiters.clear();
      });
      ws.addEventListener('message', (/** @type {any} */ ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer } = this._pending.get(msg.id);
          clearTimeout(timer);
          this._pending.delete(msg.id);
          // `cdpError` marks an ANSWER ("no") as distinct from a lost reply (timeout,
          // closed socket), where the command may have taken effect.
          if (msg.error) {
            rej(Object.assign(new Error(`CDP ${msg.error.message || 'error'} (code ${msg.error.code})`),
              { cdpError: msg.error }));
          }
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
      /** @type {{timer: any, reject: Function, method: string}} */
      const entry = { timer: null, reject, method };
      entry.timer = setTimeout(() => {
        this._waiters.delete(entry);
        reject(new Error(`CDP event ${method} did not arrive within ${timeout}ms`));
      }, timeout);
      // Registered so a socket close can clear it; see the close handler.
      this._waiters.add(entry);
      this.on(method, (/** @type {any} */ params) => {
        clearTimeout(entry.timer);
        this._waiters.delete(entry);
        resolve(params);
      });
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
 * Unknown option keys are REFUSED (e.g. `readOnly`: base imposes no capability
 * posture, and an ignored guard would look applied).
 * @param {string} base
 * @param {{host?: string, port?: number|string, defaultTimeout?: number}} [opts]
 */
export async function connectBrowser(base, opts = {}) {
  refuseUnknownOptions('connectBrowser', opts, CONNECT_BROWSER_OPTIONS);
  const { host = '127.0.0.1', port, defaultTimeout = 15000 } = opts;
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
    const raw = (r && r.targetInfos) || [];
    // ⛔ NORMALISE `targetId` -> `id` BEFORE anything downstream sees these.
    // Target.getTargets keys rows `targetId`; GET /json keys them `id`. Passing
    // these through raw made every cross-source comparison compare DIFFERENT
    // KEY SPACES: browser rows fell back to the url while HTTP rows used the
    // id, so they could never match and `sourcesAgree` was false on a perfectly
    // healthy stack. `targetId` is preserved for callers that already read it.
    const infos = raw.map((/** @type {TargetInfo} */ t) => (
      t && t.id === undefined && t.targetId !== undefined ? { ...t, id: t.targetId } : t));
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
  refuseUnknownOptions('listTargetsCorroborated', opts, CORROBORATED_OPTIONS);
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

  // Identity comes from the id (normalised above so BOTH sources populate it),
  // with the url only as a fallback. A row carrying neither has no identity to
  // compare: keying it on the empty string would collapse every such row onto
  // one key — several distinct workers would read as "the same target" — so
  // that case is reported as a disagreement with its own reason rather than
  // being silently averaged away.
  const identityOf = (/** @type {TargetInfo} */ t) => t.id || t.targetId || t.url || '';
  const anyUnidentifiable = [...viaBrowser, ...viaHttp].some((t) => !identityOf(t));
  const key = (/** @type {TargetInfo[]} */ ts) =>
    ts.map((t) => `${t.type}:${identityOf(t)}`).sort().join('|');
  const sourcesAgree = httpError === null && !anyUnidentifiable && key(viaBrowser) === key(viaHttp);

  if (!sourcesAgree && onDisagree) onDisagree({ viaBrowser, viaHttp, httpError });

  return { targets: viaBrowser, viaBrowser, viaHttp, sourcesAgree, httpError };
}

/** @param {{viaBrowser: TargetInfo[], viaHttp: TargetInfo[], httpError: Error|null}} info */
function defaultOnDisagree(info) {
  const unidentifiable = [...info.viaBrowser, ...info.viaHttp]
    .filter((t) => !(t.id || t.targetId || t.url)).length;
  const why = info.httpError
    ? `the HTTP list could not be read (${info.httpError.message})`
    : unidentifiable > 0
      ? `${unidentifiable} target(s) carry neither an id nor a url, so they cannot be compared`
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
// Carried over from substack-webctl, then CHANGED in v0.32.0 (v7x3 §"base drives
// only a tab base opened"). Three decisions in here are HARD-WON ENVIRONMENT
// KNOWLEDGE rather than style, and a reimplementation gets them wrong by default:
//
//  1. ⛔ MINT BY DEFAULT; DRIVE ANOTHER TAB ONLY WHEN TOLD WHOSE IT IS.
//     SUPERSEDES the old decision 1, "REUSE BEFORE MINTING" (`existing[0]`). That
//     rule was right for an UNATTENDED browser — minting per operation leaked tabs
//     across a long run, measured over 220 pages — and it was carried over as the
//     default for a browser a PERSON is using. There, the first page target is by
//     construction the tab the human is reading: on 2026-10-03 a consumer's
//     mutation arm navigated the human's ONLY tab in a signed-in browser.
//     ⇒ The default now mints a BACKGROUND tab (`Target.createTarget`, default
//     browser context). Reuse needs `{targetId, owner}`: 'minted' (the id is in
//     `ownedTargets`) or 'adopted' (an explicit per-call adoption). An id alone is
//     refused — base cannot tell "an id I minted" from the human's tab id copied
//     out of `listPageTargets()`. The tab-leak fix survives as `keep: true` plus a
//     caller's ledger, reused later as `{owner: 'minted'}`.
//     ⛔ No "this tab is blank, so it is free" heuristic, anywhere: a URL says what
//     a tab shows, not whose it is (Opera's new-tab page is chrome://startpage).
//  2. `/json/new` IS A FALLBACK, NOT THE PRIMARY PATH, and it tries PUT then
//     GET. ⭐ THAT ENDPOINT IS RESTRICTED OR DISABLED IN SOME CHROMIUM BUILDS.
//     If both mint paths fail, openPage REFUSES — it never falls back to an
//     existing tab, which would rebuild the incident on exactly those builds.
//     Both paths dial the caller's (REWRITTEN) authority, never the raw one that
//     /json/version prints from behind an ssh forward.
//  3. ⛔ ONLY CLOSE A TAB YOU OWN, AND NEVER THE LAST PAGE. An adopted tab is never
//     closed. If ours is the only page left, closing it exits Chromium (that is how
//     the linkedin browser was lost), so close() blanks it to about:blank instead
//     and says so: `{closed: false, reason: 'last-page'}`. "Last" is read from the
//     browser endpoint at close time, never remembered.

/**
 * Every option key a factory honours. ⛔ An option the library does not honour is
 * REFUSED, never ignored (v7x3): `connectBrowser({readOnly: true})` used to return
 * an ordinary session that still read cookies, i.e. a guard that looked applied.
 */
const CDP_SESSION_OPTIONS = Object.freeze(['defaultTimeout', 'WebSocketImpl']);
const CONNECT_BROWSER_OPTIONS = Object.freeze(['host', 'port', 'defaultTimeout']);
const CORROBORATED_OPTIONS = Object.freeze(['host', 'port', 'types', 'onDisagree']);
const OPEN_PAGE_OPTIONS = Object.freeze([
  'host', 'port', 'startUrl', 'defaultTimeout',
  'targetId', 'owner', 'ownedTargets', 'keep', 'close', 'onMinted',
]);
const NAVIGATE_OPTIONS = Object.freeze([
  ...OPEN_PAGE_OPTIONS.filter((k) => k !== 'startUrl'),
  'loadTimeout', 'waitForExpr', 'waitForTimeout', 'settleMs',
]);

/**
 * Throw on any option key `fn` does not honour, naming it.
 * @param {string} fn
 * @param {unknown} opts
 * @param {readonly string[]} allowed
 */
function refuseUnknownOptions(fn, opts, allowed) {
  if (opts === undefined) return;
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError(`${fn}: options must be an object, got ${opts === null ? 'null' : typeof opts}`);
  }
  const unknown = Object.keys(opts).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new TypeError(
      `${fn}: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} — ` +
      `refused rather than ignored (an ignored option looks honoured and is not). ` +
      `${fn} honours: ${allowed.join(', ')}.`,
    );
  }
}

/**
 * Ids THIS process minted — the default `ownedTargets`. A lane with a durable
 * ledger passes its own object with `has(id)` instead; base imposes no store.
 * @type {Set<string>}
 */
const MINTED_BY_THIS_PROCESS = new Set();

/**
 * The browser endpoint's websocket URL, REWRITTEN to the caller's authority.
 * @param {string} base @param {string} host @param {number|string} port
 */
async function browserWsUrl(base, host, port) {
  const v = await getVersion(base, { host, port });
  if (!v.webSocketDebuggerUrl) {
    throw new Error(`${base}/json/version has no webSocketDebuggerUrl — cannot reach the browser target`);
  }
  return String(v.webSocketDebuggerUrl);
}

/**
 * A page target's websocket URL, on the same (already rewritten) authority as the
 * browser endpoint. Chromium serves every page at `/devtools/page/<targetId>`.
 * @param {string} browserWs @param {string} targetId
 */
function pageWsUrl(browserWs, targetId) {
  const u = new URL(browserWs);
  u.pathname = `/devtools/page/${encodeURIComponent(targetId)}`;
  u.search = '';
  return u.toString();
}

/**
 * @template T
 * @param {string} wsUrl @param {number} defaultTimeout
 * @param {(s: CdpSession) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withSession(wsUrl, defaultTimeout, fn) {
  const s = await new CdpSession(wsUrl, { defaultTimeout }).connect();
  try { return await fn(s); } finally { s.close(); }
}

/**
 * @typedef {{host: string, port: number|string, defaultTimeout: number}} Conn
 */

/**
 * Mint a background tab. Primary: `Target.createTarget` over the browser
 * endpoint; fallback: `/json/new` PUT, then GET. Never an existing tab.
 * @param {string} base @param {Conn} conn @param {string} startUrl
 * @returns {Promise<{id: string, wsUrl: string}>}
 */
async function mintTarget(base, conn, startUrl) {
  /** @type {string[]} */
  const why = [];
  let sent = false;
  try {
    const bws = await browserWsUrl(base, conn.host, conn.port);
    // ⛔ EXACTLY these three keys. No browserContextId: a fresh context lacks the
    // human's sign-in, so every page would come back walled. background: a
    // foreground mint steals focus in the human's window.
    const r = await withSession(bws, conn.defaultTimeout, (s) => {
      sent = true;
      return s.cdp('Target.createTarget', { url: startUrl, background: true, newWindow: false });
    });
    if (!r || !r.targetId) throw new Error('reply carried no targetId');
    return { id: String(r.targetId), wsUrl: pageWsUrl(bws, String(r.targetId)) };
  } catch (err) {
    const e = /** @type {Error & {cdpError?: unknown}} */ (err);
    // ⛔ Fall back ONLY when nothing can have been created: the request never left
    // (no browser endpoint), or the browser ANSWERED with an error. A LOST reply —
    // timeout, dropped socket — may follow a tab the browser already made; a
    // fallback mint would add a second tab and leave the first an orphan that
    // onMinted never saw (measured by the review).
    if (sent && !e.cdpError) {
      throw new Error(
        `openPage: Target.createTarget was sent but its reply was lost (${e.message}). ` +
        'The browser may have created a tab that nothing records — check it for an orphan ' +
        `${startUrl === 'about:blank' ? 'blank tab' : `tab at ${startUrl}`}. ` +
        'Not falling back to /json/new: that would mint a second one.', { cause: e });
    }
    why.push(`Target.createTarget: ${e.message}`);
  }
  for (const method of ['PUT', 'GET']) {
    try {
      const resp = await fetch(`${base}/json/new?${encodeURIComponent(startUrl)}`, { method });
      if (!resp.ok) { why.push(`/json/new ${method}: HTTP ${resp.status}`); continue; }
      const t = /** @type {any} */ (await resp.json());
      if (t && t.id && t.webSocketDebuggerUrl) {
        return { id: String(t.id), wsUrl: rewriteWsUrl(String(t.webSocketDebuggerUrl), conn.host, conn.port) };
      }
      why.push(`/json/new ${method}: reply lacks id or webSocketDebuggerUrl`);
    } catch (err) {
      why.push(`/json/new ${method}: ${/** @type {Error} */ (err).message}`);
    }
  }
  throw new Error(
    `openPage: could not mint a new tab (${why.join('; ')}). ` +
    '/json/new is restricted or disabled in some chromium builds. ' +
    'base NEVER falls back to an existing tab — it may be the one a person is reading. ' +
    "To drive a tab base did not open, name it: {targetId, owner: 'adopted'}.",
  );
}

/**
 * @typedef {{closed: true} |
 *   {closed: false, reason: 'last-page'|'keep'|'owned-reuse'|'adopted'|'close-failed', error?: string}} CloseResult
 */

/**
 * A TAB: a `page` target with no `subtype`. ⚠ CDP marks a prerendered page as
 * `{type: 'page', subtype: 'prerender'}` — not a window. Counted as a page, it made
 * our real last tab look like one of two, so close() would exit Chromium; accepted
 * for reuse, base would drive something that is not a tab.
 * @param {any} t
 */
function isTab(t) {
  return !!t && t.type === 'page' && !t.subtype;
}

/**
 * One promise chain per browser AUTHORITY: closes of our own tabs run one at a time.
 * @type {Map<string, Promise<unknown>>}
 */
const CLOSE_CHAINS = new Map();

/**
 * Close a tab we own — unless it is the LAST page, which is blanked instead.
 * "Last" is read now, from the browser endpoint.
 *
 * ⛔ SERIALISED per browser authority within this process. The page count is a
 * check-then-act: two concurrent closes of two of our tabs each read "2 pages"
 * and both closed — 0 pages, and Chromium exits (measured by the review). ⚠ What
 * this cannot close: a PERSON (or another process) closing a tab in the same
 * window. That race is residual — base cannot make a read and a close atomic.
 * @param {string} base @param {Conn} conn @param {string} targetId
 * @returns {Promise<CloseResult>}
 */
function closeOwnedTarget(base, conn, targetId) {
  const key = `${conn.host}:${conn.port}`;
  const prev = CLOSE_CHAINS.get(key) || Promise.resolve();
  const run = prev.then(() => closeOwnedTargetNow(base, conn, targetId));
  const tail = run.catch(() => null);
  CLOSE_CHAINS.set(key, tail);
  tail.then(() => { if (CLOSE_CHAINS.get(key) === tail) CLOSE_CHAINS.delete(key); });
  return run;
}

/**
 * The unserialised body of `closeOwnedTarget` — call only through it.
 * @param {string} base @param {Conn} conn @param {string} targetId
 * @returns {Promise<CloseResult>}
 */
async function closeOwnedTargetNow(base, conn, targetId) {
  const bws = await browserWsUrl(base, conn.host, conn.port);
  return withSession(bws, conn.defaultTimeout, async (b) => {
    const r = await b.cdp('Target.getTargets', {});
    const pages = ((r && r.targetInfos) || []).filter(isTab);
    if (!pages.some((/** @type {any} */ t) => t.targetId === targetId)) return { closed: true };
    if (pages.length <= 1) {
      await withSession(pageWsUrl(bws, targetId), conn.defaultTimeout,
        (s) => s.cdp('Page.navigate', { url: 'about:blank' }));
      return { closed: false, reason: 'last-page' };
    }
    await b.cdp('Target.closeTarget', { targetId });
    return { closed: true };
  });
}

/**
 * After a failure between mint and return: close the just-minted tab (under the
 * last-page rule), drop it from this process's minted set if it is gone, and say
 * what happened in words fit for an error message. Never throws.
 * @param {string} base @param {Conn} conn @param {string} id
 * @returns {Promise<string>}
 */
async function closeMintedAfterFailure(base, conn, id) {
  /** @type {CloseResult} */
  let r;
  try { r = await closeOwnedTarget(base, conn, id); } catch (e) {
    r = { closed: false, reason: 'close-failed', error: /** @type {Error} */ (e).message };
  }
  if (r.closed) MINTED_BY_THIS_PROCESS.delete(id);
  return r.closed ? 'closed' : `NOT closed (${r.reason}${'error' in r && r.error ? `: ${r.error}` : ''})`;
}

/**
 * Options for `openPage()` (and, minus `startUrl`, for `navigate()`).
 * @typedef {{
 *   host?: string, port?: number|string, startUrl?: string, defaultTimeout?: number,
 *   targetId?: string,
 *   owner?: 'minted'|'adopted',
 *   ownedTargets?: {has(id: string): boolean},
 *   keep?: boolean, close?: boolean,
 *   onMinted?: (targetId: string) => unknown,
 * }} OpenPageOptions
 */

/**
 * What `openPage()` returns.
 *  * `reused`: true ONLY for an owned (`owner: 'minted'`) or adopted reuse.
 *  * `owner`: 'minted' for a fresh mint or an owned reuse; 'adopted' otherwise.
 *  * `close()`: closes the session and applies the lifetime rule — a fresh mint is
 *    closed unless `keep: true`; an owned reuse only with `close: true`; an adopted
 *    tab never; the last page is blanked instead. Idempotent. Never throws: a
 *    failure is `{closed: false, reason: 'close-failed', error}`.
 * @typedef {{session: CdpSession, targetId: string, reused: boolean,
 *            owner: 'minted'|'adopted', close: () => Promise<CloseResult>}} OpenedPage
 */

/**
 * @param {string} base @param {Conn} conn @param {CdpSession} session
 * @param {string} targetId @param {boolean} reused @param {'minted'|'adopted'} owner
 * @param {'close'|'keep'|'owned-reuse'|'adopted'} lifetime
 * @returns {OpenedPage}
 */
function opened(base, conn, session, targetId, reused, owner, lifetime) {
  /** @type {Promise<CloseResult>|null} */
  let closing = null;
  const close = () => {
    closing ||= (async () => {
      session.close();
      if (lifetime !== 'close') return /** @type {CloseResult} */ ({ closed: false, reason: lifetime });
      try {
        const r = await closeOwnedTarget(base, conn, targetId);
        if (r.closed) MINTED_BY_THIS_PROCESS.delete(targetId);
        return r;
      } catch (err) {
        return { closed: false, reason: 'close-failed', error: /** @type {Error} */ (err).message };
      }
    })();
    return closing;
  };
  return { session, targetId, reused, owner, close };
}

/**
 * Open a page session on a tab base may drive.
 *
 * | caller passes                 | does                                            | reused |
 * |-------------------------------|-------------------------------------------------|--------|
 * | nothing (default)             | MINTS a background tab                          | false  |
 * | `{targetId, owner: 'minted'}` | drives it only if `ownedTargets.has(targetId)`  | true   |
 * | `{targetId, owner: 'adopted'}`| drives a tab base did not mint (this call only) | true   |
 * | `{targetId}`, any other owner | REFUSED, naming both choices                    | —      |
 *
 * `ownedTargets` defaults to the ids this process minted. `onMinted(id)` is
 * awaited after the mint and BEFORE the first attach — record the id in a durable
 * ledger there; if it throws, the tab is closed (or blanked, if it is the last
 * page) and openPage refuses, carrying the hook's error. A reused target must
 * exist and be a `page`. Unknown option keys are refused.
 *
 * @param {string} base
 * @param {OpenPageOptions} [opts]
 * @returns {Promise<OpenedPage>}
 */
export async function openPage(base, opts = {}) {
  refuseUnknownOptions('openPage', opts, OPEN_PAGE_OPTIONS);
  const {
    host = '127.0.0.1', port, startUrl = 'about:blank', defaultTimeout = 15000,
    targetId, owner, ownedTargets = MINTED_BY_THIS_PROCESS, keep = false, close = false, onMinted,
  } = opts;
  /** @type {Conn} */
  const conn = { host, port: port || new URL(base).port, defaultTimeout };

  if (onMinted !== undefined && typeof onMinted !== 'function') {
    throw new TypeError('openPage: onMinted must be a function');
  }
  if (!ownedTargets || typeof ownedTargets.has !== 'function') {
    throw new TypeError('openPage: ownedTargets must be an object with has(id) (a Set works)');
  }
  if (keep && close) {
    throw new TypeError('openPage: keep: true and close: true contradict each other — pass one');
  }

  // ── default: MINT ─────────────────────────────────────────────────────────
  if (targetId === undefined) {
    if (owner !== undefined) {
      throw new TypeError(
        `openPage: owner '${owner}' without a targetId. owner says whose tab targetId is; ` +
        'with no targetId openPage mints a new tab and needs no owner.');
    }
    const { id, wsUrl } = await mintTarget(base, conn, startUrl);
    MINTED_BY_THIS_PROCESS.add(id);
    if (onMinted) {
      try {
        await onMinted(id);
      } catch (err) {
        const fate = await closeMintedAfterFailure(base, conn, id);
        throw new Error(
          `openPage: onMinted('${id}') failed, so the tab was never attached to and was ${fate}: ` +
          `${/** @type {Error} */ (err).message}`, { cause: err });
      }
    }
    let session;
    try {
      session = await new CdpSession(wsUrl, { defaultTimeout }).connect();
    } catch (err) {
      // ⚠ Name the id and what became of it: without that, a keep: true tab (and,
      // without onMinted, any tab) is one the caller can never find again.
      const fate = keep
        ? "kept open (keep: true; still in this process's ownedTargets)"
        : await closeMintedAfterFailure(base, conn, id);
      throw new Error(
        `openPage: minted tab '${id}' but could not attach to it, so it was ${fate}: ` +
        `${/** @type {Error} */ (err).message}`, { cause: err });
    }
    return opened(base, conn, session, id, false, 'minted', keep ? 'keep' : 'close');
  }

  // ── reuse: only a tab whose owner is DECLARED ──────────────────────────────
  if (typeof targetId !== 'string' || targetId === '') {
    throw new TypeError('openPage: targetId must be a non-empty string');
  }
  if (owner !== 'minted' && owner !== 'adopted') {
    throw new Error(
      `openPage: refusing targetId '${targetId}' — owner is ${owner === undefined ? 'missing' : `'${owner}'`}. ` +
      "base drives a tab it did not just open only when told whose it is: owner: 'minted' " +
      "(the id is in ownedTargets — a tab this process, or your ledger, minted) or owner: 'adopted' " +
      '(an explicit adoption of a tab base did not mint, for this call only; never closed by base). ' +
      "An id alone is indistinguishable from the human's tab copied out of listPageTargets().");
  }
  if (onMinted) {
    throw new TypeError(`openPage: onMinted runs only on a mint; with targetId '${targetId}' nothing is minted`);
  }
  if (owner === 'adopted' && close) {
    throw new TypeError(`openPage: close: true on adopted tab '${targetId}' — base never closes an adopted tab`);
  }
  // ⛔ Only a literal `true` vouches. An ASYNC has() (a db- or file-backed ledger)
  // returns a Promise, which is truthy — so `!has(id)` let it vouch for ANY id,
  // and the review measured navigate driving the human's tab through it.
  const vouched = owner === 'minted' ? /** @type {unknown} */ (ownedTargets.has(targetId)) : false;
  if (owner === 'minted' && vouched !== null && typeof vouched === 'object'
      && typeof (/** @type {any} */ (vouched)).then === 'function') {
    throw new TypeError(
      `openPage: ownedTargets.has('${targetId}') returned a Promise — has() must return a boolean. ` +
      'An async ledger cannot vouch synchronously: resolve your ledger first (e.g. load its ids into a Set) ' +
      'and pass that.');
  }
  if (owner === 'minted' && vouched !== true) {
    throw new Error(
      `openPage: refusing targetId '${targetId}' as owner: 'minted' — it is not in ownedTargets ` +
      `(${ownedTargets === MINTED_BY_THIS_PROCESS ? 'default: the ids this process minted' : 'the object you passed'}). ` +
      "Pass your ledger as ownedTargets, or, for a tab base did not mint, owner: 'adopted'.");
  }

  const bws = await browserWsUrl(base, conn.host, conn.port);
  const r = await withSession(bws, defaultTimeout, (s) => s.cdp('Target.getTargets', {}));
  const found = ((r && r.targetInfos) || []).find((/** @type {any} */ t) => t && t.targetId === targetId);
  if (!found) throw new Error(`openPage: no target '${targetId}' in the browser — refused`);
  if (found.type !== 'page') {
    throw new Error(`openPage: target '${targetId}' is a ${found.type}, not a page — refused`);
  }
  if (!isTab(found)) {
    throw new Error(`openPage: target '${targetId}' is a page with subtype '${found.subtype}' — not a tab, refused`);
  }
  const session = await new CdpSession(pageWsUrl(bws, targetId), { defaultTimeout }).connect();
  const lifetime = owner === 'adopted' ? 'adopted' : close ? 'close' : 'owned-reuse';
  return opened(base, conn, session, targetId, true, owner, lifetime);
}

/**
 * Close a page target by id. Best-effort — a failure here must not mask the
 * caller's actual result.
 *
 * ⚠ A LOW-LEVEL primitive: it closes exactly the id it is given, with no
 * ownership check and no last-page rule. Prefer the `close()` that `openPage()` /
 * `navigate()` return, which applies both.
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
 * Opens its tab with `openPage()` — so by default it MINTS one — passing
 * `targetId` / `owner` / `ownedTargets` / `keep` / `close` / `onMinted` /
 * `host` / `port` / `defaultTimeout` through. Returns `openPage()`'s result; its
 * `close()` applies the lifetime rule (see `OpenedPage`). Unknown keys are
 * refused, so a stale `reuse: true` is told so rather than given a new tab.
 *
 * @param {string} base
 * @param {string} url
 * @param {Omit<OpenPageOptions, 'startUrl'> & {loadTimeout?: number,
 *          waitForExpr?: string|null, waitForTimeout?: number, settleMs?: number}} [opts]
 * @returns {Promise<OpenedPage>}
 */
export async function navigate(base, url, opts = {}) {
  refuseUnknownOptions('navigate', opts, NAVIGATE_OPTIONS);
  const {
    loadTimeout = 30000, waitForExpr = null, waitForTimeout = 15000, settleMs = 800, ...pageOpts
  } = opts;
  const page = await openPage(base, pageOpts);
  const { session } = page;
  try {
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
  } catch (err) {
    // Do not leak the tab we just minted on a failed navigation.
    await page.close();
    throw err;
  }
  return page;
}
