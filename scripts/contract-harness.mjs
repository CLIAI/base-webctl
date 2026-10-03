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
//   node <base>/scripts/contract-harness.mjs require-generation 4    # the floor; ANY non-zero = FAIL
//   node <base>/scripts/contract-harness.mjs pin         --repo . --sub vendor/base-webctl
//   node <base>/scripts/contract-harness.mjs no-revendor --repo . --sub vendor/base-webctl
//   node <base>/scripts/contract-harness.mjs isolated -- <cmd> [args…]   # every mutation arm (xrl4)
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ THE GENERATION MARKER. Bump when a check's BEHAVIOUR changes, never for
 * wording. A consumer records the generation it was written against; a sweep
 * then asks "who is below N?" rather than diffing five divergent copies.
 */
export const HARNESS_GENERATION = 4;

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

  const baseFiles = walkJs(baseLib);
  // ⛔ ZERO BASE MODULES IS NOT A PASS — the comparison set is gone.
  if (baseFiles.length === 0) {
    return report('no-revendor', EXIT.fail,
      `found ZERO modules under '${sub}/lib'. This check has lost its comparison set, `
      + 'which is not the same as finding no re-vendoring.');
  }

  /** @type {Map<string,string>} normalised hash -> base path */
  const byHash = new Map();
  /** @type {Map<string,string>} basename -> base path */
  const byName = new Map();
  for (const abs of baseFiles) {
    const rel = path.relative(baseLib, abs);
    byHash.set(normHash(fs.readFileSync(abs, 'utf8')), rel);
    byName.set(path.basename(abs), rel);
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

  /** @type {{local:string, base:string, how:string}[]} */
  const found = [];
  for (const abs of localFiles) {
    const rel = path.relative(repo, abs);
    const raw = fs.readFileSync(abs, 'utf8');
    const code = stripComments(raw);

    // (1) CONTENT — a copy is a copy under any name, in any directory.
    const hit = byHash.get(normHash(raw));
    if (hit) {
      found.push({ local: rel, base: hit, how: 'identical after normalisation' });
      continue;
    }

    // (2) NAME — for a copy edited after it was taken. Still only a re-vendor if
    // it DEFINES the surface rather than re-exporting base's.
    const named = byName.get(path.basename(abs));
    if (named) {
      const reexports = new RegExp(`(from|require\\()\\s*['"][^'"]*${sub.replace(/[/\\]/g, '\\$&')}/lib/`).test(code);
      const defines = /\b(export\s+(function|const|class)|module\.exports\s*=)/.test(code);
      if (defines && !reexports) {
        found.push({ local: rel, base: named, how: 'same module name, defines rather than re-exports' });
      }
    }
  }

  if (found.length > 0) {
    return report('no-revendor', EXIT.fail,
      `${found.length} local file(s) re-vendor base: `
      + found.map((f) => `${f.local} <- lib/${f.base} (${f.how})`).join('; ')
      + '. The submodule is bypassed.',
      { found, examined: localFiles.length, baseModules: baseFiles.length });
  }
  return report('no-revendor', EXIT.pass,
    `${localFiles.length} local file(s) examined against ${baseFiles.length} base module(s); `
    + 'none is a copy by content or by name. ⚠ An EDITED copy under a DIFFERENT name is '
    + 'not detected by this check.',
    { examined: localFiles.length, baseModules: baseFiles.length });
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

/** @param {string} src Strip comments, so prose cannot satisfy a code check. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
}

/**
 * Hash of the NORMALISED code: comments stripped, whitespace collapsed. ⇒ A copy
 * is still recognised after reformatting or re-commenting, which is what a
 * re-vendor looks like once someone has "adapted" it.
 * @param {string} src
 */
function normHash(src) {
  return createHash('sha256').update(stripComments(src).replace(/\s+/g, ' ').trim()).digest('hex');
}


// ── network isolation for mutation arms (xrl4 "NO HOST NETWORK") ──────────────
//
// ⛔ INCIDENT (2026-10-02, a consumer lane's mutation control): the mutant planted
// "the default port is a location", the arm ATTACHED to the real signed-in browser
// listening on the host's loopback, closed its last tab, and Chromium exited.
// Correct code refuses; A MUTANT DOES NOT REFUSE — that is what makes it a mutant.
// The family's sandboxes isolated HOME, CWD, env and PATH. Not the network.
//
// ⇒ `isolated` puts the arm in a private user+network namespace (`unshare -rn`)
// whose only interface is its OWN loopback, so the host's listeners do not exist.
// It FAILS CLOSED: there is no path on which the command runs on the host.

const SELF = fileURLToPath(import.meta.url);
const ISOLATED_INNER = '__isolated-inner';

/**
 * Forward termination signals to a child, so killing the harness kills the arm
 * rather than orphaning it. @param {import('node:child_process').ChildProcess} child
 */
function forwardSignals(child) {
  for (const s of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.on(s, () => { try { child.kill(s); } catch { /* already gone */ } });
  }
}

/** @param {number|null} code @param {NodeJS.Signals|null} signal */
function exitCodeOf(code, signal) {
  if (code != null) return code;
  const n = signal ? os.constants.signals[signal] : undefined;
  return 128 + (n || 1);
}

/**
 * `isolated -- <cmd> [args…]` — run <cmd> in a private network namespace.
 *
 * The outer half spawns `unshare -rn <node> <this file> __isolated-inner <netns> -- <cmd…>`
 * with an extra pipe on fd 3. The inner half proves the isolation (below), then
 * writes `started` on fd 3 and runs the command; any refusal is written as
 * `fail <reason>` instead. ⇒ The outer half can tell "isolation was refused" from
 * "the command exited 1", and reports the former ONCE, as FAIL, with the reason.
 *
 * ⛔ NEVER FALLS BACK TO THE HOST. No unshare, userns disabled, no `ip`/`ifconfig`,
 * a loopback that will not come up, a namespace that still sees a non-loopback
 * interface or a listener — each is FAIL, and the command is not started.
 *
 * argv goes through as an ARRAY: no shell sees the user command.
 * @param {string[]} a
 * @returns {Promise<number>}
 */
function runIsolated(a) {
  if (a[0] !== '--' || a.length < 2) {
    process.stderr.write('usage: contract-harness.mjs isolated -- <cmd> [args…]\n');
    return Promise.resolve(EXIT.usage);
  }
  const command = a.slice(1);
  let hostNs = '';
  try { hostNs = fs.readlinkSync('/proc/self/ns/net'); } catch (e) {
    return Promise.resolve(report('isolated', EXIT.fail,
      `cannot read this process's network namespace (/proc/self/ns/net: ${errMsg(e)}), so `
      + 'isolation cannot be PROVEN; refusing to run the command on the host'));
  }
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn('unshare', ['-rn', process.execPath, SELF, ISOLATED_INNER, hostNs, '--', ...command],
        { stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
    } catch (e) {
      resolve(report('isolated', EXIT.fail, `cannot start unshare (${errMsg(e)}); refusing to run on the host`));
      return;
    }
    forwardSignals(child);
    let status = '';
    child.stdio[3]?.on('data', (d) => { status += String(d); });
    child.stdio[3]?.on('error', () => { /* inner closed it */ });
    let spawnErr = '';
    child.on('error', (e) => { spawnErr = errMsg(e); });
    child.on('close', (code, signal) => {
      const started = /^started$/m.test(status);
      const fail = status.match(/^fail (.*)$/m);
      if (started) { resolve(exitCodeOf(code, signal)); return; }
      const why = fail ? fail[1]
        : spawnErr ? `unshare could not be started (${spawnErr}) — is util-linux installed`
          : `unshare exited ${code ?? signal} before the isolated side reported in — unprivileged `
            + 'user namespaces may be disabled (kernel.unprivileged_userns_clone / '
            + 'user.max_user_namespaces); unshare\'s own message, if any, is above';
      resolve(report('isolated', EXIT.fail,
        `NOT RUN: ${why}. The command was NOT started, and is never run on the host as a fallback.`,
        { command }));
    });
  });
}

/** @param {unknown} e */
function errMsg(e) { return e instanceof Error ? e.message : String(e); }

/**
 * The half that runs INSIDE the namespace. Proves the PROPERTY — no host network —
 * not its proxy ("unshare exited 0"):
 *
 *   1. the network namespace differs from the caller's;
 *   2. the namespace's ONLY interface is `lo` (/proc/self/net/dev is per-netns);
 *   3. nothing LISTENS on TCP here (/proc/self/net/tcp{,6} — the host's browser
 *      would appear here if this were the host's namespace);
 *   4. `lo` is brought up (`ip`, else `ifconfig`) and a self-connect on
 *      127.0.0.1 works, so local fakes and stubs still run.
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
    if (!tell(`fail ${why}`)) process.stderr.write(`isolated: ${why}\n`);
    return EXIT.fail;
  };
  const [hostNs, sep, ...command] = a;
  if (!hostNs || sep !== '--' || command.length === 0) return refuse('internal: malformed inner invocation');

  let ns = '';
  try { ns = fs.readlinkSync('/proc/self/ns/net'); } catch (e) {
    return refuse(`cannot read the namespace id inside (${errMsg(e)})`);
  }
  if (ns === hostNs) {
    return refuse(`still in the CALLER'S network namespace (${ns}) — whatever ran as 'unshare' did not `
      + 'isolate the network');
  }
  /** @type {string[]} */
  let ifaces = [];
  try {
    ifaces = fs.readFileSync('/proc/self/net/dev', 'utf8').split('\n').slice(2)
      .map((l) => l.split(':')[0].trim()).filter(Boolean);
  } catch (e) { return refuse(`cannot list interfaces (/proc/self/net/dev: ${errMsg(e)})`); }
  if (ifaces.length !== 1 || ifaces[0] !== 'lo') {
    // ⚠ Count, never names: interface names describe the host, and this line gets pasted.
    return refuse(`the namespace has ${ifaces.filter((i) => i !== 'lo').length} interface(s) besides `
      + "'lo' — it is not a private network namespace and can reach beyond itself");
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

  const up = bringLoUp();
  if (up) return refuse(up);
  try { await loopbackSelfTest(); } catch (e) {
    return refuse(`the namespace loopback does not work after bringing it up (${errMsg(e)})`);
  }

  if (!tell('started')) return refuse('internal: the status channel (fd 3) is missing — run via `isolated`');
  try { fs.closeSync(3); } catch { /* the command must not inherit it */ }

  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
    forwardSignals(child);
    child.on('error', (e) => {
      process.stderr.write(`isolated: cannot run '${command[0]}': ${errMsg(e)}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(exitCodeOf(code, signal)));
  });
}

/**
 * Bring the namespace's loopback up. `ip` (iproute2), else `ifconfig` (net-tools);
 * neither → refuse. @returns {string} '' on success, else the reason
 */
function bringLoUp() {
  /** @type {string[]} */
  const tried = [];
  for (const [bin, argv] of /** @type {[string, string[]][]} */ ([
    ['ip', ['link', 'set', 'lo', 'up']], ['ifconfig', ['lo', 'up']]])) {
    try {
      execFileSync(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      return '';
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException & {stderr?: Buffer}} */ (e);
      tried.push(err.code === 'ENOENT' ? `${bin}: not found`
        : `${bin}: ${String(err.stderr || err.message).trim()}`);
    }
  }
  return `cannot bring the namespace loopback up (${tried.join('; ')}) — install iproute2`;
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
  case 'sandbox-port': code = await checkSandboxPort(args); break;
  case 'guard-live-port': code = await checkGuardLivePort(args); break;
  default:
    process.stderr.write(
      'usage: contract-harness.mjs <generation|require-generation N|pin|no-revendor|gate-probe> [--repo D] [--sub P] [--lib D]\n'
      + '       contract-harness.mjs isolated -- <cmd> [args…] | sandbox-port [--bare] | guard-live-port <port> [--pin-verified]\n'
      + '⇒ exit 0 pass · 1 fail · 2 no verdict (reason on the last line) · 3 usage\n');
    code = EXIT.usage;
}
process.exit(code);
