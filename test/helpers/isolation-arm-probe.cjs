// isolation-arm-probe.cjs — ONE reading of every ib4k §1 property, from wherever it runs.
//
// Run by test/isolation-arm-table.test.js: once OUTSIDE `isolated` (the controls) and, per backend,
// INSIDE it on all three paths — fresh, nested, stripped markers. Prints one line:
//   ARM-RESULT {"mode": …, …}
// ⚠ It never prints a host value it reads (hostname, machine-id, interface names): the table
// compares them as booleans, so a failing run's log carries no host identity.
// argv: <mode: outside|fresh|nested|stripped> <config.json>
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const [mode, cfgPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const inside = mode !== 'outside';
/** Row 12: everything a fresh `isolated` /dev may hold (ib4k §1 row 12, like `bwrap --dev`). */
const MINIMAL_DEV = ['null', 'zero', 'full', 'random', 'urandom', 'tty', 'pts', 'ptmx', 'shm', 'mqueue', 'fd', 'stdin', 'stdout', 'stderr'];

/** @param {() => unknown} f */
const errOf = (f) => { try { f(); return 'ok'; } catch (e) { return e.code || String(e.message); } };
/** @param {string} s */
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
/** @param {net.NetConnectOpts} o */
const connect = (o) => new Promise((resolve) => {
  const s = net.connect(o);
  const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, 1500);
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('CONNECTED'); });
  s.on('error', (e) => { clearTimeout(t); resolve(e.code || 'ERROR'); });
});
/** A server made HERE answers a client made here. @param {net.ListenOptions} o @param {(srv: net.Server) => net.NetConnectOpts} to */
const selfServe = (o, to) => new Promise((resolve) => {
  const srv = net.createServer((s) => s.destroy());
  srv.on('error', (e) => resolve(e.code || 'ERROR'));
  srv.listen(o, async () => { const r = await connect(to(srv)); srv.close(); resolve(r); });
});
/** @param {string} dir */
const tryWrite = (dir) => errOf(() => {
  const f = path.join(dir, `.arm-w-${mode}-${process.pid}`);
  fs.writeFileSync(f, 'x', { flag: 'wx' });
  fs.unlinkSync(f);
});
/** @param {string[]} a */
const run = (a) => spawnSync(a[0], a.slice(1), { encoding: 'utf8' });

/**
 * Try to change what `target` (a file BIND) reads WITHOUT writing through it: find its backing file
 * from /proc/self/mountinfo (another mount of the same device whose root is a prefix of the bind's
 * root), chmod it writable and write it. 'changed' | 'unchanged' | '<errno>' (target unreadable).
 * ⚠ The content is never returned: only whether it moved.
 * @param {string} target
 */
const tamper = (target) => {
  let before = '';
  try { before = fs.readFileSync(target, 'utf8'); } catch (e) { return `<${e.code}>`; }
  const unesc = (/** @type {string} */ x) => x.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const rows = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean)
    .map((l) => l.split(' ')).map((f) => ({ dev: f[2], root: unesc(f[3]), at: unesc(f[4]) }));
  const bind = rows.filter((r) => r.at === target).pop();
  if (bind) {
    for (const m of rows) {
      if (m.dev !== bind.dev || m === bind || !(bind.root === m.root || bind.root.startsWith(m.root === '/' ? '/' : `${m.root}/`))) continue;
      const backing = path.join(m.at, bind.root.slice(m.root === '/' ? 0 : m.root.length));
      try { fs.chmodSync(backing, 0o644); } catch { /* not ours, or read-only */ }
      try { fs.writeFileSync(backing, 'tampered-by-arm\n'); } catch { /* read-only, or gone */ }
    }
  }
  try { fs.writeFileSync(target, 'tampered-by-arm\n'); } catch { /* through the bind: EROFS */ }
  let after = '';
  try { after = fs.readFileSync(target, 'utf8'); } catch (e) { return `<${e.code}>`; }
  return after === before ? 'unchanged' : 'changed';
};

(async () => {
  /** @type {Record<string, unknown>} */
  const out = { mode };
  // 1 — no host network
  out.hostPort = await connect({ port: cfg.port, host: '127.0.0.1' });
  try {
    out.nonLo = fs.readFileSync('/proc/self/net/dev', 'utf8').split('\n').slice(2)
      .map((l) => l.split(':')[0].trim()).filter((n) => n && n !== 'lo').length;
  } catch (e) { out.nonLo = e.code; }
  out.selfListener = await selfServe({ port: 0, host: '127.0.0.1' }, (s) => ({ port: /** @type {net.AddressInfo} */ (s.address()).port, host: '127.0.0.1' }));
  // 2 — no host unix sockets: the test's own (named like the real ones), and, INSIDE only, the real conventional paths
  out.hostSockets = {};
  for (const [name, p] of Object.entries(cfg.sockets)) out.hostSockets[name] = await connect({ path: p });
  if (inside) {
    out.realSockets = {};
    for (const p of ['/var/run/docker.sock', '/run/docker.sock', '/tmp/.X11-unix/X0', `/run/user/${cfg.uid}/bus`]) {
      out.realSockets[p] = await connect({ path: p });
    }
  }
  const selfSock = path.join(os.tmpdir(), `arm-${mode}-${process.pid}.sock`);
  out.selfSocket = await selfServe({ path: selfSock }, () => ({ path: selfSock }));
  try { fs.unlinkSync(selfSock); } catch { /* gone */ }
  // 3 — no host processes
  out.hostPid = errOf(() => process.kill(cfg.hostPid, 0));
  // 3 — …nor through the cgroup tree: the CALLER's own cgroup.kill and cgroup.procs, OPENED for write
  // and closed at once. ⛔ Never written: a write to cgroup.kill kills every process of the caller's scope.
  if (cfg.cgroup) {
    out.cgroupOpen = {};
    for (const f of ['cgroup.kill', 'cgroup.procs']) {
      out.cgroupOpen[f] = errOf(() => fs.closeSync(fs.openSync(path.join('/sys/fs/cgroup', cfg.cgroup, f), fs.constants.O_WRONLY)));
    }
  }
  // 4 — the home hidden; --keep-ro readable, not writable
  out.sshConfig = errOf(() => fs.readFileSync(path.join(cfg.home, '.ssh', 'config')));
  out.webctlConfig = errOf(() => fs.readFileSync(path.join(cfg.home, '.config', 'webctl', 'config.toml')));
  out.keepRoRead = errOf(() => fs.readFileSync(path.join(cfg.keepRo, 'ro.txt')));
  out.keepRoWrite = tryWrite(cfg.keepRo);
  // 5 — no privilege
  const st = Object.fromEntries(fs.readFileSync('/proc/self/status', 'utf8').split('\n').map((l) => l.split(':\t'))
    .filter((f) => f.length === 2).map(([k, v]) => [k, v.trim()]));
  out.caps = { CapInh: st.CapInh, CapPrm: st.CapPrm, CapEff: st.CapEff, CapAmb: st.CapAmb, NoNewPrivs: st.NoNewPrivs };
  if (inside) {
    out.umountTmp = run(['umount', '-l', '/tmp']).status;
    out.remountHome = run(['mount', '-o', 'remount,bind,rw', cfg.home]).status;
  }
  // 6 — the env allowlist
  out.unknownVar = process.env.ARM_UNKNOWN_VAR ?? null;
  out.passedVar = process.env.ARM_PASSED_VAR ?? null;
  // 7 — writable only where declared
  out.writes = { cwd: tryWrite(process.cwd()), keep: tryWrite(cfg.keep), home: tryWrite(cfg.home), keepRo: out.keepRoWrite,
    ...(inside ? { baseRoot: tryWrite(cfg.baseRoot) } : {}), outsideHome: tryWrite(cfg.outsideHome), keepOutside: tryWrite(cfg.keepOutside) };
  // 7 (R1): what the read-only root must NOT take away — procfs writes (Chromium's sandbox writes
  // oom_score_adj and a nested userns's uid_map) and a nested user namespace
  out.procWrite = errOf(() => fs.writeFileSync('/proc/self/oom_score_adj', fs.readFileSync('/proc/self/oom_score_adj', 'utf8')));
  out.nestedUserns = run(['unshare', '-rn', 'true']).status;
  if (inside) {
    // 7 (R1, ruling on F2): the read-only root must not lock anything over /proc or /sys — a new procfs
    // or sysfs in a child userns needs a FULLY VISIBLE one (mnt_already_visible). So: the nested path's
    // prefix, the stripped-markers path's prefix, and the fresh sysfs row 10 mounts, all rc 0
    out.nestedProc = run(['unshare', '-U', '-m', '--pid', '--fork', '--mount-proc', 'true']).status;
    out.strippedPrefix = run(['unshare', '-rnm', '--uts', '--ipc', '--pid', '--fork', '--mount-proc', 'true']).status;
    out.nestedSysfs = run(['unshare', '-rnm', 'sh', '-c', 'mount -t sysfs arm-sysfs /sys']).status;
    const at = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[4]
      .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
    // ⚠ the kernel's rule: a locked mount over a NON-directory blocks a new procfs/sysfs (one over an
    // empty dir does not — the host's own binfmt_misc on /proc/sys/fs/binfmt_misc is such a dir)
    const nonDir = (/** @type {string} */ p) => { try { return !fs.statSync(p).isDirectory(); } catch { return true; } };
    out.overProcNonDir = at.filter((p) => p.startsWith('/proc/')).filter(nonDir).length;
    out.overSysNonDir = at.filter((p) => p.startsWith('/sys/')).filter(nonDir).length;
  }
  // 8 — no host-shared scratch: the world's planted files; a file made here, read back here
  out.shmPlanted = errOf(() => fs.readFileSync(path.join('/dev/shm', cfg.planted)));
  out.vartmpPlanted = errOf(() => fs.readFileSync(path.join('/var/tmp', cfg.planted)));
  out.shmSelf = errOf(() => { const f = path.join('/dev/shm', `arm-inside-${mode}`); fs.writeFileSync(f, 'x'); fs.readFileSync(f); });
  out.vartmpSelf = errOf(() => { const f = path.join('/var/tmp', `arm-inside-${mode}`); fs.writeFileSync(f, 'x'); fs.readFileSync(f); });
  // 8 (IPC) — the world's SysV segment and POSIX mqueue (cfg.ipcFile): listed? attachable — and a write
  // through an attach (python ctypes shmat) lands where? A segment and a queue made HERE, seen here.
  let ipc = null;
  try { ipc = JSON.parse(fs.readFileSync(cfg.ipcFile, 'utf8')); } catch { /* no ipcmk: the world planted none */ }
  if (ipc) {
    out.shmListed = String(run(['ipcs', '-m']).stdout).split('\n').map((l) => l.trim().split(/\s+/))
      .some((f) => f[1] === String(ipc.shmid) && /^0x[0-9a-f]+$/i.test(f[0]) && (parseInt(f[0], 16) >>> 0) === ipc.key);
    if (cfg.python) {
      const w = run([cfg.python, '-I', '-c', cfg.shmPy, String(ipc.shmid), 'w', inside ? `inside-${mode}` : 'outside']);
      out.shmAttach = String(w.stdout).trim() || `exit ${w.status}`;
    }
    const mk = String(run(['ipcmk', '-M', '64']).stdout).match(/(\d+)\s*$/);
    out.shmSegSelf = !!mk && String(run(['ipcs', '-m']).stdout).split('\n').some((l) => l.trim().split(/\s+/)[1] === mk[1]);
    if (mk) run(['ipcrm', '-m', mk[1]]);
    if (ipc.mq) {
      out.mqPlanted = errOf(() => fs.statSync(path.join('/dev/mqueue', ipc.mq)));
      out.mqSelf = errOf(() => { const f = path.join('/dev/mqueue', `arm-inside-${mode}-mq`); fs.closeSync(fs.openSync(f, 'w')); fs.statSync(f); });
    }
  }
  // 9 — no host keyring (cfg.keyName was added to the WORLD's session keyring before any of this ran)
  if (cfg.keyctl) {
    const show = run(['keyctl', 'show', '@s']);
    out.keyShowStatus = show.status;
    out.keyShowNamesHost = String(show.stdout).includes(cfg.keyName);
    out.keySearch = run(['keyctl', 'search', '@s', 'user', cfg.keyName]).status;
    // 9b: the planted key's PAYLOAD by id — possessor-only read → EACCES inside (no possession); its
    // DESCRIPTION stays readable under the user view bit (the documented residual, a diagnostic only)
    let kid = '';
    try { kid = fs.readFileSync(cfg.keyIdFile, 'utf8').trim(); } catch { /* none planted */ }
    if (kid) {
      const pr = run(['keyctl', 'print', kid]);
      out.keyPayload = pr.status === 0 ? (String(pr.stdout).trim() === 'planted-by-test' ? 'READ' : 'other')
        : /Permission denied/.test(String(pr.stderr)) ? 'EACCES' : `exit ${pr.status}`;
      out.keyDescribe = run(['keyctl', 'rdescribe', kid]).status;
    }
    const mine = `${cfg.keyName}-inside-${mode}`;
    const add = run(['keyctl', 'add', 'user', mine, 'v', '@s']);
    out.keySelf = add.status === 0 ? run(['keyctl', 'print', String(add.stdout).trim()]).stdout.trim() : `add-failed ${add.status}`;
  }
  // 10 — no host identity (DIGESTS only: never a host value in a log)
  out.hostname = digest(os.hostname());
  out.hostnameIsNeutral = os.hostname() === 'webctl-isolated';
  let names = [];
  try { names = fs.readdirSync('/sys/class/net').sort(); } catch (e) { names = [`<${e.code}>`]; }
  out.netNames = names.filter((n) => n === 'lo' || /^<.*>$/.test(n));
  out.netNonLo = names.filter((n) => n !== 'lo' && !/^<.*>$/.test(n)).length;
  let virt = [];
  try { virt = fs.readdirSync('/sys/devices/virtual/net'); } catch { /* absent */ }
  out.virtNonLo = virt.filter((n) => n !== 'lo').length;
  let mid = '';
  try { mid = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch (e) { mid = `<${e.code}>`; }
  out.machineId = /^<.*>$/.test(mid) ? mid : digest(mid);
  let eh = '';
  try { eh = fs.readFileSync('/etc/hostname', 'utf8').trim(); } catch (e) { eh = `<${e.code}>`; }
  out.etcHostname = /^<.*>$/.test(eh) ? eh : digest(eh);
  out.etcHostnameIsNeutral = eh === 'webctl-isolated';
  // row 10 (F6): the neutral file cannot be rewritten through its BACKING copy (chmod + write); the
  // control is the same routine against a read-only bind the world made outside (cfg.tamperDst)
  out.machineIdTamper = inside ? tamper('/etc/machine-id') : tamper(cfg.tamperDst);
  // 11 — loader vars: the command still sees NODE_OPTIONS (its preload logged this process)
  out.nodeOptions = !!process.env.NODE_OPTIONS;
  // 12 — no host devices: EXISTENCE only. ⛔ /dev/uinput is never opened here and no /dev/pts/N is
  // touched — a stat, and a readdir of /dev and /dev/pts, are the whole reading.
  let devNames = [];
  try { devNames = fs.readdirSync('/dev'); } catch (e) { devNames = [`<${e.code}>`]; }
  out.devExtra = devNames.filter((n) => !MINIMAL_DEV.includes(n)).length;
  out.uinput = errOf(() => fs.statSync('/dev/uinput'));
  out.snd = errOf(() => fs.statSync('/dev/snd'));
  try { out.ptsNumbered = fs.readdirSync('/dev/pts').filter((n) => /^\d+$/.test(n)).length; } catch (e) { out.ptsNumbered = `<${e.code}>`; }
  try { out.ptsDev = String(fs.statSync('/dev/pts').dev); } catch (e) { out.ptsDev = `<${e.code}>`; }
  if (inside) {
    // what a lane plausibly needs from /dev, read AFTER the listing above (a pty made here is ours)
    out.ptmxOpen = errOf(() => fs.closeSync(fs.openSync('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY)));
    // `script` opens the pty's SLAVE too (/dev/pts/N of OUR devpts) — a nodev devpts fails here
    const sc = run(['script', '-qc', 'true', '/dev/null']);
    out.ptyScript = sc.error ? `<${sc.error.code}>` : sc.status;
    out.devNullWrite = errOf(() => fs.writeFileSync('/dev/null', 'x'));
    out.urandomRead = errOf(() => { const fd = fs.openSync('/dev/urandom', 'r'); try { if (fs.readSync(fd, Buffer.alloc(16)) !== 16) throw new Error('short'); } finally { fs.closeSync(fd); } });
    out.ttyNode = errOf(() => { if (!fs.statSync('/dev/tty').isCharacterDevice()) throw new Error('not a char device'); });
    out.fdLink = errOf(() => fs.readdirSync('/dev/fd'));
    // Chromium's sandbox: a nested user + PID namespace with its own /proc
    out.nestedPidProc = run(['unshare', '-Ur', '--pid', '--fork', '--mount-proc', 'true']).status;
  }
  process.stdout.write(`ARM-RESULT ${JSON.stringify(out)}\n`);
})();
