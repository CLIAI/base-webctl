// lib/storage-paths.js — createStoragePaths(C, opts): the ONE place a *-webctl
// tool resolves where its files live (v59v; expands f868).
//
// Today every tool re-derives `~/.cache/CLIAI/<dir>` by hand — base does it in
// three separate places (mounts.cacheRoot, the mutex lockBaseDir, the gateway
// statePath), each hardcoding `$HOME` and each subtly free to drift. This is the
// resolver they all become thin callers of.
//
// THREE THINGS THIS MODULE REFUSES TO DO, each for a reason:
//
//  1. IT NEVER DELETES, AND IT NEVER MOVES. The whole reason the storage layout
//     is being unified is that a tool was writing into a namespace shared with
//     other tools, where a log rotation could eat another tool's audit ledger. A
//     migration that "tidies up" is how you lose the thing you were protecting.
//     So the legacy location is READ, never emptied: `resolveExisting()` returns
//     the canonical path if something is there, else the first legacy path that
//     exists, else the canonical path. Nothing is copied, unlinked or renamed —
//     a human moves files when a human decides to.
//
//  2. IT DOES NOT SILENTLY RELOCATE LOCKS. See `locksDir` below; this one is a
//     correctness hazard rather than a preference.
//
//  3. IT DOES NOT INVENT A HOME. `$HOME` unset is a real state (some daemons,
//     some containers) and silently resolving to `/tmp` would put secret-grade
//     material in a world-readable place. It throws instead.
//
// Zero-dep, no top-level await, `env` injectable so tests never read the real
// environment. sm2t-shaped: takes C, returns a surface.

import path from 'node:path';
import fs from 'node:fs';

/** Everything lives under this vendor segment, per f868. */
const NAMESPACE = 'CLIAI';

/**
 * The pre-v59v shared namespace. Tool-scoped paths replaced it because it is
 * SHARED — every *-webctl wrote here, so one tool's log rotation could select
 * another tool's files. Retained ONLY as a read-fallback so nothing written
 * before the migration becomes invisible. Never written to, never cleaned.
 */
const LEGACY_SHARED_SEGMENTS = ['default', 'webctl'];

/**
 * Resolve an XDG root with its spec-mandated fallback.
 * @param {Record<string,string|undefined>} env
 * @param {string} varName
 * @param {string[]} homeRelativeFallback
 * @returns {string}
 */
function xdgRoot(env, varName, homeRelativeFallback) {
  const explicit = env[varName];
  // The XDG spec says a relative value must be IGNORED, not resolved — an
  // attacker-controlled relative path would otherwise land wherever the process
  // happens to be cwd'd.
  if (explicit && path.isAbsolute(explicit)) return explicit;

  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    throw new Error(
      `createStoragePaths: cannot resolve ${varName} — it is unset (or relative) ` +
      'and $HOME is unset too.\n' +
      '\n' +
      'Refusing to guess. This resolver locates profiles, grants and logs, which ' +
      'are secret-grade; defaulting to /tmp would place them somewhere ' +
      'world-readable. Set $HOME, or set ' + varName + ' to an absolute path.',
    );
  }
  return path.join(home, ...homeRelativeFallback);
}

/**
 * @param {import('./client-config.constants.template.js').ClientConfigConstants|any} C
 * @param {{
 *   env?: Record<string,string|undefined>,
 *   fs?: { existsSync(p: string): boolean },
 *   preferRuntimeDirForLocks?: boolean,
 *   legacyHomeOnly?: boolean,
 * }} [opts]
 */
export function createStoragePaths(C, opts = {}) {
  if (!C || !C.CACHE_DIRNAME) {
    throw new Error('createStoragePaths: C.CACHE_DIRNAME is required');
  }
  const env = opts.env || process.env;
  const nodeFs = opts.fs || fs;
  const tool = C.CACHE_DIRNAME;

  // ⛔ legacyHomeOnly — the COMPATIBILITY MODE for pre-v59v call sites.
  //
  // base's existing derivations (mounts.cacheRoot, the mutex lockBaseDir) hardcode
  // $HOME and honour no XDG variable. Consolidating them onto the XDG-aware
  // resolver would therefore RELOCATE cache, profiles and locks for anyone who
  // has $XDG_CACHE_HOME set — silently, on upgrade.
  //
  // That is the same hazard as the runtime-dir lock move, reached through a
  // different variable: during a rollout, one process on the old base and one on
  // the new take locks in two different directories and BOTH believe they hold
  // it. And for profiles it is worse in a quieter way — a relocated profile is
  // an empty profile, which means a silently logged-OUT browser and a human
  // re-authenticating, with the real session still sitting at the old path.
  //
  // So the call sites pass legacyHomeOnly and DO NOT MOVE. New code gets the
  // XDG-correct default that v59v §4 mandates. Flipping the existing sites is a
  // deliberate, announced migration — not a side effect of consolidation.
  const rootFor = (/** @type {string} */ v, /** @type {string[]} */ fb) =>
    opts.legacyHomeOnly ? xdgRoot({ HOME: env.HOME, USERPROFILE: env.USERPROFILE }, v, fb)
                        : xdgRoot(env, v, fb);

  // ⚠ THE CONFIG TREE IS KEYED ON C.PROJECT, THE CACHE TREE ON C.CACHE_DIRNAME.
  // They are different fields and today they happen to be EQUAL in all four
  // consumers, which is exactly why this is worth pinning: the divergence is
  // invisible until a consumer sets them differently, and then config silently
  // moves. v59v §6 sketched configRoot on CACHE_DIRNAME; the SHIPPED code
  // (client-config.js, the pre-existing derivation) uses C.PROJECT. Matching
  // the code rather than the sketch, because the code is what has files in it.
  const configKey = C.PROJECT || tool;
  const configRoot = path.join(rootFor('XDG_CONFIG_HOME', ['.config']), NAMESPACE, configKey);
  const cacheRoot  = path.join(rootFor('XDG_CACHE_HOME',  ['.cache']),  NAMESPACE, tool);
  const stateRoot  = path.join(rootFor('XDG_STATE_HOME',  ['.local', 'state']), NAMESPACE, tool);

  // ⛔ LOCKS DEFAULT TO THE CACHE ROOT, AND MOVING THEM IS OPT-IN ONLY.
  //
  // v59v §4.1 reads two ways: "default: cache-fallback (unchanged for current
  // consumers)" and "runtime-dir is an opt-in the resolver picks when the var is
  // present". Those conflict — $XDG_RUNTIME_DIR is set on virtually every
  // desktop Linux session, so "picks it when present" is not unchanged, it is a
  // silent relocation for nearly everyone.
  //
  // Resolved toward unchanged, and NOT as a matter of taste: a lock directory
  // that moves is a lock that stops working DURING THE ROLLOUT. Two processes
  // of the same tool — one on the old base, one on the new — would take locks
  // in two different directories and BOTH believe they hold it. That is the
  // exact mutual-exclusion failure v8m2/p06y exist to prevent, caused by the
  // upgrade rather than by a bug. A tool opts in when its whole fleet is on one
  // version, which is a thing only the tool can know.
  const locksDir = (opts.preferRuntimeDirForLocks && env.XDG_RUNTIME_DIR &&
                    path.isAbsolute(env.XDG_RUNTIME_DIR))
    ? path.join(env.XDG_RUNTIME_DIR, NAMESPACE, tool, 'locks')
    : path.join(cacheRoot, 'locks');

  /** Legacy roots, READ-ONLY, most-recent-convention first. */
  const legacyCacheRoots = [
    path.join(rootFor('XDG_CACHE_HOME', ['.cache']), NAMESPACE, ...LEGACY_SHARED_SEGMENTS),
  ];

  return {
    configRoot,
    cacheRoot,
    stateRoot,
    locksDir,
    logsDir: path.join(cacheRoot, 'logs'),
    profilesRoot: path.join(cacheRoot, 'profiles'),

    /** Read-only legacy locations. Never written, never cleaned. */
    legacyCacheRoots,

    /**
     * Where a cache-relative file lives, TOLERATING the pre-migration layout.
     *
     * Returns the canonical path when it exists; otherwise the first legacy
     * path that exists; otherwise the canonical path (so writers always write
     * canonically). Reading is migrated the moment this ships; writing moves
     * when a human moves the files. Nothing here deletes.
     * @param {string} relPath
     * @returns {string}
     */
    resolveExisting(relPath) {
      const canonical = path.join(cacheRoot, relPath);
      if (nodeFs.existsSync(canonical)) return canonical;
      for (const root of legacyCacheRoots) {
        const legacy = path.join(root, relPath);
        if (nodeFs.existsSync(legacy)) return legacy;
      }
      return canonical;
    },

    /**
     * True when a file is being read from a legacy location — so a tool can say
     * so once, rather than a migration happening invisibly.
     * @param {string} relPath
     */
    isLegacy(relPath) {
      return !nodeFs.existsSync(path.join(cacheRoot, relPath)) &&
        legacyCacheRoots.some((r) => nodeFs.existsSync(path.join(r, relPath)));
    },

    /** @param {string} name */
    migrationMarker(name) {
      return path.join(cacheRoot, 'migrations', `${name}.done`);
    },

    /** f6rd gateway grant store — XDG "state": persists, not config, not cache. */
    gatewayStatePath() {
      return path.join(stateRoot, 'xpra-access.json');
    },

    /**
     * lf4f per-client config file. The client segment is per-CLIENT isolation
     * inside the per-TOOL root; the two are orthogonal.
     * @param {string} [client]
     */
    configFile(client) {
      const file = C.CONFIG_FILE_PROJECT || `${tool}.config.jsonc`;
      return client
        ? path.join(configRoot, client, 'webctl', file)
        : path.join(configRoot, file);
    },

    /**
     * Dotenv candidates, HIGHEST PRECEDENCE FIRST (v59v §5): the project-root
     * file every tool already uses, then the user-global XDG location.
     * @param {string} [projectRoot]
     */
    dotenvCandidates(projectRoot) {
      const name = C.DOTENV_FILENAME || `.env.${tool}`;
      return [
        path.join(projectRoot || env.PWD || process.cwd(), name),
        path.join(configRoot, name),
      ];
    },
  };
}
