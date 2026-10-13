#!/usr/bin/env node
// no-host-literals.mjs — the "no host literal in code" check (nl0c §3), owned by base (ib4k §3b "Machine names").
//
// Scans the files git TRACKS in the cwd for the lane's machine names, read from the file `isolated` passes in
// ($WEBCTL_MACHINE_NAMES_FILE, one name per line). ⛔ The names are private: a hit prints `path:line` and the
// name's INDEX in that file, never the name.
//
// Exit: 0 clean · 1 found · 2 REFUSED (no file passed, unreadable, empty, or nothing tracked — a scan for nothing
// is not "clean"). See no-host-literals.mjs.README.md.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findHostLiterals } from '../lib/remotes.js';

/** The variable `isolated` sets (contract-harness.mjs MACHINE_NAMES_ENV). */
const ENV = 'WEBCTL_MACHINE_NAMES_FILE';

/**
 * The check, pure but for the reads it is given. ⛔ No reason or hit carries a name.
 * @param {{env: NodeJS.ProcessEnv, readFile: (p: string) => string, tracked: () => {files: string[] | null, why: string},
 *   readTracked: (p: string) => string | null}} io
 * @returns {{code: 0 | 1 | 2, lines: string[]}}
 */
export function checkNoHostLiterals(io) {
  const refuse = (/** @type {string} */ why) => ({ code: /** @type {2} */ (2), lines: [`no-host-literals: REFUSED: ${why}`] });
  const file = io.env[ENV];
  if (!file) {
    return refuse(`${ENV} is not set — run this under \`isolated\`, which passes the machine names `
      + '(it says `machine-names: none (<why>)` in its verdict when it could not)');
  }
  let text = '';
  try { text = io.readFile(file); } catch { return refuse(`${ENV} names a file that cannot be read`); }
  const names = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!names.length) return refuse('the machine-names file is EMPTY (xq lists no machines) — a scan for nothing is not clean');
  const t = io.tracked();
  if (!t.files) return refuse(t.why);
  /** @type {{path: string, text: string}[]} */ const files = [];
  for (const p of t.files) {
    const s = io.readTracked(p);
    if (s !== null) files.push({ path: p, text: s });
  }
  const r = findHostLiterals(files, names);
  if (r.verdict === 'refused') return refuse(r.reason);
  if (r.verdict === 'clean') return { code: 0, lines: [`no-host-literals: clean — ${files.length} tracked file(s), ${names.length} name(s)`] };
  return { code: 1, lines: [...r.hits.map((h) => `no-host-literals: FOUND ${h.path}:${h.line}: machine name #${names.indexOf(h.name) + 1} of the passed file`),
    `no-host-literals: FAIL — ${r.hits.length} host literal(s) in tracked files`] };
}

/** git's tracked files in `cwd` (NUL-separated, so any name is safe). @param {string} cwd */
function gitTracked(cwd) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return { files: null, why: 'not a git work tree (`git ls-files` failed) — only TRACKED files are scanned' };
  const files = r.stdout.split('\0').filter(Boolean);
  return files.length ? { files, why: '' } : { files: null, why: 'git tracks no files here' };
}

/** A tracked file's text, or null when it is not a readable regular file (a submodule, a deleted path). @param {string} p */
function readTracked(p) {
  try {
    if (!fs.lstatSync(p).isFile()) return null;
    const b = fs.readFileSync(p);
    return b.includes(0) ? null : b.toString('utf8'); // binary: not source
  } catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkNoHostLiterals({ env: process.env, readFile: (p) => fs.readFileSync(p, 'utf8'), tracked: () => gitTracked(process.cwd()), readTracked });
  for (const l of r.lines) (r.code === 0 ? process.stdout : process.stderr).write(`${l}\n`);
  process.exit(r.code);
}
