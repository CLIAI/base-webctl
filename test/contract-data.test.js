// contract-data.test.js — the published contracts must match the DRIVER.
//
// ⛔ THE HAZARD THIS SUITE EXISTS FOR. base now publishes
// XPRA_CONTAINER_ENV_CONTRACT and TEARDOWN_CONTRACT as data, so consumers stop
// re-deriving them from comments. But a published constant can DRIFT from the
// code it describes — which would make base's own file the second source of
// truth it was shipped to eliminate, and a consumer asserting against it would
// be confidently wrong.
//
// ⭐ So the driver's ACTUAL behaviour is the ground truth here, exactly as it is
// for consumers: inject a fake docker, capture the real `runDetached` args, and
// compare the captured env against the published contract. Never grep the
// source — a grep for XPRA_HTML5_BIND in the driver matches the comments saying
// it is deliberately NOT set, and returns the negation of the truth. (A sibling
// lane nearly published that inversion.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  createChromiumDockerXpra,
  XPRA_CONTAINER_ENV_CONTRACT,
  TEARDOWN_CONTRACT,
  CONTAINER_LIFECYCLE_CONTRACT,
} from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import * as realDocker from '../lib/browser-location/docker-ctl.js';

const C = {
  PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
  IMAGE_CHROMIUM_REPO: 'demo/chromium', IMAGE_XPRA: 'demo/xpra:latest',
  DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
  ZOOM_DEFAULT_HOST: 'demo.example', CONFIG_FILE_PROJECT: 'demo.config.jsonc',
  DOTENV_FILENAME: '.env.demo', DOTENV_TEMPLATE: '.env.demo.example',
  ENV_PREFIX: 'DEMO_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
};

/**
 * ⛔ RUN A BODY UNDER A THROWAWAY $HOME. cacheRoot() is `legacyHomeOnly` and
 * ignores $XDG_CACHE_HOME, so $HOME is the ONLY lever — and a `cacheRoot`
 * option passed to createMounts is silently not honoured, which is how an
 * earlier draft of this file came to assert against the real ~/.cache.
 *
 * ⚠ EVERY test touching profile paths needs this, not just the purity one. The
 * pollution that exposed it came from `describeProfileResolution` — a PURE
 * predicate — because if purity ever breaks, every caller of it starts writing
 * to the real cache. That blast radius is the reason the guard is file-wide.
 * @param {(m: any) => void} body
 */
function underTempHome(body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-hermetic-'));
  const realHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    body({ tmp, mounts: createMounts(C, { dockerfilesDir: '/df' }) });
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function hermeticMounts() {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  // ⚠ BOTH resolvers are stubbed, consistently. Stubbing only
  // resolveChromiumProfile leaves profilePathFor returning the REAL cache path,
  // and the profile LOCK then creates it under ~/.cache during a unit run.
  const fake = (/** @type {string} */ s, /** @type {string} */ u) => u || `/tmp/no-mkdir/${s}`;
  return { ...m, resolveChromiumProfile: fake, profilePathFor: fake, cacheRoot: () => '/tmp/cache' };
}

/** Bring a stack up against a fake docker and return the captured run args. */
async function captureDockerRun() {
  /** @type {any[]} */
  const calls = [];
  const docker = {
    ...realDocker,
    dockerAvailable: async () => true,
    containerExists: async () => false,
    containerRunning: async (/** @type {string} */ n) => n.includes('chromium'),
    imageExists: async () => true,
    rm: async () => ({ code: 0 }),
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    exec: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runDetached: async (/** @type {any} */ a) => { calls.push(a); return { code: 0, stderr: '' }; },
  };
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(), docker })
    .createDriver({
      port: 4427, host: '127.0.0.1', slug: 'test', force: true,
      containerEnv: { LWC_CDP_PORT: null }, // portless: no CDP poll against a real port
    });
  try { await drv.ensureRunning(); } catch { /* the stub cannot satisfy everything */ }
  return calls;
}

test('⭐ the published env contract matches what the driver ACTUALLY passes', async () => {
  const calls = await captureDockerRun();
  const xpra = calls.find((c) => String(c.name).includes('xpra'));
  assert.ok(xpra, 'the xpra container must have been launched');
  const env = xpra.env || {};

  for (const k of XPRA_CONTAINER_ENV_CONTRACT.required) {
    assert.ok(k in env,
      `contract says ${k} is REQUIRED, but the driver does not pass it — the `
      + 'published data has drifted from the code it describes');
  }
  for (const k of XPRA_CONTAINER_ENV_CONTRACT.forbidden) {
    assert.ok(!(k in env),
      `contract says ${k} is FORBIDDEN (since ${XPRA_CONTAINER_ENV_CONTRACT.since}), `
      + 'but the driver passes it');
  }
  // Literal, never `C.PORT_OFFSET_XPRA_TCP + cdp`: an assertion that reads its
  // expectation from the artifact under test cannot detect that artifact lying
  // consistently. (Demonstrated by linkedin-webctl with a base sabotaged to lie
  // about the derivation AND the offset so the two agree.)
  assert.equal(env.XPRA_TCP_BIND, '0.0.0.0:14427');
});

test('`forbidden` is a REAL list, not the complement of `required`', () => {
  // "Not required" and "must not be set" are different claims, and only the
  // second catches an entrypoint still consuming a variable base stopped
  // setting. A derived complement would be empty here and prove nothing.
  assert.ok(XPRA_CONTAINER_ENV_CONTRACT.forbidden.length > 0);
  assert.ok(XPRA_CONTAINER_ENV_CONTRACT.forbidden.includes('XPRA_HTML5_BIND'));
  for (const k of XPRA_CONTAINER_ENV_CONTRACT.forbidden) {
    assert.ok(!XPRA_CONTAINER_ENV_CONTRACT.required.includes(k));
  }
  assert.ok(Object.isFrozen(XPRA_CONTAINER_ENV_CONTRACT));
});

test('⛔ TEARDOWN_CONTRACT matches what shutdown() ACTUALLY calls', async () => {
  // ⚠ THIS TEST PREVIOUSLY ASSERTED THE CONSTANT AGAINST ITSELF. It checked
  // `removes === []` and never called shutdown(), so adding docker.rm() to
  // shutdown left it GREEN — the drift this file exists to prevent, in the one
  // contract whose whole content is a claim about what a verb does NOT do.
  // Right and wrong gave the same answer, which looks like coverage and is not.
  /** @type {string[]} */
  const verbs = [];
  const docker = {
    ...realDocker,
    dockerAvailable: async () => true,
    containerExists: async () => true,
    containerRunning: async () => true,
    imageExists: async () => true,
    stop: async (/** @type {string} */ n) => { verbs.push(`stop:${n}`); return { code: 0 }; },
    rm: async (/** @type {string} */ n) => { verbs.push(`rm:${n}`); return { code: 0 }; },
    volumeRm: async (/** @type {string} */ n) => { verbs.push(`volumeRm:${n}`); return { code: 0 }; },
    networkRm: async (/** @type {string} */ n) => { verbs.push(`networkRm:${n}`); return { code: 0 }; },
  };
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(), docker })
    .createDriver({ port: 4427, host: '127.0.0.1', slug: 'test', force: true });
  await drv.shutdown();

  assert.ok(verbs.some((v) => v.startsWith('stop:')), `shutdown() must stop; saw ${verbs.join(', ')}`);
  for (const forbidden of ['rm:', 'volumeRm:', 'networkRm:']) {
    assert.ok(!verbs.some((v) => v.startsWith(forbidden)),
      `TEARDOWN_CONTRACT.removes is [] but shutdown() called ${forbidden} `
      + `(saw: ${verbs.join(', ')}). Either the verb changed or the contract is stale.`);
  }

  assert.deepEqual(TEARDOWN_CONTRACT.removes, []);
  assert.ok(TEARDOWN_CONTRACT.keeps.some((k) => k.key === 'containers'),
    'containers must be named in `keeps` — omitting them is the defect this records');
  assert.ok(TEARDOWN_CONTRACT.consequences.some((c) => /volume/i.test(c)),
    'the volume consequence must be stated, not left to be discovered');
});

test('⭐ profilePathFor is PURE — asking does not create', () => {
  // The control fetlife-webctl asked for: restoring resolveChromiumProfile() in
  // a query path must fail here. A guard written to avoid touching an
  // authenticated profile must not reach toward that profile's path to answer.
  // ⚠ HERMETIC VIA $HOME, not via a cacheRoot option. cacheRoot() is
  // `legacyHomeOnly` and deliberately ignores $XDG_CACHE_HOME (honouring it
  // would relocate existing profiles on upgrade, and a relocated profile is an
  // EMPTY one). An earlier draft of this test passed a cacheRoot option that is
  // not honoured, so it asserted non-existence under the REAL ~/.cache and
  // passed only because nothing had created that path yet — it polluted the
  // real cache the moment the control broke purity.
  underTempHome(({ tmp, mounts: m }) => {
    const explicit = path.join(tmp, 'never-created-explicit');

    const p1 = m.profilePathFor('some-slug', null);
    const p2 = m.profilePathFor('some-slug', explicit);
    assert.equal(p2, explicit, 'an explicit userDataDir wins over the slug');
    assert.ok(p1.startsWith(tmp),
      `the test is not hermetic: ${p1} is outside the temp HOME, so a purity `
      + 'failure would write to the real cache');

    assert.equal(fs.existsSync(p1), false, `profilePathFor CREATED ${p1}`);
    assert.equal(fs.existsSync(explicit), false, `profilePathFor CREATED ${explicit}`);
  });
});

test('⭐ describeProfileResolution names the slug/profile footgun, and only it', () => {
  underTempHome(({ mounts: m }) => {
  // THE DANGEROUS COMBINATION: a throwaway slug that will not isolate.
  const bad = m.describeProfileResolution('qa-throwaway', '~/real/authenticated/profile');
  assert.equal(bad.source, 'explicit-userDataDir');
  assert.equal(bad.isolatedBySlug, false);
  assert.equal(bad.warning.kind, 'isolated-but-not-by-slug');

  // Not a warning: no explicit dir, so the slug genuinely isolates.
  const derived = m.describeProfileResolution('qa-throwaway', null);
  assert.equal(derived.source, 'derived-from-slug');
  assert.equal(derived.isolatedBySlug, true);
  assert.equal(derived.warning, null);

  // Not a warning: explicit dir on the DEFAULT slug is the ordinary configured
  // case — nobody asked for isolation, so nothing was denied.
  const plain = m.describeProfileResolution('default', '~/real/profile');
  assert.equal(plain.warning, null, 'warning on the ordinary case would be noise');
  });
});

test('⛔ SAFE and DANGEROUS must not render identically', () => {
  // v0.11.0 shipped with `isolatedBySlug` alone, and it is FALSE for both:
  //
  //   slug 'qa' + userDataDir '/tmp/isolated'        -> a fine isolated bring-up
  //   slug 'qa' + userDataDir <the DEFAULT profile>  -> a throwaway-named
  //                                                     container mounting the
  //                                                     authenticated profile
  //
  // A consumer branching on that boolean — the obvious use — got the same
  // answer for both. The field answers "did the SLUG isolate?" while a bring-up
  // guard asks "will this touch the default profile?", and they diverge exactly
  // where it matters. This test exists so they cannot collapse again.
  underTempHome(({ mounts: m }) => {
    const defaultProfile = m.profilePathFor('default', null);

    const safe = m.describeProfileResolution('qa', '/tmp/isolated-profile');
    const danger = m.describeProfileResolution('qa', defaultProfile);

    assert.equal(safe.isDefaultProfile, false);
    assert.equal(danger.isDefaultProfile, true,
      'resolving to the default profile is THE safety question and must be its own field');

    // ⛔ Branch on `kind`, never on prose, and never on `warning !== null` —
    // which is TRUE for both and would refuse the safe configuration.
    assert.notEqual(safe.warning.kind, danger.warning.kind,
      'a safe isolated bring-up and one mounting the default profile must not '
      + 'produce identical output — that is the defect this test pins');
    assert.equal(danger.warning.kind, 'default-profile-under-throwaway-slug');
    assert.equal(safe.warning.kind, 'isolated-but-not-by-slug');
    assert.ok(safe.warning !== null && danger.warning !== null,
      'both warn, so `warning !== null` cannot be the branch — that is the point');

    // ⚠ And the narrow field stays narrow: both are "not isolated BY the slug",
    // which is true and is NOT a safety signal. Asserted so nobody later
    // "fixes" isolatedBySlug into a safety flag and reintroduces the conflation
    // from the other side.
    assert.equal(safe.isolatedBySlug, false);
    assert.equal(danger.isolatedBySlug, false);
  });
});

test('⛔ no --restart reaches docker — asserted at the ARGV, not at a stub', async () => {
  // ⛔ AN EARLIER VERSION OF THIS TEST COULD NOT FAIL. It inspected the opts
  // object handed to a STUBBED `runDetached` — but `--restart` would be added
  // INSIDE runDetached, in the function the stub replaces. Adding
  // `--restart unless-stopped` to docker-ctl left it green. An assertion one
  // layer above the code it judges is exactly the vacuous green this file was
  // written to prevent, reproduced while writing it.
  //
  // ⇒ So this patches `child_process.spawn`, which docker-ctl imports
  // indirectly FOR THIS PURPOSE (see its header), and reads the real argv.
  const cp = (await import('node:child_process')).default;
  const realSpawn = cp.spawn;
  /** @type {string[][]} */
  const argvs = [];
  // @ts-ignore - deliberate monkey-patch, restored in `finally`
  cp.spawn = (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    argvs.push(args);
    const noop = { on: () => {} };
    return { stdout: noop, stderr: noop, kill: () => {},
      on: (/** @type {string} */ ev, /** @type {Function} */ fn) => {
        if (ev === 'close') setTimeout(() => fn(0), 0);
      } };
  };
  try {
    const { runDetached } = await import('../lib/browser-location/docker-ctl.js');
    await runDetached({ name: 'demo-webctl-probe', image: 'demo/chromium' });
  } finally {
    cp.spawn = realSpawn;
  }

  assert.equal(argvs.length, 1, 'the real runDetached must have reached spawn');
  const argv = argvs[0];
  assert.ok(argv.includes('run') && argv.includes('-d'), `unexpected argv: ${argv.join(' ')}`);
  assert.ok(!argv.includes('--restart'),
    `a restart policy reached docker (${argv.join(' ')}), but `
    + 'CONTAINER_LIFECYCLE_CONTRACT.restartPolicy is null. If this is intended, '
    + 'the argument about authenticated browsers coming up unattended has to be '
    + 'had first — see the contract comment.');

  assert.equal(CONTAINER_LIFECYCLE_CONTRACT.restartPolicy, null);
  assert.equal(CONTAINER_LIFECYCLE_CONTRACT.survivesReboot, false);
});
