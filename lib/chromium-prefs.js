// Chromium Preferences scrub helpers.
//
// Mechanism C: write `partition.per_host_zoom_levels.x[<host>] =
// {zoom_level, last_modified}` in `<profile>/Default/Preferences` BEFORE
// chromium starts, so docker-xpra and on-host launches deterministically pin
// the target site's per-host zoom to a configured percentage.
//
// Native Chromium zoom_level encoding: zoom_level = log(zoom_ratio) / log(1.2)
//
// The per-repo zoom target + tool name come from the INJECTED constants `C`
// (the seam — arch-constants-injection-seam-sm2t): `createChromiumPrefs(C)`
// returns the surface; pure encoders are base-level named exports.
//
// Tag: [TOOL::*]

import fs from 'node:fs';
import path from 'node:path';
import { assertConstants } from './client-config.constants.template.js';

/** @typedef {import('./client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

/**
 * "Webkit-time" epoch (microseconds since 1601-01-01 UTC) for `last_modified`.
 * @param {Date} [now]
 * @returns {string}
 */
function _webkitMicros(now) {
  const ms = (now || new Date()).getTime();
  return String((ms + 11644473600000) * 1000);
}

/**
 * Parse a user-provided zoom value into a normalised ratio in (0, 5].
 * `> 5` ⇒ percent (80 → 0.80); `≤ 5` ⇒ ratio (0.8 → 0.80).
 * @param {number|string|null|undefined} raw
 * @returns {number}
 * @throws {Error} on parse failure
 */
export function parseZoomInput(raw) {
  if (raw === null || raw === undefined || raw === '') {
    throw new Error('zoom value is required');
  }
  let s = String(raw).trim();
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`zoom value '${raw}' is not a number`);
  }
  if (n <= 0) {
    throw new Error(`zoom value '${raw}' must be positive (got ${n})`);
  }
  let ratio;
  if (n > 5) {
    if (n > 500) {
      throw new Error(`zoom percent '${raw}' must be ≤ 500 (got ${n})`);
    }
    ratio = n / 100;
  } else {
    ratio = n;
  }
  if (ratio <= 0 || ratio > 5) {
    throw new Error(`zoom ratio out of range (got ${ratio}; expected (0, 5])`);
  }
  return ratio;
}

/**
 * Convert a zoom ratio to Chromium's `zoom_level` field.
 * @param {number} ratio
 * @returns {number}
 */
export function ratioToZoomLevel(ratio) {
  return Math.log(ratio) / Math.log(1.2);
}

/**
 * Inverse: `zoom_level` field → ratio.
 * @param {number} zoomLevel
 * @returns {number}
 */
export function zoomLevelToRatio(zoomLevel) {
  return Math.pow(1.2, zoomLevel);
}

/**
 * Resolve the Preferences file inside a Chromium profile dir.
 * @param {string} profileDir
 * @returns {string}
 */
export function preferencesPath(profileDir) {
  return path.join(profileDir, 'Default', 'Preferences');
}

/**
 * Apply a per-host zoom_level to a Chromium Preferences JSON file.
 * Creates/updates/skips; atomic (tmp + rename); refuses corrupt JSON.
 * @param {string} prefsPath
 * @param {string} host
 * @param {number} targetRatio
 * @returns {{action: 'created'|'updated'|'skip', prevRatio: number|null, newRatio: number, prevZoomLevel: number|null, newZoomLevel: number}}
 */
export function applyHostZoomToPreferences(prefsPath, host, targetRatio) {
  if (!prefsPath) throw new Error('prefsPath required');
  if (!host) throw new Error('host required');
  if (!(targetRatio > 0)) throw new Error('targetRatio must be > 0');

  const targetZoomLevel = ratioToZoomLevel(targetRatio);
  const fileExists = fs.existsSync(prefsPath);

  /** @type {any} */
  let data;
  if (fileExists) {
    let raw;
    try {
      raw = fs.readFileSync(prefsPath, 'utf8');
    } catch (/** @type {any} */ e) {
      throw new Error(`could not read ${prefsPath}: ${e.message}`);
    }
    try {
      data = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch (/** @type {any} */ e) {
      throw new Error(
        `Preferences file is not valid JSON, refusing to scrub: ${prefsPath}\n` +
        `  parse error: ${e.message}`
      );
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Preferences root is not an object: ${prefsPath}`);
    }
  } else {
    data = {};
  }

  if (!data.partition || typeof data.partition !== 'object' || Array.isArray(data.partition)) {
    data.partition = {};
  }
  if (!data.partition.per_host_zoom_levels || typeof data.partition.per_host_zoom_levels !== 'object' || Array.isArray(data.partition.per_host_zoom_levels)) {
    data.partition.per_host_zoom_levels = {};
  }
  if (!data.partition.per_host_zoom_levels.x || typeof data.partition.per_host_zoom_levels.x !== 'object' || Array.isArray(data.partition.per_host_zoom_levels.x)) {
    data.partition.per_host_zoom_levels.x = {};
  }
  const hostMap = data.partition.per_host_zoom_levels.x;
  const existing = hostMap[host];
  let prevZoomLevel = null;
  let prevRatio = null;
  if (existing && typeof existing === 'object' && !Array.isArray(existing) && typeof existing.zoom_level === 'number') {
    prevZoomLevel = existing.zoom_level;
    prevRatio = zoomLevelToRatio(prevZoomLevel);
  }

  if (prevZoomLevel !== null && Math.abs(prevZoomLevel - targetZoomLevel) < 1e-6) {
    return { action: 'skip', prevRatio, newRatio: targetRatio, prevZoomLevel, newZoomLevel: targetZoomLevel };
  }

  hostMap[host] = {
    last_modified: _webkitMicros(new Date()),
    zoom_level: targetZoomLevel,
  };

  const dir = path.dirname(prefsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.Preferences.tmp.${process.pid}.${Date.now()}`);
  const serialised = JSON.stringify(data);
  fs.writeFileSync(tmpPath, serialised, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, prefsPath);

  return { action: fileExists ? 'updated' : 'created', prevRatio, newRatio: targetRatio, prevZoomLevel, newZoomLevel: targetZoomLevel };
}

/**
 * Pin "On startup → New Tab page" (`session.restore_on_startup = 5` +
 * `session.startup_urls = []`) so idle-to-blank reclaim isn't undone by a
 * session restore. Pure + idempotent; same atomic-write style.
 * @param {string} prefsPath
 * @returns {{action: 'created'|'updated'|'skip', prevRestoreOnStartup: number|null}}
 */
export function applyStartupPolicyToPreferences(prefsPath) {
  if (!prefsPath) throw new Error('prefsPath required');
  const RESTORE_NEWTAB = 5;
  const fileExists = fs.existsSync(prefsPath);

  /** @type {any} */
  let data;
  if (fileExists) {
    let raw;
    try {
      raw = fs.readFileSync(prefsPath, 'utf8');
    } catch (/** @type {any} */ e) {
      throw new Error(`could not read ${prefsPath}: ${e.message}`);
    }
    try {
      data = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch (/** @type {any} */ e) {
      throw new Error(
        `Preferences file is not valid JSON, refusing to scrub: ${prefsPath}\n` +
        `  parse error: ${e.message}`
      );
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Preferences root is not an object: ${prefsPath}`);
    }
  } else {
    data = {};
  }

  if (!data.session || typeof data.session !== 'object' || Array.isArray(data.session)) {
    data.session = {};
  }
  const prevRestoreOnStartup = typeof data.session.restore_on_startup === 'number'
    ? data.session.restore_on_startup
    : null;
  const urlsAlreadyEmpty = Array.isArray(data.session.startup_urls)
    && data.session.startup_urls.length === 0;

  if (prevRestoreOnStartup === RESTORE_NEWTAB && urlsAlreadyEmpty) {
    return { action: 'skip', prevRestoreOnStartup };
  }

  data.session.restore_on_startup = RESTORE_NEWTAB;
  data.session.startup_urls = [];

  const dir = path.dirname(prefsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.Preferences.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, prefsPath);

  return { action: fileExists ? 'updated' : 'created', prevRestoreOnStartup };
}

/**
 * Create the chromium-prefs surface bound to a tool's per-repo constants.
 * Provides the per-repo `DEFAULT_HOST` (zoom target) + `scrubProfileZoom`
 * (which names the tool in its refusal message); pure encoders are re-exposed
 * so the returned object is the same flat surface consumers expect.
 *
 * @param {ClientConfigConstants} C
 * @param {{ assert?: boolean }} [opts]  assert defaults TRUE (escape hatch: false)
 * @returns {object}
 */
export function createChromiumPrefs(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createChromiumPrefs' });

  const DEFAULT_HOST = C.ZOOM_DEFAULT_HOST;

  /**
   * Top-level: scrub the zoom_level for a host in a Chromium profile dir.
   * Refuses when a live profile-lock holder exists unless `{force:true}`.
   * @param {string} profileDir
   * @param {object} opts
   * @param {string} [opts.host]
   * @param {number} opts.ratio
   * @param {any} [opts.profileLock]
   * @param {Function} [opts.dockerInspect]
   * @param {boolean} [opts.force]
   * @returns {Promise<{ok: boolean, reason?: string, result?: object}>}
   */
  async function scrubProfileZoom(profileDir, opts) {
    if (!profileDir) throw new Error('profileDir required');
    if (!opts || typeof opts !== 'object') throw new Error('opts required');
    const host = opts.host || DEFAULT_HOST;
    const ratio = opts.ratio;
    if (!(ratio > 0)) throw new Error('opts.ratio must be > 0');

    if (opts.profileLock && !opts.force) {
      try {
        const existing = opts.profileLock.readLock(profileDir);
        if (existing) {
          const liveness = await opts.profileLock.isHolderAlive(existing, {
            dockerInspect: opts.dockerInspect,
          });
          if (liveness.alive) {
            return {
              ok: false,
              reason:
                `Profile is currently in use; refusing to write zoom pref:\n` +
                `  profile: ${profileDir}\n` +
                `  holder:  ${opts.profileLock.describeHolder(existing)}\n` +
                `  Resolve: stop the holder (e.g. \`${C.PROJECT} docker down\`) first,\n` +
                `           OR pass --force to override.`,
            };
          }
        }
      } catch (_) {
        // Profile-lock probe is best-effort; proceed on failure.
      }
    }

    const result = applyHostZoomToPreferences(preferencesPath(profileDir), host, ratio);
    return { ok: true, result };
  }

  return {
    DEFAULT_HOST,
    parseZoomInput,
    ratioToZoomLevel,
    zoomLevelToRatio,
    preferencesPath,
    applyHostZoomToPreferences,
    applyStartupPolicyToPreferences,
    scrubProfileZoom,
  };
}
