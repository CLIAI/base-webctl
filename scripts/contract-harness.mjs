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
//   node <base>/scripts/contract-harness.mjs isolated [--keep <path>]… -- <cmd> [args…]   # every mutation arm (xrl4)
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
//
// It FAILS CLOSED: there is no path on which the command runs on the host.

const SELF = fileURLToPath(import.meta.url);
/** base's repo root (SELF is <root>/scripts/…) — kept visible under the /tmp mask. */
const SELF_ROOT = path.resolve(path.dirname(SELF), '..');
const ISOLATED_INNER = '__isolated-inner';
/** The tmpfs source tag `isolated` mounts with; the nesting proof looks for it. */
const MASK_SOURCE = 'webctl-isolated';
/** Env vars the command never inherits: each one NAMES a host socket or display. */
const SCRUBBED_ENV = Object.freeze(['DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK',
  'DBUS_SESSION_BUS_ADDRESS', 'DOCKER_HOST', 'XDG_RUNTIME_DIR']);

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

const ISOLATED_USAGE = 'usage: contract-harness.mjs isolated [--keep <path>]… -- <cmd> [args…]\n';

/**
 * `isolated [--keep <path>]… -- <cmd> [args…]` — run <cmd> with NO host network and
 * NO host unix sockets.
 *
 * The outer half spawns
 * `unshare -rnm --propagation=private <node> <this file> __isolated-inner <netns> -- <cmd…>`
 * with two extra pipes: fd 3 is the STATUS channel, fd 4 carries the masking PLAN
 * (host mount-ns id, cwd, paths to re-expose, the host's path sockets — a list that
 * can be long, so never argv). The inner half proves the isolation and masks (below),
 * then writes `started` on fd 3 and runs the command; any refusal is written as
 * `fail <reason>` instead. ⇒ The outer half can tell "isolation was refused" from
 * "the command exited 1", and reports the former ONCE, as FAIL, with the reason.
 *
 * ⛔ /tmp IS MASKED, AND THE ARM USUALLY LIVES THERE. Worktrees, the `--scratch` gate's
 * consumer clones and test fixtures are all commonly under /tmp. So these stay
 * visible at their SAME absolute paths: the cwd, base's own repo root, the command
 * if given by absolute path, node itself, and every `--keep <path>`. A keep may not
 * be /tmp or /run itself, an ancestor of either, a path under /run, or contain the
 * home directory. ⚠ Only `--keep` paths are EXEMPT from the socket check below — a
 * socket in the cwd is still covered if it answers, so `cwd = $HOME` cannot re-open
 * the ssh ControlMaster.
 *
 * ⛔ NEVER FALLS BACK TO THE HOST. No unshare, userns disabled, no `ip`/`ifconfig`, no
 * `mount`, a loopback that will not come up, a namespace that still sees a non-loopback
 * interface or a listener, a mount that fails, a host socket that still answers after
 * masking — each is FAIL, and the command is not started. Refusals carry COUNTS,
 * never socket paths: they get pasted into a public repo's logs.
 *
 * The command's env drops DISPLAY, WAYLAND_DISPLAY, SSH_AUTH_SOCK,
 * DBUS_SESSION_BUS_ADDRESS, DOCKER_HOST and XDG_RUNTIME_DIR and gets TMPDIR=/tmp —
 * on the nested path too. argv goes through as an ARRAY: no shell sees the command.
 * @param {string[]} a
 * @returns {Promise<number>}
 */
function runIsolated(a) {
  const sep = a.indexOf('--');
  const opts = sep < 0 ? a : a.slice(0, sep);
  const command = sep < 0 ? [] : a.slice(sep + 1);
  /** @type {string[]} */
  const keeps = [];
  let bad = sep < 0 || command.length === 0;
  for (let i = 0; i < opts.length && !bad; i++) {
    if (opts[i] === '--keep' && opts[i + 1]) keeps.push(opts[++i]);
    else bad = true;
  }
  if (bad) {
    process.stderr.write(ISOLATED_USAGE);
    return Promise.resolve(EXIT.usage);
  }
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
    const nestedPlan = planKeeps(keeps, []);
    if (nestedPlan.usage) {
      process.stderr.write(`isolated: ${nestedPlan.usage}\n${ISOLATED_USAGE}`);
      return Promise.resolve(EXIT.usage);
    }
    return runCommand(command); // provably inside already: do not unshare again
  }
  let hostNs = '';
  let hostMnt = '';
  try {
    hostNs = fs.readlinkSync('/proc/self/ns/net');
    hostMnt = fs.readlinkSync('/proc/self/ns/mnt');
  } catch (e) {
    return Promise.resolve(report('isolated', EXIT.fail,
      `cannot read this process's namespaces (${errMsg(e)}), so isolation cannot be PROVEN; `
      + 'refusing to run the command on the host'));
  }
  const plan = planKeeps(keeps, [
    { p: process.cwd(), label: 'the working directory' },
    { p: SELF_ROOT, label: "base's repo root" },
    ...(path.isAbsolute(command[0]) ? [{ p: command[0], label: 'the command' }] : []),
    { p: process.execPath, label: 'node' },
  ]);
  if (plan.usage) {
    process.stderr.write(`isolated: ${plan.usage}\n${ISOLATED_USAGE}`);
    return Promise.resolve(EXIT.usage);
  }
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
  const payload = JSON.stringify({ hostMnt, cwd: process.cwd(), binds: plan.binds, exempt: plan.exempt, sockets });
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn('unshare',
        ['-rnm', '--propagation=private', process.execPath, SELF, ISOLATED_INNER, hostNs, '--', ...command],
        { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
          env: { ...process.env, [HOST_NETNS_ENV]: hostNs, [HOST_MNTNS_ENV]: hostMnt } });
    } catch (e) {
      resolve(report('isolated', EXIT.fail, `cannot start unshare (${errMsg(e)}); refusing to run on the host`));
      return;
    }
    forwardSignals(child);
    const planPipe = /** @type {import('node:stream').Writable | null | undefined} */ (child.stdio[4]);
    planPipe?.on('error', () => { /* the inner side refused or never started */ });
    planPipe?.end(payload);
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
 *   6. /run, /tmp (and a real /var/run) are covered with a fresh tmpfs, the kept
 *      paths bound back — and /proc/self/mountinfo then SHOWS our tmpfs on top;
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
  /** @type {{hostMnt: string, cwd: string, binds: string[], exempt: string[], sockets: string[]}} */
  let plan;
  try {
    // node's stdio 'pipe' is a socketpair, not a FIFO; anything else is not ours
    const st = fs.fstatSync(4);
    if (!st.isSocket() && !st.isFIFO()) throw new Error('fd 4 is not a pipe');
    plan = JSON.parse(fs.readFileSync(4, 'utf8'));
    try { fs.closeSync(4); } catch { /* the command must not inherit it */ }
    const strs = (/** @type {unknown} */ x) => Array.isArray(x) && x.every((s) => typeof s === 'string');
    if (typeof plan.hostMnt !== 'string' || typeof plan.cwd !== 'string' || !strs(plan.binds)
      || !strs(plan.exempt) || !strs(plan.sockets)) throw new Error('malformed');
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

  const up = bringLoUp();
  if (up) return refuse(up);
  try { await loopbackSelfTest(); } catch (e) {
    return refuse(`the namespace loopback does not work after bringing it up (${errMsg(e)})`);
  }

  const masked = maskSocketDirs(plan.binds);
  if (masked) return refuse(masked);
  const unmasked = unmaskedDirs();
  if (unmasked.length) {
    return refuse(`after masking, ${unmasked.join(', ')} still lack(s) the '${MASK_SOURCE}' tmpfs on top`);
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

  if (!tell('started')) return refuse('internal: the status channel (fd 3) is missing — run via `isolated`');
  try { fs.closeSync(3); } catch { /* the command must not inherit it */ }

  return runCommand(command);
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

/** Is `p` equal to `dir` or beneath it? @param {string} p @param {string} dir */
function isWithin(p, dir) { return p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`); }

/**
 * Decide what must stay visible once /tmp is masked. ⚠ Messages name the keep by
 * its LABEL and the masked directory, never by its path.
 * @param {string[]} explicit `--keep` paths
 * @param {{p: string, label: string}[]} implicit
 * @returns {{binds: string[], exempt: string[], usage?: string, refuse?: string}}
 */
function planKeeps(explicit, implicit) {
  const { tmp, all } = maskedDirs();
  let home = '';
  try { home = fs.realpathSync(os.homedir()); } catch { /* no home: nothing to protect */ }
  /** @type {string[]} */ const binds = [];
  /** @type {string[]} */ const exempt = [];
  const items = [...explicit.map((p, i) => ({ p, label: `--keep #${i + 1}`, explicit: true })),
    ...implicit.map((k) => ({ ...k, explicit: false }))];
  for (const k of items) {
    let real = '';
    try { real = fs.realpathSync(path.resolve(k.p)); } catch {
      if (k.explicit) return { binds, exempt, usage: `${k.label} does not exist` };
      continue; // an absent command fails on its own (127), visibly
    }
    for (const m of all) {
      if (isWithin(m, real)) { // real IS a masked dir, or an ancestor of one
        if (k.explicit) {
          return { binds, exempt, usage: `${k.label} is ${real === m ? m : `an ancestor of ${m}`} — `
            + 'keeping it would undo the masking; keep a test-owned directory beneath it' };
        }
        if (real === m) {
          return { binds, exempt, refuse: `${k.label} is ${m} itself, which is masked — run from a `
            + 'test-owned directory beneath it' };
        }
        // e.g. cwd '/': nothing beneath it needs re-exposing
      } else if (m !== tmp && isWithin(real, m)) {
        const why = `${k.label} is beneath ${m}, where host sockets live, and cannot be re-exposed `
          + 'without re-exposing them';
        return k.explicit ? { binds, exempt, usage: why } : { binds, exempt, refuse: why };
      }
    }
    if (k.explicit && home && isWithin(home, real)) {
      return { binds, exempt, usage: `${k.label} contains the home directory — a keep exempts the `
        + 'sockets beneath it, and home holds the ssh ones; keep a test-owned directory' };
    }
    if (isWithin(real, tmp) && real !== tmp) binds.push(real);
    if (k.explicit) exempt.push(real);
  }
  // A path beneath another kept path is already re-exposed by it.
  const sorted = [...new Set(binds)].sort((x, y) => x.length - y.length);
  /** @type {string[]} */ const outer = [];
  for (const b of sorted) if (!outer.some((o) => isWithin(b, o))) outer.push(b);
  return { binds: outer, exempt };
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
 * Run `mount` (util-linux) with an argv ARRAY. @param {string[]} argv
 * @param {string} what for the reason @param {string[]} [redact] paths never to print
 * @returns {string} '' on success, else the reason
 */
function mountOrWhy(argv, what, redact = []) {
  const r = spawnSync('mount', argv, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
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
 * Cover /run, /tmp (and a real /var/run) with a fresh tmpfs, re-exposing `binds`
 * (absolute real paths beneath /tmp) at the SAME paths.
 *
 * ⛔ /tmp hides the arm itself, so: mount the new /run FIRST, rbind each kept path to
 * a staging point INSIDE it while the old /tmp is still visible, mount the new /tmp,
 * recreate the skeleton, and MOVE each staged mount back to its original path.
 * @param {string[]} binds @returns {string} '' on success, else the reason
 */
function maskSocketDirs(binds) {
  const { run, tmp, all } = maskedDirs();
  const opts = (/** @type {string} */ d) => (d === tmp ? 'mode=1777' : 'mode=0755') + ',nosuid,nodev';
  const cover = (/** @type {string} */ d) => mountOrWhy(['-t', 'tmpfs', '-o', opts(d), MASK_SOURCE, d],
    `cover ${d} with a fresh tmpfs`);
  const stage = path.join(run, '.webctl-keep');
  try {
    for (const d of all.filter((x) => x !== tmp)) { const e = cover(d); if (e) return e; }
    fs.mkdirSync(stage);
    const isDir = binds.map((b) => fs.statSync(b).isDirectory());
    for (const [i, b] of binds.entries()) {
      const s = path.join(stage, String(i));
      if (isDir[i]) fs.mkdirSync(s); else fs.writeFileSync(s, '');
      const e = mountOrWhy(['--rbind', b, s], `stage kept path ${i + 1} of ${binds.length}`, [b]);
      if (e) return e;
    }
    const e = cover(tmp);
    if (e) return e;
    for (const [i, b] of binds.entries()) {
      const s = path.join(stage, String(i));
      if (isDir[i]) fs.mkdirSync(b, { recursive: true });
      else { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.writeFileSync(b, ''); }
      const m = mountOrWhy(['--move', s, b], `re-expose kept path ${i + 1} of ${binds.length}`, [b]);
      if (m) return m;
      try { if (isDir[i]) fs.rmdirSync(s); else fs.unlinkSync(s); } catch { /* left empty: harmless */ }
    }
    try { fs.rmdirSync(stage); } catch { /* left empty: harmless */ }
  } catch (e) {
    let msg = errMsg(e);
    for (const b of binds) msg = msg.split(b).join('<path>');
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
  let txt = '';
  try { txt = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return ['/proc/self/mountinfo (unreadable)']; }
  const mounts = txt.split('\n').filter(Boolean).map((l) => {
    const [pre, post = ''] = l.split(' - ');
    const f = pre.split(' ');
    const g = post.split(' ');
    return { id: f[0], parent: f[1], at: f[4], fstype: g[0], source: g[1] };
  });
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
 * Run the user command with the caller's cwd/stdio and a SCRUBBED env; resolve with
 * its exit code (128+signal when killed, 127 when it cannot be started).
 *
 * ⛔ The scrub applies on BOTH paths (fresh and nested): the vars it drops NAME host
 * sockets and displays, and TMPDIR is reset because an inherited one may name a
 * directory the /tmp mask just hid.
 * @param {string[]} command @returns {Promise<number>}
 */
function runCommand(command) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, TMPDIR: '/tmp' };
  for (const k of SCRUBBED_ENV) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
    forwardSignals(child);
    child.on('error', (e) => {
      process.stderr.write(`isolated: cannot run '${command[0]}': ${errMsg(e)}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(exitCodeOf(code, signal)));
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

const HOST_NETNS_ENV = 'WEBCTL_HOST_NETNS';
const HOST_MNTNS_ENV = 'WEBCTL_HOST_MNTNS';

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
 * no host unix sockets? All five facts must hold; every one that fails is named.
 * @returns {{inside: boolean, why: string, facts: Record<string, any>}}
 */
function kernelInsideProof() {
  const recorded = process.env[HOST_NETNS_ENV];
  const recordedMnt = process.env[HOST_MNTNS_ENV];
  let netns = '';
  try { netns = fs.readlinkSync('/proc/self/ns/net'); } catch { /* named below */ }
  let mntns = '';
  try { mntns = fs.readlinkSync('/proc/self/ns/mnt'); } catch { /* named below */ }
  const uidMap = uidMapKind();
  const extra = extraInterfaces();
  const unmasked = unmaskedDirs();
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
  return { inside: fails.length === 0, why: fails.join('; '),
    facts: { netns, recorded: recorded ?? null, uidMap, extraInterfaces: extra,
      mntns, recordedMnt: recordedMnt ?? null, unmasked } };
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
  case 'sandbox-port': code = await checkSandboxPort(args); break;
  case 'guard-live-port': code = await checkGuardLivePort(args); break;
  case 'isolation-check': code = await checkIsolation(args); break;
  default:
    process.stderr.write(
      'usage: contract-harness.mjs <generation|require-generation N|pin|no-revendor|gate-probe> [--repo D] [--sub P] [--lib D]\n'
      + '       contract-harness.mjs isolated [--keep <path>]… -- <cmd> [args…] | isolation-check <port>… | sandbox-port [--bare] | guard-live-port <port> [--pin-verified]\n'
      + '⇒ exit 0 pass · 1 fail · 2 no verdict (reason on the last line) · 3 usage\n');
    code = EXIT.usage;
}
process.exit(code);
}
