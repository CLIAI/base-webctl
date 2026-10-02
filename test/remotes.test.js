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
