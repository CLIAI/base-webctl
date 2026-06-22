// Unit tests for lib/lru-cleanup.js — pure decision logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lru from '../lib/lru-cleanup.js';

test('parseDuration: units + rejects', () => {
  assert.equal(lru.parseDuration('30s'), 30);
  assert.equal(lru.parseDuration('10m'), 600);
  assert.equal(lru.parseDuration('1h'), 3600);
  assert.equal(lru.parseDuration('2d'), 172800);
  assert.equal(lru.parseDuration('1.5h'), 5400);
  assert.equal(lru.parseDuration('10 m'), 600); // whitespace allowed
  assert.equal(lru.parseDuration(''), null);
  assert.equal(lru.parseDuration('10x'), null);
  assert.equal(lru.parseDuration(null), null);
  assert.equal(lru.parseDuration(/** @type {any} */ (5)), null);
});

test('parseLruThresholds: parses, sorts, skips malformed', () => {
  const warns = [];
  const r = lru.parseLruThresholds('1h:5,10m:15,bad,30m:10', { onWarn: m => warns.push(m) });
  assert.deepEqual(r?.map(t => t.label), ['10m', '30m', '1h']); // sorted ascending
  assert.equal(r?.[0].maxTabs, 15);
  assert.equal(warns.length, 1); // "bad" warned
  assert.equal(lru.parseLruThresholds(''), null);
  assert.equal(lru.parseLruThresholds('nope'), null);
});

test('annotateTabs: precedence tracked > firstSeen > sentinel(now)', () => {
  const now = '2026-06-22T12:00:00.000Z';
  const tabs = [{ id: 'a', url: 'u-a' }, { id: 'b', url: 'u-b' }, { id: 'c', url: 'u-c' }];
  const activity = { 'post:a': { lastUsed: '2026-06-20T00:00:00.000Z' } };
  const extractKey = (/** @type {string|undefined} */ u) => u === 'u-a' ? 'post:a' : null;
  const firstSeen = { b: '2026-06-21T00:00:00.000Z' };
  const out = lru.annotateTabs({ linkedInTabs: tabs, activity, now, extractKey, firstSeen });
  assert.equal(out[0].lastUsed, '2026-06-20T00:00:00.000Z'); // tracked
  assert.equal(out[1].lastUsed, '2026-06-21T00:00:00.000Z'); // firstSeen
  assert.equal(out[2].lastUsed, now);                         // sentinel fresh
  assert.equal(out[0].activityKey, 'post:a');
});

test('decideClosures: count-based protects current + protected', () => {
  const mk = (/** @type {string} */ id, /** @type {string} */ lu) => ({ id, lastUsed: lu, activityKey: null });
  const tabs = [mk('old1', '2026-06-01T00:00:00Z'), mk('old2', '2026-06-02T00:00:00Z'),
                mk('new', '2026-06-20T00:00:00Z'), mk('cur', '2026-06-21T00:00:00Z')];
  const r = lru.decideClosures({ annotatedTabs: tabs, maxTabs: 2, thresholds: null,
    currentTabId: 'cur', protectedTabIds: ['old2'], now: '2026-06-22T00:00:00Z' });
  // need = 4 - 2 = 2: close the 2 oldest UNPROTECTED (old1, new); skip old2+cur.
  assert.deepEqual(r.toClose, ['old1', 'new']);
  assert.ok(r.reasons.get('old1')?.includes('count-based'));
});

test('decideClosures: no-op when no cap and no thresholds', () => {
  const r = lru.decideClosures({ annotatedTabs: [{ id: 'a', lastUsed: 'x' }], maxTabs: 0,
    thresholds: null, now: 0 });
  assert.deepEqual(r.toClose, []);
});

test('decideBlankCollapse: fires only when ALL idle past horizon, none protected', () => {
  const now = Date.UTC(2026, 5, 22, 12, 0, 0);
  const old = new Date(now - 3600_000).toISOString(); // 1h ago
  const fresh = new Date(now - 10_000).toISOString();  // 10s ago
  const tabsOld = [{ id: 'a', lastUsed: old }, { id: 'b', lastUsed: old }];
  assert.equal(lru.decideBlankCollapse(tabsOld, { blankAfterSeconds: 60, now }).collapse, true);
  // one fresh tab blocks collapse
  assert.equal(lru.decideBlankCollapse([...tabsOld, { id: 'c', lastUsed: fresh }],
    { blankAfterSeconds: 60, now }).collapse, false);
  // protected tab blocks collapse
  assert.equal(lru.decideBlankCollapse(tabsOld,
    { blankAfterSeconds: 60, now, protectedTabIds: ['a'] }).collapse, false);
  // disabled
  assert.equal(lru.decideBlankCollapse(tabsOld, { blankAfterSeconds: 0, now }).collapse, false);
});

test('reconcileFirstSeen: stamp new untimed, grace-prune absent', () => {
  const now = '2026-06-22T12:00:00.000Z';
  // 'x' newly untimed -> stamped; 'y' gained activity -> dropped; 'z' absent -> miss++
  let r = lru.reconcileFirstSeen({
    firstSeen: { y: '2026-06-20T00:00:00Z', z: '2026-06-19T00:00:00Z' },
    missed: {}, untimedTabIds: ['x'], liveTabIds: ['x', 'y'], now, graceMisses: 2 });
  assert.equal(r.firstSeen.x, now);
  assert.equal(r.firstSeen.y, undefined);   // gained activity -> dropped
  assert.equal(r.missed.z, 1);              // absent once
  assert.ok(r.firstSeen.z);                 // not yet pruned (grace=2)
  // second consecutive miss -> pruned
  r = lru.reconcileFirstSeen({ firstSeen: r.firstSeen, missed: r.missed,
    untimedTabIds: ['x'], liveTabIds: ['x'], now, graceMisses: 2 });
  assert.equal(r.firstSeen.z, undefined);
});
