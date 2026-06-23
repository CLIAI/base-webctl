// Browser-location driver: chromium-docker-xpra-ubuntu-latest
//
// Two-container bring-up: a sibling xpra-server + a chromium container.
// CDP is exposed on host 127.0.0.1:<port> via a socat relay inside the
// chromium container (Chromium 111+ binds CDP to loopback even when
// --remote-debugging-address=0.0.0.0 is passed; see
// docs/browser-location-modes.design.md §"CDP exposure").
//
// Multi-tenant safety: every docker target is referenced by exact name
// with the `C.ARTIFACT_PREFIX` prefix. No blanket commands, no broad
// `pkill chromium`. Stop is `docker stop <exact-name> -t 5`.
//
// CONSTANTS-ISOLATED (sm2t seam — arch-constants-injection-seam-sm2t): every
// project-specific value (log prefixes, docker label namespace, instance/shm
// env-var names) derives from the INJECTED constants `C`, so
// `createChromiumDockerXpra(C, opts)` returns a surface byte-equivalent across
// the webctl sibling repos.
//
// FILE-STAGING-AGNOSTIC (mirrors createMounts, Option A): the WAY-1 attach-upload
// staging feature is wired through an OPTIONAL `opts.fileStaging` seam (a consumer
// module exposing { resolveUploadDirs, ensureUploadHostDir, UPLOAD_STAGE_ENV }).
// When absent (linkedin has no file-staging.js) the driver is byte-unchanged: no
// upload mount, no upload env var, no upload dirs in inspect(). base requires NO
// per-repo file-staging module. See:
// FUTURE_WORK/migrate/260623-mounts-reconcile-file-staging-finding.md
//
// Sibling base surfaces (docker-ctl + the mounts/profile-lock/chromium-prefs
// factories) default from `C` and are overridable via `opts` for tests — the same
// deps-injection contract as profile-lock's `dockerInspect`. `opts.dockerfilesDir`
// is forwarded to the built mounts (consumer-owned dockerfiles — see
// FUTURE_WORK/migrate/260623-dockerfiles-dir-injection-seam.md). `opts.version`
// supplies the tool version recorded in the profile lock (was a repo-relative
// require('../../package.json') — invalid once vendored).
//
// Tag: [WEBCTL] [WEBCTL::CDP] — per-repo project resolved from the injected `C`

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { assertConstants } from '../client-config.constants.template.js';
import * as dockerCtl from './docker-ctl.js';
import { createMounts } from './mounts.js';
import { createProfileLock } from './profile-lock.js';
import { rewriteVersionResponse } from './cdp-rewrite.js'; // eslint-disable-line no-unused-vars
import { createChromiumPrefs } from '../chromium-prefs.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

// Default mode key kept as the historical ubuntu string for backwards
// compatibility (tests + log messages that hardcoded it). The driver is
// BASE-PARAMETERIZED: callers pass `cfg.base` ('ubuntu'|'debian'|'arch') and
// optionally `cfg.mode` so describe()/inspect() report the live mode. With
// neither, it behaves exactly as before (ubuntu base, ubuntu mode key).
const MODE = 'chromium-docker-xpra-ubuntu-latest';

// Map a chromium base → its full browser-location mode key.
/** @param {string} base */
function modeForBase(base) {
  return `chromium-docker-xpra-${base}-latest`;
}

// Derive a chromium base ('ubuntu'|'debian'|'arch') from a full mode key like
// 'chromium-docker-xpra-debian-latest'. Returns null when the key does not match
// the pattern (caller then falls back to its default).
/** @param {string|null|undefined} mode */
function baseFromMode(mode) {
  if (!mode) return null;
  const m = String(mode).match(/^chromium-docker-xpra-([a-z]+)-latest$/);
  return m ? m[1] : null;
}

class BrowserLocationError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode || 1;
  }
}

/**
 * Create the docker-xpra driver surface bound to a tool's per-repo constants.
 *
 * @param {ClientConfigConstants} C
 * @param {{
 *   assert?: boolean,
 *   docker?: any,
 *   mounts?: any,
 *   profileLock?: any,
 *   chromiumPrefs?: any,
 *   fileStaging?: any,
 *   dockerfilesDir?: string | (() => string),
 *   version?: string | null,
 * }} [opts]
 *   `fileStaging` (optional) enables WAY-1 upload staging; absent → disabled
 *   (linkedin behaviour). `docker`/`mounts`/`profileLock`/`chromiumPrefs` default
 *   from `C` (overridable for tests). `dockerfilesDir` forwards to the built
 *   mounts. `version` is recorded in the profile lock (default null).
 * @returns {object}
 */
export function createChromiumDockerXpra(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createChromiumDockerXpra' });

  const docker = opts.docker || dockerCtl;
  const mounts = opts.mounts || createMounts(C, { assert: false, dockerfilesDir: opts.dockerfilesDir });
  const profileLock = opts.profileLock || createProfileLock(C, { assert: false });
  const chromiumPrefs = opts.chromiumPrefs || createChromiumPrefs(C, { assert: false });
  const fileStaging = opts.fileStaging || null;
  const version = opts.version != null ? opts.version : null;

  // Log prefix + docker-label namespace, derived once from C.PROJECT.
  const LOG = `[${C.PROJECT}]`;
  const LABEL_ROLE = `${C.PROJECT}.role`;
  const LABEL_SLUG = `${C.PROJECT}.slug`;
  // Legacy-prefixed env vars (INSTANCE / SHM_SIZE are ENV_LEGACY_SUFFIXES).
  const ENV_INSTANCE = (C.ENV_PREFIX_LEGACY || C.ENV_PREFIX) + 'INSTANCE';
  const ENV_SHM_SIZE = (C.ENV_PREFIX_LEGACY || C.ENV_PREFIX) + 'SHM_SIZE';
  // Opt-OUT (default ON): set to '0' to skip pinning "On startup → New Tab page".
  const ENV_PIN_STARTUP = (C.ENV_PREFIX_LEGACY || C.ENV_PREFIX) + 'PIN_STARTUP_NEWTAB';

  /** @param {any} cfg */
  function createDriver(cfg) {
    if (!cfg || typeof cfg !== 'object') {
      throw new Error(`chromium-docker-xpra driver: missing config object`);
    }
    // Base selection: explicit cfg.base wins; else derive from cfg.mode; else
    // fall back to ubuntu so pre-existing callers (and the docker-mode tests)
    // keep their old behaviour unchanged.
    const base = mounts.normalizeBase(
      cfg.base || baseFromMode(cfg.mode) || 'ubuntu'
    );
    const mode = cfg.mode || modeForBase(base);
    const port = cfg.port || 4327;
    const host = cfg.host || '127.0.0.1';
    const slug = (cfg.slug || process.env[ENV_INSTANCE] || 'default').replace(/[^a-zA-Z0-9_-]/g, '-');
    // Multi-port allocation per docs/multi-client-port-allocation.design.md.
    // Caller resolves these (CLI > JSONC.ports > JSONC.<role>Port > derived);
    // we fall back to a self-contained derivation here so the driver still
    // works when called from tests / scripts that don't compute them.
    const xpraTcpPort   = cfg.xpraTcpPort   || (port < 55535 ? port + 10000 : port + 100);
    const xpraHtml5Port = cfg.xpraHtml5Port || (xpraTcpPort + 1);
    const force = !!cfg.force;  // skip pre-flight bind check
    const logger = cfg.logger || makeStderrLogger();
    // Optional per-host zoom ratio (Mechanism C from
    // ramblings/2026-05-28--chromium-zoom-control.md). Caller resolves
    // CLI > dotenv > env > JSONC and passes a normalised ratio in (0,5].
    // Null/undefined → leave Chromium's existing baseline untouched.
    const zoomRatio = (typeof cfg.zoomRatio === 'number' && cfg.zoomRatio > 0) ? cfg.zoomRatio : null;
    const zoomHost  = cfg.zoomHost || chromiumPrefs.DEFAULT_HOST;
    const N = mounts.names(slug, base);
    // Resolve the chromium profile directory on the host. When the caller
    // (the runner) supplies `cfg.userDataDir` — sourced from
    // --user-data-dir / dotenv / env / JSONC, in that order — that path
    // is bind-mounted into the chromium container at
    // /home/user/.config/chromium. Falls back to
    // ~/.cache/CLIAI/<CACHE_DIRNAME>/profiles/<slug>/chromium when nothing
    // was explicitly configured.
    const profilePath = mounts.resolveChromiumProfile(slug, cfg.userDataDir || null);

    // WAY 1 upload staging (BUG C): a host --attach path is invisible to the
    // containerised chromium (only X11 + profile are mounted), so attach uploads
    // never complete. We copy-stage into a per-slug host dir bind-mounted at a
    // DEDICATED /cliai-uploads target — never a bind of any source data dir
    // (data-safety). Pre-create 0700 so docker does not root-create the bind src.
    // GATED on the optional fileStaging seam: a consumer without it (linkedin)
    // skips this entirely and is byte-unchanged.
    /** @type {any} */
    let uploadDirs = null;
    if (fileStaging) {
      uploadDirs = fileStaging.resolveUploadDirs({ cacheRoot: mounts.cacheRoot(), slug });
      fileStaging.ensureUploadHostDir(uploadDirs.uploadHostDir);
    }

    const cdpHttpUrl = `http://${host}:${port}`;
    const cdpWsBase  = `ws://${host}:${port}`;

    // Helper: probe a docker container's running state for the
    // profile-lock liveness check. Returns { running, exists }.
    /** @param {string} containerName */
    async function dockerInspectForLock(containerName) {
      const exists  = await docker.containerExists(containerName);
      const running = exists ? await docker.containerRunning(containerName) : false;
      return { running, exists };
    }

    async function ensureRunning() {
      // 0. Profile-lock check FIRST — before any docker work — so the
      //    user sees a clean "this profile is in use by X" error rather
      //    than a confusing container-create error after Chromium's
      //    SingletonLock conflict. See docs/profile-directory-lock.design.md.
      const existing = profileLock.readLock(profilePath);
      if (existing) {
        const liveness = await profileLock.isHolderAlive(existing, {
          dockerInspect: dockerInspectForLock,
        });
        // If WE already own this lock (same container we are bringing
        // up — idempotent up()), proceed. Otherwise require it dead.
        const ownContainer = existing.containerName === N.chromiumContainer;
        if (liveness.alive && !ownContainer) {
          // Produce a remediation hint tailored to the holder:
          //   * docker mode on same host → suggest the exact `docker stop`
          //   * localhost-direct on same host → suggest `kill <pid>`
          //   * remote → generic
          const ourHost = os.hostname();
          let resolveHint;
          if (existing.containerName && existing.hostname === ourHost) {
            resolveHint =
              `    docker stop ${existing.containerName}\n` +
              `  OR run with --client <name> pointing at a different userDataDir.\n` +
              `  See docs/profile-directory-lock.design.md.`;
          } else if (
            existing.mode === 'localhost-direct' &&
            existing.hostname === ourHost &&
            typeof existing.pid === 'number'
          ) {
            resolveHint =
              `    ${C.PROJECT} stop      (or: kill ${existing.pid})\n` +
              `  OR run with --client <name> pointing at a different userDataDir.\n` +
              `  See docs/profile-directory-lock.design.md.`;
          } else {
            resolveHint =
              `  Stop the other holder (host=${existing.hostname || 'unknown'}),\n` +
              `  OR use a different userDataDir for this --client.\n` +
              `  See docs/profile-directory-lock.design.md.`;
          }
          throw new BrowserLocationError(
            `Profile directory is already in use by another ${C.PROJECT} mode:\n` +
            `  profile:  ${profilePath}\n` +
            `  holder:   ${profileLock.describeHolder(existing)}\n` +
            `  liveness: ${liveness.reason} (alive)\n` +
            `\n` +
            `  Inspect:  cat ${profileLock.lockPath(profilePath)}\n` +
            `  Resolve:\n` +
            resolveHint,
            4 // CONFIG_ERROR
          );
        }
      }

      // 1. docker available?
      if (!await docker.dockerAvailable()) {
        throw new BrowserLocationError(
          'docker not found on PATH (or daemon unreachable).\n' +
          '  Install docker or use --browser-location localhost-direct to fall back to on-host Chromium.\n' +
          '  See: https://docs.docker.com/engine/install/',
          4 // CONFIG_ERROR
        );
      }

      // 2. Build images if absent
      const haveChromium = await docker.imageExists(N.chromiumImage);
      const haveXpra     = await docker.imageExists(N.xpraImage);
      if (!haveXpra) {
        logger.info(`${LOG}[docker-build] building ${N.xpraImage} (first run, may take a few minutes)`);
        await buildImage({
          tag: N.xpraImage,
          contextSub: 'xpra',
          base, // ignored for xpra (always ubuntu Dockerfile)
          logger,
        });
      }
      if (!haveChromium) {
        logger.info(`${LOG}[docker-build] building ${N.chromiumImage} (base=${base}, first run, may take a few minutes)`);
        await buildImage({
          tag: N.chromiumImage,
          contextSub: 'chromium',
          base,
          logger,
        });
      }

      // 3. Inspect current state — reuse if everything is healthy, otherwise
      //    fully tear down and bring up clean.
      const xpraRunning     = await docker.containerRunning(N.xpraContainer);
      const chromiumRunning = await docker.containerRunning(N.chromiumContainer);

      if (xpraRunning && chromiumRunning) {
        const reachable = await pollCdp(host, port, 6, 500);
        if (reachable) {
          logger.debug(`${LOG}[docker] reusing running pair (slug=${slug})`);
          return { cdpHttpUrl, cdpWsBase, ok: true };
        }
        logger.warn(`${LOG}[docker] containers present but CDP unreachable — recreating`);
      } else if (xpraRunning !== chromiumRunning) {
        logger.warn(`${LOG}[docker] partial state (xpra=${xpraRunning} chromium=${chromiumRunning}) — recreating`);
      }

      // Clean teardown of any leftover containers (idempotent)
      await docker.rm(N.chromiumContainer, { force: true });
      await docker.rm(N.xpraContainer,     { force: true });

      // 4. Ensure shared X11 socket volume.
      //    Volume is recreated each up() because the X11 socket file persists
      //    in the volume after xpra restarts. A stale X99 socket file would
      //    fool the readiness check (it tests file existence, not server
      //    responsiveness), causing chromium to start before fresh xvfb is
      //    actually listening → "Missing X server" failure.
      //    Investigation notes:
      //      https://gist.github.com/gwpl/797a7e7e6d2ae9565ad39b943643ad27 (Bug 5)
      await docker.volumeRm(N.xpraSocketVolume, { force: true }).catch(() => {});
      await docker.volumeCreate(N.xpraSocketVolume);

      // 5. Start xpra FIRST with publish 14327 so host CDP traffic can reach
      //    socat inside the chromium container (chromium shares xpra's
      //    netns via --network=container:<xpra>; docker assigns publish to
      //    the netns owner, which has to be xpra). This is the only
      //    topology that works; the previous "try publish on chromium →
      //    retry on xpra" two-step is removed because docker always
      //    rejects --publish + --network=container.
      // Pre-flight: check each host port is free BEFORE docker run, so
      // the operator sees a clean "port X is in use" instead of a
      // cryptic "docker: ... failed to bind host port". Skipped on
      // --force, and skipped if we are reusing OUR OWN containers
      // (idempotent up — handled by the early-return at step 3 above).
      if (!force) {
        const portsToCheck = [
          { role: 'cdp',         value: port },
          { role: 'xpra-tcp',    value: xpraTcpPort },
          { role: 'xpra-html5',  value: xpraHtml5Port },
        ];
        /** @type {Array<{role:string,value:number}>} */
        const conflicts = [];
        for (const p of portsToCheck) {
          if (!(await checkPortAvailable(host, p.value))) conflicts.push(p);
        }
        if (conflicts.length) {
          const table = portsToCheck.map(p => {
            const bad = conflicts.find(c => c.role === p.role);
            return `  ${p.role.padEnd(11)} ${String(p.value).padEnd(6)} ${bad ? 'IN USE' : 'free'}`;
          }).join('\n');
          const conflictList = conflicts.map(c => `-i :${c.value}`).join(' ');
          throw new BrowserLocationError(
            `docker up: port conflict — cannot bring up containers for slug=${slug}.\n` +
            `\n` +
            `Ports ${C.PROJECT} wants to publish on ${host}:\n` +
            table + `\n` +
            `\n` +
            `  Inspect:  lsof -nP ${conflictList}\n` +
            `  Configure a different "port" (CDP) in JSONC for this --client,\n` +
            `  or override "xpraTcpPort" / "xpraHtml5Port" explicitly.\n` +
            `  Bypass:   pass --force (not recommended; docker run will fail).`,
            4 // CONFIG_ERROR
          );
        }
      }

      logger.info(`${LOG}[docker] starting ${N.xpraContainer}`);
      // Publish ports on the xpra container (it owns the netns since
      // chromium uses --network=container:<xpra>):
      //   <port>          →  CDP (socat relay inside the chromium container)
      //   <xpraTcpPort>   →  xpra protocol — `<tool> docker attach`
      //   <xpraHtml5Port> →  xpra-html5     — `xdg-open http://host:<port>/`
      // All bound on 127.0.0.1 — never on LAN. Internally the entrypoint
      // honors XPRA_TCP_BIND / XPRA_HTML5_BIND envs we set below; the
      // INTERNAL port == EXTERNAL port for these (no socat in between).
      const xpraRun = await docker.runDetached({
        name: N.xpraContainer,
        image: N.xpraImage,
        mounts: mounts.xpraMounts({ xpraSocketVolume: N.xpraSocketVolume }),
        env: {
          XPRA_TCP_BIND:   `0.0.0.0:${xpraTcpPort}`,
          XPRA_HTML5_BIND: `0.0.0.0:${xpraHtml5Port}`,
        },
        publish: [
          [host, String(port),          port],
          [host, String(xpraTcpPort),   xpraTcpPort],
          [host, String(xpraHtml5Port), xpraHtml5Port],
        ],
        labels: { [LABEL_ROLE]: 'xpra', [LABEL_SLUG]: slug },
      });
      if (xpraRun.code !== 0) {
        throw new BrowserLocationError(
          `docker run ${N.xpraContainer} failed (exit ${xpraRun.code}): ${xpraRun.stderr.trim()}`,
          4
        );
      }

      // 6. Wait until X server actually accepts connections, not just for
      //    the X99 socket file to exist. We probe with `xdpyinfo -display :99`
      //    inside the xpra container — succeeds only when xvfb is fully up
      //    AND speaking the X protocol. Replaces the file-existence check
      //    that was vulnerable to stale-socket races on volume reuse.
      //    Investigation notes (defensive readiness probe; partially
      //    applicable to xq's bind-mount topology too):
      //      https://gist.github.com/gwpl/797a7e7e6d2ae9565ad39b943643ad27 (Bug 2 + 5)
      const xReady = await pollUntil(async () => {
        const r = await docker.exec(N.xpraContainer, [
          'sh', '-c',
          'DISPLAY=:99 xdpyinfo -display :99 >/dev/null 2>&1 && echo ok',
        ]);
        return r.code === 0 && /ok/.test(r.stdout);
      }, 30, 500);
      if (!xReady) {
        // Fallback if xdpyinfo isn't installed: file-existence check
        // (less reliable but better than nothing). Both xq and our
        // image-build install x11-utils → xdpyinfo, so this should
        // rarely trigger.
        const fallback = await pollUntil(async () => {
          const r = await docker.exec(N.xpraContainer, ['sh', '-c', 'ls /tmp/.X11-unix/X99 2>/dev/null']);
          return r.code === 0 && /X99/.test(r.stdout);
        }, 6, 500);
        if (!fallback) {
          throw new BrowserLocationError(
            `xpra container did not bring up X server within 15s.\n` +
            `  Check: docker logs ${N.xpraContainer}`,
            4
          );
        }
      }

      // 6b. Apply configured per-host zoom by scrubbing the host-side
      //     `Default/Preferences` of the bind-mounted profile BEFORE the
      //     chromium container starts. Mechanism C from
      //     ramblings/2026-05-28--chromium-zoom-control.md.
      //
      //     Safe here: ensureRunning() above already refused if a live
      //     non-self holder exists, AND the chromium container has not
      //     started yet, so nothing has the file open.
      if (zoomRatio !== null) {
        try {
          const r = chromiumPrefs.applyHostZoomToPreferences(
            chromiumPrefs.preferencesPath(profilePath),
            zoomHost,
            zoomRatio
          );
          const pct = Math.round(zoomRatio * 100);
          logger.info(`${LOG}[docker][zoom] ${r.action} ${zoomHost} → ${pct}% at ${profilePath}/Default/Preferences`);
        } catch (/** @type {any} */ e) {
          logger.warn(`${LOG}[docker][zoom] could not apply zoom pref: ${e.message} (continuing)`);
        }
      }

      // 6b. Pin "On startup → New Tab page" (session.restore_on_startup=5 +
      //     empty startup_urls) so idle-to-blank reclaim is never silently undone
      //     by the browser reopening the app page on a session restore. docker-xpra
      //     ONLY (this driver); DEFAULT ON, opt out with <prefix>PIN_STARTUP_NEWTAB=0.
      //     Same safe-to-write window as the zoom pref above (file not yet open).
      //     See docs/lru-idle-to-blank-tab.design.md "Troubleshooting".
      if (process.env[ENV_PIN_STARTUP] !== '0') {
        try {
          const r = chromiumPrefs.applyStartupPolicyToPreferences(
            chromiumPrefs.preferencesPath(profilePath)
          );
          logger.info(`${LOG}[docker][startup] ${r.action} restore_on_startup=5 at ${profilePath}/Default/Preferences`);
        } catch (/** @type {any} */ e) {
          logger.warn(`${LOG}[docker][startup] could not pin startup policy: ${e.message} (continuing)`);
        }
      }

      // 7. Start chromium, sharing xpra's netns so DISPLAY=:99 finds the
      //    Xvfb socket on the shared /tmp/.X11-unix volume. No -p publish
      //    on chromium itself — docker rejects --publish + --network=container.
      logger.info(`${LOG}[docker] starting ${N.chromiumContainer}`);
      const chromiumRun = await docker.runDetached({
        name: N.chromiumContainer,
        image: N.chromiumImage,
        mounts: mounts.chromiumMounts({
          profileHostPath: profilePath,
          xpraSocketVolume: N.xpraSocketVolume,
          // Upload mount added only when the fileStaging seam is wired (gate).
          ...(uploadDirs ? { uploadHostPath: uploadDirs.uploadHostDir } : {}),
        }),
        env: {
          DISPLAY: ':99',
          LWC_CDP_PORT: String(port),
          LWC_CHROMIUM_PROFILE: '/home/user/.config/chromium',
          // Cross-runtime contract: the in-container runtime (JS or xq's Python)
          // reads the staged-upload dir from this one var. Set only when staging
          // is wired (gate) so non-upload consumers are byte-unchanged.
          ...(uploadDirs ? { [fileStaging.UPLOAD_STAGE_ENV]: uploadDirs.uploadContainerDir } : {}),
        },
        // /dev/shm size:
        //
        // Chromium uses /dev/shm extensively (renderer↔gpu IPC, V8 isolate
        // backing). Default docker /dev/shm is 64 MB → tab crashes under
        // load. xq recommends 512m as a baseline. We observed 5 hard
        // crashes (SIGBUS, ExitCode 135) in a single 16-hour session at
        // 512m driving content-heavy sites (high-comment-count pages,
        // multiple tabs open). Crash signatures included repeated "Network
        // service crashed or was terminated" + "pread64: Input/output
        // error (5)" from crashpad — classic /dev/shm exhaustion for
        // media-heavy pages with many embedded media + nested threads.
        //
        // Bumped to 1g (2026-05-29). Cheap on RAM-rich hosts, and only
        // an upper bound (Chromium uses what it needs). If a deployment
        // needs to constrain it further, override via the
        // `<PREFIX>SHM_SIZE` env var (e.g. "256m"). The string is
        // passed through to docker run --shm-size= unchanged so any
        // docker-accepted suffix works ("k"/"m"/"g"/"t").
        //
        // If 1g still isn't enough (e.g. extremely media-heavy single
        // page exceeding the ceiling on its own), the chromium entrypoint
        // recognises `LWC_DISABLE_DEV_SHM=1` and adds
        // `--disable-dev-shm-usage` to the chromium flag set, routing
        // IPC files through /tmp instead. That's bulletproof but slower
        // (filesystem-backed IPC), so it's OPT-IN per deployment, not on
        // by default:
        //   docker run -e LWC_DISABLE_DEV_SHM=1 ...
        shmSize: process.env[ENV_SHM_SIZE] || '1g',
        extra: ['--network', `container:${N.xpraContainer}`],
        labels: { [LABEL_ROLE]: 'chromium', [LABEL_SLUG]: slug },
      });
      if (chromiumRun.code !== 0) {
        throw new BrowserLocationError(
          `docker run ${N.chromiumContainer} failed: ${chromiumRun.stderr.trim()}`, 4
        );
      }

      // 8. Poll CDP until reachable (30 retries × 500ms = 15s ceiling).
      const cdpOk = await pollCdp(host, port, 30, 500);
      if (!cdpOk) {
        // Capture the tail of chromium logs to help the user diagnose.
        const r = await docker.run(['logs', '--tail', '40', N.chromiumContainer]);
        throw new BrowserLocationError(
          `CDP not reachable at ${cdpHttpUrl} after 15s.\n` +
          `  Last chromium container logs:\n${indent(r.stdout || r.stderr, '    ')}`,
          3 // CDP_UNREACHABLE
        );
      }

      // 9. Bring-up succeeded — acquire the profile-dir lock so other
      //    modes (including a parallel `localhost-direct` runner pointed
      //    at the same userDataDir) see this docker pair as the holder.
      //    Force=true is safe here: ensureRunning() above already refused
      //    if a LIVE holder existed; reaching this point means we are
      //    the rightful owner (or the previous lock was stale).
      try {
        const r = await profileLock.acquire(profilePath, {
          mode,
          pid: process.pid,
          containerName: N.chromiumContainer,
          slug,
          port,
          host,
          client: cfg.client || null,
          version,
          extra: { xpraContainer: N.xpraContainer, volume: N.xpraSocketVolume },
        }, { force: true, dockerInspect: dockerInspectForLock });
        if (r.tookOver && r.previous) {
          logger.warn(
            `${LOG}[docker] took over stale profile lock; ` +
            `previous: ${profileLock.describeHolder(r.previous)}`
          );
        }
      } catch (/** @type {any} */ e) {
        logger.warn(
          `${LOG}[profile-lock] WARN: could not write lock ` +
          `at ${profilePath}: ${e.message} (continuing anyway)`
        );
      }

      logger.debug(`${LOG}[docker] up: CDP at ${cdpHttpUrl} (slug=${slug})`);
      return { cdpHttpUrl, cdpWsBase, ok: true };
    }

    async function healthCheck() {
      try {
        return await pollCdp(host, port, 1, 100);
      } catch {
        return false;
      }
    }

    async function shutdown() {
      // Graceful: SIGTERM with 5s grace, then docker stop falls back to SIGKILL.
      // Order: chromium first (xq spec 05 §3.2 — apps before session), then xpra.
      // Profile dir, volume, and network are kept for faster next-run.
      await docker.stop(N.chromiumContainer, { graceSeconds: 5 });
      await docker.stop(N.xpraContainer,     { graceSeconds: 5 });
      // Release the profile-dir lock so a different mode / client can
      // take this profile next. We use `expect.containerName` for the
      // ownership check rather than --force: if for any reason another
      // process has rewritten the lock between our acquire and shutdown,
      // we leave their lock alone.
      try {
        profileLock.release(profilePath, {
          expect: { containerName: N.chromiumContainer, mode },
        });
      } catch (/** @type {any} */ e) {
        // Non-fatal — log and move on; stale lock will be cleaned up by
        // the next acquire() via its takeover-on-dead-holder path.
        logger.warn(
          `${LOG}[profile-lock] WARN: could not release lock ` +
          `at ${profilePath}: ${e.message}`
        );
      }
    }

    function describe() {
      return `${mode} (base=${base}, slug=${slug}, CDP at ${cdpHttpUrl})`;
    }

    // Diagnostic accessor for the `docker` subcommand handlers below.
    // Also the seam the runner uses to wire WAY-1 attach-staging: it reads the
    // resolved {uploadHostDir, uploadContainerDir} here and hands them to the
    // composer so host --attach paths get copy-staged to the container mount.
    // Upload dirs present only when the fileStaging seam is wired (gate).
    function inspect() {
      /** @type {any} */
      const out = {
        slug, base, mode, names: N, profilePath,
        cdpHttpUrl, cdpWsBase, host, port,
        xpraTcpPort, xpraHtml5Port,
      };
      if (uploadDirs) {
        out.uploadHostDir = uploadDirs.uploadHostDir;
        out.uploadContainerDir = uploadDirs.uploadContainerDir;
      }
      return out;
    }

    return {
      mode,
      base,
      ensureRunning,
      healthCheck,
      shutdown,
      describe,
      inspect,
    };
  }

  /** @param {any} buildOpts */
  async function buildImage(buildOpts) {
    const ctx = path.join(mounts.dockerfilesDir(), buildOpts.contextSub);
    // xpra always builds from its ubuntu Dockerfile; chromium picks per-base.
    const dockerfile = mounts.dockerfilePath(buildOpts.contextSub, buildOpts.base);
    const code = await docker.build({
      tag: buildOpts.tag,
      context: ctx,
      dockerfile,
      buildArgs: { UID: String(process.getuid ? process.getuid() : 1000),
                   GID: String(process.getgid ? process.getgid() : 1000) },
      onLine: (/** @type {string} */ stream, /** @type {string} */ line) => {
        // Mirror to stderr with a discoverable prefix. stream is 'stdout'|'stderr'.
        buildOpts.logger.info(`${LOG}[docker-build] ${line}`);
      },
    });
    if (code !== 0) {
      throw new BrowserLocationError(
        `docker build ${buildOpts.tag} failed (exit ${code}).\n` +
        `  See output above for details.`,
        4
      );
    }
  }

  /**
   * Build a registry-shaped factory object pinned to one chromium base.
   * The returned object exposes `createDriver(cfg)` (the registry contract)
   * which injects `{ base, mode }` so callers that only pass a mode key
   * through the resolver still get the correct base wired in. Explicit
   * cfg.base / cfg.mode from the caller still win.
   *
   * @param {string} base  'ubuntu' | 'debian' | 'arch'
   */
  function factoryForBase(base) {
    const b = mounts.normalizeBase(base);
    const mode = modeForBase(b);
    return {
      MODE: mode,
      base: b,
      createDriver(/** @type {any} */ cfg) {
        return createDriver(Object.assign({ base: b, mode }, cfg || {}));
      },
    };
  }

  return {
    MODE,
    createDriver,
    factoryForBase,
    modeForBase,
    baseFromMode,
    BrowserLocationError,
    // For docker-ctl subcommand handlers:
    _docker: docker,
    _mounts: mounts,
    _profileLock: profileLock,
    _httpGet: httpGet,
    _pollCdp: pollCdp,
  };
}

// -----------------------------------------------------------------------
// helpers (C-independent — module-level)
// -----------------------------------------------------------------------

/**
 * Pre-flight: is the given host:port free to bind right now?
 *
 * Test by trying to listen() ourselves. EADDRINUSE / EACCES → false
 * (some other process owns it OR we lack permission). Other errors
 * are treated as "available" (the docker bind will surface the real
 * error if any). Resolves quickly — no timeout needed since we are
 * binding our own socket, not connecting elsewhere.
 */
/** @param {string} host @param {number} port @returns {Promise<boolean>} */
function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => {
      if (e && (/** @type {any} */ (e).code === 'EADDRINUSE' || /** @type {any} */ (e).code === 'EACCES')) resolve(false);
      else resolve(true);
    });
    s.listen({ host, port, exclusive: true }, () => {
      s.close(() => resolve(true));
    });
  });
}

function makeStderrLogger() {
  return {
    info:  (/** @type {string} */ m) => process.stderr.write(m + '\n'),
    warn:  (/** @type {string} */ m) => process.stderr.write(m + '\n'),
    debug: () => {},
  };
}

/** @param {string} url @param {number} [timeoutMs] @returns {Promise<{status:number, body:string}>} */
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 1500 }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** @param {string} host @param {number} port @param {number} attempts @param {number} intervalMs */
async function pollCdp(host, port, attempts, intervalMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = /** @type {any} */ (await httpGet(`http://${host}:${port}/json/version`, 1500));
      if (r.status === 200 && r.body) return true;
    } catch {}
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return false;
}

/** @param {() => Promise<boolean>} fn @param {number} attempts @param {number} intervalMs */
async function pollUntil(fn, attempts, intervalMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await fn()) return true;
    } catch {}
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return false;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** @param {string} s @param {string} prefix */
function indent(s, prefix) {
  return String(s || '').split('\n').map(l => prefix + l).join('\n');
}
