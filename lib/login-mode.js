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

/**
 * Switches that reduce cleanliness but a lane's container may need. Reported, never
 * silently passed.
 *
 * ⚠ `when` makes an advisory VALUE-CONDITIONAL. The first version flagged these on
 * any value — so an EMPTY `--load-extension=` (which loads nothing) was reported as
 * "extension code running", and `disable-blink-features` was flagged for every
 * feature while its own reason said "when AutomationControlled". A reason that
 * disagrees with its code is a claim nobody checked; measured in a lane's live
 * login-mode reading.
 *
 * @type {readonly {switch: string, reason: string, when?: (v: string) => boolean}[]}
 */
export const LOGIN_ADVISORIES = Object.freeze([
  { switch: 'no-sandbox', reason: 'often needed in containers; a weaker browser' },
  { switch: 'load-extension', reason: 'extension code running during sign-in',
    when: (/** @type {string} */ v) => v.trim() !== '' },
  { switch: 'disable-extensions-except', reason: 'extension code running during sign-in',
    when: (/** @type {string} */ v) => v.trim() !== '' },
  { switch: 'disable-blink-features', reason: 'AutomationControlled: disguise, not cleanliness',
    when: (/** @type {string} */ v) => /(^|,)\s*AutomationControlled\s*(,|$)/.test(v) },
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
 * Undo Chromium's setproctitle rewrite.
 *
 * ⛔ Chromium's CHILD processes rewrite their /proc cmdline into ONE space-joined
 * string, so a NUL-split read yields a single element like
 * `"/usr/lib/chromium/chromium --type=renderer …"`. Unnormalised, `--type` is no longer
 * a separate argument, the element is skipped as argv[0], and every child reads as a
 * "browser" — measured by a lane on Chromium 154: ~10 candidates, verdict UNKNOWN.
 * ⇒ A single element containing whitespace and starting with a path is split.
 * ⚠ The split is LOSSY for values containing spaces; `joined` reports that fidelity
 * was reduced, rather than hiding it.
 *
 * @param {string[] | string} argv
 * @returns {{argv: string[], joined: boolean}}
 */
export function normalizeArgv(argv) {
  const a = typeof argv === 'string' ? [argv] : Array.isArray(argv) ? argv : [];
  if (a.length === 1 && typeof a[0] === 'string' && /\s/.test(a[0].trim()) && !a[0].trim().startsWith('-')) {
    return { argv: a[0].trim().split(/\s+/), joined: true };
  }
  return { argv: a, joined: false };
}

/** @param {string[]} argv */
function exeBase(argv) {
  return path.posix.basename(String(argv[0] || ''));
}

/**
 * Choose the BROWSER process by PARENTAGE: the root of the Chromium process tree.
 *
 * ⭐ This is the base rule (a lane measured that `--type` alone fails once children
 * are setproctitle-joined). Candidates are processes whose executable basename names
 * Chromium/Chrome, excluding the crashpad handler (which can be reparented and would
 * otherwise read as a second root). The root is the candidate whose parent is NOT
 * another candidate. Exactly one root → found; zero or several → UNKNOWN.
 *
 * @param {{pid: number, ppid: number, argv: string[] | string}[]} procs
 * @returns {{verdict: 'found', argv: string[], pid: number, joined: boolean}
 *   | {verdict: 'unknown', reason: string}}
 */
export function pickBrowserRoot(procs) {
  if (!Array.isArray(procs) || procs.length === 0) {
    return { verdict: 'unknown', reason: 'no processes were supplied — nothing was read' };
  }
  const norm = procs.map((p) => ({ ...p, ...normalizeArgv(p.argv) }));
  const cand = norm.filter((p) => /chrom(e|ium)/i.test(exeBase(p.argv)) && !/crashpad/i.test(exeBase(p.argv)));
  const pids = new Set(cand.map((p) => p.pid));
  const roots = cand.filter((p) => !pids.has(p.ppid));
  if (roots.length === 1) {
    return { verdict: 'found', argv: roots[0].argv, pid: roots[0].pid, joined: roots[0].joined };
  }
  return {
    verdict: 'unknown',
    reason: roots.length === 0
      ? `no Chromium root among ${procs.length} process(es)`
      : `${roots.length} Chromium roots (pids ${roots.map((r) => r.pid).join(', ')}); cannot tell which is the browser`,
  };
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
  // Normalise first: setproctitle-joined children would otherwise all read as browsers.
  const norm = processes.map((argv) => normalizeArgv(argv).argv);
  const browsers = norm.filter((argv) => !parseSwitches(argv).has('type'));
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
  const pick = (/** @type {readonly {switch: string, reason: string, when?: (v: string) => boolean}[]} */ list) => list
    .filter((x) => sw.has(x.switch) && (!x.when || x.when(sw.get(x.switch) || '')))
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
 * @returns {{verdict: 'read' | 'unknown', ports: number[],
 *   listeners: {address: string, port: number}[], reason: string}}
 */
export function parseListeningPorts(ssOutput) {
  const lines = String(ssOutput || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const header = lines.some((l) => /^State\s/.test(l));
  /** @type {Set<number>} */
  const ports = new Set();
  /** @type {{address: string, port: number}[]} */
  const listeners = [];
  for (const l of lines) {
    const cols = l.split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 4) continue;
    const m = /^(.*):(\d+)$/.exec(cols[3]);
    if (!m) continue;
    const address = m[1].replace(/^\[|\]$/g, '').replace(/%[^%]*$/, '');
    ports.add(Number(m[2]));
    listeners.push({ address, port: Number(m[2]) });
  }
  if (!header && ports.size === 0) {
    return { verdict: 'unknown', ports: [], listeners: [],
      reason: 'no header and no LISTEN lines — cannot tell "nothing listens" from "nothing was read"' };
  }
  return { verdict: 'read', ports: [...ports].sort((a, b) => a - b), listeners,
    reason: `${ports.size} listening port(s)` };
}

/** Docker's embedded DNS resolver, present in every user-defined network's namespace. */
export const DOCKER_EMBEDDED_DNS = '127.0.0.11';

/**
 * The SOCKET ARM: is CDP listening in this namespace?
 *
 * ⛔ Keyed on ADDRESS + PORT, not port alone. Inside a container on a user-defined
 * network, Docker's embedded DNS listens on `127.0.0.11:<random port>` — measured by a
 * lane in login mode. A check for "anything listening" reads that as CDP present; a
 * port-only check misfires the day the random port collides. ⇒ It is NAMED
 * `docker-dns` and excluded, rather than special-cased ad hoc in each lane.
 *
 * @param {string} ssOutput `ss -ltn` WITH its header
 * @param {number} cdpPort
 * @returns {{verdict: 'cdp-listening' | 'no-cdp' | 'unknown',
 *   listeners: {address: string, port: number, kind: 'docker-dns' | 'other'}[], reason: string}}
 */
export function classifySockets(ssOutput, cdpPort) {
  const r = parseListeningPorts(ssOutput);
  if (r.verdict === 'unknown') return { verdict: 'unknown', listeners: [], reason: r.reason };
  const listeners = r.listeners.map((l) => ({ ...l,
    kind: /** @type {'docker-dns'|'other'} */ (l.address === DOCKER_EMBEDDED_DNS ? 'docker-dns' : 'other') }));
  const cdp = listeners.filter((l) => l.port === cdpPort && l.kind !== 'docker-dns');
  return cdp.length
    ? { verdict: 'cdp-listening', listeners, reason: `CDP port ${cdpPort} listening on ${cdp.map((l) => l.address).join(', ')}` }
    : { verdict: 'no-cdp', listeners, reason: `no listener on port ${cdpPort} other than docker-dns` };
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

/**
 * May a LIFECYCLE action (restart, stop, re-mint cycle) run on this target now?
 *
 * ⛔ Written after an incident: an agent's live test cycle restarted a browser TWICE
 * while the human was attached and signing in — and its own inventory had reported
 * "login mode" first, which it misread as its own bug.
 *
 * Refused while the target is in LOGIN MODE, or while ANY VIEWER IS ATTACHED. "Viewer
 * attached" must be a READING (e.g. the display server's client count), never an
 * assumption; an UNKNOWN count refuses. Only an explicit human override proceeds.
 *
 * @param {{mode?: 'login' | 'control' | null, viewerCount?: number | null, humanOverride?: boolean}} s
 * @returns {{verdict: 'allowed' | 'refused', reason: string}}
 */
export function lifecycleGuard({ mode = null, viewerCount = null, humanOverride = false } = {}) {
  if (humanOverride === true) {
    return { verdict: 'allowed', reason: 'explicit human override — the human accepted interrupting the browser' };
  }
  if (mode === 'login') {
    return { verdict: 'refused', reason: 'target is in LOGIN MODE: a human is signing in; only they end it' };
  }
  if (!Number.isInteger(viewerCount) || /** @type {number} */ (viewerCount) < 0) {
    return { verdict: 'refused', reason: 'viewer count UNKNOWN — refusing rather than assuming nobody is watching' };
  }
  if (/** @type {number} */ (viewerCount) > 0) {
    return { verdict: 'refused', reason: `${viewerCount} viewer(s) attached: someone may be using this browser` };
  }
  if (mode !== 'control') {
    return { verdict: 'refused', reason: 'mode UNKNOWN — refusing rather than assuming control mode' };
  }
  return { verdict: 'allowed', reason: 'control mode and no viewer attached (both read)' };
}
