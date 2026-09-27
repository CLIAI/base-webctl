// agents-md-indexes-the-corpus.test.js — the index every agent reads must match
// the corpus it claims to index.
//
// ⛔ WHY: `docs/design/` is the COVERAGE INSTRUMENT for the whole *-webctl family
// — which specs a consumer applies is read off these IDs — and `AGENTS.md` is the
// index through which every agent discovers them. Measured 2026-09-27: 26 docs on
// master, **19 cited in AGENTS.md**. Seven were invisible to anyone who trusted
// the index, including `arch-browser-targets-btg4` and
// `test-checks-that-cannot-fail-k3wn`, which had been written that same week.
//
// ⇒ It drifts in the SILENT direction. A missing entry does not break anything;
// it just means a lane re-derives, or reimplements, a spec that already exists —
// which is the duplication this whole programme exists to stop, arrived at by
// someone reading the documentation they were told to read.
//
// ⭐ An index nothing verifies is not an index, it is a snapshot of whoever last
// remembered to edit it. Both directions are checked: an uncited doc is invisible,
// and a citation with no doc sends a reader to a file that is not there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Doc slugs present on disk, e.g. `arch-browser-targets-btg4`. */
function docsOnDisk() {
  return fs.readdirSync(path.join(ROOT, 'docs', 'design'))
    .filter((f) => f.endsWith('.md') && f !== 'DESIGN_DOCS_GUIDELINES.md')
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

/**
 * Doc slugs cited in AGENTS.md. Cited means backticked with its 4-char ID, which
 * is how the corpus list and every cross-reference in that file writes them.
 */
function docsCitedInAgentsMd() {
  const text = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const cited = new Set();
  for (const m of text.matchAll(/`([a-z]+-[a-z0-9-]+-[a-z0-9]{4})`/g)) cited.add(m[1]);
  return [...cited].sort();
}

test('⛔ every design doc is discoverable from AGENTS.md', () => {
  const onDisk = docsOnDisk();
  const cited = docsCitedInAgentsMd();

  // ⚠ VACUITY, both sides. Zero docs discovered, or zero citations parsed, means
  // this test lost its subject — which reads identically to "nothing is missing".
  assert.ok(onDisk.length >= 10,
    `discovered only ${onDisk.length} design docs; this test has lost its subject`);
  assert.ok(cited.length >= 10,
    `parsed only ${cited.length} citations from AGENTS.md — the citation pattern `
    + 'has probably stopped matching, which would make this check vacuous');

  const uncited = onDisk.filter((d) => !cited.includes(d));
  assert.deepEqual(uncited, [],
    `${uncited.length} design doc(s) exist but are NOT cited in AGENTS.md, so an `
    + 'agent reading the index cannot find them: ' + uncited.join(', ')
    + '. Add them to the corpus list.');
});

test('⛔ AGENTS.md cites no design doc that does not exist', () => {
  const onDisk = docsOnDisk();
  const cited = docsCitedInAgentsMd();

  const dangling = cited.filter((d) => !onDisk.includes(d));
  assert.deepEqual(dangling, [],
    `AGENTS.md cites ${dangling.length} doc(s) with no file in docs/design/: `
    + dangling.join(', ') + '. A citation that resolves to nothing is worse than '
    + 'no citation: the reader concludes the spec is missing from their checkout.');
});
