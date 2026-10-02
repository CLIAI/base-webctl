// remotes.js — validators for rm7t: remote targets, refresh verification, inventory.
//
// Design: docs/design/arch-remote-targets-build-inventory-rm7t.md
//
// Pure: no fs, no network, no process. Lanes do the reading (over ssh, from their
// zone manager); base decides whether what they read is acceptable. Every verdict is
// tri-state where "cannot tell" is possible, and UNKNOWN never collapses into the
// reassuring answer.

/**
 * The family's target vocabulary — the closed SUPERSET of what lanes run on today
 * (btg4 §4, the template spec, and two lanes' real configs). A lane may narrow it; base
 * refuses anything outside it.
 *
 * ⛔ CLOSED. The first version accepted any key and checked only the fields it looked
 * at, so `{role:'prod', placement:'cloud', zone:'..', bogus_key:1}` read "valid" — a
 * validator that accepts what it does not look at, and a lane reads "valid" as
 * "well-formed". Found by a lane and reproduced by webctl:mgr against v0.18.0.
 */
export const TARGET_ENUMS = Object.freeze({
  control: Object.freeze(['ssh', 'local']),
  view: Object.freeze(['ssh', 'tailscale-relay']),
  app: Object.freeze(['opera', 'chromium']),
  lifecycle: Object.freeze(['owner', 'attach-only']),
  role: Object.freeze(['dev', 'test']),
  placement: Object.freeze(['workstation', 'operator']),
  tunnel: Object.freeze(['per-invocation']),
  kind: Object.freeze(['docker-xpra', 'direct', 'managed-zone']),
  base: Object.freeze(['debian', 'arch', 'ubuntu']),
});

/** Keys whose VALUE is checked by a rule rather than an enum. */
const RULED_KEYS = Object.freeze(['name', 'ssh', 'machine', 'zone', 'profile_id', 'local_cdp_port', 'slug']);

/** Every key a target may carry. Anything else is refused, by name. */
export const TARGET_KEYS = Object.freeze([...Object.keys(TARGET_ENUMS), ...RULED_KEYS]);

/**
 * Keys that are refused with a REASON, because each is a known wrong idea rather than
 * a typo. From a lane's battle-tested config, plus the template's "no owner mirror".
 */
export const FORBIDDEN_TARGET_KEYS = Object.freeze({
  remote_cdp_port: 'the remote CDP port is read live, never stored (btg4 §4)',
  cdp_port: 'the remote CDP port is read live, never stored; a local tunnel port is local_cdp_port',
  port: 'ambiguous: a local tunnel port is local_cdp_port; the remote one is never stored',
  profile_path: 'a target never names a profile path; use the opaque profile_id (btg4 §2)',
  profile_dir: 'a target never names a profile path; use the opaque profile_id (btg4 §2)',
  user_data_dir: 'a target never names a profile path; use the opaque profile_id (btg4 §2)',
  transport: 'transport is per surface: use control (ssh|local) and view (btg4 §4)',
  host: 'the CDP host is always loopback; the remote host is the ssh alias',
  owner: 'ownership is state proven by the claim, never stored in config (ow9k)',
});

/** Target names, lower case so an env-name mapping cannot collide by case. */
export const TARGET_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** Zone-manager zone names. `..` is refused. */
export const ZONE_RE = /^[a-z][a-z0-9]{0,29}$/;
/**
 * An ssh alias, passed THROUGH to ssh (btg4 §5).
 * ⛔ It must not start with `-`: ssh would read `-oProxyCommand=…` as an OPTION, which
 * is command execution on the operator's machine. The first version of this validator
 * accepted that.
 */
export const SSH_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** An opaque profile id — never a path (btg4 §2). */
export const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate a target record.
 *
 * Lanes key targets by map key (`{targets: {"<name>": {...}}}`) while btg4's per-file
 * form carries `name` inside — so `name` is OPTIONAL in the record, and a map key is
 * checked by passing it as `opts.name`.
 *
 * ⛔ Messages NAME KEYS, NEVER VALUES: a config value can be a host, and an error
 * message is the most-copied text a tool prints.
 *
 * @param {Record<string, any>} t
 * @param {{name?: string}} [opts]
 * @returns {{verdict: 'valid' | 'invalid', errors: {field: string, message: string}[]}}
 */
export function validateTarget(t, opts = {}) {
  /** @type {{field: string, message: string}[]} */
  const errors = [];
  const add = (/** @type {string} */ field, /** @type {string} */ message) => errors.push({ field, message });
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    return { verdict: 'invalid', errors: [{ field: '*', message: 'not a record' }] };
  }

  for (const k of Object.keys(t)) {
    if (Object.hasOwn(FORBIDDEN_TARGET_KEYS, k)) add(k, `refused: ${/** @type {any} */ (FORBIDDEN_TARGET_KEYS)[k]}`);
    else if (!TARGET_KEYS.includes(k)) add(k, 'unknown key');
  }

  // ⛔ The tailscale refusal keeps its OWN message: the operator must learn WHY.
  if (t.control === 'tailscale') {
    add('control', 'control never travels over the tailnet; use --tailscale <host> to '
      + 'reach ssh, and control goes through ssh');
  } else if (!TARGET_ENUMS.control.includes(t.control)) {
    add('control', `required, one of ${TARGET_ENUMS.control.join(' | ')}`);
  }

  for (const key of /** @type {(keyof typeof TARGET_ENUMS)[]} */ (Object.keys(TARGET_ENUMS))) {
    if (key === 'control' || t[key] === undefined) continue;
    const vals = key === 'view' && Array.isArray(t[key]) ? t[key] : [t[key]];
    if (vals.length === 0 || vals.some((v) => !TARGET_ENUMS[key].includes(v))) {
      add(key, `must be ${key === 'view' ? 'drawn from' : 'one of'} ${TARGET_ENUMS[key].join(' | ')}`);
    }
  }

  const rule = (/** @type {string} */ key, /** @type {RegExp} */ re, /** @type {string} */ msg) => {
    if (t[key] !== undefined && !(typeof t[key] === 'string' && re.test(t[key]))) add(key, msg);
  };
  rule('name', TARGET_NAME_RE, 'lower-case letters, digits, "_" or "-", starting with a letter');
  rule('ssh', SSH_ALIAS_RE, 'an ssh alias of letters, digits, ".", "_", "-", never starting with "-" '
    + '(ssh would read it as an option)');
  rule('machine', SSH_ALIAS_RE, 'a machine name from the zone manager\'s list, never starting with "-"');
  rule('zone', ZONE_RE, 'a zone name: lower-case letter, then letters or digits, at most 30');
  rule('slug', SLUG_RE, 'lower-case letters, digits, "_" or "-"');
  if (t.profile_id !== undefined) {
    const p = typeof t.profile_id === 'string' ? t.profile_id : '';
    if (/[\\/]/.test(p) || /^[~.]/.test(p)) add('profile_id', 'must be an opaque id, never a path (btg4 §2)');
    else if (!PROFILE_ID_RE.test(p)) add('profile_id', 'an opaque id of letters, digits, ".", "_", "-"');
  }
  if (t.local_cdp_port !== undefined
      && !(Number.isInteger(t.local_cdp_port) && t.local_cdp_port >= 1024 && t.local_cdp_port <= 65535)) {
    add('local_cdp_port', 'a stated integer port, 1024-65535');
  }

  if (t.control === 'ssh' && t.ssh === undefined && t.machine === undefined) {
    add('ssh', 'control = "ssh" needs an ssh alias or a machine reference');
  }
  if (opts.name !== undefined && !TARGET_NAME_RE.test(String(opts.name))) {
    add('name', 'target name: lower-case letters, digits, "_" or "-", starting with a letter');
  }
  return { verdict: errors.length ? 'invalid' : 'valid', errors };
}

/**
 * Is a config file's mode acceptable? Refuses anything readable or writable by group
 * or other — on shared hosts, a host-and-target map is reconnaissance (D8).
 *
 * @param {number} mode st_mode or permission bits
 * @returns {{verdict: 'ok' | 'refused', reason: string}}
 */
export function checkConfigMode(mode) {
  if (typeof mode !== 'number' || !Number.isFinite(mode)) {
    return { verdict: 'refused', reason: 'mode could not be read — refusing rather than assuming 600' };
  }
  const bits = mode & 0o777;
  return (bits & 0o077)
    ? { verdict: 'refused', reason: `mode ${bits.toString(8).padStart(3, '0')} is readable or writable beyond its owner; chmod 600` }
    : { verdict: 'ok', reason: `mode ${bits.toString(8).padStart(3, '0')}` };
}

/** @param {string} s */
const numeric = (s) => (/^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null);

/**
 * Compare a READING against a DECLARED target, naming both.
 *
 * ⛔ A refresh that exits 0 is not a refresh: measured, a plain rebuild reproduced a
 * stale browser because the package layer was cached. Success is the binary's own
 * reported version equalling the declared candidate.
 *
 * @param {{reading?: {value?: string|null, instrument?: string, at?: string} | null, declared?: string | null}} x
 * @returns {{verdict: 'current' | 'outdated' | 'ahead' | 'differs' | 'unknown',
 *   reading: string | null, declared: string | null, reason: string}}
 */
export function versionVerdict({ reading, declared } = {}) {
  const r = reading && typeof reading.value === 'string' && reading.value.trim() ? reading.value.trim() : null;
  const d = typeof declared === 'string' && declared.trim() ? declared.trim() : null;
  if (!r) return { verdict: 'unknown', reading: null, declared: d, reason: 'no reading — unreachable or unread is UNKNOWN, not current' };
  if (!d) return { verdict: 'unknown', reading: r, declared: null, reason: 'no declared target to compare against' };
  if (!reading || !reading.instrument) {
    return { verdict: 'unknown', reading: r, declared: d, reason: 'a reading without its instrument is a claim, not a measurement' };
  }
  if (r === d) return { verdict: 'current', reading: r, declared: d, reason: `reads ${r}, declared ${d}` };
  const a = numeric(r), b = numeric(d);
  if (a && b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) {
        return x < y
          ? { verdict: 'outdated', reading: r, declared: d, reason: `reads ${r}, declared ${d}` }
          : { verdict: 'ahead', reading: r, declared: d, reason: `reads ${r}, newer than declared ${d} — the declaration may be stale` };
      }
    }
    return { verdict: 'current', reading: r, declared: d, reason: `reads ${r}, declared ${d}` };
  }
  return { verdict: 'differs', reading: r, declared: d, reason: `reads ${r}, declared ${d} — not comparable as versions` };
}

/**
 * Build inventory rows so that EVERY target has one. An unreachable target is an
 * UNKNOWN row, never an omitted one — an inventory that drops what it could not reach
 * reports a smaller fleet as a healthier one.
 *
 * ⛔ A target in LOGIN MODE is never read (lg1n): the `running` reading is taken by
 * `exec` into the container, and login mode's window belongs to the human signing in. It
 * gets an UNKNOWN row saying so — the instrument's side effect is the reason, found by a
 * lane during rollout.
 *
 * @param {string[]} targets target names
 * @param {Record<string, {value: string, instrument: string, at: string}>} readings by target
 * @param {{loginMode?: string[]}} [opts] targets currently in login mode
 * @returns {{target: string, state: 'read' | 'unknown', reading: any, reason: string}[]}
 */
export function inventoryRows(targets, readings, opts = {}) {
  const rd = readings || {};
  const login = new Set(Array.isArray(opts.loginMode) ? opts.loginMode : []);
  return (Array.isArray(targets) ? targets : []).map((t) => {
    if (login.has(t)) {
      return { target: t, state: /** @type {'unknown'} */ ('unknown'), reading: null,
        reason: 'login mode — never read; reading it would exec into a browser a human is signing in on' };
    }
    const r = rd[t];
    const ok = r && typeof r.value === 'string' && r.value && r.instrument && r.at;
    return { target: t, state: ok ? 'read' : 'unknown', reading: ok ? r : null,
      reason: ok ? `read by ${r.instrument} at ${r.at}` : 'no reading — unreachable or unread' };
  });
}

/** The `xq machine ls --json` schema this reader understands. */
export const MACHINE_LIST_SCHEMA = 1;

/**
 * Parse the zone manager's host list — the output of `xq machine ls --json`.
 *
 * ⭐ The COMMAND is the contract, never the file (rm7t §2): the zone-manager lane
 * versions the JSON (`schema`) and promises nothing about its file's shape.
 *
 * ⛔ Fail-closed, as that lane documents it: an unknown `schema` is UNKNOWN and refused
 * rather than guessed at. A malformed entry makes the whole list UNKNOWN — a host list
 * with a silently dropped host is a smaller fleet reported as complete.
 *
 * ⛔ `reachable` exists ONLY when the command ran with `--check`. An ABSENT key means
 * NOT CHECKED, never UNREACHABLE; this reader keeps the three states apart.
 *
 * @param {string} text the command's stdout
 * @returns {{verdict: 'ok' | 'unknown', present: boolean | null,
 *   machines: {alias: string, ssh: string, reachability: 'reachable' | 'unreachable' | 'not-checked'}[],
 *   reason: string}}
 */
export function parseMachineList(text) {
  /** @param {string} reason */
  const unknown = (reason) => ({ verdict: /** @type {'unknown'} */ ('unknown'), present: null, machines: [], reason });
  /** @type {any} */
  let j;
  try { j = JSON.parse(String(text)); } catch { return unknown('not JSON — nothing usable was read'); }
  if (!j || typeof j !== 'object') return unknown('not a JSON object');
  if (j.schema !== MACHINE_LIST_SCHEMA) {
    return unknown(`schema ${JSON.stringify(j.schema)} is not ${MACHINE_LIST_SCHEMA}; refusing to guess at a format this reader does not know`);
  }
  if (typeof j.present !== 'boolean' || !Array.isArray(j.machines)) {
    return unknown('schema 1 requires a boolean "present" and a "machines" array');
  }
  /** @type {{alias: string, ssh: string, reachability: 'reachable' | 'unreachable' | 'not-checked'}[]} */
  const machines = [];
  for (const m of j.machines) {
    if (!m || typeof m.alias !== 'string' || !m.alias || typeof m.ssh !== 'string' || !m.ssh) {
      return unknown('an entry lacks alias or ssh — refusing rather than dropping it');
    }
    const reachability = m.reachable === true ? 'reachable'
      : m.reachable === false ? 'unreachable' : 'not-checked';
    machines.push({ alias: m.alias, ssh: m.ssh, reachability });
  }
  return {
    verdict: 'ok',
    present: j.present,
    machines,
    reason: j.present ? `${machines.length} machine(s)` : 'no host file — a valid state, not an error',
  };
}

/**
 * Extract the version from a browser binary's raw `--version` line, keeping the raw line.
 *
 * ⛔ xq's `version` field is the binary's RAW last line ("Chromium 152.0.7977.82 built on
 * Debian GNU/Linux 12 (bookworm)"). Compared as-is against "152.0.7977.82" it reads
 * "differs" — a FALSE outdated — and lanes had started normalising it themselves, each
 * slightly differently. ⇒ One place, here.
 *
 * Rule: drop everything from " built on " onward (the distro can carry a dotted number:
 * an Ubuntu "24.04"), then require EXACTLY ONE dotted numeric token. Zero or several is
 * null — UNKNOWN, never a guess.
 *
 * @param {string | null | undefined} raw
 * @returns {{version: string | null, raw: string | null}}
 */
export function normalizeVersion(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { version: null, raw: null };
  const head = raw.split(/\s+built on\s+/i)[0];
  const tokens = head.match(/\b\d+(?:\.\d+)+\b/g) || [];
  return { version: tokens.length === 1 ? tokens[0] : null, raw: raw.trim() };
}

/** The `xq app version --json` schema this reader understands. */
export const APP_VERSION_SCHEMA = 1;

/**
 * Parse the zone manager's `xq app version <zone>/<app> --json`.
 *
 * It reports TWO readings, which must never be conflated (rm7t §3):
 *  * `next`    — the image that WOULD start (same resolver as `xq up`): what a REFRESH verifies;
 *  * `running` — the container that IS running: what an INVENTORY reports.
 *
 * ⭐ STALENESS IS AN IDENTITY QUESTION, NOT A VERSION ONE. The zone manager compares IMAGE
 * IDS: two builds can print the same version string and still differ, so "would a
 * restart change what runs" cannot be answered by comparing versions.
 *
 * ⛔ A version whose `source` is `label` is the image's own build-time CLAIM, not a
 * measurement; only `binary` (the binary was run and answered) counts as a reading.
 * `measured` reports which.
 *
 * ⛔ Fail-closed: non-JSON (the zone manager's documented bug class — an argument
 * swallowed, the HUMAN table printed with exit 0) or an unknown schema is UNKNOWN.
 *
 * @param {string} text
 * @returns {{verdict: 'ok' | 'unknown', reason: string,
 *   next: {version: string | null, raw: string | null, imageId: string | null, measured: boolean} | null,
 *   running: {version: string | null, raw: string | null, imageId: string | null, measured: boolean,
 *     isRunning: boolean} | null,
 *   stale: boolean | null}}
 */
export function parseAppVersion(text) {
  /** @param {string} reason */
  const unknown = (reason) => ({ verdict: /** @type {'unknown'} */ ('unknown'), reason, next: null, running: null, stale: null });
  /** @type {any} */
  let j;
  try { j = JSON.parse(String(text)); } catch {
    // ⚠ Distinguish the CAUSE, because the remedy differs. An xq older than the
    // `app version` verb rejects it with argparse's own usage text — measured live on
    // two hosts — and the generic "argument swallowed" reason pointed at the wrong fix.
    if (/invalid choice: '?version'?/.test(String(text))) {
      return unknown('xq too old: no `app version` verb (needs the zone manager at or after defd09b); upgrade xq');
    }
    return unknown('not JSON — if human text came back, an argument was probably swallowed; refusing');
  }
  if (!j || typeof j !== 'object') return unknown('not a JSON object');
  if (j.schema !== APP_VERSION_SCHEMA) {
    return unknown(`schema ${JSON.stringify(j.schema)} is not ${APP_VERSION_SCHEMA}; refusing to guess`);
  }
  /** @param {any} r */
  const reading = (r) => ({
    // normalised for comparison; the raw line kept beside it (normalizeVersion)
    ...normalizeVersion(r && r.version),
    imageId: r && typeof r.image_id === 'string' && r.image_id ? r.image_id : null,
    measured: !!(r && r.source === 'binary'),
  });
  const next = j.next && !j.next.error ? reading(j.next) : null;
  const running = j.running ? { ...reading(j.running), isRunning: j.running.is_running === true } : null;
  const stale = j.stale === true ? true : j.stale === false ? false : null;
  return {
    verdict: 'ok',
    reason: next ? `next ${next.version || '?'}${next.measured ? '' : ' (not measured)'}; `
      + `stale ${stale === null ? 'n/a (no container)' : stale}` : `next image unresolved: ${(j.next && j.next.error) || 'missing'}`,
    next, running, stale,
  };
}

/**
 * Resolve WHERE the browser runs: flag, then environment, then config — and nothing
 * implied (nl0c). A default is allowed only where a person DECLARED it (config); a
 * location the code assumed is the bug this exists to remove.
 *
 * ⛔ Nothing set ⇒ REFUSED with instructions naming the three ways to fix it. The
 * refusal never echoes a value. An empty or whitespace value is UNSET, not a location.
 *
 * @param {{source: 'flag' | 'env' | 'config', value?: string | null}[]} layers in precedence order
 * @param {{tool?: string, envKey?: string, configPath?: string}} [hints] for the instructions
 * @returns {{verdict: 'resolved', value: string, source: string, shadowed: string[], reason: string}
 *   | {verdict: 'refused', reason: string}}
 */
export function resolveTarget(layers, hints = {}) {
  const order = ['flag', 'env', 'config'];
  const given = (Array.isArray(layers) ? layers : [])
    .filter((l) => l && order.includes(l.source) && typeof l.value === 'string' && l.value.trim())
    .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  if (given.length === 0) {
    const tool = hints.tool || 'this tool';
    return {
      verdict: 'refused',
      reason: `no browser location given, and ${tool} never assumes one. Pass --target <name> `
        + `(or --ssh <alias>), set ${hints.envKey || 'the tool\'s target environment variable'}, `
        + `or declare a default_target in ${hints.configPath || 'the tool\'s config'}.`,
    };
  }
  const [win, ...rest] = given;
  return {
    verdict: 'resolved',
    value: /** @type {string} */ (win.value).trim(),
    source: win.source,
    shadowed: rest.map((l) => l.source),
    reason: `from the ${win.source}${rest.length ? `; overrode ${rest.map((l) => l.source).join(' and ')}` : ''}`,
  };
}

/**
 * Find host-name literals in source files — the "no host literal in code" check (nl0c).
 *
 * ⚠ The names come from the LANE'S OWN machine list (e.g. `xq machine ls --json`),
 * never from a committed list: base is public, and a list of hosts to forbid would
 * itself publish them.
 *
 * ⛔ Vacuity guards: no names supplied, or no files examined, REFUSES — a scan for
 * nothing reports clean, which is the false-zero shape.
 *
 * @param {{path: string, text: string}[]} files
 * @param {string[]} names host names / aliases to look for
 * @returns {{verdict: 'clean' | 'found' | 'refused', hits: {path: string, line: number, name: string}[],
 *   reason: string}}
 */
export function findHostLiterals(files, names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.trim());
  if (list.length === 0) return { verdict: 'refused', hits: [], reason: 'no host names supplied — the scan would find nothing' };
  if (!Array.isArray(files) || files.length === 0) {
    return { verdict: 'refused', hits: [], reason: 'no files examined — that is not the same as no literals' };
  }
  const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_.-])(${list.map(esc).join('|')})(?=$|[^A-Za-z0-9_-])`, 'g');
  /** @type {{path: string, line: number, name: string}[]} */
  const hits = [];
  for (const f of files) {
    String(f.text).split('\n').forEach((l, i) => {
      for (const m of l.matchAll(re)) hits.push({ path: f.path, line: i + 1, name: m[2] });
    });
  }
  return hits.length
    ? { verdict: 'found', hits, reason: `${hits.length} host literal(s) in ${new Set(hits.map((h) => h.path)).size} file(s)` }
    : { verdict: 'clean', hits, reason: `${files.length} file(s) examined for ${list.length} name(s); none found` };
}
