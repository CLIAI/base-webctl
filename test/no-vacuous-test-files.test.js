// no-vacuous-test-files.test.js — a file that asserts nothing counts as a PASS.
//
// ⛔ MEASURED ON THIS RUNNER, not taken from a report:
//
//     node --test <zero-byte file>        -> # tests 1 · # pass 1 · # fail 0
//     node --test <only imports assert>   -> # tests 1 · # pass 1 · # fail 0
//     node --test <test() with no assert> -> # tests 1 · # pass 1 · # fail 0
//
// ⇒ So "# pass 292" cannot distinguish ASSERTED AND PASSED from ASSERTED
// NOTHING — in the one number this repo reports after every change and quotes
// to every consumer. A sibling lane found it when its suite went 1381 -> 1380
// and the deleted file was an empty one left by an errant heredoc: the count
// moved for a reason unrelated to coverage, and nothing else would have said so.
//
// ⚠ base's suite is clean today. This exists so it stays that way, because the
// failure is invisible in exactly the direction nobody investigates: the number
// goes UP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Enumerate test files the way the RUNNER finds them, cross-checked against
 * git so a narrowing pattern cannot hide.
 *
 * ⛔ TWO INDEPENDENT ENUMERATIONS THAT MUST AGREE. A guard with its own idea of
 * which files matter stops covering files added after it was written — and
 * would miss the very file that prompted it. git is the second opinion: if the
 * runner discovers a file this list does not, the counts diverge and the guard
 * fails rather than quietly covering less.
 */
function discover() {
  const fromGit = execFileSync('git', ['ls-files', 'test/'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.test\.(js|cjs|mjs)$/.test(f));

  // What node itself discovers, named as file-level subtests in its TAP output.
  const tap = execFileSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...fromGit.map((f) => path.join(ROOT, f))],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { fromGit, tap };
}

test('⛔ no test file asserts nothing — an empty file is a PASSING test', () => {
  const { fromGit } = discover();

  // ⛔ ZERO FILES FAILS. "Nothing to check, OK" is the vacuity this guard exists
  // to catch, reproduced inside the guard. A pattern that stops matching, a
  // rename, a move — all present as a clean run.
  assert.ok(fromGit.length > 0,
    'discovered ZERO test files. That is not a pass — it is this guard failing '
    + 'to find its own subject, which is the defect it was written for.');

  /** @type {string[]} */
  const vacuous = [];
  /** @type {string[]} */
  const empty = [];
  for (const rel of fromGit) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (src.trim() === '') { empty.push(rel); continue; }
    // Strip import lines before looking: a file that IMPORTS assert and never
    // calls it is the subtler shape, and without stripping there would only be
    // evidence this catches empty files.
    const body = src.split('\n').filter((l) => !/^\s*(import|const .*=\s*require)\b/.test(l)).join('\n');
    if (!/\bassert\b\s*[.(]/.test(body)) vacuous.push(rel);
  }

  assert.deepEqual(empty, [], `zero-byte test file(s), each counting as a PASS: ${empty.join(', ')}`);
  assert.deepEqual(vacuous, [],
    `test file(s) that never call assert, each counting as a PASS: ${vacuous.join(', ')}`);
});

test('the guard discriminates EMPTY from ASSERT-FREE from REAL', () => {
  // ⚠ Without this, there is only evidence the check catches empty files —
  // and the import-but-never-call shape is the one that survives review,
  // because the file looks like a test.
  const strip = (/** @type {string} */ s) =>
    s.split('\n').filter((l) => !/^\s*(import|const .*=\s*require)\b/.test(l)).join('\n');
  const asserts = (/** @type {string} */ s) => /\bassert\b\s*[.(]/.test(strip(s));

  assert.equal(asserts(''), false, 'empty must not read as asserting');
  assert.equal(asserts('import assert from "node:assert/strict";\n'), false,
    'importing assert without calling it must not read as asserting');
  assert.equal(asserts('import assert from "node:assert";\ntest("x", () => { assert.ok(1); });'), true,
    'a real assertion must read as asserting — otherwise the guard flags everything');
});
