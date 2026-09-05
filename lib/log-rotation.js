// lib/log-rotation.js — decide which log files rotation may delete. PURE.
//
// sm2t constants-injection seam: createLogRotation(C) with the filename pattern
// in C. Zero-dep, no top-level await, so consumers can require() it from CJS.
//
// ⚠ THE BUG THIS EXISTS TO PREVENT, measured on a live machine 2026-09-05.
// `~/.cache/CLIAI/<client>/webctl/logs/` carries a {client} segment and NO TOOL
// SEGMENT, so every *-webctl writes per-invocation logs there and anything
// wanting a durable ledger lands there too. That directory held 15 files from
// three writers, including chatgpt-webctl's append-only `ttl-gc.jsonl` — the
// audit ledger that exists so an unattended archive run can still be explained
// weeks later. telegram-webctl's `endsWith('.jsonl')` filter selected 8 files,
// ALL 8 belonging to other tools, the ledger among them, while telegram had
// written nothing in that directory at all.
//
// THE RULE: rotate ONLY files matching your own per-invocation filename
// pattern, anchored at both ends. A file you did not create is not yours to
// delete.
//
// ⚠ WHY THIS IS A FACTORY AND NOT A BYTE-SHARE. The consumers use DIFFERENT
// filename formats (chatgpt `2026-09-02T07-37-50-<pid>.jsonl`, linkedin
// `20260905T201621-<pid>.jsonl`). Shipping one repo's pattern into another makes
// every historical log in the receiving repo stop matching: unprunable,
// immortal, accumulating forever, and silent because nothing errors. That is the
// same bug with the sign flipped, and it is the MORE dangerous direction —
// deletion is eventually loud, accumulation never is.
//
// ⚠ KNOWN RESIDUAL, asserted in the tests rather than left implicit. Two
// consumers currently share a filename format byte-for-byte, so no pattern can
// separate them: a filename carries no tool identity, and attributing a file in
// a shared directory to a tool is a fact about who has written there, not
// something a regex establishes. Closing that needs a TOOL-SCOPED directory
// (lib/storage-paths.js), sequenced AFTER this — a consumer that starts writing
// to a scoped path while its pruner still watches the old one prunes nobody and
// grows forever.

/**
 * Coerce and validate `keep`. THROWS on anything that is not a non-negative
 * integer.
 *
 * ⛔ WHY THIS THROWS WHEN THE CAPTURE-GROUP FALLBACK DOES NOT. The two guards
 * point opposite ways and the distinction is load-bearing.
 *
 * The first version of this module funnelled every malformed input to budget 0
 * — and budget 0 means "delete all of ours". So the MAXIMALLY DESTRUCTIVE
 * outcome was what a MISSING ARGUMENT produced. Measured on three files:
 *
 *     keep omitted -> deletes 3     keep = NaN -> deletes 3
 *     keep = -1    -> deletes 3     keep = "2" -> deletes 3
 *     keep = 2     -> deletes 1  ✓
 *
 * And the ruled call-site idiom carries it: `maxFiles - 1` with a non-numeric
 * maxFiles is NaN.
 *
 * For a missing capture group there IS a safe fallback — whole-name ordering —
 * so not throwing costs nothing. For an invalid `keep` the only two outcomes are
 * "throw" and "delete every log we own". Both stop rotation; only one is
 * RECOVERABLE: accumulation is fixed by the next run, deletion is not fixed at
 * all. "Deletion is eventually loud, accumulation never is" ranks
 * NOTICEABILITY — here noticeability and recoverability come apart, and
 * recoverability wins.
 *
 * An exact integer STRING is coerced, because config files and env vars deliver
 * strings: `MAX_LOG_FILES=5` arriving as "5" must keep five, not delete five.
 * Anything looser ('1.5', '1e3', '0x2', ' 1 ') is refused — guessing what a
 * caller meant in a delete path is how this bug started.
 *
 * @param {unknown} keep
 * @returns {number}
 */
function validateKeep(keep) {
  /** @type {any} */
  let k = keep;
  if (typeof k === 'string') {
    if (!/^\d+$/.test(k)) k = NaN;
    else k = Number(k);
  }
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 0) {
    throw new Error(
      `selectLogsToPrune: keep must be a non-negative integer, got ${JSON.stringify(keep)}.\n` +
      '\n' +
      'Refusing rather than defaulting. Every malformed value used to become ' +
      'budget 0, which means DELETE ALL OF OURS — so a missing or NaN argument ' +
      'produced the most destructive possible outcome, silently, and it looked ' +
      'like an ordinary rotation. A loud stop is recoverable; that is not.');
  }
  return k;
}

/**
 * @param {{LOG_FILENAME_RE: RegExp, ALLOW_UNANCHORED_LOG_PATTERN?: boolean}} C per-repo constants
 * @returns {{selectLogsToPrune: Function, isOwnLogFile: Function, pattern: RegExp}}
 */
export function createLogRotation(C) {
  if (!C || !(C.LOG_FILENAME_RE instanceof RegExp)) {
    throw new Error(
      'createLogRotation: C.LOG_FILENAME_RE is required and must be a RegExp.\n' +
      '\n' +
      'It is the DEFINITION of "our own log", so there is no safe default: a\n' +
      'default would be one repo\'s format, and would either delete another\n' +
      "repo's files or silently stop pruning its own.");
  }

  // ⚠ ANCHORED AT BOTH ENDS — ENFORCED, NOT MERELY STATED.
  // "Anchor your pattern" was the rule this module exists for, and it was
  // checked by nothing: the one invariant whose violation caused the incident
  // was the one nothing enforced. webctl:base reproduced the ORIGINAL BUG
  // straight through this seam with /\.jsonl$/ — a foreign tool's file selected
  // for deletion.
  //
  // Heuristic, deliberately: it will not catch `(?:^…$)`. It catches the
  // REALISTIC mistake — reaching for `endsWith('.jsonl')` and translating it
  // literally, which is exactly how the filter that started this was written.
  // `allowUnanchored: true` is an explicit acknowledgement, not a convenience.
  const src = C.LOG_FILENAME_RE.source;
  if (!C.ALLOW_UNANCHORED_LOG_PATTERN && (!src.startsWith('^') || !src.endsWith('$'))) {
    throw new Error(
      `createLogRotation: LOG_FILENAME_RE must be anchored at BOTH ends, got /${src}/.\n` +
      '\n' +
      'An unanchored pattern matches other tools\' logs, and a file you did not ' +
      'create is not yours to delete. This is the original incident exactly: a ' +
      'blanket `.jsonl` filter in a directory shared by three tools selected 8 ' +
      'files, all 8 belonging to another tool, including an audit ledger.\n' +
      '\n' +
      'Set C.ALLOW_UNANCHORED_LOG_PATTERN = true to acknowledge deliberately.');
  }

  // ⚠ NORMALISE THE FLAGS — /g and /y make `exec` and `test` STATEFUL.
  // Both advance `lastIndex` on a match, so a global pattern matches one file,
  // skips the next, matches the one after — silently, and differently on each
  // call depending on where the previous one left off. Measured on four files
  // with keep=1: unfixed selects ["a1.log"] (2 of 4 recognised), fixed selects
  // ["a1.log","a2.log","a3.log"]. In a delete path that is a WRONG answer, not a
  // slow one, and the survivors look like an ordinary rotation. The pattern is
  // injected, so the caller's flags are not ours to trust.
  const pattern = (C.LOG_FILENAME_RE.global || C.LOG_FILENAME_RE.sticky)
    ? new RegExp(C.LOG_FILENAME_RE.source, C.LOG_FILENAME_RE.flags.replace(/[gy]/g, ''))
    : C.LOG_FILENAME_RE;

  /** @param {string} name @returns {boolean} */
  function isOwnLogFile(name) {
    return pattern.test(String(name == null ? '' : name));
  }

  /**
   * Select which files rotation may delete, oldest first.
   *
   * ⭐ ORDERING COMES FROM CAPTURE GROUP 1, NEVER FROM mtime OR THE WHOLE NAME.
   *
   * mtime records when a run ENDED — a job started 09:00 and finished 12:00
   * looks NEWER than one started 11:00 — and it is mutable by touch, rsync
   * without -t, a restore from backup, a container image copy. Any of those
   * silently reorders a DELETE queue. chatgpt-webctl sorted by mtime until
   * 2026-09-05 and that is the knob that put the audit ledger inside the kill
   * window: under name-ordering it survived, under mtime it did not.
   *
   * Whole-filename ordering is safe only while every format is fixed-width —
   * and the entire reason this pattern is INJECTED is that the formats differ.
   * A sort correct only under an assumption the module explicitly rejects is
   * wrong. It also breaks on a variable-width `-<pid>` suffix, where `-9` sorts
   * after `-10`.
   *
   * The captured timestamp is format-independent AND immutable, and pattern and
   * ordering cannot drift apart because they are one declaration.
   *
   * ⭐ `keep` IS A POST-CONDITION: how many of OUR files remain when this call
   * returns. Not a budget, not "max files". A caller about to open a new log
   * passes `maxFiles - 1` AT THE CALL SITE — only the caller knows whether it
   * has already opened the file, and a module that assumes it is about to is
   * wrong for a caller that is only pruning. `keep: 0` deletes all of ours and
   * must never be read as "unlimited".
   *
   * Foreign files are neither deleted NOR counted toward `keep`, so a sibling
   * filling a shared directory cannot provoke us into pruning our own logs
   * early — the same collision causing a second, opposite bug.
   *
   * @param {string[]} names filenames in the log dir (not paths)
   * @param {number} keep how many of OURS may remain afterwards
   * @returns {string[]} filenames to delete, oldest first
   */
  function selectLogsToPrune(names, keep) {
    const budget = validateKeep(keep);
    const ours = [];
    for (const name of (names || [])) {
      const m = pattern.exec(String(name));
      // `m[1] ?? name` (NOT `m[1] ?? m[0]`): a pattern with no capture group
      // would otherwise make
      // every key compare equal and delete order silently become readdir order.
      // The fallback is exactly whole-filename ordering. It must NOT throw —
      // callers wrap rotation in try/catch, so a throw stops rotation silently
      // and logs accumulate forever, which is the direction that never
      // announces itself. A guard failing toward silence is worse than the bug.
      if (m) ours.push({ name: String(name), key: m[1] !== undefined ? m[1] : String(name) });
    }
    if (ours.length <= budget) return [];
    // Tie-break on the full name so the delete set never depends on readdir
    // order: a rotation picking different victims on different runs is not
    // reproducible and cannot be tested.
    ours.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1
      : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
    return ours.slice(0, ours.length - budget).map((e) => e.name);
  }

  return { selectLogsToPrune, isOwnLogFile, pattern };
}
