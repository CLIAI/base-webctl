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
 * Throw if `argv` would run xpra — the host's binary, `docker run --entrypoint xpra …`, or a shell string that calls
 * it — while `env` names a display. Called by every test helper that spawns. @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env] the env the child will get (default: this process's) @returns {void}
 */
export function xpraSpawnGuard(argv, env = process.env) {
  const set = DISPLAY_VARS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (!set.length) return;
  const calls = argv.some((a, i) => /(^|\/)xpra$/.test(a) || (a === '--entrypoint' && argv[i + 1] === 'xpra') || /(^|[\s;&|(])xpra\s/.test(a));
  if (calls) {
    throw new Error(`RULE ZERO: refusing to spawn xpra with ${set.join(', ')} set — it could open a window or a password prompt on a `
      + 'real display. Spawn with displayless(env); run xpra clients only in a throwaway container or a private Xvfb.');
  }
}
