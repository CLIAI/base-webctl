// integration-owner-channels.test.js — I1–I10 (gvlx §11): gvlx's measurements, made
// executable against THROWAWAY containers from a consumer's own images, driven by the
// real driver in `channels: 'owner-only'`.
//
// OPT-IN. Skipped unless both are set (and docker answers):
//   WEBCTL_IT_XPRA_IMAGE      e.g. <tool>-webctl/xpra-ubuntu:latest
//   WEBCTL_IT_CHROMIUM_IMAGE  e.g. <tool>-webctl/chromium-debian:latest
//
// ⛔ Hard rules, kept by construction:
//   * every container, volume and dir is THIS run's: artifact prefix
//     `webctl-it-p<pid>-`, temp state/profile/cache roots — removed by EXACT name;
//     nothing is pruned, no existing container is touched;
//   * nothing connects to a port this file did not open: ports are ephemeral loopback
//     ports verified free here, and the bridge address is read from the throwaway's
//     own `docker inspect`;
//   * "another user" is a throwaway client container with `--user 65534`.
//   * ⛔ NEVER the host's own xpra client. Without a password file it opens a GUI
//     password prompt on whatever desktop the shell inherits — it did, on the
//     operator's screen, 2026-10-13. Every xpra client here runs in a throwaway
//     container with no display.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { xpraSpawnGuard, displayless } from './helpers/no-real-display.mjs';
import { createChromiumDockerXpra } from '../lib/browser-location/chromium-docker-xpra.js';
import * as dockerCtl from '../lib/browser-location/docker-ctl.js';
import { createMounts } from '../lib/browser-location/mounts.js';
import { rotateSecret } from '../lib/browser-location/owner-channels.js';
import { getVersion } from '../lib/cdp-client.js';

const XPRA_IMAGE = process.env.WEBCTL_IT_XPRA_IMAGE || '';
const CHROMIUM_IMAGE = process.env.WEBCTL_IT_CHROMIUM_IMAGE || '';
const PREFIX = `webctl-it-p${process.pid}-`;
const OTHER = '65534:65534';
/** Every container THIS file starts itself is capped (a shared host's limits). */
const CAPS = ['--cpus', '1', '--memory', '1g', '--pids-limit', '512'];
/**
 * …and so is the driver's own pair, through its injectable docker-ctl (TEST-ONLY: the product sets no caps). Each
 * `runDetached` gains them, and nothing else changes.
 */
const PAIR_CAPS = ['--cpus', '2', '--memory', '4g', '--memory-swap', '4g', '--pids-limit', '512'];
const cappedDocker = { ...dockerCtl, runDetached: (/** @type {any} */ o) => dockerCtl.runDetached({ ...o, extra: [...PAIR_CAPS, ...((o && o.extra) || [])] }) };
/**
 * What a shared host ALLOWS beyond "no published port, no host network" (its admin's call, named per run):
 *   WEBCTL_IT_HOST_NETWORK=1  short-lived uid-65534 clients on the host network (I4; xpra info over TCP: I3, I5)
 *   WEBCTL_IT_PUBLISH=1       loopback publishes on ephemeral ports this run verified free (I3/I5 html5, the raw arm)
 * Without one, the arms that need it SKIP, saying which — they are never quietly passed.
 */
const HOST_NET = process.env.WEBCTL_IT_HOST_NETWORK === '1';
const PUBLISH = process.env.WEBCTL_IT_PUBLISH === '1';
const NEEDS_HOST_NET = 'needs WEBCTL_IT_HOST_NETWORK=1 (a short-lived client on the host network) — this host has not allowed it';
const NEEDS_PUBLISH = 'needs WEBCTL_IT_PUBLISH=1 (a loopback publish) — this host has not allowed it';

/** @param {string[]} args @param {number} [timeoutMs] */
function docker(args, timeoutMs = 60000, input = '') {
  const env = displayless();
  xpraSpawnGuard(['docker', ...args], env); // RULE ZERO: never with a display in reach
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, env, input });
  return { code: r.status === null ? -1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** Why this file cannot run here, or null. */
function unavailable() {
  if (!XPRA_IMAGE || !CHROMIUM_IMAGE) return 'SKIP: set WEBCTL_IT_XPRA_IMAGE and WEBCTL_IT_CHROMIUM_IMAGE to run the integration arms';
  if (docker(['version', '--format', '{{.Server.Version}}'], 15000).code !== 0) return 'SKIP: docker does not answer';
  for (const i of [XPRA_IMAGE, CHROMIUM_IMAGE]) {
    if (docker(['image', 'inspect', i], 15000).code !== 0) return `SKIP: image ${i} is not present`;
  }
  if (!/^(.+)-(ubuntu|debian|arch):latest$/.test(CHROMIUM_IMAGE)) return 'SKIP: WEBCTL_IT_CHROMIUM_IMAGE must be <repo>-<ubuntu|debian|arch>:latest';
  return null;
}
const SKIP = unavailable();

/** A loopback port free right now — bound by THIS process, then released. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = /** @type {any} */ (s.address()).port; s.close(() => resolve(p)); });
  });
}

/**
 * Bring up a throwaway pair through the REAL driver, run `fn`, and remove every
 * artifact by exact name — whatever happens.
 * @param {string} slug @param {any} cfgExtra @param {(ctx: any) => Promise<void>} fn
 */
async function withPair(slug, cfgExtra, fn) {
  const m = /^(.+)-(ubuntu|debian|arch):latest$/.exec(CHROMIUM_IMAGE);
  const C = {
    PROJECT: 'webctl-it', ARTIFACT_PREFIX: PREFIX,
    IMAGE_CHROMIUM_REPO: /** @type {any} */ (m)[1], IMAGE_XPRA: XPRA_IMAGE,
    DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: `webctl-it-p${process.pid}`,
    ZOOM_DEFAULT_HOST: 'it.example', CONFIG_FILE_PROJECT: 'it.config.jsonc',
    DOTENV_FILENAME: '.env.it', DOTENV_TEMPLATE: '.env.it.example',
    ENV_PREFIX: 'WEBCTL_IT_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-it-'));
  const stateRoot = path.join(root, 'state');
  const cacheRoot = path.join(root, 'cache');
  const udd = path.join(root, 'prof', 'chromium');
  const real = createMounts(C, { dockerfilesDir: '/nonexistent-dockerfiles' });
  const mounts = { ...real, cacheRoot: () => cacheRoot };
  const port = await freePort();
  const xpraTcpPort = await freePort(); // explicit and verified free — never a derived guess
  const logs = /** @type {string[]} */ ([]);
  const logger = { info: (/** @type {string} */ s) => logs.push(s), warn: (/** @type {string} */ s) => logs.push(s), debug: () => {} };
  const drv = createChromiumDockerXpra(C, { mounts, stateRoot, docker: cappedDocker })
    .createDriver({ port, xpraTcpPort, host: '127.0.0.1', slug, base: /** @type {any} */ (m)[2], userDataDir: udd, logger, ...cfgExtra });
  const N = drv.inspect().names;
  try {
    const r = await drv.ensureRunning();
    const ip = docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', N.xpraContainer]).out.trim();
    await fn({ drv, r, N, ip, root, stateRoot, udd, port, logs });
  } finally {
    for (const n of [N.cdpRelayContainer, N.chromiumContainer, N.xpraContainer]) docker(['rm', '-f', n]);
    docker(['volume', 'rm', N.xpraSocketVolume]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Run a throwaway client container as ANOTHER uid. @param {string[]} dockerArgs @param {string} image @param {string} sh */
function asOther(dockerArgs, image, sh) {
  const name = `${PREFIX}client-${Math.random().toString(16).slice(2, 8)}`;
  // ⛔ a probe on the HOST network (a shared host's allowance): no capability, a read-only root, no mount, ≤ 60 s
  const hostNet = dockerArgs.join(' ').includes('--network host');
  if (hostNet && dockerArgs.includes('-v')) throw new Error('a host-network probe carries no mount');
  const lock = hostNet ? ['--cap-drop', 'ALL', '--read-only'] : [];
  try {
    return docker(['run', '--rm', '--name', name, ...CAPS, ...lock, '--user', OTHER, ...dockerArgs, '--entrypoint', 'sh', image, '-c', sh], hostNet ? 60000 : 90000);
  } finally { docker(['rm', '-f', name]); }
}

/**
 * `xpra info` from a throwaway client container of the xpra image. A socket target: as US (the image's uid, which
 * the driver requires to be the owner's), with no network and this run's temp root mounted at the same path. A
 * TCP/ws target: a host-network probe as uid 65534 (below). Never the host's own xpra client: it may open a GUI prompt on the
 * desktop, and its behaviour is not this file's to depend on.
 * @param {string} root @param {string} target @param {string} [passwordFile]
 */
function xpraInfoAsUs(root, target, passwordFile) {
  const name = `${PREFIX}xinfo-${Math.random().toString(16).slice(2, 8)}`;
  const grep = "2>&1 | grep -E '^clients=|authentication failed|denied|refused' | head -3";
  try {
    if (/^socket:/.test(target)) {
      // a socket target: as US (peercred), NO network, this run's temp root mounted at its own path
      const pf = passwordFile ? ` --password-file=${passwordFile}` : '';
      const r = docker(['run', '--rm', '--name', name, ...CAPS, '--network', 'none', '-v', `${root}:${root}`,
        '--entrypoint', 'sh', XPRA_IMAGE, '-c', `timeout 20 xpra info ${target}${pf} </dev/null ${grep}`], 90000);
      return r.out + r.err;
    }
    // a TCP/ws target: a HOST-NETWORK probe (an allowance), as uid 65534 — TCP auth is the password, not who asks —
    // with no capability, a read-only root, NO mount: the password arrives on STDIN into a tmpfs (never argv), ≤ 60 s
    if (!HOST_NET) throw new Error(`xpraInfoAsUs(${target}): ${NEEDS_HOST_NET}`);
    const pw = passwordFile ? fs.readFileSync(passwordFile, 'utf8') : '';
    const pf = passwordFile ? ' --password-file=/tmp/p' : '';
    const r = docker(['run', '--rm', '-i', '--name', name, ...CAPS, '--network', 'host', '--user', OTHER, '--cap-drop', 'ALL', '--read-only',
      '--tmpfs', '/tmp:size=1m,mode=1777', '-e', 'HOME=/tmp', '-e', 'XDG_RUNTIME_DIR=/tmp', '--entrypoint', 'sh', XPRA_IMAGE, '-c',
      `umask 077; cat > /tmp/p; timeout 20 xpra info ${target}${pf} </dev/null ${grep}`], 60000, pw);
    return r.out + r.err;
  } finally { docker(['rm', '-f', name]); }
}

test('the artifact prefix is THIS process\'s and can never name a fleet container (always runs)', () => {
  assert.match(PREFIX, /^webctl-it-p\d+-$/);
  for (const fleet of ['webctl-', 'linkedin-webctl-', 'chatgpt-webctl-']) {
    assert.ok(!(`${fleet}u1-xpra-default`).startsWith(PREFIX), 'no fleet name starts with this prefix');
  }
});

test('integration arms run here, or say exactly why not', { skip: SKIP || false }, () => {
  // The non-vacuous anchor: when the arms run, this file is not "zero assertions".
  assert.ok(XPRA_IMAGE && CHROMIUM_IMAGE);
});

test('I1 + I2 + I6 + I4 + I8 + I9 + I10 — one owner-only pair (html5 off)', { skip: SKIP || false, timeout: 300000 }, async (t) => {
  await withPair('oo', { channels: 'owner-only' }, async ({ drv, r, N, ip, udd, root }) => {
    const i = drv.inspect();
    const chan = /** @type {string} */ (i.channelDir);

    // I6: CDP over the socket, through base's own client …
    assert.match((await getVersion(r.endpoint)).Browser, /Chrome\//);
    // … and another uid is refused at the 0700 dir.
    const c6 = asOther(['--network', 'none', '-v', `${chan}:/run/webctl`], CHROMIUM_IMAGE,
      'curl -sS --unix-socket /run/webctl/cdp.sock http://127.0.0.1:9222/json/version 2>&1 | head -2');
    assert.doesNotMatch(c6.out, /webSocketDebuggerUrl/, 'another uid must not reach CDP');
    assert.match(c6.out, /Could not connect|Failed to connect|Permission denied/, 'the client ran and was refused');

    // I1: another uid via the mounted dir ⇒ Permission denied; control: the owner ⇒ a session.
    const c1 = asOther(['--network', 'none', '-v', `${chan}:/run/webctl`], XPRA_IMAGE,
      'timeout 20 xpra info socket:///run/webctl/xpra.sock </dev/null 2>&1 | tail -3');
    assert.match(c1.out, /Permission denied/);
    assert.match(xpraInfoAsUs(root, `socket://${i.xpra.socket}`), /^clients=/m, 'control: the owner gets a session');

    // I2: dir AND socket opened to the world ⇒ peercred still refuses (layer two alone).
    fs.chmodSync(chan, 0o755); fs.chmodSync(i.xpra.socket, 0o666);
    try {
      const c2 = asOther(['--network', 'none', '-v', `${chan}:/run/webctl`], XPRA_IMAGE,
        'timeout 20 xpra info socket:///run/webctl/xpra.sock </dev/null 2>&1 | tail -3');
      assert.match(c2.out, /authentication failed|peercred/);
    } finally { fs.chmodSync(i.xpra.socket, 0o600); fs.chmodSync(chan, 0o700); }

    // I4: another uid from the HOST netns, at the bridge address read from docker inspect.
    assert.ok(ip, 'the throwaway has a bridge address');
    if (!HOST_NET) { t.diagnostic(`I4 NOT RUN: ${NEEDS_HOST_NET}`); } else {
    const c4 = asOther(['--network', 'host'], CHROMIUM_IMAGE,
      `curl -sS -m 5 http://${ip}:9222/json/version 2>&1 | head -1; `
      + `curl -sS -m 5 http://${ip}:${i.xpraTcpPort}/ 2>&1 | head -1`);
    assert.doesNotMatch(c4.out, /webSocketDebuggerUrl|websockets client/, c4.out);
    // ⛔ and the client RAN: both connects were refused, not silently skipped
    assert.equal((c4.out.match(/^curl: \(7\)/gm) || []).length, 2, c4.out);
    }

    // I8: the pair's own listener inventory — nothing non-loopback.
    const tcp = docker(['exec', N.xpraContainer, 'sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6']).out;
    const listen = tcp.split('\n').filter((l) => / 0A /.test(l)).map((l) => l.trim().split(/\s+/)[1]);
    const nonLoop = listen.filter((a) => !/^0100007F:/.test(a) && !/^0{24}01000000:/i.test(a));
    assert.deepEqual(nonLoop, [], `non-loopback listeners: ${nonLoop.join(', ')}`);
    assert.ok(listen.length >= 2, 'the inventory found the listeners (not vacuous)');

    // I9: the X11 volume sits under docker's data root, which the host user cannot traverse …
    const mp = docker(['volume', 'inspect', '-f', '{{.Mountpoint}}', N.xpraSocketVolume]).out.trim();
    assert.throws(() => fs.statSync(mp), /EACCES|EPERM/);
    // … while a client that HAS the volume (docker-group power) is admitted: X is not an auth layer.
    const c9 = asOther(['--network', 'none', '-v', `${N.xpraSocketVolume}:/tmp/.X11-unix`], XPRA_IMAGE,
      'xdpyinfo -display :99 2>&1 | head -1');
    assert.match(c9.out, /name of display/);

    // I10: tighten the profile and channel dirs 0755 → 0700 UNDER the running pair.
    fs.chmodSync(udd, 0o755); fs.chmodSync(udd, 0o700);
    fs.chmodSync(chan, 0o755); fs.chmodSync(chan, 0o700);
    assert.match((await getVersion(r.endpoint)).Browser, /Chrome\//);
    assert.match(xpraInfoAsUs(root, `socket://${i.xpra.socket}`), /^clients=/m);

    // and the read-only verdict on the live pair
    assert.equal((await drv.exposure()).level, 'owner-only');
  });
});

test('I3 + I5 — html5 on: password on the published port AND the bridge address; rotation', { skip: SKIP || (!PUBLISH && NEEDS_PUBLISH) || (!HOST_NET && NEEDS_HOST_NET) || false, timeout: 300000 }, async () => {
  await withPair('h5', { channels: 'owner-only', html5: true }, async ({ drv, ip, root }) => {
    const i = drv.inspect();
    const secretDir = path.join(path.dirname(path.dirname(/** @type {string} */ (i.channelDir))), 'auth', path.basename(/** @type {string} */ (i.channelDir)));
    const pass = path.join(secretDir, 'xpra.pass');
    const wrong = path.join(root, 'wrong.pass');
    fs.writeFileSync(wrong, 'wrong', { mode: 0o600 });
    for (const target of [`tcp://127.0.0.1:${i.xpraTcpPort}/`, `tcp://${ip}:${i.xpraTcpPort}/`, `ws://127.0.0.1:${i.xpraTcpPort}/`]) {
      assert.doesNotMatch(xpraInfoAsUs(root, target), /^clients=/m, `${target}: no password ⇒ no session`);
      assert.match(xpraInfoAsUs(root, target, wrong), /authentication failed/, `${target}: wrong`);
      assert.match(xpraInfoAsUs(root, target, pass), /^clients=/m, `${target}: right (control)`);
    }
    // I5: rotate by rename — the DIRECTORY is mounted, so it applies with no restart.
    const old = path.join(root, 'old.pass');
    fs.copyFileSync(pass, old);
    rotateSecret(secretDir);
    const t = `tcp://127.0.0.1:${i.xpraTcpPort}/`;
    assert.match(xpraInfoAsUs(root, t, pass), /^clients=/m, 'the new password is admitted');
    assert.match(xpraInfoAsUs(root, t, old), /authentication failed/, 'the old one is refused');
  });
});

test('I5 control + I7 + I4/I8 control — raw throwaways: the traps the driver avoids', { skip: SKIP || (!PUBLISH && NEEDS_PUBLISH) || (!HOST_NET && NEEDS_HOST_NET) || false, timeout: 300000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-it-raw-'));
  const names = /** @type {string[]} */ ([]);
  try {
    // I5 control: a SINGLE-FILE secret mount keeps the OLD inode after a rename-rotation.
    const sec = path.join(root, 'sec'); fs.mkdirSync(sec, { mode: 0o700 });
    fs.writeFileSync(path.join(sec, 'p'), 'first-password-0123456789abcdef', { mode: 0o600 });
    const x = `${PREFIX}raw-xpra`; names.push(x);
    const port = await freePort();
    assert.equal(docker(['run', '-d', '--name', x, ...CAPS, '-p', `127.0.0.1:${port}:${port}`, '-v', `${path.join(sec, 'p')}:/s/p:ro`,
      '--entrypoint', 'xpra', XPRA_IMAGE, 'start', ':95', '--daemon=no', '--xvfb=Xvfb -screen 0 640x480x24 -nolisten tcp -noreset',
      `--bind-tcp=0.0.0.0:${port},auth=file,filename=/s/p`, '--html=on', '--pulseaudio=no', '--mdns=no',
      '--notifications=no', '--bell=no', '--webcam=no', '--printing=no']).code, 0);
    const okAt = Date.now() + 20000;
    while (Date.now() < okAt && !/^clients=/m.test(xpraInfoAsUs(root, `tcp://127.0.0.1:${port}/`, path.join(sec, 'p')))) {
      await new Promise((r) => setTimeout(r, 500));
    }
    fs.copyFileSync(path.join(sec, 'p'), path.join(root, 'old'));
    fs.writeFileSync(path.join(sec, '.t'), 'second-password-0123456789abcdef', { mode: 0o600 });
    fs.renameSync(path.join(sec, '.t'), path.join(sec, 'p'));
    assert.match(xpraInfoAsUs(root, `tcp://127.0.0.1:${port}/`, path.join(root, 'old')), /^clients=/m,
      'TRAP reproduced: the OLD password still opens a session through a single-file mount');

    // I7: an image whose uid is not the dir owner's cannot create a socket in the 0700 dir.
    const run = path.join(root, 'run'); fs.mkdirSync(run, { mode: 0o700 });
    const c7 = asOther(['--network', 'none', '-v', `${run}:/run/webctl`], CHROMIUM_IMAGE,
      'timeout 5 socat UNIX-LISTEN:/run/webctl/t.sock - 2>&1 | head -1');
    assert.match(c7.out, /Permission denied/);

    // I4/I8 control: today's CDP relay shape (no publish) IS reachable at the bridge address.
    const leg = `${PREFIX}raw-legacy`; names.push(leg);
    const prof = path.join(root, 'prof'); fs.mkdirSync(prof, { mode: 0o700 });
    assert.equal(docker(['run', '-d', '--name', leg, ...CAPS, '--shm-size', '256m', '-v', `${prof}:/home/user/prof`, '--entrypoint', 'sh', CHROMIUM_IMAGE, '-c',
      'chromium --headless=new --no-sandbox --user-data-dir=/home/user/prof --remote-debugging-port=9222 --remote-allow-origins=* about:blank 2>/dev/null & '
      + 'socat TCP-LISTEN:9333,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222,retry=30,interval=1']).code, 0);
    const lip = docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', leg]).out.trim();
    let seen = '';
    for (let k = 0; k < 20 && !/webSocketDebuggerUrl/.test(seen); k++) {
      seen = asOther(['--network', 'host'], CHROMIUM_IMAGE, `curl -sS -m 3 http://${lip}:9333/json/version 2>&1 | head -20`).out;
      if (!/webSocketDebuggerUrl/.test(seen)) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.match(seen, /webSocketDebuggerUrl/, 'control: the legacy shape answers another uid at the bridge address');
  } finally {
    for (const n of names) docker(['rm', '-f', n]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
