// egress.js — which network a browser's traffic uses: DECLARED, resolved and refused here (eg7p §2a, step 2).
//
//   ~/.config/webctl/egress/<name>.toml  mode 600   kind = "<kind>" + the kind's own parameters
//
// base owns the declaration, the resolution and the refusals; xq owns what RUNS (rx9q, eg7p §1). Nothing here contacts
// a network or xq: a lane passes xq's `egress_kinds` reading in when it has one.
//
// ⛔ Direct is never assumed (nl0c): no declaration → REFUSED; `egress = "direct"` states it. ⛔ No record value is
// ever echoed — a value may be an endpoint — and only a VALID egress name is.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkConfigMode, SHARED_CONFIG_DISPLAY } from './remotes.js';
import { parseTomlSubset } from './shared-config.js';

/** The CLOSED list of egress kinds (eg7p §2). Any other kind is refused, by name. */
export const EGRESS_KINDS = Object.freeze(['direct', 'ssh-dynamic', 'socks5', 'http-proxy', 'wireguard', 'vpn', 'tor']);
/** Kinds that need NET_ADMIN or a tun device in the egress container: the human's call (eg7p §8). */
export const PRIVILEGED_EGRESS_KINDS = Object.freeze(['wireguard', 'vpn']);
/** The reserved name: no egress, deliberately. It has no record. */
export const DIRECT_EGRESS = 'direct';
/** Egress names: lower case, like target names, so an env mapping cannot collide by case. */
export const EGRESS_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** The machine codes of a refusal; a lane maps each onto its OWN exit table. */
export const EGRESS_REFUSAL_CODES = Object.freeze(['no-egress', 'ambiguous', 'invalid-egress', 'unknown-egress', 'unknown-kind',
  'privileged-kind', 'kind-unavailable']);

/**
 * A key that names an inline SECRET (eg7p §6): refused, whatever its value. A secret is a `*_file` key holding a path.
 * Matched on the key's parts, so `proxy_password` and `wg-private-key` are caught and `keepalive` is not.
 */
const SECRET_KEY_RE = /(^|[_-])(password|passwd|passphrase|secret|token|private[_-]?key|privkey|psk|preshared[_-]?key|credentials?|api[_-]?key)($|[_-])/i;

/**
 * Each kind's keys, from xq's spec (`specs/08-egress-records.md`, confirmed by xq's lane 2026-10-14): `required` and
 * `optional`. ⛔ CLOSED per kind, as xq's own loader is (it refuses an unknown key): base refuses it first, by name,
 * before anything is started. Types: `host`/`ssh`/`username`/`check_url` strings, `port` an int, `tls` a bool, every
 * `*_file` a path. `ssh` is an ssh(1) destination passed UNPARSED (never `-…`). A secret is only ever a `*_file`.
 */
export const EGRESS_KIND_KEYS = Object.freeze({
  'socks5': Object.freeze({ required: ['host', 'port'], optional: ['username', 'password_file', 'check_url'] }),
  'http-proxy': Object.freeze({ required: ['host', 'port'], optional: ['username', 'password_file', 'tls', 'check_url'] }),
  'ssh-dynamic': Object.freeze({ required: ['ssh', 'known_hosts_file'], optional: ['identity_file', 'check_url'] }),
  'tor': Object.freeze({ required: [], optional: ['torrc_file', 'check_url'] }),
  'wireguard': Object.freeze({ required: ['config_file'], optional: ['check_url'] }),
  'vpn': Object.freeze({ required: ['config_file'], optional: ['auth_file', 'check_url'] }),
});

/**
 * Validate an egress record. ⛔ Messages NAME KEYS, NEVER VALUES.
 * @param {Record<string, any>} r @param {{name?: string}} [opts]
 * @returns {{verdict: 'valid' | 'invalid', errors: {field: string, message: string}[]}}
 */
export function validateEgressRecord(r, opts = {}) {
  /** @type {{field: string, message: string}[]} */
  const errors = [];
  const add = (/** @type {string} */ field, /** @type {string} */ message) => errors.push({ field, message });
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { verdict: 'invalid', errors: [{ field: '*', message: 'not a record' }] };
  if (opts.name !== undefined) {
    if (!EGRESS_NAME_RE.test(String(opts.name))) add('name', 'egress name: lower-case letters, digits, "_" or "-", starting with a letter');
    else if (opts.name === DIRECT_EGRESS) add('name', '"direct" is reserved (no egress, deliberately) and has no record');
  }
  if (r.kind === undefined) add('kind', `required, one of ${EGRESS_KINDS.join(' | ')}`);
  else if (!EGRESS_KINDS.includes(r.kind)) add('kind', `unknown kind; one of ${EGRESS_KINDS.join(' | ')} (the list is closed)`);
  else if (r.kind === DIRECT_EGRESS) add('kind', 'a record never declares kind "direct": state egress = "direct" instead');
  /** @type {{required: readonly string[], optional: readonly string[]} | undefined} */
  const keys = typeof r.kind === 'string' ? /** @type {any} */ (EGRESS_KIND_KEYS)[r.kind] : undefined;
  for (const k of Object.keys(r)) {
    if (k === 'kind') continue;
    const v = r[k];
    if (k.endsWith('_file')) {
      if (typeof v !== 'string' || !(path.isAbsolute(v) || v.startsWith('~/'))) add(k, 'a file is an absolute path (or ~/…)');
    } else if (SECRET_KEY_RE.test(k)) {
      add(k, `refused: an inline secret — secrets live in a file the record points to (${k}_file = "<path>", mode 600)`);
      continue;
    }
    if (keys && !keys.required.includes(k) && !keys.optional.includes(k)) { add(k, `not a key of kind ${r.kind} (xq refuses it too)`); continue; }
    if (k === 'port' && !(Number.isInteger(v) && v >= 1 && v <= 65535)) add(k, 'an integer port, 1-65535');
    if (k === 'tls' && typeof v !== 'boolean') add(k, 'true or false');
    if (['host', 'username'].includes(k) && !(typeof v === 'string' && v.trim() && !/[\s\u0000-\u001f]/.test(v))) add(k, 'a non-empty string without spaces');
    if (k === 'ssh' && !(typeof v === 'string' && v.trim() && !v.startsWith('-') && !/[\s\u0000-\u001f]/.test(v))) {
      add(k, 'an ssh destination (passed to ssh unparsed), never starting with "-" (ssh would read it as an option)');
    }
    if (k === 'check_url' && !(typeof v === 'string' && /^https?:\/\/[^\s]+$/.test(v))) add(k, 'an http(s) URL of the operator\'s own endpoint');
  }
  if (keys) for (const k of keys.required) if (r[k] === undefined) add(k, `required for kind ${r.kind}`);
  return { verdict: errors.length ? 'invalid' : 'valid', errors };
}

/**
 * Load every shared egress record. Mode wider than 600 → refused, as for targets. Messages name files by
 * SHARED_CONFIG_DISPLAY, never the absolute path.
 * @param {{home?: string}} [opts]
 * @returns {{records: Record<string, Record<string, any>>, errors: string[]}}
 */
export function loadSharedEgress(opts = {}) {
  const dir = path.join(opts.home || os.homedir(), '.config', 'webctl', 'egress');
  /** @type {Record<string, Record<string, any>>} */ const records = {};
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.toml')).sort(); } catch { return { records, errors }; }
  for (const f of files) {
    const name = f.slice(0, -'.toml'.length);
    const shown = `${SHARED_CONFIG_DISPLAY}/egress/${f}`;
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch (e) { errors.push(`${shown}: cannot stat (${/** @type {any} */ (e).code})`); continue; }
    const mode = checkConfigMode(st.mode);
    if (mode.verdict !== 'ok') { errors.push(`${shown}: ${mode.reason}`); continue; }
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { errors.push(`${shown}: cannot read (${/** @type {any} */ (e).code})`); continue; }
    const p = parseTomlSubset(text);
    if (!p.ok) { errors.push(`${shown}: ${p.error}`); continue; }
    const v = validateEgressRecord(p.values, { name });
    if (v.verdict !== 'valid') { errors.push(`${shown}: ${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`); continue; }
    records[name] = p.values;
  }
  return { records, errors };
}

/**
 * Resolve a profile's egress (eg7p §2a): `--egress` > `<TOOL>_EGRESS` > the lane's config > the shared TARGET record's
 * `egress` key. ⚠ Returns a REASON OBJECT, never an exit code.
 *
 * @param {{
 *   flag?: string | string[] | null, env?: string | null, laneConfig?: string | null, targetRecord?: Record<string, any> | null,
 *   kinds?: {kind: string, privileged?: boolean, enabled?: boolean}[] | null,
 *   tool?: string, envKey?: string, home?: string, records?: Record<string, Record<string, any>>,
 * }} [o]
 *   `kinds` — xq's `egress_kinds` reading (§11.3), when the lane has one; without it a privileged kind is refused.
 *   `records` — for tests; else loadSharedEgress({home}).
 * @returns {{verdict: 'resolved', name: string, kind: string, source: string, shadowed: string[], record: Record<string, any> | null, reason: string}
 *   | {verdict: 'refused', code: string, reason: string, instructions?: string, sharedErrors?: string[]}}
 */
export function resolveEgress(o = {}) {
  const order = ['flag', 'env', 'config', 'shared'];
  /** @type {{source: string, value: string}[]} */ const layers = [];
  for (const f of Array.isArray(o.flag) ? o.flag : [o.flag]) if (typeof f === 'string' && f.trim()) layers.push({ source: 'flag', value: f.trim() });
  if (typeof o.env === 'string' && o.env.trim()) layers.push({ source: 'env', value: o.env.trim() });
  if (typeof o.laneConfig === 'string' && o.laneConfig.trim()) layers.push({ source: 'config', value: o.laneConfig.trim() });
  const fromTarget = o.targetRecord && typeof o.targetRecord.egress === 'string' ? o.targetRecord.egress.trim() : '';
  if (fromTarget) layers.push({ source: 'shared', value: fromTarget });
  layers.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  const tool = o.tool || 'this tool';
  const instructions = `Pass --egress <name>, set ${o.envKey || 'the tool\'s egress environment variable'}, or declare egress = "<name>" `
    + `in the target's record — egress = "direct" for no egress, deliberately.`;
  if (layers.length === 0) {
    return { verdict: 'refused', code: 'no-egress', reason: `no egress declared, and ${tool} never assumes direct. ${instructions}`, instructions };
  }
  if (layers.length > 1 && layers[0].source === layers[1].source) {
    return { verdict: 'refused', code: 'ambiguous', reason: `two egress names given in the ${layers[0].source} layer; give one` };
  }
  const [win, ...rest] = layers;
  const shadowed = rest.map((l) => l.source);
  const from = `from the ${win.source === 'shared' ? 'target record' : win.source}${shadowed.length ? `; overrode ${shadowed.join(' and ')}` : ''}`;
  if (!EGRESS_NAME_RE.test(win.value)) {
    // the value NOT echoed: it is not a name, and may be an endpoint typed where a name belongs
    return { verdict: 'refused', code: 'invalid-egress', reason: `the egress ${from} is not an egress name (lower-case letters, digits, "_" or "-")` };
  }
  if (win.value === DIRECT_EGRESS) {
    return { verdict: 'resolved', name: DIRECT_EGRESS, kind: DIRECT_EGRESS, source: win.source, shadowed, record: null, reason: `direct (stated) ${from}` };
  }
  const loaded = o.records ? { records: o.records, errors: [] } : loadSharedEgress({ home: o.home });
  const record = Object.prototype.hasOwnProperty.call(loaded.records, win.value) ? loaded.records[win.value] : null;
  if (!record) {
    return { verdict: 'refused', code: 'unknown-egress', sharedErrors: loaded.errors,
      reason: `no valid egress record '${win.value}' in ${SHARED_CONFIG_DISPLAY}/egress/ (${from})${loaded.errors.length ? '; see sharedErrors' : ''}` };
  }
  const kind = String(record.kind);
  if (!EGRESS_KINDS.includes(kind)) return { verdict: 'refused', code: 'unknown-kind', reason: `egress '${win.value}' has an unknown kind` };
  const reading = Array.isArray(o.kinds) ? o.kinds.find((k) => k && k.kind === kind) : undefined;
  if (Array.isArray(o.kinds) && !reading) {
    return { verdict: 'refused', code: 'kind-unavailable', reason: `egress '${win.value}' is kind ${kind}, which this xq does not implement` };
  }
  if (PRIVILEGED_EGRESS_KINDS.includes(kind) && !(reading && reading.enabled === true)) {
    return { verdict: 'refused', code: 'privileged-kind',
      reason: `egress '${win.value}' is kind ${kind}, which needs NET_ADMIN or a tun device: enabling it is the human's security `
        + `decision (eg7p §8)${reading ? ', and xq reports it disabled' : ', and no xq egress_kinds reading says it is enabled'} — refused, never degraded` };
  }
  return { verdict: 'resolved', name: win.value, kind, source: win.source, shadowed, record, reason: `egress '${win.value}' (kind ${kind}) ${from}` };
}

/**
 * The `where` fields (eg7p §10): EXACTLY these three — never a record value, endpoint or exit address.
 * @param {{verdict: string, name?: string, kind?: string, source?: string}} r
 * @returns {{egress: string, egress_kind: string, egress_source: string} | null}
 */
export function egressWhere(r) {
  if (!r || r.verdict !== 'resolved' || !r.name || !r.kind || !r.source) return null;
  return { egress: r.name, egress_kind: r.kind, egress_source: r.source };
}
