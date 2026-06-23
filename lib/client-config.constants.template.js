// lib/client-config.constants.template.js — the SHAPE of the per-repo constants
// seam (arch-constants-injection-seam-sm2t). base ships this template + the
// validator ONLY; it never ships a tool's real values (sb7q, Greg-approved
// 2026-05-30 co-design contract).
//
// Each consuming tool keeps its own `lib/client-config.constants.js` (pure
// frozen data) and injects it into base's factories:
//
//   const C = require('./client-config.constants');           // per-repo, stays in consumer
//   const { createClientConfig } = require('../vendor/base-webctl/lib/client-config.js');
//   module.exports = createClientConfig(C);
//
// Tag: [WEBCTL]

/**
 * The per-repo constants every base factory accepts. ONLY values that genuinely
 * differ between tools live here; everything identical is base-owned (e.g. the
 * port offsets + ENV_SUFFIXES in client-config.js).
 *
 * @typedef {object} ClientConfigConstants
 * @property {string}   PROJECT              project identity, e.g. "<tool>-webctl"
 * @property {string}   ARTIFACT_PREFIX      exact docker name prefix, "<tool>-webctl-" (multi-tenant safety)
 * @property {string}   IMAGE_CHROMIUM_REPO  "<tool>-webctl/chromium" (base appends -<x>:latest)
 * @property {string}   IMAGE_XPRA           "<tool>-webctl/xpra-ubuntu:latest"
 * @property {number}   DEFAULT_CDP_PORT     distinct per tool so tools co-reside
 * @property {string}   CACHE_DIRNAME        ~/.cache/CLIAI/<CACHE_DIRNAME>/...
 * @property {string}   ZOOM_DEFAULT_HOST    per-host zoom target hostname
 * @property {string}   CONFIG_FILE_PROJECT  per-project JSONC layer filename
 * @property {string}   DOTENV_FILENAME      e.g. ".env.<tool>-webctl"
 * @property {string}   DOTENV_TEMPLATE      e.g. ".env.<tool>-webctl.example"
 * @property {string}   ENV_PREFIX           canonical env-var prefix
 * @property {?string}  ENV_PREFIX_LEGACY    back-compat prefix, or null
 * @property {string[]} ENV_LEGACY_SUFFIXES  suffixes that also accept the legacy prefix (may be [])
 */

/**
 * Keys that MUST be present and non-empty on an injected constants object.
 * `ENV_PREFIX_LEGACY` is intentionally excluded — it is required-present but
 * MAY be null (a tool with no legacy prefix). `ENV_LEGACY_SUFFIXES` is checked
 * as an array (possibly empty) separately.
 * @type {Array<keyof ClientConfigConstants>}
 */
export const REQUIRED_KEYS = /** @type {Array<keyof ClientConfigConstants>} */ ([
  'PROJECT', 'ARTIFACT_PREFIX', 'IMAGE_CHROMIUM_REPO', 'IMAGE_XPRA',
  'DEFAULT_CDP_PORT', 'CACHE_DIRNAME', 'ZOOM_DEFAULT_HOST', 'CONFIG_FILE_PROJECT',
  'DOTENV_FILENAME', 'DOTENV_TEMPLATE', 'ENV_PREFIX',
]);

/**
 * Validate an injected per-repo constants object (default-on in every factory;
 * pass `{ assert: false }` to a factory to skip — the advanced-caller escape
 * hatch). Throws a loud, redaction-safe error naming missing/malformed keys so
 * a bad constants object fails fast instead of producing a silently-wrong
 * artifact name (a multi-tenant hazard, dip7).
 *
 * @param {Partial<ClientConfigConstants>} C
 * @param {{ context?: string }} [opts]
 * @returns {ClientConfigConstants} the same object (validated), for chaining
 */
export function assertConstants(C, opts = {}) {
  const where = opts.context ? ` (${opts.context})` : '';
  if (!C || typeof C !== 'object') {
    throw new Error(`client-config constants${where}: expected an object, got ${C === null ? 'null' : typeof C}`);
  }
  /** @type {string[]} */
  const problems = [];
  for (const k of REQUIRED_KEYS) {
    const v = /** @type {any} */ (C)[k];
    if (v === undefined || v === null || v === '') problems.push(`missing/empty: ${k}`);
  }
  // ENV_PREFIX_LEGACY: required-present, but may be null.
  if (!('ENV_PREFIX_LEGACY' in C)) problems.push('missing key: ENV_PREFIX_LEGACY (may be null, but must be present)');
  // ENV_LEGACY_SUFFIXES: must be an array (possibly empty).
  if (!Array.isArray(/** @type {any} */ (C).ENV_LEGACY_SUFFIXES)) problems.push('ENV_LEGACY_SUFFIXES must be an array (may be [])');
  // DEFAULT_CDP_PORT must be a number.
  if (C.DEFAULT_CDP_PORT != null && typeof C.DEFAULT_CDP_PORT !== 'number') problems.push('DEFAULT_CDP_PORT must be a number');

  if (problems.length) {
    throw new Error(
      `Invalid client-config constants${where} — base factories require the full ` +
      `per-repo shape (see ClientConfigConstants in client-config.constants.template.js):\n` +
      problems.map(p => `  - ${p}`).join('\n')
    );
  }
  return /** @type {ClientConfigConstants} */ (C);
}

/**
 * A SHAPE-ONLY placeholder. Every property access throws — so accidentally
 * wiring the template in place of a real per-repo constants file is impossible
 * to miss (Greg's decision, 2026-06-23). NEVER ship real values here.
 * @type {ClientConfigConstants}
 */
export const TEMPLATE = /** @type {any} */ (new Proxy({}, {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
    throw new Error(
      `client-config.constants.template.js is a SHAPE ONLY — '${String(prop)}' has no value. ` +
      `Each tool must ship its own lib/client-config.constants.js with real per-repo ` +
      `values (see the ClientConfigConstants typedef).`
    );
  },
}));
