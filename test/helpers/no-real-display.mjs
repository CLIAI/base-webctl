// no-real-display.mjs — RULE ZERO for base's tests: nothing a test starts may draw on a REAL display.
//
// ⛔ Measured 2026-10-13: a test ran the host's `xpra info tcp://…` against an auth-protected server with no
// password file. Agent shells inherit DISPLAY/XAUTHORITY, so xpra's GTK client opened its password dialog on a
// person's live desktop, over and over, during their calls. (AGENTS.md: no test, measurement or agent ever puts a
// window or prompt on a real display.)
//
// Importing this module SCRUBS DISPLAY, WAYLAND_DISPLAY and XAUTHORITY from process.env — so every child a test
// spawns inherits a display-less env — and `xpraSpawnGuard` REFUSES any spawn that would run xpra while one of them
// is set in the env it is given. scripts/run-tests-strict.mjs scrubs them for every test file as well; this
// module covers a file run on its own (`node --test <file>`).

/** The env vars through which a client finds a real display. */
export const DISPLAY_VARS = Object.freeze(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']);

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

for (const k of DISPLAY_VARS) delete process.env[k];

/**
 * A copy of `env` without any display var. @param {NodeJS.ProcessEnv} [env] @returns {NodeJS.ProcessEnv}
 */
export function displayless(env = process.env) {
  const out = { ...env };
  for (const k of DISPLAY_VARS) delete out[k];
  return out;
}

/**
 * The programs that can DRAW (review of v0.34.2, F12: not only xpra) — an xpra client, a browser, an opener.
 */
export const GUI_PROGRAMS = Object.freeze(['xpra', 'chromium', 'chromium-browser', 'google-chrome', 'chrome', 'firefox', 'xdg-open']);
const GUI = GUI_PROGRAMS.map((n) => n.replace(/[-.]/g, '\\$&')).join('|');

/**
 * Throw if `argv` would run a program that can draw — the host's binary, `docker run --entrypoint <it> …`, or a shell
 * string that calls it — while `env` names a display. @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env] the env the child will ACTUALLY get (default: this process's) @returns {void}
 */
export function guiSpawnGuard(argv, env = process.env) {
  const set = DISPLAY_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (!set.length) return;
  const base = new RegExp(`(^|/)(${GUI})$`);
  const inShell = new RegExp(`(^|[\\s;&|(])(${GUI})(\\s|$)`);
  const calls = argv.some((a, i) => base.test(a) || (a === '--entrypoint' && base.test(String(argv[i + 1]))) || inShell.test(a));
  if (calls) {
    throw new Error(`RULE ZERO: refusing to spawn a program that can draw with ${set.join(', ')} set — it could open a window or a `
      + 'password prompt on a real display. Spawn with displayless(env); run GUI clients only in a throwaway container or a private Xvfb.');
  }
}
/** The xpra-only name, kept: the guard covers every GUI program now. */
export const xpraSpawnGuard = guiSpawnGuard;

/**
 * spawnSync, GUARDED on the env the child really gets (review F12): the integration helper guarded an env it had just
 * scrubbed, so the guard could never fail (k3wn). Here it judges `opts.env`, else this process's env — a display that
 * reappears anywhere on the way is caught before the spawn.
 * @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnSyncOptions} [opts]
 */
export function guardedSpawnSync(cmd, args, opts = {}) {
  const env = opts.env || process.env;
  // ⛔ ANY spawn whose env names a display is refused (review 2, low): a program DENYLIST was measured to be sidestepped
  // — `sh -c '/usr/bin/xpra …'`, `$(command -v xpra)` — so what is judged is the env, not the program's name
  const set = DISPLAY_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (set.length) {
    throw new Error(`RULE ZERO: refusing to spawn ${cmd} with ${set.join(', ')} in its env — whatever it runs could draw on a real `
      + 'display. Spawn with displayless(env).');
  }
  if (/(^|\/)docker$/.test(cmd)) {
    const why = displayIntoContainer(args);
    if (why) throw new Error(`RULE ZERO: refusing docker ${args[0] || ''}: ${why} — a container handed a display draws on it`);
  }
  return spawnSync(cmd, args, { ...opts, env });
}

/** docker run's short flags that take NO value — in a cluster (`-ite`), the first other letter takes the rest, or the next arg. */
const DOCKER_SHORT_BOOLS = new Set(['d', 'i', 't', 'P', 'q']);
const DISPLAY_SRC = /\/tmp\/\.X11-unix|\.Xauthority|wayland-\d|\/run\/user\/\d+/;

/**
 * Whether a HOST path reaches the display: the X11/Wayland socket, a user runtime dir or an Xauthority, or a PARENT of
 * one (`/tmp`, `/`, `/run`, the home dir — review 3 item 3). Only an absolute path is a host path; a name is a volume.
 * @param {string} src @returns {boolean}
 */
function hostSrcReachesDisplay(src) {
  if (!src.startsWith('/')) return false;
  const p = path.posix.normalize(src).replace(/(.)\/+$/, '$1');
  if (DISPLAY_SRC.test(p)) return true;
  const inside = (/** @type {string} */ dir) => p === '/' || dir === p || dir.startsWith(`${p}/`);
  return ['/tmp/.X11-unix', '/run/user', path.posix.join(os.homedir(), '.Xauthority')].some(inside);
}

/**
 * Why a docker argv hands a container a DISPLAY, or '': `-e DISPLAY…` / `--env DISPLAY…` / `--env=DISPLAY…` /
 * `-eDISPLAY…` / a short-flag cluster ending in e (`-ite DISPLAY=:0`), any `--env-file` (what it holds is not in the
 * argv), or a mount whose HOST source reaches the display or is a parent of it — `-v`, a cluster ending in v, `--mount`
 * bind, a `--mount` volume with `volume-opt=device=<path>`, and `docker volume create --opt device=<path>`.
 * ⚠ Argv only: a shell that runs docker (`sh -c 'docker run …'`) is not parsed (CHANGELOG v0.34.2, the guard's limits).
 * @param {string[]} args @returns {string}
 */
export function displayIntoContainer(args) {
  const MOUNT_WHY = 'it mounts the host\'s X11/Wayland socket, its runtime dir, an Xauthority, or a parent of one into the container';
  const isVolumeCreate = args[0] === 'volume' && args[1] === 'create';
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const next = String(args[i + 1] || '');
    if (a === '--env-file' || a.startsWith('--env-file=')) return 'it passes an --env-file, whose contents the guard cannot judge (refused in tests)';
    if (isVolumeCreate) {
      const opt = a === '--opt' || a === '-o' ? next : a.startsWith('--opt=') ? a.slice(6) : /^-o./.test(a) ? a.slice(a[2] === '=' ? 3 : 2) : null;
      if (opt !== null && opt.startsWith('device=') && hostSrcReachesDisplay(opt.slice(7))) return MOUNT_WHY;
      continue;
    }
    /** @type {string|null} */ let envVal = a === '--env' ? next : a.startsWith('--env=') ? a.slice(6) : null;
    /** @type {string|null} */ let mountVal = a === '--volume' || a === '--mount' ? next : /^--(volume|mount)=/.test(a) ? a.replace(/^--(volume|mount)=/, '') : null;
    const isMount = a === '--mount' || a.startsWith('--mount=');
    // a short flag or a CLUSTER of them: the boolean letters, then the first letter that takes a value takes the rest
    if (/^-[A-Za-z]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (DOCKER_SHORT_BOOLS.has(f)) continue;
        // pflag's shorthand-with-equals: `-e=DISPLAY=:0` — ONE '=' after the letter is not part of the value
        const val = j + 1 < a.length ? a.slice(a[j + 1] === '=' ? j + 2 : j + 1) : next;
        if (f === 'e') envVal = val;
        if (f === 'v') mountVal = val;
        break;
      }
    }
    if (envVal !== null && /^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY)(=|$)/.test(envVal)) return `it passes ${envVal.split('=')[0]} into the container`;
    // the HOST SOURCE of a mount is what is judged — a named docker VOLUME at /tmp/.X11-unix inside (the pair's own
    // private Xvfb, integration arm I9) is not the host's display
    if (mountVal !== null) {
      /** @type {string[]} */ const srcs = [];
      if (isMount) {
        const fields = mountVal.split(',');
        for (const fl of fields) {
          const m = fl.match(/^(?:src|source)=(.*)$/) || fl.match(/^volume-opt=device=(.*)$/);
          if (m) srcs.push(m[1]);
        }
      } else {
        srcs.push(mountVal.split(':')[0]);
      }
      if (srcs.some(hostSrcReachesDisplay)) return MOUNT_WHY;
    }
  }
  return '';
}
