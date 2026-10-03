// shared-config.js — ONE loader for the family's shared `~/.config/webctl/` (nl0c §1a).
//
//   ~/.config/webctl/config.toml          mode 600   default_target = "<name>"
//   ~/.config/webctl/targets/<name>.toml  mode 600   one record per target (btg4 §3)
//
// Greg, 2026-10-03: every lane "sources from shared ~/.config/webctl/". Every lane
// reading those files its own way would be the duplication this family exists to
// stop — so base reads them, once.
//
// ⛔ The DEFAULT is a person's declaration in their own home directory. This module
// supplies no fallback of its own, never creates the directory, and refuses a file
// whose mode is wider than 600 (checkConfigMode) or a record that fails
// validateTarget — naming the file and key, never a value.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateTarget, checkConfigMode, resolveTarget, TARGET_NAME_RE, SHARED_CONFIG_DISPLAY } from './remotes.js';

/**
 * Parse a deliberate SUBSET of TOML: `key = "string" | integer | true | false |
 * ["str", …]`, `#` comments, blank lines. Anything else (tables, multi-line strings,
 * dotted keys, inline tables) is REFUSED with its line number — never half-parsed.
 *
 * @param {string} text
 * @returns {{ok: true, values: Record<string, string | number | boolean | string[]>}
 *   | {ok: false, error: string}}
 */
export function parseTomlSubset(text) {
  /** @type {Record<string, any>} */
  const values = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line);
    if (!m) return { ok: false, error: `line ${n}: not "key = value" (tables, dotted keys and multi-line values are not supported)` };
    const [, key, raw] = m;
    if (Object.prototype.hasOwnProperty.call(values, key)) return { ok: false, error: `line ${n}: key '${key}' given twice` };
    const v = parseValue(raw.trim());
    if (v === undefined) return { ok: false, error: `line ${n}: the value of '${key}' is not a string, integer, boolean or array of strings` };
    values[key] = v;
  }
  return { ok: true, values };
}

/** @param {string} line — drop a `#` comment that is not inside a string */
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && inStr) { i++; continue; }
    if (c === '"') inStr = !inStr;
    else if (c === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

/** @param {string} raw @returns {string | number | boolean | string[] | undefined} */
function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const s = parseString(raw);
  if (s !== undefined) return s;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    const parts = inner.split(',').map((p) => p.trim());
    if (parts[parts.length - 1] === '') parts.pop(); // one trailing comma is TOML
    const out = [];
    // ⚠ A comma INSIDE a string splits it; the halves then fail parseString, so the
    // value is REFUSED rather than misread.
    for (const part of parts) {
      const item = parseString(part);
      if (item === undefined) return undefined;
      out.push(item);
    }
    return out;
  }
  return undefined;
}

/** @param {string} raw @returns {string | undefined} a basic "…" string, \" and \\ only */
function parseString(raw) {
  const m = /^"((?:[^"\\]|\\["\\])*)"$/.exec(raw);
  return m ? m[1].replace(/\\(["\\])/g, '$1') : undefined;
}

/**
 * Read one TOML-subset file, refusing a mode wider than 600.
 * @param {string} file
 * @returns {{ok: true, values: Record<string, any>} | {ok: false, error: string}}
 */
function readGuarded(file, shown = file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, error: `${shown}: cannot stat (${/** @type {any} */ (e).code})` }; }
  const mode = checkConfigMode(st.mode);
  if (mode.verdict !== 'ok') return { ok: false, error: `${shown}: ${mode.reason}` };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: `${shown}: cannot read (${/** @type {any} */ (e).code})` }; }
  const p = parseTomlSubset(text);
  return p.ok ? p : { ok: false, error: `${shown}: ${p.error}` };
}

/**
 * Load the shared `~/.config/webctl/` config.
 *
 * Feed `configLayer` to `resolveTarget` as its LOWEST layer (`source: 'shared'`): a
 * flag, env, or the lane's OWN configured target all outrank it (nl0c §1b). Then look the
 * resolved NAME up — and take that record WHOLE; never merge it with a lane's partial one.
 *
 * @param {{home?: string}} [opts]  `home` for tests; defaults to os.homedir()
 * @returns {{
 *   present: boolean,
 *   dir: string,
 *   defaultTarget: string | null,
 *   configLayer: {source: 'shared', value: string} | null,
 *   targets: Record<string, Record<string, any>>,
 *   errors: string[],
 * }}
 */
export function loadSharedWebctlConfig(opts = {}) {
  const home = opts.home || os.homedir();
  const dir = path.join(home, '.config', 'webctl');
  /** @type {Record<string, Record<string, any>>} */
  const targets = {};
  /** @type {string[]} */
  const errors = [];
  if (!fs.existsSync(dir)) {
    return { present: false, dir, defaultTarget: null, configLayer: null, targets, errors };
  }

  const tdir = path.join(dir, 'targets');
  /** @type {string[]} */
  let names = [];
  try { names = fs.readdirSync(tdir).filter((f) => f.endsWith('.toml')).sort(); } catch { /* no targets dir */ }
  for (const f of names) {
    const name = f.slice(0, -'.toml'.length);
    const file = path.join(tdir, f);
    // Messages name files by SHARED_CONFIG_DISPLAY, never the absolute path (no home in output).
    const shown = `${SHARED_CONFIG_DISPLAY}/targets/${f}`;
    if (!TARGET_NAME_RE.test(name)) { errors.push(`${shown}: the file name is not a valid target name`); continue; }
    const r = readGuarded(file, shown);
    if (!r.ok) { errors.push(r.error); continue; }
    const v = validateTarget(r.values, { name });
    if (v.verdict !== 'valid') {
      errors.push(`${shown}: ${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
      continue;
    }
    targets[name] = r.values;
  }

  let defaultTarget = null;
  const cfgFile = path.join(dir, 'config.toml');
  const cfgShown = `${SHARED_CONFIG_DISPLAY}/config.toml`;
  if (fs.existsSync(cfgFile)) {
    const r = readGuarded(cfgFile, cfgShown);
    if (!r.ok) errors.push(r.error);
    else {
      const unknown = Object.keys(r.values).filter((k) => k !== 'default_target');
      if (unknown.length) errors.push(`${cfgShown}: unknown key(s) ${unknown.join(', ')} (only default_target is read)`);
      const d = r.values.default_target;
      if (d !== undefined) {
        if (typeof d !== 'string' || !d.trim()) errors.push(`${cfgShown}: default_target must be a non-empty string`);
        else if (!targets[d]) errors.push(`${cfgShown}: default_target names no valid record in targets/ — never a silent "no default"`);
        else defaultTarget = d;
      }
    }
  }
  return {
    present: true, dir, defaultTarget,
    // 'shared', NOT 'config': the family default ranks BELOW a lane's own declaration (nl0c §1b).
    configLayer: defaultTarget ? { source: 'shared', value: defaultTarget } : null,
    targets, errors,
  };
}

/**
 * The glue every lane wrote (nl0c §1c): load the shared config, rank
 * flag > env > the lane's own config > the shared default (§1b), resolve with
 * `resolveTarget`, and hand back the shared RECORD for the resolved NAME — whole (§1b),
 * never merged with anything — or `record: null` with `recordReason`.
 *
 * ⚠ `record` comes ONLY from `~/.config/webctl/targets/`. A name that resolved from the
 * lane's own config may have its record in the lane's own files; base does not look
 * there, and says so rather than guessing.
 *
 * @param {{
 *   flag?: string | {port: unknown, host?: string} | (string | {port: unknown, host?: string})[] | null,
 *   env?: string | null,
 *   laneConfig?: string | null,
 *   hints?: Parameters<typeof resolveTarget>[1],
 *   home?: string,
 * }} [opts]
 *   `flag` — a `--target` value, or `{port, host?}` for an explicit `--port` (nl0c §3a), or an
 *   array of both when the command line carried `--target X --port N`.
 *   `home` — for tests; defaults to os.homedir().
 * @returns {ReturnType<typeof resolveTarget> & {
 *   record: Record<string, any> | null,
 *   recordReason?: string,
 *   sharedErrors: string[],
 * }}
 */
export function resolveSharedTarget({ flag, env, laneConfig, hints, home } = {}) {
  const shared = loadSharedWebctlConfig({ home });
  /** @type {Parameters<typeof resolveTarget>[0]} */
  const layers = [];
  for (const f of Array.isArray(flag) ? flag : [flag]) {
    if (f === undefined || f === null) continue;
    if (typeof f === 'object') layers.push({ source: 'flag', port: f.port, ...(f.host !== undefined ? { host: f.host } : {}) });
    else layers.push({ source: 'flag', value: f });
  }
  if (env !== undefined && env !== null) layers.push({ source: 'env', value: env });
  if (laneConfig !== undefined && laneConfig !== null) layers.push({ source: 'config', value: laneConfig });
  if (shared.configLayer) layers.push(shared.configLayer);

  const r = /** @type {any} */ (resolveTarget(layers, hints));
  /** @type {Record<string, any> | null} */
  let record = null;
  /** @type {string | undefined} */
  let recordReason;
  if (r.verdict === 'resolved') {
    if (r.source === 'flag:port') {
      recordReason = 'an explicit --port is an unnamed, attach-only target; it has no record';
    } else if (Object.prototype.hasOwnProperty.call(shared.targets, r.value)) {
      record = shared.targets[r.value];
    } else {
      // The name is echoed only when it IS a target name; any other string is not repeated.
      const named = TARGET_NAME_RE.test(r.value) ? `named '${r.value}'` : 'by the resolved name (not a valid target name)';
      recordReason = `no shared record ${named} in ${SHARED_CONFIG_DISPLAY}/targets/ `
        + '(a lane may hold its own record; base does not merge or guess)';
    }
  }
  return { ...r, record, ...(recordReason ? { recordReason } : {}), sharedErrors: shared.errors };
}
