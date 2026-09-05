// package-version-matches-tag.test.js — the tag and the version string must
// name the SAME release.
//
// WHY THIS EXISTS: six of the first ten tags disagreed with the package.json
// inside them. v0.4.0 and v0.5.0 shipped saying "0.3.0"; v0.7.0 through
// v0.10.0 all shipped saying "0.6.0". A consumer asking "which base am I on?"
// got one answer from `git describe` and a different one from package.json,
// which is the entire job of a version string.
//
// It was not theoretical: it produced a wrong belief across two sessions about
// which base a consumer was pinned to, and the disagreement is invisible unless
// something compares the two. Reported by cgwc:main, 2026-09-05, who argued for
// a check over a one-off correction on the grounds that this is an apparatus
// defect — the family's failures this week have been in the checking apparatus
// rather than in the code. That is the right call and this is that check.
//
// The convention it enforces: package.json is bumped IN the release commit, so
// the tagged tree is self-consistent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string[]} args */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/** Numeric semver compare; -1 / 0 / 1. @param {string} a @param {string} b */
function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

test('⭐ package.json version agrees with the git tag naming this release', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+$/, 'version must be a bare semver triple');

  // ⛔ A check that cannot reach its subject must say so, never pass quietly —
  // a shallow clone has no tags, and silence there is indistinguishable from
  // agreement (the failure this suite keeps re-learning).
  const latest = git(['describe', '--tags', '--abbrev=0']);
  if (!latest) {
    assert.fail(
      'NO TAGS REACHABLE — this check could not run. If that is a shallow CI '
      + 'clone, fetch tags (actions/checkout: fetch-depth: 0). Not passing on an '
      + 'absence.',
    );
  }

  const atHead = git(['tag', '--points-at', 'HEAD'])
    .split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));

  if (atHead.length > 0) {
    // THE LOAD-BEARING BRANCH: the state every release lands in, and the one
    // that would have caught all six historical mismatches.
    for (const tag of atHead) {
      assert.equal(version, tag.slice(1),
        `HEAD is tagged ${tag} but package.json says ${version}. The tagged `
        + 'tree must name its own version — a consumer reading either must get '
        + 'the same answer. Bump package.json IN the release commit.');
    }
    return;
  }

  // Between releases: package.json carries the last released version, or the
  // next one while a release commit is being prepared. It must never be BEHIND
  // the newest tag — that is the shape all six failures took.
  assert.ok(cmp(version, latest.slice(1)) >= 0,
    `package.json says ${version} but ${latest} is already tagged. The version `
    + 'string is behind the tags, so it names a release that is not the one you '
    + 'are on.');
});
