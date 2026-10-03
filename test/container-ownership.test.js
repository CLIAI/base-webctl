// container-ownership.test.js — owner in the NAME, proof by MOUNT, and the
// migration off the pre-owner names.
//
// ⛔ THE DEFECT. Container names were computed from the slug alone —
// `<prefix>chromium-<slug>`, default slug `default` — so on a SHARED docker
// daemon two accounts running the same tool with the same slug asked for the
// IDENTICAL name, and the driver's exact-name `rm -f` removed the OTHER
// account's running, signed-in browser. (Inherited from an early xq; rx9q §5a.)
//
// The cure, in three parts, each tested here:
//   B1  the owner is IN THE NAME (`<prefix>u<uid>-chromium-<slug>`), so honest
//       accounts never collide — a label cannot stop `docker run --name` colliding;
//   B2  PROOF of "ours" is what a container MOUNTS (our profile dir), never its
//       name or label — both are copies anyone can set. The label is a FILTER;
//   M   a pre-owner container PROVABLY ours is running on our profile, so it is
//       stopped and removed before anything new starts; one NOT provably ours
//       is absent to us — never touched, never blocking.
//
// The fake docker is a small STATEFUL daemon (containers appear on run, vanish
// on rm, stop running on stop), wrapped by guardedDocker so nothing here can
// reach the real docker CLI. Every rm/stop is RECORDED: "refused" is asserted
// as "rm was never called", not merely "an error was thrown".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import { createProfileLock } from '../lib/browser-location/profile-lock.js';
import {
  guardedDocker, assertHermetic, INSPECT_ABSENT, inspectPresent,
} from './helpers/fake-docker-inspect.mjs';

const UID = 4242;
const OWNER = 'demo-webctl.owner.uid';
// The owner-named pair (B1) — asserted as exact strings, never derived.
const CHROMIUM = 'demo-webctl-u4242-chromium-test';
const XPRA = 'demo-webctl-u4242-xpra-test';
const VOLUME = 'demo-webctl-u4242-x11-test';
// The pre-owner names, exactly as older base computed them.
const L_CHROMIUM = 'demo-webctl-chromium-test';
const L_XPRA = 'demo-webctl-xpra-test';
const L_VOLUME = 'demo-webctl-x11-test';
// Fictional paths: base is a public repo.
const OUR_PROFILE = '/home/someone/.cache/demo/profiles/test/chromium';
const FOREIGN_PROFILE = '/home/otheraccount/private-profile-dir';

function fakeC() {
  return {
    PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
    IMAGE_CHROMIUM_REPO: 'demo/chromium', IMAGE_XPRA: 'demo/xpra:latest',
    DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'demo.example', CONFIG_FILE_PROJECT: 'demo.config.jsonc',
    DOTENV_FILENAME: '.env.demo', DOTENV_TEMPLATE: '.env.demo.example',
    ENV_PREFIX: 'DEMO_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
  };
}
function hermeticMounts(/** @type {any} */ C) {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  const fake = (/** @type {string} */ s, /** @type {string} */ u) => u || `/tmp/no-mkdir/${s}`;
  return { ...m, resolveChromiumProfile: fake, profilePathFor: fake, cacheRoot: () => '/tmp/cache' };
}
/** No Preferences writes: the profile path is fictional. */
const noPrefs = {
  DEFAULT_HOST: 'demo.example',
  preferencesPath: (/** @type {string} */ p) => p,
  applyHostZoomToPreferences: () => ({ action: 'noop' }),
  applyStartupPolicyToPreferences: () => ({ action: 'noop' }),
};
/** A lock that is always free and always acquired. */
function freeLock() {
  return {
    readLock: () => null,
    isHolderAlive: async () => ({ alive: false, reason: 'test' }),
    acquire: async () => ({ ok: true, lock: {}, tookOver: false }),
    describeHolder: () => '(none)',
    lockPath: (/** @type {string} */ p) => `${p}/.lock`,
    release: () => {},
  };
}

/**
 * @typedef {{running?: boolean, labels?: Record<string,string>, binds?: string[]}} Ctr
 */

/**
 * A stateful fake daemon.
 * @param {Record<string, Ctr | 'fail' | 'garbage'>} initial  name → container
 * @param {{rmIsNoop?: boolean}} [o]
 */
function daemon(initial, o = {}) {
  /** @type {Map<string, any>} */
  const ctrs = new Map(Object.entries(initial).map(([k, v]) => [k,
    typeof v === 'string' ? v : { running: v.running !== false, labels: v.labels || {}, binds: v.binds || [] }]));
  /** @type {string[]} */
  const verbs = [];
  /** @type {string[]} two running chromiums on one profile, observed at a `docker run` */
  const overlaps = [];
  const live = (/** @type {string} */ n) => { const c = ctrs.get(n); return c && typeof c === 'object' ? c : null; };
  const { docker, violations } = guardedDocker({
    dockerAvailable: async () => true,
    imageExists: async () => true,
    containerExists: async (/** @type {string} */ n) => ctrs.has(n),
    containerRunning: async (/** @type {string} */ n) => !!(live(n) && live(n).running),
    rm: async (/** @type {string} */ n) => { verbs.push(`rm:${n}`); if (!o.rmIsNoop) ctrs.delete(n); },
    stop: async (/** @type {string} */ n) => { verbs.push(`stop:${n}`); if (live(n)) live(n).running = false; },
    volumeRm: async (/** @type {string} */ n) => { verbs.push(`volumeRm:${n}`); },
    volumeCreate: async (/** @type {string} */ n) => { verbs.push(`volumeCreate:${n}`); },
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    runDetached: async (/** @type {any} */ a) => {
      verbs.push(`run:${a.name}`);
      const binds = (a.mounts || []).map((/** @type {any} */ m) => m[0])
        .filter((/** @type {string} */ s) => s.startsWith('/'));
      for (const [n, c] of ctrs) {
        if (c && typeof c === 'object' && c.running && c.binds.some((/** @type {string} */ b) => binds.includes(b))) {
          overlaps.push(`${a.name} started while ${n} runs on the same profile`);
        }
      }
      if (ctrs.has(a.name)) return { code: 125, stderr: `Conflict. The container name "/${a.name}" is already in use` };
      ctrs.set(a.name, { running: true, labels: a.labels || {}, binds });
      return { code: 0, stderr: '', args: a };
    },
  }, { run: {
    inspect: (a) => {
      const n = a[a.length - 1];
      verbs.push(`inspect:${n}`);
      const c = ctrs.get(n);
      if (c === undefined) return INSPECT_ABSENT;
      if (c === 'fail') return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon. Is the docker daemon running?\n' };
      if (c === 'garbage') return { code: 0, stdout: 'not json at all', stderr: '' };
      return inspectPresent(n, { labels: c.labels, binds: c.binds });
    },
    logs: () => ({ code: 0, stdout: 'container logs', stderr: '' }),
  } });
  /** @type {any[]} */
  const runs = [];
  const rd = docker.runDetached;
  // keep the full run args for label/name assertions
  /** @type {any} */ (docker).runDetached = async (/** @type {any} */ a) => { runs.push(a); return rd(a); };
  return { docker, verbs, violations, overlaps, ctrs, runs };
}

/**
 * @param {any} docker
 * @param {{uid?: number|null, lock?: any, userDataDir?: string, logs?: string[], cdpPort?: number}} [o]
 *   `cdpPort`: drive CDP at this port (a test server) instead of portless.
 */
function driver(docker, o = {}) {
  const C = fakeC();
  /** @type {string[]} */
  const logs = o.logs || [];
  return createChromiumDockerXpra(C, {
    mounts: hermeticMounts(C), docker, profileLock: o.lock || freeLock(), chromiumPrefs: noPrefs,
    ...(o.uid === null ? {} : { uid: o.uid ?? UID }),
  }).createDriver({
    port: o.cdpPort || 45998, host: '127.0.0.1', slug: 'test', force: true,
    userDataDir: o.userDataDir || OUR_PROFILE,
    // portless unless a test CDP endpoint is supplied: no poll against a real port
    ...(o.cdpPort ? {} : { containerEnv: { LWC_CDP_PORT: null } }),
    logger: {
      info: (/** @type {string} */ m) => logs.push(`info:${m}`),
      warn: (/** @type {string} */ m) => logs.push(`warn:${m}`),
      debug: (/** @type {string} */ m) => logs.push(`debug:${m}`),
    },
  });
}

/**
 * Bring up against a daemon in the given state.
 * @param {Record<string, Ctr | 'fail' | 'garbage'>} initial
 * @param {{rmIsNoop?: boolean, lock?: any, userDataDir?: string, cdpPort?: number}} [o]
 */
async function up(initial, o = {}) {
  const d = daemon(initial, o);
  /** @type {string[]} */
  const logs = [];
  /** @type {any} */
  let error, result;
  try { result = await driver(d.docker, { ...o, logs }).ensureRunning(); } catch (e) { error = e; }
  assertHermetic(d.violations);
  const removed = d.verbs.filter((v) => v.startsWith('rm:'));
  const stopped = d.verbs.filter((v) => v.startsWith('stop:'));
  const started = d.verbs.filter((v) => v.startsWith('run:'));
  return { ...d, error, result, removed, stopped, started, logs };
}

// Shapes. "ours" is defined by the MOUNT; the label alone proves nothing (B2).
const ours = (/** @type {Ctr} */ x = {}) => ({ labels: { [OWNER]: String(UID) }, binds: [OUR_PROFILE], running: false, ...x });
const labelOnly = () => ({ labels: { [OWNER]: String(UID) }, binds: [], running: false });
const foreign = () => ({ labels: { [OWNER]: '1001' }, binds: [FOREIGN_PROFILE], running: false });
const xpraOf = (/** @type {Ctr} */ x = {}) => ({ labels: { [OWNER]: String(UID) }, binds: [], running: false, ...x });

/** The refusal shape every refusing arm shares. */
function assertRefused(/** @type {any} */ r, /** @type {string} */ name) {
  assert.ok(r.error, 'must refuse');
  assert.equal(r.error.exitCode, 4, 'a refusal is a CONFIG_ERROR (exit 4), like the others');
  assert.match(String(r.error.message), new RegExp(`REFUSING to (remove|stop) container ${name}\\b`));
  assert.match(String(r.error.message), /different slug \/ --client/);
  assert.match(String(r.error.message), new RegExp(`docker rm -f ${name}`));
  assert.deepEqual(r.removed, [], `nothing may be removed; saw ${r.verbs.join(', ')}`);
  assert.deepEqual(r.started, [], 'and nothing started over the top of it');
  assert.ok(!String(r.error.message).includes(FOREIGN_PROFILE),
    'a foreign container\'s host paths are never printed');
}

// ── B1: the owner is in the name ────────────────────────────────────────────

test('⛔ BREAKING: bring-up creates the OWNER-NAMED pair and volume — exact strings', async () => {
  const r = await up({});
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.deepEqual(r.started, [`run:${XPRA}`, `run:${CHROMIUM}`]);
  assert.ok(r.verbs.includes(`volumeCreate:${VOLUME}`), r.verbs.join(', '));
  const chromium = r.runs.find((a) => a.name === CHROMIUM);
  assert.deepEqual(chromium.extra, ['--network', `container:${XPRA}`], 'chromium joins the owner-named xpra');
  assert.ok(chromium.mounts.some((/** @type {any} */ m) => m[0] === VOLUME), 'and mounts the owner-named volume');
  // the label is still stamped (a filter for listing), on both
  for (const a of r.runs) assert.equal(a.labels[OWNER], String(UID), a.name);
  assert.equal(r.runs[1].labels['demo-webctl.role'], 'chromium', 'existing labels are kept');
});

test('inspect() advertises the owner-named containers', () => {
  const i = /** @type {any} */ (driver(daemon({}).docker)).inspect();
  assert.equal(i.names.chromiumContainer, CHROMIUM);
  assert.equal(i.names.xpraContainer, XPRA);
  assert.equal(i.names.xpraSocketVolume, VOLUME);
});

test('the owner uid defaults to process.getuid() — in the name AND the label', async (t) => {
  if (typeof process.getuid !== 'function') { t.skip('no getuid on this platform'); return; }
  const d = daemon({});
  try { await driver(d.docker, { uid: null }).ensureRunning(); } catch { /* irrelevant */ }
  assertHermetic(d.violations);
  assert.ok(d.runs.length > 0, 'premise: a container was started');
  assert.equal(d.runs[0].name, `demo-webctl-u${process.getuid()}-xpra-test`);
  assert.equal(d.runs[0].labels[OWNER], String(process.getuid()));
});

test('⭐ another account\'s same-slug pair no longer COLLIDES — it is simply not ours', async () => {
  // The scenario that motivated B1: Alice (1001) runs slug `test`. Bob (4242)
  // brings up the same slug. Different names: nothing to block on, nothing killed.
  const r = await up({
    'demo-webctl-u1001-chromium-test': { ...foreign(), running: true },
    'demo-webctl-u1001-xpra-test': { labels: { [OWNER]: '1001' }, running: true },
  });
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.ok(!r.verbs.some((v) => /u1001/.test(v) && !v.startsWith('inspect:')), r.verbs.join(', '));
  assert.ok(r.ctrs.get('demo-webctl-u1001-chromium-test').running, 'Alice\'s browser still runs');
});

// ── B2: proof is the profile MOUNT; the label is a filter ───────────────────

test('CONTROL: an owner-named pair whose chromium mounts OUR profile → removal proceeds', async () => {
  const r = await up({ [CHROMIUM]: ours(), [XPRA]: xpraOf() });
  assert.deepEqual(r.removed, [`rm:${CHROMIUM}`, `rm:${XPRA}`]);
  assert.ok(r.verbs.indexOf(`inspect:${CHROMIUM}`) < r.verbs.indexOf(`rm:${CHROMIUM}`), 'inspect licensed it');
});

test('⛔ B2: OUR owner label WITHOUT the profile mount is NOT proof — refused', async () => {
  // A label is a copy: anyone can `docker run --label demo-webctl.owner.uid=4242`.
  const r = await up({ [CHROMIUM]: labelOnly(), [XPRA]: xpraOf() });
  assertRefused(r, CHROMIUM);
  assert.match(String(r.error.message), /cannot\s+be proven ours \(a name or an owner label is not proof\)/);
});

test('CONTROL: an unlabelled chromium mounting OUR profile → proven ours by the mount', async () => {
  const r = await up({ [CHROMIUM]: { binds: [OUR_PROFILE], running: false } });
  assert.deepEqual(r.removed, [`rm:${CHROMIUM}`, `rm:${XPRA}`]);
});

test('⛔ the label is a FILTER: another uid\'s label rules a container out even if it mounts our profile', async () => {
  const r = await up({ [CHROMIUM]: { labels: { [OWNER]: '1001' }, binds: [OUR_PROFILE], running: false } });
  assertRefused(r, CHROMIUM);
  assert.match(String(r.error.message), /another account \(owner uid 1001; ours is 4242\)/);
});

test('⛔ a chromium mounting a DIFFERENT profile is refused — and its path is not printed', async () => {
  const r = await up({ [CHROMIUM]: { binds: [FOREIGN_PROFILE], running: false } });
  assertRefused(r, CHROMIUM);
});

test('⛔ a FOREIGN xpra is refused even when chromium is ours — no partial removal', async () => {
  const r = await up({ [CHROMIUM]: ours(), [XPRA]: { labels: { [OWNER]: '1001' }, running: false } });
  assertRefused(r, XPRA);
  assert.match(String(r.error.message), /another account/);
});

test('⛔ an xpra ALONE (no chromium to vouch for it) is refused', async () => {
  const r = await up({ [XPRA]: xpraOf() });
  assertRefused(r, XPRA);
  // the one-time orphan: the refusal names the exact one-time remedy
  assert.match(String(r.error.message), /chromium partner \(demo-webctl-u4242-chromium-test\) does not exist/);
  assert.match(String(r.error.message), /ONE-TIME orphan/);
  assert.match(String(r.error.message), /remove it once:  docker rm -f demo-webctl-u4242-xpra-test/);
});

test('⛔ an xpra whose chromium EXISTS but is not ours is refused — and is not called an orphan', async () => {
  const r = await up({ [CHROMIUM]: { binds: [FOREIGN_PROFILE], running: false }, [XPRA]: xpraOf() });
  assertRefused(r, CHROMIUM);
  assert.doesNotMatch(String(r.error.message), /orphan/);
});

test('⛔ a FAILED inspect is refused, never read as "absent"', async () => {
  const r = await up({ [CHROMIUM]: 'fail' });
  assertRefused(r, CHROMIUM);
  assert.match(String(r.error.message), /could not be read \(docker inspect exited 1: Cannot connect/);
});

test('⛔ an UNPARSEABLE inspect is refused', async () => {
  const r = await up({ [XPRA]: 'garbage' });
  assertRefused(r, XPRA);
  assert.match(String(r.error.message), /not JSON/);
});

test('⛔ an inspect that THROWS is refused', async () => {
  const d = daemon({});
  /** @type {any} */ (d.docker).run = async () => { throw new Error('spawn docker ENOENT'); };
  /** @type {any} */
  let error;
  try { await driver(d.docker).ensureRunning(); } catch (e) { error = e; }
  assert.ok(error);
  assert.match(String(error.message), /docker inspect threw: spawn docker ENOENT/);
  assert.ok(!d.verbs.some((v) => v.startsWith('rm:') || v.startsWith('run:')));
});

// ── shutdown (stop) obeys the same rule ─────────────────────────────────────

test('CONTROL: shutdown() of a pair proven ours stops both, removes nothing', async () => {
  const d = daemon({ [CHROMIUM]: ours({ running: true }), [XPRA]: xpraOf({ running: true }) });
  await driver(d.docker).shutdown();
  assertHermetic(d.violations);
  assert.deepEqual(d.verbs.filter((v) => /^(stop|rm):/.test(v)), [`stop:${CHROMIUM}`, `stop:${XPRA}`]);
});

test('⛔ shutdown() of a pair NOT proven ours stops NOTHING (foreign label / label only)', async () => {
  for (const chromium of [foreign(), labelOnly()]) {
    const d = daemon({ [CHROMIUM]: { ...chromium, running: true }, [XPRA]: xpraOf({ running: true }) });
    /** @type {any} */
    let error;
    try { await driver(d.docker).shutdown(); } catch (e) { error = e; }
    assertHermetic(d.violations);
    assert.ok(error, 'must refuse');
    assert.equal(error.exitCode, 4);
    assert.match(String(error.message), /REFUSING to stop container demo-webctl-u4242-chromium-test/);
    assert.deepEqual(d.verbs.filter((v) => v.startsWith('stop:')), []);
  }
});

// ── the lock-failure teardown ───────────────────────────────────────────────

test('⛔ the lock-failure teardown removes NOTHING it cannot prove ours — and says so', async () => {
  // Normally this passes: the containers this call started mount our profile
  // (docker-up-lock-fails-closed.test.js). Here they are swapped for foreign
  // ones before the teardown — the name a call started is not proof.
  const d = daemon({});
  const lock = {
    ...freeLock(),
    acquire: async () => {
      d.ctrs.set(CHROMIUM, { running: true, labels: { [OWNER]: '1001' }, binds: [FOREIGN_PROFILE] });
      return { ok: false, previous: null };
    },
  };
  /** @type {any} */
  let error;
  try { await driver(d.docker, { lock }).ensureRunning(); } catch (e) { error = e; }
  assertHermetic(d.violations);
  assert.ok(error, 'must refuse');
  assert.match(String(error.message), /profile lock NOT acquired/);
  assert.match(String(error.message), /containers were NOT removed/);
  assert.match(String(error.message), /another account/);
  assert.ok(!String(error.message).includes(FOREIGN_PROFILE));
  // only what happened AFTER the start is the teardown (the pre-start cleanup
  // of absent names is a no-op rm, and not what this arm is about)
  const afterStart = d.verbs.slice(d.verbs.findIndex((v) => v.startsWith('run:')));
  assert.ok(afterStart.length > 0, 'premise: containers were started');
  assert.deepEqual(afterStart.filter((v) => v.startsWith('rm:')), [], afterStart.join(', '));
});

// ── MIGRATION off the pre-owner names ───────────────────────────────────────

test('⛔ MIGRATION: a RUNNING pre-owner pair on OUR profile is stopped, removed, VERIFIED gone — then the new pair starts', async () => {
  const r = await up({
    [L_CHROMIUM]: { binds: [OUR_PROFILE] }, // older base: no label, running
    [L_XPRA]: {},
  });
  assert.equal(r.error, undefined, r.error && r.error.message);
  // graceful stop before removal (chromium flushes its profile on SIGTERM)
  const i = (/** @type {string} */ v) => r.verbs.indexOf(v);
  assert.ok(i(`stop:${L_CHROMIUM}`) >= 0 && i(`stop:${L_CHROMIUM}`) < i(`rm:${L_CHROMIUM}`), r.verbs.join(', '));
  assert.ok(i(`rm:${L_XPRA}`) >= 0, 'its xpra partner goes too');
  assert.ok(r.verbs.includes(`volumeRm:${L_VOLUME}`), 'and the pre-owner volume (best effort)');
  // ⛔ no window where two browsers run on one profile
  assert.ok(i(`rm:${L_CHROMIUM}`) < i(`run:${XPRA}`), 'legacy gone BEFORE anything new starts');
  assert.deepEqual(r.overlaps, []);
  assert.deepEqual([...r.ctrs.keys()].sort(), [CHROMIUM, XPRA]);
});

test('⛔ MIGRATION: a pre-owner chromium that SURVIVES removal stops everything — nothing new starts', async () => {
  const r = await up({ [L_CHROMIUM]: { binds: [OUR_PROFILE] } }, { rmIsNoop: true });
  assert.ok(r.error, 'must refuse');
  assert.match(String(r.error.message), /pre-owner container demo-webctl-chromium-test runs on this profile and could\s+not be removed/);
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.overlaps, []);
});

test('⛔ MIGRATION: a pre-owner chromium that cannot be INSPECTED blocks bring-up (it might be ours)', async () => {
  const r = await up({ [L_CHROMIUM]: 'fail' });
  assert.ok(r.error, 'must refuse');
  assert.equal(r.error.exitCode, 4);
  assert.match(String(r.error.message), /cannot tell whether a pre-owner container demo-webctl-chromium-test/);
  assert.deepEqual(r.started, []);
});

test('⭐ MIGRATION: a pre-owner pair NOT provably ours is ABSENT to us — untouched, not blocking', async () => {
  const r = await up({
    [L_CHROMIUM]: { binds: [FOREIGN_PROFILE] }, // another account's, on the old shared name
    [L_XPRA]: {},
  });
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.ok(!r.verbs.some((v) => /^(stop|rm):demo-webctl-(chromium|xpra)-test$/.test(v)), r.verbs.join(', '));
  assert.ok(!r.verbs.includes(`volumeRm:${L_VOLUME}`));
  assert.ok(r.ctrs.get(L_CHROMIUM).running, 'their browser still runs');
  assert.deepEqual(r.started, [`run:${XPRA}`, `run:${CHROMIUM}`], 'bring-up proceeds under the new names');
  // mentioned in a DEBUG log only — by name, never by path
  const debug = r.logs.filter((l) => l.startsWith('debug:') && l.includes(L_CHROMIUM));
  assert.equal(debug.length, 1, r.logs.join('\n'));
  assert.ok(!r.logs.some((l) => l.includes(FOREIGN_PROFILE)), 'a foreign path is never logged');
  assert.ok(!r.logs.some((l) => l.startsWith('info:') && l.includes(L_CHROMIUM)), 'not above debug');
});

test('MIGRATION: a lone pre-owner xpra (no chromium to vouch for it) is ignored', async () => {
  const r = await up({ [L_XPRA]: {} });
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.ok(!r.verbs.some((v) => v === `rm:${L_XPRA}` || v === `stop:${L_XPRA}`));
});

/** A REAL profile lock (the driver's own module), used in a throwaway dir. */
const realLock = () => createProfileLock(fakeC(), { assert: false });

test('⛔ MIGRATION: a profile lock written by OUR pre-owner container is NOT a refusal', async () => {
  // The lock's ownContainer check compares NAMES; a lock our legacy container
  // wrote names the legacy name. Migration removes that container before the
  // lock is read, so the lock reads as container-missing → stale → taken over.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mig-'));
  try {
    const lock = realLock();
    await lock.acquire(dir, { mode: 'chromium-docker-xpra-ubuntu-latest', pid: 1, containerName: L_CHROMIUM }, { force: true });
    assert.equal(lock.readLock(dir).containerName, L_CHROMIUM, 'premise: the lock names the legacy container');
    const r = await up({ [L_CHROMIUM]: { binds: [dir] }, [L_XPRA]: {} }, { lock, userDataDir: dir });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.equal(lock.readLock(dir).containerName, CHROMIUM, 'the lock now names the owner-named container');
    assert.deepEqual(r.overlaps, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CONTROL: the same lock held by a live container NOT provably ours IS a refusal', async () => {
  // Shows the lock check above is live, not bypassed: here the legacy chromium
  // runs on a different profile, so migration leaves it, and the lock (naming
  // it, alive) refuses the start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mig-'));
  try {
    const lock = realLock();
    await lock.acquire(dir, { mode: 'chromium-docker-xpra-ubuntu-latest', pid: 1, containerName: L_CHROMIUM }, { force: true });
    const r = await up({ [L_CHROMIUM]: { binds: [FOREIGN_PROFILE] } }, { lock, userDataDir: dir });
    assert.ok(r.error, 'must refuse');
    assert.match(String(r.error.message), /Profile directory is already in use/);
    assert.deepEqual(r.started, []);
    assert.ok(!r.verbs.some((v) => v.startsWith('rm:') || v.startsWith('stop:')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATION: shutdown() also STOPS a pre-owner browser on our profile (never removes)', async () => {
  // Otherwise `down` after the upgrade would silently leave it running.
  const d = daemon({ [L_CHROMIUM]: { binds: [OUR_PROFILE] }, [L_XPRA]: {} });
  await driver(d.docker).shutdown();
  assertHermetic(d.violations);
  assert.ok(d.verbs.includes(`stop:${L_CHROMIUM}`) && d.verbs.includes(`stop:${L_XPRA}`), d.verbs.join(', '));
  assert.ok(!d.verbs.some((v) => v.startsWith('rm:') || v.startsWith('volumeRm:')), 'shutdown never removes');
});

test('MIGRATION: shutdown() leaves a pre-owner browser NOT provably ours alone', async () => {
  const d = daemon({ [L_CHROMIUM]: { binds: [FOREIGN_PROFILE] }, [L_XPRA]: {} });
  await driver(d.docker).shutdown();
  assertHermetic(d.violations);
  assert.ok(!d.verbs.some((v) => v === `stop:${L_CHROMIUM}` || v === `stop:${L_XPRA}`), d.verbs.join(', '));
  assert.ok(d.ctrs.get(L_CHROMIUM).running, 'their browser still runs');
});

// ── the REUSE path: a healthy running pair is driven only if proven ours ────

/** A local endpoint that answers CDP's /json/version — so "CDP answers" is real. */
async function cdpEndpoint() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'FakeChrome/1.0' }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {any} */ (srv.address()).port;
  return { port, close: () => new Promise((resolve) => srv.close(() => resolve(undefined))) };
}

test('CONTROL: a running, CDP-answering pair PROVEN ours is reused — nothing removed or started', async () => {
  const cdp = await cdpEndpoint();
  try {
    const r = await up({ [CHROMIUM]: ours({ running: true }), [XPRA]: xpraOf({ running: true }) }, { cdpPort: cdp.port });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.cdpHttpUrl, `http://127.0.0.1:${cdp.port}`);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.started, []);
  } finally { await cdp.close(); }
});

test('⛔ a running, CDP-answering pair NOT provably ours is never DRIVEN — and never removed', async () => {
  // Same uid, same names, our label — but its chromium runs a DIFFERENT profile
  // (e.g. the slug's userDataDir was changed). Handing back its CDP URL would
  // have the caller drive a session that is not this profile's.
  const cdp = await cdpEndpoint();
  try {
    const r = await up({
      [CHROMIUM]: { labels: { [OWNER]: String(UID) }, binds: [FOREIGN_PROFILE], running: true },
      [XPRA]: xpraOf({ running: true }),
    }, { cdpPort: cdp.port });
    assert.equal(r.result, undefined, 'no CDP URL may be handed back');
    assert.ok(r.error, 'must refuse');
    assert.equal(r.error.exitCode, 4);
    assert.match(String(r.error.message), /REFUSING to reuse container demo-webctl-u4242-chromium-test/);
    assert.ok(!String(r.error.message).includes(FOREIGN_PROFILE));
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.stopped, []);
    assert.deepEqual(r.started, []);
    assert.ok(r.ctrs.get(CHROMIUM).running, 'it still runs');
  } finally { await cdp.close(); }
});

test('⛔ portless too: a running pair NOT provably ours is not reused', async () => {
  const r = await up({
    [CHROMIUM]: { labels: { [OWNER]: '1001' }, binds: [FOREIGN_PROFILE], running: true },
    [XPRA]: { labels: { [OWNER]: '1001' }, running: true },
  });
  assert.equal(r.result, undefined);
  assert.match(String(r.error && r.error.message), /REFUSING to reuse container .*another account/s);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.started, []);
});
