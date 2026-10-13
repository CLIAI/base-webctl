// no-host-literals.test.js — base's "no host literal in code" check (ib4k §3b "Machine names"; nl0c §3).
//
// Runs the REAL script in a throwaway git tree, with a machine-names file of made-up names (RFC 2606-style: nothing
// here is a real machine). ⛔ The script must never print a name: each arm checks its output for the planted one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkNoHostLiterals } from '../scripts/no-host-literals.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'no-host-literals.mjs');
const NAMES = ['alpha-box.example', 'beta-node'];

/** A git tree with `files` committed (and `untracked` left untracked), plus a names file. */
function tree(/** @type {Record<string, string>} */ files, /** @type {Record<string, string>} */ untracked = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-nhl-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (/** @type {string[]} */ a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), t); }
  if (Object.keys(files).length) { git(['add', '-A']); git(['commit', '-qm', 'x']); }
  for (const [p, t] of Object.entries(untracked)) fs.writeFileSync(path.join(repo, p), t);
  const names = path.join(dir, 'machine-names');
  fs.writeFileSync(names, NAMES.map((n) => `${n}\n`).join(''), { mode: 0o600 });
  return { repo, names, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Run the script in `cwd`; the variable set to `file` (undefined = unset). @param {string} cwd @param {string} [file] */
function run(cwd, file) {
  const env = { ...process.env };
  delete env.WEBCTL_MACHINE_NAMES_FILE;
  if (file !== undefined) env.WEBCTL_MACHINE_NAMES_FILE = file;
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const noName = (/** @type {string} */ out) => { for (const n of NAMES) assert.ok(!out.includes(n), `the output PRINTED a machine name:\n${out}`); };

test('⛔ a name planted in a TRACKED file is FOUND (exit 1) — printed as path:line and its index, never the name', () => {
  const t = tree({ 'src/a.js': 'const ok = 1;\n', 'src/b.js': "const h = 'x';\nconst host = 'beta-node';\n" });
  try {
    const r = run(t.repo, t.names);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FOUND src\/b\.js:2: machine name #2 of the passed file/);
    noName(r.out);
  } finally { t.done(); }
});

test('CONTROL: no literal in any tracked file → clean (exit 0); an UNTRACKED file naming one is not scanned', () => {
  const t = tree({ 'src/a.js': 'const ok = 1;\n' }, { 'notes.txt': 'alpha-box.example\n' });
  try {
    const r = run(t.repo, t.names);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /clean — 1 tracked file\(s\), 2 name\(s\)/);
    noName(r.out);
  } finally { t.done(); }
});

test('⛔ every refusal is NAMED (exit 2), never a pass: unset, unreadable, empty, nothing tracked, not a git tree', () => {
  const t = tree({ 'src/a.js': "const host = 'alpha-box.example';\n" });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-nhl-bare-'));
  try {
    const cases = /** @type {Array<[string, string, string|undefined, RegExp]>} */ ([
      ['unset', t.repo, undefined, /WEBCTL_MACHINE_NAMES_FILE is not set — run this under `isolated`/],
      ['unreadable', t.repo, path.join(bare, 'absent'), /names a file that cannot be read/],
      ['not a git tree', bare, t.names, /not a git work tree/],
    ]);
    for (const [what, cwd, file, re] of cases) {
      const r = run(cwd, file);
      assert.equal(r.code, 2, `${what}: ${r.out}`);
      assert.match(r.out, /REFUSED/, what);
      assert.match(r.out, re, what);
      noName(r.out);
    }
    const empty = path.join(bare, 'empty');
    fs.writeFileSync(empty, '\n\n');
    const e = run(t.repo, empty);
    assert.equal(e.code, 2, e.out);
    assert.match(e.out, /EMPTY .* a scan for nothing is not clean/);
    const none = tree({});
    try {
      const n = run(none.repo, none.names);
      assert.equal(n.code, 2, n.out);
      assert.match(n.out, /git tracks no files here/);
    } finally { none.done(); }
  } finally { t.done(); fs.rmSync(bare, { recursive: true, force: true }); }
});

test('checkNoHostLiterals (pure): a binary or unreadable tracked file is skipped, not scanned as text', () => {
  const r = checkNoHostLiterals({
    env: { WEBCTL_MACHINE_NAMES_FILE: '/x' }, readFile: () => 'beta-node\n',
    tracked: () => ({ files: ['a.bin', 'b.js'], why: '' }), readTracked: (p) => (p === 'a.bin' ? null : 'const n = 1;\n'),
  });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines[0], /1 tracked file\(s\)/);
});
