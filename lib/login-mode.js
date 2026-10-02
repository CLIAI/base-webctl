// login-mode.js — verdicts for lg1n's "login mode": is this browser CLEAN?
//
// Design: docs/design/arch-login-mode-clean-signin-lg1n.md
//
// ⭐ BASE OWNS THE VERDICT; THE LANE OWNS THE READING. base does not own any lane's
// browser launch line — consumers inject their own container build, and some run
// browsers from a zone manager base has never seen — so base cannot know what a
// browser was started with by looking at what base asked for. ⇒ These functions
// judge what a lane READ from the running browser (its argv, its listening
// sockets). Pure: no fs, no process, no network. Service-agnostic.
//
// ⛔ Every verdict is tri-state and UNKNOWN never collapses into the reassuring
// answer: an unreadable argv is not a clean browser.

import path from 'node:path';

/**
 * Switches whose PRESENCE means the browser is not in login mode. Login mode is
 * defined by their absence.
 */
export const LOGIN_VIOLATIONS = Object.freeze([
  { switch: 'remote-debugging-port', reason: 'CDP over TCP' },
  { switch: 'remote-debugging-pipe', reason: 'CDP over a pipe — no port, still full control' },
  { switch: 'remote-debugging-address', reason: 'only meaningful with CDP' },
  { switch: 'remote-allow-origins', reason: 'only meaningful with CDP' },
  { switch: 'enable-automation', reason: 'automation-revealing' },
  { switch: 'headless', reason: 'not a human-usable browser' },
  { switch: 'disable-gpu', reason: 'contradicts "with hardware acceleration"' },
]);

/** Switches that reduce cleanliness but a lane's container may need. Reported, never silently passed. */
export const LOGIN_ADVISORIES = Object.freeze([
  { switch: 'no-sandbox', reason: 'often needed in containers; a weaker browser' },
  { switch: 'load-extension', reason: 'extension code running during sign-in' },
  { switch: 'disable-extensions-except', reason: 'extension code running during sign-in' },
  { switch: 'disable-blink-features', reason: 'when AutomationControlled: disguise, not cleanliness' },
]);

/**
 * Parse an argv the way Chromium does on POSIX.
 *
 * ⚠ Two traps a naive grep falls into, both handled:
 *  * Chromium accepts BOTH `--` and `-` as switch prefixes, so
 *    `-remote-debugging-port=9222` enables CDP and evades `grep -- '--remote'`;
 *  * a bare `--` ENDS switch parsing — anything after it is an argument, not a
 *    switch, and reporting it as one is a false violation.
 *
 * ⚠ argv[0] is skipped ONLY when it is not itself a switch. A lane that passes the
 * switches without the program name must not lose its first switch — that is the
 * dangerous direction: a dropped `--remote-debugging-port` reads as CLEAN.
 *
 * @param {string[]} argv
 * @returns {Map<string, string>} switch name -> value ('' when it has none)
 */
export function parseSwitches(argv) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (!Array.isArray(argv)) return out;
  let i = 0;
  if (argv.length > 0 && typeof argv[0] === 'string' && !argv[0].startsWith('-')) i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a === '--') break; // switch terminator: the rest are arguments
    const m = /^--?([^-=][^=]*)(?:=([\s\S]*))?$/.exec(a);
    if (!m) continue;
    out.set(m[1], m[2] === undefined ? '' : m[2]);
  }
  return out;
}

/**
 * Choose the BROWSER process from a list of process argvs. Renderers and helpers
 * carry `--type=…`; the browser process does not.
 *
 * @param {string[][]} processes
 * @returns {{verdict: 'found', argv: string[]} | {verdict: 'unknown', reason: string}}
 */
export function pickBrowserProcess(processes) {
  if (!Array.isArray(processes) || processes.length === 0) {
    return { verdict: 'unknown', reason: 'no process argv was supplied — nothing was read' };
  }
  const browsers = processes.filter((argv) => !parseSwitches(argv).has('type'));
  if (browsers.length === 1) return { verdict: 'found', argv: browsers[0] };
  return {
    verdict: 'unknown',
    reason: browsers.length === 0
      ? 'every supplied process carries --type; the browser process was not among them'
      : `${browsers.length} processes without --type; cannot tell which is the browser`,
  };
}

/** @param {Map<string, string>} sw */
function userDataDirOf(sw) {
  const v = sw.get('user-data-dir');
  return v ? v : null;
}

/**
 * Is this browser-process argv CLEAN for login mode?
 *
 * @param {string[]} argv the BROWSER process argv (see pickBrowserProcess)
 * @returns {{
 *   verdict: 'clean' | 'violations' | 'unknown',
 *   violations: {switch: string, value: string, reason: string}[],
 *   advisories: {switch: string, value: string, reason: string}[],
 *   userDataDir: string | null,
 *   reason: string,
 * }}
 */
export function classifyLoginArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { verdict: 'unknown', violations: [], advisories: [], userDataDir: null,
      reason: 'empty argv — an unread browser is not a clean one' };
  }
  const sw = parseSwitches(argv);
  const pick = (/** @type {readonly {switch: string, reason: string}[]} */ list) => list
    .filter((x) => sw.has(x.switch))
    .map((x) => ({ switch: x.switch, value: sw.get(x.switch) || '', reason: x.reason }));
  const violations = pick(LOGIN_VIOLATIONS);
  const advisories = pick(LOGIN_ADVISORIES);
  return {
    verdict: violations.length ? 'violations' : 'clean',
    violations,
    advisories,
    userDataDir: userDataDirOf(sw),
    reason: violations.length
      ? `control surface present: ${violations.map((v) => v.switch).join(', ')}`
      : advisories.length
        ? `no control surface; ${advisories.length} advisory switch(es) reported`
        : 'no control surface and no advisories',
  };
}

/**
 * The CONTROL ARM: does this argv carry CDP? Run the same reader against control
 * mode and require it to FIND CDP — that is what proves the reader can see, so a
 * "clean" from classifyLoginArgv means something (k3wn: a refusal test needs a
 * positive control on the same fixture).
 *
 * @param {string[]} argv
 * @returns {{verdict: 'cdp' | 'no-cdp' | 'unknown', port: number | null, pipe: boolean,
 *   userDataDir: string | null}}
 */
export function classifyControlArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { verdict: 'unknown', port: null, pipe: false, userDataDir: null };
  }
  const sw = parseSwitches(argv);
  const raw = sw.get('remote-debugging-port');
  const port = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
  const pipe = sw.has('remote-debugging-pipe');
  return {
    verdict: port !== null || pipe ? 'cdp' : 'no-cdp',
    port,
    pipe,
    userDataDir: userDataDirOf(sw),
  };
}

/**
 * Parse `ss -ltn` output into the set of listening TCP ports.
 *
 * ⚠ Capture it WITH the header (`ss -ltn`, not `ss -ltnH`). With no listeners,
 * `-H` prints nothing — indistinguishable from a reader that never ran. The header
 * line is what lets "nothing listens" be told apart from "nothing was read".
 *
 * @param {string} ssOutput
 * @returns {{verdict: 'read' | 'unknown', ports: number[], reason: string}}
 */
export function parseListeningPorts(ssOutput) {
  const lines = String(ssOutput || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const header = lines.some((l) => /^State\s/.test(l));
  /** @type {Set<number>} */
  const ports = new Set();
  for (const l of lines) {
    const cols = l.split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 4) continue;
    const m = /:(\d+)$/.exec(cols[3]);
    if (m) ports.add(Number(m[1]));
  }
  if (!header && ports.size === 0) {
    return { verdict: 'unknown', ports: [],
      reason: 'no header and no LISTEN lines — cannot tell "nothing listens" from "nothing was read"' };
  }
  return { verdict: 'read', ports: [...ports].sort((a, b) => a - b), reason: `${ports.size} listening port(s)` };
}

/**
 * Same profile across the login-mode and control-mode restarts, by PATH IDENTITY.
 *
 * @param {string[]} loginArgv @param {string[]} controlArgv
 * @returns {{verdict: 'same' | 'different' | 'unknown', login: string | null,
 *   control: string | null, reason: string}}
 */
export function sameProfile(loginArgv, controlArgv) {
  const norm = (/** @type {string|null} */ p) => (p ? path.posix.normalize(p).replace(/\/+$/, '') || '/' : null);
  const login = norm(userDataDirOf(parseSwitches(loginArgv)));
  const control = norm(userDataDirOf(parseSwitches(controlArgv)));
  if (!login || !control) {
    return { verdict: 'unknown', login, control,
      reason: 'a --user-data-dir is missing: Chromium would use its DEFAULT profile, '
        + 'which is not the one the human signed into' };
  }
  return login === control
    ? { verdict: 'same', login, control, reason: 'identical --user-data-dir' }
    : { verdict: 'different', login, control, reason: 'the two restarts used different profiles' };
}
