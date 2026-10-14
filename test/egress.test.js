// egress.test.js — eg7p §2a (step 2): an egress is DECLARED, resolved by rank, and refused by name; never assumed.
//
// Every arm runs against a throwaway HOME (never the real one) and made-up records: the endpoints below are RFC 5737 /
// RFC 2606 documentation values. ⛔ Each refusal and the `where` fields are searched for the planted endpoint string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as egress from '../lib/egress.js';
import { validateTarget } from '../lib/remotes.js';
import * as index from '../lib/index.js';

const ENDPOINT = '192.0.2.44';
const { resolveEgress, loadSharedEgress, validateEgressRecord, egressWhere } = egress;

/** A throwaway HOME with egress records: name → [text, mode]. @param {Record<string, [string, number]>} recs */
function home(recs) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-egress-'));
  const dir = path.join(h, '.config', 'webctl', 'egress');
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, [text, mode]] of Object.entries(recs)) { fs.writeFileSync(path.join(dir, `${n}.toml`), text, { mode }); fs.chmodSync(path.join(dir, `${n}.toml`), mode); }
  return { h, done: () => fs.rmSync(h, { recursive: true, force: true }) };
}
const noEndpoint = (/** @type {unknown} */ x) => assert.ok(!JSON.stringify(x).includes(ENDPOINT), `an endpoint was echoed: ${JSON.stringify(x)}`);

test('⛔ nothing declared → REFUSED (no-egress), never assumed direct — CONTROL: egress = "direct" stated resolves to kind direct', () => {
  const r = resolveEgress({ tool: 'demo-webctl', envKey: 'DEMO_EGRESS', records: {} });
  assert.equal(r.verdict, 'refused');
  assert.equal(/** @type {any} */ (r).code, 'no-egress');
  assert.match(/** @type {any} */ (r).reason, /never assumes direct/);
  assert.match(/** @type {any} */ (r).instructions, /--egress <name>.*DEMO_EGRESS.*egress = "direct"/);
  const d = resolveEgress({ env: 'direct', records: {} });
  assert.deepEqual([d.verdict, /** @type {any} */ (d).kind, /** @type {any} */ (d).source], ['resolved', 'direct', 'env']);
});

test('resolution: --egress > env > the lane config > the target record — each source honoured and reported, the rest shadowed', () => {
  const records = { a: { kind: 'socks5', host: 'h', port: 1 }, b: { kind: 'tor' }, c: { kind: 'ssh-dynamic', ssh: 's', known_hosts_file: '/k' },
    d: { kind: 'http-proxy', host: 'h', port: 1 } };
  const all = { flag: 'a', env: 'b', laneConfig: 'c', targetRecord: { egress: 'd' }, records };
  const r = /** @type {any} */ (resolveEgress(all));
  assert.deepEqual([r.name, r.source, r.shadowed], ['a', 'flag', ['env', 'config', 'shared']]);
  assert.deepEqual([/** @type {any} */ (resolveEgress({ ...all, flag: null })).name], ['b']);
  assert.deepEqual([/** @type {any} */ (resolveEgress({ ...all, flag: null, env: null })).name], ['c']);
  const t = /** @type {any} */ (resolveEgress({ targetRecord: { egress: 'd' }, records }));
  assert.deepEqual([t.name, t.kind, t.source], ['d', 'http-proxy', 'shared']);
  // two in one layer: ambiguous, never a silent pick
  assert.equal(/** @type {any} */ (resolveEgress({ flag: ['a', 'b'], records })).code, 'ambiguous');
});

test('⛔ every refusal is NAMED, and none echoes a record value or a non-name: invalid, unknown, unknown kind', () => {
  const h = home({ prox: [`kind = "socks5"\nhost = "${ENDPOINT}"\nport = 1080\n`, 0o600] });
  try {
    const bad = resolveEgress({ flag: `socks5://${ENDPOINT}:1080`, home: h.h });
    assert.equal(/** @type {any} */ (bad).code, 'invalid-egress');
    noEndpoint(bad);
    const unknown = resolveEgress({ flag: 'nosuch', home: h.h });
    assert.equal(/** @type {any} */ (unknown).code, 'unknown-egress');
    noEndpoint(unknown);
    // CONTROL: the record that exists resolves — its parameters passed through to the caller (xq's), unrenamed
    const ok = /** @type {any} */ (resolveEgress({ flag: 'prox', home: h.h }));
    assert.equal(ok.verdict, 'resolved');
    assert.equal(ok.record.host, ENDPOINT);
    noEndpoint(egressWhere(ok));
    assert.deepEqual(egressWhere(ok), { egress: 'prox', egress_kind: 'socks5', egress_source: 'flag' });
  } finally { h.done(); }
});

test('⛔ privileged kinds (wireguard, vpn) are REFUSED unless xq\'s reading says enabled; an unimplemented kind is refused — never degraded', () => {
  const records = { wg: { kind: 'wireguard', config_file: '/etc/x/wg.conf' }, t: { kind: 'tor' } };
  const no = /** @type {any} */ (resolveEgress({ flag: 'wg', records }));
  assert.equal(no.code, 'privileged-kind');
  assert.match(no.reason, /the human's security decision .* no xq egress_kinds reading says it is enabled/);
  const off = /** @type {any} */ (resolveEgress({ flag: 'wg', records, kinds: [{ kind: 'wireguard', privileged: true, enabled: false }, { kind: 'tor' }] }));
  assert.match(off.reason, /xq reports it disabled/);
  // CONTROL: enabled by the human (xq's reading) → resolved
  assert.equal(resolveEgress({ flag: 'wg', records, kinds: [{ kind: 'wireguard', privileged: true, enabled: true }] }).verdict, 'resolved');
  // xq's reading lacks the kind → kind-unavailable; without a reading an unprivileged kind is not blocked
  assert.equal(/** @type {any} */ (resolveEgress({ flag: 't', records, kinds: [{ kind: 'socks5' }] })).code, 'kind-unavailable');
  assert.equal(resolveEgress({ flag: 't', records }).verdict, 'resolved');
});

test('⛔ a record: kind required and from the CLOSED list; an INLINE secret refused (a *_file path accepted); "direct" reserved', () => {
  const errs = (/** @type {any} */ r, /** @type {any} */ o) => validateEgressRecord(r, o).errors.map((e) => e.field);
  assert.deepEqual(errs({}), ['kind']);
  assert.deepEqual(errs({ kind: 'shadowsocks' }), ['kind']);
  assert.deepEqual(errs({ kind: 'direct' }), ['kind']);
  for (const k of ['password', 'proxy_password', 'wg-private-key', 'psk', 'token', 'api_key', 'credentials', 'passphrase']) {
    assert.deepEqual(errs({ kind: 'socks5', host: 'h', port: 1, [k]: 'x' }), [k], k);
    assert.ok(!JSON.stringify(validateEgressRecord({ kind: 'socks5', [k]: 'sekrit-x' })).includes('sekrit-x'), `${k}: the secret was echoed`);
  }
  assert.deepEqual(errs({ kind: 'socks5', host: 'h', port: 1, password_file: 'relative/p' }), ['password_file']);
  // CONTROL: a secret BY PATH, with xq's keys
  assert.deepEqual(errs({ kind: 'socks5', host: 'h', port: 1080, username: 'u', password_file: '~/.config/webctl/egress/p.secret' }), []);
  assert.deepEqual(errs({ kind: 'tor' }, { name: 'direct' }), ['name']);
});

test('the loader: mode wider than 600 refused, an invalid record refused — named by file, never by value; a valid one loaded', () => {
  const h = home({ open: [`kind = "socks5"\nhost = "${ENDPOINT}"\n`, 0o644], inline: [`kind = "socks5"\npassword = "${ENDPOINT}"\n`, 0o600],
    good: ['kind = "tor"\n', 0o600], direct: ['kind = "tor"\n', 0o600] });
  try {
    const l = loadSharedEgress({ home: h.h });
    assert.deepEqual(Object.keys(l.records), ['good']);
    assert.equal(l.errors.length, 3, l.errors.join('\n'));
    assert.ok(l.errors.some((e) => /egress\/open\.toml: mode 644/.test(e)));
    assert.ok(l.errors.some((e) => /egress\/inline\.toml: password: refused: an inline secret/.test(e)));
    assert.ok(l.errors.some((e) => /egress\/direct\.toml: name: "direct" is reserved/.test(e)));
    noEndpoint(l.errors);
    assert.ok(!l.errors.some((e) => e.includes(h.h)), 'an absolute path (the home) reached a message');
  } finally { h.done(); }
});

test('target records accept a ruled `egress` key (a name only) — the closed schema still refuses junk', () => {
  assert.equal(validateTarget({ control: 'local', egress: 'prox' }).verdict, 'valid');
  assert.equal(validateTarget({ control: 'local', egress: 'direct' }).verdict, 'valid');
  assert.deepEqual(validateTarget({ control: 'local', egress: `socks5://${ENDPOINT}` }).errors.map((e) => e.field), ['egress']);
  assert.ok(!JSON.stringify(validateTarget({ control: 'local', egress: `socks5://${ENDPOINT}` })).includes(ENDPOINT));
});

test('the surface: lib/index.js exports egress — construct-and-inspect, not grep', () => {
  assert.equal(typeof index.egress.resolveEgress, 'function');
  assert.deepEqual([...index.egress.EGRESS_KINDS], ['direct', 'ssh-dynamic', 'socks5', 'http-proxy', 'wireguard', 'vpn', 'tor']);
});

test('⛔ each kind\'s keys are CLOSED, as xq\'s loader is (spec 08): required ones missing, unknown ones, and wrong types are refused by name', () => {
  const errs = (/** @type {any} */ r) => validateEgressRecord(r).errors.map((e) => e.field).sort();
  // CONTROLS: a minimal valid record of every kind
  for (const r of [{ kind: 'socks5', host: 'h', port: 1080 }, { kind: 'http-proxy', host: 'h', port: 3128, tls: true },
    { kind: 'ssh-dynamic', ssh: 'ssh://u@h:22', known_hosts_file: '~/.ssh/known_hosts' }, { kind: 'tor' },
    { kind: 'tor', torrc_file: '/x/torrc', check_url: 'https://check.example/ip' }, { kind: 'wireguard', config_file: '/x/wg.conf' },
    { kind: 'vpn', config_file: '/x/v.ovpn', auth_file: '/x/a' }]) assert.deepEqual(errs(r), [], JSON.stringify(r));
  assert.deepEqual(errs({ kind: 'socks5' }), ['host', 'port']);
  // ⛔ ssh-dynamic without known_hosts_file: no trust on first use (xq REQUIRES it)
  assert.deepEqual(errs({ kind: 'ssh-dynamic', ssh: 'h' }), ['known_hosts_file']);
  assert.deepEqual(errs({ kind: 'tor', host: 'h' }), ['host']);
  assert.deepEqual(errs({ kind: 'socks5', host: 'h', port: '1080' }), ['port']);
  assert.deepEqual(errs({ kind: 'http-proxy', host: 'h', port: 1, tls: 'yes' }), ['tls']);
  assert.deepEqual(errs({ kind: 'ssh-dynamic', ssh: '-oProxyCommand=x', known_hosts_file: '/k' }), ['ssh']);
  assert.deepEqual(errs({ kind: 'tor', check_url: 'ftp://x' }), ['check_url']);
  assert.ok(!JSON.stringify(validateEgressRecord({ kind: 'ssh-dynamic', ssh: `-o${ENDPOINT}`, known_hosts_file: '/k' })).includes(ENDPOINT));
});
