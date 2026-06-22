// Browser-location driver: localhost-direct
//
// Wraps the existing on-host Chromium launch path. This is the legacy
// behavior preserved verbatim — no functional change in PR #2.
//
// The driver is intentionally thin: it delegates the actual lifecycle work
// (CDP health check, auto-start spawn) to callbacks supplied by the host
// (the monolith runner). That keeps the seam clean without duplicating the
// 100-line spawn logic, and lets richer drivers (docker, xpra, remote) exist
// without disturbing this one.
//
// Driver contract (see docs/browser-location-modes.design.md):
//   {
//     mode: string,
//     async ensureRunning() → { cdpHttpUrl, cdpWsBase },
//     async healthCheck()   → boolean,
//     async shutdown()      → void,
//     describe()            → string,
//   }
//
// Tag: [TOOL::*]
//
// base-webctl ESM port (sb7q): zero-dep, JSDoc-typed, no top-level await.

export const MODE = 'localhost-direct';

/**
 * @typedef {object} LocalhostDirectConfig
 * @property {number} port            CDP port (e.g. 4327)
 * @property {string} host            CDP host (e.g. '127.0.0.1')
 * @property {() => Promise<boolean>} healthCheck   CDP /json/version reachable?
 * @property {() => Promise<boolean>} ensureRunning idempotent: true if running or auto-started OK
 */

/**
 * Create a localhost-direct driver instance.
 *
 * @param {LocalhostDirectConfig} cfg
 * @returns {object} driver
 */
export function createDriver(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('localhost-direct driver: missing config object');
  }
  const { port, host, healthCheck, ensureRunning } = cfg;
  if (!port) throw new Error('localhost-direct driver: missing port');
  if (!host) throw new Error('localhost-direct driver: missing host');
  if (typeof healthCheck !== 'function') {
    throw new Error('localhost-direct driver: healthCheck callback required');
  }
  if (typeof ensureRunning !== 'function') {
    throw new Error('localhost-direct driver: ensureRunning callback required');
  }

  const cdpHttpUrl = `http://${host}:${port}`;
  const cdpWsBase  = `ws://${host}:${port}`;

  return {
    mode: MODE,

    async ensureRunning() {
      const ok = await ensureRunning();
      // The host's ensureRunning() returns boolean; if false, the caller
      // (main()) handles the error path. We still return the would-be
      // endpoints so callers can log/inspect even when not yet up.
      return { cdpHttpUrl, cdpWsBase, ok };
    },

    async healthCheck() {
      try {
        return await healthCheck();
      } catch {
        return false;
      }
    },

    async shutdown() {
      // No-op: localhost-direct does not own the Chromium process lifecycle
      // here. `<project> stop` (actionStop) is the explicit shutdown
      // path for this mode and remains unchanged.
      return;
    },

    describe() {
      return `localhost-direct (CDP at ${cdpHttpUrl})`;
    },
  };
}
