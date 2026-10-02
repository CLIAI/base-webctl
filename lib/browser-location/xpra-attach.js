// Host-side xpra attach/detach helpers.
//
// Adapted from xq (26Q2-docker-xpra-x11-apps), commit 64e5f9d
// Original: scripts/lib/xpra.py (attach/detach helpers — subset)
// License: MIT (confirmed with author 2026-05-27)
//
// Invoked from `<project> docker attach`. The xpra-server container publishes a
// TCP bind on 127.0.0.1:<port> (default 14500 for the slug-anchored single
// instance). The host runs `xpra attach tcp://127.0.0.1:<port>/` to get a window
// onto the chromium process.
//
// If the host doesn't have xpra installed, we print a helpful pointer to
// xpra.org and exit cleanly — a UX nicety, not a hard failure of the docker stack.
//
// CONSTANTS-ISOLATED (sm2t seam — arch-constants-injection-seam-sm2t): only
// attach() reads C (the `[C.PROJECT]` hint prefix), so `createXpraAttach(C)`
// returns the surface; attachArgs/attachCommand + the _which/_shellQuote helpers
// are pure and C-independent. Canonical body = the more-evolved linkedin variant:
// the "xpra not installed" hint interpolates the parameterized `opts.html5Port`
// rather than a hardcoded 14501 — and it DEFAULTS TO `port`, not port+1: the html5
// client rides the SAME bind-tcp socket (fixed family-wide in v0.6/v0.7, missed here).
// A port+1 default sent a human to a URL nothing listens on (`chatgpt`'s re-shim).
//
// Tag: [TOOL::*]  (per-repo project resolved from the injected `C`)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { assertConstants } from '../client-config.constants.template.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

/** @param {string} bin */
function _which(bin) {
  // Simple synchronous PATH probe; we don't want a second async hop here.
  const PATH = process.env.PATH || '';
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/** @param {any} s */
function _shellQuote(s) {
  const str = String(s);
  return /^[A-Za-z0-9_/:=.,+@%-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * xpra's `--desktop-scaling` value, or null. The forms `xpra attach` accepts (v6.5, as
 * measured by `chatgpt`): decimal `1.5`, fraction `3/2`, pixels `1024x768`, per-axis
 * `2x1.5`, and `on|off|auto`. Anything else throws, so a typo fails before the attach.
 * @param {unknown} v @returns {string | null}
 */
function _desktopScaling(v) {
  if (v === undefined || v === null) return null;
  const str = typeof v === 'number' && Number.isFinite(v) && v > 0 ? String(v) : (typeof v === 'string' ? v.trim() : '');
  const NUM = '\\d+(?:\\.\\d+)?';
  if (new RegExp(`^(?:on|off|auto|${NUM}|${NUM}/${NUM}|${NUM}x${NUM})$`, 'i').test(str)) return str;
  throw new Error('xpra attach: desktopScaling must be decimal (1.5), fraction (3/2), pixels (1024x768), '
    + 'per-axis (2x1.5), or on|off|auto');
}

/** @param {any} opts @returns {string[]} */
function attachArgs(opts) {
  const o = opts || {};
  const port = o.port || 14500;
  const args = ['attach', `tcp://127.0.0.1:${port}/`];
  if (o.readonly) args.push('--readonly=yes');
  // ⚠ NAMED `desktopScaling`, NOT `scaling`: lanes already pass their OWN `scaling` field
  // through to this function and append the flag themselves. Taking that name made v0.25's
  // candidate emit the flag TWICE and reject xpra forms the lanes accept — the release gate
  // caught it in `chatgpt`. A new base option must not change what an existing caller gets.
  const scaling = _desktopScaling(o.desktopScaling);
  if (scaling !== null) args.push(`--desktop-scaling=${scaling}`);
  return args;
}

/** @param {any} opts @returns {string} */
function attachCommand(opts) {
  return ['xpra', ...attachArgs(opts)].map(_shellQuote).join(' ');
}

/**
 * Create the xpra-attach surface bound to a tool's per-repo constants.
 * @param {ClientConfigConstants} C
 * @param {{ assert?: boolean }} [opts]
 * @returns {{ attach: (opts:any)=>Promise<number>, attachArgs: typeof attachArgs, attachCommand: typeof attachCommand }}
 */
export function createXpraAttach(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createXpraAttach' });

  /**
   * Try to xpra-attach to the given TCP endpoint. Returns 0 on clean detach,
   * non-zero on failure. If xpra is not installed, prints a helpful message and
   * returns 0 (not a fatal error from the tool's perspective).
   *
   * @param {object} attachOpts
   * @param {number} attachOpts.port        host-side TCP port the xpra-server is published on
   * @param {number} [attachOpts.html5Port] host-side HTML5 client port — shown in the
   *                                   "xpra not installed" fallback hint. Defaults
   *                                   to `port`: html5 rides the same bind-tcp socket.
   * @param {boolean} [attachOpts.readonly]
   * @param {number | string} [attachOpts.desktopScaling]  maps to xpra `--desktop-scaling` (see _desktopScaling)
   * @param {boolean} [attachOpts.detached]  background the attach (best-effort)
   * @returns {Promise<number>}
   */
  function attach(attachOpts) {
    const o = /** @type {any} */ (attachOpts) || {};
    const port = o.port || 14500;
    const html5Port = o.html5Port || port;
    return new Promise((resolve) => {
      const xpra = _which('xpra');
      if (!xpra) {
        process.stderr.write(
          `[${C.PROJECT}] xpra not installed on host.\n` +
          '  Install: https://xpra.org/trac/wiki/Download\n' +
          `  Or use the HTML5 client at http://127.0.0.1:${html5Port}/ (no install needed).\n`
        );
        return resolve(0);
      }
      const args = attachArgs(o);
      // Connection hygiene: keep noise off the parent shell, but inherit stdio so
      // the user sees the window negotiation.
      const child = spawn(xpra, args, {
        stdio: o.detached ? 'ignore' : 'inherit',
        detached: !!o.detached,
      });
      if (o.detached) {
        child.unref();
        return resolve(0);
      }
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code == null ? 1 : code));
    });
  }

  return { attach, attachArgs, attachCommand };
}
