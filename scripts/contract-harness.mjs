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
    // Every reading's hash: a base module that reads two ways is matched by a
    // copy under either (the copy reads the same two ways).
    for (const h of analyse(fs.readFileSync(abs, 'utf8')).hashes) if (!byHash.has(h)) byHash.set(h, rel);
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
  /** @type {{local:string, lines:number[], why:string}[]} files that read more than one way */
  const ambiguous = [];
  /** @param {number[]} ls */
  const atLines = (ls) => (ls.length ? `line ${ls.slice(0, 5).join(', ')}` : 'no single line');
  for (const abs of localFiles) {
    const rel = path.relative(repo, abs);
    const a = analyse(fs.readFileSync(abs, 'utf8'));
    if (a.ambiguous) ambiguous.push({ local: rel, ...a.ambiguous });

    // (1) CONTENT — a copy is a copy under any name, in any directory. ⇒ For a
    // file that reads more than one way, a match under ANY reading is a copy.
    const hit = a.hashes.map((h) => byHash.get(h)).find(Boolean);
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
    //
    // ⛔ AND AN AMBIGUOUS FILE GETS NO EXCEPTION AT ALL — not the shim excuse, not
    // either barrel excuse. If its readings disagree, at least one of them is a
    // misreading, and every excuse above is a fact read from the tokens.
    const named = byName.get(path.basename(abs));
    if (named && !a.facts) {
      const amb = /** @type {NonNullable<typeof a.ambiguous>} */ (a.ambiguous);
      found.push({
        local: rel,
        base: named.map((n) => n.rel).join(' | '),
        how: `same module name, and it is AMBIGUOUS at ${atLines(amb.lines)}: ${amb.why} — `
          + 'so no shim or barrel exception can be granted',
      });
      continue;
    }
    if (named && a.facts) {
      const facts = a.facts;
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

  // Files that read more than one way but needed no exception (not named like a
  // base module) are still NAMED, so a reader knows what the hash compared.
  const ambNote = ambiguous.length === 0 ? ''
    : ` ⚠ ${ambiguous.length} file(s) read more than one way (`
      + ambiguous.map((x) => `${x.local} ${atLines(x.lines)}`).join('; ')
      + '); every reading\'s hash was compared, and none was granted an exception.';
  if (found.length > 0) {
    const ambAdvice = found.some((f) => f.how.includes('AMBIGUOUS'))
      ? ' ⇒ For an AMBIGUOUS file: simplify the named line so it reads one way only — e.g. '
        + 'assign the regex to a variable first (`const re = /…/;`), or end the block before it with `;`.'
      : '';
    return report('no-revendor', EXIT.fail,
      `${found.length} local file(s) re-vendor base: `
      + found.map((f) => `${f.local} <- lib/${f.base} (${f.how})`).join('; ')
      + '. The submodule is bypassed. ⇒ Delete the copy and import base; or make the file a '
      + 'shim that imports its same-named base module (importing a DIFFERENT base module does '
      + 'not count: a copy imports its siblings too), or a pure re-export through base\'s '
      + 'lib/index.js that defines no function or class of its own; or, if this is an '
      + 'unrelated module that only shares a name with base\'s, rename it.' + ambAdvice + ambNote,
      { found, ambiguous, examined: localFiles.length, baseModules: baseFiles.length });
  }
  return report('no-revendor', EXIT.pass,
    `${localFiles.length} local file(s) examined against ${baseFiles.length} base module(s); `
    + 'none is a normalised-content copy of a base module, and every file NAMED like a base '
    + 'module imports that same base module, or defines nothing and only re-exports base\'s '
    + 'lib/index.js or (as a local index.js) local modules. ⚠ NOT covered: an EDITED copy '
    + 'under a DIFFERENT name is not detected by this check (whole-file hashing cannot see '
    + 'it); and a same-named file that does import its base module is treated as a wrapper, '
    + 'however much else it defines.' + ambNote,
    { ambiguous, examined: localFiles.length, baseModules: baseFiles.length });
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
//
// ⛔ AND THE FIRST LEXER FAILED OPEN. It read every `/` after `)`, `}` or a
// template's `${` as DIVISION, so a regex holding a quote or a backtick there
// opened a PHANTOM string or template. Measured in re-review, 2026-10-03, all
// exit 0: the comment after such a regex was lexed as code, so
// `if (x) /'/.test(a) // ' ; require('<the same base module>')` was a shim; with
// no prose at all, `if (n) /[\`]/.test(n)` hid the file's `function` and `class`
// inside a phantom template, so the file "defined nothing" and the barrel
// exception excused it; and a phantom string KEPT a comment in the content hash,
// so a re-commented copy under a new name escaped. The old comment here called
// this limit a false FAIL. It was a false PASS.
//
// ⇒ Two changes, both in the direction of failing CLOSED:
//   1. PRECISION. A bracket stack: a `)` closing `if`/`while`/`for`/`with` is
//      followed by a regex, every other `)` by division; `${` by a regex; `]`
//      and a postfix `++`/`--` by division. So is every spot where ASI ends a
//      statement (after break/continue/debugger, a label, an uninitialised
//      binding, a module specifier, a prefix `++`): there `/` is a regex.
//      Each of these is decidable from the tokens.
//   2. WHAT IS STILL UNDECIDABLE IS READ BOTH WAYS, NOT GUESSED. A `/` after a
//      `}` (block → regex, object or function expression → division) or after a
//      contextual keyword (`of`, `yield`, `await` — also legal variable names),
//      and an HTML-like comment (`<!--`, or `-->` leading a line: a comment in a
//      CommonJS script, CODE in an ES module), are FORK points. readJs() lexes
//      every combination (capped at MAX_READINGS), drops only readings that are
//      not lexically valid JS, and analyse() trusts a fact only when every
//      remaining reading agrees on it. ⇒ A file whose readings disagree is
//      AMBIGUOUS, and no-revendor grants it no exception.
//
// Zero dependencies, so this is a lexer, not a parser. Its remaining limits, and
// which way each one fails, are listed at analyse() and in DEV_NOTES.

/**
 * `nl`: a line terminator precedes it. `pre`: for `++`/`--`, what a `/` after it starts.
 * @typedef {{k:'id'|'str'|'tpl'|'re'|'num'|'p', v:string, open?:boolean, stmt?:boolean,
 *   nl?:boolean, pre?:'re'|'div'|'fork'}} Tok
 */
/**
 * ONE way of reading a source. `forks` holds the offset of every point at which a
 * second reading was possible; `bad` is set when this reading is not lexically
 * valid JS (an unterminated string, template, comment or regex, bad regex flags,
 * unbalanced brackets) — `bad.forks` is how many forks preceded that point.
 * @typedef {{toks: Tok[], code: string, forks: number[],
 *   bad: null | {at: number, forks: number, why: string}}} Reading
 */

/**
 * Reserved words after which `/` starts a regex. Reserved, so never a variable.
 * ⛔ `break`, `continue` and `debugger` were missing: `/` after one on the SAME
 * line is a syntax error, and after a line break ASI ends the statement, so the
 * `/` starts a regex. Read as division, `break⏎/'/.test(s) // ' ; require(…)`
 * opened a phantom string and counted a require that node treats as a COMMENT
 * (final review, 2026-10-03: a false PASS). `extends` takes an expression.
 */
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'default', 'break', 'continue', 'debugger', 'extends']);
/** `break label⏎/…/` — a label on the break's own line; then the same ASI rule. */
const LABEL_AFTER = new Set(['break', 'continue']);
/**
 * `let x⏎/…/` — a binding with no initializer cannot be continued by `/`, so ASI
 * ends the declaration and the `/` is a regex (on the same line: a syntax error).
 */
const DECL = new Set(['var', 'let', 'const']);
/** ECMAScript line terminators. Node ends a line comment at ANY of them. */
const LT = new Set(['\n', '\r', '\u2028', '\u2029']);
/** Contextual keywords: also legal variable names, so a `/` after one is FORKED. */
const SLASH_CONTEXTUAL = new Set(['of', 'yield', 'await']);
/** Statement heads: the `)` closing their `( … )` is followed by a statement. */
const STMT_PAREN = new Set(['if', 'while', 'for', 'with']);
/** Valid regex flags: each of d g i m s u v y, at most once. */
const REGEX_FLAGS = /^(?!.*(.).*\1)[dgimsuvy]*$/;
// ⛔ Unicode ID_Start / ID_Continue — NOT a blanket \u0080+ range. That range swallowed
// U+2028/U+2029 line terminators, NBSP, BOM and every Zs space INTO identifiers, so
// `break`+NBSP read as one non-keyword word and the ASI-regex rule never fired (final
// re-review; NBSP is common in copy-pasted code). ZWNJ/ZWJ are legal ID_Continue.
const ID_START = /[\p{ID_Start}$_#]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
/** `\uXXXX` / `\u{X…}` — legal inside an identifier, and `require` IS `require`. */
const ID_ESCAPE = /^\\u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/;

/**
 * Read `src` ONE way: strings (' " and templates, with `${…}` nesting), regex
 * literals, comments (line, trailing, block and HTML-like — all dropped),
 * identifiers (escapes decoded), numbers, punctuation. Also returns the source
 * with every comment replaced by whitespace, which is what the content hash reads.
 *
 * At the f-th fork point the reading takes the SECOND branch (regex; HTML-like
 * comment) iff `choices[f]`; past the end of `choices`, the first (division; code).
 *
 * @param {string} src @param {boolean[]} [choices] @returns {Reading}
 */
function lexJs(src, choices = []) {
  /** @type {Tok[]} */
  const toks = [];
  let code = '';
  /** @type {number[]} */
  const forks = [];
  /** @type {Reading['bad']} */
  let bad = null;
  /** @param {number} at @param {string} why */
  const invalid = (at, why) => { if (!bad) bad = { at, forks: forks.length, why }; };
  /** Record a fork point; true = take the second branch. @param {number} at */
  const fork = (at) => { const f = forks.length; forks.push(at); return !!choices[f]; };

  const n = src.length;
  let i = 0;
  /** End of the current line: the next line terminator at or after `from`. @param {number} from */
  const lineEnd = (from = i) => { let e = from; while (e < n && !LT.has(src[e])) e++; return e; };
  if (src.startsWith('#!')) i = lineEnd(2);
  /**
   * True from a line terminator until the next token: nothing but whitespace and
   * comments since the line began. ⇒ A `-->` here leads its line, a `++` here is
   * prefix (ASI), and a token pushed now records `nl` (a break precedes it).
   */
  let lineBlank = true;
  /** Bracket depths at which a var/let/const declaration may still be open. @type {number[]} */
  const decls = [];
  /** @param {Tok} t */
  const push = (t) => { t.nl = lineBlank; lineBlank = false; toks.push(t); };
  /**
   * Open brackets — `(` (stmt: it heads if/while/for/with), `[`, `{`, and a
   * template's `${`, which the next unmatched `}` resumes.
   * @type {{t: string, stmt?: boolean}[]}
   */
  const open = [];
  /** @param {number} back */
  const tok = (back) => toks[toks.length - back];
  /** Is the token `back` from the end preceded by `.`? @param {number} back */
  const dotted = (back) => { const x = tok(back + 1); return !!x && x.k === 'p' && x.v === '.'; };

  /** @returns {'re'|'div'|'fork'} what a `/` here starts */
  const slashKind = () => {
    const t = tok(1);
    if (!t) return 're';
    if (t.k === 'id') {
      if (dotted(1)) return 'div';
      if (REGEX_AFTER.has(t.v)) return 're';
      if (SLASH_CONTEXTUAL.has(t.v)) return 'fork';
      // The token before this identifier: a `break`/`continue` on the same line
      // makes it a label, a var/let/const makes it a binding — ASI either way.
      const h = tok(2);
      if (h && h.k === 'id' && !dotted(2)) {
        if (LABEL_AFTER.has(h.v) && !t.nl) return 're';
        if (DECL.has(h.v)) return 're';
      }
      // `var a = 1, b⏎/…/` is a binding too — but whether the declaration is
      // still open (or ended by ASI lines ago) is a parse question. FORKED.
      if (h && h.k === 'p' && h.v === ',' && decls.length && decls[decls.length - 1] === open.length) return 'fork';
      return 'div';
    }
    if (t.k === 'tpl') return t.open ? 're' : 'div';
    // `import 'x'⏎/…/`, `… from 'x'⏎/…/`: a module specifier ends its declaration.
    if (t.k === 'str') {
      const h = tok(2);
      return h && h.k === 'id' && !dotted(2) && (h.v === 'import' || h.v === 'from') ? 're' : 'div';
    }
    if (t.k !== 'p') return 'div';
    if (t.v === ')') return t.stmt ? 're' : 'div';
    if (t.v === '++' || t.v === '--') return t.pre || 'div';
    if (t.v === ']') return 'div';
    return t.v === '}' ? 'fork' : 're';
  };
  /** End of a regex literal starting at `s`, or -1 when none can. @param {number} s */
  const regexEnd = (s) => {
    let j = s + 1;
    let cls = false;
    for (;;) {
      if (j >= n || LT.has(src[j])) return -1;
      const ch = src[j];
      if (ch === '\\') {
        if (j + 1 >= n || LT.has(src[j + 1])) return -1;
        j += 2; continue;
      }
      if (cls) { if (ch === ']') cls = false; } else if (ch === '[') cls = true;
      else if (ch === '/') break;
      j++;
    }
    const f = ++j;
    while (j < n && ID_PART.test(src[j])) j++;
    return REGEX_FLAGS.test(src.slice(f, j)) ? j : -1;
  };
  /** Scan template text from `i` to the closing backtick or the next `${`. @param {string} lead */
  const template = (lead) => {
    const s = i;
    let closed = false;
    let opened = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; closed = true; break; }
      if (c === '$' && src[i + 1] === '{') { i += 2; opened = true; break; }
      i++;
    }
    if (!closed && !opened) invalid(s, 'unterminated template literal');
    const text = src.slice(s, i);
    code += lead + text;
    push({ k: 'tpl', v: text, open: opened });
    if (opened) open.push({ t: '${' });
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    // ⛔ A line comment ends at ANY line terminator — `\r`, U+2028, U+2029 too.
    // Ended at `\n` only, a CR-only file's `// x⏎function f(){}` hid the function
    // that node defines, so the file "defined nothing" (final review: false PASS).
    if (c === '/' && d === '/') { i = lineEnd(); code += ' '; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) invalid(i, 'unterminated block comment');
      const end = e < 0 ? n : e + 2;
      // Keep its line breaks: a `-->` after a multi-line comment leads a line.
      const breaks = src.slice(i, end).replace(/[^\n\r\u2028\u2029]/g, '');
      if (breaks) lineBlank = true;
      code += ` ${breaks}`;
      i = end; continue;
    }
    // HTML-like comments (ECMA-262 Annex B): a line comment in a CommonJS script,
    // but `<!--` is `< ! --` and `-->` is `-- >` in an ES module. FORKED.
    if ((c === '<' && src.startsWith('<!--', i)) || (c === '-' && lineBlank && src.startsWith('-->', i))) {
      if (fork(i)) { i = lineEnd(); code += ' '; continue; }
    }
    if (/\s/.test(c)) { if (LT.has(c)) lineBlank = true; code += c; i++; continue; }
    if (c === '"' || c === "'") {
      // A string may hold U+2028/U+2029 (ES2019) but ends, unterminated, at `\n` or `\r`.
      const s = i++;
      while (i < n && src[i] !== c && src[i] !== '\n' && src[i] !== '\r') {
        i += src[i] !== '\\' ? 1 : src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
      }
      const closed = src[i] === c;
      if (closed) i++; else invalid(s, 'unterminated string');
      const lit = src.slice(s, i);
      code += lit;
      push({ k: 'str', v: lit.slice(1, closed ? -1 : undefined) });
      continue;
    }
    if (c === '`') { i++; template('`'); continue; }
    if (c === '}' && open.length && open[open.length - 1].t === '${') {
      open.pop(); i++; template('}'); continue;
    }
    if (c === '/') {
      let kind = slashKind();
      // A fork only where a regex could actually end on this line.
      if (kind === 'fork') kind = regexEnd(i) < 0 ? 'div' : fork(i) ? 're' : 'div';
      if (kind === 're') {
        let e = regexEnd(i);
        if (e < 0) { invalid(i, 'unterminated regex literal'); e = lineEnd(); }
        code += src.slice(i, e);
        push({ k: 're', v: src.slice(i, e) });
        i = e; continue;
      }
    }
    if (ID_START.test(c) || (c === '\\' && d === 'u')) {
      const s = i;
      let v = '';
      while (i < n) {
        if (src[i] === '\\') {
          const m = src[i + 1] === 'u' ? ID_ESCAPE.exec(src.slice(i, i + 10)) : null;
          const cp = m ? parseInt(m[1] || m[2], 16) : -1;
          if (!m || cp > 0x10ffff) { invalid(i, 'bad escape in an identifier'); i += 2; continue; }
          v += String.fromCodePoint(cp); i += m[0].length; continue;
        }
        if (!(i === s ? ID_START : ID_PART).test(src[i])) break;
        v += src[i]; i++;
      }
      code += src.slice(s, i);
      if (DECL.has(v) && !dotted(0)) decls.push(open.length);
      push({ k: 'id', v });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
      const s = i++;
      while (i < n && /[\w.]/.test(src[i])) i++;
      code += src.slice(s, i);
      push({ k: 'num', v: src.slice(s, i) });
      continue;
    }
    // `...` is ONE token: read as three dots, `...require('x')` looks like `.require`.
    // `++`/`--` are one token too. A `/` after a POSTFIX one is a division; after
    // a PREFIX one (`a⏎++/'/.lastIndex` — ASI makes it prefix) it is a regex.
    // Prefix exactly where a `/` would start a regex, or after a line break.
    const p = c === '=' && d === '>' ? '=>' : src.startsWith('...', i) ? '...'
      : (c === '+' || c === '-') && d === c ? c + c : c;
    /** @type {Tok} */
    const t = { k: 'p', v: p };
    if (p === '++' || p === '--') {
      const before = tok(1);
      const k = before ? slashKind() : 're';
      // after `}`: a block, or a function/object expression, which `++` cannot follow
      t.pre = lineBlank || k === 're' || (before && before.k === 'p' && before.v === '}') ? 're' : k;
    } else if (p === ';') {
      while (decls.length && decls[decls.length - 1] >= open.length) decls.pop();
    }
    if (p === '(') {
      const h = tok(1);
      const h2 = tok(2);
      const stmt = !!h && h.k === 'id' && !dotted(1) && (STMT_PAREN.has(h.v)
        || (h.v === 'await' && !!h2 && h2.k === 'id' && h2.v === 'for' && !dotted(2)));
      open.push({ t: '(', stmt });
    } else if (p === '[' || p === '{') {
      open.push({ t: p });
    } else if (p === ')' || p === ']' || p === '}') {
      const want = p === ')' ? '(' : p === ']' ? '[' : '{';
      const top = open[open.length - 1];
      if (top && top.t === want) { open.pop(); if (p === ')') t.stmt = !!top.stmt; }
      else invalid(i, `unbalanced '${p}'`);
      while (decls.length && decls[decls.length - 1] > open.length) decls.pop();
    }
    i += p.length;
    code += p;
    push(t);
  }
  if (open.length) invalid(n, `unclosed '${open[open.length - 1].t}'`);
  return { toks, code, forks, bad };
}

/** At most this many readings of one file; beyond it the file is AMBIGUOUS. */
const MAX_READINGS = 32;

/**
 * Every reading of `src`: one per combination of choices at its fork points,
 * depth-first, at most MAX_READINGS. ⇒ Cost is one lex per reading, and a fork
 * exists only where a `/` after `}` (or a contextual keyword) could close as a
 * regex on the same line, or at an HTML-like comment — rare in real code.
 *
 * A reading that goes invalid is KEPT (its hash still counts), but is not
 * branched past its invalid point: every reading below it shares the defect.
 *
 * ⛔ THE COST WAS NOT BOUNDED BY THE CAP. Every new fork enqueued its prefix
 * BEFORE the cap was checked — O(F²) memory for F forks. Measured in the final
 * review: one generated 132 KB line with 6000 forks took 91 s and 4.3 GB. ⇒ At
 * most MAX_READINGS − readings − todo prefixes are ever enqueued, and a fork
 * that finds no room STOPS the walk: the file is `capped` (AMBIGUOUS — fails
 * closed) at once, with the readings lexed so far. ⇒ Cost ≤ MAX_READINGS lexes
 * in every case, and one lex when the first reading already overflows. A reading
 * is reduced to its summary as soon as it is lexed — tokens are not kept, so
 * memory is one lex, not MAX_READINGS of them.
 *
 * @param {string} src @returns {{readings: ReadingSummary[], capped: boolean}}
 */
function readJs(src) {
  /** @type {ReadingSummary[]} */
  const readings = [];
  /** @type {boolean[][]} choice prefixes still to lex */
  const todo = [[]];
  let capped = false;
  while (todo.length) {
    const pre = /** @type {boolean[]} */ (todo.pop());
    const r = lexJs(src, pre);
    const lim = r.bad ? r.bad.forks : r.forks.length;
    const room = MAX_READINGS - readings.length - 1 - todo.length;
    if (lim - pre.length > room) capped = true;
    readings.push({
      hash: readingHash(r.code),
      forks: r.forks.slice(0, 5),
      bad: r.bad,
      facts: r.bad || capped ? null : moduleFacts(r.toks),
    });
    if (capped) break;
    // The EARLIEST forks first (the last pushed is lexed next): depth-first, as before.
    for (let m = Math.min(lim, pre.length + room) - 1; m >= pre.length; m--) {
      todo.push([...pre, ...new Array(m - pre.length).fill(false), true]);
    }
  }
  return { readings, capped };
}

/**
 * A reading, kept: its content hash, its first 5 fork offsets (all a message
 * shows), its defect, and — when valid and the file is not capped — its facts.
 * @typedef {{hash: string, forks: number[], bad: Reading['bad'],
 *   facts: null | {specifiers: string[], defines: boolean}}} ReadingSummary
 */

/** @param {string} code a reading's comment-free source */
function readingHash(code) {
  return createHash('sha256').update(code.replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * What no-revendor knows about one file, across EVERY reading of it.
 *
 * * `hashes` — the normalised-content hash of every reading (valid or not). Both
 *   sides of the content comparison go through this, so a copy and its original
 *   produce the same set, and a match on ANY reading is a copy.
 * * `facts` — specifiers + defines (moduleFacts), but ONLY when every valid
 *   reading agrees on them and on the hash; otherwise null and `ambiguous` says
 *   where and why. ⇒ An ambiguous file gets no exception: fails CLOSED.
 *
 * ⚠ Remaining limits, with the direction each one fails:
 * * Beyond MAX_READINGS the file is ambiguous (closed for every exception) — but
 *   the content arm then compares only the readings explored before the walk
 *   stopped. Both sides walk in the same order, so a copy identical after
 *   normalisation still matches; one whose ONLY matching reading lies past the
 *   cap is missed (OPEN; needs more than log2(MAX_READINGS) = 5 forks).
 * * A reading is dropped only for being invalid JS. A file that is invalid in
 *   EVERY reading is ambiguous (closed). If the true reading of a valid file were
 *   dropped, that would be a lexer bug, not a stated limit.
 * * A locally SHADOWED `require` (`function require() {}`) is still taken as
 *   require, so a copy that defines its own fake `require` and "calls" its base
 *   module through it is excused as a shim (OPEN; it has to be written that way
 *   on purpose — no copy taken from base looks like that).
 * * `defines` sees syntax (`function`, `class`, `=>`, `(…) {`) and the named
 *   string-to-code entry points (`eval`, `Function`, `constructor`, `vm.*`,
 *   `data:` imports, non-literal `import()`). Code reached by another route — a
 *   name built at runtime, a string timer, a worker — is not seen (OPEN, but
 *   again only for a file written to evade).
 *
 * @param {string} src
 * @returns {{hashes: string[], facts: null | {specifiers: string[], defines: boolean},
 *   ambiguous: null | {lines: number[], why: string}}}
 */
function analyse(src) {
  const { readings, capped } = readJs(src);
  const hashes = [...new Set(readings.map((r) => r.hash))];
  // ⛔ lineAt was `src.slice(0, at).split('\n')` — O(n) per fork per reading, the
  // other half of the review's 91 s. ⇒ A line-start index (every terminator, CRLF
  // as one) and a binary search; and only the first 5 lines, all a message shows.
  /** @type {number[]} */
  const starts = [0];
  for (const m of src.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) starts.push(/** @type {number} */ (m.index) + m[0].length);
  /** 1-based line of offset `at`. @param {number} at */
  const lineAt = (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  /** @type {Set<number>} */
  const forkAt = new Set();
  for (const r of readings) for (const f of r.forks) forkAt.add(f);
  const forkLines = [...new Set([...forkAt].sort((a, b) => a - b).map(lineAt))].slice(0, 5);
  if (capped) {
    return { hashes, facts: null, ambiguous: { lines: forkLines, why: `it has more than ${MAX_READINGS} readings` } };
  }
  const valid = readings.filter((r) => !r.bad);
  if (valid.length === 0) {
    const b = /** @type {NonNullable<Reading['bad']>} */ (readings[0].bad);
    return { hashes, facts: null, ambiguous: { lines: [lineAt(b.at)], why: `this lexer cannot read it (${b.why})` } };
  }
  const all = valid.map((r) => ({ .../** @type {NonNullable<typeof r.facts>} */ (r.facts), hash: r.hash }));
  /** @param {(typeof all)[number]} f */
  const key = (f) => JSON.stringify([[...new Set(f.specifiers)].sort(), f.defines, f.hash]);
  if (new Set(all.map(key)).size > 1) {
    return {
      hashes, facts: null,
      ambiguous: { lines: forkLines, why: 'it reads two ways, and the readings disagree on what it imports, defines or contains' },
    };
  }
  return { hashes, facts: { specifiers: all[0].specifiers, defines: all[0].defines }, ambiguous: null };
}

/** Keywords that take `( … ) {` without that being a method definition. */
const PAREN_BLOCK = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'await']);
/** Names that turn a STRING into code. A file reaching one does not "define nothing". */
const EVALS = new Set(['eval', 'Function', 'constructor', 'runInThisContext', 'runInNewContext',
  'runInContext', 'compileFunction']);

/**
 * The two facts no-revendor needs about a module, read from ONE reading's TOKENS:
 *
 * * `specifiers` — string literals in a module-syntax position ONLY:
 *   `… from '<s>'` inside an `import`/`export {…}|*` clause, `import '<s>'`,
 *   `import('<s>')` and `require('<s>')` (not `x.require`, and only when the
 *   argument is that one literal). ⇒ Text inside a comment, inside another
 *   string, or inside a template is never a specifier.
 * * `defines` — the file contains `function`, `class` or `=>`; ANY `( … )`
 *   followed by `{` that is not an if/for/while/switch/catch/with head — so
 *   method shorthand under every key form (`f() {`, `['f']() {`, `'f'() {`,
 *   `get ['x']() {`); or a string-to-code entry point (EVALS, as a name or a
 *   string, a `data:` specifier, an `import()` whose argument is not one
 *   literal). A false positive here fails CLOSED (the file is not excused).
 *
 * @param {Tok[]} toks @returns {{specifiers: string[], defines: boolean}}
 */
function moduleFacts(toks) {
  /** @param {number} j @param {string} v */
  const is = (j, v) => j >= 0 && j < toks.length && toks[j].k !== 'str' && toks[j].k !== 'tpl'
    && toks[j].v === v;
  /** @type {Map<number, number>} index of each `(` -> index of its `)` */
  const closeOf = new Map();
  /** @type {number[]} */
  const parens = [];
  toks.forEach((t, j) => {
    if (t.k !== 'p') return;
    if (t.v === '(') parens.push(j);
    else if (t.v === ')' && parens.length) closeOf.set(/** @type {number} */ (parens.pop()), j);
  });
  /** @type {string[]} */
  const specifiers = [];
  let defines = false;
  /** inside an `import …` / `export {…}|*` clause, where `from '<s>'` is real */
  let clause = false;
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j];
    const dotted = is(j - 1, '.');
    if (t.k === 'id' && !dotted && t.v === 'import' && is(j + 1, '(')
      && !(toks[j + 2] && toks[j + 2].k === 'str' && (is(j + 3, ')') || is(j + 3, ',')))) {
      defines = true; // import(<expression>) may load a module built from a string
    }
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
    if ((t.k === 'id' || t.k === 'str') && EVALS.has(t.v)) defines = true;
    if (is(j, '=>')) defines = true;
    if (is(j, '(')) {
      const h = toks[j - 1];
      const head = !!h && h.k === 'id' && PAREN_BLOCK.has(h.v) && !is(j - 2, '.');
      const k = closeOf.get(j);
      if (!head && k !== undefined && is(k + 1, '{')) defines = true;
    }
  }
  if (specifiers.some((s) => s.startsWith('data:'))) defines = true;
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
