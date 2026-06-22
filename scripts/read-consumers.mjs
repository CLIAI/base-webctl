// read-consumers.mjs — emit consumers.jsonc as tab-separated rows for the
// gate shell scripts. Zero-dep, string-aware JSONC stripping (handles // and
// /* */ without corrupting values like git@host:path or http://...).
//
// Usage: node scripts/read-consumers.mjs [path/to/consumers.jsonc]
// Output (one row per consumer, tab-separated):
//   name \t submodulePath \t testCmd \t tier \t dockerOptIn \t wired

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(here, '..', 'consumers.jsonc');

/**
 * Strip // line comments and /* *\/ block comments, respecting string literals.
 * @param {string} src
 * @returns {string}
 */
function stripJsonc(src) {
  let out = '';
  let inStr = false, inLine = false, inBlock = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

const data = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
for (const c of (data.consumers || [])) {
  process.stdout.write([
    c.name, c.submodulePath, c.testCmd, c.tier,
    c.dockerOptIn ? 'true' : 'false',
    c.wired ? 'true' : 'false',
  ].join('\t') + '\n');
}
