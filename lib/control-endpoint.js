// lib/control-endpoint.js — the control-endpoint shape, consumed EXACTLY as xq ships it.
//
// Design: docs/design/infra-unix-control-endpoint-6gi0.md §2 (the shape and the
// sealed-ancestor check) and safety-owner-only-browser-channels-gvlx.md §7 (the
// loopback rule behind B4).
//
// ⭐ ONE SHAPE, TWO PRODUCERS. xq's `wait-ready --json` (schema 1, additive, xq main
// 0a4fab6) and base's own docker-xpra driver (`inspect().ports.cdp.endpoint`) emit
// the same object:
//
//     {name, kind, adapter, transport: 'tcp'|'unix', host, port, path, host_header}
//
//   kind        xq's field, NOT redefined here: the protocol family the app speaks
//               INSIDE (`"tcp"` for Chromium's debug port even over a unix transport)
//   transport   how THIS host reaches it
//   path        unix only: the socket on this host
//   host_header unix only: the Host a client must send through the socket. Firefox
//               BiDi answers 400 to any other, so it is REQUIRED and never guessed.
//
// ⛔ WHY A CONSUMER CHECKS THE PATH, NOT THE SOCKET. xq creates its socket 0666: its
// sealed zone dir is the boundary. A socket's own mode therefore says nothing, and a
// socket another user can reach is TCP with extra steps. So before connecting, a
// consumer finds a SEALED ancestor — owned by the caller, no group/other bits — with
// nothing foreign-owned between it and the socket.
//
// Zero-dep, C-independent, no side effects at import.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The longest unix socket path the kernel accepts: `sun_path` is 108 bytes, one of
 * them the terminating NUL. Counted in BYTES — a multi-byte path is longer than its
 * `.length`.
 */
export const SUN_PATH_MAX = 107;

/**
 * @typedef {{
 *   name?: string, kind?: string|null, adapter?: string|null,
 *   transport: 'tcp'|'unix',
 *   host: string|null, port: number|null,
 *   path?: string|null, host_header?: string|null,
 *   [extra: string]: unknown,
 * }} ControlEndpoint
 */

/**
 * Loopback, and only loopback: an IPv4 dotted quad in 127.0.0.0/8, or `::1`
 * (`[::1]` accepted as the same address). ⛔ Never a NAME — `localhost` resolves
 * through whatever the host's resolver says, and docker needs an address anyway —
 * and never a wildcard.
 * @param {unknown} h
 * @returns {boolean}
 */
export function isLoopbackHost(h) {
  if (typeof h !== 'string') return false;
  if (h === '::1' || h === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * Validate a control endpoint and return it UNCHANGED (the same object).
 *
 * Refused: an unknown `transport`; unix with a non-null host or port; unix without
 * a well-formed `host_header`; a relative path or one longer than {@link SUN_PATH_MAX}
 * bytes; tcp with a non-loopback host, a bad port, or a `path`. Unknown EXTRA fields
 * are ignored — schema 1 is additive — but a known field with a wrong value is not.
 *
 * @param {unknown} ep
 * @returns {ControlEndpoint}
 */
export function parseControlEndpoint(ep) {
  if (ep === null || typeof ep !== 'object' || Array.isArray(ep)) {
    throw new TypeError(`control endpoint: expected an object, got ${ep === null ? 'null' : typeof ep}`);
  }
  const e = /** @type {Record<string, unknown>} */ (ep);
  /** @param {string} msg */
  const bad = (msg) => { throw new TypeError(`control endpoint: ${msg}`); };
  for (const k of ['name', 'kind', 'adapter']) {
    if (e[k] !== undefined && e[k] !== null && typeof e[k] !== 'string') bad(`${k} must be a string or null`);
  }
  if (e.transport === 'unix') {
    if (e.host !== undefined && e.host !== null) bad('a unix endpoint has host null — refusing a second way to connect (t2wf)');
    if (e.port !== undefined && e.port !== null) bad('a unix endpoint has port null — refusing a second way to connect (t2wf)');
    if (typeof e.path !== 'string' || !path.isAbsolute(e.path)) bad('a unix endpoint needs an absolute path');
    const len = Buffer.byteLength(/** @type {string} */ (e.path));
    if (len > SUN_PATH_MAX) {
      bad(`socket path is ${len} bytes; the kernel accepts at most ${SUN_PATH_MAX} (sun_path is 108 with its NUL)`);
    }
    if (typeof e.host_header !== 'string' || !/^[^\s/@]+:\d{1,5}$/.test(e.host_header)) {
      bad('a unix endpoint needs host_header ("<host>:<port>" the app expects as Host) — it is never guessed');
    }
    return /** @type {ControlEndpoint} */ (ep);
  }
  if (e.transport === 'tcp') {
    if (!isLoopbackHost(e.host)) bad(`tcp host ${JSON.stringify(e.host)} is not a loopback address`);
    if (typeof e.port !== 'number' || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535) {
      bad(`tcp port ${JSON.stringify(e.port)} is not an integer in 1..65535`);
    }
    if (e.path !== undefined && e.path !== null) bad('a tcp endpoint has no path');
    if (e.host_header !== undefined && e.host_header !== null
        && (typeof e.host_header !== 'string' || !/^[^\s/@]+:\d{1,5}$/.test(e.host_header))) {
      bad('host_header, when given, is "<host>:<port>"');
    }
    return /** @type {ControlEndpoint} */ (ep);
  }
  return bad(`unknown transport ${JSON.stringify(e.transport)} — only "tcp" and "unix" exist, and an unknown one is never read as tcp`);
}

/**
 * The nearest directory above `socketPath` that SEALS it: owned by `uid`, a
 * directory, no group/other permission bits — with every component between it and
 * the socket also owned by `uid` (a foreign owner below the seal could swap the
 * socket). Symlinks are resolved first, so the walk is over the real path.
 *
 * @param {string} socketPath
 * @param {{uid?: number, lstat?: (p: string) => {uid: number, mode: number,
 *   isDirectory(): boolean, isSymbolicLink(): boolean},
 *   realpath?: (p: string) => string}} [o]  injectable for tests
 * @returns {string|null}  the sealing directory, or null when there is none
 */
export function findSealedAncestor(socketPath, o = {}) {
  const uid = o.uid !== undefined ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : -1);
  const lstat = o.lstat || ((/** @type {string} */ p) => fs.lstatSync(p));
  const realpath = o.realpath || ((/** @type {string} */ p) => fs.realpathSync(p));
  let cur;
  try { cur = realpath(path.dirname(path.resolve(socketPath))); } catch { return null; }
  for (;;) {
    let st;
    try { st = lstat(cur); } catch { return null; }
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (st.uid !== uid) return null;               // foreign: cannot seal, cannot sit below one
    if ((st.mode & 0o077) === 0) return cur;        // ours, closed to everyone else
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * Throw unless {@link findSealedAncestor} finds a seal. Run before connecting to a
 * unix control endpoint, whoever produced it.
 * @param {string} socketPath
 * @param {Parameters<typeof findSealedAncestor>[1]} [o]
 * @returns {string} the sealing directory
 */
export function assertSealedPath(socketPath, o) {
  const sealed = findSealedAncestor(socketPath, o);
  if (sealed) return sealed;
  throw new Error(
    `refusing unix control socket ${socketPath}: no sealed ancestor — no directory above it is ` +
    'owned by this user with no group/other permissions (with nothing foreign-owned in between), ' +
    'so other users may be able to reach it. A socket other users can reach is no safer than TCP. ' +
    'Seal the directory that holds it (chmod 0700), or ask its producer to.');
}
