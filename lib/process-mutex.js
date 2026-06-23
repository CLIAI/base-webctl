// Shared process mutex — createProcessMutex(C, opts).
// Design: safety-process-mutex-factory-p06y (expands safety-process-mutex-v8m2).
//
// One base implementation of the port/process mutex the family fragmented three
// ways (chatgpt mkdir+metadata+signals, telegram minimal mkdir, linkedin
// flock+mkdir+age). Feature-union, gated by config so each adopter keeps its
// behaviour with a thin shim.
//
// ZERO-DEP (sb7q): `mkdir`-atomic is the universal floor. `flock` is OPTIONAL and
// CONSUMER-INJECTED via `opts.flockImpl` — base NEVER imports `fs-ext`/any addon.
// `flock:'auto'` (default) uses flock iff a flockImpl was injected, else mkdir.
//
// CONSTANTS-ISOLATED (sm2t): `C` supplies the lock dir (under
// ~/.cache/CLIAI/<CACHE_DIRNAME>/locks) + the metadata `tool` tag. `fs`/`clock`
// injectable for hermetic tests.
//
// Tag: [WEBCTL]

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertConstants } from './client-config.constants.template.js';

/** @typedef {import('./client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

const SCHEMA_VERSION = 1;

/** Thrown when acquireLock exceeds its deadline. Carries an optional exitCode. */
export class LockTimeoutError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode) {
    super(message);
    this.name = 'LockTimeoutError';
    this.code = 'LOCK_TIMEOUT';
    this.exitCode = exitCode;
  }
}

/** @param {number} pid @returns {boolean} */
function processAlive(pid) {
  if (typeof pid !== 'number' || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (/** @type {any} */ e) { return e && e.code === 'EPERM'; }
}

/** @param {number} ms */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Create the process-mutex surface bound to a tool's constants.
 *
 * @param {ClientConfigConstants} C
 * @param {{
 *   assert?: boolean,
 *   lockBaseDir?: string,
 *   flock?: 'auto'|'on'|'off',
 *   flockImpl?: (fd: number, op: 'exnb'|'un') => void,
 *   signalCleanup?: boolean,
 *   staleByPid?: boolean,
 *   staleAgeSec?: number,
 *   metadata?: boolean,
 *   timeoutMs?: number,
 *   retryMs?: number,
 *   timeoutExitCode?: number,
 *   fs?: typeof nodeFs,
 *   clock?: () => number,
 *   logger?: { warn?: Function, debug?: Function },
 * }} [opts]
 * @returns {object}
 */
export function createProcessMutex(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createProcessMutex' });
  const fs = opts.fs || nodeFs;
  const clock = opts.clock || (() => Date.now());

  const cacheRoot = path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), '.cache', 'CLIAI', C.CACHE_DIRNAME);
  const lockBaseDir = opts.lockBaseDir || path.join(cacheRoot, 'locks');

  const flockImpl = opts.flockImpl || null;
  const flockMode = opts.flock || 'auto';
  if (flockMode === 'on' && !flockImpl) {
    throw new Error("createProcessMutex: flock:'on' requires opts.flockImpl (base never deps fs-ext)");
  }
  const useFlock = flockMode === 'on' ? true : flockMode === 'auto' ? !!flockImpl : false;

  const signalCleanup = opts.signalCleanup !== false;
  const staleByPid = opts.staleByPid !== false;
  const staleAgeSec = typeof opts.staleAgeSec === 'number' ? opts.staleAgeSec : 0;
  const wantMeta = opts.metadata !== false;
  const defTimeout = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30_000;
  const retryMs = typeof opts.retryMs === 'number' ? opts.retryMs : 200;
  const timeoutExitCode = opts.timeoutExitCode;
  const _lg = opts.logger || {};
  const log = { warn: _lg.warn || (() => {}), debug: _lg.debug || (() => {}) };

  /** @param {number|string} port @returns {string} */
  function getLockPath(port) {
    return path.join(lockBaseDir, `port-${port}.lock`);
  }

  /** @param {string} p @returns {number|null} mtime ms or null if absent */
  function mtimeMs(p) {
    try { return fs.statSync(p).mtimeMs; } catch (_) { return null; }
  }

  /** @param {number|string} portOrPath @returns {number} age ms (Infinity if absent) */
  function getLockAgeMs(portOrPath) {
    const p = typeof portOrPath === 'string' && portOrPath.includes(path.sep) ? portOrPath : getLockPath(portOrPath);
    const m = mtimeMs(p);
    return m == null ? Infinity : Math.max(0, clock() - m);
  }

  /** @param {number|string} port @param {any} [info] */
  function buildMeta(port, info) {
    const i = info || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      pid: process.pid,
      tool: C.PROJECT,
      port,
      command: i.command || null,
      subcommand: i.subcommand || null,
      client: i.client || null,
      startedAt: new Date(clock()).toISOString(),
      extra: i.extra || {},
    };
  }

  // ── signal cleanup (mkdir path) ───────────────────────────────────────────
  // Module-scoped so one handler cleans every lock this process holds.
  /** @param {any} handle */
  function registerLockCleanup(handle) {
    if (!handle || handle.mode !== 'mkdir') return;
    _activeDirs.add(handle.lockPath);
    _installSignalHandlers(fs, log);
  }
  function clearLockCleanup() { _activeDirs.clear(); }

  // ── staleness ─────────────────────────────────────────────────────────────
  /** A held mkdir lock is stale if: orphaned (no/!numeric pid), aged past
   * staleAgeSec, or its pid is dead. Symlinked lock path is NEVER reclaimed. */
  /** @param {string} lockDir */
  function isStaleDir(lockDir) {
    let st;
    try { st = fs.lstatSync(lockDir); } catch (_) { return false; }
    if (st.isSymbolicLink() || !st.isDirectory()) return false; // refuse to follow/clobber
    if (staleAgeSec > 0 && (clock() - st.mtimeMs) > staleAgeSec * 1000) return true;
    const pid = readPid(lockDir);
    if (pid == null) return true; // orphaned dir, no valid pid
    if (staleByPid && !processAlive(pid)) return true;
    return false;
  }
  /** @param {string} lockDir */
  function readPid(lockDir) {
    try {
      const raw = fs.readFileSync(path.join(lockDir, 'pid'), 'utf-8').trim();
      return /^\d+$/.test(raw) ? Number(raw) : null;
    } catch (_) { return null; }
  }
  /** @param {number|string} portOrPath */
  function isStale(portOrPath) {
    const p = typeof portOrPath === 'string' && portOrPath.includes(path.sep) ? portOrPath : getLockPath(portOrPath);
    return isStaleDir(p);
  }

  /** @param {string} lockDir */
  function reclaimDir(lockDir) {
    // Re-verify real dir (not symlink) before rm (TOCTOU-narrow; v8m2 §security).
    try {
      const st = fs.lstatSync(lockDir);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch (_) { return true; }
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  }

  /** @param {number|string} portOrPath @returns {object|null} */
  function readLockInfo(portOrPath) {
    const p = typeof portOrPath === 'string' && portOrPath.includes(path.sep) ? portOrPath : getLockPath(portOrPath);
    const metaPath = useFlock ? `${p}.meta.json` : path.join(p, 'meta.json');
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (_) { return null; }
  }

  // ── acquire / release ─────────────────────────────────────────────────────
  /**
   * @param {number|string} port
   * @param {number} [timeoutMs]
   * @param {any} [metadata]
   * @returns {Promise<{mode: string, lockPath: string, port: number|string, fd?: number}>}
   */
  async function acquireLock(port, timeoutMs, metadata) {
    fs.mkdirSync(lockBaseDir, { recursive: true });
    const deadline = clock() + (typeof timeoutMs === 'number' ? timeoutMs : defTimeout);
    return useFlock
      ? acquireFlock(port, deadline, metadata)
      : acquireMkdir(port, deadline, metadata);
  }

  /** @param {number|string} port @param {number} deadline @param {any} [metadata] */
  async function acquireMkdir(port, deadline, metadata) {
    const lockDir = getLockPath(port);
    // Build the lock in a private temp dir WITH its pid+meta already inside, then
    // ATOMICALLY rename it into place. The live lock dir therefore always carries
    // its pid from the instant it exists — no mkdir-then-write window in which a
    // contender could mistake it for an orphan and reclaim it (TOCTOU). renameSync
    // also transparently reclaims an EMPTY orphan dir (rename replaces empty dirs).
    const tmp = `${lockDir}.tmp.${process.pid}.${clock()}.${_tmpCounter++}`;
    fs.mkdirSync(tmp, { recursive: true });
    // No trailing newline: the consumers' pid files are bare `String(pid)`, and
    // some have exact-match tests. base's readPid trims anyway, so this is the
    // byte-compatible, lowest-friction form for adopters.
    fs.writeFileSync(path.join(tmp, 'pid'), String(process.pid), { mode: 0o600 });
    if (wantMeta) fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(buildMeta(port, metadata), null, 2) + '\n', { mode: 0o600 });
    try {
      for (;;) {
        try {
          fs.renameSync(tmp, lockDir); // atomic acquire
          const handle = { mode: 'mkdir', lockPath: lockDir, port };
          if (signalCleanup) registerLockCleanup(handle);
          return handle;
        } catch (/** @type {any} */ e) {
          if (!e || (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST')) throw e;
          // held (non-empty) — reclaim if stale, else wait.
          if (isStaleDir(lockDir)) {
            log.warn(`[${C.PROJECT}][mutex] reclaiming stale lock ${lockDir}`);
            reclaimDir(lockDir);
            continue;
          }
          if (clock() >= deadline) {
            throw new LockTimeoutError(`lock timeout for ${lockDir} (held by pid ${readPid(lockDir)})`, timeoutExitCode);
          }
          await sleep(retryMs);
        }
      }
    } finally {
      // On success tmp was renamed away (force-rm is a no-op); on timeout/throw
      // this cleans the staged temp dir so it never leaks.
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }

  /** @param {number|string} port @param {number} deadline @param {any} [metadata] */
  async function acquireFlock(port, deadline, metadata) {
    const lockFile = getLockPath(port);
    const fd = fs.openSync(lockFile, nodeFs.constants.O_CREAT | nodeFs.constants.O_RDWR, 0o600);
    for (;;) {
      try {
        /** @type {any} */ (flockImpl)(fd, 'exnb'); // throws EWOULDBLOCK/EAGAIN when held
      } catch (/** @type {any} */ e) {
        const code = e && e.code;
        if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') { fs.closeSync(fd); throw e; }
        if (clock() >= deadline) { fs.closeSync(fd); throw new LockTimeoutError(`flock timeout for ${lockFile}`, timeoutExitCode); }
        await sleep(retryMs);
        continue;
      }
      if (wantMeta) fs.writeFileSync(`${lockFile}.meta.json`, JSON.stringify(buildMeta(port, metadata), null, 2) + '\n', { mode: 0o600 });
      return { mode: 'flock', lockPath: lockFile, port, fd };
    }
  }

  /** @param {{mode: string, lockPath: string, fd?: number}} handle */
  function releaseLock(handle) {
    if (!handle) return;
    if (handle.mode === 'flock') {
      try { if (flockImpl) flockImpl(/** @type {number} */ (handle.fd), 'un'); } catch (_) { /* best effort */ }
      try { if (handle.fd != null) fs.closeSync(handle.fd); } catch (_) { /* already closed */ }
      try { fs.rmSync(`${handle.lockPath}.meta.json`, { force: true }); } catch (_) { /* ignore */ }
      return;
    }
    // mkdir
    _activeDirs.delete(handle.lockPath);
    try { fs.rmSync(handle.lockPath, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  return {
    SCHEMA_VERSION,
    getLockPath,
    getLockAgeMs,
    isStale,
    readLockInfo,
    acquireLock,
    releaseLock,
    registerLockCleanup,
    clearLockCleanup,
  };
}

// ── module-scoped signal cleanup state (mkdir locks) ─────────────────────────
/** @type {Set<string>} */
const _activeDirs = new Set();
let _tmpCounter = 0;
let _handlersInstalled = false;
/** @param {typeof nodeFs} fs @param {any} log */
function _installSignalHandlers(fs, log) {
  if (_handlersInstalled) return;
  _handlersInstalled = true;
  const sigs = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const sig of sigs) {
    process.on(sig, () => {
      for (const dir of _activeDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      }
      _activeDirs.clear();
      process.exit(codes[sig]);
    });
  }
}
