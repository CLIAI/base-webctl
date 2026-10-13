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
 * @typedef {{uid?: number, lstat?: (p: string) => {uid: number, mode: number,
 *   isDirectory(): boolean, isSymbolicLink(): boolean, isSocket?(): boolean},
 *   realpath?: (p: string) => string}} SealOpts  injectable for tests
 */

/**
 * Why `p` (already lstat'ed as `st`) lets ANOTHER user swap what lies below it, or '' when it does not
 * (review of v0.34.2, F3): it must be owned by this uid or root, and a directory must not be group- or other-WRITABLE
 * unless it is sticky (in a sticky dir nobody renames or removes an entry they do not own).
 * @param {string} p @param {{uid: number, mode: number, isDirectory(): boolean, isSymbolicLink(): boolean}} st @param {number} uid
 * @returns {string}
 */
function unsafeComponent(p, st, uid) {
  if (st.uid !== uid && st.uid !== 0) return `${p} is owned by uid ${st.uid}, not this user or root`;
  if (st.isSymbolicLink()) return '';
  if (!st.isDirectory()) return `${p} is not a directory`;
  if ((st.mode & 0o022) && !(st.mode & 0o1000)) return `${p} is writable by group or others (mode 0${(st.mode & 0o7777).toString(8)})`;
  return '';
}

/**
 * Walk EVERY component of the absolute dir `abs`, from `/` down (lexically — a symlink component is lstat'ed as a
 * link, and what follows it is reached through it). '' when each is safe, else why not. @param {string} abs
 * @param {(p: string) => any} lstat @param {number} uid @returns {string}
 */
function unsafePath(abs, lstat, uid) {
  const parts = abs.split('/').filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const p = `/${parts.slice(0, i).join('/')}`;
    let st;
    try { st = lstat(p); } catch (e) { return `${p} cannot be read (${/** @type {any} */ (e).code || 'error'})`; }
    const why = unsafeComponent(p, st, uid);
    if (why) return why;
  }
  return '';
}

/**
 * Judge a unix control socket's path (review of v0.34.2, F3). Three rules, all needed:
 *   1. EVERY component of the path AS GIVEN — and of its real path — is owned by this uid or root, and no directory
 *      is group/other-writable unless sticky. ⛔ A seal says nothing about what is ABOVE it: the owner of a 0777
 *      parent can rename the sealed dir away and plant an impostor; a foreign symlink in the path can be re-pointed.
 *   2. A SEAL: the nearest directory above the socket, on its real path, owned by this uid with no group/other bits,
 *      with every component between it and the socket also ours.
 *   3. The socket itself, when present: a socket (not a link), owned by this uid.
 * `real` is the path that was CHECKED — the caller connects to exactly that, never the path it was given.
 * @param {string} socketPath @param {SealOpts} [o]
 * @returns {{sealed: string|null, real: string|null, why: string}}
 */
export function inspectSocketPath(socketPath, o = {}) {
  const uid = o.uid !== undefined ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : -1);
  const lstat = o.lstat || ((/** @type {string} */ p) => fs.lstatSync(p));
  const realpath = o.realpath || ((/** @type {string} */ p) => fs.realpathSync(p));
  const none = (/** @type {string} */ why) => ({ sealed: null, real: null, why });
  const abs = path.resolve(socketPath);
  const dir = path.dirname(abs);
  let why = unsafePath(dir, lstat, uid);
  if (why) return none(why);
  let realDir;
  try { realDir = realpath(dir); } catch { return none(`${dir} cannot be resolved`); }
  why = unsafePath(realDir, lstat, uid);
  if (why) return none(why);
  let cur = realDir;
  /** @type {string|null} */ let sealed = null;
  for (;;) {
    let st;
    try { st = lstat(cur); } catch { return none(`${cur} cannot be read`); }
    if (st.isSymbolicLink() || !st.isDirectory()) return none(`${cur} is not a directory`);
    if (st.uid !== uid) return none(`no sealed ancestor — ${cur} is not owned by this user, so nothing at or above it can seal the socket`);
    if ((st.mode & 0o077) === 0) { sealed = cur; break; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (!sealed) return none('no sealed ancestor — no directory above it is owned by this user with no group/other permissions');
  const real = path.join(realDir, path.basename(abs));
  let sst = null;
  try { sst = lstat(real); } catch { /* absent: the connect fails on its own */ }
  if (sst) {
    if (sst.isSymbolicLink()) return none(`${real} is a symlink, not a socket`);
    if (typeof sst.isSocket === 'function' && !sst.isSocket()) return none(`${real} is not a socket`);
    if (sst.uid !== uid) return none(`${real} is owned by uid ${sst.uid}, not this user`);
  }
  return { sealed, real, why: '' };
}

/**
 * The nearest directory above `socketPath` that SEALS it, when every rule of {@link inspectSocketPath} holds — else
 * null. @param {string} socketPath @param {SealOpts} [o] @returns {string|null}
 */
export function findSealedAncestor(socketPath, o = {}) {
  return inspectSocketPath(socketPath, o).sealed;
}

/**
 * {@link inspectSocketPath}, refusing when any rule fails. ⛔ RETURNS THE REAL PATH THAT WAS CHECKED: connect to it,
 * never to `socketPath` — a path re-resolved later can lead somewhere else (review F3).
 * @param {string} socketPath @param {SealOpts} [o] @returns {string}
 */
export function assertSealedPath(socketPath, o) {
  const r = inspectSocketPath(socketPath, o);
  if (r.real) return r.real;
  throw new Error(
    `refusing unix control socket ${socketPath}: ${r.why}. Every directory on its path must be owned by this user or ` +
    'root and not writable by others (unless sticky), one above it must be this user\'s with no group/other ' +
    'permissions, and no component may be a symlink another user owns — otherwise another user can put an ' +
    'IMPOSTOR there, and a socket other users can reach is no safer than TCP. Seal the directory that holds it ' +
    '(chmod 0700), or ask its producer to.');
}
