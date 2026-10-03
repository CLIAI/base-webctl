// container-ownership.test.js — never rm or stop a container not proven OURS.
//
// ⛔ THE DEFECT. Container names are computed from the slug —
// `<prefix>chromium-<slug>` / `<prefix>xpra-<slug>`, default slug `default` —
// and carry no owner. On a SHARED docker daemon two accounts running the same
// tool with the same slug produce IDENTICAL names, and the driver's
// `docker rm -f <name>` removed the OTHER account's running, signed-in browser.
// Exact `^name$` matching does not help: the name is the same. (Inherited from
// an early xq; rx9q §5a. Cure: an owner label, and nothing removed or stopped
// unless proven ours — an unrecognised holder is HELD, ow9k.)
//
// Everything here runs against a FAKE docker: `docker.run(['inspect', …])`
// answers crafted JSON, and every rm/stop is RECORDED, so "refused" is
// asserted as "rm was never called", not merely "an error was thrown".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import * as realDocker from '../lib/browser-location/docker-ctl.js';
import { INSPECT_ABSENT, inspectPresent } from './helpers/fake-docker-inspect.mjs';

const OUR_UID = 4242;
const OWNER = 'demo-webctl.owner.uid';
const CHROMIUM = 'demo-webctl-chromium-test';
const XPRA = 'demo-webctl-xpra-test';
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
 * @typedef {'absent' | 'fail' | 'garbage' | {labels?: Record<string,string>, binds?: string[]}} CState
 */

/**
 * A recording fake docker whose inspect answers the given per-container state.
 * @param {{chromium?: CState, xpra?: CState}} st
 * @param {{haltRun?: boolean}} [o]
 */
function fakeDocker(st, o = {}) {
  /** @type {string[]} */
  const verbs = [];
  /** @type {any[]} */
  const runs = [];
  /** @param {string} name */
  const stateOf = (name) => (name === CHROMIUM ? st.chromium : name === XPRA ? st.xpra : 'absent') || 'absent';
  const docker = {
    ...realDocker,
    dockerAvailable: async () => true,
    containerExists: async () => false,
    containerRunning: async () => false, // not a healthy pair → bring-up cleans up
    imageExists: async () => true,
    rm: async (/** @type {string} */ n) => { verbs.push(`rm:${n}`); return { code: 0 }; },
    stop: async (/** @type {string} */ n) => { verbs.push(`stop:${n}`); return { code: 0 }; },
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    run: async (/** @type {string[]} */ a) => {
      if (a[0] !== 'inspect') return { code: 0, stdout: '', stderr: '' };
      verbs.push(`inspect:${a[a.length - 1]}`);
      const s = stateOf(a[a.length - 1]);
      if (s === 'absent') return INSPECT_ABSENT;
      if (s === 'fail') return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon. Is the docker daemon running?\n' };
      if (s === 'garbage') return { code: 0, stdout: 'not json at all', stderr: '' };
      return inspectPresent(a[a.length - 1], s);
    },
    runDetached: async (/** @type {any} */ a) => {
      runs.push(a);
      verbs.push(`run:${a.name}`);
      // Halt after the first container: everything under test happened before it.
      return o.haltRun === false ? { code: 0, stderr: '' } : { code: 1, stderr: 'halted by test' };
    },
  };
  return { docker, verbs, runs };
}

/**
 * @param {any} docker
 * @param {{uid?: number|null, lock?: any}} [o]
 */
function driver(docker, o = {}) {
  const C = fakeC();
  return createChromiumDockerXpra(C, {
    mounts: hermeticMounts(C), docker, profileLock: o.lock || freeLock(),
    ...(o.uid === null ? {} : { uid: o.uid ?? OUR_UID }),
  }).createDriver({
    port: 45998, host: '127.0.0.1', slug: 'test', force: true,
    userDataDir: OUR_PROFILE,
    containerEnv: { LWC_CDP_PORT: null }, // portless: no CDP poll against a real port
  });
}

/** Bring up; return the error (if any) and the recorded verbs. */
async function up(/** @type {{chromium?: CState, xpra?: CState}} */ st) {
  const { docker, verbs } = fakeDocker(st);
  /** @type {any} */
  let error;
  try { await driver(docker).ensureRunning(); } catch (e) { error = e; }
  const removed = verbs.filter((v) => v.startsWith('rm:'));
  const started = verbs.filter((v) => v.startsWith('run:'));
  return { error, verbs, removed, started };
}

const ours = () => ({ labels: { [OWNER]: String(OUR_UID) } });
const foreign = () => ({ labels: { [OWNER]: '1001' }, binds: [FOREIGN_PROFILE] });

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

// ── the label is written ────────────────────────────────────────────────────

test('docker run labels BOTH containers with the owner uid', async () => {
  const { docker, runs } = fakeDocker({}, { haltRun: false });
  try { await driver(docker).ensureRunning(); } catch { /* stub cannot satisfy everything */ }
  const xpra = runs.find((r) => r.name === XPRA);
  const chromium = runs.find((r) => r.name === CHROMIUM);
  assert.ok(xpra && chromium, `both containers must launch; saw ${runs.map((r) => r.name).join(', ')}`);
  assert.equal(xpra.labels[OWNER], String(OUR_UID));
  assert.equal(chromium.labels[OWNER], String(OUR_UID));
  assert.equal(chromium.labels['demo-webctl.role'], 'chromium', 'existing labels are kept');
});

test('the owner uid defaults to process.getuid()', async (t) => {
  if (typeof process.getuid !== 'function') { t.skip('no getuid on this platform'); return; }
  const { docker, runs } = fakeDocker({});
  try { await driver(docker, { uid: null }).ensureRunning(); } catch { /* halted */ }
  assert.ok(runs.length > 0, 'premise: a container was started');
  assert.equal(runs[0].labels[OWNER], String(process.getuid()));
});

// ── owner label ─────────────────────────────────────────────────────────────

test('CONTROL: both containers labelled OURS → removal proceeds', async () => {
  const r = await up({ chromium: ours(), xpra: ours() });
  assert.deepEqual(r.removed, [`rm:${CHROMIUM}`, `rm:${XPRA}`]);
  // and it was the inspect that licensed it, before any rm
  assert.ok(r.verbs.indexOf(`inspect:${CHROMIUM}`) < r.verbs.indexOf(`rm:${CHROMIUM}`));
});

test('CONTROL: both absent → nothing to prove, bring-up proceeds', async () => {
  const r = await up({});
  assert.equal(r.error && r.error.message, 'docker run demo-webctl-xpra-test failed (exit 1): halted by test');
});

test('⛔ a chromium container labelled with ANOTHER uid is refused — rm never called', async () => {
  const r = await up({ chromium: foreign(), xpra: ours() });
  assertRefused(r, CHROMIUM);
  assert.match(String(r.error.message), /another account/);
  assert.match(String(r.error.message), /owner uid 1001; ours is 4242/);
});

test('⛔ a FOREIGN xpra is refused even when chromium is ours — no partial removal', async () => {
  const r = await up({ chromium: ours(), xpra: foreign() });
  assertRefused(r, XPRA);
  assert.match(String(r.error.message), /another account/);
});

// ── legacy (no owner label: created by an older base) ──────────────────────

test('CONTROL: legacy chromium whose bind mount IS our profile → proven ours, proceeds', async () => {
  const r = await up({ chromium: { binds: ['/tmp/.X11-unix-vol', OUR_PROFILE] } });
  assert.deepEqual(r.removed, [`rm:${CHROMIUM}`, `rm:${XPRA}`]);
});

test('⛔ legacy chromium mounting a DIFFERENT profile is refused — rm never called', async () => {
  const r = await up({ chromium: { binds: [FOREIGN_PROFILE] } });
  assertRefused(r, CHROMIUM);
  assert.match(String(r.error.message), /no owner label/);
});

test('⛔ legacy chromium with NO bind mounts at all is refused', async () => {
  const r = await up({ chromium: { binds: [] } });
  assertRefused(r, CHROMIUM);
});

test('CONTROL: legacy xpra whose chromium is proven ours (legacy rule) → proceeds', async () => {
  const r = await up({ chromium: { binds: [OUR_PROFILE] }, xpra: { binds: [] } });
  assert.deepEqual(r.removed, [`rm:${CHROMIUM}`, `rm:${XPRA}`]);
});

test('CONTROL: legacy xpra whose chromium is labelled ours → proceeds', async () => {
  const r = await up({ chromium: ours(), xpra: { binds: [] } });
  assert.deepEqual(r.removed, [`rm:${CHROMIUM}`, `rm:${XPRA}`]);
});

test('⛔ legacy xpra ALONE (no chromium to vouch for it) is refused', async () => {
  const r = await up({ xpra: { binds: [] } });
  assertRefused(r, XPRA);
  assert.match(String(r.error.message), /chromium partner\s+\(demo-webctl-chromium-test\) is not proven ours/);
});

test('⛔ legacy xpra with an UNPROVEN legacy chromium is refused', async () => {
  const r = await up({ chromium: { binds: [FOREIGN_PROFILE] }, xpra: { binds: [] } });
  assertRefused(r, CHROMIUM);
});

// ── inspect itself fails ────────────────────────────────────────────────────

test('⛔ a FAILED inspect is refused, never read as "absent"', async () => {
  const r = await up({ chromium: 'fail' });
  assertRefused(r, CHROMIUM);
  assert.match(String(r.error.message), /could not be read \(docker inspect exited 1: Cannot connect/);
});

test('⛔ an UNPARSEABLE inspect is refused', async () => {
  const r = await up({ xpra: 'garbage' });
  assertRefused(r, XPRA);
  assert.match(String(r.error.message), /not JSON/);
});

test('⛔ an inspect that THROWS is refused', async () => {
  const { docker, verbs } = fakeDocker({});
  docker.run = async () => { throw new Error('spawn docker ENOENT'); };
  /** @type {any} */
  let error;
  try { await driver(docker).ensureRunning(); } catch (e) { error = e; }
  assert.ok(error);
  assert.match(String(error.message), /REFUSING to remove .*docker inspect threw: spawn docker ENOENT/s);
  assert.ok(!verbs.some((v) => v.startsWith('rm:')));
});

// ── shutdown (stop) obeys the same rule ─────────────────────────────────────

test('CONTROL: shutdown() of a pair labelled ours stops both', async () => {
  const { docker, verbs } = fakeDocker({ chromium: ours(), xpra: ours() });
  await driver(docker).shutdown();
  assert.deepEqual(verbs.filter((v) => v.startsWith('stop:')), [`stop:${CHROMIUM}`, `stop:${XPRA}`]);
});

test('⛔ shutdown() of a FOREIGN pair stops NOTHING and refuses', async () => {
  const { docker, verbs } = fakeDocker({ chromium: foreign(), xpra: foreign() });
  /** @type {any} */
  let error;
  try { await driver(docker).shutdown(); } catch (e) { error = e; }
  assert.ok(error, 'must refuse');
  assert.equal(error.exitCode, 4);
  assert.match(String(error.message), /REFUSING to stop container demo-webctl-chromium-test — it belongs to another account/);
  assert.deepEqual(verbs.filter((v) => v.startsWith('stop:')), []);
});

test('⛔ shutdown() of an unrecognised LEGACY chromium stops nothing', async () => {
  const { docker, verbs } = fakeDocker({ chromium: { binds: [FOREIGN_PROFILE] }, xpra: { binds: [] } });
  await assert.rejects(driver(docker).shutdown(), /REFUSING to stop/);
  assert.deepEqual(verbs.filter((v) => v.startsWith('stop:')), []);
});

// ── the lock-failure teardown ───────────────────────────────────────────────

test('⛔ the lock-failure teardown removes NOTHING it cannot prove ours — and says so', async () => {
  // Our own containers carry our label, so this teardown normally passes (see
  // docker-up-lock-fails-closed.test.js). Here inspect reports them foreign —
  // the name a call started is still not proof of who holds it now.
  const { docker, verbs } = fakeDocker({}, { haltRun: false });
  let started = 0;
  const run0 = docker.run;
  docker.run = async (/** @type {string[]} */ a) => (a[0] === 'inspect' && started > 0
    ? inspectPresent(a[a.length - 1], foreign()) : run0(a));
  const rd = docker.runDetached;
  docker.runDetached = async (/** @type {any} */ a) => { started++; return rd(a); };
  docker.containerRunning = async (/** @type {string} */ n) => started > 0 && n.includes('chromium');
  const lock = { ...freeLock(), acquire: async () => ({ ok: false, previous: null }) };
  /** @type {any} */
  let error;
  try { await driver(docker, { lock }).ensureRunning(); } catch (e) { error = e; }
  assert.ok(started > 0, 'premise: containers were started before the lock step');
  assert.ok(error, 'must refuse');
  assert.match(String(error.message), /profile lock NOT acquired/);
  assert.match(String(error.message), /containers were NOT removed/);
  assert.match(String(error.message), /another account/);
  assert.ok(!String(error.message).includes(FOREIGN_PROFILE));
  const afterStart = verbs.slice(verbs.findIndex((v) => v.startsWith('run:')));
  assert.ok(!afterStart.some((v) => v.startsWith('rm:')), `no rm after start; saw ${afterStart.join(', ')}`);
});
