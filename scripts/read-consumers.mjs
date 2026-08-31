// read-consumers.mjs — emit consumers.jsonc as tab-separated rows for the
// gate shell scripts. Zero-dep, string-aware JSONC stripping (handles // and
// /* */ without corrupting values like git@host:path or http://...).
//
// Usage: node scripts/read-consumers.mjs [path/to/consumers.jsonc]
// Output (one row per consumer, tab-separated):
//   name \t submodulePath \t testCmd \t tier \t dockerOptIn \t wired \t localDir
//
// localDir is OPTIONAL and empty for most consumers, which then resolve to
// $WEBCTL_CONSUMERS_DIR/<name>. It exists because a consumer's local directory
// name need not equal its registry name — and when it does not, the gate
// silently could not find the repo and reported SKIP forever.

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

// A consumer of this output may stop reading early (`awk '...{exit}'`, `head`),
// which closes the pipe and makes the next write raise EPIPE. That is normal
// shell behaviour, not an error worth a stack trace — and an unhandled one made
// the drift script explode when it looked up a single consumer by name.
process.stdout.on('error', (err) => {
  if (err && /** @type {any} */ (err).code === 'EPIPE') process.exit(0);
  throw err;
});

const data = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
for (const c of (data.consumers || [])) {
  process.stdout.write([
    c.name, c.submodulePath, c.testCmd, c.tier,
    c.dockerOptIn ? 'true' : 'false',
    c.wired ? 'true' : 'false',
    c.localDir || '',
  ].join('\t') + '\n');
}
