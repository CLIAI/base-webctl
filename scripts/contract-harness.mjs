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
//   node <base>/scripts/contract-harness.mjs isolated [--keep <path>]… [--keep-ro <path>]… [--pass-env <NAME|PREFIX_*>]… -- <cmd> [args…]   # every mutation arm (xrl4)
//   node <base>/scripts/contract-harness.mjs isolated -- node <base>/scripts/contract-harness.mjs isolation-check <port>…
//   node <base>/scripts/contract-harness.mjs sandbox-port [--bare]
//   node <base>/scripts/contract-harness.mjs guard-live-port <port> [--pin-verified]
//
// Exit: 0 pass · 1 fail · 2 NO VERDICT (reason printed as its last line) · 3 usage
//
// ⇒ THE HARNESS OWNS THE EXIT CODE so a contract never re-implements the
// `[ "$rc" = 2 ]` handling that has already bitten one lane.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// ⇩ for the network-isolation verbs (isolated / sandbox-port / guard-live-port)
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  // ⚠ Anything that is neither pass nor NO VERDICT is a FAIL — a USAGE refusal (exit 3)
  // included: it keeps its exit code, but its line must match `^(FAIL|NO VERDICT) +<check>: `,
  // the one shape a caller greps for (the gate misdiagnosed untagged refusals as
  // "user namespaces unavailable").
  const result = code === EXIT.pass ? 'pass' : code === EXIT.noVerdict ? 'no-verdict' : 'fail';
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

// ── isolation for mutation arms (xrl4: no host network AND no host unix sockets) ──
//
// ⛔ INCIDENT (2026-10-02, a consumer lane's mutation control): the mutant planted
// "the default port is a location", the arm ATTACHED to the real signed-in browser
// listening on the host's loopback, closed its last tab, and Chromium exited.
// Correct code refuses; A MUTANT DOES NOT REFUSE — that is what makes it a mutant.
// The family's sandboxes isolated HOME, CWD, env and PATH. Not the network.
//
// ⇒ `isolated` puts the arm in private user + network + MOUNT namespaces
// (`unshare -rnm --propagation=private`):
//
//   * NETWORK: the only interface is its OWN loopback, so the host's listeners do
//     not exist. Abstract-namespace unix sockets ('@…') are per-netns too, so -n
//     hides those as well.
//   * ⛔ PATH UNIX SOCKETS ARE NOT NETWORK. They are filesystem objects, and `-n`
//     leaves them reachable — measured: inside `unshare -rn`,
//     `curl --unix-socket /var/run/docker.sock` was ANSWERED by the daemon, i.e. a
//     mutant could `docker stop` the human's browser container; the X display
//     (/tmp/.X11-unix — key injection), the ssh-agent and the session bus
//     ($XDG_RUNTIME_DIR under /run) were equally open. ⇒ a fresh tmpfs over /run and
//     /tmp (and /var/run when it is a real directory), the paths the arm needs bound
//     back, every host path socket still listed connect-tested and covered with
//     /dev/null if it answers, and the env vars that NAME host sockets scrubbed.
//   * ⛔ THE HOME DIRECTORY IS HIDDEN, WHOLE (v0.33.0). It holds the signed-in browser
//     profiles (~/.cache/<tool>), ~/.config/webctl and ~/.ssh: a mutant restoring a LITERAL
//     path corrupts a live profile with no network at all (so the home was made READ-ONLY),
//     and read-only still let it READ and print ssh keys, ControlMaster sockets, an install
//     salt and remote target configs (so ~/.ssh and the state roots were HIDDEN) — and a fixed
//     list misses every secret nobody listed. ⇒ the PASSWD home gets an EMPTY read-only tmpfs;
//     re-bound on top READ-ONLY: base's root, node, the absolute command, every PATH entry
//     under the home, each `--keep-ro`; WRITABLE: the cwd and each `--keep`. A hidden dir a
//     re-bind would expose gets its own empty tmpfs again.
//   * ⛔ THE ENV IS AN ALLOWLIST (v0.33.0): credentials in the caller's env reached the arm.
//   * PID 1 REAPS: `bash --norc -p`, not node — node leaves re-parented orphans as zombies.
//
// It FAILS CLOSED: there is no path on which the command runs on the host.

const SELF = fileURLToPath(import.meta.url);
/** base's repo root (SELF is <root>/scripts/…) — kept visible under the /tmp mask. */
const SELF_ROOT = path.resolve(path.dirname(SELF), '..');
const ISOLATED_INNER = '__isolated-inner';
/** The node helper under a NESTED call's reaping pid 1: runs the command, forwards signals. */
const PID1_INNER = '__isolated-pid1';
/** The tmpfs source tag `isolated` mounts with; the nesting proof looks for it. */
const MASK_SOURCE = 'webctl-isolated';
/**
 * Env vars the command never inherits. The first six NAME a host socket or display. The
 * XDG_*_HOME four NAME the user's state roots, and base's storage paths PREFER them over
 * $HOME: a test that set a temp HOME but inherited an exported XDG_CACHE_HOME was silently
 * redirected to the REAL dirs (`perplexity`; a sibling lane's suite wrote and deleted the
 * human's real tab ledger and captcha lock through the same class of mistake). Unset, they
 * fall back to $HOME — the gate's throwaway one, or the read-only real one.
 * The last eight (`perplexity`, measured): TMUX/TMUX_PANE name the human's tmux server and
 * pane, XAUTHORITY an X cookie file, SSH_AGENT_PID and DOCKER_CONTEXT a live agent and a
 * (possibly remote) daemon — and SSH_CONNECTION, SSH_CLIENT, SSH_TTY carry the operator's
 * ADDRESSES, which a mutated test can print into a public log.
 */
const SCRUBBED_ENV = Object.freeze(['DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK',
  'DBUS_SESSION_BUS_ADDRESS', 'DOCKER_HOST', 'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME',
  'TMUX', 'TMUX_PANE', 'XAUTHORITY', 'SSH_AGENT_PID', 'DOCKER_CONTEXT',
  'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']);
/**
 * The env ALLOWLIST (v0.33.0, BREAKING): the ONLY names the command inherits, plus each
 * `--pass-env NAME|PREFIX_*` — and `isolated`'s own (TMPDIR=/tmp; the WEBCTL_* markers).
 * A trailing `*` is a prefix. SCRUBBED_ENV is removed AFTER the allowlist, so a prefix pass
 * (`XDG_*`) cannot bring a socket name back.
 *
 * ⛔ A denylist cannot keep up (measured by the review): 37 vars matching *_API_KEY, *_TOKEN,
 * *SECRET reached the arm on an operator host — and the gate passes its full env. So does
 * SESSION_MANAGER (it embeds the hostname and an ICE socket), ICEAUTHORITY, and
 * CLIAI_<TOOL>_BROWSER_{SSH_,}TARGET (they NAME remote targets). CLIAI_* is NOT default.
 * ⚠ The halves that run BEFORE the command (pid 1, the inner node, the drop) get even less:
 * PRIVILEGED_PASS_ENV. BASH_ENV and SHELLOPTS are on neither list.
 */
const DEFAULT_PASS_ENV = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_*', 'TERM', 'TZ',
  'NODE_OPTIONS', 'NODE_PATH', 'npm_config_*', 'WEBCTL_*']);
/** A `--pass-env` value: an env NAME, or `<PREFIX>_*` (the prefix ends in `_`; `*` alone is refused). */
const PASS_ENV_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9_]*_\*)$/;

/**
 * The ONLY env names the PRIVILEGED halves get — deny by default (v0.33.0, review of 5773fb8).
 * Privileged: everything `isolated` runs BEFORE the command's capability drop is complete —
 * `unshare -rnm`, pid 1's bash, the `__isolated-inner` node (namespace root, FULL caps, before
 * any mask), the mount/ip it runs, `setpriv`/`unshare -U` of the drop — and, for uniformity,
 * the `__isolated-pid1` helper that finally spawns the command.
 *
 * ⛔ Measured by the review: NODE_OPTIONS=--require <preload> (default-passed to the COMMAND)
 * ran the preload in the inner node as namespace root, CapEff full, the real home readable and
 * the host's X11 socket dir reachable. `--pass-env 'LD_*'` did the same for every C binary of
 * the chain (LD_PRELOAD into setpriv runs with the caps it is about to drop). A denylist of
 * loader vars cannot be complete (NODE_OPTIONS, NODE_PATH, LD_*, GCONV_PATH, LOCPATH, BASH_ENV,
 * ENV, PERL5OPT, PYTHONSTARTUP, …) — so the privileged env is this short allowlist instead, and
 * the COMMAND's full env (isolatedEnv) travels in a pipe and is applied only by the helper that
 * spawns it (runPid1 `--env <fd>`), after the drop.
 * ⛔ PATH is NOT the caller's (re-review of v0.33.0): it is SYSTEM_PATH, the fixed system dirs
 * every privileged tool is taken from (systemTool) — a PATH entry the command can write into (its
 * cwd via an empty or relative entry, npm's absolute node_modules/.bin) must never pick a binary
 * that runs with these capabilities. WEBCTL_* carries the markers and WEBCTL_UNSHARE_BIN.
 */
const PRIVILEGED_PASS_ENV = Object.freeze(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_*', 'TERM', 'TZ', 'TMPDIR', 'WEBCTL_*']);

/**
 * The privileged halves' env: `env` (already the command's allowlisted env) cut to
 * PRIVILEGED_PASS_ENV, with PATH = SYSTEM_PATH (never the caller's).
 * @param {NodeJS.ProcessEnv} env @returns {NodeJS.ProcessEnv}
 */
function privilegedEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && passEnvMatches(k, PRIVILEGED_PASS_ENV)) out[k] = v;
  return { ...out, PATH: SYSTEM_PATH };
}

/**
 * ⛔ The ONLY dirs a tool run BEFORE the command's capability drop comes from (re-review of v0.33.0).
 *
 * Measured: `ip`, `mount` and `setpriv` were run by name — searched on the CALLER's PATH, empty and
 * relative entries included — and `unshare`/`bash` by PATH too (absolute entries only, which npm's
 * prepended `<pkg>/node_modules/.bin` defeats). A fake `ip` in the cwd + `PATH=":$PATH"` ran as
 * namespace root, CapEff full, BEFORE the masks, listing the real home. The cwd is WRITABLE inside,
 * so a mutated test plants `./ip` and the NEXT run executes it privileged. ⇒ unshare, pid 1's bash,
 * mount, ip/ifconfig and setpriv are resolved ON THE HOST, before unshare, from these dirs only, and
 * passed on as ABSOLUTE paths (the fresh path's plan carries them); the privileged halves' own env
 * PATH is this list too. WEBCTL_UNSHARE_BIN stays the one explicit, validated override.
 * ⚠ The COMMAND still gets the caller's PATH, unchanged, and runs its tools by it.
 */
const SYSTEM_TOOL_DIRS = Object.freeze(['/usr/sbin', '/usr/bin', '/sbin', '/bin']);
/** The privileged halves' PATH. */
const SYSTEM_PATH = SYSTEM_TOOL_DIRS.join(':');

/**
 * The first `<dir>/<name>` in `dirs` (default SYSTEM_TOOL_DIRS) that is an executable regular file
 * (symlinks followed), as that path — NOT realpath'd: a multi-call binary (busybox) dispatches on
 * the name it was run as. '' when none. Never consults PATH.
 * @param {string} name @param {readonly string[]} [dirs] @returns {string}
 */
export function systemTool(name, dirs = SYSTEM_TOOL_DIRS) {
  for (const d of dirs) {
    if (!path.isAbsolute(d)) continue;
    const p = path.join(d, name);
    try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { /* next */ }
  }
  return '';
}

/** The refusal for a privileged tool that is in none of the system dirs. @param {string} name @param {string} why */
function noSystemTool(name, why) {
  return `'${name}' not found in ${SYSTEM_TOOL_DIRS.join(', ')} — ${why} (tools that run before the command's `
    + 'capability drop are never taken from the caller\'s PATH)';
}

/** @param {string} name @param {readonly string[]} patterns */
function passEnvMatches(name, patterns) {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * The env `isolated` gives what it starts: the ALLOWLIST (DEFAULT_PASS_ENV + `pass`) of `env`,
 * minus SCRUBBED_ENV, with TMPDIR=/tmp (an inherited one may name a dir the /tmp mask hid).
 * Idempotent — the fresh path applies it on the host AND again inside.
 * @param {NodeJS.ProcessEnv} env @param {readonly string[]} pass @param {Record<string, string>} [own]
 * @returns {NodeJS.ProcessEnv}
 */
function isolatedEnv(env, pass, own = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  const allow = [...DEFAULT_PASS_ENV, ...pass];
  for (const [k, v] of Object.entries(env)) if (v !== undefined && passEnvMatches(k, allow)) out[k] = v;
  for (const k of SCRUBBED_ENV) delete out[k];
  return { ...out, ...own, TMPDIR: '/tmp' };
}
/**
 * Home dot-directories that hold LIVE state: signed-in browser profiles (~/.cache/<tool>),
 * the family's config (~/.config/webctl), keys and ControlMaster sockets (~/.ssh). A keep
 * in (or containing) one is allowed — it is the caller's choice — but NAMED on stderr.
 * One that is a SYMLINK out of home is read-only-protected at its real path too.
 */
const SENSITIVE_DOTDIRS = Object.freeze(['.ssh', '.gnupg', '.config', '.cache', '.local', '.mozilla', '.pki']);
/**
 * Home directories hidden even where a re-bind would expose them. ⛔ Measured (`perplexity`): with
 * the home only read-only, a mutated test could READ and print the operator's ssh keys, live
 * ControlMaster socket paths, an install salt, and target configs naming remote hosts — into a log
 * that may be public. Since v0.33.0 the WHOLE home is hidden; these get their OWN empty read-only
 * tmpfs (source HIDE_SOURCE) wherever a re-bind contains them (a `--keep ~/.config` does not
 * unhide ~/.config/webctl) and at their real path when it lies outside the home. An explicit
 * `--keep` at or beneath one re-exposes THAT path only (named on stderr). A PATH entry or
 * `--keep-ro` inside or containing one is REFUSED (planKeeps).
 */
const HIDDEN_DIRS = Object.freeze(['.ssh', '.gnupg', '.cache/CLIAI', '.config/CLIAI', '.local/state/CLIAI', '.config/webctl']);
/** The tmpfs source tag of a HIDDEN_DIRS mask; the post-check and the nesting proof look for it. */
const HIDE_SOURCE = 'webctl-isolated-hidden';

/**
 * pid 1 of every PID namespace `isolated` makes (fresh AND nested): a bash that REAPS.
 *
 * ⛔ node as pid 1 leaves an orphaned, exited grandchild as a ZOMBIE — measured (`perplexity`):
 * `kill -0` on it succeeds and /proc shows state Z, so a test that daemonises a helper and
 * asserts "it is gone" fails only under `isolated`. libuv waits for the pids IT spawned and
 * node has no waitpid(-1); prctl(PR_SET_CHILD_SUBREAPER) is not reachable from node either, and
 * would not help — a pid 1 already IS the reaper, the question is only whether it calls wait.
 * ⇒ unshare's forked child is `bash --norc -p -c PID1_REAPER` (PID1_BASH_FLAGS): it runs the real work ($@ — the node inner
 * half, or the nested path's node pid-1 helper) in the BACKGROUND and `wait`s on it. bash's
 * SIGCHLD handler reaps ANY child, re-parented orphans included (measured: state gone).
 *
 *   * `<&0`: a background job of a non-interactive bash gets /dev/null as stdin unless it is
 *     redirected explicitly (measured) — without it every command reading stdin starves.
 *   * fds 3/4 (the fresh path's status and plan pipes) pass to the background child, which
 *     needs them; bash then closes its OWN copies.
 *   * INT/TERM/HUP are trapped (pid 1 receives nothing it has no handler for) and forwarded to
 *     the child; a trapped signal interrupts `wait` (>128), so it waits AGAIN until the child
 *     itself ended — bash keeps a reaped child's status for a second `wait` (measured) — and
 *     exits with the CHILD's status. A signal after the traps but before the child exists ends
 *     pid 1 at once (128+n), and the namespace with it.
 *   * ⛔ A signal BEFORE the traps is LOST, not handled: pid 1 ignores what it has no handler for.
 *     (This comment used to claim "nothing starts after the caller gave up" — measured false by
 *     the review: 24 of 40 early TERMs lost, the command ran to exit 0.) The window is closed
 *     from OUTSIDE: until the half under pid 1 reports `started` on fd 3 — which it can only do
 *     after pid 1 trapped and started it — the harness SIGKILLs unshare (forwardSignalsPastUnshare).
 *   * ⚠ A background job ignores SIGINT; node resets its signal dispositions at start (measured),
 *     which is why the node helper stays between this pid 1 and the command on BOTH paths.
 * Fail closed: no bash in the system dirs → refused (privilegedTools), never a non-reaping pid 1.
 */
const PID1_REAPER = [
  'c=; t=',
  'f() { t=1; if [ -n "$c" ]; then kill -s "$1" "$c" 2>/dev/null; else exit "$2"; fi; }',
  "trap 'f INT 130' INT; trap 'f TERM 143' TERM; trap 'f HUP 129' HUP",
  '"$@" <&0 &',
  'c=$!',
  'exec 3>&- 4<&-',
  'while :; do t=; wait "$c"; rc=$?; [ -n "$t" ] || break; done',
  'exit "$rc"',
].join('\n');

/** The AppArmor knob that makes an unprivileged `unshare -r` fail with uid_map EPERM (Ubuntu ≥ 23.10). */
const APPARMOR_USERNS_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
/** An absolute path to the `unshare` EVERY invocation uses (default: `unshare` on PATH). */
const UNSHARE_BIN_ENV = 'WEBCTL_UNSHARE_BIN';

/**
 * The HOST-POLICY refusal for an unprivileged user namespace the kernel refused, or ''.
 *
 * Measured on an Ubuntu 24.04 host: `kernel.apparmor_restrict_unprivileged_userns=1` makes
 * `unshare -r` fail writing uid_map (EPERM). That is the host's policy, not the lane's code —
 * and the generic "user namespaces may be disabled" reason sent people hunting the wrong
 * sysctl. ⇒ When `stderr` (unshare's) shows an EPERM on uid_map/gid_map/setgroups/unshare AND
 * the sysctl reads 1, say so and give both fixes; otherwise '' (the caller's reason stands).
 * ⚠ `sysctlPath` is a parameter so the arms never read (or depend on) the host's setting.
 * @param {string} stderr @param {string} [sysctlPath] @returns {string}
 */
export function userNamespaceRefusal(stderr, sysctlPath = APPARMOR_USERNS_SYSCTL) {
  const eperm = /\b(uid_map|gid_map|setgroups|unshare)\b[^\n]*(Operation not permitted|EPERM|Permission denied)/i.test(String(stderr || ''));
  if (!eperm) return '';
  let v = '';
  try { v = fs.readFileSync(sysctlPath, 'utf8').trim(); } catch { return ''; }
  if (v !== '1') return '';
  return 'HOST POLICY, not a fault of this lane: the kernel refused an unprivileged user namespace (uid_map '
    + 'EPERM) because kernel.apparmor_restrict_unprivileged_userns = 1 — AppArmor restricts them on this host. '
    + 'Fix ONE of: (1) `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (host-wide; persist it under '
    + '/etc/sysctl.d); (2) an AppArmor profile granting `userns,` to a DEDICATED copy of unshare, and '
    + `${UNSHARE_BIN_ENV}=<its absolute path> (used for every unshare isolation runs)`;
}

/**
 * The `unshare` to run: WEBCTL_UNSHARE_BIN when set — VALIDATED: an absolute path to an
 * executable regular file — else the system one (systemTool, never PATH). `why` names the rule
 * broken, never the path; `override`: it came from WEBCTL_UNSHARE_BIN (re-bound read-only inside).
 * @returns {{bin: string, why: string, override: boolean}}
 */
function unshareBin() {
  const v = process.env[UNSHARE_BIN_ENV];
  if (v === undefined || v === '') {
    const bin = systemTool('unshare');
    return { bin, why: bin ? '' : noSystemTool('unshare', `install util-linux, or name one with ${UNSHARE_BIN_ENV}`), override: false };
  }
  const rule = `${UNSHARE_BIN_ENV} must be an ABSOLUTE path to an EXECUTABLE regular file`;
  if (!path.isAbsolute(v)) return { bin: '', why: `${rule} — it is not absolute`, override: true };
  /** @type {fs.Stats} */ let st;
  try { st = fs.statSync(v); } catch { return { bin: '', why: `${rule} — it does not exist`, override: true }; }
  if (!st.isFile()) return { bin: '', why: `${rule} — it is not a regular file`, override: true };
  try { fs.accessSync(v, fs.constants.X_OK); } catch { return { bin: '', why: `${rule} — it is not executable`, override: true }; }
  return { bin: v, why: '', override: true };
}

/**
 * @typedef {{unshare: string, bash: string, setpriv: string, mount: string, lo: [string, string[]][]}} Tools
 *   every binary a privileged half runs, by ABSOLUTE path (SYSTEM_TOOL_DIRS / WEBCTL_UNSHARE_BIN).
 *   `lo`: how to bring the loopback up — `ip`, then `ifconfig`, whichever exist. The NESTED path
 *   needs no mount or lo (it makes no netns and masks nothing): '' / [] there.
 */

/**
 * Resolve, ON THE HOST and before anything runs, every tool a privileged half needs — from the
 * system dirs only (SYSTEM_TOOL_DIRS). `why` names the first missing one (no path).
 * @param {{bin: string}} ub unshareBin()'s answer @param {boolean} nested
 * @returns {{tools: Tools, why: string}}
 */
function privilegedTools(ub, nested) {
  const bash = systemTool('bash');
  const setpriv = systemTool('setpriv');
  const mount = nested ? '' : systemTool('mount');
  /** @type {[string, string[]][]} */
  const lo = nested ? [] : /** @type {[string, string[]][]} */ ([[systemTool('ip'), ['link', 'set', 'lo', 'up']],
    [systemTool('ifconfig'), ['lo', 'up']]]).filter(([b]) => b);
  const tools = { unshare: ub.bin, bash, setpriv, mount, lo };
  if (!bash) return { tools, why: NO_BASH };
  if (!setpriv) {
    return { tools, why: `cannot enter the uid-mapped child user namespace: ${noSystemTool('setpriv', 'install util-linux')}; `
      + 'the command would run as namespace root with every capability (it could unmount the masks)' };
  }
  if (!nested && !mount) return { tools, why: `cannot mask the host's sockets: ${noSystemTool('mount', 'install util-linux')}` };
  if (!nested && lo.length === 0) {
    return { tools, why: 'cannot bring the namespace loopback up: neither \'ip\' nor \'ifconfig\' found in '
      + `${SYSTEM_TOOL_DIRS.join(', ')} — install iproute2 (never taken from the caller's PATH)` };
  }
  return { tools, why: '' };
}

/** @param {unknown} x @returns {x is Tools} every path absolute (the plan's `tools`, re-validated inside) */
function isTools(x) {
  const t = /** @type {Record<string, unknown>} */ (x);
  const abs = (/** @type {unknown} */ p) => typeof p === 'string' && path.isAbsolute(p);
  return !!t && typeof t === 'object' && abs(t.unshare) && abs(t.bash) && abs(t.setpriv) && abs(t.mount)
    && Array.isArray(t.lo) && t.lo.length > 0
    && t.lo.every((e) => Array.isArray(e) && e.length === 2 && abs(e[0]) && Array.isArray(e[1]) && e[1].every((a) => typeof a === 'string'));
}

/**
 * Why `bin -r true` fails here, if it is the AppArmor policy (userNamespaceRefusal), else ''.
 * Run only AFTER a failure: the fresh path's unshare shares the caller's stderr, so its own
 * message cannot be read back. @param {string} bin
 */
function diagnoseUserNamespace(bin) {
  const r = spawnSync(bin, ['-r', 'true'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  return r.status === 0 ? '' : userNamespaceRefusal(String(r.stderr || ''));
}

/**
 * How pid 1's bash is started: `--norc -p -c PID1_REAPER`.
 *
 * ⛔ `bash -c` honoured the CALLER's shell config as pid 1 — WITH every namespace capability and
 * BEFORE any mask (measured by the review): a BASH_ENV script ran; SHELLOPTS=xtrace traced the
 * reaper; an exported `wait()` (BASH_FUNC_wait%%) REPLACED it, losing the exit code;
 * SHELLOPTS=errexit + TERM ended the namespace before the command's trap (143, not its 7).
 * ⇒ `-p` (privileged mode): BASH_ENV/ENV not read, functions not imported, SHELLOPTS/BASHOPTS
 * ignored. ⛔ AND `--norc` (measured while fixing it): with SHLVL unset (the env allowlist drops
 * it) and stdin a SOCKET (node's stdio pipes are socketpairs) bash decides rshd started it and
 * sources ~/.bashrc — `-p` does not stop that branch, `--norc` does. Long options go first.
 */
const PID1_BASH_FLAGS = Object.freeze(['--norc', '-p', '-c']);

/** The refusal when systemTool('bash') finds none — pid 1 must be the reaping bash (PID1_REAPER). */
const NO_BASH = noSystemTool('bash', 'pid 1 of the isolated PID namespace is a bash that REAPS orphans (node as '
  + 'pid 1 leaves them as zombies), and isolation does not run without it');

/** The termination signals the harness forwards. */
const FORWARDED_SIGNALS = /** @type {NodeJS.Signals[]} */ (Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']));

/**
 * @typedef {{last: () => NodeJS.Signals | null, remove: () => void, early?: () => boolean}} Forwarder
 * `last`: the most recent signal forwarded (null: none); `remove`: uninstall the handlers;
 * `early` (forwardSignalsPastUnshare only): a signal came before `started`, so unshare was KILLED.
 */

/**
 * Install `send` as the handler of every FORWARDED_SIGNALS entry, remembering the last one.
 * @param {(s: NodeJS.Signals) => void} send @returns {Forwarder}
 */
function installForwarder(send) {
  /** @type {NodeJS.Signals | null} */
  let last = null;
  /** @type {[NodeJS.Signals, () => void][]} */
  const handlers = FORWARDED_SIGNALS.map((s) => [s, () => { last = s; send(s); }]);
  for (const [s, h] of handlers) process.on(s, h);
  return { last: () => last, remove: () => { for (const [s, h] of handlers) process.off(s, h); } };
}

/**
 * A forwarder installed BEFORE its child exists: a signal that comes first is BUFFERED and
 * delivered on `attach(child)` (right after the spawn); after that, at once.
 *
 * ⛔ Review of 5773fb8, finding 5: the inner half removed its early handler BEFORE runCommand
 * installed its forwarder, and the pid-1 helper wrote `started` before it had any handler. A
 * node process with no listener for a signal has its DEFAULT disposition — so a TERM in either
 * gap killed that half outright: the command, already spawned or about to be, was orphaned and
 * SIGKILLed with the namespace, its trap never run. ⇒ Every forwarder is made first, then the
 * spawn, then `attach`. (node dispatches a signal on a later tick, so `pending` is the belt to
 * that brace: nothing is lost even if the spawn moved off this tick.)
 * @template C
 * @param {(s: NodeJS.Signals, child: C) => void} deliver
 * @returns {Forwarder & {attach: (c: C) => void}}
 */
export function forwarderBeforeSpawn(deliver) {
  /** @type {{c: C} | null} */
  let to = null;
  /** @type {NodeJS.Signals[]} */
  const pending = [];
  const fwd = installForwarder((s) => { if (to) deliver(s, to.c); else pending.push(s); });
  return { ...fwd, attach: (c) => { to = { c }; for (const s of pending.splice(0)) deliver(s, c); } };
}

/**
 * Forward termination signals to a child (attached after its spawn), so killing the harness
 * kills the arm rather than orphaning it.
 * @returns {Forwarder & {attach: (c: import('node:child_process').ChildProcess) => void}}
 */
function forwardSignals() {
  return forwarderBeforeSpawn((s, /** @type {import('node:child_process').ChildProcess} */ child) => {
    try { child.kill(s); } catch { /* already gone */ }
  });
}

/**
 * The exit code for a child that ended with (code, signal) — or, when it ended BY the signal
 * we forwarded to it, DIE BY THAT SIGNAL OURSELVES.
 *
 * ⛔ Ctrl-C became a lane FAIL (measured by the final review): `isolated` caught SIGINT,
 * forwarded it, then EXITED NORMALLY with 130. bash's wait-and-cooperative-exit rule reads a
 * normal exit as "the child handled the INT", so the gate's INT trap never ran: it reported
 * "FAIL … failed against this base" and went on to the next consumer.
 * ⇒ When a signal was forwarded and the child ended by it — killed by it, or exit 128+n,
 * which is how it arrives through unshare and the namespace's pid 1 — remove our handlers
 * and re-raise it on ourselves. A command that HANDLED the signal and chose its own exit
 * code (a trap's `exit 7`) still returns that code; an exit 130 with no signal forwarded
 * stays an ordinary exit 130.
 * Inside, the inner half (pid 2, under the reaping bash pid 1) dies by it; pid 1 exits with
 * 128+n — pid 1 cannot die by a self-sent signal — and unshare passes that on as an exit code,
 * so the outer half, which forwarded the same signal, re-raises it on the host.
 * @param {Forwarder} fwd @param {number|null} code @param {NodeJS.Signals|null} signal
 * @returns {number}
 */
function exitOrDieBy(fwd, code, signal) {
  const rc = exitCodeOf(code, signal);
  const sig = fwd.last();
  fwd.remove();
  if (sig && rc === 128 + (os.constants.signals[sig] || -999)) {
    try { process.kill(process.pid, sig); } catch { /* fall through to the exit code */ }
  }
  return rc;
}

/**
 * Host pids of `pid`'s children: /proc/<pid>/task/<pid>/children, else a /proc scan.
 * @param {number} pid @returns {number[]}
 */
function childrenOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch { /* CONFIG_PROC_CHILDREN off: scan */ }
  /** @type {number[]} */ const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      if (Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) === pid) out.push(Number(d));
    } catch { /* gone */ }
  }
  return out;
}

/**
 * Forward termination signals THROUGH `unshare --fork` to the inner half.
 *
 * ⛔ `unshare --fork` BLOCKS SIGTERM (and ignores SIGINT/SIGQUIT) in its own process until
 * its child exits — measured: a SIGTERM to it never reached the child, which ran to the
 * end. So the signal goes to unshare's CHILD, the reaping bash (pid 1 of the new namespace;
 * it traps them, which a namespace init needs to receive anything) and on to the node half
 * (PID1_REAPER).
 *
 * ⛔ THE EARLY WINDOW (measured by the review: 24 of 40 TERMs lost; v0.32.0 15/40). pid 1 of a
 * new PID namespace IGNORES any signal it has no handler for, and bash installs its traps a
 * moment AFTER unshare's child exists — so "a child exists" is not "pid 1 can hear us": the
 * TERM vanished and the command ran to exit 0 after the caller gave up. ⇒ Until `started()`
 * (the inner side's report on fd 3 — written only once pid 1's traps are certainly in place,
 * because pid 1 started it), a signal SIGKILLs unshare and `--kill-child` takes the namespace
 * with it; `early()` then tells the caller to die by that signal. No child at all ⇒ the same.
 * Installed BEFORE the spawn (forwarderBeforeSpawn): `attach(unshare)` once it exists.
 * @param {() => boolean} started has the inner side reported `started`?
 * @returns {Forwarder & {attach: (c: import('node:child_process').ChildProcess) => void}}
 */
function forwardSignalsPastUnshare(started) {
  let early = false;
  const fwd = forwarderBeforeSpawn((s, /** @type {import('node:child_process').ChildProcess} */ unshare) => {
    const kids = unshare.pid ? childrenOf(unshare.pid) : [];
    if (kids.length === 0 || !started()) {
      early = true;
      try { unshare.kill('SIGKILL'); } catch { /* gone */ }
      return;
    }
    for (const k of kids) { try { process.kill(k, s); } catch { /* gone */ } }
  });
  return { ...fwd, early: () => early };
}

/**
 * Die by the signal that was forwarded (if any), after uninstalling our handlers — for a run
 * that ended because WE killed it early (Forwarder.early) or before anything started. Returns
 * only if there was no signal or the kill did not end us.
 * @param {Forwarder} fwd
 */
function dieByForwarded(fwd) {
  const sig = fwd.last();
  fwd.remove();
  if (sig) { try { process.kill(process.pid, sig); } catch { /* the caller reports */ } }
}

/**
 * Collect `started` from a status pipe (fd 3 of a child). @param {import('node:child_process').ChildProcess} child
 * @returns {{started: () => boolean, text: () => string}}
 */
function statusChannel(child) {
  let status = '';
  const pipe = /** @type {import('node:stream').Readable | null | undefined} */ (child.stdio[3]);
  pipe?.on('data', (d) => { status += String(d); });
  pipe?.on('error', () => { /* the other side closed it */ });
  return { started: () => /^started$/m.test(status), text: () => status };
}

/**
 * The node helper under a nested call's reaping pid 1 (`__isolated-pid1 [--status] -- <cmd…>`):
 * spawn the command with the env it was given (already allowlisted) and default signal
 * dispositions, forward termination signals to it, and return its exit code (128+n when killed;
 * the caller re-raises). `--status`: first write `started` on fd 3 (the nested caller's status
 * pipe) and close it — the early-signal window (forwardSignalsPastUnshare) ends there.
 * ⚠ Internal: reached only through the nested path's prefix, never documented as a verb.
 * @param {string[]} a @returns {Promise<number>}
 */
function runPid1(a) {
  // `--status`: fd 3 is the nested path's status pipe — write `started` on it, then close it
  const status = a[0] === '--status';
  let rest = status ? a.slice(1) : a;
  // `--env <fd>`: the COMMAND's env, JSON on that pipe (we run with the privileged env only)
  const envFd = rest[0] === '--env' && /^[3-9]$/.test(rest[1] || '') ? Number(rest[1]) : -1;
  if (envFd >= 0) rest = rest.slice(2);
  const command = rest[0] === '--' ? rest.slice(1) : [];
  if (command.length === 0 || envFd < 0) return Promise.resolve(report('isolated', EXIT.fail, 'internal: malformed pid-1 invocation'));
  const env = commandEnvFrom(envFd);
  if (!env) {
    return Promise.resolve(report('isolated', EXIT.fail, 'NOT RUN: internal: the command\'s env did not arrive on its pipe — '
      + 'it is never run with the privileged env instead. The command was NOT started.'));
  }
  // ⛔ the forwarder FIRST (review finding 5): from `started` on the caller forwards to us, and
  // with no handler node's default disposition would kill us and orphan the command
  const fwd = forwardSignals();
  if (status) {
    // ⚠ only a pipe/socket is ours: an fd 3 node opened for itself must never be written to
    let ours = false;
    try { const st = fs.fstatSync(3); ours = st.isSocket() || st.isFIFO(); } catch { /* absent */ }
    // ⛔ BEFORE the command starts, so it never inherits fd 3. Our forwarder is installed ABOVE
    // (before this write), and pid 1 (bash) trapped its signals before starting us — so from
    // `started` on, a forwarded signal is HEARD, and buffered until the command exists.
    if (ours) {
      try { fs.writeSync(3, 'started\n'); } catch { /* the caller then never sees `started` */ }
      try { fs.closeSync(3); } catch { /* already gone */ }
    }
  }
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
    fwd.attach(child);
    child.on('error', (e) => { fwd.remove(); resolve(report('isolated', 127, `NOT RUN: cannot start '${command[0]}': ${errMsg(e)}`)); });
    child.on('close', (code, signal) => { fwd.remove(); resolve(exitCodeOf(code, signal)); });
  });
}

/**
 * Read the command's env (JSON object of strings) from pipe `fd`, then close it so the command
 * never inherits it. null when fd is not a pipe/socket or the JSON is not such an object.
 * @param {number} fd @returns {NodeJS.ProcessEnv | null}
 */
function commandEnvFrom(fd) {
  try {
    const st = fs.fstatSync(fd);
    if (!st.isSocket() && !st.isFIFO()) return null;
    const env = JSON.parse(fs.readFileSync(fd, 'utf8'));
    try { fs.closeSync(fd); } catch { /* already gone */ }
    return isEnvObject(env) ? env : null;
  } catch { return null; }
}

/** @param {unknown} x @returns {x is Record<string, string>} */
function isEnvObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x)
    && Object.entries(x).every(([k, v]) => /^[^=\0]+$/.test(k) && typeof v === 'string' && !v.includes('\0'));
}

/**
 * The argv of the `__isolated-pid1` helper that spawns `command` with the env on pipe `envFd`.
 * @param {string[]} command @param {number} envFd @param {boolean} status @returns {string[]}
 */
function pid1HelperArgv(command, envFd, status) {
  return [process.execPath, SELF, PID1_INNER, ...(status ? ['--status'] : []), '--env', String(envFd), '--', ...command];
}

/** @param {number|null} code @param {NodeJS.Signals|null} signal */
function exitCodeOf(code, signal) {
  if (code != null) return code;
  const n = signal ? os.constants.signals[signal] : undefined;
  return 128 + (n || 1);
}

const ISOLATED_USAGE = 'usage: contract-harness.mjs isolated [--keep <path>]… [--keep-ro <path>]… [--pass-env <NAME|PREFIX_*>]… -- <cmd> [args…]\n';

/**
 * A USAGE refusal: the usage text, then a `FAIL  isolated: NOT RUN (usage): …` line +
 * JSONL record, exit 3. ⛔ It used to be a bare `isolated: …` line, which the gate's grep
 * for `^(FAIL|NO VERDICT) +isolated: ` missed — so a bad `--keep` (TMPDIR under /run)
 * was reported as "isolated exited 3 and stated no reason … fix unshare / user
 * namespaces" (final review, finding 7).
 * @param {string} why @param {string[]} command @returns {number}
 */
function usageRefusal(why, command) {
  process.stderr.write(ISOLATED_USAGE);
  return report('isolated', EXIT.usage, `NOT RUN (usage): ${why}. The command was NOT started.`, { command });
}

/**
 * `isolated [--keep <path>]… -- <cmd> [args…]` — run <cmd> with NO host network and
 * NO host unix sockets.
 *
 * The outer half spawns
 * `unshare -rnm --pid --fork --mount-proc --kill-child --propagation=private <bash> --norc -p -c PID1_REAPER … <node> <this file> __isolated-inner <netns> -- <cmd…>`
 * — pid 1 is a bash that REAPS orphans (PID1_REAPER), the inner half runs under it — with
 * two extra pipes: fd 3 is the STATUS channel, fd 4 carries the masking PLAN
 * (host mount-ns id, cwd, paths to re-expose, the host's path sockets — a list that
 * can be long, so never argv). The inner half proves the isolation and masks (below),
 * then writes `started` on fd 3 and runs the command; any refusal is written as
 * `fail <reason>` instead. ⇒ The outer half can tell "isolation was refused" from
 * "the command exited 1", and reports the former ONCE, as FAIL, with the reason.
 *
 * ⛔ /tmp IS MASKED, AND THE ARM USUALLY LIVES THERE. Worktrees, the `--scratch` gate's
 * consumer clones and test fixtures are all commonly under /tmp. So these stay
 * visible at their SAME absolute paths: the cwd, base's own repo root, the command
 * if given by absolute path, node itself, WEBCTL_UNSHARE_BIN, a $HOME that lives under /tmp (a
 * sandbox's throwaway one), every `--keep <path>` and `--keep-ro <path>`. Anything else the arm
 * shares with its caller under /tmp — a marker file, a fixture — needs a keep. A keep may not
 * be /tmp or /run itself, an ancestor of either, a path under /run, or contain the
 * (passwd) home directory. ⚠ Only `--keep` paths are EXEMPT from the socket check below — a
 * socket in the cwd or under a `--keep-ro` is still covered if it answers.
 *
 * ⛔ THE PASSWD HOME IS HIDDEN, WHOLE (not $HOME — the gate points that at a throwaway dir): an
 * EMPTY read-only tmpfs over it (v0.33.0; it was read-only before, with a fixed list hidden).
 * Re-bound on top, at the same paths — READ-ONLY: base's repo root, node, an absolute command,
 * WEBCTL_UNSHARE_BIN, EVERY PATH entry under the home (or the tools there vanish), each
 * `--keep-ro`; WRITABLE: the cwd and each `--keep`. Each re-bind's submounts get its mode too.
 * base's root is read-only because under the release gate ONE checkout serves every consumer.
 * A cwd containing the home is REFUSED (fail); a `--keep` containing it is a usage error; a
 * writable keep in or containing ~/.ssh, ~/.config, ~/.cache … is allowed but NAMED on stderr
 * (`isolated: note: …`). A real path of a SENSITIVE_DOTDIRS entry that symlinks OUT of home is
 * made READ-ONLY there (the home's tmpfs hides only the symlink). Every path is realpath'd
 * first, so a symlink cannot smuggle the home in. Any mount that fails → refused; and the
 * result is READ BACK from /proc/self/mountinfo before the command starts. The verdict line
 * `isolated: home HIDDEN; re-bound read-only: …; writable: …` lists by path (`~/…`) only what the
 * caller named — PATH entries are COUNTED (verdictLine; WEBCTL_ISOLATED_VERBOSE=1 lists all).
 * A cwd at or beneath a hidden dir is REFUSED (it would be re-bound writable there).
 *
 * ⛔ AND THE SECRET DIRS STAY HIDDEN UNDER A RE-BIND (HIDDEN_DIRS): ~/.ssh, ~/.gnupg,
 * ~/.cache/CLIAI, ~/.config/CLIAI, ~/.local/state/CLIAI and ~/.config/webctl get their own empty
 * read-only tmpfs where a re-bind contains them. A PATH entry or `--keep-ro` that IS the home,
 * or contains or lies inside one of them, is REFUSED naming the rule and no path. An explicit
 * `--keep` at or beneath one re-exposes THAT path (named on stderr). Read back from mountinfo by
 * RESOLVING each path (hiddenGaps): a later mount on an ancestor would shadow a hide.
 *
 * ⛔ NEVER FALLS BACK TO THE HOST. No unshare, userns disabled, no `ip`/`ifconfig`, no
 * `mount`, a loopback that will not come up, a namespace that still sees a non-loopback
 * interface or a listener, a mount that fails, a host socket that still answers after
 * masking — each is FAIL, and the command is not started. Refusals carry COUNTS,
 * never socket paths: they get pasted into a public repo's logs.
 *
 * ⛔ The command runs with NO CAPABILITIES — otherwise namespace root could simply unmount
 * every mask above (measured). It runs in a CHILD user namespace as the REAL uid/gid
 * (privilegeDrop: `setpriv --no-new-privs -- unshare -U --map-user …`, read back), so it can
 * still make namespaces of its own — `unshare -rn`, Chromium's sandbox — which the earlier
 * setpriv capability drop broke (measured).
 *
 * ⛔ THE ENV IS AN ALLOWLIST (v0.33.0, DEFAULT_PASS_ENV): PATH, HOME, USER, LOGNAME, SHELL, LANG,
 * LC_*, TERM, TZ, NODE_OPTIONS, NODE_PATH, npm_config_*, WEBCTL_* — plus each `--pass-env
 * NAME|PREFIX_*` — and SCRUBBED_ENV is removed even from those; TMPDIR=/tmp. On the nested path
 * too, with the nested call's own `--pass-env`. ⛔ That is the COMMAND's env: every half before
 * it gets PRIVILEGED_PASS_ENV only, and the command's env reaches the `__isolated-pid1` helper
 * that spawns it down a pipe. argv goes through as an ARRAY: no shell sees the command.
 *
 * ⛔ HOST POLICY: an unprivileged user namespace refused by AppArmor
 * (kernel.apparmor_restrict_unprivileged_userns=1) is named as such, with both fixes
 * (userNamespaceRefusal). WEBCTL_UNSHARE_BIN — an absolute path to an executable — replaces
 * `unshare` in EVERY invocation, so a host can grant userns to one dedicated binary.
 * @param {string[]} a
 * @returns {Promise<number>}
 */
function runIsolated(a) {
  const sep = a.indexOf('--');
  const opts = sep < 0 ? a : a.slice(0, sep);
  const command = sep < 0 ? [] : a.slice(sep + 1);
  /** @type {string[]} */
  const keeps = [];
  /** @type {string[]} */
  const keepsRo = [];
  /** @type {string[]} */
  const pass = [];
  let bad = sep < 0 || command.length === 0;
  for (let i = 0; i < opts.length && !bad; i++) {
    if (opts[i] === '--keep' && opts[i + 1]) keeps.push(opts[++i]);
    else if (opts[i] === '--keep-ro' && opts[i + 1]) keepsRo.push(opts[++i]);
    else if (opts[i] === '--pass-env' && i + 1 < opts.length) pass.push(opts[++i]);
    else bad = true;
  }
  if (bad) return Promise.resolve(usageRefusal('expected `-- <cmd> [args…]` after the options', command));
  // ⚠ the refusal names the RULE and the option's position, never the value
  for (const [i, p] of pass.entries()) {
    if (!PASS_ENV_RE.test(p)) {
      return Promise.resolve(usageRefusal(`--pass-env #${i + 1} is not an env NAME or a PREFIX_* pattern `
        + '(letters, digits, `_`; a prefix ends in `_*`; a bare `*` is refused)', command));
    }
    if (SCRUBBED_ENV.includes(p)) {
      return Promise.resolve(usageRefusal(`--pass-env #${i + 1} names a var isolation always REMOVES (a host socket, `
        + 'display, address or state root) — set it inside the command instead', command));
    }
  }
  const ub = unshareBin();
  if (ub.why) return Promise.resolve(report('isolated', EXIT.fail, `NOT RUN: ${ub.why}. The command was NOT started.`, { command }));
  // ⛔ NESTED CALL: "already inside" is proven from the KERNEL. The marker alone is
  // trusted input — set on the host it would skip isolation entirely — so a marker
  // whose proof fails is REFUSED (no verdict, exit 2) before anything runs.
  if (process.env[HOST_NETNS_ENV] !== undefined) {
    const proof = kernelInsideProof();
    if (!proof.inside) {
      return Promise.resolve(report('isolated', EXIT.noVerdict,
        `REFUSED, nothing run: ${HOST_NETNS_ENV} is set, claiming we are already inside an isolated `
          + `namespace, but the kernel says otherwise — ${proof.why}. Unset it on the host; only `
          + '`isolated` sets it.', { command, namespace: proof.facts }));
    }
    // ⛔ A keep under the OUTER call's hidden home (or a hidden dir) is ENOENT here — "does not
    // exist" sent people hunting a typo (review of 5773fb8, 8a). Only the OUTER call can re-bind it.
    const outerHidden = recordedPaths(HIDDEN_ENV) || [];
    for (const [label, p] of [...keeps.map((p, i) => [`--keep #${i + 1}`, p]), ...keepsRo.map((p, i) => [`--keep-ro #${i + 1}`, p])]) {
      if (fs.existsSync(p) || !outerHidden.some((h) => isWithin(path.resolve(p), h))) continue;
      return Promise.resolve(usageRefusal(`${label} lies under a dir the OUTER \`isolated\` call HIDES (its home, ~/.ssh, `
        + 'a state root) — it is not visible here; keep it in the OUTER call instead (--keep / --keep-ro there)', command));
    }
    const nestedPlan = planKeeps(keeps, [], { home: '', roots: recordedRoRoots() || [], sensitive: [], hidden: [], hideRule: [] }, keepsRo);
    if (nestedPlan.usage) return Promise.resolve(usageRefusal(nestedPlan.usage, command));
    // ⛔ and still capless: a nested call must not be the way back to capabilities — its
    // command, too, enters a uid-mapped child user namespace (read back as on the fresh path)
    // ⛔ …and still a fresh PID namespace. A nested call used to share its caller's, so
    // the command could see and signal the process that called it. Two lanes' own arms ("a
    // pid outside cannot be signalled from inside") failed ONLY under the gate, where their
    // `isolated` is nested in the gate's (measured on the v0.32.0 gate run). The network and
    // the masks are inherited (already isolated); the process table is not.
    // ⛔ setpriv, unshare and pid 1's bash from the SYSTEM dirs, never the caller's PATH
    const nt = privilegedTools(ub, true);
    if (nt.why) return Promise.resolve(report('isolated', EXIT.fail, `NOT RUN: ${nt.why}. The command was NOT started.`, { command }));
    const priv = privilegeDrop(recordedHostIds(), nt.tools, { pidns: true });
    if (priv.why) {
      return Promise.resolve(report('isolated', EXIT.fail, `NOT RUN: ${priv.why}. The command was NOT started.`, { command }));
    }
    // pid 1 is the reaping bash (PID1_REAPER); the node helper under it gives the command default
    // signal dispositions (a bash background job would IGNORE SIGINT)
    // fd 3: the helper's `started`; fd 4: the command's env (the chain itself gets privilegedEnv)
    return runCommand([nt.tools.bash, ...PID1_BASH_FLAGS, PID1_REAPER, 'webctl-isolated-pid1', ...pid1HelperArgv(command, 4, true)],
      priv.prefix, { pastUnshare: true, env: isolatedEnv(process.env, pass) });
  }
  let hostNs = '';
  let hostMnt = '';
  let hostPid = '';
  try {
    hostNs = fs.readlinkSync('/proc/self/ns/net');
    hostMnt = fs.readlinkSync('/proc/self/ns/mnt');
    hostPid = fs.readlinkSync('/proc/self/ns/pid');
  } catch (e) {
    return Promise.resolve(report('isolated', EXIT.fail,
      `cannot read this process's namespaces (${errMsg(e)}), so isolation cannot be PROVEN; `
      + 'refusing to run the command on the host'));
  }
  // ⇩ WHO: the real uid/gid and home — under an outer `unshare -r` getuid() is 0 (realIdentity)
  const ident = realIdentity();
  if (ident.refuse) {
    return Promise.resolve(report('isolated', EXIT.fail, `NOT RUN: ${ident.refuse}. The command was NOT started.`, { command }));
  }
  const prot = protectedRoots(ident.home);
  if (prot.refuse) {
    return Promise.resolve(report('isolated', EXIT.fail, `NOT RUN: ${prot.refuse}. The command was NOT started.`, { command }));
  }
  const plan = planKeeps(keeps, [
    { p: process.cwd(), label: 'the working directory', rw: true, named: true, noHidden: true },
    // ⛔ READ-ONLY: under the release gate ONE base checkout serves every consumer in turn,
    // so a mutant writing into it would change what the NEXT consumer is judged against —
    // and it is the harness's own code. base's own suite runs with cwd = its root, which
    // re-opens it writable through the cwd.
    { p: SELF_ROOT, label: "base's repo root", rw: false },
    ...(path.isAbsolute(command[0]) ? [{ p: command[0], label: 'the command', rw: false }] : []),
    { p: process.execPath, label: 'node', rw: false },
    // the inner half and every nested call run it again, from INSIDE the masks
    ...(ub.override ? [{ p: ub.bin, label: UNSHARE_BIN_ENV, rw: false }] : []),
    // a throwaway HOME under /tmp is the arm's own (the family's sandboxes isolate HOME)
    ...(throwawayHome(ident.home) ? [{ p: throwawayHome(ident.home), label: 'HOME', rw: true }] : []),
    // ⛔ the HIDDEN home: every PATH entry under it is re-bound READ-ONLY, or tools vanish
    ...pathEntriesUnder(ident.home).map(({ p, n }) => ({ p, label: `PATH entry #${n}`, rw: false, rule: true })),
  ], prot, keepsRo);
  if (plan.usage) return Promise.resolve(usageRefusal(plan.usage, command));
  if (plan.refuse) {
    return Promise.resolve(report('isolated', EXIT.fail,
      `NOT RUN: ${plan.refuse}. The command was NOT started.`, { command }));
  }
  const sockets = hostPathSockets();
  if (!sockets) {
    return Promise.resolve(report('isolated', EXIT.fail,
      'NOT RUN: /proc/self/net/unix is unreadable, so the host\'s unix sockets cannot be listed and '
      + 'their masking cannot be PROVEN. The command was NOT started.', { command }));
  }
  // ⛔ every tool the privileged halves run: from the SYSTEM dirs, resolved HERE, passed on by path
  const { tools, why: noTool } = privilegedTools(ub, false);
  if (noTool) return Promise.resolve(report('isolated', EXIT.fail, `NOT RUN: ${noTool}. The command was NOT started.`, { command }));
  for (const n of plan.notes) process.stderr.write(`isolated: note: ${n}\n`);
  // ⭐ STRIPPED MARKERS: no HOST_NETNS, yet the KERNEL says we are inside one of ours — our tmpfs
  // tag on /run and /tmp and a lo-only network. Measured: such a call isolates AGAIN, fully
  // (its own netns and pidns, the home hidden again); never "only inherited". Say so.
  const inside = unmaskedDirs().length === 0 && extraInterfaces() === 0
    ? '; ALREADY INSIDE an isolated namespace whose markers were stripped — isolated AGAIN, fully' : '';
  process.stderr.write(`${verdictLine(plan.binds, prot.home, process.env[VERBOSE_ENV] === '1', inside)}\n`);
  // ⇩ the REAL uid/gid, resolved HERE (inside, getuid() is 0). The command runs as them (privilegeDrop).
  const ids = { uid: ident.uid, gid: ident.gid };
  // the COMMAND's env: the allowlist + our markers. It travels in the plan (fd 4) and is applied
  // only when the command is spawned; every half before that gets privilegedEnv() of it.
  const cmdEnv = isolatedEnv(process.env, pass, { [HOST_NETNS_ENV]: hostNs, [HOST_MNTNS_ENV]: hostMnt, [HOST_PIDNS_ENV]: hostPid,
    // the home is recorded as HIDDEN (fact 8: its read-only mask), not as a ro root — under its
    // 0555 tmpfs access(W_OK) answers EACCES before EROFS (mode bits are checked first)
    [RO_ROOTS_ENV]: JSON.stringify(prot.roots), [HIDDEN_ENV]: JSON.stringify([prot.home, ...prot.hidden]),
    [HOST_IDS_ENV]: JSON.stringify(ids) });
  const payload = JSON.stringify({ hostMnt, cwd: process.cwd(), binds: plan.binds, roots: prot.roots, hidden: prot.hidden,
    home: prot.home, exempt: plan.exempt, sockets, ids, env: cmdEnv, tools });
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    /** @type {ReturnType<typeof statusChannel> | null} */
    let st = null;
    // ⛔ the forwarder BEFORE the spawn (review finding 5): no tick in which a TERM meets the default
    const fwd = forwardSignalsPastUnshare(() => !!st && st.started());
    try {
      child = spawn(ub.bin,
        // --pid --fork --mount-proc: a private PID namespace with its own /proc, so no host
        // process can be signalled or even seen. --kill-child: if unshare dies, so does
        // everything inside (pid 1 is the reaping bash, PID1_REAPER; the inner half runs under it).
        ['-rnm', '--pid', '--fork', '--mount-proc', '--kill-child', '--propagation=private',
          tools.bash, ...PID1_BASH_FLAGS, PID1_REAPER, 'webctl-isolated-pid1',
          process.execPath, SELF, ISOLATED_INNER, hostNs, '--', ...command],
        // ⛔ the PRIVILEGED env: unshare, pid 1 and the inner half (namespace root, full caps, before
        // any mask) never see NODE_OPTIONS, LD_*, or any --pass-env (PRIVILEGED_PASS_ENV)
        { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'], env: privilegedEnv(cmdEnv) });
    } catch (e) {
      fwd.remove();
      resolve(report('isolated', EXIT.fail, `cannot start unshare (${errMsg(e)}); refusing to run on the host`));
      return;
    }
    const status = statusChannel(child);
    st = status;
    fwd.attach(child);
    const planPipe = /** @type {import('node:stream').Writable | null | undefined} */ (child.stdio[4]);
    planPipe?.on('error', () => { /* the inner side refused or never started */ });
    planPipe?.end(payload);
    let spawnErr = '';
    child.on('error', (e) => { spawnErr = errMsg(e); });
    child.on('close', (code, signal) => {
      const fail = status.text().match(/^fail (.*)$/m);
      if (status.started() && !fwd.early?.()) { resolve(exitOrDieBy(fwd, code, signal)); return; }
      // signalled before the command started (or we killed it then): die by it too — no verdict
      dieByForwarded(fwd);
      const why = fail ? fail[1]
        : spawnErr ? `unshare could not be started (${spawnErr}) — is util-linux installed`
          : diagnoseUserNamespace(ub.bin) || `unshare exited ${code ?? signal} before the isolated side reported in — unprivileged `
            + 'user namespaces may be disabled (kernel.unprivileged_userns_clone / '
            + 'user.max_user_namespaces); unshare\'s own message, if any, is above';
      resolve(report('isolated', EXIT.fail,
        `NOT RUN: ${why}. The command was NOT started, and is never run on the host as a fallback.`,
        { command }));
    });
  });
}

/** `1`: the verdict line lists EVERY re-bound path (as `~/…`), implicit ones included. */
const VERBOSE_ENV = 'WEBCTL_ISOLATED_VERBOSE';

/**
 * The verdict on the hidden home: `isolated: home HIDDEN; re-bound read-only: …; writable: …`.
 *
 * ⛔ It used to list EVERY re-bind under the home as `~/…` — on an operator host ~95 PATH
 * entries, naming private repos — and the gate tees this line into logs (review of 5773fb8).
 * base is PUBLIC; its rule is that verdicts carry COUNTS, never paths. ⇒ Listed by path: only
 * what the caller NAMED (cwd, --keep, --keep-ro). Implicit re-binds are COUNTED (`N PATH
 * entries`) or named by LABEL (base's repo root, node, the command, WEBCTL_UNSHARE_BIN), with a
 * pointer to the opt-in. `verbose` (WEBCTL_ISOLATED_VERBOSE=1): every path, as `~/…`, as before.
 * @param {Bind[]} binds @param {string} home @param {boolean} verbose @param {string} [more] appended before the pointer
 * @returns {string}
 */
function verdictLine(binds, home, verbose, more = '') {
  const tilde = (/** @type {string} */ p) => (p === home ? '~' : `~/${path.relative(home, p)}`);
  let counted = false;
  const list = (/** @type {boolean} */ rw) => {
    const under = binds.filter((b) => b.rw === rw && isWithin(b.p, home));
    if (verbose) return under.map((b) => tilde(b.p)).sort().join(', ') || 'nothing';
    const named = under.filter((b) => b.named).map((b) => tilde(b.p)).sort();
    const paths = under.filter((b) => !b.named && /^PATH entry #/.test(b.label || '')).length;
    const labels = [...new Set(under.filter((b) => !b.named && !/^PATH entry #/.test(b.label || '')).map((b) => b.label || 'a re-bind'))].sort();
    const implicit = [...(paths ? [`${paths} PATH entr${paths === 1 ? 'y' : 'ies'}`] : []), ...labels];
    if (implicit.length) counted = true;
    return [...named, ...implicit].join(', ') || 'nothing';
  };
  const ro = list(false);
  const rw = list(true);
  return `isolated: home HIDDEN; re-bound read-only: ${ro}; writable: ${rw}${more}`
    + (counted ? ` — ${VERBOSE_ENV}=1 lists every path` : '');
}

/** @param {unknown} e */
function errMsg(e) { return e instanceof Error ? e.message : String(e); }

/**
 * The half that runs INSIDE the namespaces. Proves the PROPERTY — no host network,
 * no host unix sockets — not its proxy ("unshare exited 0"):
 *
 *   1. the network namespace differs from the caller's;
 *   2. the namespace's ONLY interface is `lo` (/proc/self/net/dev is per-netns);
 *   3. nothing LISTENS on TCP here (/proc/self/net/tcp{,6} — the host's browser
 *      would appear here if this were the host's namespace);
 *   4. the mount namespace differs from the caller's;
 *   5. `lo` is brought up (`ip`, else `ifconfig`) and a self-connect on
 *      127.0.0.1 works, so local fakes and stubs still run;
 *   6. /run, /tmp (and a real /var/run) are covered with a fresh tmpfs, the passwd home
 *      HIDDEN under an empty read-only one, the sensitive roots outside it made read-only
 *      with every submount, the kept paths bound back — and /proc/self/mountinfo then SHOWS
 *      our tmpfs on top, NO writable mount under a ro root or ro re-bind outside a writable
 *      keep, and the home and each hidden dir RESOLVING to our read-only hide;
 *   7. every host path socket the outer half listed (except under a `--keep`) is
 *      connect-tested; one that still answers gets /dev/null bound over it and is
 *      tested again. Any that still answers → refuse.
 *
 * ⇒ (2) and (3) also make this verb useless as a bypass: called directly on the
 * host it refuses, whatever namespace id it is handed.
 * @param {string[]} a
 * @returns {Promise<number>}
 */
async function runIsolatedInner(a) {
  /** @param {string} line */
  const tell = (line) => { try { fs.writeSync(3, `${line}\n`); return true; } catch { return false; } };
  const refuse = (/** @type {string} */ why) => {
    // no status channel = not run via `isolated` (e.g. called on the host): report it here
    if (!tell(`fail ${why}`)) report('isolated', EXIT.fail, `NOT RUN: ${why}. The command was NOT started.`);
    return EXIT.fail;
  };
  const [hostNs, sep, ...command] = a;
  if (!hostNs || sep !== '--' || command.length === 0) return refuse('internal: malformed inner invocation');
  // ⚠ We run under the reaping bash pid 1, which forwards INT/TERM/HUP to us. Until the
  // command runs (runCommand forwards from then on), a termination signal ends us — and the
  // namespace with us — rather than letting the command start after the caller gave up.
  const SIGS = /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);
  const early = (/** @type {NodeJS.Signals} */ s) => process.exit(128 + (os.constants.signals[s] || 1));
  for (const s of SIGS) process.on(s, early);

  let ns = '';
  try { ns = fs.readlinkSync('/proc/self/ns/net'); } catch (e) {
    return refuse(`cannot read the namespace id inside (${errMsg(e)})`);
  }
  if (ns === hostNs) {
    return refuse(`still in the CALLER'S network namespace (${ns}) — whatever ran as 'unshare' did not `
      + 'isolate the network');
  }
  const extra = extraInterfaces();
  if (extra !== 0) {
    return refuse(extra < 0 ? 'cannot list interfaces (/proc/self/net/dev unreadable)'
      : `the namespace has ${extra} interface(s) besides 'lo' — it is not a private network `
        + 'namespace and can reach beyond itself');
  }
  if (uidMapKind() !== 'mapped') {
    return refuse(`/proc/self/uid_map is ${uidMapKind()}, not a user-namespace mapping — this is not `
      + "the namespace 'unshare -rn' creates");
  }
  let listeners = 0;
  for (const f of ['/proc/self/net/tcp', '/proc/self/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; } // tcp6 may be absent (ipv6 off)
    listeners += txt.split('\n').slice(1).filter((l) => l.trim().split(/\s+/)[3] === '0A').length;
  }
  if (listeners > 0) {
    return refuse(`${listeners} TCP listener(s) are visible inside — this is not a fresh namespace`);
  }

  // ⇩ only now, provably off the host network, read the plan. (On the host the
  // proofs above refuse first, so an unrelated fd 4 is never read.)
  /** @type {{hostMnt: string, cwd: string, binds: Bind[], roots: string[], hidden: string[], home: string, exempt: string[], sockets: string[], ids: unknown, env: Record<string, string>, tools: Tools}} */
  let plan;
  try {
    // node's stdio 'pipe' is a socketpair, not a FIFO; anything else is not ours
    const st = fs.fstatSync(4);
    if (!st.isSocket() && !st.isFIFO()) throw new Error('fd 4 is not a pipe');
    plan = JSON.parse(fs.readFileSync(4, 'utf8'));
    try { fs.closeSync(4); } catch { /* the command must not inherit it */ }
    const strs = (/** @type {unknown} */ x) => Array.isArray(x) && x.every((s) => typeof s === 'string');
    const binds = (/** @type {unknown} */ x) => Array.isArray(x)
      && x.every((b) => b && typeof b.p === 'string' && typeof b.rw === 'boolean');
    if (typeof plan.hostMnt !== 'string' || typeof plan.cwd !== 'string' || !binds(plan.binds)
      || typeof plan.home !== 'string' || !path.isAbsolute(plan.home)
      || !strs(plan.roots) || !strs(plan.hidden) || !strs(plan.exempt) || !strs(plan.sockets) || !hostIdsOf(plan.ids)
      || !isEnvObject(plan.env) || !isTools(plan.tools)) throw new Error('malformed');
  } catch (e) {
    return refuse(`internal: no masking plan on fd 4 (${errMsg(e)}) — run via \`isolated\``);
  }
  let mnt = '';
  try { mnt = fs.readlinkSync('/proc/self/ns/mnt'); } catch (e) {
    return refuse(`cannot read the mount namespace id inside (${errMsg(e)})`);
  }
  if (mnt === plan.hostMnt) {
    return refuse(`still in the CALLER'S mount namespace (${mnt}) — whatever ran as 'unshare' did not `
      + 'create one, so the host\'s unix sockets cannot be masked');
  }

  // ⛔ the tools resolved on the HOST from the system dirs — never looked up on PATH in here
  MOUNT.bin = plan.tools.mount;
  const up = bringLoUp(plan.tools.lo);
  if (up) return refuse(up);
  try { await loopbackSelfTest(); } catch (e) {
    return refuse(`the namespace loopback does not work after bringing it up (${errMsg(e)})`);
  }

  const masked = maskSocketDirs(plan.binds, plan.roots, plan.hidden, plan.home);
  if (masked) return refuse(masked);
  const unmasked = unmaskedDirs();
  if (unmasked.length) {
    return refuse(`after masking, ${unmasked.join(', ')} still lack(s) the '${MASK_SOURCE}' tmpfs on top`);
  }
  // ⭐ ASSERT THE PROPERTY: every mount reachable under a protected root, or under a
  // read-only keep, is ro — except beneath a writable keep. Read back from the kernel.
  const mounts = readMountinfo();
  const gaps = mounts ? readOnlyGaps(mounts, [...plan.roots, ...plan.binds.filter((b) => !b.rw).map((b) => b.p)],
    plan.binds.filter((b) => b.rw).map((b) => b.p)) : null;
  if (!gaps) return refuse('cannot read /proc/self/mountinfo to verify the home directory is read-only');
  if (gaps.length) {
    return refuse(`after the read-only step, ${gaps.length} mount(s) under the home directory or a read-only `
      + 'keep are still WRITABLE (or not mounted at all)');
  }
  // ⭐ …and the home and every hidden dir RESOLVE to our empty read-only tmpfs (their own, or an
  // ancestor's), unless an explicit `--keep` is exactly there — a later mount on an ancestor
  // shadows a hide. ⛔ ONLY an explicit keep (plan.exempt): exempting every bind let a cwd (or
  // any implicit re-bind) at a hidden dir through (review of 5773fb8)
  const allHidden = [plan.home, ...plan.hidden];
  const shown = hiddenGaps(mounts, allHidden, plan.exempt);
  if (shown.length) {
    return refuse(`after hiding, ${shown.length} of ${allHidden.length} hidden dir(s) (the home, ~/.ssh, ~/.gnupg, the `
      + `state roots) do not resolve to the read-only '${HIDE_SOURCE}' tmpfs`);
  }
  const res = await closeResidualSockets(plan.sockets, plan.exempt);
  if (res.still > 0) {
    return refuse(`${res.still} of ${res.checked} host path socket(s) still ANSWER after masking `
      + `(${res.listed} listed, ${res.exempt} exempt under --keep, ${res.covered} covered with /dev/null, `
      + `${res.coverFailed} of those covers failed)`);
  }
  // ⛔ The cwd we inherited is a reference to the OLD directory — through it the
  // command would still see the unmasked /tmp. Re-enter it BY PATH.
  try { process.chdir(plan.cwd); } catch (e) {
    return refuse(`cannot re-enter the working directory after masking (${errMsg(e).split(plan.cwd).join('<cwd>')})`);
  }

  // ⛔ LAST, after every mount: the command runs as the real uid in a child user namespace —
  // NO capabilities, so it cannot undo them, yet free to make namespaces of its own.
  const priv = privilegeDrop(hostIdsOf(plan.ids), plan.tools);
  if (priv.why) return refuse(priv.why);

  if (!tell('started')) return refuse('internal: the status channel (fd 3) is missing — run via `isolated`');
  try { fs.closeSync(3); } catch { /* the command must not inherit it */ }

  // the command's env (plan.env) goes to the helper on ITS fd 3 — setpriv/unshare of the drop run
  // with OUR (privileged) env, so an LD_* the caller passed never runs with our capabilities.
  // ⛔ runCommand installs its forwarder SYNCHRONOUSLY, before its spawn; only THEN is `early`
  // removed — a listener is present throughout, so a TERM never meets the default (finding 5)
  const ran = runCommand(pid1HelperArgv(command, 3, false), priv.prefix, { env: plan.env });
  for (const s of SIGS) process.off(s, early);
  return ran;
}

/**
 * The directories that get a fresh tmpfs: where host sockets live. Real paths;
 * /run first (the keeps are staged in the NEW /run), /tmp last. /var/run only when it
 * is a REAL directory — usually it is a symlink into /run, which /run already covers.
 * @returns {{run: string, tmp: string, all: string[]}}
 */
function maskedDirs() {
  const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const run = real('/run');
  const tmp = real('/tmp');
  const all = [run];
  try { if (fs.lstatSync('/var/run').isDirectory()) all.push('/var/run'); } catch { /* absent */ }
  all.push(tmp);
  return { run, tmp, all };
}

/**
 * $HOME when it is strictly beneath /tmp (a sandbox's throwaway home), else ''. Never the
 * PASSWD home (or anything containing it), even under /tmp: that would re-open it writable.
 * @param {string} pwHome the real user's passwd home (realIdentity)
 */
function throwawayHome(pwHome) {
  const h = process.env.HOME;
  if (!h) return '';
  try {
    const real = fs.realpathSync(h);
    const { tmp } = maskedDirs();
    let pw = '';
    try { pw = fs.realpathSync(pwHome); } catch { /* none */ }
    if (pw && isWithin(pw, real)) return '';
    return real !== tmp && isWithin(real, tmp) ? real : '';
  } catch { return ''; }
}

/**
 * The PATH entries whose REAL path is the home or beneath it, with their 1-based position in
 * PATH (refusals name the position, never the path). Relative and missing entries are skipped.
 * ⚠ Bound at the REAL path: an entry that reaches into the home through a symlink OUTSIDE it
 * is re-bound at its real path only (list that, or `--keep-ro` it).
 * @param {string} home realpath'd @returns {{p: string, n: number}[]}
 */
function pathEntriesUnder(home) {
  /** @type {{p: string, n: number}[]} */ const out = [];
  for (const [i, d] of String(process.env.PATH || '').split(':').entries()) {
    if (!path.isAbsolute(d)) continue;
    let real = '';
    try { real = fs.realpathSync(d); } catch { continue; }
    if (home && isWithin(real, home)) out.push({ p: real, n: i + 1 });
  }
  return out;
}

/** Is `p` equal to `dir` or beneath it? @param {string} p @param {string} dir */
function isWithin(p, dir) { return p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`); }

/**
 * The id `id` of THIS user namespace is, one level up, in its PARENT — per /proc/self/{uid,gid}_map.
 * `identity` when the map is the full identity map (the initial namespace, or one just like
 * it); `outside` -1 when `id` is in no extent (unmapped) or the map is unreadable.
 * @param {string} file @param {number} id @returns {{outside: number, identity: boolean}}
 */
function parentIdOf(file, id) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return { outside: -1, identity: false }; }
  const ext = txt.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((e) => e.length === 3);
  if (ext.length === 1 && ext[0][0] === 0 && ext[0][1] === 0 && ext[0][2] === 4294967295) return { outside: id, identity: true };
  const hit = ext.find(([inside, , count]) => id >= inside && id < inside + count);
  return { outside: hit ? hit[1] + (id - hit[0]) : -1, identity: false };
}

/**
 * The passwd home of `uid`: `getent passwd <uid>` (NSS: LDAP/sssd/homed users too), else
 * /etc/passwd parsed directly. '' when there is no entry. ⚠ Not os.userInfo(): under an outer
 * `unshare -r` that answers for uid 0 — root's home.
 * @param {number} uid @returns {{home: string, conflict: boolean}}
 */
function passwdHomeOf(uid) {
  /** @param {string} l */
  const homeOf = (l) => { const f = l.split(':'); return f.length >= 7 && f[2] === String(uid) ? f[5] : ''; };
  // ⛔ getent by ABSOLUTE path, never by PATH: under an outer \`unshare -r\`, a \`getent\` earlier
  // on PATH that answered a self-owned dir under /tmp made the REAL home writable — the
  // "home" was then dropped as hidden by the mask, so nothing was protected (measured by
  // the final review). And the two sources are CROSS-CHECKED: where both answer, they must
  // agree, or nobody can say whose home this is.
  let viaNss = '';
  for (const bin of ['/usr/bin/getent', '/bin/getent']) {
    if (!fs.existsSync(bin)) continue;
    const r = spawnSync(bin, ['passwd', String(uid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    viaNss = r.status === 0 ? homeOf(String(r.stdout).split('\n')[0]) : '';
    break;
  }
  let viaFile = '';
  try { viaFile = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(homeOf).find(Boolean) || ''; } catch { /* none */ }
  if (viaNss && viaFile && viaNss !== viaFile) return { home: '', conflict: true };
  return { home: viaNss || viaFile, conflict: false };
}

/**
 * WHO the arm runs on behalf of: the REAL uid/gid and their passwd home. Read on the host
 * side, at entry.
 *
 * ⛔ UNDER AN OUTER `unshare -r` (lanes self-isolate with `unshare -rn` and may call
 * `isolated` inside it) getuid() is 0 and os.userInfo() is ROOT: the "read-only home" was
 * root's, and the REAL home stayed writable — measured by the final review, a file appeared
 * in it. ⇒ In a user namespace that is not the identity map, two candidates are tried:
 *   1. the OUTSIDE id of /proc/self/{uid,gid}_map (one level up) — the `unshare -r` case;
 *   2. our own uid/gid — a namespace that maps the real uid NUMBER onto its parent's root
 *      (`unshare --map-user=<uid>`, as `isolated`'s own child namespace does).
 * A candidate is accepted only when its passwd home is OWNED BY US as the kernel shows it
 * here (stat uid === getuid()): the same on-disk owner as this process. That is a kernel
 * fact, not a guess about how the namespaces were stacked.
 * ⛔ Nothing accepted → refuse, never a quiet no-op: an unmapped id; a stack of `unshare -r`
 * (uid 0 mapped onto 0 — the real uid is further up and cannot be read from here); no
 * passwd entry (nothing to protect would be a SILENT gap — refused, not noted); a home not
 * owned by us or absent.
 * ⚠ Refusals name no id and no path: they get pasted into a public repo's logs.
 * @returns {{uid: number, gid: number, home: string, refuse: string}}
 */
function realIdentity() {
  const none = (/** @type {string} */ refuse) => ({ uid: -1, gid: -1, home: '', refuse });
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  const u = parentIdOf('/proc/self/uid_map', uid);
  const g = parentIdOf('/proc/self/gid_map', gid);
  if (u.outside < 0 || g.outside < 0) {
    return none('cannot resolve the real uid/gid: this process\'s ids are not mapped in /proc/self/uid_map or gid_map');
  }
  const noEntry = 'the real user has NO passwd entry, so there is no home directory to make read-only — '
    + 'refusing rather than running with the home unprotected';
  if (u.identity) {
    let home = '';
    try { home = os.userInfo().homedir; } catch { /* below */ }
    if (!home) return none(noEntry);
    try { return { uid, gid, home: fs.realpathSync(home), refuse: '' }; } catch {
      return none('the real user\'s passwd home directory does not exist here, so it cannot be made read-only');
    }
  }
  /** @type {{uid: number, gid: number}[]} */
  const cands = [];
  if (u.outside > 0) cands.push({ uid: u.outside, gid: g.outside });
  if (uid > 0 && uid !== u.outside) cands.push({ uid, gid });
  if (cands.length === 0) {
    return none('cannot resolve the real uid: this user namespace maps uid 0 onto uid 0 of its PARENT (a stack '
      + 'of `unshare -r`?) — the real uid is further up and cannot be read from here. Call `isolated` from the '
      + 'host or from directly inside ONE `unshare -r`');
  }
  let entries = 0;
  for (const c of cands) {
    const { home, conflict } = passwdHomeOf(c.uid);
    if (conflict) {
      return none('the passwd database and /etc/passwd DISAGREE about the real user\'s home, so it is unknown '
        + 'which directory to make read-only');
    }
    if (!home) continue;
    entries++;
    try {
      if (fs.statSync(home).uid === uid) return { ...c, home: fs.realpathSync(home), refuse: '' };
    } catch { /* absent: not accepted */ }
  }
  return none(entries === 0 ? noEntry
    : 'cannot resolve the real user: no candidate uid\'s passwd home is owned by this process here, so it '
      + 'is unknown whose home to make read-only');
}

/**
 * What `isolated` protects, from the PASSWD home (realpath):
 *
 *   * `home` — HIDDEN whole (v0.33.0): an empty read-only tmpfs over it; what the arm needs is
 *     re-bound on top (planKeeps). ⛔ A fixed hidden list missed every secret nobody listed —
 *     a read-only home is still a READABLE one.
 *   * `roots` — READ-ONLY: the real path of every SENSITIVE_DOTDIRS entry that is a symlink OUT
 *     of home (a ~/.cache on a bigger disk still holds the profiles; the home tmpfs hides only
 *     the symlink). Roots under a masked dir are dropped; nested roots collapse to the outer one.
 *   * `hidden` — the real path of every HIDDEN_DIRS entry that exists, outer ones only, minus any
 *     already hidden by the /run or /tmp mask: each gets its OWN empty tmpfs wherever a re-bind
 *     would otherwise expose it (a `--keep ~/.config` does not unhide ~/.config/webctl), and
 *     always when it lies outside the home. One that CONTAINS /run, /tmp or the home is refused.
 *   * `hideRule` — every HIDDEN_DIRS path, nominal AND real, existing or not: a PATH entry or
 *     `--keep-ro` inside or containing one is REFUSED (planKeeps).
 *
 * ⚠ Computed on the HOST side only, from realIdentity()'s home: inside the user namespace
 * we are uid 0, and os.userInfo() there answers root's home, not the caller's.
 * @param {string} home the real user's passwd home, realpath'd (realIdentity)
 * @returns {Prot & {refuse?: string}}
 */
function protectedRoots(home) {
  /** @type {{name: string, real: string}[]} */
  const sensitive = [];
  for (const d of SENSITIVE_DOTDIRS) {
    try { sensitive.push({ name: `~/${d}`, real: fs.realpathSync(path.join(home, d)) }); } catch { /* absent */ }
  }
  const hideRule = [...new Set(HIDDEN_DIRS.flatMap((d) => {
    const nominal = path.join(home, d);
    try { return [nominal, fs.realpathSync(nominal)]; } catch { return [nominal]; }
  }))];
  const { all } = maskedDirs();
  const none = (/** @type {string} */ refuse) => ({ home, roots: [], sensitive, hidden: [], hideRule, refuse });
  if (all.some((m) => isWithin(m, home))) {
    return none('the home directory CONTAINS /run or /tmp, so it cannot be hidden without hiding the arm too');
  }
  if (all.some((m) => isWithin(home, m))) {
    // ⛔ A HOME under /run or /tmp would protect NOTHING: the mask hides it, and the real
    // files are elsewhere. That is the signature of a wrong passwd answer, so refuse.
    return none('the resolved home directory lies under /run or /tmp, so hiding it would protect nothing — '
      + 'refusing rather than leaving the real home exposed');
  }
  /** @type {string[]} */
  const hidden = [];
  const hideCands = HIDDEN_DIRS.map((d) => { try { return fs.realpathSync(path.join(home, d)); } catch { return ''; } })
    .filter((r) => r && !all.some((m) => isWithin(r, m))).sort((x, y) => x.length - y.length);
  for (const r of hideCands) {
    if (isWithin(home, r) || all.some((m) => isWithin(m, r))) {
      return none('the real path of a home directory isolation HIDES (~/.ssh, ~/.gnupg, a state root) CONTAINS the '
        + 'home, /run or /tmp, so hiding it would hide the arm too');
    }
    if (!hidden.some((o) => isWithin(r, o))) hidden.push(r);
  }
  /** @type {string[]} */
  const roots = [];
  const cands = sensitive.map((x) => x.real).filter((r) => !isWithin(r, home)).sort((x, y) => x.length - y.length);
  for (const r of cands) {
    if (all.some((m) => isWithin(m, r))) {
      return { ...none('a sensitive home directory\'s real path CONTAINS /run or /tmp, so it cannot be made read-only '
        + 'without undoing the socket masking'), hidden };
    }
    if (all.some((m) => isWithin(r, m))) continue; // hidden by the mask already
    if (!roots.some((o) => isWithin(r, o))) roots.push(r);
  }
  return { home, roots, sensitive, hidden, hideRule };
}

/**
 * @typedef {{home: string, roots: string[], sensitive: {name: string, real: string}[], hidden: string[], hideRule: string[]}} Prot
 */

/**
 * @typedef {{id: string, parent: string, at: string, opts: string[], fstype: string, source: string}} MountRow
 */

/**
 * Parse /proc/self/mountinfo. Mount points are OCTAL-ESCAPED there (`\040` = space).
 * @param {string} txt @returns {MountRow[]}
 */
export function parseMountinfo(txt) {
  const unesc = (/** @type {string} */ s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return txt.split('\n').filter(Boolean).map((l) => {
    const [pre, post = ''] = l.split(' - ');
    const f = pre.split(' ');
    const g = post.split(' ');
    return { id: f[0], parent: f[1], at: unesc(f[4] || ''), opts: (f[5] || '').split(','),
      fstype: g[0], source: unesc(g[1] || '') };
  });
}

/**
 * The mounts REACHABLE by path at or beneath `root`, topmost-at-root first — i.e. the set
 * a ro remount must cover. `null` when nothing is mounted AT root.
 *
 * ⛔ A ro remount of an rbind hits only its TOP mount; every submount stays writable
 * (measured: `touch` into a submount succeeded after the top was remounted ro). So each
 * reachable submount is listed. Unreachable ones are left out — a remount by path could
 * not reach them, and neither can a write:
 *   * one with a mount stacked on it at the SAME path (only the top of a stack is seen);
 *   * one whose path a SIBLING mounted later on an ancestor directory shadows.
 * @param {MountRow[]} mounts @param {string} root @returns {MountRow[]|null}
 */
export function reachableMountsUnder(mounts, root) {
  /** @param {MountRow} m @returns {MountRow} the top of the stack on m */
  const topOf = (m) => {
    const on = mounts.filter((c) => c.parent === m.id && c.at === m.at);
    if (on.length === 0) return m;
    return topOf(on.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a)));
  };
  const atRoot = mounts.filter((m) => m.at === root);
  // the bottom of the stack at root: a mount whose parent is NOT another mount at root
  let bottom = atRoot.filter((m) => !atRoot.some((o) => o.id === m.parent));
  if (bottom.length === 0) return null;
  // ⛔ Two stacks at one path happen when an ANCESTOR was mounted over in between: a call nested
  // in `isolated` masks /tmp again, so the OUTER call's mount at a path and ours at the same path
  // both appear — the outer's unreachable under the new /tmp. Walking it too reported it "still
  // WRITABLE" (measured: a false FAIL of base's read-only root). ⇒ keep the stack path resolution
  // LANDS on (resolveMount); only when none matches, over-cover with all of them, as before.
  const live = resolveMount(mounts, root);
  const reached = bottom.filter((b) => live && topOf(b).id === live.id);
  if (reached.length) bottom = reached;
  /** @type {MountRow[]} */
  const out = [];
  /** @param {MountRow} m */
  const walk = (m) => {
    const top = topOf(m);
    out.push(top);
    const kids = mounts.filter((c) => c.parent === top.id && c.at !== top.at);
    for (const c of kids) {
      const shadowed = kids.some((o) => o !== c && o.at !== c.at && isWithin(c.at, o.at));
      if (!shadowed) walk(c);
    }
  };
  // several bottoms = several independent stacks at one path (not something mount(8)
  // produces); walk them all — over-covering is safe, under-covering is not.
  for (const b of bottom) walk(b);
  return out;
}

/**
 * Reachable mounts at/under each ro root that are still WRITABLE, except at/under a
 * writable keep. ⇒ The post-condition of the read-only step, read from the kernel.
 * @param {MountRow[]} mounts @param {string[]} roots @param {string[]} rwKeeps
 * @returns {{root: string, at: string}[]} '' at = nothing is mounted at that root
 */
export function readOnlyGaps(mounts, roots, rwKeeps) {
  /** @type {{root: string, at: string}[]} */
  const gaps = [];
  for (const r of roots) {
    const under = reachableMountsUnder(mounts, r);
    if (!under) { gaps.push({ root: r, at: '' }); continue; }
    for (const m of under) {
      if (rwKeeps.some((k) => isWithin(m.at, k))) continue;
      if (!m.opts.includes('ro')) gaps.push({ root: r, at: m.at });
    }
  }
  return gaps;
}

/**
 * The mount that path resolution of `p` LANDS ON, read from mountinfo: from the root mount,
 * descend into the child whose mount point is the CLOSEST ancestor-or-self of `p` — of two
 * children of one parent that both cover `p`, the shallower was mounted LATER and shadows the
 * deeper — then to the top of the stack there; repeat. null when there is no root mount.
 * @param {MountRow[]} mounts @param {string} p @returns {MountRow|null}
 */
export function resolveMount(mounts, p) {
  const ids = new Set(mounts.map((m) => m.id));
  /** @param {MountRow} m @returns {MountRow} */
  const topOf = (m) => {
    const on = mounts.filter((c) => c.parent === m.id && c.at === m.at && c !== m);
    return on.length ? topOf(on.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a))) : m;
  };
  const root = mounts.find((m) => m.at === '/' && (!ids.has(m.parent) || m.parent === m.id));
  if (!root) return null;
  let cur = topOf(root);
  for (;;) {
    const at = cur.at;
    const kids = mounts.filter((c) => c.parent === cur.id && c.at !== at && isWithin(p, c.at));
    if (kids.length === 0) return cur;
    cur = topOf(kids.reduce((a, b) => (b.at.length < a.at.length
      || (b.at.length === a.at.length && Number(b.id) > Number(a.id)) ? b : a)));
  }
}

/**
 * Hidden dirs (the home first) that do NOT resolve to our read-only HIDE_SOURCE tmpfs — their
 * own, or an ancestor's (a hidden dir under the home and under no re-bind is hidden by the
 * home's) — except one a keep is mounted at exactly (the caller's explicit exception).
 * ⛔ Resolved, not "the top of the stack AT the path" (review finding 7): a later mount on an
 * ANCESTOR shadows a hide that is still on top of its own stack.
 * @param {MountRow[]} mounts @param {string[]} hidden @param {string[]} keeps every bind's path
 * @returns {string[]}
 */
export function hiddenGaps(mounts, hidden, keeps) {
  return hidden.filter((h) => {
    if (keeps.includes(h)) return false;
    const m = resolveMount(mounts, h);
    return !(m && m.fstype === 'tmpfs' && m.source === HIDE_SOURCE && m.opts.includes('ro'));
  });
}

/** @returns {MountRow[]|null} null when /proc/self/mountinfo is unreadable */
function readMountinfo() {
  try { return parseMountinfo(fs.readFileSync('/proc/self/mountinfo', 'utf8')); } catch { return null; }
}

/**
 * rbind `root` onto itself and remount it AND every reachable submount read-only.
 * @param {string} root @param {boolean} rbindFirst false when `root` is already a mount
 *   of its own (a staged keep just moved back) @returns {string} '' on success, else why
 */
function makeTreeReadOnly(root, rbindFirst) {
  if (rbindFirst) {
    const e = mountOrWhy(['--rbind', root, root], 'bind a read-only root onto itself', [root]);
    if (e) return e;
  }
  const mounts = readMountinfo();
  if (!mounts) return 'cannot read /proc/self/mountinfo to find the submounts to make read-only';
  const under = reachableMountsUnder(mounts, root);
  if (!under) return 'a read-only root is not a mount point after binding it onto itself';
  const redact = under.map((m) => m.at).sort((x, y) => y.length - x.length);
  for (const [i, m] of under.entries()) {
    if (m.opts.includes('ro')) continue; // already read-only (e.g. staged `-o ro`); the post-check reads it back
    const e = mountOrWhy(['-o', 'remount,bind,ro', m.at],
      `remount mount ${i + 1} of ${under.length} under a protected root read-only`, redact);
    if (e) return e;
  }
  return '';
}

/**
 * @typedef {{p: string, rw: boolean, label?: string, named?: boolean}} Bind a real path re-exposed by
 *   its own mount; rw=false is READ-ONLY (base's repo root, node, the command: the arm reads them
 *   only). `label` names it in messages; `named`: the CALLER named this path (cwd, --keep,
 *   --keep-ro) — only those are listed by path in the verdict (verdictLine).
 */

/**
 * Decide what must stay visible once /tmp is masked and the home is HIDDEN, and with which
 * mode. ⚠ Messages name an item by its LABEL (and position), never by its path.
 *
 * A bind is needed for (a) any item strictly under /tmp — the mask hides it otherwise — (b) ANY
 * item under the hidden HOME (v0.33.0), (c) a WRITABLE item under a read-only root (a read-only
 * one there is covered by the root's own ro mount), (d) any item at or beneath a HIDDEN dir,
 * which its own empty tmpfs would hide, and (e) every `--keep-ro`, so it really is read-only.
 * Writable: the cwd, $HOME under /tmp, every `--keep`. Read-only: base's repo root, node, an
 * absolute command, WEBCTL_UNSHARE_BIN, every PATH entry under the home, every `--keep-ro`.
 *
 * ⛔ A PATH entry or `--keep-ro` (`rule`) is REFUSED if it IS the home, contains it, or contains
 * or lies inside a hidden dir (Prot.hideRule): re-bound read-only it would EXPOSE what the
 * hiding is for. A PATH entry's refusal is a FAIL (the caller's env), a `--keep-ro`'s a usage error.
 * ⚠ Only `--keep` (writable) paths are EXEMPT from the socket check — a socket on a read-only
 * mount still answers a connect.
 * @param {string[]} explicit `--keep` paths
 * @param {{p: string, label: string, rw: boolean, rule?: boolean, named?: boolean, noHidden?: boolean}[]} implicit
 * @param {Prot} prot
 * @param {string[]} [explicitRo] `--keep-ro` paths
 * @returns {{binds: Bind[], exempt: string[], notes: string[], usage?: string, refuse?: string}}
 */
function planKeeps(explicit, implicit, prot, explicitRo = []) {
  const { tmp, all } = maskedDirs();
  // ⚠ The roots hold the PASSWD home, not $HOME: os.homedir() honours $HOME, and an arm's
  // throwaway HOME under a kept scratch dir is exactly what a keep is for (measured: the
  // `--scratch` gate's layout was refused by the $HOME reading).
  /** @type {Bind[]} */ const binds = [];
  /** @type {string[]} */ const exempt = [];
  /** @type {string[]} */ const notes = [];
  const items = [...explicit.map((p, i) => ({ p, label: `--keep #${i + 1}`, explicit: true, rw: true, rule: false, named: true })),
    ...explicitRo.map((p, i) => ({ p, label: `--keep-ro #${i + 1}`, explicit: true, rw: false, rule: true, named: true })),
    ...implicit.map((k) => ({ rule: false, named: false, ...k, explicit: false }))];
  for (const k of items) {
    let real = '';
    try { real = fs.realpathSync(path.resolve(k.p)); } catch {
      if (k.explicit) return { binds, exempt, notes, usage: `${k.label} does not exist` };
      continue; // an absent command fails on its own (127), visibly
    }
    for (const m of all) {
      if (isWithin(m, real)) { // real IS a masked dir, or an ancestor of one
        if (k.explicit) {
          return { binds, exempt, notes, usage: `${k.label} is ${real === m ? m : `an ancestor of ${m}`} — `
            + 'keeping it would undo the masking; keep a test-owned directory beneath it' };
        }
        if (real === m) {
          return { binds, exempt, notes, refuse: `${k.label} is ${m} itself, which is masked — run from a `
            + 'test-owned directory beneath it' };
        }
        // e.g. cwd '/': nothing beneath it needs re-exposing
      } else if (m !== tmp && isWithin(real, m)) {
        const why = `${k.label} is beneath ${m}, where host sockets live, and cannot be re-exposed `
          + 'without re-exposing them';
        return k.explicit ? { binds, exempt, notes, usage: why } : { binds, exempt, notes, refuse: why };
      }
    }
    // ⛔ the HIDDEN home: a read-only re-bind must not bring back what hiding it is for
    if (k.rule && prot.home) {
      const bad = real === prot.home ? 'is the home directory'
        : isWithin(prot.home, real) ? 'contains the home directory'
          : prot.hideRule.some((h) => isWithin(real, h)) ? 'lies inside a HIDDEN dir'
            : prot.hideRule.some((h) => isWithin(h, real)) ? 'contains a HIDDEN dir' : '';
      if (bad) {
        const why = `${k.label} ${bad} (the home, ~/.ssh, ~/.gnupg, ~/.cache/CLIAI, ~/.config/CLIAI, ~/.local/state/CLIAI, `
          + '~/.config/webctl) — re-bound read-only, it would EXPOSE what isolation hides; '
          + (k.explicit ? 'keep a narrower path' : 'drop it from PATH for this call, or put a narrower dir there');
        return k.explicit ? { binds, exempt, notes, usage: why } : { binds, exempt, notes, refuse: why };
      }
    }
    // ⛔ The CWD at or beneath a hidden dir would be re-bound WRITABLE there — only an explicit
    // `--keep` may re-expose a hidden dir (review of 5773fb8: a cwd at ~/.ssh ran with it writable)
    if (k.noHidden && prot.hideRule.some((h) => isWithin(real, h))) {
      return { binds, exempt, notes, refuse: `${k.label} lies inside a HIDDEN dir (~/.ssh, ~/.gnupg, ~/.cache/CLIAI, `
        + '~/.config/CLIAI, ~/.local/state/CLIAI, ~/.config/webctl) — re-bound writable, it would EXPOSE what isolation '
        + 'hides; run from a directory outside it (an explicit --keep of a path there is still allowed)' };
    }
    // ⛔ A WRITABLE keep that IS (or contains) the home or a protected root re-opens all of it.
    const contained = [...(prot.home ? [prot.home] : []), ...prot.roots].find((r) => isWithin(r, real));
    if (contained && k.rw) {
      const what = contained === prot.home || !prot.home ? 'the home directory' : 'the real path of a sensitive home directory';
      if (k.explicit) {
        return { binds, exempt, notes, usage: `${k.label} contains ${what} — a keep is re-exposed WRITABLE and `
          + 'exempts the sockets beneath it, and home holds the browser profiles, ~/.config and the ssh '
          + 'sockets; keep a test-owned directory' };
      }
      return { binds, exempt, notes, refuse: `${k.label} contains ${what}, which isolation HIDES — `
        + 'run from a test-owned directory' };
    }
    if (contained) continue; // read-only and containing the home or a root: nothing beneath it is re-bound
    if (k.rw) {
      for (const sd of prot.sensitive) {
        if (isWithin(real, sd.real) || isWithin(sd.real, real)) {
          notes.push(`${k.label} ${isWithin(real, sd.real) ? 'is in' : 'contains'} ${sd.name} — re-exposed WRITABLE`
            + `${k.explicit ? ', and its sockets exempt from the socket check,' : ''} at the caller's request`);
          break;
        }
      }
    }
    const underHome = !!prot.home && isWithin(real, prot.home);
    const underRoot = prot.roots.some((r) => isWithin(real, r));
    const underHidden = prot.hidden.some((h) => isWithin(real, h));
    const keepRo = k.explicit && !k.rw;
    if ((isWithin(real, tmp) && real !== tmp) || underHome || (underRoot && k.rw) || underHidden || (keepRo && !underRoot)) {
      binds.push({ p: real, rw: k.rw, label: k.label, named: k.named });
    }
    if (k.explicit && k.rw) exempt.push(real);
  }
  // A path beneath another kept path is already re-exposed by it — unless the outer one is
  // read-only and the inner writable: then the inner gets its own (later) mount on top. ⚠ Or
  // unless a HIDDEN dir lies between them: its empty tmpfs goes on top of the outer one.
  const sorted = [...binds].sort((x, y) => x.p.length - y.p.length || Number(y.rw) - Number(x.rw));
  /** @type {Bind[]} */ const outer = [];
  const hiddenBetween = (/** @type {Bind} */ o, /** @type {Bind} */ b) => prot.hidden.some((h) => h !== o.p && isWithin(h, o.p) && isWithin(b.p, h));
  for (const b of sorted) if (!outer.some((o) => isWithin(b.p, o.p) && (o.rw || !b.rw) && !hiddenBetween(o, b))) outer.push(b);
  return { binds: outer, exempt, notes };
}

/**
 * PATH unix sockets in THIS network namespace (/proc/self/net/unix is per-netns):
 * the 8th column onward, absolute, unique. Abstract ones ('@…') are skipped — they
 * are per-netns, so a new network namespace already cannot reach them.
 * @returns {string[]|null} null when unreadable
 */
function hostPathSockets() {
  let txt = '';
  try { txt = fs.readFileSync('/proc/self/net/unix', 'utf8'); } catch { return null; }
  const out = new Set();
  for (const line of txt.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const p = f.slice(7).join(' ');
    if (p.startsWith('/')) out.add(p);
  }
  return [...out];
}

/**
 * The `mount` every masking step runs: the ABSOLUTE path the host resolved from the system dirs
 * (plan.tools.mount, set at the top of the inner half). '' until then — a mountOrWhy before it is
 * an internal error, never a PATH lookup.
 * ⚠ It used to be `mount` on PATH, then PINNED read-only under the new /run because a PATH dir
 * under the hidden home vanished mid-masking. A system dir never vanishes, so the pin is gone —
 * and so is the PATH lookup that let a planted `mount` run as namespace root (re-review of v0.33.0).
 */
const MOUNT = { bin: '' };

/**
 * Run `mount` (util-linux) with an argv ARRAY. @param {string[]} argv
 * @param {string} what for the reason @param {string[]} [redact] paths never to print
 * @returns {string} '' on success, else the reason
 */
function mountOrWhy(argv, what, redact = []) {
  if (!path.isAbsolute(MOUNT.bin)) return `cannot ${what}: internal: no system 'mount' was resolved`;
  const r = spawnSync(MOUNT.bin, argv, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error) {
    const err = /** @type {NodeJS.ErrnoException} */ (r.error);
    return `cannot ${what}: ${err.code === 'ENOENT' ? "'mount' not found — install util-linux" : errMsg(err)}`;
  }
  if (r.status === 0) return '';
  let msg = String(r.stderr || '').trim().split('\n').pop() || `exit ${r.status ?? r.signal}`;
  for (const p of redact) msg = msg.split(p).join('<path>');
  return `cannot ${what}: ${msg}`;
}

/**
 * Cover /run, /tmp (and a real /var/run) with a fresh tmpfs, make every protected root
 * READ-ONLY, HIDE the home under an empty read-only tmpfs, and re-expose `binds` at the SAME
 * paths — each with its own mode.
 *
 * ⛔ /tmp hides the arm itself, so: mount the new /run FIRST, rbind each kept path to
 * a staging point INSIDE it while the old /tmp is still visible, mount the new /tmp,
 * recreate the skeleton, and MOVE each staged mount back to its original path.
 *
 * ⛔ THE ORDER AGAINST THE READ-ONLY ROOTS: stage FIRST — the staged copies are taken
 * from the untouched tree, so they keep the host's modes, submounts included — THEN
 * rbind each root onto itself and remount it and every reachable submount ro, THEN move
 * the staged keeps back on top, outer before inner. A writable keep therefore sits ON TOP
 * of the ro root; the ro remount never touches it. (Re-binding a keep AFTER the ro step
 * would copy the ro submounts beneath it, and remounting those rw can fail on a mount
 * that was ro on the host.)
 *
 * ⛔ THE HIDES go in the SAME outer-before-inner sequence as the keeps moving back (a hide before
 * a keep at the same path): an empty tmpfs (mode 0555), the MISSING mount points of the keeps
 * beneath it created in it, then remounted READ-ONLY. The HOME is always hidden; a hidden dir
 * under it only where a re-bind CONTAINS it (elsewhere the home's tmpfs already hides it), and
 * one outside the home always. ⇒ a keep CONTAINING a hidden dir is covered there again; a keep
 * AT or BENEATH one lands on top of it and shows only itself.
 * ⚠ A mount point is created only when MISSING: should a hide's tmpfs silently not be there,
 * an existing FILE at a keep's path is the REAL file, and writing '' would truncate it.
 * @param {Bind[]} binds @param {string[]} roots @param {string[]} [hidden] @param {string} [home]
 * @returns {string} '' on success, else the reason
 */
function maskSocketDirs(binds, roots, hidden = [], home = '') {
  const { run, tmp, all } = maskedDirs();
  const opts = (/** @type {string} */ d) => (d === tmp ? 'mode=1777' : 'mode=0755') + ',nosuid,nodev';
  const cover = (/** @type {string} */ d) => mountOrWhy(['-t', 'tmpfs', '-o', opts(d), MASK_SOURCE, d],
    `cover ${d} with a fresh tmpfs`);
  const stage = path.join(run, '.webctl-keep');
  const hides = [...(home ? [home] : []),
    ...hidden.filter((h) => !home || !isWithin(h, home) || binds.some((b) => b.p !== h && isWithin(h, b.p)))];
  const secret = [...binds.map((b) => b.p), ...roots, ...hidden, ...(home ? [home] : [])].sort((x, y) => y.length - x.length);
  /** @param {string} p @param {boolean} dir create a mount point only where there is none */
  const mountPoint = (p, dir) => {
    if (fs.existsSync(p)) return;
    if (dir) fs.mkdirSync(p, { recursive: true });
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '', { flag: 'wx' }); }
  };
  try {
    for (const d of all.filter((x) => x !== tmp)) { const e = cover(d); if (e) return e; }
    fs.mkdirSync(stage);
    const isDir = binds.map((b) => fs.statSync(b.p).isDirectory());
    for (const [i, b] of binds.entries()) {
      const st = path.join(stage, String(i));
      if (isDir[i]) fs.mkdirSync(st); else fs.writeFileSync(st, '');
      // a read-only bind is staged ro at its top at once (one `mount` less per PATH entry); its
      // submounts are made ro after the move (makeTreeReadOnly), and all of it is read back
      const e = mountOrWhy(b.rw ? ['--rbind', b.p, st] : ['--rbind', '-o', 'ro', b.p, st],
        `stage kept path ${i + 1} of ${binds.length}`, secret);
      if (e) return e;
    }
    for (const r of roots) {
      const e = makeTreeReadOnly(r, true);
      if (e) return `${e.split(r).join('<path>')} — a sensitive home directory would stay WRITABLE`;
    }
    const e = cover(tmp);
    if (e) return e;
    // outer before inner; at one path the hide first, so a keep exactly there lands on top
    const ops = [...binds.map((b, i) => ({ p: b.p, i })), ...hides.map((h) => ({ p: h, i: -1 }))]
      .sort((x, y) => x.p.length - y.p.length || Number(y.i < 0) - Number(x.i < 0));
    let nHide = 0;
    for (const { p: at, i } of ops) {
      if (i < 0) {
        nHide++;
        const what = `hide home dir ${nHide} of ${hides.length}`;
        const h = mountOrWhy(['-t', 'tmpfs', '-o', 'mode=0555,nosuid,nodev,noexec,size=1m', HIDE_SOURCE, at], what, secret);
        if (h) return h;
        for (const [j, b] of binds.entries()) if (b.p !== at && isWithin(b.p, at)) mountPoint(b.p, isDir[j]);
        const ro = mountOrWhy(['-o', 'remount,bind,ro', at], `${what} read-only`, secret);
        if (ro) return ro;
        continue;
      }
      const b = binds[i];
      const st = path.join(stage, String(i));
      // ⚠ Create the mount point only when MISSING (the fresh /tmp, the hidden home): under a ro
      // root it exists — and writing '' to an existing FILE keep would truncate the real file.
      mountPoint(b.p, isDir[i]);
      const m = mountOrWhy(['--move', st, b.p], `re-expose kept path ${i + 1} of ${binds.length}`, secret);
      if (m) return m;
      if (!b.rw) {
        const r = makeTreeReadOnly(b.p, false);
        if (r) return r.split(b.p).join('<path>');
      }
      try { if (isDir[i]) fs.rmdirSync(st); else fs.unlinkSync(st); } catch { /* left empty: harmless */ }
    }
    try { fs.rmdirSync(stage); } catch { /* left empty: harmless */ }
  } catch (e) {
    let msg = errMsg(e);
    for (const b of secret) msg = msg.split(b).join('<path>');
    return `masking failed (${msg})`;
  }
  return '';
}

/**
 * Masked directories whose TOPMOST mount is NOT our tmpfs. ⚠ "a tmpfs at /run" alone
 * is a proxy: on a systemd host /run and /tmp are ALREADY tmpfs (measured), so the
 * test is the source tag `isolated` mounts with.
 * @returns {string[]}
 */
function unmaskedDirs() {
  const mounts = readMountinfo();
  if (!mounts) return ['/proc/self/mountinfo (unreadable)'];
  return maskedDirs().all.filter((d) => {
    const here = mounts.filter((m) => m.at === d);
    const top = here.find((m) => !here.some((o) => o.parent === m.id));
    return !(top && top.fstype === 'tmpfs' && top.source === MASK_SOURCE);
  });
}

/** Outcomes that mean "a mutant cannot talk to it either". */
const SOCKET_UNREACHABLE = new Set(['ENOENT', 'ENOTDIR', 'ECONNREFUSED', 'EACCES', 'EPERM']);

/**
 * Connect to a unix socket path: 'CONNECTED', the errno, or 'TIMEOUT'.
 * @param {string} p @param {number} [ms] @returns {Promise<string>}
 */
function unixConnectOutcome(p, ms = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ path: p });
    const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, ms);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('CONNECTED'); });
    s.on('error', (e) => { clearTimeout(t); resolve(/** @type {NodeJS.ErrnoException} */ (e).code || errMsg(e)); });
  });
}

/** @param {string[]} ps @returns {Promise<string[]>} outcomes, 32 at a time */
async function connectAll(ps) {
  /** @type {string[]} */ const out = [];
  for (let i = 0; i < ps.length; i += 32) out.push(...await Promise.all(ps.slice(i, i + 32).map((p) => unixConnectOutcome(p))));
  return out;
}

/**
 * ⭐ ASSERT THE PROPERTY: after masking, try every host path socket (except under a
 * `--keep`). Anything not provably unreachable gets /dev/null bound over it — a
 * connect to a non-socket is ECONNREFUSED — and is tried again. Counts only.
 * @param {string[]} sockets @param {string[]} exempt
 */
async function closeResidualSockets(sockets, exempt) {
  const todo = sockets.filter((p) => !exempt.some((k) => isWithin(p, k)));
  const first = await connectAll(todo);
  const open = todo.filter((_, i) => !SOCKET_UNREACHABLE.has(first[i]));
  let coverFailed = 0;
  for (const p of open) {
    if (mountOrWhy(['--bind', '/dev/null', p], 'cover a socket', [p])) coverFailed++;
  }
  const again = await connectAll(open);
  return { listed: sockets.length, exempt: sockets.length - todo.length, checked: todo.length,
    covered: open.length, coverFailed, still: again.filter((o) => !SOCKET_UNREACHABLE.has(o)).length };
}

/**
 * The capability fields /proc/<pid>/status must show as ZERO for the command. ⚠ Not
 * CapBnd: a new user namespace starts with a FULL bounding set, and that is harmless here
 * — a non-root uid under no_new_privs can never raise anything from it.
 */
const CAP_FIELDS = Object.freeze(['CapInh', 'CapPrm', 'CapEff', 'CapAmb']);

/** @param {string} status /proc/<pid>/status text @returns {Record<string, string>} */
function statusFields(status) {
  return Object.fromEntries(status.split('\n').map((l) => l.split(':\t')).filter((f) => f.length === 2)
    .map(([k, v]) => [k, v.trim()]));
}

/**
 * The REAL (host-namespace) uid/gid, as `isolated` recorded them at entry: in the plan on
 * the fresh path, in WEBCTL_HOST_IDS on the nested one. Inside the outer namespace
 * getuid() is 0, so they cannot be re-derived there. null when absent/malformed.
 * @param {unknown} v @returns {{uid: number, gid: number} | null}
 */
function hostIdsOf(v) {
  const o = /** @type {{uid?: unknown, gid?: unknown} | null} */ (v);
  const ok = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0;
  return o && typeof o === 'object' && ok(o.uid) && ok(o.gid)
    ? { uid: /** @type {number} */ (o.uid), gid: /** @type {number} */ (o.gid) } : null;
}

/** The host ids recorded in WEBCTL_HOST_IDS (nested path), or null. */
function recordedHostIds() {
  try { return hostIdsOf(JSON.parse(process.env[HOST_IDS_ENV] ?? 'null')); } catch { return null; }
}

/**
 * Is `map` (a /proc/<pid>/{uid,gid}_map text) EXACTLY one line mapping `inside` to
 * `outside`, count 1? @param {string} map @param {number} inside @param {number} outside
 */
function singleMapping(map, inside, outside) {
  const lines = String(map).trim().split('\n').map((l) => l.trim().split(/\s+/).join(' ')).filter(Boolean);
  return lines.length === 1 && lines[0] === `${inside} ${outside} 1`;
}

/**
 * The argv prefix that runs the command with NO capabilities — and the PROOF that it does.
 *
 * ⛔ WITHOUT IT THE ARM IS NAMESPACE ROOT WITH EVERY CAPABILITY (measured by the final
 * review: CapEff 000001ffffffffff). It could `umount` a /dev/null cover, `umount -l /tmp`
 * (both probe sockets went ENOENT/ECONNREFUSED → CONNECTED), `mount -o remount,bind,rw` the
 * read-only home — every mask undone by one call. And CAP_DAC_OVERRIDE made a chmod-000
 * file READABLE inside: a consumer test asserting EACCES went false-red only under the gate.
 *
 * ⇒ `setpriv --no-new-privs -- unshare -U --map-user <real uid> --map-group <real gid> --`:
 * the command runs in a CHILD user namespace as the REAL uid/gid number (mapped onto the
 * outer namespace's root, i.e. back onto the caller). A non-root uid loses every capability
 * on execve; no mount namespace is created, so the masks it lives under belong to the
 * OUTER user namespace, where it holds nothing. ⚠ It stays able to make its OWN nested
 * namespaces (`unshare -rn`, a pid ns, Chromium's sandbox) — and inherited mounts are
 * LOCKED in those, so they cannot be the way back (measured).
 *
 * ⛔ WHY NOT `setpriv --bounding-set=-all …` (a28b280): it measured as BREAKING NESTED
 * NAMESPACES. A capless namespace-ROOT process cannot write a nested user namespace's
 * uid_map — mapping its uid 0 needs CAP_SETFCAP since Linux 5.12 — so under the release
 * gate a lane that self-isolates with `unshare -rn` FAILED, a lane probing for a netns went
 * INCONCLUSIVE, and a real Chromium never brought CDP up (its sandbox needs a user
 * namespace; as uid 0 it refuses to start at all). Here the uid is NOT 0, so a nested
 * `unshare -r` maps the real uid, which needs no capability.
 *
 * `--no-new-privs` is KEPT: measured not to hinder nested `unshare -rn` (+ `ip link set lo
 * up`), a nested pid ns or Chromium; it stops a setuid or file-capability binary from
 * handing the command capabilities in its child namespace.
 *
 * ⭐ ASSERTS THE PROPERTY, not the tools' exit: the same prefix runs node once to report its
 * own /proc/self/status, uid_map and gid_map. CapInh/CapPrm/CapEff/CapAmb must be 0,
 * NoNewPrivs 1, getuid() the real uid, and uid_map/gid_map EXACTLY one line mapping the real
 * id onto our own euid/egid. A missing setpriv, a missing or too-old unshare (no
 * --map-user: util-linux < 2.38), one that ignores its flags, a real uid of 0 — refused.
 * ⚠ Refusals never print the ids: they get pasted into a public repo's logs.
 * @param {{uid: number, gid: number} | null} ids the REAL uid/gid (host namespace)
 * @returns {{prefix: string[], why: string}}
 */
function privilegeDrop(ids, tools, { pidns = false } = {}) {
  if (!ids) return { prefix: [], why: 'internal: the real uid/gid were not recorded at entry — run via `isolated`' };
  if (ids.uid === 0) {
    return { prefix: [], why: 'the real uid is 0 (root): a child user namespace mapped onto it would keep every '
      + 'capability — run `isolated` as an ordinary user' };
  }
  // pidns (the NESTED path): a fresh PID namespace too, so the command cannot see or signal
  // its CALLER's processes either. -m only to mount that namespace's /proc: inherited mounts
  // stay locked, and the command (a non-root uid after exec) holds no capabilities in it.
  // ⛔ both by ABSOLUTE path from the system dirs (privilegedTools) — never the caller's PATH
  const pid = pidns ? ['-m', '--pid', '--fork', '--mount-proc', '--kill-child'] : [];
  const prefix = [tools.setpriv, '--no-new-privs', '--', tools.unshare, '-U', '--map-user', String(ids.uid),
    '--map-group', String(ids.gid), ...pid, '--'];
  const r = spawnSync(prefix[0], [...prefix.slice(1), process.execPath, '-e',
    'const f = require("fs"); process.stdout.write(JSON.stringify({ status: f.readFileSync("/proc/self/status", "utf8"),'
      + ' uidMap: f.readFileSync("/proc/self/uid_map", "utf8"), gidMap: f.readFileSync("/proc/self/gid_map", "utf8"),'
      + ' uid: process.getuid(), gid: process.getgid() }))'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: privilegedEnv(process.env) });
  // ⚠ strip the ids from anything quoted back (a getopt error may echo an argument)
  const redact = (/** @type {string} */ s) => s.replace(new RegExp(`\\b(${ids.uid}|${ids.gid})\\b`, 'g'), '<id>');
  const tail = () => redact(String(r.stderr || '').trim().split('\n').pop() || '');
  const ns = 'the uid-mapped child user namespace';
  if (r.error) {
    const err = /** @type {NodeJS.ErrnoException} */ (r.error);
    return { prefix, why: `cannot enter ${ns}: ${err.code === 'ENOENT' ? "'setpriv' not found — install util-linux"
      : errMsg(err)}; the command would run as namespace root with every capability (it could unmount the masks)` };
  }
  if (r.status !== 0) {
    const policy = userNamespaceRefusal(String(r.stderr || ''));
    if (policy) return { prefix, why: `cannot enter ${ns}: ${policy}` };
    return { prefix, why: `cannot enter ${ns}: \`setpriv --no-new-privs -- unshare -U --map-user …\` exited `
      + `${r.status ?? r.signal} (${tail()}) — util-linux ≥ 2.38 (unshare --map-user) is required` };
  }
  /** @type {{status?: string, uidMap?: string, gidMap?: string, uid?: number, gid?: number}} */
  let got = {};
  try { got = JSON.parse(r.stdout); } catch { /* every check below fails */ }
  const f = statusFields(String(got.status || ''));
  const held = CAP_FIELDS.filter((k) => !/^0+$/.test(f[k] || 'x'));
  /** @type {string[]} */
  const bad = [];
  if (held.length) bad.push(`it would still hold ${held.join(', ')}`);
  if (f.NoNewPrivs !== '1') bad.push('NoNewPrivs is not set');
  if (got.uid !== ids.uid || got.gid !== ids.gid) bad.push('its uid/gid are not the real ones');
  if (!singleMapping(String(got.uidMap || ''), ids.uid, process.geteuid?.() ?? -1)
    || !singleMapping(String(got.gidMap || ''), ids.gid, process.getegid?.() ?? -1)) {
    bad.push('its uid_map/gid_map are not exactly the one expected mapping');
  }
  if (bad.length) return { prefix, why: `after entering ${ns}, ${bad.join('; ')} — it is not dropping privileges` };
  return { prefix, why: '' };
}

/**
 * Run `prefix` + `command` (a chain ending in the `__isolated-pid1` helper, pid1HelperArgv) with
 * the caller's cwd/stdio; resolve with its exit code (128+signal when killed, 127 when it cannot
 * be started). `prefix` is the privilege drop (privilegeDrop); `env` the COMMAND's env — the
 * ALLOWLIST (isolatedEnv: the fresh path's plan.env, or the nested call's own `--pass-env`).
 *
 * ⛔ `env` is NOT the chain's env: setpriv, unshare -U, pid 1's bash and the helper get
 * privilegedEnv(env); `env` itself goes down a pipe and only the helper applies it, to the
 * command. So an LD_* or NODE_OPTIONS reaches the command and nothing that runs before it.
 * @param {string[]} command @param {string[]} [prefix]
 * @param {{pastUnshare?: boolean, env?: NodeJS.ProcessEnv}} [o] @returns {Promise<number>}
 */
function runCommand(command, prefix = [], { pastUnshare = false, env = /** @type {NodeJS.ProcessEnv} */ ({}) } = {}) {
  const argv = [...prefix, ...command];
  return new Promise((resolve) => {
    // ⛔ the forwarder BEFORE the spawn (review finding 5); through `unshare --fork` a signal must
    // go to unshare's CHILD (forwardSignalsPastUnshare)
    /** @type {ReturnType<typeof statusChannel> | null} */
    let st = null;
    const fwd = pastUnshare ? forwardSignalsPastUnshare(() => !!st && st.started()) : forwardSignals();
    // pastUnshare (the nested path): fd 3 is the pid-1 helper's status pipe (`started`), fd 4 the
    // command's env; else fd 3 is the env. ⛔ The chain itself runs with privilegedEnv(env) only.
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe', ...(pastUnshare ? /** @type {const} */ (['pipe']) : [])], env: privilegedEnv(env) });
    const envPipe = /** @type {import('node:stream').Writable | null | undefined} */ (child.stdio[pastUnshare ? 4 : 3]);
    envPipe?.on('error', () => { /* the helper refused or never started; it reports */ });
    envPipe?.end(JSON.stringify(env));
    if (pastUnshare) st = statusChannel(child);
    fwd.attach(child);
    child.on('error', (e) => {
      fwd.remove();
      resolve(report('isolated', 127, `NOT RUN: cannot start '${argv[0]}': ${errMsg(e)}`));
    });
    child.on('close', (code, signal) => {
      if (fwd.early?.()) dieByForwarded(fwd); // killed before pid 1 could hear it: die by the signal
      resolve(exitOrDieBy(fwd, code, signal));
    });
  });
}

// ── kernel facts: "am I inside?" is read from the KERNEL, never from env alone ──
//
// ⛔ A lane's own isolation used an env marker (`…_IN_NETNS=1`) to mean "already
// inside"; setting it on the HOST skipped isolation and the whole suite ran on the
// host network. ⇒ `isolated` exports WEBCTL_HOST_NETNS (the host netns id it saw at
// entry), but that id can be FABRICATED, so it is only one of THREE facts:
//
//   1. /proc/self/ns/net DIFFERS from the recorded host id;
//   2. /proc/self/uid_map is NOT the identity map ("0 0 4294967295") — env-free;
//   3. /proc/self/net/dev lists ONLY 'lo'                              — env-free.
//
// ⚠ (2) alone proves only a USER namespace: `unshare -r` WITHOUT -n passes it. And
// (1)+(2) together are still beaten by `unshare -r` plus a fabricated id that merely
// differs from the current one — measured while building this. (3) is what closes it:
// it is a fact about the NETWORK, which is the thing being claimed.
//
// ⛔ AND THE NETWORK IS NO LONGER THE WHOLE CLAIM. The old `unshare -rn` namespace
// passes (1)–(3) yet leaves every host PATH socket reachable. So two MOUNT facts too:
//
//   4. /proc/self/ns/mnt DIFFERS from WEBCTL_HOST_MNTNS (recorded at entry);
//   5. /proc/self/mountinfo shows OUR tmpfs (source 'webctl-isolated') on top of
//      /run and /tmp (and a real /var/run)                                — env-free.
//
// (5) is the fact about the SOCKETS; (4) alone is beaten by `unshare -rnm` plus a
// fabricated id. ⚠ "a tmpfs at /run" would be a proxy: the host's /run and /tmp are
// usually tmpfs already.
//
// ⛔ AND THE HOME DIRECTORY. The previous `isolated` passes (1)–(5) with the passwd home
// WRITABLE — signed-in profiles, ~/.config, ~/.ssh. So a sixth:
//
//   6. each root in WEBCTL_RO_ROOTS (recorded at entry) answers access(W_OK) with EROFS
//      (or is absent — masked). Since v0.33.0 these are only the sensitive dot-dirs'
//      real paths OUTSIDE the home; the home itself is fact 8's.
//   7. /proc/self/ns/pid DIFFERS from WEBCTL_HOST_PIDNS — no host process is signalable.
//   8. each dir in WEBCTL_HIDDEN_DIRS (recorded at entry: the HOME first, then ~/.ssh and the
//      state roots) has OUR read-only tmpfs (source 'webctl-isolated-hidden') in the mount
//      stack AT it or at an ANCESTOR — the home's covers what no re-bind brings back. In the
//      stack, not necessarily on top: a `--keep` at exactly that dir sits above it.
//      ⚠ A ≤ v0.32.0 outer records no WEBCTL_HIDDEN_DIRS: when that is the ONLY failing fact
//      the refusal says "upgrade the outer" (it is version skew, not a forged marker).
//
// ⚠ The roots are RECORDED, not re-derived: inside the user namespace we are uid 0 and
// the passwd lookup answers root's home. access(2) rather than mountinfo because it asks
// the kernel the exact question — "is THIS path on a read-only mount", through path
// resolution, stacking and shadowing included; the full submount sweep (mountinfo) runs
// once, where the writable keeps are known: in the inner half, before `started`.

const HOST_NETNS_ENV = 'WEBCTL_HOST_NETNS';
const HOST_MNTNS_ENV = 'WEBCTL_HOST_MNTNS';
const HOST_PIDNS_ENV = 'WEBCTL_HOST_PIDNS';
const RO_ROOTS_ENV = 'WEBCTL_RO_ROOTS';
/** The HIDDEN_DIRS real paths `isolated` masked (JSON array), recorded at entry for the nesting proof. */
const HIDDEN_ENV = 'WEBCTL_HIDDEN_DIRS';
/** The REAL uid/gid ({uid, gid} JSON), recorded at entry for the nested path's privilegeDrop. */
const HOST_IDS_ENV = 'WEBCTL_HOST_IDS';

/** The absolute paths recorded in env var `name` (a JSON array), or null when absent/malformed. @param {string} name */
function recordedPaths(name) {
  try {
    const v = JSON.parse(process.env[name] ?? 'null');
    return Array.isArray(v) && v.every((r) => typeof r === 'string' && path.isAbsolute(r)) ? v : null;
  } catch { return null; }
}

/** The protected roots `isolated` recorded at entry, or null when absent/malformed. */
function recordedRoRoots() { return recordedPaths(RO_ROOTS_ENV); }

/**
 * Is `p` NOT writable through its mount — 'EROFS', or 'ENOENT' (masked away)? Anything
 * else (success = 'WRITABLE', another errno) means the read-only step is not in effect.
 * @param {string} p @returns {string}
 */
function writeOutcome(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return 'WRITABLE'; } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code || 'ERROR';
  }
}

/** @returns {'identity'|'mapped'|'unreadable'} */
function uidMapKind() {
  let txt = '';
  try { txt = fs.readFileSync('/proc/self/uid_map', 'utf8'); } catch { return 'unreadable'; }
  const lines = txt.trim().split('\n').map((l) => l.trim().split(/\s+/).join(' ')).filter(Boolean);
  if (lines.length === 0) return 'unreadable';
  return lines.length === 1 && lines[0] === '0 0 4294967295' ? 'identity' : 'mapped';
}

/**
 * Interfaces other than 'lo' in THIS network namespace (/proc/self/net is per-netns).
 * ⚠ A count, never names: interface names describe the host, and refusals get pasted.
 * @returns {number} -1 when unreadable
 */
function extraInterfaces() {
  try {
    return fs.readFileSync('/proc/self/net/dev', 'utf8').split('\n').slice(2)
      .map((l) => l.split(':')[0].trim()).filter((n) => n && n !== 'lo').length;
  } catch { return -1; }
}

/**
 * Is this process provably inside the namespaces `isolated` made — no host network,
 * no host unix sockets, a HIDDEN home, no host processes? All eight
 * facts must hold; every one that fails
 * is named.
 * @returns {{inside: boolean, why: string, facts: Record<string, any>}}
 */
function kernelInsideProof() {
  const recorded = process.env[HOST_NETNS_ENV];
  const recordedMnt = process.env[HOST_MNTNS_ENV];
  let netns = '';
  try { netns = fs.readlinkSync('/proc/self/ns/net'); } catch { /* named below */ }
  let mntns = '';
  try { mntns = fs.readlinkSync('/proc/self/ns/mnt'); } catch { /* named below */ }
  const recordedPid = process.env[HOST_PIDNS_ENV];
  let pidns = '';
  try { pidns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* named below */ }
  const uidMap = uidMapKind();
  const extra = extraInterfaces();
  const unmasked = unmaskedDirs();
  const roRoots = recordedRoRoots();
  const writable = (roRoots || []).filter((r) => !['EROFS', 'ENOENT'].includes(writeOutcome(r))).length;
  const hidden = recordedPaths(HIDDEN_ENV);
  const mounts = readMountinfo() || [];
  // a HIDE mask AT the dir or on an ANCESTOR (the home's hides everything under it no keep re-binds)
  const shown = (hidden || []).filter((h) => !mounts.some((m) => isWithin(h, m.at) && m.source === HIDE_SOURCE && m.opts.includes('ro'))).length;
  /** @type {string[]} */
  const fails = [];
  if (!netns) fails.push('/proc/self/ns/net is unreadable');
  if (!recorded) fails.push(`${HOST_NETNS_ENV} is not set, so there is no recorded host namespace to differ from`);
  else if (netns === recorded) fails.push(`the current network namespace ${netns} EQUALS the recorded host one`);
  if (uidMap !== 'mapped') fails.push(`/proc/self/uid_map is ${uidMap} (no user namespace)`);
  if (extra !== 0) {
    fails.push(extra < 0 ? '/proc/self/net/dev is unreadable'
      : `${extra} interface(s) besides 'lo' are visible (the host's network)`);
  }
  if (!mntns) fails.push('/proc/self/ns/mnt is unreadable');
  if (!recordedMnt) fails.push(`${HOST_MNTNS_ENV} is not set, so there is no recorded host mount namespace to differ from`);
  else if (mntns === recordedMnt) fails.push(`the current mount namespace ${mntns} EQUALS the recorded host one`);
  if (unmasked.length) {
    fails.push(`no '${MASK_SOURCE}' tmpfs on top of ${unmasked.join(', ')} (the host's unix sockets there are reachable)`);
  }
  if (!pidns) fails.push('/proc/self/ns/pid is unreadable');
  if (!recordedPid) fails.push(`${HOST_PIDNS_ENV} is not set, so there is no recorded host PID namespace to differ from`);
  else if (pidns === recordedPid) fails.push(`the current PID namespace ${pidns} EQUALS the recorded host one (host processes can be signalled)`);
  if (!roRoots) fails.push(`${RO_ROOTS_ENV} is not set (or malformed), so there is no recorded home directory to find read-only`);
  else if (writable) fails.push(`${writable} of ${roRoots.length} protected root(s) — the home directory — are WRITABLE here`);
  if (!hidden) fails.push(`${HIDDEN_ENV} is not set (or malformed), so there is no record of which home dirs must be hidden`);
  else if (shown) fails.push(`${shown} of ${hidden.length} hidden dir(s) — the home, ~/.ssh, the state roots — lack the '${HIDE_SOURCE}' mask here`);
  // ⛔ VERSION SKEW: a ≤ v0.32.0 outer records no WEBCTL_HIDDEN_DIRS (and hides nothing). If that
  // is the ONLY failing fact, say what it is — still refused, never "inherited" as if hidden.
  const outerTooOld = process.env[HIDDEN_ENV] === undefined && fails.length === 1;
  if (outerTooOld) {
    fails[0] = `the OUTER \`isolated\` is older than v0.33.0: it recorded no ${HIDDEN_ENV} and did not hide the `
      + 'home, and a nested call cannot hide it after the fact — upgrade the outer one (the base checkout running '
      + 'the gate, or your contract\'s own outer call) to v0.33.0 or later';
  }
  // ⚠ counts, never the roots: they are home paths, and refusals get pasted
  return { inside: fails.length === 0, why: fails.join('; '),
    facts: { netns, recorded: recorded ?? null, uidMap, extraInterfaces: extra,
      mntns, recordedMnt: recordedMnt ?? null, pidns, recordedPid: recordedPid ?? null, unmasked,
      roRoots: roRoots ? roRoots.length : null, writableRoRoots: writable,
      hidden: hidden ? hidden.length : null, shownHidden: shown } };
}

/**
 * `isolation-check <port>…` — the PRECONDITION a lane runs INSIDE `isolated` before
 * its runner-spawning arms: "my real default port is unreachable from in here; my
 * own fake is reachable."
 *
 *   * each named port: a connect to 127.0.0.1:<port> must fail with EXACTLY
 *     ECONNREFUSED. ⛔ Not "any error": with lo DOWN the connect fails ENETUNREACH,
 *     which looks like isolation — and then every in-namespace fake fails for the
 *     wrong reason. Refused means lo is UP in our own namespace and nothing listens.
 *   * a control listener this verb opens on the namespace loopback must be REACHABLE;
 *   * the kernel proof (kernelInsideProof) must hold — otherwise a host on which the
 *     browser merely happens to be DOWN right now would pass, and it may come back.
 *
 * FAIL names every condition that failed.
 * @param {string[]} a @returns {Promise<number>}
 */
async function checkIsolation(a) {
  if (a.length === 0 || a.some((x) => !/^\d+$/.test(x) || Number(x) < 1 || Number(x) > 65535)) {
    process.stderr.write('usage: contract-harness.mjs isolation-check <port 1-65535>…   '
      + '(run it INSIDE: contract-harness.mjs isolated -- node contract-harness.mjs isolation-check <port>…)\n');
    return EXIT.usage;
  }
  /** @type {string[]} */
  const fails = [];
  /** @type {{port: number, error: string}[]} */
  const ports = [];
  for (const p of a.map(Number)) {
    const error = await connectOutcome(p);
    ports.push({ port: p, error });
    if (error === 'CONNECTED') fails.push(`127.0.0.1:${p} is REACHABLE from here`);
    else if (error === 'ENETUNREACH') fails.push(`127.0.0.1:${p} → ENETUNREACH: the loopback is DOWN, not isolated-and-up`);
    else if (error !== 'ECONNREFUSED') fails.push(`127.0.0.1:${p} → ${error}, not ECONNREFUSED`);
  }
  let control = 'reachable';
  try { await loopbackSelfTest(); } catch (e) {
    control = /** @type {NodeJS.ErrnoException} */ (e).code || errMsg(e);
    fails.push(`the control listener on the namespace loopback is NOT reachable (${control})`);
  }
  const proof = kernelInsideProof();
  if (!proof.inside) fails.push(`not provably inside a private network namespace: ${proof.why}`);

  const portsTxt = ports.map((x) => `127.0.0.1:${x.port} → ${x.error}`).join(', ');
  const extra = { ports, control, namespace: proof.facts };
  if (fails.length) {
    return report('isolation-check', EXIT.fail, `${fails.join('; ')}. (${portsTxt}; control: ${control})`, extra);
  }
  return report('isolation-check', EXIT.pass,
    `${portsTxt}; control listener on the namespace loopback: reachable; inside a private network namespace`,
    extra);
}

/**
 * Connect to 127.0.0.1:port and name the outcome: 'CONNECTED', the errno, or 'TIMEOUT'.
 * @param {number} port @param {number} [ms] @returns {Promise<string>}
 */
function connectOutcome(port, ms = 800) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const t = setTimeout(() => { s.destroy(); resolve('TIMEOUT'); }, ms);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('CONNECTED'); });
    s.on('error', (e) => { clearTimeout(t); resolve(/** @type {NodeJS.ErrnoException} */ (e).code || errMsg(e)); });
  });
}

/**
 * Bring the namespace's loopback up: each of `lo` in turn — `ip` (iproute2), then `ifconfig`
 * (net-tools), by the ABSOLUTE paths the host resolved from the system dirs (privilegedTools);
 * ⛔ never by name: that searched the caller's PATH, its cwd included (re-review of v0.33.0).
 * @param {[string, string[]][]} lo @returns {string} '' on success, else the reason
 */
function bringLoUp(lo) {
  /** @type {string[]} */
  const tried = [];
  for (const [bin, argv] of lo) {
    const name = path.basename(bin);
    if (!path.isAbsolute(bin)) { tried.push(`${name}: internal: not an absolute path`); continue; }
    try {
      execFileSync(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      return '';
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException & {stderr?: Buffer}} */ (e);
      tried.push(err.code === 'ENOENT' ? `${name}: not found`
        : `${name}: ${String(err.stderr || err.message).trim()}`);
    }
  }
  return `cannot bring the namespace loopback up (${tried.join('; ') || 'no tool'}) — install iproute2`;
}

/** Listen on 127.0.0.1:0 and connect to it. @returns {Promise<void>} */
function loopbackSelfTest() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => s.destroy());
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = /** @type {net.AddressInfo} */ (srv.address()).port;
      const c = net.connect(port, '127.0.0.1');
      c.on('connect', () => { c.destroy(); srv.close(); resolve(); });
      c.on('error', (e) => { srv.close(); reject(e); });
    });
  });
}

/**
 * Try a TCP connect to 127.0.0.1:port.
 * @param {number} port @param {number} [ms]
 * @returns {Promise<'yes'|'no'|'unknown'>} unknown = timed out (not proof of absence)
 */
function probeListening(port, ms = 800) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const t = setTimeout(() => { s.destroy(); resolve('unknown'); }, ms);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('yes'); });
    s.on('error', (e) => {
      clearTimeout(t);
      resolve(/** @type {NodeJS.ErrnoException} */ (e).code === 'ECONNREFUSED' ? 'no' : 'unknown');
    });
  });
}

/**
 * Does 127.0.0.1:port answer `GET /json/version` with 200?
 * @param {number} port @param {number} [ms] @returns {Promise<boolean>}
 */
function probeCdp(port, ms = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: ms }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * `sandbox-port [--bare]` — a port with NOTHING behind it, for a lane to export
 * into its PORT variable so every port DERIVED from it is dead too.
 *
 * Bind 127.0.0.1:0, read the port, close, then ASSERT a connect is refused (a
 * port freed is not a port nobody took). `--bare` prints only the number on
 * stdout, for `PORT=$(…)`.
 * @param {string[]} a @returns {Promise<number>}
 */
async function checkSandboxPort(a) {
  const bare = a.includes('--bare');
  if (a.some((x) => x !== '--bare')) {
    process.stderr.write('usage: contract-harness.mjs sandbox-port [--bare]\n');
    return EXIT.usage;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = /** @type {net.AddressInfo} */ (srv.address()).port;
        srv.close(() => resolve(p));
      });
    }).catch(() => 0);
    if (!port) continue;
    if (await probeListening(Number(port)) !== 'no') continue; // someone took it — try another
    if (bare) {
      process.stdout.write(`${port}\n`);
      process.stderr.write(`PASS  sandbox-port: 127.0.0.1:${port} refuses connections\n`);
      return EXIT.pass;
    }
    return report('sandbox-port', EXIT.pass,
      `127.0.0.1:${port} was free and refuses connections — export it so derived ports are dead`,
      { port: Number(port) });
  }
  return report('sandbox-port', EXIT.fail,
    'could not obtain a port that stays dead after release in 5 attempts');
}

/**
 * `guard-live-port <port> [--pin-verified]` — defence in depth where `isolated`
 * is not used. REFUSES when 127.0.0.1:<port> LISTENS or answers CDP, unless the
 * caller has verified its sandbox pin. Names BOTH facts either way.
 *
 * ⚠ A listener with a dead browser behind it (docker-proxy) still counts: the
 * browser may come back mid-run. A connect that TIMES OUT is not proof of
 * absence, so it refuses too.
 * @param {string[]} a @returns {Promise<number>}
 */
async function checkGuardLivePort(a) {
  const pinVerified = a.includes('--pin-verified');
  const rest = a.filter((x) => x !== '--pin-verified');
  const port = Number(rest[0]);
  if (rest.length !== 1 || !/^\d+$/.test(rest[0]) || port < 1 || port > 65535) {
    process.stderr.write('usage: contract-harness.mjs guard-live-port <port 1-65535> [--pin-verified]\n');
    return EXIT.usage;
  }
  const listening = await probeListening(port);
  const cdp = listening === 'yes' && await probeCdp(port);
  const facts = `listening: ${listening}, CDP answering: ${cdp ? 'yes' : 'no'}`;
  const extra = { port, listening, cdp, pinVerified };
  if (listening === 'no') {
    return report('guard-live-port', EXIT.pass, `127.0.0.1:${port} — ${facts}`, extra);
  }
  if (pinVerified) {
    return report('guard-live-port', EXIT.pass,
      `127.0.0.1:${port} — ${facts}; proceeding ONLY because --pin-verified was given`, extra);
  }
  return report('guard-live-port', EXIT.fail,
    `REFUSED 127.0.0.1:${port} — ${facts}. A mutation arm aimed here can reach a LIVE browser `
      + '(a mutant does not refuse). Run the arm under `isolated`, point it at `sandbox-port`, '
      + 'or pass --pin-verified once the sandbox pin is verified.', extra);
}

// ── entry ─────────────────────────────────────────────────────────────────────
/**
 * ⛔ IMPORTING THIS MODULE MUST NEVER RUN A VERB. The dispatch below used to run at
 * module top level unconditionally, so an `import` of this file (a test reading
 * HARNESS_GENERATION) would dispatch on the IMPORTER's argv — at best usage + exit 3,
 * at worst a real verb. ⇒ Dispatch only when this file IS the entry script; both
 * sides realpath'd, because node's argv[1] keeps a symlinked path while
 * import.meta.url is the resolved one.
 */
function isEntryScript() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; }
}
// ⚠ Body deliberately NOT re-indented: keeps this guard a two-line diff against
// concurrent edits to the dispatch.
if (isEntryScript()) {
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
  // ⇩ network isolation for mutation arms — additive, generation unchanged (see DEV_NOTES)
  case 'isolated': code = await runIsolated(args); break;
  case ISOLATED_INNER: code = await runIsolatedInner(args); break;
  case PID1_INNER: code = await runPid1(args); break;
  case 'sandbox-port': code = await checkSandboxPort(args); break;
  case 'guard-live-port': code = await checkGuardLivePort(args); break;
  case 'isolation-check': code = await checkIsolation(args); break;
  default:
    process.stderr.write(
      'usage: contract-harness.mjs <generation|require-generation N|pin|no-revendor|gate-probe> [--repo D] [--sub P] [--lib D]\n'
      + '       contract-harness.mjs isolated [--keep <path>]… [--keep-ro <path>]… [--pass-env <NAME|PREFIX_*>]… -- <cmd> [args…] | isolation-check <port>… | sandbox-port [--bare] | guard-live-port <port> [--pin-verified]\n'
      + '⇒ exit 0 pass · 1 fail · 2 no verdict (reason on the last line) · 3 usage\n');
    code = EXIT.usage;
}
process.exit(code);
}
