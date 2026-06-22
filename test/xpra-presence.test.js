// Unit tests for lib/xpra-presence.js — the PURE parser (no xpra CLI calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as xp from '../lib/xpra-presence.js';

test('parseXpraClients: reads clients=<N> at line start', () => {
  assert.equal(xp.parseXpraClients('clients=1\nfoo=bar'), 1);
  assert.equal(xp.parseXpraClients('foo=bar\nclients=3\n'), 3);
  assert.equal(xp.parseXpraClients('clients=0'), 0);
});

test('parseXpraClients: 0 on absent/empty/garbage', () => {
  assert.equal(xp.parseXpraClients(''), 0);
  // @ts-expect-error — exercising the nullish guard
  assert.equal(xp.parseXpraClients(null), 0);
  assert.equal(xp.parseXpraClients('no clients here'), 0);
  // must anchor to line start — "xclients=2" must not match
  assert.equal(xp.parseXpraClients('xclients=2'), 0);
});

test('isXpraClientAttached: false when port is falsy (no CLI call)', () => {
  assert.equal(xp.isXpraClientAttached(0), false);
});
