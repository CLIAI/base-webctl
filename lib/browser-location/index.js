// Browser-location resolver entry point.
//
// Resolves the active browser-location mode from (highest precedence first):
//   1. opts.browserLocation                            (CLI --browser-location)
//   2. process.env.<ENV_PREFIX_LEGACY>BROWSER_LOCATION (env var)
//   3. dotenv `browser_location: <mode>`               (from the dotenv file)
//   4. built-in default = 'chromium-docker-xpra-debian-latest'
//
// Returns { mode, driver } where driver implements the contract documented in
// docs/browser-location-modes.design.md.
//
// On unknown / unimplemented mode the resolver calls onError (default: print +
// process.exit(4)).
//
// CONSTANTS-ISOLATED (sm2t seam — arch-constants-injection-seam-sm2t): the project
// name + env-var prefix are read from the INJECTED `C`, so `createBrowserLocation(C,
// opts)` returns the surface. This is the chain AGGREGATOR (extracted LAST): it
// builds the C-bound registry (→ driver) and references mounts.migrationBannerMarker;
// the driver opts (fileStaging / dockerfilesDir / version) thread through registry →
// driver. opts.registry / opts.mounts / opts.fs inject for tests.
//
// Tag: [WEBCTL] — per-repo project resolved from the injected `C`

import nodeFs from 'node:fs';
import path from 'node:path';

import { assertConstants } from '../client-config.constants.template.js';
import { createRegistry } from './registry.js';
import { createMounts } from './mounts.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

// PR #3 flipped the built-in default from 'localhost-direct' to the docker-xpra
// mode. Default is the DEBIAN base (real upstream chromium via apt) — the ubuntu
// base installed Google Chrome and reported "Google Chrome", whose
// /opt/google/chrome/chrome was the binary crashing in the field. Debian's
// `chromium` package is genuine upstream Chromium. The ubuntu (Google-Chrome) and
// arch bases remain selectable via --browser-location. (C-independent literals.)
const DEFAULT_MODE = 'chromium-docker-xpra-debian-latest';
const LEGACY_DEFAULT_MODE = 'localhost-direct';
const DOTENV_KEY = 'browser_location';

/**
 * Create the browser-location resolver surface bound to a tool's constants.
 *
 * @param {ClientConfigConstants} C
 * @param {{ assert?: boolean, registry?: any, mounts?: any, fs?: any, fileStaging?: any,
 *           dockerfilesDir?: string | (() => string), version?: string | null }} [opts]
 * @returns {object}
 */
export function createBrowserLocation(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createBrowserLocation' });

  const fs = opts.fs || nodeFs;
  const mounts = opts.mounts || createMounts(C, { assert: false, dockerfilesDir: opts.dockerfilesDir });
  // Build (or accept) the registry; forward the driver opts + skip redundant assert.
  const registry = opts.registry || createRegistry(C, { ...opts, mounts, assert: false });
  const { isKnown, getFactory, listModes, listAvailableModes } = registry;

  // Env var that overrides the mode. The BROWSER_LOCATION suffix is SHARED; only
  // the prefix is project-specific. We use the LEGACY prefix because
  // BROWSER_LOCATION is one of the ENV_LEGACY_SUFFIXES kept for back-compat —
  // the historical spelling the migration banner advertises. Falls back to the
  // canonical prefix only when no legacy prefix is declared by the repo.
  const ENV_VAR = (C.ENV_PREFIX_LEGACY || C.ENV_PREFIX) + 'BROWSER_LOCATION';

  /**
   * Resolve the browser-location mode from the precedence chain. Pure.
   * @param {any} sources
   * @returns {string} the resolved mode key
   */
  function resolveMode(sources) {
    const s = sources || {};
    if (s.cli) return String(s.cli).trim();
    const env = s.env || {};
    if (env[ENV_VAR]) return String(env[ENV_VAR]).trim();
    const dotenv = s.dotenv || {};
    // Accept either the lowercase dotenv-style key or the env-var-style key
    // inside dotenv files (people are inconsistent; be forgiving).
    if (dotenv[DOTENV_KEY]) return String(dotenv[DOTENV_KEY]).trim();
    if (dotenv[ENV_VAR])    return String(dotenv[ENV_VAR]).trim();
    const jsonc = s.jsonc || {};
    // JSONC: accept camelCase or snake_case
    if (jsonc.browserLocation)  return String(jsonc.browserLocation).trim();
    if (jsonc.browser_location) return String(jsonc.browser_location).trim();
    return DEFAULT_MODE;
  }

  /**
   * Return true when the resolved mode came from the BUILT-IN default (no CLI /
   * env / dotenv user input). Used by the migration banner to detect
   * first-run-after-default-flip.
   * @param {any} sources
   */
  function isUnsetByUser(sources) {
    const s = sources || {};
    if (s.cli) return false;
    const env = s.env || {};
    if (env[ENV_VAR]) return false;
    const dotenv = s.dotenv || {};
    if (dotenv[DOTENV_KEY] || dotenv[ENV_VAR]) return false;
    const jsonc = s.jsonc || {};
    if (jsonc.browserLocation || jsonc.browser_location) return false;
    return true;
  }

  /**
   * Show a one-time migration banner explaining the default-flip from
   * localhost-direct to docker-xpra. Idempotent — writes a marker file the first
   * time it fires.
   * @param {any} bannerOpts
   * @returns {boolean} true if the banner was shown
   */
  function maybeShowMigrationBanner(bannerOpts) {
    const o = bannerOpts || {};
    const out = o.stderr || process.stderr;
    let markerPath;
    try {
      markerPath = mounts.migrationBannerMarker();
      if (fs.existsSync(markerPath)) return false;
    } catch {
      // mounts module unavailable in some test contexts — skip banner.
      return false;
    }
    out.write(
      '\n' +
      `[${C.PROJECT}] Default browser mode changed.\n` +
      '  The built-in default is now "chromium-docker-xpra-debian-latest"\n' +
      '  (REAL upstream Chromium under xpra/X11 in two docker containers;\n' +
      '   stronger anti-detection, persistent profile via bind-mount).\n' +
      '\n' +
      '  First-time setup is automatic on the next docker command, but\n' +
      '  building the two images takes a few minutes the first time.\n' +
      '\n' +
      '  Your options:\n' +
      `    1. Run \`${C.PROJECT} docker build\` to pre-build the images.\n` +
      '    2. Keep the legacy on-host behavior with one of:\n' +
      '         --browser-location localhost-direct\n' +
      `         export ${ENV_VAR}=localhost-direct\n` +
      `         echo "browser_location: localhost-direct" >> ${C.DOTENV_FILENAME}\n` +
      '\n' +
      '  Details: docs/browser-location-modes.design.md\n' +
      '  (This message is shown once per host.)\n\n'
    );
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, new Date().toISOString() + '\n');
    } catch { /* best-effort */ }
    return true;
  }

  /**
   * Main entry point: resolve mode + instantiate driver.
   * @param {any} resolveOpts
   * @returns {{mode: string, driver: object} | any}
   */
  function resolveBrowserLocation(resolveOpts) {
    const o = resolveOpts || {};
    const mode = resolveMode({
      cli:    o.browserLocation || null,
      env:    o.env || process.env,
      dotenv: o.dotenv || {},
      jsonc:  o.jsonc  || {},
    });

    const fail = (/** @type {string} */ msg, /** @type {number} */ code) => {
      if (typeof o.onError === 'function') {
        return o.onError(msg, code);
      }
      process.stderr.write(msg + '\n');
      // EXIT.CONFIG_ERROR = 4 (kept in sync with the runner)
      process.exit(code || 4);
    };

    if (!isKnown(mode)) {
      const available = listAvailableModes().join(', ');
      const all = listModes().join(', ');
      return fail(
        `Unknown --browser-location mode: "${mode}"\n` +
        `  Available now: ${available}\n` +
        `  All known modes (some future): ${all}`,
        4
      );
    }

    const factory = getFactory(mode);
    if (!factory) {
      const available = listAvailableModes().join(', ');
      return fail(
        `--browser-location mode "${mode}" is not yet implemented.\n` +
        `  Available now: ${available}\n` +
        `  See docs/browser-location-modes.design.md for the rollout plan.`,
        4
      );
    }

    const driver = factory.createDriver(o.driverConfig || {});
    return { mode, driver };
  }

  return {
    resolveBrowserLocation,
    resolveMode,
    isUnsetByUser,
    maybeShowMigrationBanner,
    DEFAULT_MODE,
    LEGACY_DEFAULT_MODE,
    ENV_VAR,
    DOTENV_KEY,
  };
}
