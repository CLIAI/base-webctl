// runtime-xq.test.js — the xq capabilities reader (rx9q §4), each verdict in BOTH
// directions, against a REAL measured `xq capabilities --json` and against stub xq
// binaries for every way the child can fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES_SCHEMA, parseCapabilities, hasVerb, controlFor, readCapabilities,
  hasFlag,
} from '../lib/runtime-xq.js';
import * as index from '../lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'xq-capabilities.schema1.measured.json');
const MEASURED = fs.readFileSync(FIXTURE, 'utf8');
/** a fresh, mutable copy of the measured document */
const doc = () => JSON.parse(MEASURED);
/** @param {any} j */
const parse = (j) => parseCapabilities(JSON.stringify(j));

test('exported from lib/index.js as runtimeXq', () => {
  assert.equal(index.runtimeXq.parseCapabilities, parseCapabilities);
  assert.equal(CAPABILITIES_SCHEMA, 1);
});

// ── the MEASURED document ────────────────────────────────────────────────────

test('MEASURED: parses ok and keeps the facts xq reported', () => {
  const c = parseCapabilities(MEASURED);
  assert.equal(c.verdict, 'ok', c.reason);
  if (c.verdict !== 'ok') return;
  assert.equal(c.schema, 1);
  assert.equal(c.docker, true);
  assert.equal(c.verbs.size, 20);
  assert.equal(c.verbs.get('capabilities'), 1);
  assert.equal(c.verbs.get('app version'), 1);
  assert.equal(c.verbs.get('machine ls'), 1);
  assert.equal(c.verbs.get('zone ls'), null, 'zone ls has no versioned JSON (rx9q X7)');
  assert.deepEqual(c.apps.map((a) => a.app), ['chromium', 'firefox', 'opera', 'prusaslicer', 'xcalc', 'xtest']);
});

test('MEASURED: hasVerb reads the list — listed, absent, json_schema match and mismatch', () => {
  const c = parseCapabilities(MEASURED);
  assert.equal(hasVerb(c, 'capabilities'), true);
  assert.equal(hasVerb(c, 'capabilities', { jsonSchema: 1 }), true);
  assert.equal(hasVerb(c, 'capabilities', { jsonSchema: 2 }), false, 'a different json schema is not the verb we pin');
  assert.equal(hasVerb(c, 'zone ls'), true);
  assert.equal(hasVerb(c, 'zone ls', { jsonSchema: 1 }), false, 'listed but with NO versioned JSON');
  assert.equal(hasVerb(c, 'zone ls', { jsonSchema: null }), true);
  // absent verbs: a deferred one (not listed), and names that live on Object.prototype
  assert.equal(hasVerb(c, 'app inspect'), false);
  assert.equal(hasVerb(c, 'constructor'), false);
  assert.equal(hasVerb(c, 'toString'), false);
  // an UNKNOWN result answers nothing
  assert.equal(hasVerb(parseCapabilities('nope'), 'capabilities'), false);
});

test('MEASURED: chromium/debian DECLARES adapter cdp (kind tcp — xq\'s names, unrenamed)', () => {
  const c = parseCapabilities(MEASURED);
  const v = controlFor(c, 'chromium', { distro: 'debian' });
  assert.equal(v.state, 'declared', v.reason);
  assert.deepEqual(v.controls, [{ name: 'cdp', kind: 'tcp', adapter: 'cdp' }]);
  const f = controlFor(c, 'chromium', { distro: 'debian', adapter: 'cdp' });
  assert.equal(f.state, 'declared');
  assert.equal(f.controls[0].adapter, 'cdp');
  assert.equal(controlFor(c, 'opera', { adapter: 'cdp' }).state, 'declared');
});

test('MEASURED: firefox/ubuntu is built and declares NONE ([]), not unknown', () => {
  const c = parseCapabilities(MEASURED);
  const v = controlFor(c, 'firefox');
  assert.equal(v.state, 'none', v.reason);
  assert.deepEqual(v.controls, []);
  assert.equal(controlFor(c, 'firefox', { distro: 'ubuntu', adapter: 'bidi' }).state, 'none');
});

test('MEASURED: an unbuilt chromium image (control null) is UNKNOWN, never none', () => {
  const c = parseCapabilities(MEASURED);
  for (const distro of ['alpine', 'arch', 'ubuntu']) {
    const v = controlFor(c, 'chromium', { distro });
    assert.equal(v.state, 'unknown', `${distro}: ${v.reason}`);
    assert.match(v.reason, /not built/);
  }
});

test('MEASURED: chromium with NO distro — its images disagree ⇒ UNKNOWN, never a silent pick', () => {
  const v = controlFor(parseCapabilities(MEASURED), 'chromium');
  assert.equal(v.state, 'unknown');
  assert.match(v.reason, /disagree/);
  assert.match(v.reason, /debian: declared/);
  assert.match(v.reason, /pass \{ distro \}/);
});

test('MEASURED: adapter filter that matches nothing ⇒ none, naming the adapter', () => {
  const v = controlFor(parseCapabilities(MEASURED), 'chromium', { distro: 'debian', adapter: 'bidi' });
  assert.equal(v.state, 'none');
  assert.match(v.reason, /"bidi"/);
  assert.match(v.reason, /declares: cdp/);
});

// ── schema and shape: fail-closed ────────────────────────────────────────────

test('⛔ schema 2 is UNKNOWN (control: the same document at schema 1 is ok)', () => {
  const d = doc();
  assert.equal(parse(d).verdict, 'ok');
  d.schema = 2;
  const c = parse(d);
  assert.equal(c.verdict, 'unknown');
  assert.match(c.reason, /schema 2 is not 1/);
  for (const s of ['1', null, undefined, 1.0001]) {
    assert.equal(parse({ ...doc(), schema: s }).verdict, 'unknown', `schema ${JSON.stringify(s)}`);
  }
});

test('⛔ not JSON / not an object ⇒ UNKNOWN', () => {
  assert.equal(parseCapabilities('usage: xq [-h] ...\nxq: error: invalid choice').verdict, 'unknown');
  assert.equal(parseCapabilities('[]').verdict, 'unknown');
  assert.equal(parseCapabilities('null').verdict, 'unknown');
  assert.equal(parseCapabilities('').verdict, 'unknown');
});

test('⛔ each malformed field ⇒ UNKNOWN naming that field', () => {
  /** @type {[string, (d: any) => void, RegExp][]} */
  const cases = [
    ['docker missing', (d) => { delete d.docker; }, /"docker"/],
    ['docker string', (d) => { d.docker = 'true'; }, /"docker"/],
    ['verbs not array', (d) => { d.verbs = {}; }, /"verbs"/],
    ['apps not array', (d) => { d.apps = null; }, /"apps"/],
    ['verb not string', (d) => { d.verbs[0].verb = 7; }, /verbs\[0\]\.verb/],
    ['verb empty', (d) => { d.verbs[3].verb = ''; }, /verbs\[3\]\.verb/],
    ['verb entry null', (d) => { d.verbs[1] = null; }, /verbs\[1\]\.verb/],
    ['json_schema missing', (d) => { delete d.verbs[2].json_schema; }, /verbs\[2\]\.json_schema/],
    ['json_schema string', (d) => { d.verbs[6].json_schema = '1'; }, /verbs\[6\]\.json_schema/],
    ['json_schema float', (d) => { d.verbs[6].json_schema = 1.5; }, /verbs\[6\]\.json_schema/],
    ['verb listed twice', (d) => { d.verbs.push({ verb: 'up', json_schema: null }); }, /"up" is listed twice/],
    ['app not string', (d) => { d.apps[1].app = null; }, /apps\[1\]\.app/],
    ['app listed twice', (d) => { d.apps.push(d.apps[0]); }, /"chromium" is listed twice/],
    ['images not array', (d) => { d.apps[1].images = {}; }, /apps\[1\]\.images/],
    ['image null', (d) => { d.apps[0].images[2] = null; }, /apps\[0\]\.images\[2\]/],
    ['distro missing', (d) => { delete d.apps[0].images[1].distro; }, /apps\[0\]\.images\[1\]\.distro/],
    ['scope number', (d) => { d.apps[2].images[0].scope = 1; }, /apps\[2\]\.images\[0\]\.scope/],
    ['image missing', (d) => { delete d.apps[2].images[0].image; }, /apps\[2\]\.images\[0\]\.image/],
    ['built string', (d) => { d.apps[0].images[2].built = 'yes'; }, /apps\[0\]\.images\[2\]\.built/],
    ['built missing', (d) => { delete d.apps[0].images[2].built; }, /apps\[0\]\.images\[2\]\.built/],
    ['control object', (d) => { d.apps[0].images[2].control = {}; }, /apps\[0\]\.images\[2\]\.control/],
    ['control missing', (d) => { delete d.apps[1].images[0].control; }, /apps\[1\]\.images\[0\]\.control/],
    ['control entry null', (d) => { d.apps[0].images[2].control[0] = null; }, /control\[0\]\.name/],
    ['control adapter missing', (d) => { delete d.apps[0].images[2].control[0].adapter; }, /control\[0\]\.adapter/],
    ['control kind number', (d) => { d.apps[2].images[0].control[0].kind = 5; }, /apps\[2\]\.images\[0\]\.control\[0\]\.kind/],
  ];
  for (const [label, mutate, field] of cases) {
    const d = doc();
    mutate(d);
    const c = parse(d);
    assert.equal(c.verdict, 'unknown', `${label}: must be UNKNOWN`);
    assert.match(c.reason, field, `${label}: reason must name the field — got "${c.reason}"`);
  }
});

// ── controlFor: the three states on synthetic documents ──────────────────────

/** @param {any[]} images @param {boolean} [docker] */
const one = (images, docker = true) => parse({ schema: 1, docker, verbs: [], apps: [{ app: 'b', images }] });
/** @param {string} distro @param {any} control @param {boolean | null} [built] */
const img = (distro, control, built = true) => ({ distro, scope: 'shared', image: `x-${distro}`, built, control });
const CDP = { name: 'cdp', kind: 'tcp', adapter: 'cdp' };
const BIDI = { name: 'bidi', kind: 'tcp', adapter: 'bidi' };

test('controlFor UNKNOWN: control null / not built / built null / docker:false / absent app / absent distro / unread caps', () => {
  assert.equal(controlFor(one([img('d', null)]), 'b').state, 'unknown', 'control null');
  assert.equal(controlFor(one([img('d', [CDP], false)]), 'b').state, 'unknown', 'not built — even with control listed');
  assert.equal(controlFor(one([img('d', [], null)]), 'b').state, 'unknown', 'built null');
  const nod = controlFor(one([img('d', [CDP])], false), 'b');
  assert.equal(nod.state, 'unknown', 'docker false');
  assert.match(nod.reason, /docker/);
  assert.equal(controlFor(one([img('d', [CDP])]), 'zz').state, 'unknown', 'absent app');
  assert.equal(controlFor(one([img('d', [CDP])]), 'b', { distro: 'arch' }).state, 'unknown', 'absent distro');
  assert.equal(controlFor(one([]), 'b').state, 'unknown', 'no images');
  assert.equal(controlFor(parseCapabilities('x'), 'b').state, 'unknown', 'caps unread');
});

test('controlFor NONE vs DECLARED, adapter filter', () => {
  assert.equal(controlFor(one([img('d', [])]), 'b').state, 'none');
  const dec = controlFor(one([img('d', [CDP, BIDI])]), 'b');
  assert.equal(dec.state, 'declared');
  assert.equal(dec.controls.length, 2);
  const bidi = controlFor(one([img('d', [CDP, BIDI])]), 'b', { adapter: 'bidi' });
  assert.equal(bidi.state, 'declared');
  assert.deepEqual(bidi.controls, [BIDI]);
  const miss = controlFor(one([img('d', [CDP])]), 'b', { adapter: 'bidi' });
  assert.equal(miss.state, 'none');
  assert.match(miss.reason, /"bidi"/);
});

test('controlFor across several images: agreement is judged, disagreement is UNKNOWN', () => {
  const agree = controlFor(one([img('d', [CDP]), img('u', [CDP])]), 'b');
  assert.equal(agree.state, 'declared', agree.reason);
  assert.match(agree.reason, /agree/);
  assert.equal(controlFor(one([img('d', []), img('u', [])]), 'b').state, 'none');
  /** @type {[string, any[]][]} */
  const disagreeing = [
    ['declared vs none', [img('d', [CDP]), img('u', [])]],
    ['declared vs unbuilt', [img('d', [CDP]), img('u', null, false)]],
    ['different controls', [img('d', [CDP]), img('u', [BIDI])]],
  ];
  for (const [label, images] of disagreeing) {
    const v = controlFor(one(images), 'b');
    assert.equal(v.state, 'unknown', label);
    assert.match(v.reason, /disagree/, label);
  }
  // the adapter filter applies per image BEFORE agreement: both declare cdp ⇒ declared
  assert.equal(controlFor(one([img('d', [CDP]), img('u', [CDP, BIDI])]), 'b', { adapter: 'cdp' }).state, 'declared');
  // and a distro choice resolves the disagreement
  assert.equal(controlFor(one([img('d', [CDP]), img('u', [])]), 'b', { distro: 'd' }).state, 'declared');
  // all unknown stays unknown
  assert.equal(controlFor(one([img('d', null, false), img('u', null, false)]), 'b').state, 'unknown');
});

// ── readCapabilities against STUB xq binaries ────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-xq-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

/** @param {string} name @param {string} body @param {number} [mode] */
function stub(name, body, mode = 0o755) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, mode);
  return p;
}

test('readCapabilities: exit 0 with the measured JSON ⇒ ok — and argv is exactly `capabilities --json`', async () => {
  const xqBin = stub('xq-ok', [
    '[ "$#" = 2 ] && [ "$1" = capabilities ] && [ "$2" = --json ] || { echo "bad argv: $*" >&2; exit 3; }',
    `cat '${FIXTURE.replace(/'/g, "'\\''")}'`,
  ].join('\n'));
  const c = await readCapabilities({ xqBin });
  assert.equal(c.verdict, 'ok', c.reason);
  assert.equal(hasVerb(c, 'capabilities', { jsonSchema: 1 }), true);
});

test('readCapabilities: NODE_TEST_CONTEXT is not passed to the child', async () => {
  const prev = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const xqBin = stub('xq-env', '[ -z "${NODE_TEST_CONTEXT+x}" ] || { echo "leaked" >&2; exit 4; }\necho \'{"schema":1,"docker":false,"verbs":[],"apps":[]}\'');
    const c = await readCapabilities({ xqBin });
    assert.equal(c.verdict, 'ok', c.reason);
  } finally {
    if (prev === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prev;
  }
});

test('readCapabilities: exit 0 with an unknown schema ⇒ unknown, code contract', async () => {
  const c = await readCapabilities({ xqBin: stub('xq-s2', 'echo \'{"schema":2}\'') });
  assert.equal(c.verdict, 'unknown');
  assert.equal(/** @type {any} */ (c).code, 'contract');
  assert.match(c.reason, /schema 2/);
});

test('readCapabilities: exit 2 "invalid choice" (an xq older than the verb) ⇒ xq-too-old', async () => {
  const xqBin = stub('xq-old', [
    'echo "usage: xq [-h] {zone,machine,build,app,up,down} ..." >&2',
    'echo "xq: error: argument cmd: invalid choice: \'capabilities\' (choose from \'zone\', \'machine\')" >&2',
    'exit 2',
  ].join('\n'));
  const c = await readCapabilities({ xqBin });
  assert.equal(c.verdict, 'unknown');
  assert.equal(/** @type {any} */ (c).code, 'xq-too-old');
  assert.match(c.reason, /does not know the `capabilities` verb/);
  assert.match(c.reason, /invalid choice/, 'a stderr excerpt is included');
});

test('readCapabilities: any exit 2 ⇒ xq-too-old', async () => {
  const c = await readCapabilities({ xqBin: stub('xq-two', 'exit 2') });
  assert.equal(/** @type {any} */ (c).code, 'xq-too-old');
});

test('readCapabilities: missing binary ⇒ xq-absent with an install hint', async () => {
  const c = await readCapabilities({ xqBin: path.join(TMP, 'no-such-xq') });
  assert.equal(c.verdict, 'unknown');
  assert.equal(/** @type {any} */ (c).code, 'xq-absent');
  assert.match(c.reason, /install xq/);
  assert.match(c.reason, /PATH/);
});

test('readCapabilities: exit 1 ⇒ xq-failed with a stderr excerpt', async () => {
  const c = await readCapabilities({ xqBin: stub('xq-one', 'echo "Traceback: boom" >&2\nexit 1') });
  assert.equal(c.verdict, 'unknown');
  assert.equal(/** @type {any} */ (c).code, 'xq-failed');
  assert.match(c.reason, /exited 1/);
  assert.match(c.reason, /Traceback: boom/);
});

test('readCapabilities: a non-executable file ⇒ xq-failed, not absent', async () => {
  const c = await readCapabilities({ xqBin: stub('xq-noexec', 'exit 0', 0o644) });
  assert.equal(/** @type {any} */ (c).code, 'xq-failed');
});

test('readCapabilities: a hanging xq times out PROMPTLY ⇒ xq-failed — and its GRANDCHILD is actually killed', async () => {
  // A grandchild `sleep` keeps stdout open after sh is killed: the promise must not wait for
  // the pipe, AND the process-group kill must reach it. (Review: replacing the group kill
  // with a no-op left this test green and leaked a `sleep 30` — it only checked promptness.)
  const pidFile = path.join(TMP, 'grandchild.pid');
  const xqBin = stub('xq-hang', `sleep 30 &\necho $! > '${pidFile}'\nwait`);
  const t0 = Date.now();
  const c = await readCapabilities({ xqBin, timeoutMs: 300 });
  const took = Date.now() - t0;
  assert.equal(c.verdict, 'unknown');
  assert.equal(/** @type {any} */ (c).code, 'xq-failed');
  assert.match(c.reason, /timed out after 300 ms/);
  assert.ok(took < 5000, `must return promptly, took ${took} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(pid > 1, 'premise: the grandchild recorded its pid');
  // the group kill is asynchronous: give the kernel a moment, then the pid must be gone
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
  }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch {} } // never leak it, even on failure
  assert.equal(alive, false, `the grandchild ${pid} survived the timeout — the process-group kill did not reach it`);
});

test('unknown keys on app / image / control objects are tolerated (additive), known ones still checked', () => {
  const j = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  j.apps[0].future = { x: 1 };
  j.apps[0].images[0].future = true;
  const withControl = j.apps.flatMap((a) => a.images).find((im) => Array.isArray(im.control) && im.control.length);
  if (withControl) withControl.control[0].future = 'y';
  assert.equal(/** @type {any} */ (parseCapabilities(JSON.stringify(j))).verdict, 'ok');
  // control: a malformed KNOWN field (here the verb-level `schemas`) is still refused
  j.verbs[0].schemas = 'x';
  assert.equal(/** @type {any} */ (parseCapabilities(JSON.stringify(j))).verdict, 'unknown');
});

test('readCapabilities: spawn THROWING synchronously ⇒ xq-failed, never a throw', async () => {
  const orig = child_process.spawn;
  // @ts-ignore — monkey-patch the call-time seam
  child_process.spawn = () => { throw new TypeError('synthetic spawn failure'); };
  try {
    const c = await readCapabilities({ xqBin: 'xq' });
    assert.equal(/** @type {any} */ (c).code, 'xq-failed');
    assert.match(c.reason, /synthetic spawn failure/);
  } finally {
    child_process.spawn = orig;
  }
});

// ── xq evolves ADDITIVELY: a newer schema-1 document must still parse ─────────
test('⛔ an additive field in a newer xq (per-verb "schemas") is tolerated — schema 1 still parses', () => {
  // Measured from xq after X6/X7: verbs carry "schemas": [...] and firefox declares bidi.
  // A reader that refused unknown keys would turn every newer xq into UNKNOWN.
  const text = fs.readFileSync(new URL('./fixtures/xq-capabilities.schema1.additive.measured.json', import.meta.url), 'utf8');
  assert.ok(/"schemas"/.test(text), 'premise: the fixture really carries the additive field');
  const caps = /** @type {any} */ (parseCapabilities(text));
  assert.equal(caps.verdict, 'ok', caps.reason);
  assert.equal(hasVerb(caps, 'wait-ready', { jsonSchema: 1 }), true);
  assert.equal(hasVerb(caps, 'forward', { jsonSchema: 1 }), true);
  const ff = controlFor(caps, 'firefox', { distro: 'ubuntu' });
  assert.equal(ff.state, 'declared');
  assert.deepEqual(ff.controls.map((c) => c.adapter), ['bidi']);
});

// ── flags: never send a flag this xq does not list (an older xq passes it to the APP) ──
const fixture = (/** @type {string} */ n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('⛔ hasFlag: a flag the verb lists is OK — one it does not list is refused, naming it', () => {
  const caps = /** @type {any} */ (parseCapabilities(fixture('xq-capabilities.schema1.flags.measured.json')));
  assert.equal(caps.verdict, 'ok', caps.reason);
  assert.deepEqual(hasFlag(caps, 'up', ['--profile-dir', '--no-attach']), { ok: true });
  const r = /** @type {any} */ (hasFlag(caps, 'up', ['--profile-dir', '--teleport']));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['--teleport']);
  assert.match(r.reason, /never send it/);
  assert.equal(/** @type {any} */ (hasFlag(caps, 'no such verb', ['--x'])).ok, false);
});

test('⛔ hasFlag: an xq whose capabilities carry NO "flags" is TOO OLD to vouch — fail closed', () => {
  // the earlier measured fixture predates the field (a real older xq)
  const text = fixture('xq-capabilities.schema1.measured.json');
  assert.ok(!/"flags"/.test(text), 'premise: this fixture really has no flags field');
  const caps = /** @type {any} */ (parseCapabilities(text));
  assert.equal(caps.verdict, 'ok', 'an older xq still PARSES — it just cannot vouch for flags');
  const r = /** @type {any} */ (hasFlag(caps, 'up', ['--profile-dir']));
  assert.equal(r.ok, false);
  assert.match(r.reason, /too old to vouch/);
});

test('a malformed "flags" makes the whole document UNKNOWN (never half-trusted)', () => {
  const j = JSON.parse(fixture('xq-capabilities.schema1.flags.measured.json'));
  j.verbs[0].flags = 'oops';
  assert.equal(/** @type {any} */ (parseCapabilities(JSON.stringify(j))).verdict, 'unknown');
});

test('⛔ hasFlag: an xq whose grouped verbs ALL list one flag set OVER-CLAIMS — refused for that group', () => {
  // The flags fixture predates xq 70ff416: all six `zone` verbs listed the same ten flags, so
  // `zone ls --purge` parsed and was IGNORED. hasFlag must not approve it.
  const old = /** @type {any} */ (parseCapabilities(fixture('xq-capabilities.schema1.flags.measured.json')));
  assert.equal(old.verdict, 'ok');
  assert.ok(old.overclaimed.has('zone'), 'premise: the old fixture over-claims for zone');
  const r = /** @type {any} */ (hasFlag(old, 'zone ls', ['--purge']));
  assert.equal(r.ok, false);
  assert.match(r.reason, /over-reports flags for its 'zone' verbs/);
  // an UNGROUPED verb in the same old document is still judged on its own list
  assert.deepEqual(hasFlag(old, 'up', ['--profile-dir']), { ok: true });
});

test('CONTROL: a per-verb-correct xq (after 70ff416) is not flagged — two verbs sharing a set is fine', () => {
  const cur = /** @type {any} */ (parseCapabilities(fixture('xq-capabilities.schema1.perverb-flags.measured.json')));
  assert.equal(cur.verdict, 'ok', cur.reason);
  assert.equal(cur.overclaimed.size, 0, `nothing over-claimed: ${[...cur.overclaimed]}`);
  assert.equal(/** @type {any} */ (hasFlag(cur, 'zone ls', ['--purge'])).ok, false, 'zone ls genuinely lacks --purge now');
  assert.deepEqual(hasFlag(cur, 'up', ['--profile-dir']), { ok: true });
});
