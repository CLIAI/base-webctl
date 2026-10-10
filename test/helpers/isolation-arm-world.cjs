// isolation-arm-world.cjs — the throwaway "host" the ib4k §1 arm table runs against.
//
// Started by test/isolation-arm-table.test.js as namespace root of a throwaway `unshare -rm`
// (inside a throwaway session keyring when keyctl exists), so NOTHING here touches the real host:
//   * a tmpfs over a neutral dir (cfg.neutral, e.g. /mnt) holds a FAKE passwd home with planted
//     secrets, and a user-owned dir OUTSIDE that home; /etc/passwd is bound to point the real uid there;
//   * a tmpfs over /dev/shm and over /var/tmp — the "host's" scratch — each holding a planted file;
//   * a key planted in the (throwaway) session keyring.
// Then: the probe OUTSIDE (the controls), the probe INSIDE `isolated` on the fresh, nested and
// stripped-markers paths (the arms), and the read-backs on this side after it exits.
// Prints `WORLD {json}` on stdout; exit 97 = this host cannot build the world (the table skips).
// argv: <config.json>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
/** @param {string[]} a @param {import('node:child_process').SpawnSyncOptions} [o] */
const run = (a, o = {}) => spawnSync(a[0], a.slice(1), { encoding: 'utf8', ...o });
const fail = (/** @type {string} */ why) => { process.stdout.write(`WORLD ${JSON.stringify({ unavailable: why })}\n`); process.exit(97); };

// ── build ──
for (const [what, at] of [['neutral', cfg.neutral], ['shm', '/dev/shm'], ['vartmp', '/var/tmp']]) {
  const r = run([cfg.mount, '-t', 'tmpfs', '-o', 'mode=1777', `arm-world-${what}`, at]);
  if (r.status !== 0) fail(`tmpfs over ${what}: ${String(r.stderr).trim()}`);
}
for (const d of ['.ssh', '.config/webctl', 'data']) fs.mkdirSync(path.join(cfg.home, d), { recursive: true });
fs.writeFileSync(path.join(cfg.home, '.ssh', 'config'), 'Host planted-by-test\n');
fs.writeFileSync(path.join(cfg.home, '.config', 'webctl', 'config.toml'), 'planted = true\n');
fs.writeFileSync(path.join(cfg.keepRo, 'ro.txt'), 'readable\n');
fs.mkdirSync(cfg.outsideHome, { recursive: true });
fs.writeFileSync(path.join('/dev/shm', cfg.planted), 'planted-by-test\n');
fs.writeFileSync(path.join('/var/tmp', cfg.planted), 'planted-by-test\n');
const pw = path.join(cfg.neutral, 'passwd');
fs.writeFileSync(pw, `u:x:${cfg.uid}:${cfg.gid}::${cfg.home}:/bin/sh\n`);
if (run([cfg.mount, '--bind', pw, '/etc/passwd']).status !== 0) fail('bind over /etc/passwd');
const ent = run(['getent', 'passwd', String(cfg.uid)]);
if (String(ent.stdout).split(':')[5] !== cfg.home) fail('NSS answers the uid from elsewhere');
if (cfg.keyctl) {
  const k = run(['keyctl', 'add', 'user', cfg.keyName, 'planted-by-test', '@s']);
  if (k.status !== 0) fail(`keyctl add: ${String(k.stderr).trim()}`);
}

/** ARM-RESULT lines of `out`, by mode. @param {string} out */
const results = (out) => Object.fromEntries(String(out).split('\n').filter((l) => l.startsWith('ARM-RESULT '))
  .map((l) => JSON.parse(l.slice('ARM-RESULT '.length))).map((r) => [r.mode, r]));

// ── the controls: the same probe, outside ──
const env = { ...process.env, ARM_UNKNOWN_VAR: 'planted', ARM_PASSED_VAR: 'passed', NODE_OPTIONS: `--require ${cfg.preload}` };
const outside = run([process.execPath, cfg.probe, 'outside', cfg.self], { cwd: cfg.cwd, env });

// ── the arms: fresh, nested, stripped markers ──
const strip = ['WEBCTL_HOST_NETNS', 'WEBCTL_HOST_MNTNS', 'WEBCTL_HOST_PIDNS', 'WEBCTL_RO_ROOTS', 'WEBCTL_HIDDEN_DIRS', 'WEBCTL_HOST_IDS']
  .flatMap((v) => ['-u', v]);
const script = [
  '"$0" "$2" fresh "$3"',
  '"$0" "$1" isolated -- "$0" "$2" nested "$3"',
  `env ${strip.join(' ')} "$0" "$1" isolated -- "$0" "$2" stripped "$3"`,
].join('; ');
const arm = run([process.execPath, cfg.harness, 'isolated', '--keep', cfg.keep, '--keep-ro', cfg.keepRo, '--pass-env', 'ARM_PASSED_VAR', '--',
  'sh', '-c', script, process.execPath, cfg.harness, cfg.probe, cfg.self],
{ cwd: cfg.cwd, env: { ...env, ...(cfg.backend ? { WEBCTL_ISOLATION_BACKEND: cfg.backend } : {}) } });

// ── read back on THIS side, after the arm exited ──
const post = {
  // the arms' own files (`arm-inside-<mode>`); the control's `arm-inside-outside` is expected here
  shmLeft: fs.readdirSync('/dev/shm').filter((f) => f.startsWith('arm-inside-') && f !== 'arm-inside-outside'),
  vartmpLeft: fs.readdirSync('/var/tmp').filter((f) => f.startsWith('arm-inside-') && f !== 'arm-inside-outside'),
  shmControl: fs.existsSync('/dev/shm/arm-inside-outside'),
  ...(cfg.keyctl ? { keysLeft: ['fresh', 'nested', 'stripped']
    .filter((m) => run(['keyctl', 'search', '@s', 'user', `${cfg.keyName}-inside-${m}`]).status === 0) } : {}),
  hostnameHere: require('node:crypto').createHash('sha256').update(require('node:os').hostname()).digest('hex').slice(0, 16),
};

process.stdout.write(`WORLD ${JSON.stringify({ worldPid: process.pid, outside: results(outside.stdout), outsideErr: String(outside.stderr).slice(-2000),
  arm: results(arm.stdout), armStatus: arm.status, armErr: String(arm.stderr).slice(-6000), post })}\n`);
