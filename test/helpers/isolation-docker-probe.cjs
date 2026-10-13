// isolation-docker-probe.cjs — ONE reading of every ib4k §1 property under the DOCKER backend, from wherever it runs.
//
// Run by test/isolation-docker-table.test.js once OUTSIDE (the controls, on the real host — read-only there except
// its own throwaway files) and INSIDE `isolated` on all three paths: fresh, nested, stripped markers. The image has
// no ipcs, keyctl or python, so each reading uses what node and /proc give. Prints one line: ARM-RESULT {…}.
// ⚠ It never prints a host value it reads (hostname, machine-id, interface names): digests and booleans only.
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
/** @param {net.ListenOptions} o @param {(srv: net.Server) => net.NetConnectOpts} to */
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
/** @param {string} f */
const status = (f) => { try { return Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').map((l) => l.split(':\t')).filter((x) => x.length === 2).map(([k, v]) => [k, v.trim()])); } catch { return {}; } };
/** @param {string} d */
const list = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return [`<${e.code}>`]; } };

(async () => {
  /** @type {Record<string, any>} */
  const out = { mode };
  // 1 — no host network
  out.hostPort = await connect({ port: cfg.port, host: '127.0.0.1' });
  out.interfaces = list('/sys/class/net').filter((n) => n !== 'lo').length;
  out.selfTcp = await selfServe({ port: 0, host: '127.0.0.1' }, (s) => ({ port: /** @type {net.AddressInfo} */ (s.address()).port, host: '127.0.0.1' }));
  // 2 — no host unix sockets
  out.hostSocket = await connect({ path: cfg.socket });
  out.daemonSocket = { var: await connect({ path: '/var/run/docker.sock' }), run: await connect({ path: '/run/docker.sock' }) };
  out.bus = await connect({ path: `/run/user/${cfg.uid}/bus` });
  const own = path.join(os.tmpdir(), `.arm-sock-${mode}-${process.pid}`);
  out.selfUnix = await selfServe({ path: own }, () => ({ path: own }));
  // 3 — no host processes, no writable caller cgroup
  out.hostPid = errOf(() => process.kill(cfg.hostPid, 0));
  out.cgroupHost = {};
  for (const f of ['cgroup.kill', 'cgroup.procs']) out.cgroupHost[f] = errOf(() => fs.closeSync(fs.openSync(path.join('/sys/fs/cgroup', cfg.cgroup, f), fs.constants.O_WRONLY)));
  const own3 = (fs.readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*)$/m) || [])[1] || '';
  out.cgroupOwn = errOf(() => fs.closeSync(fs.openSync(path.join('/sys/fs/cgroup', own3, 'cgroup.kill'), fs.constants.O_WRONLY)));
  // 4 — the home HIDDEN (existence only: nothing of the real home is ever read)
  out.sshDir = errOf(() => fs.statSync(path.join(cfg.home, '.ssh')));
  out.configDir = errOf(() => fs.statSync(path.join(cfg.home, '.config')));
  out.homeEntries = list(cfg.home).filter((n) => !n.startsWith('<')).length;
  out.keepRoRead = errOf(() => fs.readFileSync(path.join(cfg.keepRo, 'ro.txt')));
  out.keepRoWrite = tryWrite(cfg.keepRo);
  // 5 — no privilege
  const st = status('/proc/self/status');
  out.capEff = st.CapEff; out.capBnd = st.CapBnd; out.noNewPrivs = st.NoNewPrivs; out.seccomp = st.Seccomp;
  if (inside) out.mountTmpfs = spawnSync('mount', ['-t', 'tmpfs', 'arm', '/tmp'], { stdio: 'ignore' }).status;
  // 6 — env allowlist
  out.planted = process.env.WEBCTL_ARM_PLANTED === undefined ? 'absent' : 'present';
  out.passed = process.env.ARM_PASSED === undefined ? 'absent' : 'present';
  // 7 — writable only where declared
  out.writes = { cwd: tryWrite(process.cwd()), keep: tryWrite(cfg.keep), outsideDir: tryWrite(cfg.outsideDir), baseRoot: tryWrite(cfg.baseRoot),
    root: tryWrite('/'), etc: tryWrite('/etc'), tmp: tryWrite('/tmp'), varTmp: tryWrite('/var/tmp'), run: tryWrite('/run'), devShm: tryWrite('/dev/shm') };
  out.nestedUserns = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' }).status;
  // 8 — no host-shared scratch
  out.shmPlanted = errOf(() => fs.readFileSync(path.join('/dev/shm', cfg.planted)));
  out.varTmpPlanted = errOf(() => fs.readFileSync(path.join('/var/tmp', cfg.planted)));
  if (inside) {
    out.shmWrote = errOf(() => fs.writeFileSync(path.join('/dev/shm', `${cfg.planted}-in-${mode}`), 'x'));
    out.varTmpWrote = errOf(() => fs.writeFileSync(path.join('/var/tmp', `${cfg.planted}-in-${mode}`), 'x'));
  }
  out.ipcNs = digest(fs.readlinkSync('/proc/self/ns/ipc'));
  out.sysvShm = (() => { try { return fs.readFileSync('/proc/sysvipc/shm', 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.trim().split(/\s+/)[1]); } catch { return []; } })();
  out.mqueueFs = (fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find((l) => l.split(' ')[4] === '/dev/mqueue') || '').includes(' - mqueue ');
  // 9 — no host keyring: /proc/keys is the host's listing outside; masked inside
  out.procKeys = (() => { try { return fs.readFileSync('/proc/keys', 'utf8').split('\n').filter(Boolean).length; } catch (e) { return `<${e.code}>`; } })();
  // 10 — no host identity (digests only)
  out.hostname = digest(os.hostname());
  out.hostnameNeutral = os.hostname() === 'webctl-isolated';
  out.netNames = list('/sys/class/net').map(digest);
  out.virtualNet = list('/sys/devices/virtual/net').map(digest);
  out.machineId = errOf(() => fs.readFileSync('/etc/machine-id')) === 'ok' ? digest(fs.readFileSync('/etc/machine-id', 'utf8').trim()) : 'absent';
  out.machineIdNeutral = errOf(() => fs.readFileSync('/etc/machine-id')) === 'ok' && fs.readFileSync('/etc/machine-id', 'utf8').trim() === '77656263746c2d69736f6c6174656400';
  if (inside) out.machineIdWrite = errOf(() => fs.writeFileSync('/etc/machine-id', 'x'));
  // 12 — no host devices
  out.dev = list('/dev');
  out.devPts = list('/dev/pts');
  out.uinput = errOf(() => fs.statSync('/dev/uinput'));
  out.snd = errOf(() => fs.statSync('/dev/snd'));
  out.devNull = errOf(() => fs.readFileSync('/dev/null'));
  out.devFull = errOf(() => fs.writeFileSync('/dev/full', 'x'));
  out.ptmx = errOf(() => fs.closeSync(fs.openSync('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY)));
  out.devCreate = errOf(() => { const f = `/dev/.arm-${process.pid}`; fs.closeSync(fs.openSync(f, 'wx')); fs.unlinkSync(f); });
  // 12b — no controlling terminal
  out.devTty = errOf(() => fs.closeSync(fs.openSync('/dev/tty', 'r')));
  process.stdout.write(`ARM-RESULT ${JSON.stringify(out)}\n`);
})();
