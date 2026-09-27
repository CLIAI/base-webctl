// design-doc-id-uniqueness.test.js — the duplicate-ID check must be able to say NO.
//
// ⛔ WHY: "No duplicate IDs across documents" was a DOCUMENTED CHECK THAT COULD
// NOT FAIL. build_id_index returned dict[str, Path], so a second doc with the
// same ID overwrote the first; the check downstream then regrouped an
// already-unique mapping, and `len(paths) > 1` was unreachable. Measured
// 2026-09-27 on master + the 21 unmerged design/* branches: 47 docs scanned,
// 40 indexed, "All files passed validation", rc 0. Seven docs vanished from the
// index and the verdict was green.
//
// ⇒ The IDs are what docs/design cross-references RESOLVE THROUGH, so a
// collision does not merely go unreported: `relates_to: [v7m2]` silently
// resolves to whichever doc won the overwrite. A wrong cross-reference is the
// coverage corpus answering confidently and incorrectly.
//
// ⭐ This file also wires the verifier into `npm test`. Before it, the check ran
// only when an agent remembered the command in AGENTS.md — and a check nothing
// invokes is indistinguishable from one that cannot fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts', 'verify_yaml_frontmatter.py');

/**
 * Run the verifier; never throws, so a control can assert on the exit code.
 * @param {string} dir
 */
function verify(dir) {
  try {
    const stdout = execFileSync('uv', ['run', TOOL, dir],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out: stdout, missing: false };
  } catch (/** @type {any} */ e) {
    if (e.code === 'ENOENT') return { status: -1, out: '', missing: true };
    return { status: e.status == null ? -1 : e.status, out: (e.stdout || '') + (e.stderr || ''), missing: false };
  }
}

/** @param {string} category @param {string} slug @param {string} id */
function doc(category, slug, id) {
  return {
    name: `${category}-${slug}-${id}.md`,
    // ⚠ The dates MUST be quoted. Bare `created: 2026-09-27` is a YAML date
    // object, not a string, and the schema rejects it — which first made this
    // fixture fail its own CONTROL, and made the MUTATION's rc=1 arrive for the
    // wrong reason. A double that cannot satisfy the real schema proves nothing.
    body: `---\nid: ${id}\ntitle: "${slug}"\ncategory: ${category}\n`
      + `created: "2026-09-27"\nupdated: "2026-09-27"\nstatus: draft\n---\n\n# ${slug}\n`,
  };
}

/**
 * A throwaway corpus containing exactly the docs given.
 * @param {{name: string, body: string}[]} docs
 */
function corpus(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-ids-'));
  for (const d of docs) fs.writeFileSync(path.join(dir, d.name), d.body);
  return dir;
}

test('CONTROL: distinct IDs pass — the check is not simply always-red', (t) => {
  const r = verify(corpus([doc('arch', 'alpha', 'aa11'), doc('infra', 'beta', 'bb22')]));
  if (r.missing) return t.skip('uv is not installed; the verifier could not be run at all');
  assert.equal(r.status, 0, `a clean corpus must pass, got rc=${r.status}:\n${r.out}`);
  assert.match(r.out, /All files passed validation/);
});

test('MUTATION: two docs sharing an ID must FAIL, and both must be named', (t) => {
  // The real collision shape: one ID, different categories AND different slugs,
  // each filename postfix agreeing with its own front matter. Nothing but the
  // index can notice these two.
  const r = verify(corpus([doc('arch', 'alpha', 'dup1'), doc('safety', 'beta', 'dup1')]));
  if (r.missing) return t.skip('uv is not installed; the verifier could not be run at all');

  assert.equal(r.status, 1, `a duplicate ID must be an error, got rc=${r.status}:\n${r.out}`);
  assert.match(r.out, /DUPLICATE ID 'dup1'/, 'the colliding ID must be named');
  // ⇒ Naming ONE of the pair would be a half-fix: the reader cannot act without
  // knowing which documents collided.
  assert.match(r.out, /arch-alpha-dup1\.md/, 'the first colliding doc must be named');
  assert.match(r.out, /safety-beta-dup1\.md/, 'the second colliding doc must be named');

  // ⇒ rc=1 ALONE IS A PROXY. It was satisfied, on the first run of this file, by
  // four unrelated date errors in a broken fixture. Pin the count so the
  // duplicate is the ONLY reason this corpus is rejected.
  assert.match(r.out, /^1 error\(s\) found\.$/m,
    `the duplicate must be the only error, so rc=1 cannot arrive for another reason:\n${r.out}`);
});

test('VACUITY: every scanned doc reaches the index — no silent drop', (t) => {
  // The old defect's signature was visible in the output and read as normal:
  // "47 design doc(s) scanned / 40 document(s) with IDs indexed". Assert the
  // counts agree, so a future index keyed by anything collision-prone is caught
  // by the count rather than by whoever next reads the numbers.
  const r = verify(corpus([doc('arch', 'alpha', 'dup1'), doc('safety', 'beta', 'dup1'),
    doc('infra', 'gamma', 'cc33')]));
  if (r.missing) return t.skip('uv is not installed; the verifier could not be run at all');

  const scanned = Number(/Scanning (\d+) design doc/.exec(r.out)?.[1]);
  const indexed = Number(/(\d+) document\(s\) with IDs indexed/.exec(r.out)?.[1]);
  assert.equal(scanned, 3, `expected 3 scanned, output was:\n${r.out}`);
  assert.equal(indexed, scanned,
    `${scanned} docs scanned but only ${indexed} indexed — the index dropped a doc silently`);
});

test("base's own docs/design passes the verifier", (t) => {
  const r = verify(path.join(ROOT, 'docs', 'design'));
  if (r.missing) return t.skip('uv is not installed; the verifier could not be run at all');
  assert.equal(r.status, 0, `base's design corpus must validate:\n${r.out}`);
});
