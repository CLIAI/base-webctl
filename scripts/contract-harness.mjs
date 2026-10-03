#!/usr/bin/env node
// contract-harness.mjs — the checks every consumer contract was copying.
//
// ⛔ WHY THIS EXISTS: A DEFECTIVE CONTRACT REPORTS GREEN.
//
// Every other duplication in this family fails loudly. This one fails by
// reassuring us. Three defects have been found in three lanes' copies, at three
// different AGES, and two of the three were found by someone looking ACROSS
// copies rather than by any lane reading its own:
//
//   * a re-vendor check `grep -q "$BASE_DIR" lib/client-config.js` that matched
//     the string inside the SHIM'S OWN COMMENT, and so returned PASS across a
//     genuine re-vendor. A check its own documentation satisfies is not a check.
//   * `[ "$rc" = "2" ] && { … }` as an arm's last statement, returning 1 under
//     `set -e` — so a GREEN suite exits 1. Invisible in the lane it was copied
//     from, because that lane had no suite; fires on the copier's first
//     passing test, and reads as "the tests broke the base adoption".
//   * naming the pin from the submodule WORKTREE rather than the committed
//     gitlink — 4 of 5 contracts — which is worst under the release gate,
//     because the gate is the thing that makes the two differ.
//
// ⇒ And the pin check in the most-corrected contract now carries THREE layers
// of correction commentary, each fixing the previous keying. That is the
// artifact being copy-pasted into every new lane.
//
// ⛔ A LIBRARY FIXES FUTURE DUPLICATION AND NOT THE COPIES ALREADY OUT THERE —
// and you cannot find those by diffing, because rot and legitimate per-lane
// customisation look identical in a diff. Hence GENERATION below: a sweep asks
// "who is below N?" instead of "who differs?".
//
// ⚠ AND A GENERATION MARKER IS NOT ENOUGH ON ITS OWN. It says an old copy
// carries old rot. It does NOT say that a CORRECT copy's assumptions have
// expired against a newer pin — a fallback that was right when written becomes
// a guaranteed false RED when the world moves past it. Two mechanisms.
//
// Usage:
//   node <base>/scripts/contract-harness.mjs generation
//   node <base>/scripts/contract-harness.mjs require-generation 5    # the floor; ANY non-zero = FAIL
//   node <base>/scripts/contract-harness.mjs pin         --repo . --sub vendor/base-webctl
//   node <base>/scripts/contract-harness.mjs no-revendor --repo . --sub vendor/base-webctl
//
// Exit: 0 pass · 1 fail · 2 NO VERDICT (reason printed as its last line) · 3 usage
//
// ⇒ THE HARNESS OWNS THE EXIT CODE so a contract never re-implements the
// `[ "$rc" = 2 ]` handling that has already bitten one lane.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * ⭐ THE GENERATION MARKER. Bump when a check's BEHAVIOUR changes, never for
 * wording. A consumer records the generation it was written against; a sweep
 * then asks "who is below N?" rather than diffing five divergent copies.
 */
export const HARNESS_GENERATION = 5;

/**
 * ⚠ NOT BUMPED BY `gate-probe`, DELIBERATELY. The marker answers "who is
 * carrying old ROT?" — a purely ADDITIVE verb creates none, so bumping would
 * declare every existing copy stale and send five lanes looking for a defect
 * that is not there. ⇒ A version marker that cries wolf stops being read, which
 * would cost exactly the sweep it exists to enable.
 */

const EXIT = Object.freeze({ pass: 0, fail: 1, noVerdict: 2, usage: 3 });

/** @param {string[]} args @param {string} name */
function opt(args, name, dflt = '') {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

/** @param {string[]} a @param {string} cwd */
function git(a, cwd) {
  try {
    return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/**
 * @param {string} check @param {number} code @param {string} reason
 * @param {Record<string, any>} [extra]
 */
function report(check, code, reason, extra = {}) {
  const result = code === EXIT.pass ? 'pass' : code === EXIT.fail ? 'fail' : 'no-verdict';
  // JSONL on stdout (lszd); the human line on stderr, so a machine reader is
  // never parsing prose.
  process.stdout.write(`${JSON.stringify({
    type: 'contract-check', check, result, generation: HARNESS_GENERATION, reason, ...extra,
  })}\n`);
  const tag = { pass: 'PASS', fail: 'FAIL', 'no-verdict': 'NO VERDICT' }[result];
  process.stderr.write(`${tag}  ${check}: ${reason}\n`);
  return code;
}

// ── pin ───────────────────────────────────────────────────────────────────────
/**
 * Report the pin, and assert it is an exact tag.
 *
 * ⛔ THE DECLARED GITLINK, NOT THE WORKTREE. `git -C <sub> describe` names what
 * is CHECKED OUT; the pin a sibling gets when it clones is the gitlink
 * committed in the parent. They differ exactly when the release gate has
 * swapped the submodule — which is the moment a contract is most likely to
 * report a tag its own repo does not declare.
 *
 * ⛔ AND THE CARVE-OUT IS KEYED ON `WEBCTL_DECLARED_PIN`, NOT ON
 * `WEBCTL_BASE_DIR`. The directory variable is a PROXY: the gate sets it on
 * every run, so keying the skip on it skips a computable check every time. The
 * gate exporting the declared pin is the actual signal, and it is the one the
 * gate can supply precisely because the swap takes it away. (FOUR people have
 * keyed this carve-out four different ways, each fixing the last; the fourth
 * blocked a release.)
 *
 * ⛔ GATE-PROVIDED ENV IS INDEPENDENT OF YOUR PIN — and misreading this is the
 * likely CAUSE of the four. One lane deferred reading `WEBCTL_DECLARED_PIN`
 * "until I bump, since v0.5.0 does not export it". ⇒ But it is not exported by
 * the pinned LIBRARY at all: it is set by the GATE PROCESS in your contract's
 * environment at runtime. **A lane on any pin, however old, receives it.**
 * There was never a version reason to skip it.
 *
 * ⭐ JUDGEMENT IS SEPARATE FROM REPORTING so that `gate-probe` can assert on
 * THE SAME VERDICT this function produces. A probe that re-derived the verdict
 * would be a second implementation, and two implementations agreeing proves
 * only that they agree.
 *
 * @param {string} repo @param {string} sub
 * @returns {{code: number, reason: string, extra: Record<string, any>}}
 */
function judgePin(repo, sub) {
  const declaredEnv = process.env.WEBCTL_DECLARED_PIN || '';
  // ⚠ Only a mode-160000 COMMIT entry is a gitlink. `ls-tree` on a plain vendored
  // DIRECTORY prints a TREE sha in the same field, and reading field 2 regardless
  // judged a tree as if it were a declared pin.
  const [mode, type, sha] = git(['ls-tree', 'HEAD', sub], repo).split(/\s+/);
  const gitlink = mode === '160000' && type === 'commit' ? (sha || '') : '';
  const worktree = git(['rev-parse', 'HEAD'], path.join(repo, sub));

  if (!gitlink && !worktree) {
    return { code: EXIT.noVerdict, extra: {},
      reason: `no submodule found at '${sub}' — this contract cannot judge a pin that is not mounted` };
  }
  if (!gitlink) {
    // ⛔ UNDECLARED is its own verdict. The worktree used to stand in for the
    // missing declaration — `gitlink || worktree` — and was then reported as
    // "declared gitlink … is tag", a declaration nobody made. A sibling cloning
    // this repo gets no base at all.
    return { code: EXIT.fail,
      reason: `UNDECLARED: '${sub}' has a checkout (${worktree.slice(0, 7)}) but no committed gitlink. `
        + 'A sibling cloning this repo gets no pin; commit the submodule.',
      extra: { declared: null, worktree } };
  }
  if (!worktree) {
    return { code: EXIT.noVerdict, extra: { declared: gitlink },
      reason: `the gitlink ${gitlink.slice(0, 7)} is declared but '${sub}' is not checked out `
        + '(git submodule update --init); nothing runs against it here' };
  }

  // ⛔ THE ONLY SWAP SIGNAL IS `WEBCTL_GATE_SWAPPED=1`. Since v0.24 the gate sets
  // WEBCTL_DECLARED_PIN on EVERY run, swapped or not — it is a DECLARATION, not a
  // swap. Generation 3 keyed the carve-out on "declared != worktree", so real drift
  // under a gate run that had NOT swapped (`SWAPPED=0`) read as "the release gate has
  // swapped this submodule" — NO VERDICT, a false statement, and the drift passed.
  // (Raised from `fetlife`'s adoption; measured in base's own gen 3 before fixing.)
  if (process.env.WEBCTL_GATE_SWAPPED === '1' && !declaredEnv) {
    // ⚠ An INCONSISTENT signal: a swap with no declared pin. The gate never produces it
    // (gate-probe flags it as a gate defect); a test that scrubs DECLARED_PIN but not
    // SWAPPED does — measured in a lane's fixture under the gate. Say THAT, rather
    // than "the release gate has swapped (declared , …)", which reads as a swap.
    return { code: EXIT.noVerdict, extra: { declared: null, worktree },
      reason: 'INCONSISTENT gate signal: WEBCTL_GATE_SWAPPED=1 but WEBCTL_DECLARED_PIN is empty. '
        + 'A test that scrubs the gate\'s variables must scrub BOTH (and WEBCTL_BASE_DIR); '
        + 'a gate never sends one without the other.' };
  }
  const swapped = process.env.WEBCTL_GATE_SWAPPED === '1' && declaredEnv !== worktree;
  if (swapped) {
    // ⇒ A pin check under the gate is a VACUOUS RED: the gate deliberately
    // points at a release candidate, which by definition is not yet tagged.
    // Skipping loudly, with the declared pin named, so the skip is a decision
    // and not a silence.
    return { code: EXIT.noVerdict,
      reason: `the release gate has swapped this submodule (declared ${declaredEnv.slice(0, 7)}, `
        + `worktree ${worktree.slice(0, 7)}). A candidate is not yet tagged, so pin-is-a-tag `
        + 'does not apply; CONTENTS checks still do.',
      extra: { declared: declaredEnv, worktree } };
  }

  if (worktree !== gitlink) {
    // ⛔ DRIFT. With no gate signal nobody swapped this submodule on purpose, so a
    // checkout that differs from the declaration means the suite is about to run
    // against code the repo does not declare. This used to PASS — judging only the
    // gitlink — which is exactly the drift `pin` exists to catch. (Measured by
    // `substack` at v0.22.0: a worktree at another commit, "PASS pin", exit 0.)
    return { code: EXIT.fail,
      reason: `DRIFT: the declared gitlink is ${gitlink.slice(0, 7)} but '${sub}' has `
        + `${worktree.slice(0, 7)} checked out, and no release gate says it swapped it `
        + '(WEBCTL_GATE_SWAPPED is not 1). '
        + 'The suite would run against an undeclared base: git submodule update, or commit the bump.',
      extra: { declared: gitlink, worktree } };
  }

  const pin = gitlink;
  const tag = git(['describe', '--tags', '--exact-match', pin], path.join(repo, sub));
  if (!tag) {
    return { code: EXIT.fail,
      reason: `the declared gitlink ${pin.slice(0, 7)} is not an exact tag. Pin by TAG: a bare `
        + 'commit is not a release and cannot be reasoned about by a sibling.',
      extra: { declared: pin } };
  }
  return { code: EXIT.pass, reason: `declared gitlink ${pin.slice(0, 7)} is tag ${tag}`,
    extra: { declared: pin, tag } };
}

/**
 * `require-generation <N>` — the floor a contract enforces, and the one defence that
 * survives a DOWNGRADE of the submodule.
 *
 * ⛔ The harness lives INSIDE the submodule, so drifting a lane to an older base also
 * downgrades the checker meant to catch the drift (`substack` measured it: a drift
 * control reported `"generation":2` PASS). Base cannot make a lane call this — base's
 * code is what got downgraded. What it can do is make the call FAIL CLOSED on every
 * older harness: those exit 3 (usage) on an unknown VERB. ⇒ A contract treats ANY
 * non-zero from this verb as FAIL; exit 3 here means "the harness predates this verb".
 *
 * Exit 0 when this harness's generation is ≥ N (a warning on stderr when above: the
 * contract may be recording a stale floor), 1 when below, 3 on a bad N.
 * @param {string[]} args
 */
function checkRequireGeneration(args) {
  const raw = args[0];
  if (!raw || !/^[1-9]\d*$/.test(raw) || args.length > 1) {
    process.stderr.write('usage: contract-harness.mjs require-generation <N>   (a positive integer, nothing else)\n');
    return EXIT.usage;
  }
  const need = Number(raw);
  if (HARNESS_GENERATION < need) {
    return report('require-generation', EXIT.fail,
      `harness generation ${HARNESS_GENERATION} is BELOW the required ${need}: the submodule was `
        + 'downgraded or never bumped, and the checks it runs predate fixes your contract relies on',
      { generation: HARNESS_GENERATION, required: need });
  }
  if (HARNESS_GENERATION > need) {
    process.stderr.write(`note: harness generation ${HARNESS_GENERATION} is above the floor ${need}; `
      + 'raise the floor once your contract is re-recorded against it\n');
  }
  return report('require-generation', EXIT.pass,
    `harness generation ${HARNESS_GENERATION} >= required ${need}`,
    { generation: HARNESS_GENERATION, required: need });
}

/** The `pin` verb: judge, then report. @param {string} repo @param {string} sub */
function checkPin(repo, sub) {
  const v = judgePin(repo, sub);
  return report('pin', v.code, v.reason, v.extra);
}

// ── gate-probe ────────────────────────────────────────────────────────────────
/**
 * Assert that `pin` declines a verdict IN THE REAL SWAP STATE.
 *
 * ⛔ WHY THIS VERB EXISTS. The swap arm of `judgePin` — return NO VERDICT when
 * the gate has pointed the submodule at an untagged candidate — was tested only
 * against a FORGED fixture: the disagreement was constructed by hand. ⇒ A forged
 * fixture proves the arm CAN fire. It does not prove it fires in the state the
 * gate actually produces, and the gate is the only place that state exists on
 * demand.
 *
 * ⚠ VACUITY IS THE WHOLE RISK HERE. Outside the swap window this probe MUST NOT
 * report pass: there is nothing to assert, and a pass would mean "the arm works"
 * on the strength of never having tried it. It returns NO VERDICT with the
 * reason instead, every time, including when run by hand.
 *
 * @param {string} repo @param {string} sub
 */
function checkGateProbe(repo, sub) {
  const swappedByGate = process.env.WEBCTL_GATE_SWAPPED === '1';
  const declaredEnv = process.env.WEBCTL_DECLARED_PIN || '';
  const worktree = git(['rev-parse', 'HEAD'], path.join(repo, sub));

  // ⛔ THE PRECONDITION COMES FROM THE GATE, NOT FROM THE COMPARISON UNDER TEST.
  // The first draft of this probe decided "a swap is in effect" by computing
  // `declaredEnv !== worktree` — the SAME comparison judgePin makes — and then
  // asserted that judgePin declines. That assertion was guaranteed true: the
  // branch reporting "pin returned PASS inside a swap window" was UNREACHABLE.
  // ⇒ A check whose precondition and whose assertion read the same input cannot
  // fail. WEBCTL_GATE_SWAPPED is set by the gate, which knows it performed a
  // swap, so the claim about judgePin's own comparison becomes falsifiable.
  if (!swappedByGate) {
    return report('gate-probe', EXIT.noVerdict,
      'WEBCTL_GATE_SWAPPED is not 1, so the release gate has not told us it swapped '
      + 'anything. This probe asserts behaviour that exists only inside the gate\'s swap '
      + 'window; there is nothing to assert here and a PASS would be vacuous.');
  }
  if (!declaredEnv) {
    return report('gate-probe', EXIT.fail,
      'the gate says it SWAPPED (WEBCTL_GATE_SWAPPED=1) but did not hand over '
      + 'WEBCTL_DECLARED_PIN. In that state a contract cannot know its own declared pin '
      + 'at all, which is the exact failure the variable exists to prevent.');
  }
  if (!worktree) {
    return report('gate-probe', EXIT.fail,
      `the gate says it swapped, but there is no submodule worktree at '${sub}' to have `
      + 'swapped. One of the two is wrong, and a contract run in this state is judging nothing.');
  }

  // ⭐ Ask the SAME function the `pin` verb asks — not a re-derivation.
  const v = judgePin(repo, sub);

  if (v.code !== EXIT.noVerdict) {
    const named = { 0: 'PASS', 1: 'FAIL' }[v.code] || String(v.code);
    return report('gate-probe', EXIT.fail,
      `pin returned ${named} although the gate reports a swap in effect (declared `
      + `${declaredEnv.slice(0, 7)}, worktree ${worktree.slice(0, 7)}). It must decline a `
      + 'verdict: a release candidate is not tagged, so a PASS asserts a tag that does not '
      + 'exist and a FAIL blocks every release. '
      + `Its reason was: ${v.reason}`,
      { declared: declaredEnv, worktree, pinCode: v.code });
  }

  // ⚠ The reason TRAVELS AS TEXT (xrl4), so a reader must be able to see both
  // sides. A no-verdict naming neither SHA is a verdict nobody can act on — and
  // it would satisfy a code-only assertion.
  const bothNamed = v.reason.includes(declaredEnv.slice(0, 7))
    && v.reason.includes(worktree.slice(0, 7));
  if (!bothNamed) {
    return report('gate-probe', EXIT.fail,
      'pin declined a verdict, but its reason does not name BOTH the declared pin '
      + `(${declaredEnv.slice(0, 7)}) and the worktree (${worktree.slice(0, 7)}). The reason is `
      + `the only thing that travels; a reader cannot act on it. Reason was: ${v.reason}`,
      { declared: declaredEnv, worktree });
  }

  return report('gate-probe', EXIT.pass,
    'pin declined a verdict inside a gate-reported swap window and named both sides '
    + `(declared ${declaredEnv.slice(0, 7)}, worktree ${worktree.slice(0, 7)})`,
    { declared: declaredEnv, worktree });
}

// ── no-revendor ───────────────────────────────────────────────────────────────
/**
 * Assert no local file shadows a base module.
 *
 * ⛔ ASSERTS CODE, NEVER PROSE. The check this replaces grepped for the vendor
 * PATH and matched the string inside the shim's own explanatory comment — so it
 * returned PASS across a genuine re-vendor. ⇒ The source is LEXED (lexJs), and
 * the assertion is about an import SPECIFIER token and about a local definition,
 * both of which are code — never text in a comment, string or template.
 *
 * ⚠ VACUITY: examining zero shims FAILS. A repo whose lib/ moved, or whose
 * pattern stopped matching, otherwise reports "no re-vendoring found" over
 * nothing at all — which is the shape that let the original grep pass.
 *
 * @param {string} repo @param {string} sub @param {string} libDir
 */
function checkNoRevendor(repo, sub, libDir) {
  const baseLib = path.join(repo, sub, 'lib');
  if (!fs.existsSync(baseLib)) {
    return report('no-revendor', EXIT.noVerdict, `no base lib at '${sub}/lib' to compare against`);
  }

  const baseFiles = walkJs(baseLib);
  // ⛔ ZERO BASE MODULES IS NOT A PASS — the comparison set is gone.
  if (baseFiles.length === 0) {
    return report('no-revendor', EXIT.fail,
      `found ZERO modules under '${sub}/lib'. This check has lost its comparison set, `
      + 'which is not the same as finding no re-vendoring.');
  }

  /** @type {Map<string,string>} normalised hash -> base path */
  const byHash = new Map();
  /**
   * basename -> EVERY base module carrying it. ⚠ A list, not one path: base has
   * both `lib/index.js` and `lib/browser-location/index.js`, and a single-valued
   * map silently kept whichever the walk reached last.
   * @type {Map<string,{rel:string, real:string}[]>}
   */
  const byName = new Map();
  for (const abs of baseFiles) {
    const rel = path.relative(baseLib, abs);
    byHash.set(normHash(fs.readFileSync(abs, 'utf8')), rel);
    const list = byName.get(path.basename(abs)) || [];
    list.push({ rel, real: fs.realpathSync(abs) });
    byName.set(path.basename(abs), list);
  }

  // ⭐ SELF-CONTROL, EVERY RUN: the hash must DISCRIMINATE. A normaliser that
  // collapsed distinct modules to one hash would silently shrink the comparison
  // set — the failure this check exists to avoid, turned on the check itself.
  if (baseFiles.length > 1 && byHash.size < 2) {
    return report('no-revendor', EXIT.fail,
      `the content normaliser collapsed ${baseFiles.length} distinct base modules into `
      + `${byHash.size} hash(es), so it cannot tell files apart. The detector is broken; `
      + 'no conclusion about this repo is available.');
  }

  const localDir = path.join(repo, libDir);
  if (!fs.existsSync(localDir)) {
    return report('no-revendor', EXIT.noVerdict, `no local '${libDir}/' to examine`);
  }
  const subAbs = path.resolve(repo, sub);
  const localFiles = walkJs(localDir).filter((f) => !path.resolve(f).startsWith(subAbs + path.sep));

  // ⛔ ZERO FILES EXAMINED IS NOT A PASS.
  if (localFiles.length === 0) {
    return report('no-revendor', EXIT.fail,
      `examined ZERO files under '${libDir}/'. That is this check failing to find its `
      + 'subject, not an absence of re-vendoring.');
  }

  /** realpath of base's top-level barrel, if it has one — see (2b). */
  let baseIndex = '';
  try { baseIndex = fs.realpathSync(path.join(baseLib, 'index.js')); } catch { /* no barrel */ }
  /** @type {string[]} the submodule, lexically and through symlinks */
  const subRoots = [subAbs];
  try { subRoots.push(fs.realpathSync(subAbs)); } catch { /* absent: lexical only */ }

  /** @type {{local:string, base:string, how:string}[]} */
  const found = [];
  for (const abs of localFiles) {
    const rel = path.relative(repo, abs);
    const raw = fs.readFileSync(abs, 'utf8');

    // (1) CONTENT — a copy is a copy under any name, in any directory.
    const hit = byHash.get(normHash(raw));
    if (hit) {
      found.push({ local: rel, base: hit, how: 'identical after normalisation' });
      continue;
    }

    // (2) NAME — for a copy edited after it was taken, which content cannot see.
    //
    // ⭐ THE RULE: a local file whose BASENAME equals that of any base module (at
    // any depth on either side) is a re-vendor UNLESS its code imports, requires
    // or re-exports THAT module — a specifier resolving to a base module of the
    // SAME basename. Directory position is deliberately ignored, so moving a copy
    // does not hide it. ⇒ A shim is identified by WHAT IT WRAPS, never by whether
    // it touches base at all.
    //
    // ⛔ THE PREVIOUS RULE EXCUSED ANY FILE THAT IMPORTED ANYTHING FROM BASE's lib.
    // An edited copy of a base module imports that module's SIBLINGS — the copy
    // of cdp-client.js requires base's cdp-rewrite.js, exactly as base's own
    // cdp-client.js does — so the realistic re-vendor was the case the excuse
    // fired on. Measured 2026-10-03 (`substack`): a stale 237-line local
    // lib/cdp-client.js reported PASS, "none is a copy by content or by name".
    //
    // ⭐ TWO NARROW EXCEPTIONS, both requiring that the file DEFINES NOTHING (no
    // function, class, arrow or method — see moduleFacts), because a file with
    // no code of its own cannot be an edited copy of anything:
    //   (2a) it imports base's top-level lib/index.js — base's own house rule is
    //        that consumers import ONLY that barrel, so a pure re-export through
    //        it (`module.exports = require('…/lib/index.js').cdpClient`) is the
    //        sanctioned shape, not a bypass;
    //   (2b) it is a local `index.js` whose every specifier is a RELATIVE path
    //        resolving OUTSIDE the submodule — the consumer's own barrel, which
    //        shares base's barrel's name and nothing else.
    // ⛔ A file that imports base's index.js AND defines code is still judged by
    // the main rule: the barrel reaches every sibling, so a copy can import it.
    const named = byName.get(path.basename(abs));
    if (named) {
      const facts = moduleFacts(raw);
      const reals = facts.specifiers.map((s) => resolveSpec(abs, s));
      const want = new Set(named.map((n) => n.real));
      const wraps = reals.some((r) => r && want.has(r));
      const barrelShim = !facts.defines && baseIndex !== '' && reals.includes(baseIndex);
      const localBarrel = path.basename(abs) === 'index.js' && !facts.defines
        && facts.specifiers.length > 0
        && facts.specifiers.every((s, k) => s.startsWith('.')
          && !insideAny(reals[k] || path.resolve(path.dirname(abs), s), subRoots));
      if (!wraps && !barrelShim && !localBarrel) {
        found.push({
          local: rel,
          base: named.map((n) => n.rel).join(' | '),
          how: `same module name, and it does not import base's own ${named.map((n) => `lib/${n.rel}`).join(' or ')}`,
        });
      }
    }
  }

  if (found.length > 0) {
    return report('no-revendor', EXIT.fail,
      `${found.length} local file(s) re-vendor base: `
      + found.map((f) => `${f.local} <- lib/${f.base} (${f.how})`).join('; ')
      + '. The submodule is bypassed. ⇒ Delete the copy and import base; or make the file a '
      + 'shim that imports its same-named base module (importing a DIFFERENT base module does '
      + 'not count: a copy imports its siblings too), or a pure re-export through base\'s '
      + 'lib/index.js that defines no function or class of its own; or, if this is an '
      + 'unrelated module that only shares a name with base\'s, rename it.',
      { found, examined: localFiles.length, baseModules: baseFiles.length });
  }
  return report('no-revendor', EXIT.pass,
    `${localFiles.length} local file(s) examined against ${baseFiles.length} base module(s); `
    + 'none is a normalised-content copy of a base module, and every file NAMED like a base '
    + 'module imports that same base module, or defines nothing and only re-exports base\'s '
    + 'lib/index.js or (as a local index.js) local modules. ⚠ NOT covered: an EDITED copy '
    + 'under a DIFFERENT name is not detected by this check (whole-file hashing cannot see '
    + 'it); and a same-named file that does import its base module is treated as a wrapper, '
    + 'however much else it defines.',
    { examined: localFiles.length, baseModules: baseFiles.length });
}

/**
 * Resolve a module specifier from local file `abs` to a realpath, or '' when it
 * is not resolvable here.
 *
 * Only RELATIVE or ABSOLUTE specifiers are resolved — the form every consumer
 * uses. A bare specifier (a package name, an import map) is not resolved, so it
 * excuses nothing: the check fails CLOSED, with a FAIL that names the file.
 *
 * @param {string} abs @param {string} s @returns {string}
 */
function resolveSpec(abs, s) {
  if (!(s.startsWith('.') || path.isAbsolute(s))) return '';
  const p = path.resolve(path.dirname(abs), s);
  for (const cand of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, path.join(p, 'index.js')]) {
    try {
      if (fs.statSync(cand).isFile()) return fs.realpathSync(cand);
    } catch { /* next candidate */ }
  }
  return '';
}

/** @param {string} p @param {string[]} roots */
function insideAny(p, roots) {
  return roots.some((r) => p === r || p.startsWith(r + path.sep));
}

// ── a small JS lexer: what is CODE, what is a comment, what is a string ────────
//
// ⛔ "COMMENTS STRIPPED" WAS WHOLE-LINE `//` ONLY. A copy ending in
// `// forked from require('…/cdp-client.js')`, or carrying the same text inside
// a string literal, PASSED: a regex over the remaining text found the specifier
// in prose. Measured in review, 2026-10-03, exit 0 on both. ⇒ Specifiers are
// now read from TOKENS: a string literal counts only in a module-syntax
// position, and comments / other strings / template text are never searched.
// Zero dependencies, so this is a lexer, not a parser — its limits are stated
// at moduleFacts and in DEV_NOTES.

/** @typedef {{k:'id'|'str'|'tpl'|'re'|'num'|'p', v:string}} Tok */

/** Keywords after which `/` starts a regex rather than a division. */
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Tokenise `src`: strings (' " and templates, with `${…}` nesting), regex
 * literals, comments (line, trailing and block — all dropped), identifiers,
 * numbers, punctuation. Also returns the source with every comment replaced by
 * a space, which is what the content hash reads.
 *
 * @param {string} src @returns {{toks: Tok[], code: string}}
 */
function lexJs(src) {
  /** @type {Tok[]} */
  const toks = [];
  let code = '';
  const n = src.length;
  let i = 0;
  if (src.startsWith('#!')) { const e = src.indexOf('\n'); i = e < 0 ? n : e; }
  /** brace depths at which an open `${` will close */
  /** @type {number[]} */
  const tpl = [];
  let depth = 0;

  const regexAllowed = () => {
    const t = toks[toks.length - 1];
    if (!t) return true;
    if (t.k === 'id') return REGEX_AFTER.has(t.v);
    if (t.k === 'p') return !(t.v === ')' || t.v === ']' || t.v === '}');
    return false;
  };
  /** Scan template text from `i` to the closing backtick or the next `${`. */
  const tplChunk = () => {
    const s = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; return { text: src.slice(s, i), open: false }; }
      if (c === '$' && src[i + 1] === '{') { i += 2; return { text: src.slice(s, i), open: true }; }
      i++;
    }
    return { text: src.slice(s), open: false };
  };
  /** @param {string} lead */
  const template = (lead) => {
    const r = tplChunk();
    code += lead + r.text;
    toks.push({ k: 'tpl', v: r.text });
    if (r.open) tpl.push(depth);
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i); i = e < 0 ? n : e; code += ' '; continue;
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; code += ' '; continue;
    }
    if (/\s/.test(c)) { code += c; i++; continue; }
    if (c === '"' || c === "'") {
      const s = i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      const closed = src[i] === c;
      if (closed) i++;
      const lit = src.slice(s, i);
      code += lit;
      toks.push({ k: 'str', v: lit.slice(1, closed ? -1 : undefined) });
      continue;
    }
    if (c === '`') { i++; template('`'); continue; }
    if (c === '}' && tpl.length && tpl[tpl.length - 1] === depth) {
      tpl.pop(); i++; template('}'); continue;
    }
    if (c === '/' && regexAllowed()) {
      const s = i++;
      let cls = false;
      while (i < n && src[i] !== '\n') {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (cls) { if (ch === ']') cls = false; } else if (ch === '[') cls = true;
        else if (ch === '/') { i++; break; }
        i++;
      }
      while (i < n && /[A-Za-z]/.test(src[i])) i++;
      code += src.slice(s, i);
      toks.push({ k: 're', v: src.slice(s, i) });
      continue;
    }
    if (/[A-Za-z_$#\u0080-￿]/.test(c)) {
      const s = i++;
      while (i < n && /[\w$\u0080-￿]/.test(src[i])) i++;
      code += src.slice(s, i);
      toks.push({ k: 'id', v: src.slice(s, i) });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
      const s = i++;
      while (i < n && /[\w.]/.test(src[i])) i++;
      code += src.slice(s, i);
      toks.push({ k: 'num', v: src.slice(s, i) });
      continue;
    }
    // `...` is ONE token: read as three dots, `...require('x')` looks like `.require`.
    const p = c === '=' && d === '>' ? '=>' : src.startsWith('...', i) ? '...' : c;
    if (p === '{') depth++;
    if (p === '}') depth--;
    i += p.length;
    code += p;
    toks.push({ k: 'p', v: p });
  }
  return { toks, code };
}

/** Keywords that take `( … ) {` without that being a method definition. */
const PAREN_BLOCK = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'await']);

/**
 * The two facts no-revendor needs about a module, read from TOKENS:
 *
 * * `specifiers` — string literals in a module-syntax position ONLY:
 *   `… from '<s>'` inside an `import`/`export {…}|*` clause, `import '<s>'`,
 *   `import('<s>')` and `require('<s>')` (not `x.require`, and only when the
 *   argument is that one literal). ⇒ Text inside a comment, inside another
 *   string, or inside a template is never a specifier.
 * * `defines` — the file contains a `function`, `class`, `=>`, or a method
 *   shorthand `name(…) {`. A false positive here fails CLOSED (the file is not
 *   excused), which is the safe direction.
 *
 * ⚠ Limits: a lexer, not a parser. A regex literal after `)` or `}` is read as
 * division; a shadowed `require` is still taken as require.
 *
 * @param {string} src @returns {{specifiers: string[], defines: boolean}}
 */
function moduleFacts(src) {
  const { toks } = lexJs(src);
  /** @param {number} j @param {string} v */
  const is = (j, v) => j >= 0 && j < toks.length && toks[j].k !== 'str' && toks[j].k !== 'tpl'
    && toks[j].v === v;
  /** @type {string[]} */
  const specifiers = [];
  let defines = false;
  /** inside an `import …` / `export {…}|*` clause, where `from '<s>'` is real */
  let clause = false;
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j];
    const dotted = is(j - 1, '.');
    if (t.k === 'id' && !dotted && t.v === 'import' && !is(j + 1, '(') && !is(j + 1, '.')) {
      clause = true;
      if (toks[j + 1] && toks[j + 1].k === 'str') specifiers.push(toks[j + 1].v);
      continue;
    }
    if (t.k === 'id' && !dotted && t.v === 'export') {
      clause = is(j + 1, '{') || is(j + 1, '*');
      continue;
    }
    if (t.k === 'str' && clause && is(j - 1, 'from')) { specifiers.push(t.v); clause = false; continue; }
    if (clause && !(t.k === 'id' || t.k === 'str' || (t.k === 'p' && '{},*'.includes(t.v)))) {
      clause = false;
    }
    if (t.k === 'str' && is(j - 1, '(') && !is(j - 3, '.')
      && (is(j - 2, 'require') ? is(j + 1, ')') : is(j - 2, 'import') && (is(j + 1, ')') || is(j + 1, ',')))) {
      specifiers.push(t.v);
    }
    if (t.k === 'id' && !dotted && (t.v === 'function' || t.v === 'class')) defines = true;
    if (t.k === 'p' && t.v === '=>') defines = true;
    if (t.k === 'p' && t.v === '(' && j > 0 && toks[j - 1].k === 'id' && !dotted
      && !is(j - 2, '.') && !PAREN_BLOCK.has(toks[j - 1].v)) {
      let lvl = 0;
      let k = j;
      for (; k < toks.length; k++) {
        if (is(k, '(')) lvl++;
        else if (is(k, ')') && --lvl === 0) break;
      }
      if (is(k + 1, '{')) defines = true;
    }
  }
  return { specifiers, defines };
}

/**
 * Every .js/.mjs/.cjs under `dir`, RECURSIVELY.
 *
 * ⛔ THE OLD VERSION USED readdirSync AND SAW ONLY THE TOP LEVEL — while HALF of
 * base's own lib is nested (12 flat, 12 under lib/browser-location/). So the names
 * of profile-lock.js, mounts.js and chromium-docker-xpra.js were not even in the
 * comparison set, and a consumer could copy any of them to its own top level and
 * PASS. Measured 2026-09-27: three planted re-vendors — nested→flat, into a
 * subdirectory, and renamed in place — ALL reported `pass`, with the reason
 * "3 local file(s) examined; none shadows a base module".
 *
 * @param {string} dir @returns {string[]}
 */
function walkJs(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      out.push(...walkJs(abs));
    } else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(abs);
  }
  return out;
}

/**
 * Hash of the NORMALISED code: comments stripped, whitespace collapsed. ⇒ A copy
 * is still recognised after reformatting or re-commenting, which is what a
 * re-vendor looks like once someone has "adapted" it.
 *
 * ⭐ Comments are stripped by the SAME lexer the specifier test uses, so a
 * TRAILING comment added to a copy is stripped too (the old line filter kept
 * it, and the copy hashed differently). Both sides go through this function, so
 * the hash stays symmetric.
 * @param {string} src
 */
function normHash(src) {
  return createHash('sha256').update(lexJs(src).code.replace(/\s+/g, ' ').trim()).digest('hex');
}


// ── entry ─────────────────────────────────────────────────────────────────────
const [, , cmd, ...args] = process.argv;
const repo = path.resolve(opt(args, 'repo', '.'));
const sub = opt(args, 'sub', 'vendor/base-webctl');
const libDir = opt(args, 'lib', 'lib');

let code;
switch (cmd) {
  case 'generation':
    if (args.length) {
      // ⛔ `generation --min N` was proposed — and every harness before this one
      // IGNORES unknown flags: generation 2 printed "generation 2", exit 0, for
      // `generation --min 3`. A floor spelled as a flag fails OPEN on exactly the
      // downgraded harness it exists to catch. Refused here so nobody adopts it.
      process.stderr.write('generation takes no arguments. To enforce a floor use the VERB: '
        + 'require-generation <N> — an unknown verb exits 3 on every older harness, so it fails closed.\n');
      code = EXIT.usage; break;
    }
    process.stdout.write(`${JSON.stringify({ type: 'harness', generation: HARNESS_GENERATION })}\n`);
    process.stderr.write(`contract-harness generation ${HARNESS_GENERATION}\n`);
    code = EXIT.pass; break;
  case 'require-generation': code = checkRequireGeneration(args); break;
  case 'pin': code = checkPin(repo, sub); break;
  case 'no-revendor': code = checkNoRevendor(repo, sub, libDir); break;
  case 'gate-probe': code = checkGateProbe(repo, sub); break;
  default:
    process.stderr.write(
      'usage: contract-harness.mjs <generation|require-generation N|pin|no-revendor|gate-probe> [--repo D] [--sub P] [--lib D]\n'
      + '⇒ exit 0 pass · 1 fail · 2 no verdict (reason on the last line) · 3 usage\n');
    code = EXIT.usage;
}
process.exit(code);
