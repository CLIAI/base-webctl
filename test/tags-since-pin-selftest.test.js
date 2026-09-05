// tags-since-pin-selftest.test.js — run the probe's own control in CI.
//
// The probe ships a --self-test that asserts it returns BOTH of its answers
// over immutable historical refs. A control nobody runs rots exactly like the
// dead predicates that made the probe necessary, so base's suite runs it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('⭐ tags-since-pin --self-test returns both answers', () => {
  let out;
  try {
    out = execFileSync('bash', [join(ROOT, 'scripts/tags-since-pin.sh'), '--self-test'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (/** @type {any} */ e) {
    assert.fail(`probe self-test failed:\n${e.stdout || ''}${e.stderr || ''}`);
  }
  assert.match(out, /SELF-TEST PASSED 2\/2/);
  assert.match(out, /OK \(answer: NEWS\)/, 'control A must reach the news answer');
  // The negative arm must ALSO prove it saw the range — "no news" over an empty
  // range is a pass that measured nothing.
  assert.match(out, /OK \(answer: NO NEWS, and it verifiably compared the range\)/,
    'control B must reach the no-news answer AND assert its own subject');
});
