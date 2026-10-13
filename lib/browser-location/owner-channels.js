// lib/browser-location/owner-channels.js — the owner-only channel directory, the xpra
// secret, and the bind strings of `channels: 'owner-only'` (gvlx §5.2, §6.1, §8).
//
// C-independent and zero-dep. The driver composes these; they are separate so each
// property has an arm of its own (test/owner-channels.test.js).
//
//   <stateRoot>/run/<key>/            0700   channel dir: xpra.sock, cdp.sock
//   <stateRoot>/auth/<key>/           0700   secret dir (auth is always on)
//   <stateRoot>/auth/<key>/xpra.pass  0600   SECRET_BYTES random bytes, base64url
//
//   <key> = first 12 hex of sha256(path.resolve(profilePath)) — keyed on the TARGET
//   (ow9k §3), the same resolution the bring-up mutex keys on, and computable before
//   the profile dir exists, so a read-only inspect() names what a bring-up creates.
//
// ⛔ REFUSE, NEVER TIGHTEN. A channel or secret dir that exists with group/other bits,
// another owner, or as a symlink is REFUSED. chmod-ing it would hide whoever loosened
// it — and the loosening is the thing worth knowing about.
//
// ⛔ THE SECRET DIR IS MOUNTED, NEVER THE FILE. Rotation is write-temp + rename, which
// makes a NEW inode; a single-file bind mount keeps the OLD one, so the container keeps
// admitting the old password while the host reports a successful rotation (measured,
// gvlx §8.2). Mount the directory and xpra re-reads the file per connection.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SUN_PATH_MAX } from '../control-endpoint.js';

/** Where the channel dir is mounted inside the pair's containers. */
export const CONTAINER_CHANNEL_DIR = '/run/webctl';
/** Where the secret DIRECTORY is mounted (read-only, xpra container only). */
export const CONTAINER_SECRET_DIR = '/run/webctl-secret';
/** Chromium's own debug port, on the pair's network-namespace loopback only. */
export const CHROMIUM_INTERNAL_CDP_PORT = 9222;
/** Random bytes in the xpra secret. */
export const SECRET_BYTES = 32;
const SECRET_NAME = 'xpra.pass';

/**
 * @param {{stateRoot: string, profilePath: string}} o
 */
export function channelPaths(o) {
  const key = crypto.createHash('sha256').update(path.resolve(o.profilePath)).digest('hex').slice(0, 12);
  const channelDir = path.join(o.stateRoot, 'run', key);
  const secretDir = path.join(o.stateRoot, 'auth', key);
  const cdpSock = path.join(channelDir, 'cdp.sock');
  const xpraSock = path.join(channelDir, 'xpra.sock');
  return {
    key, channelDir, secretDir, cdpSock, xpraSock,
    secretFile: path.join(secretDir, SECRET_NAME),
    /** Throw unless both socket paths fit in sun_path (A7). */
    assertFits() {
      for (const p of [cdpSock, xpraSock]) {
        const n = Buffer.byteLength(p);
        if (n > SUN_PATH_MAX) {
          throw Object.assign(new Error(
            `owner-only channels: the socket path ${p} is ${n} bytes; the kernel accepts at most ` +
            `${SUN_PATH_MAX} (sun_path is 108 bytes with its NUL). The state root ${o.stateRoot} is ` +
            'too deep — set XDG_STATE_HOME to a shorter directory.'), { exitCode: 4 });
        }
      }
    },
  };
}

/**
 * Create `dir` 0700 if absent (parents too, 0700); refuse it if it exists loosened,
 * foreign-owned, or as a symlink. Never chmods.
 * @param {string} dir
 * @param {{uid?: number, lstat?: (p: string) => {uid: number, mode: number, isDirectory(): boolean, isSymbolicLink(): boolean},
 *   mkdir?: (p: string) => void}} [o]  injectable for tests
 * @returns {string} dir
 */
export function ensurePrivateDir(dir, o = {}) {
  const uid = o.uid !== undefined ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : -1);
  const lstat = o.lstat || ((/** @type {string} */ p) => fs.lstatSync(p));
  const mkdir = o.mkdir || ((/** @type {string} */ p) => { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); });
  mkdir(dir);
  const st = lstat(dir);
  /** @param {string} why */
  const refuse = (why) => {
    throw Object.assign(new Error(
      `owner-only channels: refusing ${dir} — ${why}. It holds a browser's control sockets or ` +
      'its xpra secret, so it must be a directory owned by this user with no group/other ' +
      'permissions. It is NOT changed here: whatever loosened it is worth finding first.'), { exitCode: 4 });
  };
  if (st.isSymbolicLink()) refuse('it is a symlink');
  if (!st.isDirectory()) refuse('it is not a directory');
  if (st.uid !== uid) refuse(`it is owned by uid ${st.uid}, not ${uid}`);
  if ((st.mode & 0o077) !== 0) refuse(`its mode is 0${(st.mode & 0o777).toString(8)} (group/other bits set)`);
  return dir;
}

/** @param {string} file */
function checkSecretFile(file) {
  const st = fs.lstatSync(file);
  /** @param {string} why */
  const refuse = (why) => {
    throw Object.assign(new Error(`owner-only channels: refusing the xpra secret ${file} — ${why}.`), { exitCode: 4 });
  };
  if (st.isSymbolicLink()) refuse('it is a symlink (never followed)');
  if (!st.isFile()) refuse('it is not a regular file');
  const me = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (st.uid !== me) refuse(`it is owned by uid ${st.uid}`);
  if ((st.mode & 0o077) !== 0) refuse(`its mode is 0${(st.mode & 0o777).toString(8)} (group/other bits set)`);
  const n = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url').length;
  if (n < SECRET_BYTES) refuse(`it holds ${n} bytes of secret, fewer than ${SECRET_BYTES}`);
}

/** Write a fresh secret to `file`, which must not exist. @param {string} file */
function writeNewSecret(file) {
  const value = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  // ⛔ O_EXCL + O_NOFOLLOW, mode 0600 AT CREATION: never written-then-chmodded (a window),
  // never through a link someone planted.
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600); // the umask cannot widen a create mode, but say it once, exactly
    fs.writeSync(fd, value);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/**
 * The per-target xpra secret: created if absent, verified if present.
 * @param {string} secretDir
 * @returns {string} the secret FILE's path (never its content)
 */
export function ensureSecret(secretDir) {
  ensurePrivateDir(secretDir);
  const file = path.join(secretDir, SECRET_NAME);
  let exists = true;
  try { fs.lstatSync(file); } catch (/** @type {any} */ e) {
    if (e && e.code === 'ENOENT') exists = false; else throw e;
  }
  if (exists) checkSecretFile(file); else writeNewSecret(file);
  return file;
}

/**
 * Rotate the secret: a temp file in the same dir (0600, O_EXCL), fsync, rename over.
 * New connections need the new password at once; xpra re-reads the file per
 * connection — provided the DIRECTORY is what is mounted.
 * @param {string} secretDir
 * @returns {string} the secret file's path
 */
export function rotateSecret(secretDir) {
  ensurePrivateDir(secretDir);
  const file = path.join(secretDir, SECRET_NAME);
  const tmp = path.join(secretDir, `.${SECRET_NAME}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  writeNewSecret(tmp);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  return file;
}

/**
 * The xpra container env for owner-only channels — passed straight through by the
 * stock entrypoint to `--bind=` / `--bind-tcp=` (measured, gvlx §5.2).
 *
 * ⚠ TCP is never omitted: the entrypoint's `${XPRA_TCP_BIND:=0.0.0.0:14500}` substitutes
 * on unset OR empty, so omitting it re-arms a no-auth wildcard listener. With html5 off
 * it is bound to the netns loopback (unreachable from the bridge); with html5 on, to the
 * wildcard so docker can publish it — and auth is on either way, in the COMMA form
 * (`auth=file:filename=` inside a bind string refuses every password).
 * @param {{xpraTcpPort: number, html5: boolean}} o
 */
export function xpraChannelEnv(o) {
  return {
    XPRA_BIND: `${CONTAINER_CHANNEL_DIR}/xpra.sock,auth=peercred`,
    XPRA_TCP_BIND: `${o.html5 ? '0.0.0.0' : '127.0.0.1'}:${o.xpraTcpPort},auth=file,filename=${CONTAINER_SECRET_DIR}/${SECRET_NAME}`,
  };
}

/** The socat sidecar's command: unix socket in the channel dir → Chromium's netns-loopback port. */
export function relayCmd() {
  return [
    `UNIX-LISTEN:${CONTAINER_CHANNEL_DIR}/cdp.sock,fork,mode=0600,unlink-early`,
    `TCP:127.0.0.1:${CHROMIUM_INTERNAL_CDP_PORT},retry=30,interval=1`,
  ];
}

/**
 * Read an `XPRA_TCP_BIND` value: `<host>:<port>[,auth=…][,…]`. `null` when absent.
 * @param {string|undefined|null} v
 * @returns {{host: string, port: number, auth: string|null}|null}
 */
export function parseXpraTcpBind(v) {
  if (typeof v !== 'string' || !v) return null;
  const [addr, ...opts] = v.split(',');
  const i = addr.lastIndexOf(':');
  const auth = opts.find((x) => x.startsWith('auth='));
  return { host: addr.slice(0, i), port: Number(addr.slice(i + 1)), auth: auth ? auth.slice('auth='.length) : null };
}
