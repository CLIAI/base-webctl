// lib/xpra-presence.js — "is a human watching the docker-xpra browser?"
//
// In docker-xpra mode the browser is headless (Xvfb); a human only sees it via
// an ATTACHED xpra client. So the architecturally-correct presence signal is
// xpra client-attachment, NOT per-tab document.hasFocus() (which is permanently
// true for the active tab under Xvfb — see lru-idle-to-blank design notes).
//
// Used to gate ONLY the terminal idle-to-blank collapse: while a client is
// attached we never blank the browser under the human (count/time LRU still
// trims excess to ~1 tab); when detached, collapse proceeds after the horizon.
//
// Mode-specific + err-toward-collapse: only docker-xpra has an xpra server on
// the derived port, so localhost-direct / no-xpra / a flaky-or-absent socket
// all fail the query → treated as NOT attached → collapse proceeds.
//
// base-webctl ESM port (sb7q): zero-dep, JSDoc-typed, no top-level await.

import { execFileSync } from 'node:child_process';
import { inspectSocketPath } from './control-endpoint.js';

/**
 * Parse the `clients=<N>` scalar from `xpra info` output. PURE.
 * That scalar counts real UI clients and excludes the info query's own
 * control connection (verified: one attached `xpra attach` → clients=1).
 * @param {string} infoText
 * @returns {number} attached UI client count (0 if absent/unparseable)
 */
export function parseXpraClients(infoText) {
  if (!infoText) return 0;
  const m = String(infoText).match(/^clients=(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * The `xpra info` argv for a session: a port (the tcp form, unchanged), or
 * `{socketPath}` (owner-only channels: the peercred unix socket, gvlx §5.3), or
 * `{port, passwordFile}` (TCP behind auth=file — the PATH, never the secret). PURE.
 * @param {number | {socketPath?: string, port?: number, passwordFile?: string}} target
 * @returns {string[]|null}  null when there is nothing to ask
 */
export function xpraInfoArgs(target) {
  if (typeof target === 'number') return target ? ['info', `tcp://127.0.0.1:${target}/`] : null;
  if (!target || typeof target !== 'object') return null;
  if (target.socketPath) return ['info', `socket://${target.socketPath}`];
  if (!target.port) return null;
  return ['info', `tcp://127.0.0.1:${target.port}/`,
    ...(target.passwordFile ? [`--password-file=${target.passwordFile}`] : [])];
}

/**
 * Is at least one xpra client attached to the given session?
 * Best-effort: any failure (xpra CLI missing, port not listening, timeout,
 * non-xpra mode) returns false so the caller errs toward collapse.
 * @param {number | {socketPath?: string, port?: number, passwordFile?: string}} target
 *   the xpra-tcp port, or `{socketPath}` under owner-only channels
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000]
 * @returns {boolean}
 */
export function isXpraClientAttached(target, { timeoutMs = 8000 } = {}) {
  // ⛔ a socket path is CHECKED before xpra connects to it (review F4) — an unsafe one may hold an impostor; the
  // REAL path the check judged is what is asked. Refused → false: the caller errs toward collapse, as for any failure.
  let t = target;
  if (t && typeof t === 'object' && t.socketPath) {
    const r = inspectSocketPath(t.socketPath);
    if (!r.real) return false;
    t = { ...t, socketPath: r.real };
  }
  const args = xpraInfoArgs(t);
  if (!args) return false;
  try {
    // ⛔ NO DISPLAY for the probe: `xpra info` needs none, and with one inherited, an auth-protected server it holds no
    // password for makes xpra's GTK client open a password DIALOG on that desktop — on every LRU tick (measured
    // 2026-10-13, from a test, on a person's live desktop). Without a display it fails, and the caller errs toward collapse.
    const env = { ...process.env };
    for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) delete env[k];
    const out = execFileSync('xpra', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    return parseXpraClients(out) >= 1;
  } catch {
    return false; // err toward collapse
  }
}
