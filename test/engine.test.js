// engine.test.js — the ENGINE vocabulary is base's (nl0c §1c): ENGINES, ENGINES_PENDING,
// resolveEngine, targetEnvKey('engine'), resolveSharedTarget, and the shared-layer wording.
// Every test touching ~/.config/webctl builds a throwaway HOME and proves nothing was written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ENGINES, ENGINES_PENDING, ENGINE_REFUSAL_CODES, TARGET_ENUMS,
  resolveEngine, resolveTarget, validateTarget,
} from '../lib/remotes.js';
import { loadSharedWebctlConfig, resolveSharedTarget } from '../lib/shared-config.js';
import * as index from '../lib/index.js';

const rec = (app) => ({ control: 'ssh', ssh: 'browserhost', kind: 'docker-xpra', ...(app ? { app } : {}) });

// ── vocabulary ───────────────────────────────────────────────────────────────

test('ENGINES is the record enum itself; firefox is valid and PENDING; all frozen; exported via index', () => {
  assert.equal(ENGINES, TARGET_ENUMS.app, 'one list — a valid record and a valid engine word cannot drift');
  assert.deepEqual([...ENGINES].sort(), ['chromium', 'firefox', 'opera']);
  assert.deepEqual(ENGINES_PENDING, ['firefox']);
  for (const e of ENGINES_PENDING) assert.ok(ENGINES.includes(e), 'a pending engine is still a valid engine');
  assert.ok(Object.isFrozen(ENGINES) && Object.isFrozen(ENGINES_PENDING) && Object.isFrozen(ENGINE_REFUSAL_CODES));
  assert.deepEqual(ENGINE_REFUSAL_CODES, ['no-engine', 'invalid-engine', 'engine-conflict', 'engine-pending']);
  assert.equal(index.remotes.resolveEngine, resolveEngine);
  assert.equal(index.sharedConfig.resolveSharedTarget, resolveSharedTarget);
});

test('a firefox record VALIDATES — control: a garbage app is refused', () => {
  assert.equal(validateTarget(rec('firefox')).verdict, 'valid');
  const bad = validateTarget(rec('netscape'));
  assert.equal(bad.verdict, 'invalid');
  assert.ok(bad.errors.some((e) => e.field === 'app'));
});

// ── resolveEngine: each code path ────────────────────────────────────────────

test('no input at all → no-engine, naming --engine, the env key from hints, and the record', () => {
  const r = /** @type {any} */ (resolveEngine({ hints: { envKey: 'CLIAI_X_BROWSER_ENGINE' } }));
  assert.equal(r.verdict, 'refused');
  assert.equal(r.code, 'no-engine');
  assert.match(r.instructions, /--engine/);
  assert.match(r.instructions, /CLIAI_X_BROWSER_ENGINE/);
  assert.match(r.instructions, /app in the target record/);
  assert.equal(/** @type {any} */ (resolveEngine()).code, 'no-engine', 'no argument at all');
  // Empty and whitespace FLAG/ENV are UNSET, not an engine — control: a real value resolves.
  // (A RECORD whose app is whitespace is not "unset" but MALFORMED — refused invalid-engine;
  // see the quality-review test below. Here the record has no app field at all.)
  assert.equal(/** @type {any} */ (resolveEngine({ flag: '', env: '   ', record: rec() })).code, 'no-engine');
  assert.equal(resolveEngine({ flag: 'chromium' }).verdict, 'resolved');
});

test('flag > env when no record names an app; shadowed reported like resolveTarget', () => {
  const r = /** @type {any} */ (resolveEngine({ flag: 'opera', env: 'chromium', record: rec() }));
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.value, 'opera');
  assert.equal(r.source, 'flag');
  assert.deepEqual(r.shadowed, ['env']);
  assert.equal(r.pending, false);
  const e = /** @type {any} */ (resolveEngine({ env: ' chromium ' }));
  assert.equal(e.value, 'chromium', 'trimmed');
  assert.equal(e.source, 'env');
  assert.deepEqual(e.shadowed, []);
});

test('invalid-engine: a short word is echoed, anything else is "an unknown engine"; allowed list named', () => {
  const r = /** @type {any} */ (resolveEngine({ flag: 'netscape' }));
  assert.equal(r.code, 'invalid-engine');
  assert.match(r.reason, /'netscape'/);
  assert.match(r.reason, /chromium, opera|opera, chromium/);
  for (const v of ['Chromium', 'rm -rf /', 'x'.repeat(21), 'secret-host-value-xyz']) {
    const x = /** @type {any} */ (resolveEngine({ env: v }));
    assert.equal(x.code, 'invalid-engine', v);
    assert.ok(!x.reason.includes(v), `"${v}" must not be echoed`);
    assert.match(x.reason, /an unknown engine/);
  }
  // A record carrying a garbage app (a lane that skipped validateTarget) is refused too.
  assert.equal(/** @type {any} */ (resolveEngine({ record: rec('netscape') })).code, 'invalid-engine');
});

test('⛔ engine-conflict: the record says what RUNS there — from flag AND from env, never overridden', () => {
  const fromFlag = /** @type {any} */ (resolveEngine({ flag: 'opera', record: rec('chromium') }));
  assert.equal(fromFlag.verdict, 'refused');
  assert.equal(fromFlag.code, 'engine-conflict');
  assert.match(fromFlag.reason, /flag asks for 'opera'/);
  assert.match(fromFlag.reason, /record says 'chromium'/);
  const fromEnv = /** @type {any} */ (resolveEngine({ env: 'opera', record: rec('chromium') }));
  assert.equal(fromEnv.code, 'engine-conflict');
  assert.match(fromEnv.reason, /env asks for 'opera'/);
  // flag AGREES but env differs: still a conflict — the env is stating something false about the target.
  assert.equal(/** @type {any} */ (resolveEngine({ flag: 'chromium', env: 'opera', record: rec('chromium') })).code,
    'engine-conflict');
  // Control: agreeing flag and env resolve from the RECORD and are reported as agreeing.
  const ok = /** @type {any} */ (resolveEngine({ flag: 'chromium', env: 'chromium', record: rec('chromium') }));
  assert.equal(ok.verdict, 'resolved');
  assert.equal(ok.source, 'record');
  assert.equal(ok.value, 'chromium');
  assert.deepEqual(ok.agreeing, ['flag', 'env']);
  assert.deepEqual(ok.shadowed, []);
  assert.match(ok.reason, /from the target record; flag and env agree/);
  // Control: the record alone resolves.
  const alone = /** @type {any} */ (resolveEngine({ record: rec('opera') }));
  assert.equal(alone.source, 'record');
  assert.deepEqual(alone.agreeing, []);
});

test('engine-pending: firefox is refused for a DRIVING run, resolved+pending for a describe-only verb', () => {
  for (const inputs of [{ flag: 'firefox' }, { env: 'firefox' }, { record: rec('firefox') }]) {
    const r = /** @type {any} */ (resolveEngine(inputs));
    assert.equal(r.verdict, 'refused', JSON.stringify(inputs));
    assert.equal(r.code, 'engine-pending');
    assert.match(r.reason, /BiDi/);
    const w = /** @type {any} */ (resolveEngine({ ...inputs, hints: { allowPending: true } }));
    assert.equal(w.verdict, 'resolved');
    assert.equal(w.value, 'firefox');
    assert.equal(w.pending, true);
    assert.match(w.reason, /PENDING/);
  }
  // allowPending must be exactly true — a truthy string is not consent.
  assert.equal(/** @type {any} */ (resolveEngine({ flag: 'firefox', hints: { allowPending: /** @type {any} */ ('yes') } })).code,
    'engine-pending');
  // Control: a drivable engine is not pending either way.
  assert.equal(/** @type {any} */ (resolveEngine({ flag: 'chromium', hints: { allowPending: true } })).pending, false);
  // Conflict is judged BEFORE pending: firefox flag on a chromium record is a conflict, not "pending".
  assert.equal(/** @type {any} */ (resolveEngine({ flag: 'firefox', record: rec('chromium') })).code, 'engine-conflict');
});

test('⛔ the code set is CLOSED — no input matrix produces a code outside ENGINE_REFUSAL_CODES', () => {
  const vals = [undefined, null, '', '  ', 'chromium', 'opera', 'firefox', 'netscape', 'Bad Value!', 42, {}];
  const recs = [undefined, null, {}, rec(), rec('chromium'), rec('opera'), rec('firefox'), rec('netscape'),
    /** @type {any} */ ({ app: 7 })];
  const seen = new Set();
  let n = 0;
  for (const flag of vals) for (const env of vals) for (const record of recs) for (const allowPending of [false, true]) {
    const r = /** @type {any} */ (resolveEngine({ flag, env, record, hints: { allowPending } }));
    n++;
    assert.ok(['resolved', 'refused'].includes(r.verdict), `verdict ${r.verdict}`);
    if (r.verdict === 'refused') {
      assert.ok(ENGINE_REFUSAL_CODES.includes(r.code), `unlisted code ${r.code}`);
      assert.equal(typeof r.reason, 'string');
      seen.add(r.code);
    } else {
      assert.ok(ENGINES.includes(r.value));
      assert.ok(['flag', 'env', 'record'].includes(r.source));
    }
  }
  assert.ok(n > 1000, `the matrix actually ran (${n})`);
  // And every listed code is REACHABLE — a code nothing produces is a dead entry.
  assert.deepEqual([...seen].sort(), [...ENGINE_REFUSAL_CODES].sort());
});

// ── shared-layer wording (amazonde lane nit) ─────────────────────────────────

test('the shared layer reads "from the shared config (~/.config/webctl)"; other sources unchanged', () => {
  const s = /** @type {any} */ (resolveTarget([{ source: 'shared', value: 'workstation' }]));
  assert.match(s.reason, /^from the shared config \(~\/\.config\/webctl\)$/);
  for (const source of ['flag', 'env', 'config']) {
    const r = /** @type {any} */ (resolveTarget([{ source: /** @type {any} */ (source), value: 'workstation' }]));
    assert.equal(r.reason, `from the ${source}`, source);
  }
  const over = /** @type {any} */ (resolveTarget([{ source: 'config', value: 'a' }, { source: 'shared', value: 'b' }]));
  assert.equal(over.reason, 'from the config; overrode shared');
});

// ── resolveSharedTarget ──────────────────────────────────────────────────────

/** @param {Record<string, string>} files relative path -> text (mode 600) */
function home(files) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-home-'));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(h, '.config', 'webctl', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, text, { mode: 0o600 });
    fs.chmodSync(f, 0o600);
  }
  return h;
}

/** @param {string} dir every path + mtime + size under it, to PROVE nothing was written */
function snapshot(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.statSync(p);
      out.push(`${p}:${st.mtimeMs}:${st.size}:${st.mode}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

const SHARED = {
  'config.toml': 'default_target = "workstation"\n',
  'targets/workstation.toml': 'control = "ssh"\nssh = "browserhost"\napp = "chromium"\nkind = "docker-xpra"\n',
  'targets/fox.toml': 'control = "ssh"\nssh = "browserhost"\napp = "firefox"\nkind = "docker-xpra"\n',
};

/** @param {(h: string) => void} fn */
function withHome(fn, files = SHARED) {
  const h = home(files);
  const before = snapshot(h);
  try {
    fn(h);
    assert.equal(snapshot(h), before, 'resolveSharedTarget wrote nothing under HOME');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
}

test('the shared default wins when nothing else is given — and its record comes back WHOLE', () => withHome((h) => {
  const r = /** @type {any} */ (resolveSharedTarget({ home: h }));
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.source, 'shared');
  assert.equal(r.value, 'workstation');
  assert.deepEqual(r.record, loadSharedWebctlConfig({ home: h }).targets.workstation);
  assert.equal(r.record.ssh, 'browserhost');
  assert.equal(r.recordReason, undefined);
  assert.deepEqual(r.sharedErrors, []);
  assert.match(r.reason, /shared config \(~\/\.config\/webctl\)/);
  // The record then feeds resolveEngine — a firefox target loads, and is pending to drive.
  assert.equal(/** @type {any} */ (resolveEngine({ record: r.record })).value, 'chromium');
}));

test('the lane\'s own config outranks the shared default (shadowed [shared]); unknown name → record null + reason', () => withHome((h) => {
  const r = /** @type {any} */ (resolveSharedTarget({ laneConfig: 'lane-own', home: h }));
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.source, 'config');
  assert.equal(r.value, 'lane-own');
  assert.deepEqual(r.shadowed, ['shared']);
  assert.equal(r.record, null);
  assert.match(r.recordReason, /no shared record named 'lane-own'/);
  // Control: a lane config naming a SHARED record gets that record.
  const c = /** @type {any} */ (resolveSharedTarget({ laneConfig: 'fox', home: h }));
  assert.equal(c.record.app, 'firefox');
  assert.equal(/** @type {any} */ (resolveEngine({ record: c.record })).code, 'engine-pending');
  // A name that is not a target name is not echoed; a prototype key is not a record.
  const odd = /** @type {any} */ (resolveSharedTarget({ flag: 'Not A Name!', home: h }));
  assert.equal(odd.record, null);
  assert.ok(!odd.recordReason.includes('Not A Name!'));
  assert.equal(/** @type {any} */ (resolveSharedTarget({ flag: 'constructor', home: h })).record, null);
}));

test('flag > env > laneConfig > shared, each shadowing the rest; a --port flag is an unnamed attach-only target', () => withHome((h) => {
  const all = /** @type {any} */ (resolveSharedTarget({ flag: 'fox', env: 'e', laneConfig: 'c', home: h }));
  assert.equal(all.source, 'flag');
  assert.deepEqual(all.shadowed, ['env', 'config', 'shared']);
  assert.equal(all.record.app, 'firefox');
  const env = /** @type {any} */ (resolveSharedTarget({ env: 'workstation', laneConfig: 'c', home: h }));
  assert.equal(env.source, 'env');
  assert.deepEqual(env.shadowed, ['config', 'shared']);
  const port = /** @type {any} */ (resolveSharedTarget({ flag: { port: 4877 }, home: h }));
  assert.equal(port.source, 'flag:port');
  assert.equal(port.attachOnly, true);
  assert.equal(port.record, null);
  assert.match(port.recordReason, /unnamed/);
  // --target X --port N: the port QUALIFIES the named target, which keeps its record.
  const both = /** @type {any} */ (resolveSharedTarget({ flag: ['workstation', { port: 4877 }], home: h }));
  assert.equal(both.source, 'flag');
  assert.equal(both.port, 4877);
  assert.equal(both.record.app, 'chromium');
}));

test('no shared dir: refuses as resolveTarget always has; hints pass through; loader errors surface', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-empty-'));
  try {
    const r = /** @type {any} */ (resolveSharedTarget({ home: empty, hints: { envKey: 'CLIAI_X_BROWSER_TARGET' } }));
    assert.equal(r.verdict, 'refused');
    assert.equal(r.code, 'no-target');
    assert.match(r.instructions, /CLIAI_X_BROWSER_TARGET/);
    assert.equal(r.record, null);
    assert.deepEqual(r.sharedErrors, []);
    assert.equal(/** @type {any} */ (resolveSharedTarget({ home: empty, hints: { needsTarget: false } })).verdict, 'not-needed');
    assert.deepEqual(fs.readdirSync(empty), [], 'the loader never creates ~/.config/webctl');
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  // A broken shared file is SURFACED, not swallowed — and the bad record is not returned.
  withHome((h) => {
    const r = /** @type {any} */ (resolveSharedTarget({ flag: 'broken', home: h }));
    assert.equal(r.record, null);
    assert.equal(r.sharedErrors.length, 1);
    assert.match(r.sharedErrors[0], /broken\.toml/);
  }, { 'targets/broken.toml': 'control = "ssh"\napp = "netscape"\n' });
});

// ── quality-review fixes ──────────────────────────────────────────────────────

test('⛔ a record whose app is MALFORMED is refused invalid-engine — never "no app" for a flag to fill', () => {
  for (const app of [42, '   ', true, {}]) {
    const r = /** @type {any} */ (resolveEngine({ record: { app }, flag: 'chromium' }));
    assert.equal(r.verdict, 'refused', JSON.stringify(app));
    assert.equal(r.code, 'invalid-engine', JSON.stringify(app));
    assert.match(r.reason, /record's app is not an engine name/);
  }
  // control: a record with NO app field at all lets the flag decide
  assert.equal(/** @type {any} */ (resolveEngine({ record: { control: 'ssh' }, flag: 'chromium' })).value, 'chromium');
  // and app: null is "no app", the same as absent
  assert.equal(/** @type {any} */ (resolveEngine({ record: { app: null }, flag: 'opera' })).value, 'opera');
});

test('⛔ no message names the user\'s HOME: recordReason and the loader\'s errors use ~/.config/webctl', () => {
  const h = home({
    'config.toml': 'default_target = "workstation"\nbogus = "x"\n',
    'targets/workstation.toml': 'control = "ssh"\nssh = "browserhost"\napp = "chromium"\n',
    'targets/broken.toml': 'control = "ssh"\nuser_data_dir = "/p"\n',
    'targets/unparseable.toml': '[a table]\n',
    'targets/widemode.toml': 'control = "ssh"\nssh = "browserhost"\n',
  });
  // every message path the loader has: a validation error, a parse error, a mode refusal
  fs.chmodSync(path.join(h, '.config', 'webctl', 'targets', 'widemode.toml'), 0o644);
  try {
    const r = /** @type {any} */ (resolveSharedTarget({ flag: 'nosuchtarget', home: h }));
    assert.ok(r.recordReason, 'premise: a named target with no shared record gives a reason');
    assert.ok(!r.recordReason.includes(h), `recordReason must not contain HOME: ${r.recordReason}`);
    assert.match(r.recordReason, /~\/\.config\/webctl\/targets\//);
    assert.ok(r.sharedErrors.length >= 4, `premise: bogus key, broken record, parse error, mode refusal: ${r.sharedErrors.join(' | ')}`);
    assert.ok(r.sharedErrors.some((e) => /unparseable\.toml: line 1/.test(e)), 'the parse-error path is exercised');
    assert.ok(r.sharedErrors.some((e) => /widemode\.toml: mode 644/.test(e)), 'the mode-refusal path is exercised');
    for (const e of r.sharedErrors) {
      assert.ok(!e.includes(h), `a loader error leaked HOME: ${e}`);
      assert.match(e, /^~\/\.config\/webctl\//);
    }
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('an engine word in the wrong case gets a lowercase hint; junk does not', () => {
  assert.match(/** @type {any} */ (resolveEngine({ flag: 'Chromium' })).reason, /engine names are lowercase/);
  const junk = /** @type {any} */ (resolveEngine({ flag: 'rm -rf' })).reason;
  assert.doesNotMatch(junk, /lowercase/);
  assert.ok(!junk.includes('rm -rf'), 'junk is never echoed');
});

test('a pending engine\'s reason is keyed per engine (firefox names BiDi)', () => {
  assert.match(/** @type {any} */ (resolveEngine({ flag: 'firefox' })).reason, /WebDriver BiDi/);
});
