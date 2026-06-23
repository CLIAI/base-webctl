// xpra-html5 access gateway — grant/request store (P2).
// Design: infra-xpra-remote-access-gateway-f6rd §4.2/§4.3.
//
// Persistent JSON store of remote-access GRANTS (principal -> time-boxed access)
// and pending REQUESTS (principal -> awaiting operator approval), plus the
// `enabled` toggle. Atomic writes (temp + rename), lazy expiry pruning on read,
// flexible TTL parser. It is session-grade ACCESS STATE — the caller MUST place
// `statePath` under a gitignored state dir (SECRET-FREE invariant; same class as
// cookies). Zero-dep; `clock`/`fs` injectable for hermetic tests.
//
// Principal is an opaque string (P2: the peer IP; the `tailscale whois` resolver
// arrives in P4 — same store, principal just resolved differently).
//
// Tag: [WEBCTL]

import nodeFs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

/**
 * Parse a TTL string to seconds. Forms: `forever`, `<n>` (bare = minutes),
 * `<n>min`, `<n>h`, `<n>d`. Throws on anything else.
 * @param {string} str
 * @returns {number} seconds (Infinity for 'forever')
 */
export function parseTtl(str) {
  const s = String(str == null ? '' : str).trim().toLowerCase();
  if (s === 'forever') return Infinity;
  const m = s.match(/^(\d+)\s*(min|h|d)?$/);
  if (!m) throw new Error(`invalid ttl: ${JSON.stringify(str)} (use 15min|1h|3h|12h|forever|<n>{min,h,d})`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    case 'min': return n * 60;
    default:  return n * 60; // bare number = minutes
  }
}

/**
 * Create the access store.
 * @param {{
 *   statePath: string,
 *   defaultTtlSec?: number,
 *   clock?: () => number,
 *   fs?: typeof nodeFs,
 * }} opts
 * @returns {object}
 */
export function createAccessStore(opts) {
  const o = opts || /** @type {any} */ ({});
  if (!o.statePath) throw new Error('createAccessStore: opts.statePath required (gitignored state file)');
  const statePath = o.statePath;
  const defaultTtlSec = typeof o.defaultTtlSec === 'number' ? o.defaultTtlSec : 3 * 3600;
  const fs = o.fs || nodeFs;
  const now = o.clock || (() => Date.now());

  function freshState() {
    return { schemaVersion: SCHEMA_VERSION, enabled: true, requests: {}, grants: {} };
  }

  /** Read state from disk (or a fresh default if absent/corrupt). */
  function read() {
    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf-8');
    } catch (_) {
      return freshState();
    }
    try {
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return freshState();
      s.requests = s.requests || {};
      s.grants = s.grants || {};
      if (typeof s.enabled !== 'boolean') s.enabled = true;
      return s;
    } catch (_) {
      // corrupt -> treat as fresh (do NOT throw; access state is best-effort)
      return freshState();
    }
  }

  /** Atomic write: temp + rename, mode 0600. @param {any} state */
  function write(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, statePath);
  }

  /** Remove expired grants in-place; returns true if anything was pruned. @param {any} state */
  function prune(state) {
    let changed = false;
    const t = now();
    for (const [principal, g] of Object.entries(state.grants)) {
      if (g && g.expiresAt != null && t >= g.expiresAt) {
        delete state.grants[principal];
        changed = true;
      }
    }
    return changed;
  }

  /** read + prune + (persist if pruned). */
  function readPruned() {
    const state = read();
    if (prune(state)) write(state);
    return state;
  }

  function isEnabled() {
    return read().enabled !== false;
  }

  /** @param {boolean} b */
  function setEnabled(b) {
    const state = read();
    state.enabled = !!b;
    write(state);
  }

  /** @param {string} principal @param {{who?: string, note?: string}} [info] */
  function addRequest(principal, info) {
    if (!principal) throw new Error('addRequest: principal required');
    const state = read();
    const i = info || {};
    const req = {
      principal,
      who: i.who || null,
      note: i.note || null,
      requestedAt: new Date(now()).toISOString(),
    };
    state.requests[principal] = req;
    write(state);
    return req;
  }

  function listRequests() {
    return Object.values(read().requests);
  }

  /** @param {string} principal @param {{ttl?: string, grantedBy?: string}} [info] */
  function approve(principal, info) {
    if (!principal) throw new Error('approve: principal required');
    const i = info || {};
    const ttl = i.ttl || ttlStringForDefault();
    const ttlSec = parseTtl(ttl);
    const t = now();
    const grant = {
      ttl,
      grantedBy: i.grantedBy || null,
      grantedAt: new Date(t).toISOString(),
      expiresAt: ttlSec === Infinity ? null : t + ttlSec * 1000,
    };
    const state = readPruned();
    state.grants[principal] = grant;
    delete state.requests[principal];
    write(state);
    return grant;
  }

  /** @param {string} principal */
  function reject(principal) {
    const state = read();
    if (state.requests[principal]) { delete state.requests[principal]; write(state); return true; }
    return false;
  }

  /** @param {string} principal */
  function revoke(principal) {
    const state = read();
    if (state.grants[principal]) { delete state.grants[principal]; write(state); return true; }
    return false;
  }

  /** @param {string} principal */
  function isGranted(principal) {
    if (!principal) return false;
    return !!readPruned().grants[principal];
  }

  function listGrants() {
    const state = readPruned();
    const t = now();
    return Object.entries(state.grants).map(([principal, g]) => ({
      principal,
      ...g,
      remainingSeconds: g.expiresAt == null ? null : Math.max(0, Math.round((g.expiresAt - t) / 1000)),
    }));
  }

  /** The default-TTL string (so `approve` records a human-readable ttl). */
  function ttlStringForDefault() {
    if (!Number.isFinite(defaultTtlSec)) return 'forever';
    if (defaultTtlSec % 3600 === 0) return `${defaultTtlSec / 3600}h`;
    if (defaultTtlSec % 60 === 0) return `${defaultTtlSec / 60}min`;
    return `${defaultTtlSec}`;
  }

  return {
    isEnabled, setEnabled,
    addRequest, listRequests,
    approve, reject, revoke,
    isGranted, listGrants,
    SCHEMA_VERSION,
  };
}
