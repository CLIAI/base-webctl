// Browser-location driver registry.
//
// Maps mode keys → driver-factory modules. A `null` entry means the mode is
// reserved for a future PR and not yet implemented; resolveBrowserLocation()
// rejects it with a clear error.
//
// CONSTANTS-ISOLATED (sm2t seam — arch-constants-injection-seam-sm2t): the
// registry content is byte-identical across consumers, but it must build the
// C-bound docker-xpra driver surface (createChromiumDockerXpra) and reference the
// constants-free localhost-direct module, so it is exposed as a factory
// `createRegistry(C, opts)`. The driver `opts` (fileStaging / dockerfilesDir /
// version) are forwarded to the built driver. `opts.driver` / `opts.localhostDirect`
// allow injection for tests.
//
// See: docs/browser-location-modes.design.md
//
// Tag: [TOOL::*]

import { assertConstants } from '../client-config.constants.template.js';
import * as baseLocalhostDirect from './localhost-direct.js';
import { createChromiumDockerXpra } from './chromium-docker-xpra.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

/**
 * Create the browser-location registry surface bound to a tool's constants.
 *
 * @param {ClientConfigConstants} C
 * @param {{ assert?: boolean, driver?: any, localhostDirect?: any, mounts?: any,
 *           fileStaging?: any, dockerfilesDir?: string | (() => string),
 *           version?: string | null }} [opts]
 * @returns {object}
 */
export function createRegistry(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createRegistry' });

  const localhostDirect = opts.localhostDirect || baseLocalhostDirect;
  // Build (or accept an injected) docker-xpra driver surface; forward the driver
  // opts (fileStaging / dockerfilesDir / version) and skip the redundant assert.
  const chromiumDockerXpra =
    opts.driver || createChromiumDockerXpra(C, { ...opts, assert: false });

  // The chromium-docker-xpra driver is base-parameterized: one driver module,
  // three bases. Each mode key resolves to a base-pinned factory (factoryForBase
  // injects { base, mode } into createDriver). Containers / volumes are slug-keyed
  // and base-independent, so `docker down/rm/status` for a slug work regardless of
  // which base last ran.
  //
  //   * debian — REAL upstream chromium (apt). The wired DEFAULT.
  //   * ubuntu — legacy Google-Chrome-stable base (FALLBACK; reports
  //     "Google Chrome", kept for continuity).
  //   * arch   — REAL upstream chromium (pacman). Selectable.
  /** @type {Record<string, any>} */
  const REGISTRY = {
    'localhost-direct': localhostDirect,
    // Real-Chromium docker-xpra bases (all implemented):
    'chromium-docker-xpra-debian-latest': chromiumDockerXpra.factoryForBase('debian'),
    'chromium-docker-xpra-ubuntu-latest': chromiumDockerXpra.factoryForBase('ubuntu'),
    'chromium-docker-xpra-arch-latest':   chromiumDockerXpra.factoryForBase('arch'),
    // Future modes (stubs — see design doc):
    'chromium-docker-headless-ubuntu-latest': null,  // future, CI-only
    'xpra-remote-host': null,                        // future
    'x11-remote': null,                              // future
  };

  function listModes() {
    return Object.keys(REGISTRY);
  }

  function listAvailableModes() {
    return Object.keys(REGISTRY).filter(k => REGISTRY[k] !== null);
  }

  /** @param {string} mode */
  function isKnown(mode) {
    return Object.prototype.hasOwnProperty.call(REGISTRY, mode);
  }

  /** @param {string} mode */
  function getFactory(mode) {
    return REGISTRY[mode] || null;
  }

  return {
    REGISTRY,
    listModes,
    listAvailableModes,
    isKnown,
    getFactory,
  };
}
