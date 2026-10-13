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
  guiSpawnGuard([cmd, ...args], env);
  return spawnSync(cmd, args, { ...opts, env });
}
