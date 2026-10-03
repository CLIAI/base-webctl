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

import { validateTarget, checkConfigMode, TARGET_NAME_RE } from './remotes.js';

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
function readGuarded(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, error: `${file}: cannot stat (${/** @type {any} */ (e).code})` }; }
  const mode = checkConfigMode(st.mode);
  if (mode.verdict !== 'ok') return { ok: false, error: `${file}: ${mode.reason}` };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: `${file}: cannot read (${/** @type {any} */ (e).code})` }; }
  const p = parseTomlSubset(text);
  return p.ok ? p : { ok: false, error: `${file}: ${p.error}` };
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
    if (!TARGET_NAME_RE.test(name)) { errors.push(`${file}: the file name is not a valid target name`); continue; }
    const r = readGuarded(file);
    if (!r.ok) { errors.push(r.error); continue; }
    const v = validateTarget(r.values, { name });
    if (v.verdict !== 'valid') {
      errors.push(`${file}: ${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
      continue;
    }
    targets[name] = r.values;
  }

  let defaultTarget = null;
  const cfgFile = path.join(dir, 'config.toml');
  if (fs.existsSync(cfgFile)) {
    const r = readGuarded(cfgFile);
    if (!r.ok) errors.push(r.error);
    else {
      const unknown = Object.keys(r.values).filter((k) => k !== 'default_target');
      if (unknown.length) errors.push(`${cfgFile}: unknown key(s) ${unknown.join(', ')} (only default_target is read)`);
      const d = r.values.default_target;
      if (d !== undefined) {
        if (typeof d !== 'string' || !d.trim()) errors.push(`${cfgFile}: default_target must be a non-empty string`);
        else if (!targets[d]) errors.push(`${cfgFile}: default_target names no valid record in targets/ — never a silent "no default"`);
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
