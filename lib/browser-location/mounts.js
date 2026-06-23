// Path + mount layout for the docker-xpra mode.
//
// Adapted from xq (26Q2-docker-xpra-x11-apps), commit 64e5f9d
// Original: scripts/lib/apps.py (lines 37-53 mount builder)
// License: MIT (confirmed with author 2026-05-27)
//
// Single-instance variant — this tool is single-tenant unlike xq's
// per-zone multi-app fan-out, so we only build mounts for the one
// app (chromium) plus its X11 socket and (optional) pulse socket.
//
// CONSTANTS-ISOLATED (sm2t seam — arch-constants-injection-seam-sm2t): every
// project-specific value (cache dirname, artifact prefix, image repos) is read
// from the INJECTED constants `C`, so `createMounts(C)` returns a surface that
// is byte-identical across the webctl sibling repos. The `.cache`/`CLIAI`
// segments and the `xpra-`/`chromium-`/`x11-`/`net-` infixes are SHARED and
// stay literal.
//
// FILE-STAGING-AGNOSTIC (Greg-approved Option A, 2026-06-23): base owns the
// container-side upload path `CONTAINER_UPLOAD_DIR='/cliai-uploads'` and gates
// the dedicated upload mount on `cfg.uploadHostPath`. base does NOT depend on
// any per-repo `file-staging` module — a consumer that never sets uploadHostPath
// (linkedin) gets the pre-upload behaviour unchanged; a consumer that DOES set
// it (chatgpt) gets the read-only mount. The host-side staging/cleanup that
// PRODUCES uploadHostPath stays consumer-owned. Finding:
// FUTURE_WORK/migrate/260623-mounts-reconcile-file-staging-finding.md
//
// Tag: [WEBCTL] — per-repo project resolved from the injected constants `C`

import fs from 'node:fs';
import path from 'node:path';
import { assertConstants } from '../client-config.constants.template.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

/**
 * Dedicated container-side mount target for staged upload files. Base-owned:
 * a fixed cross-tool container path, identical across the webctl family (it is
 * NOT a per-repo seam value). The HOST side of the path is supplied per call as
 * `cfg.uploadHostPath`; the consumer's own file-staging owns producing it.
 */
export const CONTAINER_UPLOAD_DIR = '/cliai-uploads';

/**
 * The chromium-container base images base knows how to build. Each maps to a
 * `dockerfiles/chromium/<base>.Dockerfile` and a distinct image tag so the three
 * bases can coexist on one host without clobbering each other.
 *
 *   * ubuntu — legacy Google-Chrome-stable base (FALLBACK).
 *   * debian — REAL upstream chromium via `apt-get install chromium` (DEFAULT).
 *   * arch   — REAL upstream chromium via `pacman -S chromium` (selectable).
 */
export const CHROMIUM_BASES = ['ubuntu', 'debian', 'arch'];
export const DEFAULT_BASE = 'debian';

/**
 * Create the mount/path-layout surface bound to a tool's per-repo constants.
 *
 * @param {ClientConfigConstants} C
 * @param {{
 *   assert?: boolean,
 *   dockerfilesDir?: string | (() => string),
 * }} [opts]
 *   `assert` defaults TRUE (escape hatch: false). `dockerfilesDir` injects the
 *   CONSUMER-owned dockerfiles directory (an absolute path or a thunk) — required
 *   when base is vendored as a submodule, because the Dockerfiles live in the
 *   consumer repo, not in base. When omitted, dockerfilesDir() falls back to a
 *   module-relative `../../dockerfiles` (correct only for a standalone/in-tree
 *   layout; a vendored consumer MUST inject its own).
 * @returns {object}
 */
export function createMounts(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createMounts' });

  /**
   * Compute the per-host cache root this tool uses for docker state.
   * Mirrors the existing log-dir layout under ~/.cache/CLIAI/.
   * @returns {string}
   */
  function cacheRoot() {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    return path.join(home, '.cache', 'CLIAI', C.CACHE_DIRNAME);
  }

  /**
   * Expand a leading `~` in a host path. JSONC config and dotenv commonly use
   * `~/priv/...`; docker bind-mount sources must be absolute, so we always
   * expand here before handing the path to `docker run -v`.
   * @param {string} p
   * @returns {string}
   */
  function expandHomePath(p) {
    if (!p) return p;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (p === '~') return home;
    if (p.startsWith('~/')) return path.join(home, p.slice(2));
    return p;
  }

  /**
   * Compute the *default* chromium profile directory on the host for a given
   * slug — used when no explicit userDataDir is configured. Bind-mounted into
   * the container at /home/user/.config/chromium.
   * @param {string} slug  instance slug, e.g. 'default'
   * @returns {string} absolute host path
   */
  function profileDir(slug) {
    return path.join(cacheRoot(), 'profiles', slug || 'default', 'chromium');
  }

  /**
   * Resolve the chromium profile directory for the docker-xpra mode, with
   * explicit-config override. Precedence (high→low): explicit `userDataDir`
   * (CLI > dotenv > env > JSONC, already resolved by the runner), else a
   * cache-based default keyed by slug. The chosen path is `mkdir -p`'d and a
   * leading `~` expanded. This is the path docker bind-mounts into the chromium
   * container at /home/user/.config/chromium.
   * @param {string}      slug
   * @param {string|null} userDataDir  explicit path (or null/undefined)
   * @returns {string} absolute host path (mkdir -p'd)
   */
  function resolveChromiumProfile(slug, userDataDir) {
    const p = userDataDir ? expandHomePath(userDataDir) : profileDir(slug);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  /**
   * Back-compat alias. New code should call resolveChromiumProfile so an
   * explicit userDataDir is honored.
   * @param {string} slug
   * @returns {string}
   */
  function ensureProfileDir(slug) {
    return resolveChromiumProfile(slug, null);
  }

  /**
   * Marker file path for the one-time migration banner.
   * @returns {string}
   */
  function migrationBannerMarker() {
    return path.join(cacheRoot(), '.migration-banner-v2-shown');
  }

  /**
   * Normalise / validate a chromium base name. Falls back to DEFAULT_BASE for
   * null/undefined; throws on an unknown non-empty value so a typo in a mode key
   * surfaces loudly rather than silently building the wrong image.
   * @param {string|null|undefined} base
   * @returns {string}
   */
  function normalizeBase(base) {
    if (base == null || base === '') return DEFAULT_BASE;
    const b = String(base).trim().toLowerCase();
    if (!CHROMIUM_BASES.includes(b)) {
      throw new Error(
        `unknown chromium base "${base}" (known: ${CHROMIUM_BASES.join(', ')})`
      );
    }
    return b;
  }

  /**
   * Compute container and volume names for a given slug + chromium base.
   * Multi-tenant safety: every name carries `C.ARTIFACT_PREFIX` so we can always
   * filter by it when listing or stopping.
   *
   * The chromium IMAGE tag is base-specific (`<IMAGE_CHROMIUM_REPO>-<base>`) so
   * the ubuntu/debian/arch images coexist; the xpra image is always C.IMAGE_XPRA
   * (a single xpra base — only the browser half varies). Container/volume/network
   * names are keyed by SLUG only, NOT base: a slug runs exactly one base at a
   * time, so reusing the same names lets `down`/`rm`/`status` work regardless of
   * which base last ran.
   * @param {string} slug
   * @param {string} [base='debian']  one of CHROMIUM_BASES
   */
  function names(slug, base) {
    const s = slug || 'default';
    const b = normalizeBase(base);
    return {
      slug:           s,
      base:           b,
      xpraContainer:  `${C.ARTIFACT_PREFIX}xpra-${s}`,
      chromiumContainer: `${C.ARTIFACT_PREFIX}chromium-${s}`,
      xpraSocketVolume:  `${C.ARTIFACT_PREFIX}x11-${s}`,
      network:        `${C.ARTIFACT_PREFIX}net-${s}`,
      chromiumImage:  `${C.IMAGE_CHROMIUM_REPO}-${b}:latest`,
      xpraImage:      C.IMAGE_XPRA,
    };
  }

  /**
   * Resolve the dockerfiles dir. Uses the injected consumer-owned path when
   * provided (the vendored-submodule case); otherwise falls back to a
   * module-relative `../../dockerfiles` (standalone/in-tree only — base ships no
   * dockerfiles, so a vendored consumer MUST inject `opts.dockerfilesDir`).
   * @returns {string}
   */
  function dockerfilesDir() {
    const inj = opts.dockerfilesDir;
    if (typeof inj === 'function') return inj();
    if (typeof inj === 'string' && inj) return inj;
    // lib/browser-location/mounts.js -> ../../dockerfiles
    return path.resolve(import.meta.dirname, '..', '..', 'dockerfiles');
  }

  /**
   * Resolve the Dockerfile path for a chromium base relative to the dockerfiles
   * dir. The xpra image always uses its ubuntu Dockerfile.
   * @param {string} contextSub  'chromium' | 'xpra'
   * @param {string} [base='debian'] chromium base (ignored for xpra)
   * @returns {string} absolute path to the Dockerfile
   */
  function dockerfilePath(contextSub, base) {
    const dir = path.join(dockerfilesDir(), contextSub);
    if (contextSub === 'xpra') {
      return path.join(dir, 'ubuntu.Dockerfile');
    }
    return path.join(dir, `${normalizeBase(base)}.Dockerfile`);
  }

  /**
   * Build the mount list for the chromium container.
   *
   * @param {object} cfg
   * @param {string} cfg.profileHostPath  absolute host dir
   * @param {string} cfg.xpraSocketVolume named volume sharing /tmp/.X11-unix
   * @param {string} [cfg.uploadHostPath] per-slug host staging dir; when set, a
   *                 DEDICATED upload mount is added at CONTAINER_UPLOAD_DIR (WAY 1
   *                 of the attach-upload fix). Omitted when absent so non-upload
   *                 runs and the existing tests stay unchanged. This is a
   *                 copy-stage target, NOT a bind of any source data dir
   *                 (data-safety gate).
   * @returns {Array<[string,string,string]>}
   */
  function chromiumMounts(cfg) {
    const m = /** @type {Array<[string,string,string]>} */ ([
      [cfg.xpraSocketVolume, '/tmp/.X11-unix', 'rw'],
      [cfg.profileHostPath,  '/home/user/.config/chromium', 'rw'],
    ]);
    if (cfg.uploadHostPath) {
      // READ-ONLY: chromium only READS staged files (via setFileInputFiles), never
      // writes — `ro` blocks a compromised container from poisoning host staging,
      // at no cost. The HOST process copy-stages + cleans up directly on the host
      // filesystem (not through this mount), so staging/cleanup are unaffected.
      m.push([cfg.uploadHostPath, CONTAINER_UPLOAD_DIR, 'ro']);
    }
    return m;
  }

  /**
   * Build the mount list for the xpra container.
   * @param {object} cfg
   * @param {string} cfg.xpraSocketVolume named volume sharing /tmp/.X11-unix
   * @returns {Array<[string,string,string]>}
   */
  function xpraMounts(cfg) {
    return /** @type {Array<[string,string,string]>} */ ([
      [cfg.xpraSocketVolume, '/tmp/.X11-unix', 'rw'],
    ]);
  }

  return {
    cacheRoot,
    expandHomePath,
    profileDir,
    ensureProfileDir,
    resolveChromiumProfile,
    migrationBannerMarker,
    names,
    chromiumMounts,
    xpraMounts,
    dockerfilesDir,
    dockerfilePath,
    normalizeBase,
    CHROMIUM_BASES,
    DEFAULT_BASE,
    CONTAINER_UPLOAD_DIR,
  };
}
