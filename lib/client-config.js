// lib/client-config.js — SHARED client/config resolver (cross-repo co-design).
//
// CO-DESIGN CONTRACT between the *-webctl sibling tools (Greg-approved
// 2026-05-30). This file contains NO project literal (no per-tool name, no
// per-tool env prefix). Everything project-specific is read from an INJECTED
// per-repo constants object `C` (the seam — arch-constants-injection-seam-sm2t):
// `createClientConfig(C)` returns the resolver surface; the consumer shim does
// `module.exports = createClientConfig(require('./client-config.constants'))`.
//
// The SHARED values (identical in both repos) are base-owned, defined at module
// scope below — they are NOT part of the per-repo seam.
//
// Pure, zero-dep (fs/os/path + the injected constants). Every resolver takes
// state EXPLICITLY (no module globals) so it is trivially unit-testable.
//
// Tag: [WEBCTL]

import fs from 'node:fs';
import path from 'node:path';
import { assertConstants } from './client-config.constants.template.js';

/** @typedef {import('./client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

/**
 * @typedef {object} ResolverState
 * @property {Record<string, any>} [args]
 * @property {Record<string, string>} [dotenv]
 * @property {Record<string, string>} [env]
 * @property {Record<string, any>} [jsonc]
 * @property {string} [mode]
 * @property {string} [base]
 * @property {(raw: any) => any} [zoomParse]
 *
 * @typedef {object} ResolveEnvOpts
 * @property {Record<string, any>} [args]
 * @property {string} [argKey]
 * @property {Record<string, string>} [dotenv]
 * @property {Record<string, string>} [env]
 * @property {Record<string, any>} [jsonc]
 * @property {string[]} [jsoncKeys]
 */

// ── SHARED constants (identical in both repos → base-owned, NOT in the seam) ──
export const CACHE_BASE = ['.cache', 'CLIAI'];
export const CONFIG_BASE = ['.config', 'CLIAI'];
export const CONFIG_SUBDIR = 'webctl';
export const CONFIG_FILE_BASE = 'base-webctl.config.jsonc';

export const PORT_OFFSET_XPRA_TCP = 10000;
export const PORT_OFFSET_XPRA_TCP_FALLBACK = 100;
export const PORT_FALLBACK_THRESHOLD = 55535;
export const PORT_OFFSET_HTML5 = 1;
export const DEFAULT_HOST = '127.0.0.1';

// The pre-unification CDP port/host env alias. Shared by BOTH repos, so it is
// base-owned rather than per-repo. ARBITRARY prefix, unrelated to ENV_PREFIX.
export const LEGACY_PORTHOST_PREFIX = 'CHROME_WS_';

// logical key → {suffix, container?}. Suffixes are SHARED across repos; only
// the prefix (C.ENV_PREFIX / C.ENV_PREFIX_LEGACY) differs.
export const ENV_SUFFIXES = Object.freeze({
  instance:        { suffix: 'INSTANCE' },
  port:            { suffix: 'PORT',             container: 'LWC_CDP_PORT' },
  host:            { suffix: 'HOST' },
  browserLocation: { suffix: 'BROWSER_LOCATION' },
  userDataDir:     { suffix: 'USER_DATA_DIR',    container: 'LWC_CHROMIUM_PROFILE' },
  cacheDir:        { suffix: 'CACHE_DIR' },
  lockMaxAgeMin:   { suffix: 'LOCK_MAX_AGE_MIN' },
  ozonePlatform:   { suffix: 'OZONE_PLATFORM' },
  windowSize:      { suffix: 'WINDOW_SIZE' },
  zoomPercent:     { suffix: 'ZOOM_PERCENT' },
  shmSize:         { suffix: 'SHM_SIZE' },
  disableDevShm:   { suffix: 'DISABLE_DEV_SHM',  container: 'LWC_DISABLE_DEV_SHM' },
});

// ── Pure helpers (no per-repo constants → base-level named exports) ───────────

/**
 * Parse JSONC (JSON with Comments) text. Strips single-line (//) and
 * multi-line comments + trailing commas; comment delimiters inside JSON
 * strings are preserved.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { result += c; escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      if (c === '"') inString = false;
      result += c;
      continue;
    }
    if (c === '"') { inString = true; result += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // skip closing /
      continue;
    }
    result += c;
  }
  result = result.replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(result);
}

/**
 * Parse a dotenv file into a key-value object. Handles blank lines, #
 * comments, KEY=VALUE, quoted values; no variable expansion.
 * @param {string} filepath
 * @returns {Record<string, string>}
 */
export function parseDotenv(filepath) {
  /** @type {Record<string, string>} */
  const env = {};
  const content = fs.readFileSync(filepath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/**
 * Pure name-builder (no dependency on the injected constants). Exposed so the
 * "arbitrary legacy prefix" property is unit-provable with synthetic inputs.
 * @param {string} prefix
 * @param {string|null} legacyPrefix
 * @param {string[]} legacySuffixes
 * @param {string} suffix
 * @returns {string[]} canonical-first candidate names
 */
export function buildEnvNames(prefix, legacyPrefix, legacySuffixes, suffix) {
  const names = [prefix + suffix];
  if (legacyPrefix != null && legacySuffixes.includes(suffix)) {
    names.push(legacyPrefix + suffix);
  }
  return names;
}

/**
 * Create the client/config resolver bound to a tool's per-repo constants.
 *
 * @param {ClientConfigConstants} C  the injected per-repo constants
 * @param {{ assert?: boolean }} [opts]  assert defaults TRUE (fail-fast); pass
 *   `{ assert: false }` to skip validation (advanced-caller escape hatch).
 * @returns {object} the resolver surface (same flat shape consumers expect)
 */
export function createClientConfig(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createClientConfig' });

  /**
   * Load and merge JSONC config files using the 4-layer precedence.
   * @param {string} client
   * @returns {{ merged: Record<string, any>, layers: Array<{path: string, loaded: boolean}> }}
   */
  function loadJsoncConfig(client) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configBase = path.join(home, ...CONFIG_BASE);
    const layerPaths = [
      path.join(configBase, 'default', CONFIG_SUBDIR, CONFIG_FILE_BASE),
      path.join(configBase, client, CONFIG_SUBDIR, CONFIG_FILE_BASE),
      path.join(configBase, 'default', CONFIG_SUBDIR, C.CONFIG_FILE_PROJECT),
      path.join(configBase, client, CONFIG_SUBDIR, C.CONFIG_FILE_PROJECT),
    ];
    const seen = new Set();
    /** @type {Record<string, any>} */
    const merged = {};
    const layers = [];
    for (const layerPath of layerPaths) {
      if (seen.has(layerPath)) continue;
      seen.add(layerPath);
      let loaded = false;
      try {
        const text = fs.readFileSync(layerPath, 'utf-8');
        const parsed = parseJsonc(text);
        Object.assign(merged, parsed);
        loaded = true;
      } catch (_) { /* silently skip missing/unreadable files */ }
      layers.push({ path: layerPath, loaded });
    }
    return { merged, layers };
  }

  /**
   * Discover + load the dotenv file (CWD then global; process.exit(4) on a
   * dual-global conflict, matching the monolith's EXIT.CONFIG_ERROR).
   * @returns {{ env: Record<string, string>, source: string|null }}
   */
  function loadDotenv() {
    const filename = C.DOTENV_FILENAME;
    try {
      const localPath = path.join(process.cwd(), filename);
      if (fs.existsSync(localPath)) {
        return { env: parseDotenv(localPath), source: localPath };
      }
    } catch (_) { /* CWD unavailable — fall through to global */ }

    const home = process.env.HOME || process.env.USERPROFILE || '';
    const homePath = path.join(home, filename);
    const configPath = path.join(home, ...CONFIG_BASE, C.PROJECT, filename);
    const homeExists = home && fs.existsSync(homePath);
    const configExists = home && fs.existsSync(configPath);

    if (homeExists && configExists) {
      console.error(`ERROR: Conflicting global dotenv files found:`);
      console.error(`  ${homePath}`);
      console.error(`  ${configPath}`);
      console.error(`Remove one to resolve ambiguity.`);
      process.exit(4); // EXIT.CONFIG_ERROR
    }
    if (configExists) return { env: parseDotenv(configPath), source: configPath };
    if (homeExists) return { env: parseDotenv(homePath), source: homePath };
    return { env: {}, source: null };
  }

  /**
   * Build candidate env-var names for a logical key, CANONICAL-FIRST.
   * @param {string} logicalKey
   * @returns {string[]}
   */
  function envNames(logicalKey) {
    const entry = /** @type {Record<string, {suffix: string}>} */ (ENV_SUFFIXES)[logicalKey];
    if (!entry) return [];
    const suffix = entry.suffix;
    const names = [C.ENV_PREFIX + suffix];
    if (C.ENV_PREFIX_LEGACY != null && C.ENV_LEGACY_SUFFIXES.includes(suffix)) {
      names.push(C.ENV_PREFIX_LEGACY + suffix);
    }
    return names;
  }

  /**
   * Resolve a single logical value with precedence:
   *   CLI > dotenv > process.env > jsonc > default.
   * @param {string} logicalKey
   * @param {ResolveEnvOpts} [opts]
   * @returns {{ value: any, source: string }}
   */
  function resolveEnvValue(logicalKey, opts) {
    const o = opts || {};
    const args = o.args || {};
    const argKey = o.argKey;
    const dotenv = o.dotenv || {};
    const procEnv = o.env || process.env;
    const jsonc = o.jsonc || {};
    const jsoncKeys = o.jsoncKeys || [];

    if (argKey && args[argKey] != null && args[argKey] !== '') {
      return { value: args[argKey], source: 'cli' };
    }
    const names = envNames(logicalKey);
    for (const n of names) {
      if (dotenv[n]) return { value: dotenv[n], source: `dotenv:${n}` };
    }
    for (const n of names) {
      if (procEnv[n]) return { value: procEnv[n], source: `env:${n}` };
    }
    for (const k of jsoncKeys) {
      if (jsonc[k] !== undefined && jsonc[k] !== null && jsonc[k] !== '') {
        return { value: jsonc[k], source: `jsonc:${k}` };
      }
    }
    return { value: undefined, source: 'default' };
  }

  /**
   * @param {number|string} cdpPort
   * @returns {number}
   */
  function _derivedXpraTcpPort(cdpPort) {
    const n = Number(cdpPort) || C.DEFAULT_CDP_PORT;
    return n < PORT_FALLBACK_THRESHOLD ? n + PORT_OFFSET_XPRA_TCP
                                       : n + PORT_OFFSET_XPRA_TCP_FALLBACK;
  }

  /**
   * Derive both xpra ports from a CDP port + JSONC overrides. SINGLE source of
   * truth. Override precedence preserved verbatim.
   * @param {number|string} cdpPort
   * @param {Record<string, any>} [jsonc]
   * @returns {{ xpraTcpPort: number, xpraHtml5Port: number, sources: { tcp: string, html5: string } }}
   */
  function deriveXpraPorts(cdpPort, jsonc) {
    const j = jsonc || {};
    const bag = (j.ports && typeof j.ports === 'object') ? j.ports : {};

    let tcp, tcpSource;
    if (bag['xpra-tcp']) { tcp = Number(bag['xpra-tcp']); tcpSource = 'jsonc.ports["xpra-tcp"]'; }
    else if (j.xpraTcpPort)   { tcp = Number(j.xpraTcpPort);   tcpSource = 'jsonc.xpraTcpPort'; }
    else if (j.xpra_tcp_port) { tcp = Number(j.xpra_tcp_port); tcpSource = 'jsonc.xpra_tcp_port'; }
    else { tcp = _derivedXpraTcpPort(cdpPort); tcpSource = 'derived'; }

    let html5, html5Source;
    if (bag['xpra-html5']) { html5 = Number(bag['xpra-html5']); html5Source = 'jsonc.ports["xpra-html5"]'; }
    else if (j.xpraHtml5Port)   { html5 = Number(j.xpraHtml5Port);   html5Source = 'jsonc.xpraHtml5Port'; }
    else if (j.xpra_html5_port) { html5 = Number(j.xpra_html5_port); html5Source = 'jsonc.xpra_html5_port'; }
    else { html5 = tcp + PORT_OFFSET_HTML5; html5Source = 'derived'; }

    return { xpraTcpPort: tcp, xpraHtml5Port: html5, sources: { tcp: tcpSource, html5: html5Source } };
  }

  /**
   * Resolve the docker-mode instance "slug". Sanitised to [a-zA-Z0-9_-].
   * @param {ResolverState} [state]
   * @returns {string}
   */
  function resolveSlug(state) {
    const s = state || {};
    const args = s.args || {};
    const jsonc = s.jsonc || {};
    const procEnv = s.env || process.env;
    let raw;
    for (const n of envNames('instance')) {
      if (procEnv[n]) { raw = procEnv[n]; break; }
    }
    if (!raw) {
      raw = jsonc.slug
        || (args.client && args.client !== 'default' ? args.client : null)
        || 'default';
    }
    return String(raw).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  /**
   * Resolve Chromium --user-data-dir (host path), NOT yet ~-expanded.
   * @param {ResolverState} [state]
   * @returns {any}
   */
  function resolveUserDataDir(state) {
    const s = state || {};
    const r = resolveEnvValue('userDataDir', {
      args: s.args, argKey: 'userDataDir',
      dotenv: s.dotenv, env: s.env, jsonc: s.jsonc,
      jsoncKeys: ['userDataDir', 'user_data_dir'],
    });
    return r.value != null ? r.value : null;
  }

  /**
   * Resolve configured browser zoom, or null when UNSET.
   * @param {ResolverState} [state]
   * @returns {{ raw: any, source: string }|null}
   */
  function resolveZoomPercent(state) {
    const s = state || {};
    const args = s.args || {};
    const dotenv = s.dotenv || {};
    const procEnv = s.env || process.env;
    const jsonc = s.jsonc || {};

    if (args.zoom !== null && args.zoom !== undefined) {
      return { raw: args.zoom, source: 'cli' };
    }
    const names = envNames('zoomPercent');
    for (const n of names) {
      if (dotenv[n]) return { raw: dotenv[n], source: 'dotenv' };
    }
    for (const n of names) {
      if (procEnv[n]) return { raw: procEnv[n], source: 'env' };
    }
    if (jsonc.zoom !== undefined && jsonc.zoom !== null) {
      return { raw: jsonc.zoom, source: 'jsonc' };
    }
    if (jsonc.zoom_percent !== undefined && jsonc.zoom_percent !== null) {
      return { raw: jsonc.zoom_percent, source: 'jsonc' };
    }
    return null;
  }

  /**
   * Resolve the CDP port.
   * @param {ResolverState} [state]
   * @returns {{ value: number, source: string }}
   */
  function resolvePort(state) {
    const s = state || {};
    const args = s.args || {};
    const dotenv = s.dotenv || {};
    const procEnv = s.env || process.env;
    const jsonc = s.jsonc || {};

    if (args.port) return { value: args.port, source: 'cli' };
    const names = envNames('port');
    for (const n of names) {
      const v = parseInt(dotenv[n], 10);
      if (v) return { value: v, source: `dotenv:${n}` };
    }
    for (const n of names) {
      const v = parseInt(procEnv[n] ?? '', 10);
      if (v) return { value: v, source: `env:${n}` };
    }
    const legacyName = LEGACY_PORTHOST_PREFIX + ENV_SUFFIXES.port.suffix;
    const lv = parseInt(procEnv[legacyName] ?? '', 10);
    if (lv) return { value: lv, source: `env:${legacyName}` };
    if (jsonc.port) return { value: parseInt(jsonc.port, 10), source: 'jsonc:port' };
    return { value: C.DEFAULT_CDP_PORT, source: 'default' };
  }

  /**
   * Resolve the CDP host.
   * @param {ResolverState} [state]
   * @returns {{ value: string, source: string }}
   */
  function resolveHost(state) {
    const s = state || {};
    const args = s.args || {};
    const dotenv = s.dotenv || {};
    const procEnv = s.env || process.env;
    const jsonc = s.jsonc || {};

    if (args.host) return { value: args.host, source: 'cli' };
    const names = envNames('host');
    for (const n of names) {
      if (dotenv[n]) return { value: dotenv[n], source: `dotenv:${n}` };
    }
    for (const n of names) {
      if (procEnv[n]) return { value: procEnv[n], source: `env:${n}` };
    }
    const legacyName = LEGACY_PORTHOST_PREFIX + ENV_SUFFIXES.host.suffix;
    if (procEnv[legacyName]) return { value: procEnv[legacyName], source: `env:${legacyName}` };
    if (jsonc.host) return { value: jsonc.host, source: 'jsonc:host' };
    return { value: DEFAULT_HOST, source: 'default' };
  }

  /**
   * Assemble the cfg object the browser-location drivers read.
   * @param {ResolverState} [state]
   * @returns {Record<string, any>}
   */
  function buildDriverCfg(state) {
    const s = state || {};
    const args = s.args || {};
    const dotenv = s.dotenv || {};
    const jsonc = s.jsonc || {};
    const port = resolvePort({ args, dotenv, env: s.env, jsonc }).value;
    const host = resolveHost({ args, dotenv, env: s.env, jsonc }).value;
    const slug = resolveSlug({ args, jsonc, env: s.env });
    const userDataDir = resolveUserDataDir({ args, dotenv, env: s.env, jsonc });
    const xpra = deriveXpraPorts(port, jsonc);
    const z = resolveZoomPercent({ args, dotenv, env: s.env, jsonc });
    return {
      mode: s.mode != null ? s.mode : null,
      base: s.base != null ? s.base : null,
      port, host, slug,
      xpraTcpPort:   xpra.xpraTcpPort,
      xpraHtml5Port: xpra.xpraHtml5Port,
      userDataDir,
      zoomRatio: z ? (typeof s.zoomParse === 'function' ? s.zoomParse(z.raw) : z.raw) : null,
      force: !!args.force,
      client: args.client != null ? args.client : 'default',
    };
  }

  return {
    // JSONC / dotenv
    parseJsonc, parseDotenv, loadJsoncConfig, loadDotenv,
    // env-name building + generic resolution
    envNames, buildEnvNames, resolveEnvValue,
    // port derivation
    deriveXpraPorts,
    // individual resolvers
    resolveSlug, resolveUserDataDir, resolveZoomPercent, resolvePort, resolveHost,
    // cfg builder
    buildDriverCfg,
    // shared constants (handy for tests / callers that need provenance)
    CACHE_BASE, CONFIG_BASE, CONFIG_SUBDIR, CONFIG_FILE_BASE,
    PORT_OFFSET_XPRA_TCP, PORT_OFFSET_XPRA_TCP_FALLBACK, PORT_FALLBACK_THRESHOLD,
    PORT_OFFSET_HTML5, DEFAULT_HOST, LEGACY_PORTHOST_PREFIX, ENV_SUFFIXES,
    // the injected per-repo constants module
    CONSTANTS: C,
  };
}
