// Unit tests for createAccessStore(opts) — the gateway P2 grant/request store
// (design: infra-xpra-remote-access-gateway-f6rd §4.2/§4.3). Persistent JSON,
// atomic temp+rename, TTL parse, lazy expiry, enabled flag. Hermetic: a temp
// state file + an injected clock so expiry is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccessStore, parseTtl } from '../lib/browser-location/xpra-access-store.js';

function tmpStatePath() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xpra-access-'));
  return path.join(d, 'xpra-access.json');
}

function mkStore(extra = {}) {
  let now = 1_000_000_000_000; // fixed epoch ms
  const clock = () => now;
  const statePath = tmpStatePath();
  const store = createAccessStore({ statePath, defaultTtlSec: 3 * 3600, clock, ...extra });
  return { store, statePath, advance: (sec) => { now += sec * 1000; }, nowRef: () => now };
}

// ── TTL parser (pure) ───────────────────────────────────────────────────────

test('parseTtl: named + numeric forms', () => {
  assert.equal(parseTtl('15min'), 900);
  assert.equal(parseTtl('1h'), 3600);
  assert.equal(parseTtl('3h'), 10800);
  assert.equal(parseTtl('12h'), 43200);
  assert.equal(parseTtl('90min'), 5400);
  assert.equal(parseTtl('2d'), 172800);
  assert.equal(parseTtl('45'), 45 * 60, 'bare number = minutes');
  assert.equal(parseTtl('forever'), Infinity);
  assert.throws(() => parseTtl('nonsense'), /invalid ttl/i);
  assert.throws(() => parseTtl(''), /invalid ttl/i);
});

// ── enabled flag (persisted) ────────────────────────────────────────────────

test('enabled: defaults true; toggles persist across reloads', () => {
  const { store, statePath } = mkStore();
  assert.equal(store.isEnabled(), true);
  store.setEnabled(false);
  assert.equal(store.isEnabled(), false);
  // a fresh store over the same file sees the persisted flag
  const store2 = createAccessStore({ statePath, defaultTtlSec: 3 * 3600 });
  assert.equal(store2.isEnabled(), false);
});

// ── request queue ───────────────────────────────────────────────────────────

test('addRequest / listRequests: queues pending by principal', () => {
  const { store } = mkStore();
  store.addRequest('100.64.0.5', { who: 'alice', note: 'pls' });
  const reqs = store.listRequests();
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].principal, '100.64.0.5');
  assert.equal(reqs[0].who, 'alice');
  assert.ok(reqs[0].requestedAt);
});

// ── approve / grants / lazy expiry ──────────────────────────────────────────

test('approve: creates a grant, clears the request, expiry honored lazily', () => {
  const { store, advance } = mkStore();
  store.addRequest('100.64.0.5', { who: 'alice' });
  const grant = store.approve('100.64.0.5', { ttl: '3h', grantedBy: '127.0.0.1' });
  assert.equal(grant.grantedBy, '127.0.0.1');
  assert.ok(grant.expiresAt > 0);
  assert.equal(store.listRequests().length, 0, 'request cleared on approve');
  assert.equal(store.isGranted('100.64.0.5'), true);

  const g = store.listGrants().find(x => x.principal === '100.64.0.5');
  assert.ok(g.remainingSeconds > 0 && g.remainingSeconds <= 10800);

  advance(3 * 3600 - 1);
  assert.equal(store.isGranted('100.64.0.5'), true, 'still valid 1s before expiry');
  advance(2);
  assert.equal(store.isGranted('100.64.0.5'), false, 'expired -> lazily pruned');
  assert.equal(store.listGrants().length, 0, 'expired grant pruned from listing');
});

test('approve: default TTL (3h) when ttl omitted', () => {
  const { store } = mkStore();
  const grant = store.approve('100.64.0.9', { grantedBy: '127.0.0.1' });
  assert.equal(grant.ttl, '3h');
  const g = store.listGrants().find(x => x.principal === '100.64.0.9');
  assert.ok(g.remainingSeconds > 10700 && g.remainingSeconds <= 10800);
});

test('forever grant never expires', () => {
  const { store, advance } = mkStore();
  store.approve('100.64.0.7', { ttl: 'forever', grantedBy: '127.0.0.1' });
  advance(365 * 24 * 3600);
  assert.equal(store.isGranted('100.64.0.7'), true);
});

// ── reject / revoke ─────────────────────────────────────────────────────────

test('reject: removes a pending request without granting', () => {
  const { store } = mkStore();
  store.addRequest('100.64.0.5', { who: 'mallory' });
  store.reject('100.64.0.5');
  assert.equal(store.listRequests().length, 0);
  assert.equal(store.isGranted('100.64.0.5'), false);
});

test('revoke: ends an active grant', () => {
  const { store } = mkStore();
  store.approve('100.64.0.5', { ttl: '3h', grantedBy: '127.0.0.1' });
  assert.equal(store.isGranted('100.64.0.5'), true);
  store.revoke('100.64.0.5');
  assert.equal(store.isGranted('100.64.0.5'), false);
});

// ── persistence + atomicity ─────────────────────────────────────────────────

test('persistence: grants survive a reload; writes are atomic (no temp left)', () => {
  const { store, statePath } = mkStore();
  store.approve('100.64.0.5', { ttl: 'forever', grantedBy: '127.0.0.1' });
  const store2 = createAccessStore({ statePath, defaultTtlSec: 3 * 3600 });
  assert.equal(store2.isGranted('100.64.0.5'), true, 'grant persisted to disk');
  // no leftover temp files in the state dir
  const dir = path.dirname(statePath);
  const leftover = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
  assert.deepEqual(leftover, [], 'atomic write leaves no .tmp file');
});

test('corrupt/missing state file -> fresh default (never throws)', () => {
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, '{ not valid json');
  const store = createAccessStore({ statePath, defaultTtlSec: 3 * 3600 });
  assert.equal(store.isEnabled(), true);
  assert.equal(store.listGrants().length, 0);
});
