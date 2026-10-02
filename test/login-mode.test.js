// login-mode.test.js — lg1n's verdicts, each in BOTH directions.
//
// ⛔ The failure this module exists to prevent is a reader that reports CLEAN
// because it cannot see. So every "clean" assertion here is paired with a control
// on the same fixture shape that must FIND the control surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSwitches, pickBrowserProcess, classifyLoginArgv, classifyControlArgv,
  parseListeningPorts, sameProfile, LOGIN_VIOLATIONS,
} from '../lib/login-mode.js';

const CLEAN = ['/usr/bin/chromium', '--user-data-dir=/p/chromium', '--no-first-run'];
const CONTROL = [...CLEAN, '--remote-debugging-port=9222', '--remote-allow-origins=*'];

test('⭐ CONTROL ARM: the same reader FINDS CDP in control mode', () => {
  // Without this, every "clean" below could be a blind reader.
  const c = classifyControlArgv(CONTROL);
  assert.equal(c.verdict, 'cdp');
  assert.equal(c.port, 9222);
  assert.equal(classifyLoginArgv(CONTROL).verdict, 'violations');
});

test('login mode: a browser with no control surface is CLEAN', () => {
  const v = classifyLoginArgv(CLEAN);
  assert.equal(v.verdict, 'clean', v.reason);
  assert.equal(v.userDataDir, '/p/chromium');
  assert.equal(classifyControlArgv(CLEAN).verdict, 'no-cdp');
});

test('⛔ every listed violation switch is caught, including value forms', () => {
  for (const { switch: s } of LOGIN_VIOLATIONS) {
    const v = classifyLoginArgv([...CLEAN, `--${s}=x`]);
    assert.equal(v.verdict, 'violations', `--${s}=x must be a violation`);
    assert.ok(v.violations.some((x) => x.switch === s));
    // and without a value
    assert.equal(classifyLoginArgv([...CLEAN, `--${s}`]).verdict, 'violations', `bare --${s}`);
  }
  assert.equal(classifyLoginArgv([...CLEAN, '--headless=new']).verdict, 'violations');
});

test('⛔ a CDP PIPE is control too — no port, still a violation', () => {
  const argv = [...CLEAN, '--remote-debugging-pipe'];
  assert.equal(classifyLoginArgv(argv).verdict, 'violations');
  const c = classifyControlArgv(argv);
  assert.equal(c.verdict, 'cdp');
  assert.equal(c.pipe, true);
  assert.equal(c.port, null);
});

test('⛔ SINGLE-DASH evasion: Chromium accepts `-remote-debugging-port`, so must we', () => {
  // `grep -- '--remote'` misses this; Chromium on POSIX enables CDP with it.
  const argv = [...CLEAN, '-remote-debugging-port=9222'];
  assert.equal(classifyLoginArgv(argv).verdict, 'violations');
  assert.equal(classifyControlArgv(argv).port, 9222);
});

test('⛔ a bare `--` ends switch parsing — what follows is an argument, not a switch', () => {
  // Control first: the same token BEFORE the terminator is a violation.
  assert.equal(classifyLoginArgv([...CLEAN, '--remote-debugging-port=1']).verdict, 'violations');
  // After it, Chromium treats it as an argument (e.g. a URL), so we must too.
  const v = classifyLoginArgv([...CLEAN, '--', '--remote-debugging-port=1']);
  assert.equal(v.verdict, 'clean', 'a false violation here would block a clean login');
});

test('⛔ an argv WITHOUT the program name must not lose its first switch', () => {
  // The dangerous direction: dropping argv[0] unconditionally would discard
  // `--remote-debugging-port` and report CLEAN.
  const v = classifyLoginArgv(['--remote-debugging-port=9222', '--user-data-dir=/p']);
  assert.equal(v.verdict, 'violations');
  assert.equal(parseSwitches(['--a', '--b']).size, 2);
});

test('advisories are REPORTED, and do not on their own make it unclean', () => {
  const v = classifyLoginArgv([...CLEAN, '--no-sandbox', '--load-extension=/ext']);
  assert.equal(v.verdict, 'clean');
  assert.deepEqual(v.advisories.map((a) => a.switch).sort(), ['load-extension', 'no-sandbox']);
  assert.match(v.reason, /2 advisory/);
});

test('⛔ an empty argv is UNKNOWN — an unread browser is not a clean one', () => {
  assert.equal(classifyLoginArgv([]).verdict, 'unknown');
  assert.equal(classifyControlArgv([]).verdict, 'unknown');
  assert.equal(classifyLoginArgv(/** @type {any} */ (undefined)).verdict, 'unknown');
});

test('pickBrowserProcess: exactly one process without --type, else UNKNOWN', () => {
  const renderer = ['/usr/lib/chromium/chromium', '--type=renderer', '--remote-debugging-port=9222'];
  const gpu = ['/usr/lib/chromium/chromium', '--type=gpu-process'];
  const one = pickBrowserProcess([renderer, CLEAN, gpu]);
  assert.equal(one.verdict, 'found');
  assert.deepEqual(/** @type {any} */ (one).argv, CLEAN);

  assert.equal(pickBrowserProcess([renderer, gpu]).verdict, 'unknown', 'no browser process');
  assert.equal(pickBrowserProcess([CLEAN, CLEAN]).verdict, 'unknown', 'two candidates');
  assert.equal(pickBrowserProcess([]).verdict, 'unknown', 'nothing read');
});

test('sockets: CDP listening in control mode, absent in login mode — with the header as proof of reading', () => {
  const control = 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port\n'
    + 'LISTEN 0      4096   127.0.0.1:9222     0.0.0.0:*\n'
    + 'LISTEN 0      5      [::1]:14427        [::]:*\n';
  const c = parseListeningPorts(control);
  assert.equal(c.verdict, 'read');
  assert.ok(c.ports.includes(9222), 'control arm: the reader must SEE the CDP port');
  assert.ok(c.ports.includes(14427), 'IPv6 bracket form parsed');

  const login = 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port\n'
    + 'LISTEN 0      5      [::1]:14427        [::]:*\n';
  const l = parseListeningPorts(login);
  assert.equal(l.verdict, 'read');
  assert.equal(l.ports.includes(9222), false);

  const headerOnly = parseListeningPorts('State  Recv-Q Send-Q Local Address:Port Peer Address:Port\n');
  assert.equal(headerOnly.verdict, 'read', 'header present ⇒ the reader ran and nothing listens');
  assert.deepEqual(headerOnly.ports, []);
});

test('⛔ sockets: empty output is UNKNOWN — "nothing listens" vs "nothing was read"', () => {
  assert.equal(parseListeningPorts('').verdict, 'unknown');
  assert.equal(parseListeningPorts(/** @type {any} */ (null)).verdict, 'unknown');
});

test('same profile across both restarts, by path identity', () => {
  const ctl = ['/usr/bin/chromium', '--user-data-dir=/p/chromium/', '--remote-debugging-port=9222'];
  assert.equal(sameProfile(CLEAN, ctl).verdict, 'same', 'trailing slash normalised');

  const other = ['/usr/bin/chromium', '--user-data-dir=/q/chromium', '--remote-debugging-port=9222'];
  assert.equal(sameProfile(CLEAN, other).verdict, 'different');

  const noDir = ['/usr/bin/chromium', '--remote-debugging-port=9222'];
  const u = sameProfile(CLEAN, noDir);
  assert.equal(u.verdict, 'unknown');
  assert.match(u.reason, /DEFAULT profile/);
});

// ── reader-side traps found by lanes in LIVE use (v0.17.1) ─────────────────────
import { pickBrowserRoot, normalizeArgv, classifySockets } from '../lib/login-mode.js';

test('⛔ advisories are VALUE-conditional: an EMPTY --load-extension= loads nothing', () => {
  // Measured in a lane's live login mode: `--load-extension=` (empty) was reported
  // as "extension code running". Control: a real path still is.
  assert.equal(classifyLoginArgv([...CLEAN, '--load-extension=']).advisories.length, 0);
  assert.equal(classifyLoginArgv([...CLEAN, '--load-extension=/ext/a']).advisories.length, 1);
  assert.equal(classifyLoginArgv([...CLEAN, '--disable-extensions-except=']).advisories.length, 0);
});

test('⛔ disable-blink-features is an advisory ONLY for AutomationControlled, as its reason says', () => {
  assert.equal(classifyLoginArgv([...CLEAN, '--disable-blink-features=AutomationControlled']).advisories.length, 1);
  assert.equal(classifyLoginArgv([...CLEAN, '--disable-blink-features=Foo,AutomationControlled']).advisories.length, 1);
  assert.equal(classifyLoginArgv([...CLEAN, '--disable-blink-features=SomethingElse']).advisories.length, 0,
    'the reason names AutomationControlled; flagging any feature contradicted it');
  // no-sandbox stays unconditional
  assert.equal(classifyLoginArgv([...CLEAN, '--no-sandbox']).advisories.length, 1);
});

test('⛔ setproctitle-joined children: exactly ONE browser by parentage', () => {
  // Measured: Chromium 154 children rewrite /proc cmdline into one space-joined
  // string, so --type is no longer a separate arg and ~10 "browsers" appeared.
  const procs = [
    { pid: 1, ppid: 0, argv: ['/bin/sh', '/entrypoint.sh'] },
    { pid: 50, ppid: 1, argv: ['/usr/lib/chromium/chromium', '--user-data-dir=/p', '--no-first-run'] },
    { pid: 51, ppid: 50, argv: ['/usr/lib/chromium/chromium --type=zygote --no-zygote-sandbox'] },
    { pid: 60, ppid: 51, argv: ['/usr/lib/chromium/chromium --type=renderer --lang=en'] },
    { pid: 61, ppid: 51, argv: ['/usr/lib/chromium/chromium --type=renderer --lang=en'] },
    { pid: 70, ppid: 50, argv: ['/usr/lib/chromium/chromium --type=gpu-process'] },
    { pid: 80, ppid: 1, argv: ['/usr/lib/chromium/chrome_crashpad_handler', '--database=/x'] },
  ];
  const r = /** @type {any} */ (pickBrowserRoot(procs));
  assert.equal(r.verdict, 'found', r.reason);
  assert.equal(r.pid, 50, 'the shell parent and the reparented crashpad handler are not the browser');
  assert.equal(classifyLoginArgv(r.argv).verdict, 'clean');

  // The old --type picker also copes now, because it normalises first.
  assert.equal(pickBrowserProcess(procs.slice(1, 6).map((p) => p.argv)).verdict, 'found');
});

test('⛔ CONTROL: two Chromium ROOTS is UNKNOWN, not a guess', () => {
  const r = pickBrowserRoot([
    { pid: 50, ppid: 1, argv: ['/usr/lib/chromium/chromium', '--user-data-dir=/p'] },
    { pid: 90, ppid: 1, argv: ['/usr/lib/chromium/chromium', '--user-data-dir=/q'] },
  ]);
  assert.equal(r.verdict, 'unknown');
  assert.match(/** @type {any} */ (r).reason, /2 Chromium roots/);
  assert.equal(pickBrowserRoot([]).verdict, 'unknown');
});

test('normalizeArgv reports that a joined argv was split, i.e. fidelity was reduced', () => {
  assert.deepEqual(normalizeArgv(['/c --type=renderer --x']), { argv: ['/c', '--type=renderer', '--x'], joined: true });
  assert.equal(normalizeArgv(['/c', '--a']).joined, false);
  assert.equal(normalizeArgv(['--a --b']).joined, false, 'a leading switch is not a joined program line');
});

test('⛔ socket arm: Docker embedded DNS is NAMED, not read as CDP — and a real CDP is still caught', () => {
  const H = 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port\n';
  // the measured case: docker-dns on a random port, nothing else
  const login = classifySockets(H + 'LISTEN 0 4096 127.0.0.11:41237 0.0.0.0:*\n', 9222);
  assert.equal(login.verdict, 'no-cdp');
  assert.equal(login.listeners[0].kind, 'docker-dns');
  // even if its random port COLLIDES with the CDP port
  assert.equal(classifySockets(H + 'LISTEN 0 4096 127.0.0.11:9222 0.0.0.0:*\n', 9222).verdict, 'no-cdp');
  // CONTROL: a real CDP listener is still caught, beside docker-dns
  const control = classifySockets(H + 'LISTEN 0 4096 127.0.0.11:41237 0.0.0.0:*\n'
    + 'LISTEN 0 10 127.0.0.1:9222 0.0.0.0:*\n', 9222);
  assert.equal(control.verdict, 'cdp-listening');
  // interface suffix and IPv6 brackets stripped from the address
  const v6 = classifySockets(H + 'LISTEN 0 10 [::1]:9222 [::]:*\nLISTEN 0 10 127.0.0.53%lo:53 0.0.0.0:*\n', 9222);
  assert.equal(v6.verdict, 'cdp-listening');
  assert.ok(v6.listeners.some((l) => l.address === '127.0.0.53'));
  assert.equal(classifySockets('', 9222).verdict, 'unknown');
});

// ── lifecycle guard: never restart a browser a human is using (incident rule) ──
import { lifecycleGuard } from '../lib/login-mode.js';

test('⭐ CONTROL: control mode with zero viewers (both READ) allows a restart', () => {
  assert.equal(lifecycleGuard({ mode: 'control', viewerCount: 0 }).verdict, 'allowed');
});

test('⛔ a viewer attached REFUSES a restart', () => {
  const r = lifecycleGuard({ mode: 'control', viewerCount: 1 });
  assert.equal(r.verdict, 'refused');
  assert.match(r.reason, /1 viewer\(s\) attached/);
});

test('⛔ LOGIN MODE refuses a restart even with no viewer — and SAYS a human is signing in', () => {
  const r = lifecycleGuard({ mode: 'login', viewerCount: 0 });
  assert.equal(r.verdict, 'refused');
  // ⇒ The REASON is the point, not just the verdict: in the incident the agent saw
  // "login mode" and misread it as its own bug. A generic "mode unknown" refusal would
  // pass a verdict-only assertion and teach nothing — sabotage proved exactly that.
  assert.match(r.reason, /LOGIN MODE: a human is signing in/);
});

test('⛔ an UNKNOWN viewer count or mode refuses — never assumed safe', () => {
  assert.equal(lifecycleGuard({ mode: 'control' }).verdict, 'refused', 'count not read');
  assert.equal(lifecycleGuard({ mode: 'control', viewerCount: -1 }).verdict, 'refused');
  assert.equal(lifecycleGuard({ viewerCount: 0 }).verdict, 'refused', 'mode not read');
  assert.equal(lifecycleGuard().verdict, 'refused');
});

test('only an EXPLICIT human override proceeds', () => {
  assert.equal(lifecycleGuard({ mode: 'login', viewerCount: 2, humanOverride: true }).verdict, 'allowed');
  assert.equal(lifecycleGuard({ mode: 'login', viewerCount: 2, humanOverride: /** @type {any} */ ('yes') }).verdict,
    'refused', 'a truthy non-boolean is not an override');
});
