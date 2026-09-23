#!/usr/bin/env node
// base-surface.mjs — what does base ACTUALLY expose? Ask by CONSTRUCTING.
//
// ⛔ THE ERROR THIS EXISTS FOR, MADE TWICE IN ONE HOUR BY TWO PEOPLE.
// Asked "does base have inspect()?", a lane grepped `export function inspect`
// across base's lib, found nothing, and told two peers the capability was
// missing. Its manager then re-derived it with the same query shape and logged
// "verified at the tag". Both were wrong, and both called it verified.
//
//     grep 'export function inspect'   -> 0 matches
//     grep '    inspect,'              -> 1 match
//
// `inspect` is an INNER function returned in the driver's object literal, so a
// grep keyed on `export` is structurally blind to it EVEN IN THE RIGHT FILE.
//
// ⭐ AND THAT IS THE SHIM-COMPLETENESS CHECK MIRRORED. A shim re-exporting only
// THE FACTORY'S RETURN is blind to MODULE-LEVEL exports; a grep for MODULE-LEVEL
// exports is blind to THE FACTORY'S RETURN. Same seam, opposite side — both
// instruments correct about everything they looked at.
//
// ⇒ The measurement that makes someone run this, which matters more than who
// found it: **140 module-level exports, 117 factory-return members — 46% of the
// callable surface is reachable ONLY by constructing.** Three parties measured
// it by three methods and landed on the same number.
//
// ⚠ ENUMERATING BY CALLING IS NOT FREE. base's `resolveChromiumProfile()`
// mkdirs, which is how a consumer's `profile-path` command documented
// "(read-only)" created a directory for any slug named. Everything constructed
// here is pointed at a throwaway HOME, and the tool PRINTS where it pointed it
// so a reader can check that claim rather than trust it.
//
// ⛔ READ THIS BEFORE ADDING "SHOW ME WHAT EACH MEMBER RETURNS".
// That is the obvious next feature and it is the one that is NOT safe:
//
//     CONSTRUCTING is pure.  createDriver() has been side-effect-free since
//                            v0.11.0. That is why this tool can build every
//                            factory and still leave the cache untouched.
//     INVOKING is NOT.       profilePathFor(slug, dir)          pure
//                            resolveChromiumProfile(slug, dir)  WRITES
//
// `resolveChromiumProfile()` keeps its mkdir DELIBERATELY — it is on the
// bring-up path, where creating the directory is the job. `profilePathFor()` is
// the pure sibling. The hazard note lives here rather than only in AGENTS.md
// because ⭐ a hazard note is only useful where the hand is: the person adding
// that feature is reading THIS file.
//
// ⚠ ESM ON PURPOSE. base is ESM, so this loads modules natively rather than
// through `require(esm)`. A CJS lane reaches it the same way it reaches every
// other base module — which is why base ships one copy instead of each lane
// carrying its own enumerator.
//
// Usage:  node scripts/base-surface.mjs [name-substring]
// Exit:   0 ok · 1 the tool found no factory returns (see the vacuity guard)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';

// A constants bag rich enough to construct every factory. ⚠ Deliberately NOT
// base's own template: a fixture that is the thing under test cannot show that
// the thing under test is missing something.
const C = {
  PROJECT: 'surface-probe', ARTIFACT_PREFIX: 'surface-probe-',
  IMAGE_CHROMIUM_REPO: 'probe/chromium', IMAGE_XPRA: 'probe/xpra:latest',
  DEFAULT_CDP_PORT: 4427, CACHE_DIRNAME: 'surface-probe',
  ZOOM_DEFAULT_HOST: 'probe.invalid', CONFIG_FILE_PROJECT: 'probe.config.jsonc',
  DOTENV_FILENAME: '.env.probe', DOTENV_TEMPLATE: '.env.probe.example',
  ENV_PREFIX: 'PROBE_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [],
  LOG_FILENAME_RE: /^(\d{8}T\d{6})-\d+\.jsonl$/,
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'base-surface-'));
const realHome = process.env.HOME;
process.env.HOME = sandbox;

/** @type {Array<{module: string, name: string, kind: string}>} */
const rows = [];
const add = (m, n, k) => rows.push({ module: m, name: n, kind: k });

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(ROOT, 'lib'));
files.sort();

for (const file of files) {
  const rel = path.relative(ROOT, file);
  let mod;
  try {
    mod = await import(file);
  } catch (e) {
    add(rel, `<load failed: ${String(e.message).split('\n')[0]}>`, 'error');
    continue;
  }
  for (const [name, val] of Object.entries(mod)) {
    add(rel, name, 'module export');
    if (typeof val === 'function' && /^create[A-Z]/.test(name)) {
      let built;
      try {
        built = val(C, { dockerfilesDir: path.join(sandbox, 'dockerfiles'), assert: false });
      } catch (e) {
        // ⭐ A ROW, NOT A SILENCE. "Cannot construct without arguments" is a
        // TRUE answer about the surface and belongs in the output; omitting it
        // would make a factory look absent rather than differently-shaped.
        add(rel, `${name}() — needs opts: ${String(e.message).split('\n')[0].slice(0, 60)}`, 'needs opts');
        continue;
      }
      if (built && typeof built === 'object') {
        for (const k of Object.keys(built)) add(rel, `${name}().${k}`, 'factory return');
        // One level deeper where a factory returns a driver factory, because
        // that is where `inspect` lives and where the original error happened.
        if (typeof (/** @type {any} */ (built).createDriver) === 'function') {
          try {
            const drv = (/** @type {any} */ (built)).createDriver({
              port: 4427, host: '127.0.0.1', slug: 'surface-probe',
              userDataDir: path.join(sandbox, 'profile'),
            });
            if (drv && typeof drv === 'object') {
              for (const k of Object.keys(drv)) add(rel, `${name}().createDriver().${k}`, 'driver surface');
            }
          } catch { /* a driver needing more cfg is not a surface fact */ }
        }
      }
    }
  }
}

process.env.HOME = realHome;

const counts = rows.reduce((/** @type {Record<string, number>} */ a, r) => {
  a[r.kind] = (a[r.kind] || 0) + 1; return a;
}, {});
const constructedOnly = rows.filter((r) => r.kind === 'factory return' || r.kind === 'driver surface');

const shown = filter ? rows.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase())) : rows;
for (const r of shown) console.log(`${r.kind.padEnd(14)}  ${r.module.padEnd(46)}  ${r.name}`);

console.error('');
for (const [k, v] of Object.entries(counts)) console.error(`  ${k.padEnd(14)} ${v}`);
const callable = (counts['module export'] || 0) + constructedOnly.length;
if (callable > 0) {
  const pct = (constructedOnly.length / callable * 100).toFixed(0);
  console.error(`  ⇒ ${pct}% of the callable surface is reachable ONLY by constructing`);
}
console.error(`  sandbox HOME was ${sandbox} (removed) — this tool wrote nothing under your real HOME`);
fs.rmSync(sandbox, { recursive: true, force: true });

// ⛔ THE VACUITY GUARD, AND IT IS ON THE TOOL ITSELF.
// If this ever reports zero factory returns it has SILENTLY BECOME THE GREP IT
// REPLACES — same answers, same blind spot, nothing visibly wrong. A loader
// change, a rename, a walk that stops matching: all present as a clean run over
// a smaller surface.
if (constructedOnly.length === 0) {
  console.error('');
  console.error('⛔ ZERO factory-return members found. This tool has become the grep it replaces:');
  console.error('   same answers, same blind spot, and nothing about the output would say so.');
  console.error('   Refusing to report a surface it cannot see.');
  process.exit(1);
}
