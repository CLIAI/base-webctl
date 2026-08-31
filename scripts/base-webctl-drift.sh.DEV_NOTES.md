# base-webctl-drift.sh — dev notes

## Why it exists

chatgpt-webctl's `AGENTS.md` asserted `BYTE-IDENTICAL ... never diverge` for five
modules. On 2026-08-31 all five had diverged and nobody had noticed. The claim
had been true when written and had been decaying in prose ever since.

**An invariant nobody can check cheaply stops being true quietly.** That is the
whole motivation: the assertion had to become a command.

## The normaliser is the whole design

Raw line counts are alarming and *misleading*: base-webctl was ported to ESM, so
`require`→`import` and `module.exports`→`export` dominate the delta. Reporting
only the raw number tells you to panic; reporting only "they differ" tells you
nothing.

`normalise()` therefore strips, before diffing:

* line comments, block-comment lines, JSDoc continuation lines
* `'use strict';` (a CJS-only pragma with no ESM counterpart)
* `import {x} from 'y'` / `const {x} = require('y')` → a single canonical form
* `export function` / `export const` → bare declarations
* `module.exports = …` and `export { … }` lines
* the `node:` builtin prefix
* trailing whitespace and blank lines

It is deliberately **crude and conservative**: it may leave packaging noise in
(reported as logic — a false alarm you can read) but must never hide a real
change (a false all-clear you cannot). If you extend it, preserve that bias.

## Control-tested, and it must stay that way

A drift checker that cannot fail is worse than none, so both directions were
verified against `xpra-presence.js`:

* inject a real logic change (default `timeoutMs` 8000 → 9000) → **LOGIC DRIFT**
* add a comment line → still **packaging only**

Re-run those two after any change to `normalise()`. Trusting it without the
negative control is how you end up with a tool that reports green forever.

## Two bugs that lived in this script, both invisible by reading

**A fix that had never once executed.** The pipeline ran `awk` to drop
multi-line `module.exports = { ... }` blocks and then piped into `sed` — but the
`sed` invocation still ended with `"$1"`, so it re-read the file from disk and
silently discarded awk's output entirely. The block-drop had been written,
committed, and never run. Symptom: systemd-timer reported 20 "logic" lines that
were all packaging. Nobody rediscovers that by reading the script; the two stages
look correct individually.

**Numbers for an adopted module are meaningless.** Once `lib/<mod>.js` is a
shim, diffing a 15-line shim against a 361-line implementation yields a large
count *by construction* — it measures the migration, not drift. This script
printed those numbers, and the author used them in a cross-repo brief that
reported another consumer's already-adopted modules as heavily drifted.
webctl:linkedin caught it. Adopted modules now report `n/a`, and the shim check
runs BEFORE the diffs so the numbers are never computed.

## Shim detection must come FIRST, and this generalises

webctl:mgr's framing, worth stating as a principle because it will recur across
every remaining consumer:

> **Any drift measurement over a partially-adopted fleet reports adoption as
> MAXIMAL drift unless it detects shims first** — because a shim is
> simultaneously the most-different possible *text* from the module it points
> at, and the most-converged possible *state*.

Text-distance and convergence point in opposite directions here, which is why
the naive measurement does not merely mislead, it inverts. This script tests for
`require(vendor/base-webctl)` and reports `ADOPTED (shim)` before computing any
diff. Six more consumers will be measured mid-adoption; every one of them will
hit this.

## Controls: prove the mutation LANDED

The DEV_NOTES already say to re-run both control directions after touching
`normalise()`. One sharper rule, learned by nearly getting it wrong:

**A mutation-based control must verify the mutation actually applied before its
result is evidence of anything.** A `sed` that matches nothing leaves the file
untouched, the checker dutifully reports "no difference", and that reads exactly
like a passing control. `diff` the mutated copy against the original and fail
loudly if they are identical.

This is the same class as webctl:linkedin's surviving mutants (a branch that was
unreachable, a threshold no seed sat near) — in all three cases the harness
printed a reassuring zero while being structurally incapable of producing
anything else.

## Known limits

* Line-based, not AST-based. A pure reformat (line wrapping) reads as logic
  drift. Acceptable: it errs toward a readable false alarm.
* Only compares modules present in **both** `base/lib` and `consumer/lib` by the
  same filename. A module renamed during extraction is invisible to it.
* The shim check greps for `vendor/base-webctl`, so a consumer mounting the
  submodule elsewhere reads as unwired.

## Lifted into base 2026-08-31 — and the one lesson that generalises

Authored in chatgpt-webctl during its adoption pass; lifted verbatim into base
at chatgpt-webctl@86df8dd, the first revision whose notes carried both of the
invisible bugs below. It now serves five consumers, not one.

⭐ **ANY drift measurement over a PARTIALLY-ADOPTED fleet reports adoption as
MAXIMAL drift unless it detects shims first.** This is the thing to carry
forward, because it will recur for every consumer that adopts a module:

A shim is simultaneously *the most-different possible text* from the module it
points at, and *the most-converged possible state* of that consumer. One line of
`module.exports = require('../vendor/base-webctl/lib/x.js')` against a 361-line
module is a ~100% textual diff and a 0% real diff. A tool that only counts lines
will therefore report a consumer as WORSE the instant it is fixed, and the
numbers get louder as adoption progresses — exactly backwards.

This script tests for `require(.../vendor/base-webctl` and reports
`ADOPTED (shim)` BEFORE diffing, suppressing the numbers entirely. Keep that
ordering. The failure it prevents is not cosmetic: chatgpt-webctl propagated a
table of inflated drift figures to base and to the manager, and the numbers were
believed until someone re-read them.
