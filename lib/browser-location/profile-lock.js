// Cross-mode profile-directory lock.
//
// A single Chromium profile dir must not be used by two browsers at once. This
// lock is the system-of-record for "who currently has this profile dir open":
// each acquire writes a JSON file inside the profile dir with enough metadata
// for a tool OR a human to answer which mode / PID / container / client / host
// holds it, and since when. It sits IN FRONT of Chromium's SingletonLock.
//
// CONSTANTS-ISOLATED: the lock filename + recorded `tool` name + log prefixes
// derive from the INJECTED constants `C.PROJECT` (the seam —
// arch-constants-injection-seam-sm2t): `createProfileLock(C)` returns the
// surface. The `dockerInspect` liveness probe stays injectable per call (the
// existing test seam the driver injection mirrors).
//
// Tag: [WEBCTL]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertConstants } from '../client-config.constants.template.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

/** Lock schema version (no per-repo dependency). */
export const SCHEMA_VERSION = 1;

/**
 * Create the profile-lock surface bound to a tool's per-repo constants.
 * @param {ClientConfigConstants} C
 * @param {{ assert?: boolean }} [opts]  assert defaults TRUE (escape hatch: false)
 * @returns {object}
 */
export function createProfileLock(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createProfileLock' });

  const LOCK_FILENAME = `.${C.PROJECT}.lock.json`;
  const LOG_PREFIX    = `[${C.PROJECT}][profile-lock]`;

  /**
   * Compute the lock file path for a given profile directory.
   * @param {string} profileDir
   * @returns {string}
   */
  function lockPath(profileDir) {
    return path.join(profileDir, LOCK_FILENAME);
  }

  /**
   * Read the existing lock, or null if absent/unreadable/corrupt (a corrupt
   * lock emits a one-line stderr warning and is treated as absent).
   * @param {string} profileDir
   * @returns {any}
   */
  function readLock(profileDir) {
    const p = lockPath(profileDir);
    let text;
    try {
      text = fs.readFileSync(p, 'utf-8');
    } catch (_) {
      return null;
    }
    try {
      const obj = JSON.parse(text);
      obj._path = p;
      return obj;
    } catch (/** @type {any} */ e) {
      process.stderr.write(
        `${LOG_PREFIX} WARN: corrupt lock at ${p}: ` +
        `${e.message}; treating as absent\n`
      );
      return null;
    }
  }

  /**
   * Decide whether the holder recorded in `lock` is still alive.
   * `dockerInspect` is an injectable async (containerName) → {running, exists}.
   * @param {any} lock
   * @param {{hostname?: string, dockerInspect?: (name: string) => Promise<{running?: boolean, exists?: boolean}>}} [opts]
   * @returns {Promise<{alive: boolean, reason: string}>}
   */
  async function isHolderAlive(lock, opts) {
    const o = opts || {};
    const hostname = (o.hostname || os.hostname()).trim();

    if (lock.hostname && lock.hostname !== hostname) {
      return { alive: true, reason: 'remote' };
    }

    if (lock.containerName) {
      if (!o.dockerInspect) return { alive: true, reason: 'unknown' };
      try {
        const r = await o.dockerInspect(lock.containerName);
        if (r && r.running) return { alive: true,  reason: 'container' };
        if (r && !r.exists) return { alive: false, reason: 'container-missing' };
        return { alive: false, reason: 'container-stopped' };
      } catch (_) {
        return { alive: true, reason: 'unknown' };
      }
    }

    const pid = lock.pid;
    if (typeof pid !== 'number' || pid <= 1) return { alive: false, reason: 'no-pid' };
    try {
      process.kill(pid, 0);
      return { alive: true, reason: 'pid' };
    } catch (/** @type {any} */ e) {
      if (e && e.code === 'EPERM') {
        return { alive: true, reason: 'pid' };
      }
      return { alive: false, reason: 'pid-dead' };
    }
  }

  /**
   * Acquire the lock for `profileDir`. Atomic (write-to-temp + rename).
   * @param {string} profileDir
   * @param {any} info  holder metadata; requires {mode, pid}
   * @param {any} [opts]  {force?, hostname?, dockerInspect?}
   * @returns {Promise<any>}
   */
  async function acquire(profileDir, info, opts) {
    const o = opts || {};
    if (!profileDir) throw new Error('profile-lock acquire: profileDir required');
    if (!info || typeof info !== 'object') throw new Error('profile-lock acquire: info required');
    if (!info.mode) throw new Error('profile-lock acquire: info.mode required');
    if (typeof info.pid !== 'number') throw new Error('profile-lock acquire: info.pid required');

    fs.mkdirSync(profileDir, { recursive: true });

    const previous = readLock(profileDir);
    if (previous && !o.force) {
      const liveness = await isHolderAlive(previous, o);
      if (liveness.alive) {
        return { ok: false, conflict: true, previous, liveness };
      }
      process.stderr.write(
        `${LOG_PREFIX} taking over stale lock at ` +
        `${previous._path}: previous holder ${describeHolder(previous)} ` +
        `(${liveness.reason})\n`
      );
    }

    const now = new Date();
    const lock = {
      schemaVersion: SCHEMA_VERSION,
      tool:     C.PROJECT,
      mode:     info.mode,
      pid:      info.pid,
      containerName: info.containerName || null,
      client:   info.client   || null,
      slug:     info.slug     || null,
      port:     typeof info.port === 'number' ? info.port : null,
      host:     info.host     || null,
      hostname: os.hostname(),
      profileDir,
      acquiredAt: now.toISOString(),
      acquiredAtEpoch: Math.floor(now.getTime() / 1000),
      version:  info.version || null,
      extra:    info.extra   || null,
    };

    const p   = lockPath(profileDir);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', { mode: 0o644 });
    fs.renameSync(tmp, p);

    return {
      ok: true,
      lock: { ...lock, _path: p },
      tookOver: !!previous,
      previous: previous || null,
      forced:   !!o.force,
    };
  }

  /**
   * Release the lock for `profileDir`. Safe to call repeatedly. By default only
   * releases locks we own (matching mode+pid OR containerName); `opts.force`
   * releases any. `opts.expect` supplies the ownership identifier.
   * @param {string} profileDir
   * @param {any} [opts]
   * @returns {any}
   */
  function release(profileDir, opts) {
    const o = opts || {};
    const existing = readLock(profileDir);
    if (!existing) return { ok: true, released: false, reason: 'no-lock' };

    if (!o.force) {
      const expect = o.expect || {};
      const ownByPid =
        expect.pid != null && existing.pid === expect.pid && existing.mode === expect.mode;
      const ownByContainer =
        expect.containerName && existing.containerName === expect.containerName;
      if (!ownByPid && !ownByContainer) {
        return { ok: false, released: false, reason: 'not-owner', existing };
      }
    }

    try {
      fs.unlinkSync(lockPath(profileDir));
      return { ok: true, released: true, previous: existing };
    } catch (/** @type {any} */ e) {
      if (e && e.code === 'ENOENT') {
        return { ok: true, released: false, reason: 'no-lock' };
      }
      throw e;
    }
  }

  /**
   * One-shot inspector for `docker status` output / operator scripts.
   * @param {string} profileDir
   * @param {any} [opts]
   * @returns {Promise<{profileDir: string, lockPath: string, present: boolean, lock: any, liveness: any}>}
   */
  async function inspect(profileDir, opts) {
    const lock = readLock(profileDir);
    if (!lock) {
      return { profileDir, lockPath: lockPath(profileDir), present: false, lock: null, liveness: null };
    }
    const liveness = await isHolderAlive(lock, opts || {});
    return { profileDir, lockPath: lockPath(profileDir), present: true, lock, liveness };
  }

  /**
   * Format a holder for human-readable error / log messages.
   * @param {any} lock
   * @returns {string}
   */
  function describeHolder(lock) {
    if (!lock) return '(none)';
    const parts = [];
    if (lock.mode) parts.push(`mode=${lock.mode}`);
    if (lock.containerName) parts.push(`container=${lock.containerName}`);
    if (lock.pid) parts.push(`pid=${lock.pid}`);
    if (lock.client) parts.push(`client=${lock.client}`);
    if (lock.slug) parts.push(`slug=${lock.slug}`);
    if (lock.hostname) parts.push(`host=${lock.hostname}`);
    if (lock.acquiredAt) parts.push(`since ${lock.acquiredAt}`);
    return parts.join(' ');
  }

  return {
    LOCK_FILENAME,
    SCHEMA_VERSION,
    lockPath,
    readLock,
    isHolderAlive,
    acquire,
    release,
    inspect,
    describeHolder,
  };
}
