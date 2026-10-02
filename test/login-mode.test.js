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
