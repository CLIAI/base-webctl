// remotes.test.js — rm7t's validators, each in BOTH directions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, checkConfigMode, versionVerdict, inventoryRows } from '../lib/remotes.js';

const OK = { name: 'workstation', control: 'ssh', ssh: 'workstation', view: ['ssh', 'tailscale-relay'],
  kind: 'docker-xpra', profile_id: 'main' };

test('CONTROL: a well-formed target is valid', () => {
  const v = validateTarget(OK);
  assert.equal(v.verdict, 'valid', JSON.stringify(v.errors));
});

test('⛔ control = "tailscale" is refused with its OWN message — and tailscale-relay viewing is fine', () => {
  const v = validateTarget({ ...OK, control: 'tailscale' });
  assert.equal(v.verdict, 'invalid');
  assert.match(v.errors[0].message, /control never travels over the tailnet/);
  assert.match(v.errors[0].message, /--tailscale <host> to reach ssh/, 'it tells the operator what to do instead');
  // control arm: the tailnet is acceptable for VIEW
  assert.equal(validateTarget({ ...OK, view: ['tailscale-relay'] }).verdict, 'valid');
});

test('⛔ a path-like profile_id is refused (btg4 §2) — an opaque one loads', () => {
  for (const p of ['/home/x/profile', '~/p', './p', 'a/b', 'a\\b', ' ']) {
    assert.equal(validateTarget({ ...OK, profile_id: p }).verdict, 'invalid', `"${p}" must be refused`);
  }
  assert.equal(validateTarget({ ...OK, profile_id: 'claude-main' }).verdict, 'valid');
});

test('control = "ssh" needs a destination or a machine reference', () => {
  const { ssh, ...noSsh } = OK;
  assert.equal(validateTarget(noSsh).verdict, 'invalid');
  assert.equal(validateTarget({ ...noSsh, machine: 'workstation' }).verdict, 'valid',
    'a reference to the zone manager\'s machine list replaces repeating its ssh value');
  assert.equal(validateTarget({ ...OK, kind: 'vm-ish' }).verdict, 'invalid');
});

test('⛔ config mode: group/other access is REFUSED; 600 is ok; unreadable mode is refused, not assumed', () => {
  assert.equal(checkConfigMode(0o100600).verdict, 'ok');
  assert.equal(checkConfigMode(0o100644).verdict, 'refused');
  assert.equal(checkConfigMode(0o100640).verdict, 'refused');
  assert.equal(checkConfigMode(0o100602).verdict, 'refused');
  assert.match(checkConfigMode(0o100644).reason, /chmod 600/);
  assert.equal(checkConfigMode(/** @type {any} */ (undefined)).verdict, 'refused');
});

test('⛔ refresh verification: a STALE reading is outdated and names BOTH values', () => {
  const rd = { value: '154.0.8037.92', instrument: 'chromium --version in container', at: '2026-10-02T12:00Z' };
  const stale = versionVerdict({ reading: rd, declared: '155.0.8102.4' });
  assert.equal(stale.verdict, 'outdated');
  assert.match(stale.reason, /reads 154\.0\.8037\.92, declared 155\.0\.8102\.4/);
  // control: the declared version reads current
  assert.equal(versionVerdict({ reading: { ...rd, value: '155.0.8102.4' }, declared: '155.0.8102.4' }).verdict, 'current');
  // newer than declared is not silently "current"
  assert.equal(versionVerdict({ reading: { ...rd, value: '156.0.1' }, declared: '155.0.8102.4' }).verdict, 'ahead');
});

test('⛔ no reading, no instrument, or no declaration is UNKNOWN — never current', () => {
  assert.equal(versionVerdict({ reading: null, declared: '1.0' }).verdict, 'unknown');
  assert.equal(versionVerdict({ reading: { value: '1.0' }, declared: '1.0' }).verdict, 'unknown',
    'a value without its instrument is a claim, not a measurement');
  assert.equal(versionVerdict({ reading: { value: '1.0', instrument: 'x' }, declared: null }).verdict, 'unknown');
  assert.equal(versionVerdict({ reading: { value: 'v0.17.1-x', instrument: 'git' }, declared: 'v0.17.1' }).verdict, 'differs');
});

test('⛔ inventory: an unreachable target is an UNKNOWN row, never omitted — rows == targets', () => {
  const rows = inventoryRows(['a', 'b', 'c'], {
    a: { value: '154', instrument: 'chromium --version', at: 'T' },
    c: { value: '154', instrument: '', at: 'T' }, // a reading without its instrument
  });
  assert.equal(rows.length, 3, 'every target gets a row');
  assert.deepEqual(rows.map((r) => r.state), ['read', 'unknown', 'unknown']);
});

// ── the zone manager's host list (rm7t §2, resolved) ─────────────────────────
import { parseMachineList } from '../lib/remotes.js';

test('CONTROL: a schema-1 host list parses', () => {
  const r = parseMachineList(JSON.stringify({ schema: 1, path: '/x', present: true,
    machines: [{ alias: 'ws', ssh: 'ws', shadows_local_zone: false, reachable: true }] }));
  assert.equal(r.verdict, 'ok', r.reason);
  assert.deepEqual(r.machines, [{ alias: 'ws', ssh: 'ws', reachability: 'reachable' }]);
});

test('⛔ an ABSENT reachable key is NOT CHECKED, never unreachable', () => {
  const r = parseMachineList(JSON.stringify({ schema: 1, present: true, machines: [
    { alias: 'a', ssh: 'a' }, { alias: 'b', ssh: 'b', reachable: false }] }));
  assert.equal(r.machines[0].reachability, 'not-checked', 'absence is not a zero');
  assert.equal(r.machines[1].reachability, 'unreachable');
});

test('⛔ an unknown schema is REFUSED, not guessed at', () => {
  const r = parseMachineList(JSON.stringify({ schema: 2, present: true, machines: [{ alias: 'a', ssh: 'a' }] }));
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /refusing to guess/);
  assert.equal(parseMachineList(JSON.stringify({ present: true, machines: [] })).verdict, 'unknown', 'missing schema');
  assert.equal(parseMachineList('not json').verdict, 'unknown');
});

test('⛔ a malformed entry makes the list UNKNOWN rather than silently dropping a host', () => {
  const r = parseMachineList(JSON.stringify({ schema: 1, present: true, machines: [{ alias: 'a', ssh: 'a' }, { alias: 'b' }] }));
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.machines.length, 0);
});

test('present:false with an empty list is a VALID state — no host file', () => {
  const r = parseMachineList(JSON.stringify({ schema: 1, path: '/x', present: false, machines: [] }));
  assert.equal(r.verdict, 'ok');
  assert.equal(r.present, false);
  assert.match(r.reason, /valid state/);
});

// ── closed keys, enums, rules (v0.18.1) ──────────────────────────────────────
// ⛔ v0.18.0 accepted any key and checked only the fields it looked at:
// {role:'prod', placement:'cloud', zone:'..', bogus_key:1} read "valid".
import { TARGET_ENUMS } from '../lib/remotes.js';

/** gemini's REAL target shape — 4 targets, keyed by map key (no `name` field). */
const gem = (over = {}) => ({ role: 'dev', placement: 'workstation', control: 'ssh', view: 'ssh',
  ssh: 'example-host', zone: 'gemchrome', app: 'chromium', lifecycle: 'attach-only',
  tunnel: 'per-invocation', profile_id: 'p-0123456789abcdef', ...over });

test('⭐ REAL SHAPES stay valid: gemini\'s 4 targets, perplexity\'s, and btg4\'s example', () => {
  const four = {
    'gem-dev-chromium': gem(),
    'gem-dev-opera': gem({ app: 'opera', zone: 'gemopera' }),
    'gem-test-chromium': gem({ role: 'test', zone: 'gemtestchrome' }),
    'gem-test-opera': gem({ role: 'test', app: 'opera', zone: 'gemtestopera' }),
  };
  for (const [name, t] of Object.entries(four)) {
    const v = validateTarget(t, { name });
    assert.equal(v.verdict, 'valid', `${name}: ${JSON.stringify(v.errors)}`);
  }
  const pplx = { control: 'ssh', ssh: 'example-host', zone: 'pplxchrome', app: 'chromium',
    lifecycle: 'attach-only', local_cdp_port: 4837 };
  assert.equal(validateTarget(pplx, { name: 'chromium' }).verdict, 'valid');
  const btg4 = { name: 'workstation', control: 'ssh', view: ['ssh', 'tailscale-relay'], ssh: 'workstation',
    kind: 'docker-xpra', slug: 'default', base: 'debian', profile_id: 'claude-main', lifecycle: 'owner' };
  assert.equal(validateTarget(btg4).verdict, 'valid', JSON.stringify(validateTarget(btg4).errors));
});

test('⛔ CLOSED: an unknown key is refused BY NAME — and the error never echoes its value', () => {
  const v = validateTarget(gem({ bogus_key: 'secret-host-value-xyz' }));
  assert.equal(v.verdict, 'invalid');
  assert.ok(v.errors.some((e) => e.field === 'bogus_key' && /unknown key/.test(e.message)));
  assert.ok(!JSON.stringify(v.errors).includes('secret-host-value-xyz'), 'a value must never appear in a message');
});

test('⛔ every enum refuses an out-of-range value, each with a valid control', () => {
  const bad = { role: 'prod', placement: 'cloud', lifecycle: 'nonsense', app: 'firefox',
    tunnel: 'persistent', kind: 'vm', base: 'alpine', view: 'tcp' };
  for (const [k, v] of Object.entries(bad)) {
    assert.equal(validateTarget(gem({ [k]: v })).verdict, 'invalid', `${k}=${v} must be refused`);
    assert.equal(validateTarget(gem({ [k]: TARGET_ENUMS[/** @type {keyof typeof TARGET_ENUMS} */ (k)][0] })).verdict,
      'valid', `${k} control`);
  }
  assert.equal(validateTarget(gem({ view: [] })).verdict, 'invalid', 'an empty view list says nothing');
});

test('⛔ zone follows the zone-manager rule: `..` is refused', () => {
  for (const z of ['..', 'Gem', '1gem', 'gem-chrome', 'a'.repeat(31)]) {
    assert.equal(validateTarget(gem({ zone: z })).verdict, 'invalid', `zone "${z}"`);
  }
  assert.equal(validateTarget(gem({ zone: 'gemchrome' })).verdict, 'valid');
});

test('⛔ SECURITY: an ssh alias starting with "-" is refused — ssh would read it as an option', () => {
  // `-oProxyCommand=…` passed through to ssh is command execution on the operator's machine.
  for (const a of ['-oProxyCommand=touch /tmp/pwned', '-v', '--', 'host name', 'a;b']) {
    const v = validateTarget(gem({ ssh: a }));
    assert.equal(v.verdict, 'invalid', `ssh "${a}" must be refused`);
    assert.ok(!JSON.stringify(v.errors).includes(a), 'and the refusal must not echo it');
  }
  assert.equal(validateTarget(gem({ ssh: 'example-host.lan' })).verdict, 'valid');
  assert.equal(validateTarget(gem({ ssh: undefined, machine: '-oProxyCommand=x' })).verdict, 'invalid');
});

test('⛔ FORBIDDEN keys are refused WITH their reason, not as mere typos', () => {
  for (const k of ['cdp_port', 'owner', 'user_data_dir', 'transport', 'host']) {
    const v = validateTarget(gem({ [k]: 'x' }));
    const e = v.errors.find((x) => x.field === k);
    assert.ok(e && /^refused: /.test(e.message), `${k} must be refused with a reason`);
  }
});

test('local_cdp_port is a stated integer in range; name is checked when given as a map key', () => {
  assert.equal(validateTarget(gem({ local_cdp_port: 80 })).verdict, 'invalid');
  assert.equal(validateTarget(gem({ local_cdp_port: '4827' })).verdict, 'invalid', 'a string is not a stated port');
  assert.equal(validateTarget(gem({ local_cdp_port: 4827 })).verdict, 'valid');
  assert.equal(validateTarget(gem(), { name: 'Gem Dev' }).verdict, 'invalid');
  assert.equal(validateTarget(gem(), { name: 'gem-dev' }).verdict, 'valid');
});

// ── `xq app version --json` (rm7t §3/§4) ─────────────────────────────────────
import { parseAppVersion } from '../lib/remotes.js';

const appv = (over = {}) => JSON.stringify({ schema: 1, zone: 'z', app: 'chromium',
  next: { image: 'xq-app-chromium-debian', distro: 'debian', image_id: 'c608ea0', version: 'Chromium 155', source: 'binary' },
  running: { container: 'c', image_id: '19ff6bb', is_running: true, version: 'Chromium 154', source: 'binary' },
  stale: true, ...over });

test('CONTROL: both readings parse, labelled, and staleness is carried as given', () => {
  const r = /** @type {any} */ (parseAppVersion(appv()));
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.next.imageId, 'c608ea0');
  assert.equal(r.running.imageId, '19ff6bb');
  assert.equal(r.stale, true);
  assert.equal(r.next.measured, true);
});

test('⛔ a version from an image LABEL is a claim, not a measurement', () => {
  const r = /** @type {any} */ (parseAppVersion(appv({ next: { image_id: 'x', version: '155', source: 'label' } })));
  assert.equal(r.next.measured, false);
  assert.match(r.reason, /not measured/);
});

test('⛔ non-JSON (an argument swallowed, the human table printed) and unknown schema are UNKNOWN', () => {
  assert.equal(parseAppVersion('ZONE  APP  VERSION\nz  chromium  155').verdict, 'unknown');
  assert.equal(parseAppVersion(appv({ schema: 2 })).verdict, 'unknown');
});

test('no container means stale is NOT APPLICABLE (null), never false', () => {
  const r = /** @type {any} */ (parseAppVersion(appv({ running: null, stale: null })));
  assert.equal(r.verdict, 'ok');
  assert.equal(r.stale, null, 'nothing running is not "up to date"');
  assert.equal(r.running, null);
});

test('⛔ an xq too old for `app version` is named as such — not as a swallowed argument', () => {
  // Built from the REAL argparse text of the installed xq (`xq app nosuchverb`), with the
  // rejected verb set to 'version' and 'version' dropped from the choices — exactly what an
  // xq predating the verb prints. Measured live on two hosts by a lane.
  const old = 'usage: xq <subcommand> [...]    (try `xq --help`) app [-h] [--help-for-agents]\n'
    + '                                                      {run,stop,ls,exec,rm,logs} ...\n'
    + "xq <subcommand> [...]    (try `xq --help`) app: error: argument app_verb: invalid choice: 'version' "
    + '(choose from run, stop, ls, exec, rm, logs)\n';
  const r = parseAppVersion(old);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /xq too old/);
  // controls: other non-JSON keeps the general reason; real JSON still parses
  assert.match(parseAppVersion('ZONE APP VERSION\nz chromium 155').reason, /argument was probably swallowed/);
  assert.equal(parseAppVersion(appv()).verdict, 'ok');
});

// ── version normalisation + login-mode inventory (next release) ───────────────
import { normalizeVersion } from '../lib/remotes.js';

test('⛔ REAL version lines normalise to their dotted version, raw kept beside it', () => {
  // Read from the local images' own binaries (chromium, opera); Firefox as measured by the
  // zone-manager lane.
  const c = normalizeVersion('Chromium 152.0.7977.82 built on Debian GNU/Linux 12 (bookworm)');
  assert.deepEqual(c, { version: '152.0.7977.82', raw: 'Chromium 152.0.7977.82 built on Debian GNU/Linux 12 (bookworm)' });
  assert.equal(normalizeVersion('136.0.6008.22').version, '136.0.6008.22');
  assert.equal(normalizeVersion('Mozilla Firefox 156.0.1').version, '156.0.1');
  // the false-outdated it fixes: raw line vs declared now compares as current
  const rd = { value: c.version || '', instrument: 'chromium --version', at: 'T' };
  assert.equal(versionVerdict({ reading: rd, declared: '152.0.7977.82' }).verdict, 'current');
});

test('⛔ a dotted number in the DISTRO part does not confuse it — and ambiguity is UNKNOWN', () => {
  assert.equal(normalizeVersion('Chromium 154.0.8037.92 built on Ubuntu 24.04.1 LTS').version, '154.0.8037.92');
  // control: no anchor and two candidates → never a guess
  assert.equal(normalizeVersion('Chromium 154.0.8037.92 Ubuntu 24.04').version, null);
  assert.equal(normalizeVersion('Chromium (unknown build)').version, null);
  assert.equal(normalizeVersion(null).version, null);
});

test('parseAppVersion carries the normalised version AND the raw line', () => {
  const r = /** @type {any} */ (parseAppVersion(appv({ next: { image_id: 'x', source: 'binary',
    version: 'Chromium 155.0.1 built on Debian GNU/Linux 12 (bookworm)' } })));
  assert.equal(r.next.version, '155.0.1');
  assert.match(r.next.raw, /built on Debian/);
});

test('⛔ inventory never reads a LOGIN-MODE target — an UNKNOWN row with the reason', () => {
  const rows = inventoryRows(['a', 'b'], {
    a: { value: '154', instrument: 'xq app version', at: 'T' },
    b: { value: '154', instrument: 'xq app version', at: 'T' },
  }, { loginMode: ['b'] });
  assert.equal(rows[0].state, 'read', 'control: a target not in login mode is read');
  assert.equal(rows[1].state, 'unknown');
  assert.equal(rows[1].reading, null, 'even a reading that exists is not used');
  assert.match(rows[1].reason, /login mode — never read/);
});

// ── nl0c: never assume where the browser runs ────────────────────────────────
import { resolveTarget, findHostLiterals } from '../lib/remotes.js';

test('⛔ nothing set ⇒ REFUSED with instructions naming all three fixes', () => {
  const r = resolveTarget([{ source: 'flag' }, { source: 'env', value: '  ' }, { source: 'config', value: '' }],
    { tool: 'demo-webctl', envKey: 'DEMO_WEBCTL_TARGET', configPath: '~/.config/webctl/demo.toml' });
  assert.equal(r.verdict, 'refused');
  assert.match(r.reason, /never assumes one/);
  assert.match(r.reason, /--target <name>/);
  assert.match(r.reason, /DEMO_WEBCTL_TARGET/);
  assert.match(r.reason, /default_target/);
  // control: a declared config default resolves
  assert.equal(resolveTarget([{ source: 'config', value: 'workstation' }]).verdict, 'resolved');
});

test('⭐ precedence flag > env > config, proven with THREE DISTINCT hosts', () => {
  const L = [{ source: 'config', value: 'host-c' }, { source: 'env', value: 'host-b' }, { source: 'flag', value: 'host-a' }];
  const all = /** @type {any} */ (resolveTarget(L));
  assert.equal(all.value, 'host-a');
  assert.deepEqual(all.shadowed, ['env', 'config']);
  assert.equal(/** @type {any} */ (resolveTarget(L.slice(0, 2))).value, 'host-b', 'env beats config');
  assert.equal(/** @type {any} */ (resolveTarget(L.slice(0, 1))).value, 'host-c', 'config alone');
});

test('⛔ the no-host-literal check finds a PLANTED literal — and refuses to scan for nothing', () => {
  const files = [
    { path: 'lib/a.js', text: "const host = 'workstation-a';\nconst x = 1;" },
    { path: 'lib/b.js', text: '// remote: workstation-ab is unrelated\nnothing here' },
  ];
  const r = findHostLiterals(files, ['workstation-a']);
  assert.equal(r.verdict, 'found');
  assert.deepEqual(r.hits, [{ path: 'lib/a.js', line: 1, name: 'workstation-a' }], 'whole-word: workstation-ab is not a hit');
  // control: clean files are clean
  assert.equal(findHostLiterals([{ path: 'c.js', text: 'const n = 2;' }], ['workstation-a']).verdict, 'clean');
  // vacuity
  assert.equal(findHostLiterals(files, []).verdict, 'refused');
  assert.equal(findHostLiterals([], ['workstation-a']).verdict, 'refused');
});
