// isolation-docker.test.js — the docker backend's UNIT arms (ib4k §3b, §3a.5): a FAKE docker CLI records every
// invocation, so these run on any host, docker or not. The real-docker arms are isolation-docker-table.test.js.
//
// ⛔ What is judged here is what the harness ASKS the daemon for: the name, the caps, the flags that must be there
// and the ones that never may, the endpoint on every call, no prune, no env on any argv — and the refusals that
// come before any `create` (a remote endpoint, a missing image, a native addon, a symlinked bind source), and the
// reaper's bound (ruling 6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as harness from '../scripts/contract-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');
const SEAM = path.join(ROOT, 'test', 'helpers', 'isolated-with-docker.mjs');
const FAKE = path.join(ROOT, 'test', 'helpers', 'fake-docker-cli.mjs');
const ENDPOINT = 'unix:///var/run/docker.sock';
const NAME_RE = /^webctl-iso-u\d+-[a-z0-9-]{1,24}-\d+$/;

/** A scratch dir with the fake CLI behind an absolute-path wrapper (the CLI's env has no PATH). */
function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ib-docker-')));
  const bin = path.join(dir, 'docker');
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'calls.jsonl');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  return { dir, bin, log, work, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

/** @param {Record<string, string>} extra */
function env(extra = {}) {
  const e = { ...process.env, WEBCTL_ISOLATION_BACKEND: 'docker', WEBCTL_FAKE_DOCKER_RECIPE: harness.dockerRecipe().hash, ...extra };
  delete e.NODE_TEST_CONTEXT;
  delete e.DOCKER_HOST;
  delete e.DOCKER_CONTEXT;
  for (const [k, v] of Object.entries(extra)) e[k] = v;
  return e;
}

/**
 * `isolated <args>` through the seam, with the fake CLI. @param {ReturnType<typeof scratch>} s @param {string[]} args
 * @param {Record<string, string>} [extra] @param {string} [cwd]
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
function run(s, args, extra = {}, cwd = s.work) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SEAM, TOOL, s.bin, ...args], { cwd, env: env({ WEBCTL_FAKE_DOCKER_LOG: s.log, ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

/** The argv of the first call whose verb (after `-H <endpoint>`) is `verb`. @param {string[][]} calls @param {string} verb */
const callOf = (calls, verb) => calls.find((c) => c[2] === verb);

test('⭐ §3a.5: the create argv carries the owned NAME, the caps, and every flag the sandbox rests on', async () => {
  const s = scratch();
  try {
    await run(s, ['--', 'true']);
    const c = callOf(s.calls(), 'create');
    assert.ok(c, `no create was recorded: ${JSON.stringify(s.calls())}`);
    const at = (/** @type {string} */ f) => c[c.indexOf(f) + 1];
    assert.match(at('--name'), NAME_RE);
    assert.equal(at('--name'), `webctl-iso-u${process.getuid?.()}-work-${at('--name').split('-').pop()}`);
    for (const f of ['--cpus', '--memory', '--pids-limit']) assert.ok(c.includes(f), `${f} is missing`);
    assert.deepEqual([at('--cpus'), at('--memory'), at('--pids-limit')], ['2', '4g', '4096'], 'the default caps');
    for (const f of ['--rm', '--read-only']) assert.ok(c.includes(f), `${f} is missing`);
    // ⛔ no `--interactive` on create or start: the CLI would read the caller's stdin eagerly (the gate's loop lost a line)
    for (const x of s.calls()) assert.ok(!x.includes('--interactive') && !x.includes('-i'), `--interactive on: ${x.slice(0, 4).join(' ')}`);
    assert.equal(at('--network'), 'none');
    assert.equal(at('--cap-drop'), 'ALL');
    assert.equal(at('--security-opt'), 'no-new-privileges');
    assert.equal(at('--hostname'), 'webctl-isolated');
    assert.equal(at('--user'), `${process.getuid?.()}:${process.getgid?.()}`);
    assert.ok(c.some((a) => a === `type=bind,src=${s.work},dst=${s.work}`), 'the cwd is not bound writable at its own path');
    assert.ok(c.some((a) => a === `type=bind,src=${ROOT},dst=${ROOT},readonly`), 'base\'s root is not bound read-only');
    assert.ok(c.some((a) => /^type=bind,src=\/[^,]+,dst=\/run\/webctl-isolated,readonly$/.test(a)), 'no read-only channel bind');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⛔ §3a.2/§3a.5: NO forbidden flag on any call, no `prune` anywhere, and `-H <local socket>` on EVERY call', async () => {
  const s = scratch();
  try {
    await run(s, ['--', 'true']);
    const calls = s.calls();
    assert.ok(calls.length >= 4, `too few calls: ${JSON.stringify(calls)}`);
    for (const c of calls) {
      assert.deepEqual(c.slice(0, 2), ['-H', ENDPOINT], `a call without the local endpoint first: ${JSON.stringify(c)}`);
      // docker's own options only: after the image comes the command line run INSIDE (pid 1's script has a `-p`)
      const img = c[2] === 'create' ? c.findIndex((a) => /^sha256:[0-9a-f]{64}$/.test(a)) : c.length;
      const flat = c.slice(2, img).join(' ');
      assert.doesNotMatch(flat, /\bprune\b/, 'a prune');
      assert.doesNotMatch(flat, /--privileged|seccomp[=:]unconfined|apparmor[=:]unconfined|--publish|(^| )-p |--network host|--net host|--pid[= ]|--ipc[= ]|--userns[= ]|--init( |$)|docker\.sock/,
        `a forbidden flag: ${flat}`);
    }
    // removal only by EXACT id or exact name — never a filter, a pattern, or `-a`
    for (const c of calls.filter((x) => x[2] === 'rm')) {
      assert.equal(c.length, 5, `rm with more than one ref: ${JSON.stringify(c)}`);
      assert.equal(c[3], '-f');
      assert.ok(/^[0-9a-f]{64}$/.test(c[4]) || NAME_RE.test(c[4]), `rm of something not exact: ${c[4]}`);
    }
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⛔ row 11: the command\'s env is on NO argv (it travels in the channel\'s plan file) — CONTROL: the plan holds it', async () => {
  const s = scratch();
  try {
    const secret = `v-${process.pid}-${Date.now()}-secret`;
    await run(s, ['--pass-env', 'WEBCTL_ARM_SECRET', '--', 'true'], { WEBCTL_ARM_SECRET: secret, WEBCTL_ARM_OTHER: secret });
    const flat = JSON.stringify(s.calls());
    assert.ok(flat.includes('"create"'), 'no create was recorded');
    assert.doesNotMatch(flat, new RegExp(secret), 'an env value reached the docker CLI\'s argv');
    assert.doesNotMatch(flat, /(^|",")(-e|--env|--env-file)"/, 'an env flag on the CLI');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⛔ §3a.1: a planted DOCKER_HOST (remote) → REFUSED before any docker call; the value is never printed — and DOCKER_CONTEXT too', async () => {
  for (const [k, v] of [['DOCKER_HOST', 'ssh://192.0.2.1'], ['DOCKER_CONTEXT', 'remote-ctx-arm']]) {
    const s = scratch();
    try {
      const r = await run(s, ['--', 'true'], { [k]: v });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`^FAIL {2}isolated: NOT RUN: WEBCTL_ISOLATION_BACKEND pins the docker backend, which cannot be used here — docker: ${k} names`, 'm'));
      assert.doesNotMatch(r.stderr + r.stdout, new RegExp(v.replace(/[.]/g, '\\.')), 'the endpoint value is printed');
      assert.deepEqual(s.calls(), [], 'docker was called anyway');
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  }
  // CONTROL: DOCKER_HOST naming the local socket is the local daemon — not refused
  const s = scratch();
  try {
    await run(s, ['--', 'true'], { DOCKER_HOST: ENDPOINT });
    assert.ok(callOf(s.calls(), 'create'), 'the local endpoint was refused');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⛔ the daemon\'s profiles: rootless, or no seccomp → REFUSED by name before any create', async () => {
  for (const [mode, re] of [['rootless', /ROOTLESS/], ['noseccomp', /WITHOUT seccomp/]]) {
    const s = scratch();
    try {
      const r = await run(s, ['--', 'true'], { WEBCTL_FAKE_DOCKER_MODE: mode });
      assert.equal(r.status, 1);
      assert.match(r.stderr, re);
      assert.equal(callOf(s.calls(), 'create'), undefined, `${mode}: a container was created`);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  }
});

test('⛔ a missing image → REFUSED naming the build command; an image without this recipe\'s label → refused too; never a build or pull', async () => {
  for (const [mode, re] of [['noimage', /is not built here — build it once with: node <base>\/scripts\/contract-harness\.mjs isolated-image build/],
    ['badlabel', /does not carry this recipe's label/]]) {
    const s = scratch();
    try {
      const r = await run(s, ['--', 'true'], { WEBCTL_FAKE_DOCKER_MODE: mode });
      assert.equal(r.status, 1);
      assert.match(r.stderr, re);
      const verbs = s.calls().map((c) => c[2]);
      assert.ok(!verbs.some((v) => ['create', 'build', 'pull', 'run'].includes(v)), `${mode}: ${verbs.join(' ')}`);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  }
});

test('⛔ §3a.6: a native addon (*.node) in the cwd\'s node_modules → REFUSED before any create — CONTROL: a plain one is not', async () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.join(s.work, 'node_modules', 'pkg', 'build'), { recursive: true });
    fs.writeFileSync(path.join(s.work, 'node_modules', 'pkg', 'index.js'), '');
    await run(s, ['--', 'true']);
    assert.ok(callOf(s.calls(), 'create'), 'CONTROL: a plain node_modules was refused');
    fs.writeFileSync(path.join(s.work, 'node_modules', 'pkg', 'build', 'addon.node'), '');
    fs.rmSync(s.log);
    const r = await run(s, ['--', 'true']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NATIVE addon/);
    assert.equal(callOf(s.calls(), 'create'), undefined, 'a container was created');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⛔ ruling 7: a --keep or --keep-ro through a SYMLINK → REFUSED before any create, naming the option, never the path — CONTROL: the real path runs', async () => {
  const s = scratch();
  try {
    const real = path.join(s.dir, 'real-keep');
    fs.mkdirSync(real);
    const link = path.join(s.dir, 'link-keep');
    fs.symlinkSync(real, link);
    for (const opt of ['--keep', '--keep-ro']) {
      if (fs.existsSync(s.log)) fs.rmSync(s.log);
      const r = await run(s, [opt, path.join(link), '--', 'true']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`NOT RUN: ${opt} #1 passes through a SYMLINK`));
      assert.doesNotMatch(r.stderr, /link-keep|real-keep/, 'a path is printed');
      assert.equal(callOf(s.calls(), 'create'), undefined, `${opt}: a container was created`);
    }
    // a link in an ANCESTOR component counts too
    const deep = path.join(real, 'sub');
    fs.mkdirSync(deep);
    fs.rmSync(s.log);
    const d = await run(s, ['--keep', path.join(link, 'sub'), '--', 'true']);
    assert.match(d.stderr, /NOT RUN: --keep #1 passes through a SYMLINK/);
    // CONTROL
    fs.rmSync(s.log);
    await run(s, ['--keep', real, '--', 'true']);
    const c = callOf(s.calls(), 'create');
    assert.ok(c && c.includes(`type=bind,src=${real},dst=${real}`), 'CONTROL: the real path was not bound');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⭐ the caps are overridable (WEBCTL_ISOLATION_DOCKER_*), and a malformed one is REFUSED by its name, never its value', async () => {
  const s = scratch();
  try {
    await run(s, ['--', 'true'], { WEBCTL_ISOLATION_DOCKER_CPUS: '1.5', WEBCTL_ISOLATION_DOCKER_MEMORY: '2g', WEBCTL_ISOLATION_DOCKER_PIDS: '512' });
    const c = callOf(s.calls(), 'create');
    assert.ok(c);
    assert.deepEqual([c[c.indexOf('--cpus') + 1], c[c.indexOf('--memory') + 1], c[c.indexOf('--pids-limit') + 1]], ['1.5', '2g', '512']);
    fs.rmSync(s.log);
    const r = await run(s, ['--', 'true'], { WEBCTL_ISOLATION_DOCKER_MEMORY: '4g; rm -rf' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /WEBCTL_ISOLATION_DOCKER_MEMORY is malformed/);
    assert.doesNotMatch(r.stderr, /rm -rf/);
    assert.equal(callOf(s.calls(), 'create'), undefined);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⭐ selection: unshare and bwrap unavailable → docker is selected, and the verdict says why each was skipped (the LAST `; backend:`)', async () => {
  const s = scratch();
  try {
    const r = await run(s, ['--', 'true'], { WEBCTL_ISOLATION_BACKEND: '', WEBCTL_UNSHARE_BIN: '/nonexistent/unshare' });
    assert.match(r.stderr, /^isolated: home HIDDEN; .*; backend: docker \(skipped unshare: WEBCTL_UNSHARE_BIN must be an ABSOLUTE path[^\n]*; bwrap: [^\n]*\); keyring: none \(docker seccomp\); dev: \+core; machine-names: (passed|none \([^\n]*\))( — WEBCTL_ISOLATED_VERBOSE=1 lists every path)?$/m);
    assert.doesNotMatch(r.stderr, /cgroup2: nsdelegate/, 'ruling 2: the nsdelegate clause is claimed under docker');
    assert.ok(callOf(s.calls(), 'create'), 'docker was selected but nothing was created');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⛔ the start ending before the inner half reports in → FAIL, never a run; the container removed by exact id', async () => {
  const s = scratch();
  try {
    const r = await run(s, ['--', 'true']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^FAIL {2}isolated: NOT RUN: docker exited 0 before the isolated side reported in/m);
    const rm = s.calls().filter((c) => c[2] === 'rm');
    assert.ok(rm.some((c) => c[4] === 'b'.repeat(64)), `no rm -f of the exact id: ${JSON.stringify(rm)}`);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

// ── the pure parts ──────────────────────────────────────────────────────────

test('logic: dockerEndpointRefusal — local socket names pass, anything else is refused', () => {
  assert.equal(harness.dockerEndpointRefusal({}), '');
  assert.equal(harness.dockerEndpointRefusal({ DOCKER_HOST: 'unix:///var/run/docker.sock' }), '');
  assert.equal(harness.dockerEndpointRefusal({ DOCKER_HOST: 'unix:///run/docker.sock' }), '');
  assert.equal(harness.dockerEndpointRefusal({ DOCKER_CONTEXT: 'default' }), '');
  for (const h of ['ssh://192.0.2.1', 'tcp://192.0.2.1:2375', 'unix:///home/x/docker.sock']) assert.match(harness.dockerEndpointRefusal({ DOCKER_HOST: h }), /DOCKER_HOST names/);
  assert.match(harness.dockerEndpointRefusal({ DOCKER_CONTEXT: 'x' }), /DOCKER_CONTEXT names/);
});

test('logic: dockerName — `webctl-iso-u<uid>-<lane>-<pid>`, the lane sanitised and bounded', () => {
  const was = process.env.WEBCTL_LANE;
  try {
    process.env.WEBCTL_LANE = 'My Lane/../X__y!!-with-a-very-long-suffix-indeed';
    const n = harness.dockerName(1234);
    assert.match(n, NAME_RE);
    assert.ok(n.startsWith('webctl-iso-u1234-my-lane-x-y-with-a-very'), n);
    process.env.WEBCTL_LANE = '!!!';
    assert.match(harness.dockerName(1), /^webctl-iso-u1-run-\d+$/);
  } finally { if (was === undefined) delete process.env.WEBCTL_LANE; else process.env.WEBCTL_LANE = was; }
});

test('⛔ ruling 1: dockerDevGaps refuses ANY extra /dev name but `core` — CONTROL: the same dir without it has no such gap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dev-'));
  try {
    for (const n of harness.MINIMAL_DEV) fs.writeFileSync(path.join(dir, n), '');
    const without = harness.dockerDevGaps(dir);
    assert.ok(!without.some((g) => /beyond the minimal set/.test(g)), without.join('; '));
    fs.writeFileSync(path.join(dir, 'uinput'), '');
    const planted = harness.dockerDevGaps(dir);
    assert.ok(planted.some((g) => /1 entry in .* beyond the minimal set and `core`/.test(g)), planted.join('; '));
    // `core` as anything but a link to /proc/kcore is a gap, not the accepted extra
    fs.rmSync(path.join(dir, 'uinput'));
    fs.symlinkSync('/etc/passwd', path.join(dir, 'core'));
    assert.ok(harness.dockerDevGaps(dir).some((g) => /core \(not a link to a masked \/proc\/kcore\)/.test(g)));
    // and a /dev the command can create in is a gap
    assert.ok(harness.dockerDevGaps(dir).some((g) => /WRITABLE by the command/.test(g)), 'a writable dev dir passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('logic: dockerCreateArgv — what is NOT there is the contract too', () => {
  const a = harness.dockerCreateArgv({ name: 'webctl-iso-u1-x-2', uid: 1, gid: 1, limits: ['--cpus', '2'], binds: [{ p: '/w', rw: true }, { p: '/r', rw: false }],
    masks: ['/w/s.sock'], channel: '/c', image: 'sha256:x', inner: ['node'] });
  assert.ok(a.includes('type=bind,src=/w,dst=/w'));
  assert.ok(a.includes('type=bind,src=/r,dst=/r,readonly'));
  assert.ok(a.includes('type=bind,src=/dev/null,dst=/w/s.sock,readonly'));
  assert.ok(!a.includes('--init') && !a.includes('--privileged') && !a.some((x) => /^-e$|^--env/.test(x)));
});

// ── the reaper (ruling 6) ───────────────────────────────────────────────────

/** @param {string} bin @param {string} input @param {Record<string, string>} extra */
function reaper(bin, input, extra = {}) {
  return /** @type {Promise<{status: number, stderr: string, ms: number}>} */ (new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [TOOL, '__isolated-reaper', bin, 'webctl-iso-u1-arm-1'], { env: env(extra), stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ status: code ?? -1, stderr, ms: Date.now() - t0 }));
    c.stdin.end(input);
  }));
}

test('⛔ ruling 6: the reaper is BOUNDED — against an `rm` that hangs for ever it exits within its bound, naming what it could not remove', { timeout: 60_000 }, async () => {
  const s = scratch();
  try {
    const r = await reaper(s.bin, '', { WEBCTL_FAKE_DOCKER_LOG: s.log, WEBCTL_FAKE_DOCKER_MODE: 'hangrm' });
    assert.equal(r.status, 0);
    assert.ok(r.ms < 45_000, `the reaper ran ${r.ms} ms`);
    assert.match(r.stderr, /reaper: container webctl-iso-u1-arm-1 may be left/);
    assert.ok(s.calls().every((c) => c[2] === 'rm' && c[4] === 'webctl-iso-u1-arm-1'), 'removal by anything but the exact name');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('⭐ the reaper: `done` → ONE rm by the exact id and exit at once; EOF without `done` (the harness died) → rm by exact id and name', async () => {
  const id = 'c'.repeat(64);
  const s = scratch();
  try {
    const d = await reaper(s.bin, `id ${id}\ndone\n`, { WEBCTL_FAKE_DOCKER_LOG: s.log });
    assert.equal(d.status, 0);
    assert.deepEqual(s.calls().map((c) => c.slice(2)), [['rm', '-f', id]]);
    fs.rmSync(s.log);
    const e = await reaper(s.bin, `id ${id}\n`, { WEBCTL_FAKE_DOCKER_LOG: s.log });
    assert.equal(e.status, 0);
    assert.ok(e.ms < 15_000, `${e.ms} ms`);
    assert.deepEqual(s.calls().map((c) => c.slice(2)), [['rm', '-f', id], ['rm', '-f', 'webctl-iso-u1-arm-1']]);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

// ── ib4k §3b "Nested under docker": PARITY — every read-back, run again in place ──────────────
test('⛔ dockerReadBacks: a planted host socket that still ANSWERS is a refusal — the same one for the inner half and a NESTED call; exempt sockets are not asked', async () => {
  const plan = { sockets: ['/w/live.sock', '/w/keep/ok.sock'], exempt: ['/w/keep'] };
  /** @type {string[][]} */ const asked = [];
  const io = (/** @type {string[]} */ outcomes) => ({ gaps: () => [], loopback: async () => {},
    connect: async (/** @type {string[]} */ ps) => { asked.push(ps); return outcomes; } });
  assert.equal(await harness.dockerReadBacks(plan, io(['CONNECTED'])), '1 host path socket(s) still ANSWER inside the container');
  assert.deepEqual(asked[0], ['/w/live.sock'], 'an exempt (kept) socket was asked, or a planned one was not');
  // CONTROLS: every socket unreachable → ''; a property gap and a dead loopback refuse first, by name
  assert.equal(await harness.dockerReadBacks(plan, io(['ENOENT'])), '');
  assert.equal(await harness.dockerReadBacks(plan, { ...io([]), gaps: () => ['CapEff is not 0'] }), 'inside the container, CapEff is not 0');
  assert.match(await harness.dockerReadBacks(plan, { ...io([]), loopback: async () => { throw new Error('no lo'); } }), /loopback does not work \(no lo\)/);
});

// ── final review (v0.35.0): BLOCKER 1, hidden dirs under a bind; MUST 2, a comma in a mount path ──────────────────
test('⛔ final review 1: a hidden dir INSIDE a bind gets an empty read-only cover — only a --keep AT it unhides it; one beneath it stays on top', () => {
  const hidden = ['/h/.ssh', '/h/.config/webctl', '/h/.cache/CLIAI'];
  assert.deepEqual(harness.dockerHiddenCovers(hidden, [{ p: '/h/.config' }], []), ['/h/.config/webctl']);
  assert.deepEqual(harness.dockerHiddenCovers(hidden, [{ p: '/h/.config' }, { p: '/h/.config/webctl' }], ['/h/.config/webctl']), [],
    'CONTROL: an explicit --keep AT the hidden dir re-exposes it');
  assert.deepEqual(harness.dockerHiddenCovers(hidden, [{ p: '/h/.config' }, { p: '/h/.config/webctl/x' }], ['/h/.config/webctl/x']), ['/h/.config/webctl']);
  assert.deepEqual(harness.dockerHiddenCovers(hidden, [{ p: '/work' }], []), [], 'CONTROL: no bind contains a hidden dir');
  const argv = harness.dockerCreateArgv({ name: 'n', uid: 1, gid: 1, limits: [], binds: [], masks: [], covers: ['/h/.config/webctl'], channel: '/c', image: 'i', inner: [] });
  assert.ok(argv.includes('type=bind,src=/c/empty,dst=/h/.config/webctl,readonly'), argv.join(' '));
});

test('⛔ final review 1: the read-back no longer exempts a hidden dir INSIDE a keep — shown unless empty and read-only (a keep beneath may lead through it)', () => {
  const io = (/** @type {Record<string, {entries: string[], w: boolean}>} */ fsm) => ({
    exists: (/** @type {string} */ p) => p in fsm, list: (/** @type {string} */ p) => fsm[p].entries, writable: (/** @type {string} */ p) => fsm[p].w });
  const plan = { hidden: ['/h/.config/webctl'], exempt: ['/h/.config'] };
  // the measured hole: --keep ~/.config showed ~/.config/webctl with its entries, writable — the old check exempted it
  assert.equal(harness.dockerHiddenShown(plan, io({ '/h/.config/webctl': { entries: ['a', 'b', 'c'], w: true } })), 1);
  assert.equal(harness.dockerHiddenShown(plan, io({ '/h/.config/webctl': { entries: [], w: true } })), 1, 'an empty but WRITABLE dir is not a cover');
  assert.equal(harness.dockerHiddenShown(plan, io({ '/h/.config/webctl': { entries: [], w: false } })), 0, 'CONTROL: the cover');
  assert.equal(harness.dockerHiddenShown(plan, io({})), 0, 'CONTROL: absent');
  // a keep BENEATH the hidden dir: only its leading entry may show
  const beneath = { hidden: ['/h/.config/webctl'], exempt: ['/h/.config/webctl/x'] };
  assert.equal(harness.dockerHiddenShown(beneath, io({ '/h/.config/webctl': { entries: ['x'], w: false } })), 0);
  assert.equal(harness.dockerHiddenShown(beneath, io({ '/h/.config/webctl': { entries: ['x', 'secret'], w: false } })), 1);
  // a --keep AT it: re-exposed by the caller's own choice
  assert.equal(harness.dockerHiddenShown({ hidden: ['/h/.ssh'], exempt: ['/h/.ssh'] }, io({ '/h/.ssh': { entries: ['k'], w: true } })), 0);
});

test('⛔ final review 2: a comma (or quote, control char) in a mount path is REFUSED before any create — named by label, never the path', async () => {
  const s = scratch();
  try {
    const target = path.join(s.dir, 'target');
    fs.mkdirSync(target);
    const odd = path.join(s.dir, `y,src=${target}`);
    fs.mkdirSync(odd, { recursive: true }); // (the spec has slashes: a dir chain)
    const r = await run(s, ['--keep-ro', odd, '--', 'true']);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--keep-ro #1 has a comma, a quote or a control character in its path .* refused/);
    assert.ok(!r.stderr.includes(odd) && !r.stderr.includes('src='), 'the path was echoed');
    assert.equal(callOf(s.calls(), 'create'), undefined, 'a container was CREATED with the split mount spec');
    for (const p of ['/a"b', '/a\nb', "/a'b"]) assert.match(harness.dockerMountPathsUnsafe([{ p, label: 'x' }]), /^x has/, JSON.stringify(p));
    assert.equal(harness.dockerMountPathsUnsafe([{ p: '/a b/c-d_e.f', label: 'x' }]), '', 'CONTROL: spaces and the usual characters pass');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});
