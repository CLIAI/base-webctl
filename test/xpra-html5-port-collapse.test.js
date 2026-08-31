// xpra-html5-port-collapse.test.js — acceptance for the html5 port collapse.
//
// THE DEFECT: base derived xpraHtml5Port = xpraTcpPort + 1, then published it,
// bound it via XPRA_HTML5_BIND, listed it in the pre-flight table and
// advertised it through inspect(). Modern xpra (>=6) multiplexes the html5
// client and its websocket onto the bind-tcp listener and rejects the
// --html=host:port form, so the +1 port answered nothing. Every docker+xpra
// consumer inherited a reserved, advertised, dead port.
//
// ⭐ WHY THIS FILE DOES NOT JUST ASSERT PORT EQUALITY. The defect's whole
// signature is that the ADVERTISED port answers nothing. An equality assertion
// (`xpraHtml5Port === xpraTcpPort`) passes just as happily against a stack that
// serves nothing at all — it re-tests the arithmetic, not the claim. So the
// structural half below asserts on what is actually handed to `docker run`
// (publish list + env), and the live half performs an HTTP GET against the URL
// inspect() advertises. Per xrl4 "Gate validity": a check must be able to tell
// "served" from "never reached".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import * as realDocker from '../lib/browser-location/docker-ctl.js';

function fakeC(overrides = {}) {
  return {
    PROJECT: 'demo-webctl',
    ARTIFACT_PREFIX: 'demo-webctl-',
    IMAGE_CHROMIUM_REPO: 'demo-webctl/chromium',
    IMAGE_XPRA: 'demo-webctl/xpra-ubuntu:latest',
    DEFAULT_CDP_PORT: 4999,
    CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'www.demo.example',
    CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc',
    DOTENV_FILENAME: '.env.demo-webctl',
    DOTENV_TEMPLATE: '.env.demo-webctl.example',
    ENV_PREFIX: 'CLIAI_DEMO_WEBCTL_',
    ENV_PREFIX_LEGACY: null,
    ENV_LEGACY_SUFFIXES: [],
    ...overrides,
  };
}

function hermeticMounts(C) {
  const m = createMounts(C, { dockerfilesDir: '/df' });
  return {
    ...m,
    resolveChromiumProfile: (slug, udd) => udd || `/tmp/no-mkdir/${slug}`,
    cacheRoot: () => '/tmp/cache',
  };
}

/**
 * Run `ensureRunning()` far enough to capture the xpra container's `docker run` args,
 * then stop. Returns the recorded runDetached calls.
 * @param {object} cfg
 */
async function captureDockerRun(cfg) {
  const C = fakeC();
  /** @type {any[]} */
  const calls = [];
  // Stub every daemon-touching call ensureRunning() makes before the xpra run.
  // Names verified against the real call sites, not guessed — a stub method
  // that nothing calls would let bring-up reach the real docker CLI.
  const docker = {
    ...realDocker,
    dockerAvailable: async () => true,
    containerExists: async () => false,
    containerRunning: async () => false,
    imageExists: async () => true,
    rm: async () => ({ code: 0 }),
    volumeRm: async () => ({ code: 0 }),
    volumeCreate: async () => ({ code: 0 }),
    // Record, then fail so bring-up unwinds before touching a real daemon.
    runDetached: async (/** @type {any} */ a) => {
      calls.push(a);
      return { code: 1, stderr: 'halted by test after capture' };
    },
  };
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C), docker })
    .createDriver({ port: 4327, host: '127.0.0.1', slug: 'test', force: true, ...cfg });
  try {
    await drv.ensureRunning();
  } catch (err) {
    // Expected: we halt bring-up on purpose once the args are captured. But if
    // it unwound BEFORE the capture, the tests below would fail with a confusing
    // "undefined" — so surface the real reason instead.
    if (calls.length === 0) {
      throw new Error(
        `ensureRunning() unwound before the xpra container was started, so ` +
          `nothing was captured. Underlying error: ${err && err.message}`,
      );
    }
  }
  return calls;
}

// ── structural: the dead port must be gone from what docker is actually told ──

test('the xpra container publishes NO separate html5 port', async () => {
  const calls = await captureDockerRun({});
  assert.ok(calls.length >= 1, 'expected at least the xpra container run to be captured');
  const xpra = calls[0];

  const published = (xpra.publish || []).map((/** @type {any[]} */ p) => Number(p[2]));
  assert.deepEqual(
    published,
    [4327, 14327],
    'expected exactly CDP + xpra-tcp. A third entry (14328) is the dead html5 port ' +
      'this change removed — it was published, reserved, and answered nothing.',
  );
  assert.ok(!published.includes(14328), 'the +1 port must not be published');
});

test('XPRA_HTML5_BIND is not passed — the entrypoint must use --html=on', async () => {
  const calls = await captureDockerRun({});
  const env = calls[0].env || {};

  assert.equal(env.XPRA_TCP_BIND, '0.0.0.0:14327');
  assert.ok(
    !('XPRA_HTML5_BIND' in env),
    'XPRA_HTML5_BIND is dead config: xpra >=6 rejects --html=host:port and serves ' +
      'html5 on the bind-tcp socket. Passing it made the entrypoint advertise a ' +
      'port nothing listened on.',
  );
});

test('inspect() advertises a URL on the tcp port, and it is the one we publish', async () => {
  const C = fakeC();
  const drv = createChromiumDockerXpra(C, { mounts: hermeticMounts(C) });
  const i = drv.createDriver({ port: 4327, host: '127.0.0.1', slug: 'test' }).inspect();

  assert.equal(i.xpraHtml5Url, `http://127.0.0.1:${i.xpraTcpPort}/`);

  // Cross-check the advertised URL against what docker is actually told to
  // publish, so the two can never drift apart silently.
  const calls = await captureDockerRun({});
  const published = (calls[0].publish || []).map((/** @type {any[]} */ p) => Number(p[2]));
  const advertised = Number(new URL(i.xpraHtml5Url).port);
  assert.ok(
    published.includes(advertised),
    `inspect() advertises ${advertised} but docker publishes ${published.join(',')} — ` +
      'advertising a port we do not publish is exactly the original defect',
  );
});

// ── live acceptance: GET the URL we advertise ────────────────────────────────
//
// The only check that can distinguish "the right port" from "a port that
// answers". Requires a running docker+xpra stack, so it is opt-in — and when it
// does not run it SKIPS while naming exactly what it looked for (xrl4).

test('live: the advertised html5 URL actually serves the xpra client', async (t) => {
  const port = process.env.WEBCTL_LIVE_XPRA_TCP_PORT;
  if (!port) {
    t.skip(
      'no live stack: set WEBCTL_LIVE_XPRA_TCP_PORT=<xpraTcpPort> against a running ' +
        'docker+xpra session to run this. NOT RUN is not the same as passed — the ' +
        'structural tests above cannot tell a served port from a dead one.',
    );
    return;
  }
  const url = `http://127.0.0.1:${port}/`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    assert.fail(
      `GET ${url} failed (${err && err.message}). This is the ORIGINAL DEFECT'S ` +
        'SIGNATURE: the advertised port does not answer. Check that the container ' +
        'entrypoint passes --html=on (not --html=host:port, which xpra >=6 rejects).',
    );
  }
  assert.equal(res.status, 200, `GET ${url} returned ${res.status}`);
  const body = await res.text();
  assert.match(
    body,
    /xpra/i,
    `${url} answered but does not look like the xpra html5 client`,
  );
});
