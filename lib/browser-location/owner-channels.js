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

import { SUN_PATH_MAX, findSealedAncestor, isLoopbackHost } from '../control-endpoint.js';

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

/**
 * @typedef {{level: 'owner-only'|'local-users'|'not-running'|'unknown', reasons: string[],
 *   sealedBy?: {channelDir: string|null, profileDir: string|null}}} Exposure
 */

/**
 * What a RUNNING pair exposes, judged from `docker inspect` output and `stat` only
 * (gvlx §9 Phase 0). Pure but for the sealed-ancestor walk (injectable).
 *
 * ⛔ An in-container listener on a non-loopback address without auth is LOCAL-USERS
 * even with NO publish: the container's bridge address reaches it (gvlx §1). And an
 * inspection that failed is UNKNOWN — never read as safe.
 *
 * @param {{xpra: any, chromium: any, relay?: any}} c  each: a parsed inspect object,
 *   null (absent), or {failed: string}
 * @param {{findSealed?: (p: string) => string|null}} [o]
 * @returns {Exposure}
 */
export function judgeExposure(c, o = {}) {
  const sealed = o.findSealed || ((/** @type {string} */ p) => findSealedAncestor(p));
  const parts = [c.xpra, c.chromium, c.relay];
  const failed = parts.filter((x) => x && x.failed);
  if (failed.length) {
    return { level: 'unknown', reasons: failed.map((f) => `inspection failed: ${f.failed}`),
      sealedBy: { channelDir: null, profileDir: null } };
  }
  /** @param {any} x */
  const running = (x) => !!x && !(x.State && x.State.Running === false);
  if (!running(c.xpra) && !running(c.chromium)) {
    return { level: 'not-running', reasons: [], sealedBy: { channelDir: null, profileDir: null } };
  }
  /** @param {any} x @returns {Record<string, string>} */
  const env = (x) => Object.fromEntries(((x && x.Config && x.Config.Env) || []).map((/** @type {string} */ kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
  /** @param {any} x @param {string} dst @returns {string|null} */
  const bindSrc = (x, dst) => {
    const m = ((x && x.Mounts) || []).find((/** @type {any} */ mm) => mm && mm.Destination === dst
      && (mm.Type === undefined || mm.Type === 'bind'));
    return m && typeof m.Source === 'string' ? m.Source : null;
  };
  /** @type {string[]} */
  const reasons = [];
  for (const x of parts) {
    const pb = (x && x.HostConfig && x.HostConfig.PortBindings) || {};
    for (const list of Object.values(pb)) {
      for (const b of (Array.isArray(list) ? list : [])) {
        const ip = b && typeof b.HostIp === 'string' ? b.HostIp : '';
        if (!isLoopbackHost(ip)) {
          reasons.push(`port ${b && b.HostPort} is published on ${JSON.stringify(ip)} — not a loopback address`
            + (ip === '' ? ' (docker\'s empty HostIp is the wildcard)' : ''));
        }
      }
    }
  }
  if (running(c.xpra)) {
    const b = parseXpraTcpBind(env(c.xpra).XPRA_TCP_BIND);
    if (!b) {
      reasons.push('xpra: XPRA_TCP_BIND is unset, so the image\'s entrypoint default applies — 0.0.0.0:14500 '
        + 'with no auth, reachable through the bridge address (entrypoint default)');
    } else if (!b.auth && !isLoopbackHost(b.host)) {
      reasons.push(`xpra: tcp ${b.host}:${b.port}, no auth — reachable by every local user through the `
        + 'container\'s bridge address, published or not');
    }
  }
  if (running(c.chromium)) {
    const port = env(c.chromium).LWC_CDP_PORT;
    if (port) {
      reasons.push(`cdp: LWC_CDP_PORT=${port} — the image's relay listens on 0.0.0.0 in the pair's network `
        + 'namespace with no auth, reachable through the bridge address');
    }
  }
  const chan = bindSrc(c.xpra, CONTAINER_CHANNEL_DIR) || bindSrc(c.relay, CONTAINER_CHANNEL_DIR);
  /** @type {string|null} */
  let chanSeal = null;
  if (chan) {
    chanSeal = sealed(path.join(chan, 'xpra.sock'));
    if (!chanSeal) reasons.push(`channel dir ${chan} is not sealed — other users may reach its sockets`);
  }
  const prof = bindSrc(c.chromium, '/home/user/.config/chromium');
  /** @type {string|null} */
  let profSeal = null;
  if (prof) {
    profSeal = sealed(path.join(prof, '.probe'));
    if (!profSeal) {
      reasons.push(`profile dir ${prof} is reachable by other users (no sealed ancestor) — chmod 0700 it, `
        + 'or a parent, when its owner decides; base never changes a directory it did not create');
    }
  }
  return { level: reasons.length ? 'local-users' : 'owner-only', reasons,
    sealedBy: { channelDir: chanSeal, profileDir: profSeal } };
}

/**
 * The doctor / `gui status` line for an {@link Exposure}. Loud when exposed.
 * @param {Exposure} e
 * @returns {string}
 */
export function formatExposureLine(e) {
  const tag = (/** @type {string} */ t) => `exposure  ${t.padEnd(12)}`;
  if (e.level === 'owner-only') return `${tag('owner-only')} cdp and xpra reachable by this account only`;
  if (e.level === 'not-running') return `${tag('not-running')} no pair is running for this target`;
  if (e.level === 'unknown') return `${tag('UNKNOWN')} ${e.reasons.join('; ')} — not known to be safe`;
  return `${tag('LOCAL-USERS')} ${e.reasons.join('; ')}\n`
    + '          → any local user can reach this browser. Fix: channels: \'owner-only\', then restart '
    + 'the pair when its owner decides (gvlx §9)';
}
