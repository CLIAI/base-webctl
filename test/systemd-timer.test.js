// Unit tests for lib/systemd-timer.js — the PURE builders + path helpers.
// (install/uninstall/status shell out to systemctl and are covered by live
// verification in the consuming tools, not here.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as st from '../lib/systemd-timer.js';

test('unitPaths: exact slug-scoped service + timer paths (multi-tenant safety)', () => {
  const p = st.unitPaths('proj-lru', { home: '/home/u' });
  assert.equal(p.dir, '/home/u/.config/systemd/user');
  assert.equal(p.service, '/home/u/.config/systemd/user/proj-lru.service');
  assert.equal(p.timer, '/home/u/.config/systemd/user/proj-lru.timer');
});

test('userUnitDir: honours injected home', () => {
  assert.equal(st.userUnitDir({ home: '/h' }), '/h/.config/systemd/user');
});

test('buildServiceUnit: oneshot with ExecStart; optional WD/env', () => {
  const u = st.buildServiceUnit({ description: 'D', execStart: '/n /r cmd' });
  assert.ok(u.includes('Description=D'));
  assert.ok(u.includes('Type=oneshot'));
  assert.ok(u.includes('ExecStart=/n /r cmd'));
  const u2 = st.buildServiceUnit({ description: 'D', execStart: 'x',
    workingDirectory: '/w', environment: ['A=1', 'B=2'] });
  assert.ok(u2.includes('WorkingDirectory=/w'));
  assert.ok(u2.includes('Environment=A=1'));
  assert.ok(u2.includes('Environment=B=2'));
});

test('buildTimerUnit: cadence + persistent + Install', () => {
  const u = st.buildTimerUnit({ description: 'D', onActiveSec: '30min' });
  assert.ok(u.includes('OnUnitActiveSec=30min'));
  assert.ok(u.includes('OnBootSec=5min'));  // default
  assert.ok(u.includes('Persistent=true'));
  assert.ok(u.includes('WantedBy=timers.target'));
  const u2 = st.buildTimerUnit({ description: 'D', onActiveSec: '1h', onBootSec: '2min', persistent: false });
  assert.ok(u2.includes('OnBootSec=2min'));
  assert.ok(!u2.includes('Persistent=true'));
});
