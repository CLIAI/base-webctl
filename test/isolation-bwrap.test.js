// isolation-bwrap.test.js — the bwrap backend's own depth (ib4k §2a, v0.35.0 phase 2).
//
// The CONTRACT is the shared arm table (isolation-arm-table.test.js), run under unshare AND bwrap (plus
// its bwrap-only `--new-session` arm). bwrap's probe and named refusals are in
// isolation-backend-select.test.js; the signal path through it (`--as-pid-1`, `--die-with-parent`) is the
// `[bwrap]` block of contract-harness-isolation.test.js. Here: the mount-propagation hole bwrap opened,
// closed for every backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'contract-harness.mjs');
const harness = await import(pathToFileURL(TOOL).href);

// ── mount propagation (§2a, difference 1) ──────────────────────────────────
// ⛔ bwrap makes `/` an rslave: a mount the host makes AFTER the start appeared inside, writable
// (measured: listed twice; under `unshare --propagation=private` 0 times). ⇒ The inner half makes every
// mount private and READS IT BACK: no mount may carry a `shared:` or `master:` tag.

const MI = [
  '25 1 0:23 / / ro,relatime - ext4 /dev/root rw',
  '26 25 0:24 / /tmp rw,nosuid,nodev - tmpfs webctl-isolated rw',
  '27 25 0:25 / /proc rw,nosuid - proc proc rw',
];

test('⛔ propagationGaps: a mount that is a SLAVE (master:) or SHARED (shared:) is a gap — CONTROL: all private → none', () => {
  assert.equal(typeof harness.propagationGaps, 'function', 'propagationGaps is not exported');
  const priv = harness.parseMountinfo(MI.join('\n'));
  assert.deepEqual(priv.map((/** @type {any} */ m) => m.propagation), [[], [], []], 'parseMountinfo does not read the optional fields');
  assert.deepEqual(harness.propagationGaps(priv), [], 'control: an all-private table has a gap');
  const slave = harness.parseMountinfo([MI[0].replace('ro,relatime -', 'ro,relatime master:1 -'), MI[1],
    MI[2].replace('rw,nosuid -', 'rw,nosuid shared:7 master:5 propagate_from:5 -')].join('\n'));
  assert.deepEqual(slave[2].propagation, ['shared:7', 'master:5', 'propagate_from:5']);
  assert.deepEqual(harness.propagationGaps(slave).map((/** @type {any} */ m) => m.at), ['/', '/proc']);
  // `unbindable` is not propagation INTO the namespace
  assert.deepEqual(harness.propagationGaps(harness.parseMountinfo(MI[1].replace('nodev -', 'nodev unbindable -'))), []);
});
