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

/**
 * ⭐ THE GENERATION MARKER. Bump when a check's BEHAVIOUR changes, never for
 * wording. A consumer records the generation it was written against; a sweep
 * then asks "who is below N?" rather than diffing five divergent copies.
 */
export const HARNESS_GENERATION = 1;

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
  const gitlink = git(['ls-tree', 'HEAD', sub], repo).split(/\s+/)[2] || '';
  const worktree = git(['rev-parse', 'HEAD'], path.join(repo, sub));

  if (!gitlink && !worktree) {
    return { code: EXIT.noVerdict, extra: {},
      reason: `no submodule found at '${sub}' — this contract cannot judge a pin that is not mounted` };
  }

  const swapped = !!declaredEnv && !!worktree && declaredEnv !== worktree;
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

  const pin = gitlink || worktree;
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
 * returned PASS across a genuine re-vendor. ⇒ Comments are stripped before
 * anything is matched, and the assertion is about an import SPECIFIER and about
 * a local definition, both of which are code.
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
  const baseModules = new Set(fs.readdirSync(baseLib).filter((f) => f.endsWith('.js')));

  const localDir = path.join(repo, libDir);
  if (!fs.existsSync(localDir)) {
    return report('no-revendor', EXIT.noVerdict, `no local '${libDir}/' to examine`);
  }
  const localFiles = fs.readdirSync(localDir).filter((f) => /\.(js|mjs|cjs)$/.test(f));

  // ⛔ ZERO FILES EXAMINED IS NOT A PASS.
  if (localFiles.length === 0) {
    return report('no-revendor', EXIT.fail,
      `examined ZERO files under '${libDir}/'. That is this check failing to find its `
      + 'subject, not an absence of re-vendoring.');
  }

  /** @type {string[]} */
  const shadowed = [];
  let examined = 0;
  for (const f of localFiles) {
    const raw = fs.readFileSync(path.join(localDir, f), 'utf8');
    // Strip comments FIRST — the original defect was a match inside one.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
    examined++;
    if (baseModules.has(f)) {
      // A same-named local file is only a re-vendor if it DEFINES the surface
      // rather than re-exporting base's. Both halves are code.
      const reexports = new RegExp(`(from|require\\()\\s*['"][^'"]*${sub.replace(/[/\\]/g, '\\$&')}/lib/`).test(code);
      const defines = /\b(export\s+(function|const|class)|module\.exports\s*=)/.test(code);
      if (defines && !reexports) shadowed.push(f);
    }
  }

  if (shadowed.length > 0) {
    return report('no-revendor', EXIT.fail,
      `${shadowed.length} local file(s) DEFINE a surface base also provides, without importing `
      + `base's: ${shadowed.join(', ')}. That is a re-vendor; the submodule is bypassed.`,
      { shadowed, examined });
  }
  return report('no-revendor', EXIT.pass,
    `${examined} local file(s) examined; none shadows a base module`, { examined });
}

// ── entry ─────────────────────────────────────────────────────────────────────
const [, , cmd, ...args] = process.argv;
const repo = path.resolve(opt(args, 'repo', '.'));
const sub = opt(args, 'sub', 'vendor/base-webctl');
const libDir = opt(args, 'lib', 'lib');

let code;
switch (cmd) {
  case 'generation':
    process.stdout.write(`${JSON.stringify({ type: 'harness', generation: HARNESS_GENERATION })}\n`);
    process.stderr.write(`contract-harness generation ${HARNESS_GENERATION}\n`);
    code = EXIT.pass; break;
  case 'pin': code = checkPin(repo, sub); break;
  case 'no-revendor': code = checkNoRevendor(repo, sub, libDir); break;
  case 'gate-probe': code = checkGateProbe(repo, sub); break;
  default:
    process.stderr.write(
      'usage: contract-harness.mjs <generation|pin|no-revendor|gate-probe> [--repo D] [--sub P] [--lib D]\n'
      + '⇒ exit 0 pass · 1 fail · 2 no verdict (reason on the last line) · 3 usage\n');
    code = EXIT.usage;
}
process.exit(code);
