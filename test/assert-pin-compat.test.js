// assert-pin-compat.test.js — the caveat-as-an-assertion (scripts/assert-pin-compat.mjs).
//
// A changelog reaches the reader DECIDING to bump; it cannot reach the reader
// who ALREADY bumped, because their checkout predates the entry warning them.
// This script is the second reader's mechanism, so it has to work against a
// PINNED OLD base — which is what these tests fixture, rather than depending on
// git history being present.
//
// The script probes CAPABILITY, not version: it asks the pinned base to derive
// ports for the consumer's real port and checks whether the answer is possible.
// So the fixtures here are two fake "bases" — one that returns an impossible
// port (an old pin) and one that refuses (a fixed pin).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'assert-pin-compat.mjs');

/**
 * Write a fake pinned base whose deriveXpraPorts behaves like `kind`.
 * @param {'old'|'fixed'} kind
 */
function fakeBase(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pin-compat-'));
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const body =
    kind === 'old'
      ? // Returns the impossible port, silently, with full confidence — the
        // exact shape of the defect.
        `const tcp = n < 55535 ? n + 10000 : n + 100;
      return { xpraTcpPort: tcp, xpraHtml5Port: tcp + 1, sources: { tcp: 'derived', html5: 'derived' } };`
      : // Refuses, as a fixed base does.
        `const tcp = n < 55535 ? n + 10000 : n + 100;
      if (tcp > 65535) throw new Error('cannot derive: ' + tcp + ' exceeds the maximum port 65535');
      return { xpraTcpPort: tcp, xpraHtml5Port: tcp, sources: { tcp: 'derived', html5: 'derived' } };`;

  writeFileSync(
    path.join(dir, 'lib', 'client-config.js'),
    `export function createClientConfig(C, opts) {
  return {
    deriveXpraPorts(cdpPort) {
      const n = Number(cdpPort);
      ${body}
    },
  };
}
`,
  );
  return dir;
}

/** @returns {{code:number, out:string}} */
function run(baseDir, cdpPort) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--base-dir', baseDir, '--cdp-port', String(cdpPort)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? -1, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('an OLD pin + an affected port is REFUSED, naming the impossible value', () => {
  const base = fakeBase('old');
  try {
    const r = run(base, 65500);
    assert.equal(r.code, 1, 'must refuse, not pass');
    assert.match(r.out, /REFUSED/);
    assert.match(r.out, /65600/, 'must name the impossible derived port');
    assert.match(r.out, /65500/, "must name the consumer's actual configured port");
    assert.match(r.out, /xpraTcpPort/, 'must offer the explicit-override remedy');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an OLD pin + an UNAFFECTED port says NOTHING', () => {
  // Scoping matters as much as detection: warning all consumers about a hazard
  // touching 100 ports out of 64512 is how a real signal gets tuned out.
  const base = fakeBase('old');
  try {
    for (const port of [4327, 4527, 4877, 65435 - 1]) {
      const r = run(base, port);
      assert.equal(r.code, 0, `port ${port} is unaffected and must pass`);
      assert.equal(r.out.trim(), '', `port ${port} must produce NO output, got: ${r.out}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a FIXED pin passes even on an affected port — refusing counts as safe', () => {
  // A base that throws has already protected the consumer; from here that is
  // indistinguishable from success, and must not be reported as a failure.
  const base = fakeBase('fixed');
  try {
    const r = run(base, 65500);
    assert.equal(r.code, 0, 'a base that refuses the derivation is compatible');
    assert.equal(r.out.trim(), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unresolvable base dir exits 2 and NAMES the path it looked for', () => {
  // "cannot check" must never be confused with "checked and fine" — and the
  // message has to say where it looked (xrl4 "Gate validity").
  const missing = path.join(tmpdir(), 'pin-compat-does-not-exist-xyz');
  const r = run(missing, 4877);
  assert.equal(r.code, 2, 'unable-to-check is exit 2, distinct from pass(0) and refuse(1)');
  assert.match(r.out, /cannot check/i);
  assert.match(r.out, /client-config\.js/, 'must name the resolved path it looked for');
});
