// isolation-arm-tty.cjs — row 12b of the ib4k §1 table: the command's CONTROLLING TERMINAL (third review, F1).
//
// Run by helpers/isolation-arm-world.cjs under a pty the WORLD creates (`script -qec … /dev/null`), so fd 0
// is that throwaway pty's slave — never a real terminal.
//   * `record`: fd 0's identity (st_dev:st_rdev) → cfg.ptyIdFile — written first, OUTSIDE `isolated`.
//   * `outside` (the control): /dev/tty opens (fd 0's pty is this session's controlling terminal).
//   * `fresh` | `nested` | `stripped` (the arms): /dev/tty → ENXIO (no controlling terminal), an ioctl
//     TIOCSTI on fd 0 → EPERM or EIO, never success, and no capless ancestor holds a controlling terminal.
// ⛔ TIOCSTI is attempted ONLY when fd 0 is a tty whose identity equals the recorded one — i.e. the
// throwaway pty, and nothing else; otherwise the reading says SKIPPED. One JSON line per run → cfg.ttyFile.
// argv: <mode> <config.json>
'use strict';
const fs = require('node:fs');
const tty = require('node:tty');
const { spawnSync } = require('node:child_process');

const [mode, cfgPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const idOf0 = () => { const st = fs.fstatSync(0); return `${st.dev}:${st.rdev}`; };

if (mode === 'record') {
  if (tty.isatty(0)) fs.writeFileSync(cfg.ptyIdFile, idOf0());
  process.exit(0);
}
/** @type {Record<string, unknown>} */
const out = { mode };
try { fs.closeSync(fs.openSync('/dev/tty', fs.constants.O_RDWR)); out.ttyOpen = 'ok'; } catch (e) { out.ttyOpen = e.code || String(e.message); }
if (mode !== 'outside') {
  // ⚠ what a TIOCSTI answer can PROVE depends on this sysctl (v0.35.0 follow-up): at 0 the kernel answers EIO
  // to every capless caller BEFORE it compares the terminal with the caller's controlling one, so EIO says
  // nothing about the session. Absent: a kernel < 6.2, which always has the legacy behaviour (as at 1).
  try { out.legacyTiocsti = fs.readFileSync('/proc/sys/dev/tty/legacy_tiocsti', 'utf8').trim(); } catch { out.legacyTiocsti = 'absent'; }
  let recorded = '';
  try { recorded = fs.readFileSync(cfg.ptyIdFile, 'utf8').trim(); } catch { /* none recorded */ }
  if (!cfg.python) out.tiocsti = 'SKIPPED (no python3 in the system dirs)';
  else if (!tty.isatty(0) || !recorded || idOf0() !== recorded) out.tiocsti = 'SKIPPED (fd 0 is not the throwaway pty)';
  else {
    const py = ['import errno, fcntl, termios', 'try:', '    fcntl.ioctl(0, termios.TIOCSTI, b"#")', '    print("SUCCEEDED")',
      'except OSError as e:', '    print(errno.errorcode.get(e.errno, str(e.errno)))'].join('\n');
    const r = spawnSync(cfg.python, ['-I', '-c', py], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    out.tiocsti = String(r.stdout).trim() || `exit ${r.status}`;
  }
}
// …and no ANCESTOR the command could ptrace holds one: the same uid with NO capabilities (the class
// commoncap lets a capless process trace — given yama ptrace_scope 0), so no TIOCSTI by proxy. Read from
// /proc/<pid>/stat (tty_nr) and /proc/<pid>/status (CapEff), up to pid 1; ancestors WITH capabilities
// (the fresh path's pid 1 and inner half) cannot be traced by the command and are only counted in `ttyAncestors`.
let pid = process.ppid;
let any = 0; let capless = 0;
while (pid > 0) {
  let stat = ''; let status = '';
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { break; }
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // state ppid pgrp session tty_nr …
  if (Number(f[4]) !== 0) { any++; if (/^0+$/.test((status.match(/^CapEff:\s*(\S+)/m) || [])[1] || 'x')) capless++; }
  pid = pid === 1 ? 0 : Number(f[1]);
}
out.ttyAncestors = any;
out.ttyCaplessAncestors = capless;
fs.appendFileSync(cfg.ttyFile, `${JSON.stringify(out)}\n`);
