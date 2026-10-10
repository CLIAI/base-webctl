// isolation-arm-table.test.js — ib4k §1: ONE contract, whatever the backend, proven by ONE arm set.
//
// ⛔ "A backend that passes fewer arms is not a backend." Each row below is a property of
// `isolated`, an ARM that must hold INSIDE it, and the positive CONTROL that shows the arm can
// fail (k3wn): the same reading OUTSIDE, or a self-made counterpart inside. The table is run per
// IMPLEMENTED backend (WEBCTL_ISOLATION_BACKEND pins it), on all three paths a lane hits: FRESH,
// NESTED (an `isolated` inside `isolated`) and STRIPPED markers (`env -u WEBCTL_…` inside).
//
// ⚠ This is the CONTRACT, kept short so a new backend (bwrap, docker) is judged by exactly it.
// The depth for the unshare implementation — every mutant, refusal and race — stays in
// contract-harness-isolation.test.js; each row names the tests there that go deeper.
//
// ⛔ NOTHING here touches the real host: the arms run in a throwaway "world"
// (helpers/isolation-arm-world.cjs) — a throwaway `unshare -rm` with a FAKE passwd home on a tmpfs
// over a neutral dir, a tmpfs "host" /dev/shm and /var/tmp, and a throwaway session keyring. The
// world shares the host's network and PID namespaces (rows 1 and 3 need the host side) — and reads
// host identity only as DIGESTS (row 10): no hostname, machine-id or interface name is ever logged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as harness from '../scripts/contract-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');
const PROBE = path.join(ROOT, 'test', 'helpers', 'isolation-arm-probe.cjs');
const WORLD = path.join(ROOT, 'test', 'helpers', 'isolation-arm-world.cjs');

/**
 * The backends this table is RUN against — every backend the harness can run. ⛔ Extend it when a
 * backend lands (phase 2: bwrap, phase 3: docker); the guard test below fails until you do.
 */
const IMPLEMENTED = ['unshare'];
const PATHS = /** @type {const} */ (['fresh', 'nested', 'stripped']);
const NEUTRAL_HOSTNAME = 'webctl-isolated';
/** @param {string} s */
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

const sysTool = (/** @type {string} */ n) => ['/usr/sbin', '/usr/bin', '/sbin', '/bin'].map((d) => path.join(d, n)).find((p) => fs.existsSync(p)) || '';
const KEYCTL = sysTool('keyctl');
const MOUNT = sysTool('mount');
const IPCMK = sysTool('ipcmk');
const PYTHON = sysTool('python3');
/** shmat(argv[1]); `w`: write argv[3] at its start, `r`: print what is there. Prints `wrote`, the text, or `failed <errno>`. */
const SHM_PY = ['import ctypes, sys', 'libc = ctypes.CDLL(None, use_errno=True)', 'libc.shmat.restype = ctypes.c_void_p',
  'p = libc.shmat(int(sys.argv[1]), None, 0)',
  'if p in (None, ctypes.c_void_p(-1).value): print("failed", ctypes.get_errno()); sys.exit(1)',
  'buf = (ctypes.c_char * 32).from_address(p)',
  'if sys.argv[2] == "w": buf.value = sys.argv[3].encode(); print("wrote")',
  'else: print(buf.value.decode())'].join('\n');

/** A dir to put the fake home under: exists, and is not (an ancestor of) anything the run needs. */
function neutralDir() {
  const need = [ROOT, fs.realpathSync(process.execPath), os.tmpdir(), fs.realpathSync(os.tmpdir())];
  return ['/mnt', '/srv', '/media', '/opt'].find((d) => {
    try { if (!fs.statSync(d).isDirectory()) return false; } catch { return false; }
    return !need.some((n) => n === d || n.startsWith(`${d}/`));
  }) || '';
}

/** @param {string} p */
function unixServer(p) {
  const srv = net.createServer((s) => s.destroy());
  return new Promise((resolve) => srv.listen(p, () => resolve(srv)));
}

/** @type {Map<string, Promise<any>>} */
const worlds = new Map();
/**
 * Build the world once per backend and run every reading in it. Resolves `{skip}` when this host
 * cannot build it (named), else the WORLD record (helpers/isolation-arm-world.cjs).
 * @param {string} backend
 */
function world(backend) {
  if (!worlds.has(backend)) worlds.set(backend, buildWorld(backend));
  return /** @type {Promise<any>} */ (worlds.get(backend));
}

/** @param {string} backend */
async function buildWorld(backend) {
  const neutral = neutralDir();
  if (!neutral) return { skip: 'SKIP (host): no neutral dir (/mnt, /srv, /media, /opt) to put a fake home on' };
  if (!MOUNT) return { skip: 'SKIP (host): no mount in the system dirs' };
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-arm-keep-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-arm-cwd-'));
  const socks = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-arm-socks-'));
  const listener = net.createServer((s) => s.destroy());
  await new Promise((r) => listener.listen(0, '127.0.0.1', () => r(undefined)));
  /** @type {net.Server[]} */ const servers = [];
  try {
    const sockets = { 'docker.sock': path.join(socks, 'docker.sock'), X0: path.join(socks, 'X0'), bus: path.join(socks, 'bus') };
    for (const p of Object.values(sockets)) servers.push(/** @type {net.Server} */ (await unixServer(p)));
    const home = path.join(neutral, 'home', 'u');
    const hits = path.join(keep, 'hits');
    const preload = path.join(keep, 'preload.cjs');
    fs.writeFileSync(preload, `const fs = require('fs');
let cap = ''; try { cap = (fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\\s*(\\S+)/m) || [])[1]; } catch {}
try { fs.appendFileSync(${JSON.stringify(hits)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, cap, argv: process.argv }) + '\\n'); } catch {}\n`);
    const cfg = { neutral, home, keepRo: path.join(home, 'data'), outsideHome: path.join(neutral, 'outside-home'),
      keepOutside: path.join(neutral, 'keep-outside'), keep, cwd,
      planted: `arm-planted-${process.pid}`, uid: process.getuid?.(), gid: process.getgid?.(), mount: MOUNT,
      tamperSrc: path.join(neutral, 'tamper-src'), tamperDst: path.join(neutral, 'tamper-dst'),
      ipcmk: IPCMK, python: PYTHON, shmPy: SHM_PY, ipcFile: path.join(keep, 'ipc.json'),
      keyIdFile: path.join(keep, 'key-id'), keyctl: !!KEYCTL, keyName: `webctl-arm-${process.pid}`, port: /** @type {net.AddressInfo} */ (listener.address()).port,
      sockets, hostPid: process.pid, cgroup: CGROUP, baseRoot: ROOT, probe: PROBE, harness: TOOL, preload, backend,
      self: path.join(keep, 'cfg.json') };
    fs.writeFileSync(cfg.self, JSON.stringify(cfg));
    const argv = [...(KEYCTL ? [KEYCTL, 'session', '-'] : []), 'unshare', '-rm', '--ipc', '--propagation=private', process.execPath, WORLD, cfg.self];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.WEBCTL_ISOLATION_BACKEND;
    const r = await new Promise((resolve) => {
      const c = spawn(argv[0], argv.slice(1), { env, cwd: ROOT });
      let stdout = ''; let stderr = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.stderr.on('data', (d) => { stderr += d; });
      c.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
    const line = /** @type {any} */ (r).stdout.split('\n').find((/** @type {string} */ l) => l.startsWith('WORLD '));
    if (!line) return { skip: '', broken: `the world printed no record (exit ${/** @type {any} */ (r).status}):\n${/** @type {any} */ (r).stderr.slice(-3000)}` };
    const w = JSON.parse(line.slice('WORLD '.length));
    if (w.unavailable) return { skip: `SKIP (host): cannot build the arm world here — ${w.unavailable}` };
    let hitLines = [];
    try { hitLines = fs.readFileSync(hits, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    return { ...w, hits: hitLines, cfg };
  } finally {
    for (const s of servers) s.close();
    listener.close();
    for (const d of [keep, cwd, socks]) fs.rmSync(d, { recursive: true, force: true });
  }
}

/** Row 3: the caller's own cgroup files the command must not be able to open for write. */
const CGROUP_FILES = ['cgroup.kill', 'cgroup.procs'];
/** The test's cgroup v2 path ('' when none): the world and the arms run in it (re-review item 2). */
const CGROUP = (() => { try { return (fs.readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(\/.*)$/m) || [])[1] || ''; } catch { return ''; } })();
/** @param {any} w @param {string} where */
const ctx = (w, where) => `${where}\n--- arm stderr (tail) ---\n${w.armErr}`;
const ZERO = /^0+$/;

/**
 * THE TABLE (ib4k §1). `arm(r, w)`: r = the reading on ONE inside path; `control(w)`: the
 * reading(s) that prove the arm can fail. `deeper`: where the unshare depth lives.
 * `untested`: the arm ADDS a named reason for each half this host cannot test (the ARM is then a SKIP).
 * @type {{n: number, property: string, arm: (r: any, w: any, p: string, untested: Set<string>) => void, control: ((w: any, t: any) => void) | null, deeper: string}[]}
 */
const ROWS = [
  { n: 1, property: 'no host network',
    arm: (r, w, p) => {
      assert.equal(r.hostPort, 'ECONNREFUSED', ctx(w, `${p}: a live HOST listener is reachable (or lo is down)`));
      assert.equal(r.nonLo, 0, ctx(w, `${p}: an interface besides lo is visible`));
    },
    control: (w) => {
      assert.equal(w.outside.outside.hostPort, 'CONNECTED', 'control: the host listener is not reachable even outside');
      for (const p of PATHS) assert.equal(w.arm[p].selfListener, 'CONNECTED', `${p}: a listener made INSIDE does not answer`);
    },
    deeper: '"⭐ QA: a mutant under `isolated` cannot reach a host listener", "isolation-check …", "nesting CONTROL: … keeps the outer NETWORK"' },
  { n: 2, property: 'no host unix sockets',
    arm: (r, w, p) => {
      for (const [name, o] of Object.entries(r.hostSockets)) assert.equal(o, 'ENOENT', ctx(w, `${p}: the host socket ${name} answers ${o}`));
      for (const [where, o] of Object.entries(r.realSockets || {})) {
        assert.ok(['ENOENT', 'ECONNREFUSED'].includes(String(o)), ctx(w, `${p}: ${where} answers ${o}`));
      }
    },
    control: (w) => {
      for (const [name, o] of Object.entries(w.outside.outside.hostSockets)) assert.equal(o, 'CONNECTED', `control: ${name} does not answer outside`);
      for (const p of PATHS) assert.equal(w.arm[p].selfSocket, 'CONNECTED', `${p}: a socket made INSIDE does not connect`);
    },
    deeper: '"⭐ QA: a self-made socket under an UNKEPT /tmp dir", "`--keep` EXEMPTS its sockets", "⭐ ARM: `umount -l /tmp` FAILS inside"' },
  { n: 3, property: 'no host processes',
    arm: (r, w, p, untested) => {
      assert.equal(r.hostPid, 'ESRCH', ctx(w, `${p}: a host pid is signalable (${r.hostPid})`));
      // …nor killable or movable through the cgroup tree: the CALLER's scope (re-review item 2)
      for (const f of CGROUP_FILES) {
        const o = w.outside.outside.cgroupOpen?.[f];
        if (o !== 'ok') { untested.add(`the caller's ${f} does not open for write even outside (${o ?? 'no cgroup v2 path'}): that arm is UNTESTED`); continue; }
        assert.ok(['EROFS', 'EACCES', 'ENOENT'].includes(r.cgroupOpen?.[f]),
          ctx(w, `${p}: the caller's ${f} opens for WRITE inside (${r.cgroupOpen?.[f]}) — the command could kill or move the processes that called it`));
      }
    },
    control: (w, t) => {
      assert.equal(w.outside.outside.hostPid, 'ok', 'control: the host pid is not alive outside');
      const o = w.outside.outside.cgroupOpen || {};
      const bad = CGROUP_FILES.filter((f) => o[f] !== 'ok');
      if (bad.length) t.skip(`SKIP (host): the caller's ${bad.join(' and ')} do(es) not open for write even outside — the cgroup arm is UNTESTED here`);
    },
    deeper: '"⭐ ARM: a host process this test started → kill(pid, 0) is ESRCH inside", "⛔ a NESTED `isolated` gets its own PID namespace"' },
  { n: 4, property: 'the home HIDDEN',
    arm: (r, w, p) => {
      assert.equal(r.sshConfig, 'ENOENT', ctx(w, `${p}: ~/.ssh/config is readable`));
      assert.equal(r.webctlConfig, 'ENOENT', ctx(w, `${p}: ~/.config/webctl/config.toml is readable`));
      assert.equal(r.keepRoRead, 'ok', ctx(w, `${p}: the --keep-ro path is not readable`));
      assert.equal(r.keepRoWrite, 'EROFS', ctx(w, `${p}: the --keep-ro path is writable`));
    },
    control: (w) => {
      const o = w.outside.outside;
      assert.equal(o.sshConfig, 'ok', 'control: ~/.ssh/config unreadable outside');
      assert.equal(o.webctlConfig, 'ok', 'control: ~/.config/webctl/config.toml unreadable outside');
      assert.equal(o.keepRoWrite, 'ok', 'control: the --keep-ro path is not writable outside');
    },
    deeper: '"⭐ ARM: the WHOLE home is hidden", "⭐ ARM: ~/.ssh, ~/.gnupg and the state roots are ABSENT inside", the xq / PATH / keep arms' },
  { n: 5, property: 'no privilege',
    arm: (r, w, p) => {
      for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) assert.match(String(r.caps[k]), ZERO, ctx(w, `${p}: ${k} is not 0`));
      assert.equal(r.caps.NoNewPrivs, '1', ctx(w, `${p}: NoNewPrivs is not set`));
      assert.notEqual(r.umountTmp, 0, ctx(w, `${p}: \`umount -l /tmp\` succeeded`));
      assert.notEqual(r.remountHome, 0, ctx(w, `${p}: a remount of the home succeeded`));
    },
    control: null,
    deeper: '"⭐ ARM: inside `isolated` CapInh, CapPrm, CapEff, CapAmb are 0", "⭐ CONTROL: a raw `unshare -rnm` gives the command EVERY capability", "⛔ LOCKING …"' },
  { n: 6, property: 'env allowlist',
    arm: (r, w, p) => assert.equal(r.unknownVar, null, ctx(w, `${p}: a planted unknown var reached the command`)),
    control: (w) => {
      assert.equal(w.outside.outside.unknownVar, 'planted', 'control: the planted var is not set outside');
      // --pass-env passes it — on the call that names it (fresh); a nested call honours only its OWN --pass-env
      assert.equal(w.arm.fresh.passedVar, 'passed', 'fresh: --pass-env ARM_PASSED_VAR did not pass it');
      assert.equal(w.arm.nested.passedVar, null, 'nested: the OUTER call\'s --pass-env leaked into a nested call');
    },
    deeper: '"⛔ env ALLOWLIST: planted FAKE_API_KEY, CLIAI_*, …", "⭐ --pass-env NAME passes exactly that name", "⛔ the NESTED path keeps the allowlist"' },
  { n: 7, property: 'writable only where declared',
    arm: (r, w, p) => {
      for (const k of ['home', 'keepRo', 'baseRoot']) assert.equal(r.writes[k], 'EROFS', ctx(w, `${p}: ${k} is writable (${r.writes[k]})`));
      // ⛔ R1: EVERYTHING else — a user-owned dir outside the home, the cwd, the keeps and /tmp
      assert.equal(r.writes.outsideHome, 'EROFS', ctx(w, `${p}: a user-owned dir outside the home is writable (${r.writes.outsideHome})`));
      // ⛔ …and it locks nothing over /proc or /sys: nested procfs/sysfs mounts still work (ruling on F2)
      assert.equal(r.overProcNonDir, 0, ctx(w, `${p}: ${r.overProcNonDir} mount(s) lie over /proc FILES (a new procfs would be refused)`));
      assert.equal(r.overSysNonDir, 0, ctx(w, `${p}: a mount lies over a /sys FILE (a new sysfs would be refused)`));
      assert.equal(r.nestedProc, 0, ctx(w, `${p}: the nested path's \`unshare -U -m --pid --fork --mount-proc\` fails`));
      assert.equal(r.strippedPrefix, 0, ctx(w, `${p}: the stripped-markers path's \`unshare -rnm --uts --ipc --pid --fork --mount-proc\` fails`));
      assert.equal(r.nestedSysfs, 0, ctx(w, `${p}: a fresh sysfs in a nested user+net namespace (row 10's) is refused`));
    },
    control: (w) => {
      for (const p of PATHS) {
        assert.equal(w.arm[p].writes.cwd, 'ok', `${p}: the cwd is not writable`);
        assert.equal(w.arm[p].writes.keep, 'ok', `${p}: the --keep dir is not writable`);
        assert.equal(w.arm[p].writes.keepOutside, 'ok', `${p}: a --keep OUTSIDE the home and /tmp is not writable`);
        // the read-only root must not take procfs writes or nested namespaces away (Chromium's sandbox)
        assert.equal(w.arm[p].procWrite, 'ok', `${p}: /proc/self/oom_score_adj is not writable`);
        assert.equal(w.arm[p].nestedUserns, 0, `${p}: a nested \`unshare -rn\` fails`);
      }
      assert.equal(w.outside.outside.writes.home, 'ok', 'control: the (fake) home is not writable outside');
      assert.equal(w.outside.outside.writes.outsideHome, 'ok', 'control: the user-owned dir outside the home is not writable outside');
    },
    deeper: '"⭐ ARM: creating a new file directly under the passwd home → EROFS", "⛔ base\'s repo root is READ-ONLY …", the submount arms' },
  { n: 8, property: 'no host-shared scratch (/dev/shm, /var/tmp, SysV IPC, POSIX mqueues)',
    arm: (r, w, p, untested) => {
      assert.equal(r.shmPlanted, 'ENOENT', ctx(w, `${p}: a file planted in the host's /dev/shm is visible inside`));
      assert.equal(r.vartmpPlanted, 'ENOENT', ctx(w, `${p}: a file planted in the host's /var/tmp is visible inside`));
      assert.deepEqual(w.post.shmLeft, [], ctx(w, `${p}: a write to /dev/shm inside is visible outside`));
      assert.deepEqual(w.post.vartmpLeft, [], ctx(w, `${p}: a write to /var/tmp inside is visible outside`));
      // ⛔ a half this host cannot test is NAMED (untested → the ARM is reported SKIP, never a green pass)
      if (!w.cfg.ipcmk) { untested.add('no ipcmk in the system dirs: the SysV IPC and POSIX mqueue halves are UNTESTED'); return; }
      assert.equal(r.shmListed, false, ctx(w, `${p}: the host's SysV shm segment is listed by \`ipcs -m\` inside`));
      if (w.cfg.python) assert.match(String(r.shmAttach), /^failed /, ctx(w, `${p}: shmat of the host's segment by id succeeded (${r.shmAttach})`));
      else untested.add('no python3 in the system dirs: the shmat attach-and-write half is UNTESTED');
      if (w.post.shmNow !== undefined) assert.equal(w.post.shmNow, 'outside', ctx(w, `${p}: a write through shmat inside reached the host's segment`));
      if (r.mqPlanted === undefined || !w.post.mqLeft) { untested.add('no /dev/mqueue planted: the POSIX mqueue half is UNTESTED'); return; }
      assert.equal(r.mqPlanted, 'ENOENT', ctx(w, `${p}: the host's POSIX mqueue is visible in /dev/mqueue`));
      assert.deepEqual(w.post.mqLeft, [], ctx(w, `${p}: a POSIX mqueue made inside is in the host's /dev/mqueue`));
    },
    control: (w, t) => {
      assert.equal(w.outside.outside.shmPlanted, 'ok', 'control: the planted /dev/shm file is not readable outside');
      assert.equal(w.outside.outside.vartmpPlanted, 'ok', 'control: the planted /var/tmp file is not readable outside');
      assert.equal(w.post.shmControl, true, 'control: a write to /dev/shm OUTSIDE did not stay (the read-back cannot see)');
      for (const p of PATHS) {
        assert.equal(w.arm[p].shmSelf, 'ok', `${p}: a file made in /dev/shm inside is not readable inside`);
        assert.equal(w.arm[p].vartmpSelf, 'ok', `${p}: a file made in /var/tmp inside is not readable inside`);
      }
      if (!w.cfg.ipcmk) { t.diagnostic('control: no ipcmk in the system dirs — the SysV IPC / mqueue arms are UNTESTED here'); return; }
      const o = w.outside.outside;
      assert.equal(o.shmListed, true, 'control: the planted segment is not listed by `ipcs -m` outside');
      if (w.cfg.python) {
        assert.equal(o.shmAttach, 'wrote', 'control: shmat + write of the planted segment fails outside');
        assert.equal(w.post.shmAfterOutside, 'outside', 'control: the read-back does not see the write made outside');
      } else t.diagnostic('control: no python3 in the system dirs — the shmat write arm is UNTESTED here');
      for (const p of PATHS) assert.equal(w.arm[p].shmSegSelf, true, `${p}: a segment made inside is not listed inside`);
      if (o.mqPlanted === undefined) { t.diagnostic('control: no /dev/mqueue here — the POSIX mqueue arm is UNTESTED'); return; }
      assert.equal(o.mqPlanted, 'ok', 'control: the planted mqueue is not visible outside');
      assert.equal(w.post.mqControl, true, 'control: an mqueue made OUTSIDE did not stay (the read-back cannot see)');
      for (const p of PATHS) assert.equal(w.arm[p].mqSelf, 'ok', `${p}: an mqueue made inside is not visible inside`);
    },
    deeper: '"⛔ a --keep under /dev/shm or /var/tmp is re-bound" (contract-harness-isolation.test.js)' },
  { n: 9, property: 'no host keyring',
    arm: (r, w, p) => {
      assert.equal(r.keyShowStatus, 0, ctx(w, `${p}: \`keyctl show @s\` failed`));
      assert.equal(r.keyShowNamesHost, false, ctx(w, `${p}: \`keyctl show @s\` names the HOST's planted key`));
      assert.notEqual(r.keySearch, 0, ctx(w, `${p}: the host's planted key is found from inside`));
      // 9b — what is GUARANTEED (ruling on F2): a possessor-only payload is unreadable without possession.
      // ⚠ Its DESCRIPTION is not hidden (user view bit; /proc/keys, rdescribe) — the documented residual.
      assert.equal(r.keyPayload, 'EACCES', ctx(w, `${p}: the host key's possessor-only payload is readable by id (${r.keyPayload})`));
      assert.deepEqual(w.post.keysLeft, [], ctx(w, `${p}: a key added inside is in the host's session keyring`));
    },
    control: (w, t) => {
      assert.equal(w.outside.outside.keyShowNamesHost, true, 'control: `keyctl show @s` outside does not name the planted key');
      assert.equal(w.outside.outside.keySearch, 0, 'control: the planted key is not found outside');
      for (const p of PATHS) assert.equal(w.arm[p].keySelf, 'v', `${p}: a key added inside is not readable inside`);
      assert.equal(w.outside.outside.keyPayload, 'READ', 'control: the planted key\'s payload is not readable outside (where it is possessed)');
      for (const p of PATHS) {
        if (w.arm[p].keyDescribe === 0) t.diagnostic(`${p}: the host key's DESCRIPTION is readable by id — the documented residual (ib4k §1a row 9)`);
      }
    },
    deeper: '"⛔ keyctl missing → the run goes ahead and the verdict says keyring: shared"' },
  { n: 10, property: 'no host identity',
    arm: (r, w, p) => {
      assert.equal(r.hostnameIsNeutral, true, ctx(w, `${p}: the hostname is not the neutral one`));
      assert.notEqual(r.hostname, w.outside.outside.hostname, ctx(w, `${p}: the hostname is the host's`));
      assert.deepEqual(r.netNames, ['lo'], ctx(w, `${p}: /sys/class/net does not list exactly lo`));
      assert.equal(r.netNonLo, 0, ctx(w, `${p}: /sys/class/net lists a host interface`));
      assert.equal(r.virtNonLo, 0, ctx(w, `${p}: /sys/devices/virtual/net lists a host interface`));
      assert.ok(r.machineId === '<ENOENT>' || r.machineId === digest(harness.NEUTRAL_MACHINE_ID || '-unset-'),
        ctx(w, `${p}: /etc/machine-id is neither absent nor the neutral one`));
      assert.ok(r.etcHostname === '<ENOENT>' || r.etcHostnameIsNeutral, ctx(w, `${p}: /etc/hostname is the host's`));
      if (r.machineId !== '<ENOENT>') {
        assert.equal(r.machineIdTamper, 'unchanged', ctx(w, `${p}: /etc/machine-id was REWRITTEN through its backing copy (chmod + write)`));
      }
    },
    control: (w, t) => {
      const o = w.outside.outside;
      assert.equal(o.machineIdTamper, 'changed', 'control: chmod + write of a read-only bind\'s backing file does not change it — the tamper arm cannot fail');
      assert.equal(o.hostnameIsNeutral, false, 'control: the host is itself named webctl-isolated — the arm cannot tell');
      if (o.netNonLo === 0) t.diagnostic('control: this host has only lo — the /sys/class/net arm is UNTESTED here, not passed');
      else assert.ok(o.netNonLo > 0);
      if (o.virtNonLo === 0) t.diagnostic('control: this host has no virtual interface besides lo — the /sys/devices/virtual/net arm is UNTESTED here');
      else assert.ok(o.virtNonLo > 0);
      if (/^<.*>$/.test(o.machineId)) t.diagnostic('control: this host has no /etc/machine-id — that arm is UNTESTED here');
      else assert.notEqual(o.machineId, digest(harness.NEUTRAL_MACHINE_ID || '-unset-'), 'control: the host machine-id IS the neutral one');
    },
    deeper: '"⛔ /etc/machine-id: what a neutral one breaks" (contract-harness-isolation.test.js)' },
  { n: 11, property: 'no loader injection into the privileged half',
    arm: (r, w, p) => {
      const privileged = w.hits.filter((/** @type {any} */ h) => h.ppid !== w.worldPid
        && (h.argv.some((/** @type {string} */ a) => /^__isolated-/.test(a)) || !ZERO.test(h.cap || 'x')));
      assert.deepEqual(privileged, [], ctx(w, `${p}: a NODE_OPTIONS preload ran in a privileged half (an __isolated-* node, or with capabilities)`));
    },
    control: (w) => {
      for (const p of PATHS) {
        assert.equal(w.arm[p].nodeOptions, true, `${p}: the command does not see NODE_OPTIONS`);
        assert.ok(w.hits.some((/** @type {any} */ h) => h.argv.includes(p)), `${p}: the preload did not run in the command`);
      }
    },
    deeper: '"⛔ NODE_OPTIONS never reaches a PRIVILEGED half", "⛔ `--pass-env LD_*` never reaches a privileged half", the planted-tool arms' },
  { n: 12, property: 'no host devices',
    arm: (r, w, p, untested) => {
      const o = w.outside.outside;
      assert.equal(r.devExtra, 0, ctx(w, `${p}: /dev holds ${r.devExtra} entr(y/ies) beyond the minimal set (null zero full random urandom tty pts ptmx shm mqueue fd stdin stdout stderr)`));
      assert.notEqual(r.ptsDev, o.ptsDev, ctx(w, `${p}: /dev/pts is the HOST's devpts instance`));
      // ⛔ each host device this host lacks is NAMED (the ARM is then a SKIP, never a pass)
      if (o.uinput === 'ok') assert.equal(r.uinput, 'ENOENT', ctx(w, `${p}: the host's /dev/uinput is present (virtual-keyboard injection)`));
      else untested.add('no /dev/uinput on this host: that arm is UNTESTED');
      if (o.snd === 'ok') assert.equal(r.snd, 'ENOENT', ctx(w, `${p}: the host's /dev/snd is present`));
      else untested.add('no /dev/snd on this host: that arm is UNTESTED');
      if (typeof o.ptsNumbered === 'number' && o.ptsNumbered > 0) assert.equal(r.ptsNumbered, 0, ctx(w, `${p}: ${r.ptsNumbered} host terminal(s) listed in /dev/pts`));
      else untested.add('no /dev/pts/N open on this host: the host-terminal arm is UNTESTED');
    },
    control: (w) => {
      assert.ok(w.outside.outside.devExtra > 0, 'control: the host /dev holds nothing beyond the minimal set — the arm cannot fail');
      for (const p of PATHS) {
        const r = w.arm[p];
        // what a lane plausibly needs from /dev still works (a pty, /dev/null, /dev/urandom, /dev/tty, /dev/fd)
        assert.equal(r.ptmxOpen, 'ok', `${p}: /dev/ptmx cannot be opened (${r.ptmxOpen})`);
        assert.equal(r.ptyScript, 0, `${p}: \`script -qc true /dev/null\` (a pty, master AND slave) fails (${r.ptyScript})`);
        assert.equal(r.devNullWrite, 'ok', `${p}: /dev/null cannot be written (${r.devNullWrite})`);
        assert.equal(r.urandomRead, 'ok', `${p}: /dev/urandom cannot be read (${r.urandomRead})`);
        assert.equal(r.ttyNode, 'ok', `${p}: /dev/tty is not a char device (${r.ttyNode})`);
        assert.equal(r.fdLink, 'ok', `${p}: /dev/fd cannot be listed (${r.fdLink})`);
        // Chromium's sandbox: /dev/shm writable (row 8's shmSelf) and a nested user + PID namespace with its own /proc
        assert.equal(r.shmSelf, 'ok', `${p}: /dev/shm is not writable`);
        assert.equal(r.nestedPidProc, 0, `${p}: a nested \`unshare -Ur --pid --fork --mount-proc\` fails`);
      }
    },
    deeper: '"⛔ a --keep under /dev is refused" (contract-harness-isolation.test.js)' },
];

/**
 * Rows MEASURED OPEN on a backend — a `todo` (red, visible, not a pass) until the commit that closes
 * them empties the entry. ⛔ Never add a row here to get a suite green: it is the record of a gap.
 * @type {Record<string, number[]>}
 */
const OPEN_ROWS = { unshare: [] };

for (const backend of IMPLEMENTED) {
  for (const row of ROWS) {
    const open = (OPEN_ROWS[backend] || []).includes(row.n)
      ? { todo: `OPEN on ${backend}: measured in v0.33 (CHANGELOG "does NOT cover"), closed in v0.34` } : {};
    test(`[${backend}] row ${row.n} — ${row.property}: ARM on the fresh, nested and stripped-markers paths`, open, async (t) => {
      if (row.n === 9 && !KEYCTL) { t.skip(NO_KEYCTL); return; }
      const w = await world(backend);
      if (w.skip) { t.skip(w.skip); return; }
      if (row.n === 9 && w.outside.outside.keyShowStatus !== 0) { t.skip(KEYRING_UNVERIFIED); return; }
      assert.ok(!w.broken, w.broken);
      assert.equal(w.armStatus, 0, ctx(w, `the arm run exited ${w.armStatus}`));
      assert.match(w.armErr, new RegExp(`^isolated: home HIDDEN; .*backend: ${backend}`, 'm'), ctx(w, 'the verdict does not name the backend'));
      /** @type {Set<string>} what this host could not test — named, and the ARM is then a SKIP, never a pass */
      const untested = new Set();
      for (const p of PATHS) {
        assert.ok(w.arm[p], ctx(w, `no reading from the ${p} path`));
        row.arm(w.arm[p], w, p, untested);
      }
      if (untested.size) t.skip(`SKIP (host): ${[...untested].join('; ')} — the rest of the ARM passed`);
    });
    test(`[${backend}] row ${row.n} — ${row.property}: CONTROL (the arm can fail)`, async (t) => {
      if (row.n === 9 && !KEYCTL) { t.skip(NO_KEYCTL); return; }
      const w = await world(backend);
      if (w.skip) { t.skip(w.skip); return; }
      if (row.n === 9 && w.outside.outside.keyShowStatus !== 0) { t.skip(KEYRING_UNVERIFIED); return; }
      assert.ok(!w.broken, w.broken);
      if (!row.control) { t.diagnostic('no control by design (ib4k §1: —) — see the deeper arms'); assert.ok(w.outside.outside); return; }
      assert.ok(w.outside.outside, 'no reading from outside');
      row.control(w, t);
    });
  }
}

test('⛔ the table covers EVERY backend the harness can run — extend IMPLEMENTED when one lands', async () => {
  for (const b of harness.ISOLATION_BACKENDS) {
    const r = spawnSync(process.execPath, [TOOL, 'isolated', '--', 'true'], { encoding: 'utf8',
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), WEBCTL_ISOLATION_BACKEND: b } });
    if (r.status === 0) assert.ok(IMPLEMENTED.includes(b), `the harness runs the ${b} backend, but the arm table does not judge it`);
    else assert.match(r.stderr, new RegExp(`NOT RUN: WEBCTL_ISOLATION_BACKEND pins the ${b} backend`), r.stderr);
  }
  assert.deepEqual(ROWS.map((r) => r.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'ib4k §1 has rows 1–12');
});

/** Row 9 where `keyctl show @s` fails (review F5): a named SKIP — isolated says "keyring: unverified". */
const KEYRING_UNVERIFIED = 'SKIP (host): `keyctl show @s` fails here — the keyring row is UNVERIFIED (isolated says "keyring: unverified")';
/** Row 9 without keyctl: a named SKIP — untested, never a pass. */
const NO_KEYCTL = 'SKIP (host): keyctl not installed — the keyring row is UNTESTED here (isolated says "keyring: shared")';
