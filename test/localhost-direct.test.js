// Unit tests for lib/browser-location/localhost-direct.js — driver contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ld from '../lib/browser-location/localhost-direct.js';

const baseCfg = () => ({
  port: 4327, host: '127.0.0.1',
  healthCheck: async () => true,
  ensureRunning: async () => true,
});

test('createDriver: returns the documented contract shape', () => {
  const d = ld.createDriver(baseCfg());
  assert.equal(d.mode, ld.MODE);
  assert.equal(d.mode, 'localhost-direct');
  for (const fn of ['ensureRunning', 'healthCheck', 'shutdown', 'describe']) {
    assert.equal(typeof d[fn], 'function', `missing ${fn}`);
  }
});

test('createDriver: ensureRunning returns endpoints + ok', async () => {
  const d = ld.createDriver(baseCfg());
  const r = await d.ensureRunning();
  assert.equal(r.cdpHttpUrl, 'http://127.0.0.1:4327');
  assert.equal(r.cdpWsBase, 'ws://127.0.0.1:4327');
  assert.equal(r.ok, true);
});

test('createDriver: healthCheck swallows throw -> false', async () => {
  const cfg = baseCfg();
  cfg.healthCheck = async () => { throw new Error('boom'); };
  const d = ld.createDriver(cfg);
  assert.equal(await d.healthCheck(), false);
});

test('createDriver: validates required fields', () => {
  assert.throws(() => ld.createDriver(/** @type {any} */ (null)), /missing config/);
  assert.throws(() => ld.createDriver(/** @type {any} */ ({ host: 'h', healthCheck() {}, ensureRunning() {} })), /missing port/);
  assert.throws(() => ld.createDriver(/** @type {any} */ ({ port: 1, healthCheck() {}, ensureRunning() {} })), /missing host/);
  assert.throws(() => ld.createDriver(/** @type {any} */ ({ port: 1, host: 'h', ensureRunning() {} })), /healthCheck callback/);
  assert.throws(() => ld.createDriver(/** @type {any} */ ({ port: 1, host: 'h', healthCheck() {} })), /ensureRunning callback/);
});

test('createDriver: describe includes the CDP url', () => {
  const d = ld.createDriver(baseCfg());
  assert.ok(d.describe().includes('http://127.0.0.1:4327'));
});
