// test/log-rotation.test.js — every case below corresponds to a defect actually
// observed in a consumer, not to a hypothetical.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogRotation } from '../lib/log-rotation.js';

// chatgpt-webctl's format. Group 1 is the sort key.
const CHATGPT = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-\d+\.jsonl$/;
// linkedin-webctl's format — deliberately DIFFERENT, which is the whole reason
// the pattern is injected rather than shared.
const LINKEDIN = /^(\d{8}T\d{6})-\d+\.jsonl$/;

const rot = (re = CHATGPT) => createLogRotation({ LOG_FILENAME_RE: re });
const iso = (d, pid) => `2026-09-${d}T10-00-00-${pid}.jsonl`;

describe('createLogRotation — the seam', () => {
  it('refuses to be constructed without a pattern', () => {
    // There is no safe default: a default would be one repo's format, and would
    // either delete another repo's files or silently stop pruning its own.
    assert.throws(() => createLogRotation({}), /LOG_FILENAME_RE is required/);
    assert.throws(() => createLogRotation(null), /LOG_FILENAME_RE is required/);
    assert.throws(() => createLogRotation({ LOG_FILENAME_RE: '^x$' }), /must be a RegExp/);
  });

  it('two consumers with different formats do not see each other as prunable', () => {
    const names = [iso('01', 1), '20260901T100000-2.jsonl'];
    assert.deepEqual(rot(CHATGPT).selectLogsToPrune(names, 0), [iso('01', 1)]);
    assert.deepEqual(rot(LINKEDIN).selectLogsToPrune(names, 0), ['20260901T100000-2.jsonl']);
  });
});

describe('only OUR files are candidates', () => {
  it('never selects a file that is not ours, however many there are', () => {
    const names = ['ttl-gc.jsonl', '20260902T084241-2474887.jsonl', 'notes.jsonl',
                   iso('01', 1), iso('02', 2)];
    assert.deepEqual(rot().selectLogsToPrune(names, 0), [iso('01', 1), iso('02', 2)]);
  });

  it('foreign files are not even COUNTED toward keep', () => {
    // Otherwise a sibling filling a shared directory provokes us into pruning
    // our own logs early — the same collision causing a second, opposite bug.
    const names = [
      'ttl-gc.jsonl',
      ...Array.from({ length: 20 }, (_, i) => `2026090${i % 9}T08424${i % 9}-${i}.jsonl`),
      iso('01', 1), iso('02', 2),
    ];
    assert.deepEqual(rot().selectLogsToPrune(names, 2), []);
  });

  it('the LEDGER survives even when it is the oldest thing present', () => {
    // The incident, reduced to one assertion.
    const names = ['ttl-gc.jsonl', iso('01', 1), iso('02', 2), iso('03', 3)];
    const del = rot().selectLogsToPrune(names, 1);
    assert.ok(!del.includes('ttl-gc.jsonl'), 'a file we did not create is not ours to delete');
    assert.deepEqual(del, [iso('01', 1), iso('02', 2)]);
  });
});

describe('keep is a POST-CONDITION', () => {
  it('leaves exactly `keep` of ours behind', () => {
    const names = [iso('01', 1), iso('02', 2), iso('03', 3), iso('04', 4)];
    for (const keep of [0, 1, 2, 3, 4, 9]) {
      const remaining = names.length - rot().selectLogsToPrune(names, keep).length;
      assert.equal(remaining, Math.min(keep, names.length), `keep=${keep}`);
    }
  });

  it('keep=0 deletes ALL of ours and is never read as "unlimited"', () => {
    assert.equal(rot().selectLogsToPrune([iso('01', 1), iso('02', 2)], 0).length, 2);
  });
});

describe('ordering comes from the captured timestamp', () => {
  it('deletes oldest-first by the timestamp IN THE NAME, not by array order', () => {
    const names = [iso('05', 1), iso('01', 2), iso('03', 3)];
    assert.deepEqual(rot().selectLogsToPrune(names, 1), [iso('01', 2), iso('03', 3)]);
  });

  it('a variable-width pid never reorders two logs from the same second', () => {
    // '-9' sorts after '-10' lexicographically, so sorting the WHOLE filename is
    // wrong. Both are equally stale so it cannot change WHICH survive — but only
    // because the key stops at the timestamp.
    const a = iso('01', 9);
    const b = iso('01', 10);
    const del = rot().selectLogsToPrune([a, b, iso('09', 1)], 1);
    assert.equal(del.length, 2);
    assert.ok(del.includes(a) && del.includes(b), 'neither survives on pid luck');
  });

  it('is deterministic regardless of readdir order', () => {
    const names = [iso('01', 3), iso('01', 1), iso('01', 2), iso('09', 9)];
    const once = rot().selectLogsToPrune(names, 1);
    const again = rot().selectLogsToPrune([...names].reverse(), 1);
    assert.deepEqual(once.slice().sort(), again.slice().sort());
  });
});

describe('an injected pattern cannot be stateful', () => {
  it('a /g pattern does not skip every other file', () => {
    // `.exec()` advances lastIndex on a global regex. Measured unfixed:
    // ["a1.log"] — 2 of 4 recognised.
    const r = rot(/^a(\d)\.log$/g);
    assert.deepEqual(r.selectLogsToPrune(['a1.log', 'a2.log', 'a3.log', 'a4.log'], 1),
      ['a1.log', 'a2.log', 'a3.log']);
  });

  it('the same /g pattern gives the same answer twice', () => {
    const r = rot(/^a(\d)\.log$/g);
    const names = ['a1.log', 'a2.log', 'a3.log'];
    assert.deepEqual(r.selectLogsToPrune(names, 1), r.selectLogsToPrune(names, 1),
      'a delete path depending on a regex\'s previous use is not reproducible');
  });

  it('isOwnLogFile is not stateful either', () => {
    // `.test()` advances lastIndex too — the classic every-other-call failure.
    const r = rot(/^a(\d)\.log$/g);
    assert.equal(r.isOwnLogFile('a1.log'), true);
    assert.equal(r.isOwnLogFile('a1.log'), true, 'the second call must agree with the first');
  });

  it('a pattern with NO capture group falls back to whole-name ordering', () => {
    // Must not throw: callers wrap rotation in try/catch, so a throw stops
    // rotation silently and logs accumulate forever.
    const r = rot(/^b\d\.log$/);
    assert.deepEqual(r.selectLogsToPrune(['b3.log', 'b1.log', 'b2.log'], 1), ['b1.log', 'b2.log']);
  });
});

describe('the KNOWN RESIDUAL — same-format consumers are indistinguishable', () => {
  it('a sibling using OUR format matches our pattern and WOULD be selected', () => {
    // Asserted so a green suite is not misread as "the collision is closed".
    // Anchoring stops us deleting LEDGERS and differently-formatted siblings; it
    // does NOT separate two tools that share a format, because a filename
    // carries no tool identity. That half needs a tool-scoped directory
    // (lib/storage-paths.js), sequenced AFTER this change.
    assert.equal(rot().isOwnLogFile('2026-09-05T21-00-00-999999.jsonl'), true);
  });
});


describe('an invalid `keep` must THROW, never delete everything', () => {
  // ⛔ THE BLOCKER webctl:base found by RUNNING the module rather than reading
  // it. Every malformed input funnelled to budget 0, and budget 0 means "delete
  // all of ours" — so the maximally destructive outcome was what a MISSING
  // ARGUMENT produced, silently, looking like an ordinary rotation.
  //
  //     keep omitted -> deletes 3     keep = NaN -> deletes 3
  //     keep = -1    -> deletes 3     keep = "2" -> deletes 3
  //     keep = 2     -> deletes 1  ✓
  //
  // The string case is the one that will actually happen: env and config
  // deliver strings, so MAX_LOG_FILES=5 arriving as "5" deleted all five.
  const files = ['2026-09-01T10-00-00-1.jsonl', '2026-09-02T10-00-00-2.jsonl'];

  it('throws when keep is omitted', () => {
    assert.throws(() => rot().selectLogsToPrune(files), /keep/i);
  });

  it('throws on NaN, negatives and non-integers', () => {
    for (const bad of [NaN, -1, -0.5, 1.5, Infinity, null, {}, [], true]) {
      assert.throws(() => rot().selectLogsToPrune(files, bad), /keep/i, `keep=${String(bad)}`);
    }
  });

  it('COERCES an exact integer string', () => {
    assert.deepEqual(rot().selectLogsToPrune(files, '1'), [files[0]]);
    assert.deepEqual(rot().selectLogsToPrune(files, '0'), files);
  });

  it('throws on a string that is not an exact integer', () => {
    for (const bad of ['', ' ', 'abc', '1.5', '1e3', '0x2', ' 1 ']) {
      assert.throws(() => rot().selectLogsToPrune(files, bad), /keep/i, JSON.stringify(bad));
    }
  });

  it('an EXPLICIT keep=0 still deletes all of ours — it is a real instruction', () => {
    assert.deepEqual(rot().selectLogsToPrune(files, 0), files);
  });
});

describe('the pattern must be ANCHORED — enforced, not merely stated', () => {
  // base reproduced THE ORIGINAL INCIDENT through this seam:
  //   createLogRotation({LOG_FILENAME_RE: /\.jsonl$/})
  //   selectLogsToPrune(['ttl-gc.jsonl','20260901T100000-1.jsonl','telegram-run.jsonl'], 1)
  //     -> ["20260901T100000-1.jsonl", "telegram-run.jsonl"]
  // A foreign tool's file selected for deletion, through the module whose whole
  // purpose is to prevent that.
  it('refuses an unanchored pattern at CONSTRUCTION', () => {
    assert.throws(() => createLogRotation({ LOG_FILENAME_RE: /\.jsonl$/ }), /anchored/i);
    assert.throws(() => createLogRotation({ LOG_FILENAME_RE: /^\d+/ }), /anchored/i);
  });

  it('the refusal names the incident, not just the rule', () => {
    try { createLogRotation({ LOG_FILENAME_RE: /\.jsonl$/ }); assert.fail('should throw'); }
    catch (e) { assert.match(e.message, /not yours to delete/i); }
  });

  it('ALLOW_UNANCHORED_LOG_PATTERN is an explicit acknowledgement, not a default', () => {
    const r = createLogRotation({ LOG_FILENAME_RE: /\.jsonl$/, ALLOW_UNANCHORED_LOG_PATTERN: true });
    assert.equal(r.isOwnLogFile('anything.jsonl'), true);
  });
});
