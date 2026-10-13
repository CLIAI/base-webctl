// isolation-docker-table.test.js — ib4k §1 judged under the DOCKER backend (§3b), on the REAL host's daemon.
//
// ⛔ Why not isolation-arm-table.test.js: its world is a throwaway `unshare -rm` with a FAKE home on a tmpfs — but
// the docker daemon resolves bind sources in the HOST's mount namespace, so inside that world it would bind the
// real host's dirs at the world's paths. ⇒ The same rows, here, with a world of throwaway dirs on the real host:
// the controls run OUTSIDE (read-only there, except this file's own throwaway files in /tmp, /dev/shm, /var/tmp),
// the arms INSIDE on the fresh, nested and stripped-markers paths. Each row's DEVIATIONS (ib4k §3b, "rows docker
// cannot meet") are asserted AS deviations and named — never counted as a pass of the namespace contract.
//
// Needs: the docker CLI in the system dirs, the LOCAL daemon, and the image built
// (`node scripts/contract-harness.mjs isolated-image build`). Otherwise every test is a named SKIP.
// ⚠ Within a shared host's limits: tests run one at a time, each run is ONE container (nested runs are in place).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');
const PROBE = path.join(ROOT, 'test', 'helpers', 'isolation-docker-probe.cjs');
const DOCKER = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'].map((d) => path.join(d, 'docker')).find((p) => fs.existsSync(p)) || '';
const ENDPOINT = 'unix:///var/run/docker.sock';
const UID = process.getuid?.() ?? -1;
const NEUTRAL_ID_DIGEST = crypto.createHash('sha256').update('77656263746c2d69736f6c6174656400').digest('hex').slice(0, 16);
const MINIMAL_DEV = ['null', 'zero', 'full', 'random', 'urandom', 'tty', 'pts', 'ptmx', 'shm', 'mqueue', 'fd', 'stdin', 'stdout', 'stderr'];
const MARKERS = ['WEBCTL_HOST_NETNS', 'WEBCTL_HOST_MNTNS', 'WEBCTL_HOST_PIDNS', 'WEBCTL_RO_ROOTS', 'WEBCTL_HIDDEN_DIRS', 'WEBCTL_HOST_IDS'];

/** @param {string[]} a */
const docker = (a) => spawnSync(DOCKER, ['-H', ENDPOINT, ...a], { encoding: 'utf8', timeout: 30_000 });
/** Why this host cannot run the docker table, or ''. */
function unavailable() {
  if (!DOCKER) return 'SKIP (host): no docker CLI in the system dirs';
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) return 'SKIP (host): DOCKER_HOST/DOCKER_CONTEXT set — the docker backend uses the local daemon only';
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) return 'SKIP (host): the local docker daemon does not answer';
  const r = spawnSync(process.execPath, [TOOL, 'isolated-image'], { encoding: 'utf8' });
  if (r.status !== 0) return 'SKIP (host): the docker backend\'s image is not built — node scripts/contract-harness.mjs isolated-image build';
  return '';
}
const SKIP = unavailable();
// ⛔ a timeout on every test: a run that never ends (a sabotage, a regression) must fail, not hang the suite
const needsDocker = SKIP ? { skip: SKIP } : { timeout: 120_000 };

/** @param {Record<string, string>} [extra] */
function cleanEnv(extra = {}) {
  const env = { ...process.env, WEBCTL_ISOLATION_BACKEND: 'docker' };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', ...MARKERS]) delete env[k];
  return { ...env, ...extra };
}
/** The containers of THIS uid's runs whose name names `pid` (exact name, never a sweep). @param {string} lane @param {number} pid */
const containerOf = (lane, pid) => docker(['ps', '-aq', '--filter', `name=^webctl-iso-u${UID}-${lane}-${pid}$`]).stdout.trim();
/** Wait until `f()` or `ms`. @param {() => boolean} f @param {number} ms */
async function until(f, ms) { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (f()) return true; return f(); }

/**
 * Spawn the harness in a process GROUP of its own (as a terminal's foreground job), collecting its output.
 * @param {string[]} args @param {{cwd: string, env?: NodeJS.ProcessEnv}} o
 */
function start(args, o) {
  const c = spawn(process.execPath, [TOOL, 'isolated', ...args], { cwd: o.cwd, env: o.env || cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  STARTED.add(c);
  c.on('close', () => STARTED.delete(c));
  let stdout = ''; let stderr = '';
  c.stdout?.on('data', (d) => { stdout += d; });
  c.stderr?.on('data', (d) => { stderr += d; });
  const done = /** @type {Promise<{code: number | null, signal: NodeJS.Signals | null}>} */ (new Promise((r) => c.on('close', (code, signal) => r({ code, signal }))));
  // ⛔ `exited`, not `done`, after a SIGKILL: `close` waits for every holder of the stdio pipes — the detached docker
  // CLI holds them until the COMMAND ends, so "nothing left" judged after `close` judged a run that had ended by itself
  // (sabotage D1: no reaper, and the arm stayed green)
  const exited = /** @type {Promise<void>} */ (new Promise((r) => c.on('exit', () => r())));
  return { c, done, exited, out: () => stdout, err: () => stderr };
}

// ── the world: throwaway dirs on the real host ─────────────────────────────

/** @type {any} */ let W = null;
async function world() {
  if (W) return W;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dtable-')));
  const work = path.join(dir, 'work');
  const keep = path.join(dir, 'keep');
  const keepRo = path.join(dir, 'ro');
  const outsideDir = path.join(dir, 'outside');
  for (const d of [work, keep, keepRo, outsideDir]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(keepRo, 'ro.txt'), 'ro');
  const planted = `arm-planted-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(path.join('/dev/shm', planted), 'host');
  fs.writeFileSync(path.join('/var/tmp', planted), 'host');
  const tcp = net.createServer((s) => s.destroy());
  await new Promise((r) => tcp.listen(0, '127.0.0.1', () => r(null)));
  const socket = path.join(work, 'live.sock');
  const unix = net.createServer((s) => s.destroy());
  await new Promise((r) => unix.listen(socket, () => r(null)));
  const cgroup = (fs.readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*)$/m) || [])[1] || '/';
  const cfg = { port: /** @type {net.AddressInfo} */ (tcp.address()).port, socket, uid: UID, hostPid: process.pid, cgroup, home: os.userInfo().homedir,
    keep, keepRo, outsideDir, baseRoot: ROOT, planted };
  const cfgPath = path.join(work, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // row 11: a preload that records WHO loads it (argv only) — the caller's env carries it
  const mark = path.join(work, 'mark.cjs');
  const marks = path.join(work, 'marks.log');
  fs.writeFileSync(mark, `require('fs').appendFileSync(${JSON.stringify(marks)}, JSON.stringify(process.argv.slice(1)) + '\\n');\n`);
  const readings = (/** @type {string} */ s) => Object.fromEntries(s.split('\n').filter((l) => l.startsWith('ARM-RESULT ')).map((l) => JSON.parse(l.slice(11))).map((x) => [x.mode, x]));
  const outside = readings(spawnSync(process.execPath, [PROBE, 'outside', cfgPath], { cwd: work, encoding: 'utf8' }).stdout).outside;
  const strip = MARKERS.map((m) => `-u ${m}`).join(' ');
  const script = `node "$1" fresh "$2"; node "$3" isolated -- node "$1" nested "$2"; env ${strip} node "$3" isolated -- node "$1" stripped "$2"`;
  const r = start(['--keep', keep, '--keep-ro', keepRo, '--pass-env', 'ARM_PASSED', '--', 'sh', '-c', script, 'arm', PROBE, cfgPath, TOOL],
    { cwd: work, env: cleanEnv({ ARM_PLANTED_UNKNOWN: 'x', ARM_PASSED: 'x', NODE_OPTIONS: `--require=${mark}` }) });
  const end = await r.done;
  const arm = readings(r.out());
  tcp.close(); unix.close();
  W = { dir, work, cfg, outside, arm, status: end.code, err: r.err(), marks: fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [],
    leftShm: ['fresh', 'nested', 'stripped'].filter((m) => fs.existsSync(path.join('/dev/shm', `${planted}-in-${m}`)) || fs.existsSync(path.join('/var/tmp', `${planted}-in-${m}`))) };
  for (const d of ['/dev/shm', '/var/tmp']) for (const n of [planted, ...['fresh', 'nested', 'stripped'].map((m) => `${planted}-in-${m}`)]) fs.rmSync(path.join(d, n), { force: true });
  return W;
}
/** Every harness this file started and has not seen end. @type {Set<import('node:child_process').ChildProcess>} */
const STARTED = new Set();
test.after(async () => {
  // ⛔ a harness left running (a test timed out) is SIGKILLed — its reaper then removes its container, by exact name
  for (const c of STARTED) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  if (STARTED.size) await until(() => false, 3000);
  if (W) fs.rmSync(W.dir, { recursive: true, force: true });
});

const PATHS = ['fresh', 'nested', 'stripped'];
/** Every path's reading, asserted present. @param {any} w */
function each(w) {
  assert.equal(w.status, 0, `the arm run exited ${w.status}:\n${w.err}`);
  for (const p of PATHS) assert.ok(w.arm[p], `no reading from the ${p} path:\n${w.err}`);
  return PATHS.map((p) => /** @type {[string, any]} */ ([p, w.arm[p]]));
}

test('[docker] the run: the verdict names the backend, its deviations, and NOT the nsdelegate check (ruling 2)', needsDocker, async () => {
  const w = await world();
  each(w);
  assert.match(w.err, /^isolated: home HIDDEN; .*; backend: docker; keyring: none \(docker seccomp\); dev: \+core/m);
  assert.doesNotMatch(w.err, /cgroup2: nsdelegate/);
});

test('[docker] row 1 — no host network: ARM (host port refused, lo only) — CONTROL: outside it answers; a listener made inside answers', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.equal(a.hostPort, 'ECONNREFUSED', `${p}: the host's port`);
    assert.equal(a.interfaces, 0, `${p}: an interface besides lo`);
    assert.equal(a.selfTcp, 'CONNECTED', `${p}: the namespace's own loopback`);
  }
  assert.equal(w.outside.hostPort, 'CONNECTED', 'CONTROL: the host port does not answer outside');
});

test('[docker] row 2 — no host unix sockets: ARM (a socket in the bound cwd masked, the daemon\'s socket absent) — CONTROL: outside it answers; one made inside answers', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.ok(['ECONNREFUSED', 'ENOENT'].includes(a.hostSocket), `${p}: the host socket in the cwd answered: ${a.hostSocket}`);
    assert.equal(a.daemonSocket.var, 'ENOENT', `${p}: the docker socket`);
    assert.equal(a.daemonSocket.run, 'ENOENT', `${p}: the docker socket`);
    assert.equal(a.bus, 'ENOENT', `${p}: the session bus`);
    assert.equal(a.selfUnix, 'CONNECTED', `${p}: a socket made inside`);
  }
  assert.equal(w.outside.hostSocket, 'CONNECTED', 'CONTROL');
});

test('[docker] row 3 — no host processes: ARM (a host pid ESRCH; the caller\'s cgroup files and the own ones not writable) — CONTROL: outside the pid is alive and the files open', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.equal(a.hostPid, 'ESRCH', `${p}: a host pid`);
    for (const [f, e] of Object.entries(a.cgroupHost)) assert.ok(['ENOENT', 'EROFS', 'EACCES'].includes(/** @type {string} */ (e)), `${p}: the caller's ${f} → ${e}`);
    assert.ok(['EROFS', 'EACCES'].includes(a.cgroupOwn), `${p}: the own cgroup.kill → ${a.cgroupOwn}`);
  }
  assert.equal(w.outside.hostPid, 'ok', 'CONTROL');
  assert.equal(w.outside.cgroupHost['cgroup.procs'], 'ok', 'CONTROL: the caller\'s cgroup.procs does not open for write outside');
});

test('[docker] row 3 — kill(0) from the command leaves a sentinel in the caller\'s process group alive — CONTROL: without isolated it dies', needsDocker, async () => {
  const w = await world();
  const run = (/** @type {boolean} */ iso) => new Promise((resolve) => {
    const inner = iso ? `"$0" "$1" isolated -- sh -c 'kill -TERM 0'` : `sh -c 'kill -TERM 0'`;
    const c = spawn('sh', ['-c', `sleep 30 & s=$!; ${inner}; sleep 0.3; kill -0 $s 2>/dev/null && echo SENTINEL-ALIVE; kill $s 2>/dev/null; exit 0`, process.execPath, TOOL],
      { cwd: w.work, env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out));
  });
  assert.match(String(await run(true)), /SENTINEL-ALIVE/);
  assert.doesNotMatch(String(await run(false)), /SENTINEL-ALIVE/, 'CONTROL: kill(0) did not reach the group without isolated');
});

test('[docker] row 4 — the home HIDDEN: ARM (~/.ssh and ~/.config absent; --keep-ro readable, not writable) — CONTROL: outside they exist', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.equal(a.sshDir, 'ENOENT', `${p}: ~/.ssh`);
    assert.equal(a.configDir, 'ENOENT', `${p}: ~/.config`);
    assert.equal(a.keepRoRead, 'ok', `${p}: --keep-ro read`);
    assert.ok(['EROFS', 'EACCES'].includes(a.keepRoWrite), `${p}: --keep-ro write → ${a.keepRoWrite}`);
  }
  assert.ok(w.outside.homeEntries > (w.arm.fresh.homeEntries || 0), 'CONTROL: the home lists no more outside than inside');
});

test('[docker] row 5 — no privilege: ARM (CapEff and CapBnd 0, NoNewPrivs 1, seccomp on, mount refused)', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.equal(a.capEff, '0000000000000000', p);
    assert.equal(a.capBnd, '0000000000000000', p);
    assert.equal(a.noNewPrivs, '1', p);
    assert.equal(a.seccomp, '2', p);
    assert.notEqual(a.mountTmpfs, 0, `${p}: a mount succeeded`);
  }
});

test('[docker] row 6 — env allowlist: ARM (an unknown var absent) — CONTROL: --pass-env passes it on the call that names it; a nested call honours only its OWN', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) assert.equal(a.planted, 'absent', p);
  assert.equal(w.arm.fresh.passed, 'present', 'CONTROL: fresh: --pass-env ARM_PASSED did not pass it');
  assert.equal(w.arm.nested.passed, 'absent', 'nested: the OUTER call\'s --pass-env leaked into a nested call');
});

test('[docker] row 7 — writable only where declared: ARM (an unbound dir absent; base, /, /etc read-only) — CONTROL: the cwd, --keep and the private scratch are writable', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.equal(a.writes.outsideDir, 'ENOENT', `${p}: a user dir that was not declared`);
    for (const k of ['baseRoot', 'root', 'etc']) assert.ok(['EROFS', 'EACCES'].includes(a.writes[k]), `${p}: ${k} → ${a.writes[k]}`);
    for (const k of ['cwd', 'keep', 'tmp', 'varTmp', 'run', 'devShm']) assert.equal(a.writes[k], 'ok', `${p}: CONTROL ${k}`);
  }
  assert.equal(w.outside.writes.outsideDir, 'ok', 'CONTROL: the undeclared dir is writable outside');
});

test('[docker] row 7 — DEVIATION (ib4k §3b): the command cannot make namespaces of its own — asserted as the named deviation, never a pass', needsDocker, async (t) => {
  const w = await world();
  for (const [p, a] of each(w)) assert.notEqual(a.nestedUserns, 0, `${p}: a nested userns WORKED — §3b names this row's control unmet; update the doc`);
  t.diagnostic('DEVIATION (ib4k §3b): row 7\'s control — a nested `unshare -rn` — is EPERM under docker\'s seccomp/AppArmor');
  t.diagnostic('NOT TESTED HERE: row 7\'s late-mount arm needs a mount the HOST makes; docker binds are rprivate (read back by the propagation check)');
});

test('[docker] row 8 — no host-shared scratch: ARM (planted /dev/shm and /var/tmp files absent; writes inside never reach the host; own IPC ns; a fresh mqueue) — CONTROL: outside they read', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.equal(a.shmPlanted, 'ENOENT', `${p}: /dev/shm`);
    assert.equal(a.varTmpPlanted, 'ENOENT', `${p}: /var/tmp`);
    assert.equal(a.shmWrote, 'ok', `${p}: CONTROL /dev/shm write`);
    assert.notEqual(a.ipcNs, w.outside.ipcNs, `${p}: the host's IPC namespace`);
    assert.ok(a.mqueueFs, `${p}: /dev/mqueue`);
    for (const id of w.outside.sysvShm) assert.ok(!a.sysvShm.includes(id), `${p}: a host SysV segment is listed`);
  }
  assert.deepEqual(w.leftShm, [], 'a write inside reached the host\'s /dev/shm or /var/tmp');
  assert.equal(w.outside.shmPlanted, 'ok', 'CONTROL');
  assert.equal(w.outside.varTmpPlanted, 'ok', 'CONTROL');
});

test('[docker] row 9 — no host keyring: ARM (/proc/keys lists nothing; seccomp on) — CONTROL: outside it lists the host\'s — DEVIATION: no key can be added inside', needsDocker, async (t) => {
  const w = await world();
  for (const [p, a] of each(w)) assert.ok(a.procKeys === 0 || typeof a.procKeys === 'string', `${p}: /proc/keys lists ${a.procKeys} key(s)`);
  if (typeof w.outside.procKeys === 'number' && w.outside.procKeys > 0) assert.ok(true);
  else t.diagnostic('NOT TESTED HERE: the host lists no key in /proc/keys');
  t.diagnostic('DEVIATION (ib4k §3b): row 9\'s control — a key added inside — is EPERM under docker\'s seccomp');
});

test('[docker] row 10 — no host identity: ARM (the neutral hostname and machine-id, read-only; lo only in both sysfs dirs) — CONTROL: outside they differ', needsDocker, async () => {
  const w = await world();
  const lo = crypto.createHash('sha256').update('lo').digest('hex').slice(0, 16);
  for (const [p, a] of each(w)) {
    assert.ok(a.hostnameNeutral, `${p}: hostname`);
    assert.deepEqual(a.netNames, [lo], `${p}: /sys/class/net`);
    assert.deepEqual(a.virtualNet, [lo], `${p}: /sys/devices/virtual/net`);
    assert.equal(a.machineId, NEUTRAL_ID_DIGEST, `${p}: machine-id`);
    assert.ok(['EROFS', 'EACCES'].includes(a.machineIdWrite), `${p}: machine-id write → ${a.machineIdWrite}`);
  }
  assert.notEqual(w.outside.hostname, w.arm.fresh.hostname, 'CONTROL: the host is called webctl-isolated');
  assert.ok(w.outside.netNames.length > 1, 'CONTROL: the host lists only lo');
});

test('[docker] row 11 — no loader injection into the privileged half: a NODE_OPTIONS preload never runs in the inner half or the reaper — CONTROL: the command loads it', needsDocker, async () => {
  const w = await world();
  each(w);
  const who = w.marks.map((/** @type {string[]} */ a) => a.join(' '));
  assert.ok(!who.some((/** @type {string} */ a) => /__isolated-docker|__isolated-reaper/.test(a)), `a privileged half loaded the preload: ${who.join(' | ')}`);
  assert.ok(who.some((/** @type {string} */ a) => /isolation-docker-probe\.cjs fresh/.test(a)), `CONTROL: the command did not load it: ${who.join(' | ')}`);
});

test('[docker] row 12 — no host devices: ARM (/dev is the minimal set plus `core`; no host pty, uinput or snd; no create in /dev) — CONTROL: the nodes work, a pty opens; the host /dev holds more', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) {
    assert.deepEqual(a.dev.filter((/** @type {string} */ n) => !MINIMAL_DEV.includes(n)), ['core'], `${p}: /dev beyond the minimal set and core`);
    assert.deepEqual(a.devPts.filter((/** @type {string} */ n) => n !== 'ptmx'), [], `${p}: a host pty in /dev/pts`);
    assert.equal(a.uinput, 'ENOENT', p);
    assert.equal(a.snd, 'ENOENT', p);
    assert.ok(['EACCES', 'EROFS'].includes(a.devCreate), `${p}: a create in /dev → ${a.devCreate}`);
    assert.equal(a.devNull, 'ok', `${p}: CONTROL /dev/null`);
    assert.equal(a.devFull, 'ENOSPC', `${p}: CONTROL /dev/full`);
    assert.equal(a.ptmx, 'ok', `${p}: CONTROL a pty`);
  }
  assert.ok(w.outside.dev.length > w.arm.fresh.dev.length, 'CONTROL: the host /dev holds no more');
});

test('[docker] row 12b — no controlling terminal: /dev/tty → ENXIO on every path (stdio are the CLI\'s pipes)', needsDocker, async () => {
  const w = await world();
  for (const [p, a] of each(w)) assert.equal(a.devTty, 'ENXIO', p);
});

// ── §3a.2, §3a.4 and the v0.35 signal contract ─────────────────────────────

test('[docker] the CALLER\'s stdin is never consumed: a `while read` loop around `isolated` keeps every line (the gate\'s registry loop lost one) — the command reads EOF', needsDocker, async () => {
  const w = await world();
  const r = spawnSync('sh', ['-c', 'printf "one\\ntwo\\nthree\\n" | while read l; do "$0" "$1" isolated -- sh -c \'read x && echo "CMD-READ:$x" || echo CMD-EOF\' 2>/dev/null; echo "LOOP:$l"; done',
    process.execPath, TOOL], { cwd: w.work, env: cleanEnv(), encoding: 'utf8', timeout: 110_000 });
  assert.deepEqual(r.stdout.split('\n').filter((l) => l.startsWith('LOOP:')), ['LOOP:one', 'LOOP:two', 'LOOP:three'], r.stdout + r.stderr);
  assert.equal((r.stdout.match(/^CMD-EOF$/gm) || []).length, 3, `the command read the caller's stdin (a named deviation: it reads EOF):\n${r.stdout}`);
});

const TRAP = 'for s in INT TERM HUP QUIT; do trap "echo GOT-$s; sleep 0.3; echo CLEANED; exit 7" $s; done; echo READY; while :; do sleep 0.1; done';

test('[docker] §3a.2: the RUNNING container — not privileged, exactly `no-new-privileges`, docker\'s AppArmor profile where the host has AppArmor', needsDocker, async () => {
  const w = await world();
  const r = start(['--', 'bash', '-c', TRAP], { cwd: w.work });
  try {
    assert.ok(await until(() => r.out().includes('READY'), 30_000), r.err());
    const name = `webctl-iso-u${UID}-work-${r.c.pid}`;
    const i = docker(['inspect', '--format', '{{.HostConfig.Privileged}}|{{json .HostConfig.SecurityOpt}}|{{.AppArmorProfile}}|{{.HostConfig.NetworkMode}}', name]);
    assert.equal(i.status, 0, i.stderr);
    const [priv, sec, aa, net] = i.stdout.trim().split('|');
    assert.equal(priv, 'false');
    assert.equal(sec, '["no-new-privileges"]');
    assert.equal(net, 'none');
    let hostAa = false;
    try { hostAa = fs.readFileSync('/sys/module/apparmor/parameters/enabled', 'utf8').trim() === 'Y'; } catch { /* none */ }
    if (hostAa) assert.equal(aa, 'docker-default');
  } finally { process.kill(-(r.c.pid || 0), 'SIGTERM'); await r.done; }
});

for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'])) {
  test(`[docker] a terminal-group ${sig} reaches the command EXACTLY ONCE, its trap completes, rc 7, nothing left`, needsDocker, async () => {
    const w = await world();
    const r = start(['--', 'bash', '-c', TRAP], { cwd: w.work });
    assert.ok(await until(() => r.out().includes('READY'), 30_000), r.err());
    process.kill(-(r.c.pid || 0), sig);
    const end = await r.done;
    assert.equal(end.code, 7, `${end.code}/${end.signal}\n${r.out()}${r.err()}`);
    assert.equal((r.out().match(/GOT-/g) || []).length, 1, r.out());
    assert.match(r.out(), /CLEANED/);
    assert.equal(containerOf('work', r.c.pid || 0), '', 'a container is left');
  });
}

test('[docker] 128+n: a forwarded TERM the command does not trap → the harness DIES by TERM (as on the namespace backends)', needsDocker, async () => {
  const w = await world();
  const r = start(['--', 'bash', '-c', 'echo READY; sleep 30'], { cwd: w.work });
  assert.ok(await until(() => r.out().includes('READY'), 30_000), r.err());
  process.kill(-(r.c.pid || 0), 'SIGTERM');
  const end = await r.done;
  assert.equal(end.signal, 'SIGTERM', `${end.code}/${end.signal}`);
});

test('[docker] §3a.4: the harness SIGKILLed mid-run → its reaper removes the container (by exact name) — nothing left', needsDocker, async () => {
  const w = await world();
  const r = start(['--', 'bash', '-c', 'echo READY; sleep 300'], { cwd: w.work });
  assert.ok(await until(() => r.out().includes('READY'), 30_000), r.err());
  assert.notEqual(containerOf('work', r.c.pid || 0), '', 'CONTROL: the container is not running');
  r.c.kill('SIGKILL');
  await r.exited;
  assert.ok(await until(() => containerOf('work', r.c.pid || 0) === '', 15_000), 'the container outlived its harness');
});

test('[docker] §3a.4: the harness SIGKILLed during the CREATE → no container is left once the reaper\'s bound has passed', needsDocker, async () => {
  const w = await world();
  const r = start(['--', 'bash', '-c', 'echo RAN; sleep 300'], { cwd: w.work });
  // the create is in flight once docker was called: the probe takes several CLI calls first
  await until(() => false, 900);
  r.c.kill('SIGKILL');
  await r.exited;
  assert.ok(await until(() => containerOf('work', r.c.pid || 0) === '', 45_000), 'a container outlived its harness');
});

test('[docker] an EARLY TERM (before the inner half reports in) → the command never runs, the harness dies by TERM, nothing left', needsDocker, async () => {
  const w = await world();
  const marker = path.join(w.work, `RAN-${process.pid}`);
  const r = start(['--', 'sh', '-c', `touch ${marker}`], { cwd: w.work });
  await until(() => false, 400);
  process.kill(-(r.c.pid || 0), 'SIGTERM');
  const end = await r.done;
  assert.equal(end.signal, 'SIGTERM', `${end.code}/${end.signal}\n${r.err()}`);
  assert.equal(fs.existsSync(marker), false, 'the command RAN after an early TERM');
  assert.ok(await until(() => containerOf('work', r.c.pid || 0) === '', 10_000), 'a container is left');
});

/** Host pids whose cmdline holds every one of `parts` (the container's processes are visible from the host). @param {string[]} parts */
const pidsWith = (parts) => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
  try { const a = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0'); return parts.every((p) => a.includes(p)); } catch { return false; }
}).map(Number);

test('[docker] the GO-HANDSHAKE: the harness FROZEN before it reads `started` → the inner half waits in `read` on `go`, the command never starts; SIGKILLed then → nothing left', needsDocker, async () => {
  const w = await world();
  const marker = path.join(w.work, `GO-RAN-${process.pid}`);
  const r = start(['--', 'sh', '-c', `touch ${marker}; sleep 300`], { cwd: w.work });
  let stopped = false;
  try {
    // freeze the harness the moment its `docker start` exists: it can then never read `started` nor answer `go`
    assert.ok(await until(() => pidsWith(['start', '--attach']).some((p) => {
      try { return Number(fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]) === r.c.pid; } catch { return false; }
    }), 30_000), `no docker start appeared: ${r.err()}`);
    process.kill(r.c.pid || 0, 'SIGSTOP');
    stopped = true;
    // the inner half (visible from the host) reaches its read on the `go` FIFO
    const inner = () => pidsWith(['__isolated-docker', `touch ${marker}; sleep 300`]);
    assert.ok(await until(() => inner().some((p) => { try { return /pipe_read|pipe_wait|fifo/.test(fs.readFileSync(`/proc/${p}/wchan`, 'utf8')); } catch { return false; } }), 30_000),
      'the inner half never waited on `go`');
    await until(() => false, 1000);
    assert.equal(fs.existsSync(marker), false, 'the command started WITHOUT the harness\'s `go`');
  } finally {
    r.c.kill('SIGKILL');
    await r.exited;
  }
  assert.ok(stopped);
  assert.ok(await until(() => containerOf('work', r.c.pid || 0) === '', 15_000), 'the container outlived its frozen, killed harness');
  assert.equal(fs.existsSync(marker), false, 'the command ran after its harness was killed');
});

test('[docker] the reaper runs SHIELDED: TERM, INT, HUP and QUIT ignored or caught (read back from /proc) — and survives a TERM aimed at it', needsDocker, async () => {
  const w = await world();
  const r = start(['--', 'bash', '-c', 'echo READY; sleep 30'], { cwd: w.work });
  try {
    assert.ok(await until(() => r.out().includes('READY'), 30_000), r.err());
    const name = `webctl-iso-u${UID}-work-${r.c.pid}`;
    const pid = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).find((d) => {
      try { const a = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0'); return a.includes('__isolated-reaper') && a.includes(name); } catch { return false; }
    });
    assert.ok(pid, 'no reaper process for this run');
    process.kill(Number(pid), 'SIGTERM');
    await until(() => false, 300);
    assert.ok(fs.existsSync(`/proc/${pid}`), 'a TERM aimed at the reaper killed it');
    const ign = BigInt(`0x${(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^SigIgn:\s*([0-9a-f]+)$/m) || [])[1]}`);
    // node RESETS inherited dispositions at start, so an `env --ignore-signal` shield cannot hold for it: the reaper
    // CATCHES them (no-op handlers) — either bit is a shield, neither is not
    const cgt = BigInt(`0x${(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^SigCgt:\s*([0-9a-f]+)$/m) || [])[1]}`);
    for (const n of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
      const bit = 1n << BigInt(os.constants.signals[/** @type {NodeJS.Signals} */ (n)] - 1);
      assert.ok((ign | cgt) & bit, `the reaper is not shielded from ${n}`);
    }
  } finally { process.kill(-(r.c.pid || 0), 'SIGTERM'); await r.done; }
});

test('[docker] §3a.3: a FORGED marker (a plain /run/webctl-isolated dir, in a container that is not ours) → REFUSED, nothing run — CONTROL: the real nested path runs (row arms above)', needsDocker, async () => {
  const w = await world();
  const img = spawnSync(process.execPath, [TOOL, 'isolated-image'], { encoding: 'utf8' }).stdout.match(/(webctl-iso\/node22:[0-9a-f]{12})/)?.[1];
  assert.ok(img);
  const name = `webctl-iso-u${UID}-forge-${process.pid}`;
  const r = docker(['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--user', `${UID}:${process.getgid?.()}`, '--hostname', 'webctl-isolated',
    '--tmpfs', '/run:mode=1777', '--tmpfs', '/tmp:mode=1777', '--mount', `type=bind,src=${ROOT},dst=${ROOT},readonly`, '-w', ROOT, img || '',
    'bash', '-c', 'mkdir /run/webctl-isolated && printf "webctl-isolated docker backend\\n" > /run/webctl-isolated/marker && '
      + 'WEBCTL_HOST_NETNS=x node scripts/contract-harness.mjs isolated -- echo ESCAPED; echo "rc=$?"']);
  assert.match(r.stdout, /^rc=2$/m, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^ESCAPED$/m, 'the command ran');
  assert.match(r.stderr, /REFUSED, nothing run: .*not the docker backend's read-only bind \(a forged marker\)/);
  assert.ok(each(w).length === 3, 'CONTROL: the nested path did not run');
});
