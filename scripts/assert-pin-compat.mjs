#!/usr/bin/env node
// assert-pin-compat.mjs — REFUSE a base pin that cannot serve this consumer's
// actual configuration. Run from a consumer's ./test-against-base.sh.
//
// WHY THIS EXISTS. A changelog reaches the reader DECIDING to bump. It cannot
// reach the reader who ALREADY bumped: a consumer that pins v0.6.0 checks out
// v0.6.0's files, which do not contain v0.6.0's later caveats — the entry
// warning them was written after the tag. Those are two different readers
// needing two different mechanisms, and only one of them is a document.
//
// So this is the caveat as an ASSERTION rather than a paragraph. A warning
// someone has to read and remember is worth less than a condition the tool
// detects and refuses.
//
// ⭐ IT PROBES CAPABILITY, NOT VERSION. It does not parse tags, compare semver,
// or carry a table of bad releases — all of which go stale and none of which
// work for a bare-commit pin. It asks the PINNED base to derive the ports for
// the consumer's real configured CDP port, and checks whether the answer is
// possible. A base that returns an impossible port fails; a base that refuses
// (because it carries the fix) passes. That stays correct for pins that do not
// exist yet, and for the reverse case of a consumer ahead of this script.
//
// SCOPED NARROWLY ON PURPOSE. It says nothing at all unless THIS consumer's
// configured port is actually affected. A consumer on 4327 or 4877 is
// unaffected by any of this and should see silence — warning everyone about a
// hazard that touches 100 ports out of 64512 is how a real signal gets tuned
// out.
//
// Usage:
//   node <base>/scripts/assert-pin-compat.mjs --cdp-port 4877 [--base-dir DIR]
//
// --base-dir defaults to $WEBCTL_BASE_DIR, then ./vendor/base-webctl.
// Exit: 0 compatible (or not applicable) · 1 REFUSED · 2 could not check.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
/** @param {string} flag */
function arg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const cdpPortRaw = arg('--cdp-port') ?? process.env.WEBCTL_CDP_PORT;
const baseDir = path.resolve(
  arg('--base-dir') || process.env.WEBCTL_BASE_DIR || 'vendor/base-webctl',
);

if (!cdpPortRaw) {
  console.error('assert-pin-compat: --cdp-port is required (or set WEBCTL_CDP_PORT)');
  console.error('  Pass the port THIS consumer is actually configured to use.');
  process.exit(2);
}
const cdpPort = Number(cdpPortRaw);
if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
  console.error(`assert-pin-compat: --cdp-port ${cdpPortRaw} is not a valid port`);
  process.exit(2);
}

const ccPath = path.join(baseDir, 'lib', 'client-config.js');
if (!existsSync(ccPath)) {
  // Name the resolved path, always (xrl4 "Gate validity").
  console.error(`assert-pin-compat: cannot check — no client-config.js at ${ccPath}`);
  console.error('  Pass --base-dir, or set WEBCTL_BASE_DIR, or init the submodule.');
  process.exit(2);
}

const MAX_PORT = 65535;

/** Minimal constants: only what deriveXpraPorts actually reads. */
const C = {
  PROJECT: 'pin-compat-probe',
  ARTIFACT_PREFIX: 'pin-compat-probe-',
  IMAGE_CHROMIUM_REPO: 'probe/chromium',
  IMAGE_XPRA: 'probe/xpra:latest',
  DEFAULT_CDP_PORT: cdpPort,
  CACHE_DIRNAME: 'pin-compat-probe',
  ZOOM_DEFAULT_HOST: 'probe.invalid',
  CONFIG_FILE_PROJECT: 'probe.config.jsonc',
  DOTENV_FILENAME: '.env.probe',
  DOTENV_TEMPLATE: '.env.probe.example',
  ENV_PREFIX: 'WEBCTL_PIN_COMPAT_PROBE_',
  ENV_PREFIX_LEGACY: null,
  ENV_LEGACY_SUFFIXES: [],
};

let derived;
try {
  const mod = await import(pathToFileURL(ccPath).href);
  const cc = mod.createClientConfig(C, { assert: false });
  derived = cc.deriveXpraPorts(cdpPort, {});
} catch (err) {
  // A base carrying the fix REFUSES an impossible derivation — that is the
  // correct behaviour, and from here it is indistinguishable from success:
  // either way this consumer will not be handed a port that cannot exist.
  const msg = String((err && err.message) || err);
  if (/exceeds the maximum port/i.test(msg)) process.exit(0);
  console.error(`assert-pin-compat: cannot check — probing ${ccPath} failed: ${msg}`);
  process.exit(2);
}

const bad = [];
if (derived.xpraTcpPort > MAX_PORT) bad.push(['xpra-tcp', derived.xpraTcpPort]);
if (derived.xpraHtml5Port > MAX_PORT) bad.push(['xpra-html5', derived.xpraHtml5Port]);

if (bad.length === 0) process.exit(0); // silent: this consumer is unaffected

console.error('REFUSED: this base pin cannot serve this consumer\'s configured port.\n');
console.error(`  base pin:  ${baseDir}`);
console.error(`  CDP port:  ${cdpPort}`);
for (const [role, value] of bad) {
  console.error(`  ${role.padEnd(10)} derives ${value}, which exceeds the maximum port ${MAX_PORT}`);
}
console.error(
  '\n  This pin derives a port that CANNOT EXIST, and older pins return it\n' +
  "  silently with sources:{tcp:'derived'} — indistinguishable from a valid\n" +
  '  answer — so the failure would surface later as an unrelated bind error.\n',
);
console.error('  Fix, in order of preference:');
console.error('    1. Move the pin to a base that refuses the derivation (>= v0.7.0).');
console.error('    2. Set "xpraTcpPort" explicitly; that bypasses derivation entirely');
console.error('       and keeps a high CDP port usable.');
console.error('    3. Choose a CDP port below 65436.');
process.exit(1);
