// require-esm-from-cjs.test.cjs — base's NO-TOP-LEVEL-AWAIT guarantee, enforced.
//
// WHY THIS TEST EXISTS
// --------------------
// Consumers are CJS. They adopt base by keeping their own `lib/<module>.js`
// path stable and making it a one-line re-export shim (sb7q, xrl4):
//
//     module.exports = require('../vendor/base-webctl/lib/<module>.js');
//
// That one line only works because Node >=22.12 can `require()` an ES module
// SYNCHRONOUSLY -- and it can do that only while the ESM graph contains NO
// TOP-LEVEL AWAIT. A single `await` at module scope, anywhere in the imported
// graph, makes Node throw ERR_REQUIRE_ASYNC_MODULE and breaks EVERY consumer's
// shim at once. base therefore guarantees no top-level await.
//
// Until now that guarantee lived in 8 source comments and 5 design docs and was
// enforced NOWHERE -- so any future module could break the whole family's
// adoption path and base's own suite would stay green. This test is the
// enforcement. It is deliberately written as CJS (`.cjs`) because that is the
// consumer's vantage point: it does not model the shim, it IS the shim.
//
// The module list is walked from disk, never hardcoded, so a NEW module is
// covered the moment it lands rather than when someone remembers to add it.
//
// Ref: sb7q "API surface & semver", sm2t "the seam must add no top-level await",
//      xrl4 consumer contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');

/** Every .js module under lib/, recursively, sorted for stable output. */
function walkLib(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walkLib(full);
      return e.name.endsWith('.js') ? [full] : [];
    })
    .sort();
}

const modules = walkLib(LIB);
const rel = (f) => path.relative(LIB, f);

// --- 1. NEGATIVE CONTROL: prove this guard can actually fail ----------------
// Verify BYTES not existence, and make sure a guard test is able to FAIL.
// If Node's behaviour ever changes so that top-level await no longer blocks
// require(), every other assertion in this file becomes vacuous -- and we want
// to be told that, not silently reassured.
test('negative control: top-level await IS detectable via require()', () => {
  const fixture = path.join(__dirname, 'helpers', 'tla-violation.fixture.mjs');
  assert.ok(fs.existsSync(fixture), 'negative-control fixture is missing');

  assert.throws(
    () => require(fixture),
    (err) => {
      assert.equal(
        err.code,
        'ERR_REQUIRE_ASYNC_MODULE',
        `expected ERR_REQUIRE_ASYNC_MODULE, got ${err.code || err.message}. ` +
          'If this changed, this whole guard is vacuous -- fix the detector ' +
          'before trusting any green run of this file.',
      );
      return true;
    },
    'a module with top-level await must NOT be require()-able from CJS',
  );
});

// --- 2. COVERAGE FLOOR: a broken walk must not silently test nothing --------
test('module walk actually finds base lib modules', () => {
  assert.ok(
    modules.length >= 15,
    `walked only ${modules.length} modules under lib/ -- the walk is broken, ` +
      'so the guarantee below would be asserted over an empty set',
  );
  const names = modules.map(rel);
  assert.ok(names.includes('index.js'), 'public entry point lib/index.js not walked');
  assert.ok(
    names.some((n) => n.startsWith('browser-location' + path.sep)),
    'nested lib/browser-location/ modules not walked',
  );
});

// --- 3. THE GUARANTEE: every module is require()-able from CJS --------------
// One subtest per module so a violation names the exact offending file.
test('every lib module is require()-able from CJS (no top-level await)', async (t) => {
  for (const file of modules) {
    await t.test(rel(file), () => {
      let ns;
      try {
        ns = require(file);
      } catch (err) {
        if (err.code === 'ERR_REQUIRE_ASYNC_MODULE') {
          assert.fail(
            `lib/${rel(file)} (or something it imports) uses TOP-LEVEL AWAIT.\n` +
              "This breaks EVERY consumer's one-line CJS shim:\n" +
              "  module.exports = require('../vendor/base-webctl/lib/...')\n" +
              'Remove the top-level await -- move it into a function or a ' +
              'factory (the createX(C) seam, sm2t). See sb7q.',
          );
        }
        throw err;
      }
      assert.equal(typeof ns, 'object', `lib/${rel(file)} did not yield a namespace`);
      assert.ok(ns !== null, `lib/${rel(file)} yielded null`);
    });
  }
});

// --- 4. The public entry point is what consumers actually reach for ---------
test('lib/index.js re-exports the documented surface through require()', () => {
  const api = require(path.join(LIB, 'index.js'));
  // Spot-check across BOTH shapes base ships: plain modules and createX(C)
  // factories. Named explicitly (not derived from the same object) so a
  // dropped export is caught rather than tautologically confirmed.
  for (const name of [
    'dockerCtl',
    'cdpRewrite',
    'localhostDirect',
    'xpraPresence',
    'lruCleanup',
    'systemdTimer',
    'clientConfig',
    'chromiumPrefs',
    'mounts',
    'registry',
    'browserLocation',
    'processMutex',
  ]) {
    assert.ok(name in api, `lib/index.js no longer exports "${name}"`);
    assert.equal(typeof api[name], 'object', `export "${name}" is not a namespace`);
  }

  // The pilot module's two pure functions, reachable the way a consumer gets
  // them. xpra-presence is the convergence pilot (2 functions, ~15 lines).
  assert.equal(typeof api.xpraPresence.parseXpraClients, 'function');
  assert.equal(typeof api.xpraPresence.isXpraClientAttached, 'function');
});
