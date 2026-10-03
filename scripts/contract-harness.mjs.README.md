# `contract-harness.mjs` — the checks every contract was copying

A consumer's `test-against-base.sh` calls this instead of reimplementing the
checks that have rotted in three lanes at three different ages.

```sh
node "$BASE_DIR/scripts/contract-harness.mjs" generation
node "$BASE_DIR/scripts/contract-harness.mjs" pin         --repo . --sub vendor/base-webctl
node "$BASE_DIR/scripts/contract-harness.mjs" no-revendor --repo . --sub vendor/base-webctl --lib lib
```

**Exit:** `0` pass · `1` fail · `2` **no verdict** (reason is the last line) ·
`3` usage.

⇒ **The harness owns the exit code.** A contract never re-implements
`[ "$rc" = "2" ] && { … }`, which as an arm's last statement returns 1 under
`set -e` and turns a *green* suite red.

## Why a library

**A defective contract reports green.** Every other duplication in this family
fails loudly; this one fails by reassuring us. Three defects, three lanes, three
ages — and two of the three were found by someone looking *across* copies rather
than by any lane reading its own.

## The checks

`require-generation`, `pin`, `no-revendor` and `generation` are for your contract;
`gate-probe` is for the release gate (see below).

## ⛔ LOAD-BEARING: the checker lives INSIDE the thing it checks

The harness is `vendor/base-webctl/scripts/contract-harness.mjs` — **inside the
submodule.** So drifting a lane to an **older** base also **downgrades the checker**
meant to catch that drift. *Measured by `substack`:* its first drift control reported
`"generation":2` PASS, because the drift had replaced generation 3 with generation 2.

⇒ **Every fix in a newer harness protects only a contract that ENFORCES a floor.**
Recording `CONTRACT_HARNESS_GENERATION` in a comment is not enforcing it. Put this
first in your contract, and treat **any** non-zero as FAIL:

```bash
node "$H" require-generation 4 || { echo "FAIL: base harness below generation 4 (downgraded submodule?)"; exit 1; }
```

* ⭐ **Why a VERB, not `generation --min N`.** Measured: every harness before
  generation 4 **ignores unknown flags** — generation 2 answers `generation --min 3` with
  "generation 2", exit 0. A floor spelled as a flag **fails open on exactly the
  downgraded harness it exists to catch.** An unknown **verb** exits 3 on every older
  harness, so `require-generation` fails **closed** even where it does not exist.
  Generation 4+ refuses `generation <args>` so nobody adopts the flag form.
* ⚠ **Base cannot make you call it.** Base's code is what gets downgraded; only your
  contract, which lives in your repo, survives. ⇒ Prove it with a **downgrade arm**.

**Reference arms** (`substack`'s `test/pin-drift-test.js`, the shape every lane proves):

| arm | set-up | expected |
|---|---|---|
| control | worktree = gitlink = a tag | PASS |
| same-generation drift | worktree moved to another commit of the same generation | FAIL — `pin` DRIFT |
| ⛔ **downgrade drift** | worktree moved to an **older** base whose harness is a lower generation | FAIL — **`require-generation`**, because the old `pin` cannot see it |
| undeclared | a checkout with no committed gitlink | FAIL — `pin` UNDECLARED |
| swap signal | `WEBCTL_DECLARED_PIN` set, `WEBCTL_GATE_SWAPPED=0`, drift | FAIL — DRIFT (see below) |

### `pin`

Asserts the pin is an exact tag, read from the **committed gitlink** — not the
submodule worktree. Those differ exactly when the release gate has swapped the
submodule, which is when a contract is most likely to report a tag its own repo
does not declare.

⛔ **`WEBCTL_DECLARED_PIN` COMES FROM THE GATE PROCESS, NOT FROM YOUR PIN.** It
is set in your contract's environment at runtime by `test-all-consumers.sh`
before it swaps your submodule. ⇒ **A lane on any pin, however old, receives
it** — there is no version in which "my base does not export it yet" is a
reason to skip it. *(One lane deferred exactly on those grounds, which is the
likeliest reason the correct key was used zero times in four attempts.)*

⛔ **THE ONLY SWAP SIGNAL IS `WEBCTL_GATE_SWAPPED=1`. `WEBCTL_DECLARED_PIN` is a
declaration, not a swap.** Since v0.24 the gate sets the declared pin on **every**
run, swapped or not. A carve-out keyed on "DECLARED_PIN is set" — or, as base's own
generation 3 did, on "DECLARED_PIN ≠ worktree" — **passes real drift under the gate**:
`fetlife` measured it in its contract, and base then measured the same defect in its
own harness (`SWAPPED=0` + drift ⇒ *"the release gate has swapped this submodule"*, NO
VERDICT — a false sentence). Fixed in generation 4. *(Keyings so far: `WEBCTL_BASE_DIR`,
then `DECLARED_PIN`, then declared ≠ worktree; the fifth asks the one party that knows
— the swapper.)*

⚠ **A test that scrubs the gate's variables must scrub ALL of them** —
`WEBCTL_GATE_SWAPPED`, `WEBCTL_DECLARED_PIN` and `WEBCTL_BASE_DIR`. Scrubbing the
declared pin but not the swap flag leaks `SWAPPED=1` into a local fixture under the
gate (measured in a lane at the v0.26.0 candidate: its control arm went NO VERDICT).
`pin` names that state *INCONSISTENT gate signal* rather than calling it a swap.

Under a real swap the check returns **no verdict**, never a fail: a candidate is
not yet tagged, and failing there is a vacuous RED. *A gate that always blocks gets
overridden.*

### `no-revendor`

⚠ **GENERATION 2 CHANGED WHAT `pass` MEANS HERE.** Generation 1 read only the TOP
LEVEL of both trees and matched only IDENTICAL FILENAMES. Since **half of base's own
lib is nested**, that check could not see most of the library: three planted
re-vendors (a nested module copied flat, a copy into a subdirectory under a new
name, and a rename in place) all reported `pass`. ⇒ Generation 2 walks both trees
**recursively** and matches by **normalised content** as well as by name, so a copy
is caught under any name in any directory, and after reformatting or re-commenting.

⛔ **GENERATION 5 CHANGED IT AGAIN — the name match found copies and then excused
them.** Generation 4 cleared any same-named file that imported *anything* from base's
lib. An edited copy of a base module imports that module's **siblings**, as the
original does, so the realistic re-vendor was exactly the case the excuse fired on
(`substack`: a stale `lib/cdp-client.js` requiring base's `cdp-rewrite.js` reported
PASS). **The rule now:**

* A local file whose **basename** equals that of any base module — at any depth on
  either side; directory position is ignored, so moving a copy does not hide it — is
  a **FAIL**,
* **unless** its code (comments stripped) imports, requires or re-exports **that same
  base module**: a relative or absolute specifier resolving to a base module of the
  same basename. A sibling module does not count, and neither does base's
  `index.js` — both are what a copy imports too.
* Bare specifiers (package names, import maps) are not resolved, so they do not
  excuse a file: fails **closed**, naming it.

Measured 2026-10-03 across every locally present consumer: all same-named shims
(bare re-exports, factories bound to local constants, wrappers that add functions)
import their own base module and stay green; the only reds are two local
`cdp-client.js` copies.

⛔ **What it still does NOT catch:** a copy that was **edited** and **renamed**
(whole-file hashing cannot see it), and a same-named file that imports its base
module is treated as a wrapper however much else it defines. The PASS reason says
both explicitly rather than leaving an impression of coverage.


Asserts no local file shadows a base module. **Asserts code, never prose** —
comments are stripped first, because the check this replaces grepped for the
vendor path and matched the string inside the shim's own comment.

⚠ Examining **zero** files FAILS. "No re-vendoring found" over nothing is the
shape that let the original grep pass.

### `generation`

⚠ **Now 5.** History, each a change in what a verdict MEANS:

* **2** — `no-revendor` sees copies in subdirectories and under new names.
* **3** — `pin` FAILS on drift and on an undeclared submodule; only a mode-160000
  entry is a gitlink (`substack`).
* **4** — the swap carve-out keys on `WEBCTL_GATE_SWAPPED=1` only (`fetlife`);
  `require-generation` added; `generation` refuses arguments.
* **5** — `no-revendor`: a file named like a base module is a shim only if it imports
  **that** module; importing a sibling no longer excuses an edited copy (`substack`).
  ⚠ Lanes that were green on 4 with a same-named copy go **red** — that is the fix.

A sweep asks *"who is below 5?"* — and, since generation 4, *"whose contract does not
call `require-generation`?"*, because a recorded number nobody checks protects nothing.

### `require-generation <N>`

Exit 0 when this harness is generation ≥ N (with a note on stderr when above, so a
stale floor is visible), **1 when below**, 3 for a bad N — and **3 on every harness
older than generation 4**, which does not know the verb. ⇒ **ANY non-zero = FAIL.**


Prints `HARNESS_GENERATION`. A consumer records the generation it was written
against, so a sweep asks **"who is below N?"** instead of "who differs?" —
because rot and legitimate per-lane customisation look identical in a diff.

⚠ **A generation marker is not sufficient on its own.** It says an old copy
carries old rot. It does *not* say a **correct** copy's assumptions have expired
against a newer pin. Two mechanisms.

See `.DEV_NOTES.md`.

### `gate-probe` — for the GATE, not for your contract

```sh
node <base>/scripts/contract-harness.mjs gate-probe --repo . --sub vendor/base-webctl
```

⚠ **A lane does not call this.** The release gate calls it, inside the window
where it has swapped a consumer's submodule to a release candidate, and it
asserts that `pin` **declines a verdict** there — because a candidate is not
tagged. Run by hand it always returns **no verdict** (exit 2), never pass: there
is no swap window, so there is nothing to assert.

| state | result |
|---|---|
| `WEBCTL_GATE_SWAPPED` unset | **no verdict** — not exercised, and not a pass |
| gate reports a swap, no `WEBCTL_DECLARED_PIN` | **fail** — the state that variable exists to prevent |
| gate reports a swap, `pin` declines and names both SHAs | **pass** |
| gate reports a swap, `pin` returns PASS or FAIL | **fail** — base's defect, not the consumer's |

⇒ Its precondition comes from **`WEBCTL_GATE_SWAPPED`, set by the gate**, and
deliberately not from comparing the declared pin against the worktree — which is
the comparison it is testing. A guard and a claim that read the same input cannot
disagree.

## ⛔ Contract checklist: a green exit is not a green run

* **Run your suite through `scripts/run-tests-strict.mjs`** (or add
  `scripts/strict-reporter.mjs` as a second reporter). node:test lets a `describe()`
  that throws while registering **vanish** — `not ok`, `# fail 0`, exit 0 — and a
  zero-test guard does not catch it, because the tests that did register still count.
  The strict reporter fails on the failure EVENT, fails a file that registers zero
  tests (node counts one as a pass), and strips `NODE_TEST_CONTEXT` for nested runs.
* **The gate also scans your output:** exit 0 with a TAP `not ok` (TODO/SKIP excepted)
  or spec's `✖ failing tests:` is a **FAIL**, named. ⚠ It can only scan what you
  PRINT: a contract that logs its suite and prints a summary gives it nothing to read
  (5 of 7 at v0.27.0). That is fine — **if** the summarising step is itself strict.
* **Read your own `"test"` script.** `echo "No tests yet" && exit 0` over a real suite
  (measured in a lane) never reaches node, so no reporter or scan can see it.
* **Restrict discovery to test files.** Bare `node --test` runs every `.js`/`.mjs`
  under `test/`, helpers included — base ran three helper scripts as "tests", one of
  them taking a real lock in the real `~/.cache`. Pass a glob such as
  `"test/**/*.test.{js,mjs,cjs}"`.

## ⭐ A contract's last line is API

The release gate captures the **trailing block** of your output as the FAIL
reason. ⇒ Put the actionable line last and the explanation above it; background
reasoning belongs in a file a reader opens deliberately, not one a capture lands
in by accident.

## Using the harness from a lane pinned BEFORE it existed

You do not need a tag or a bump. Under `--against-head` the gate points
`WEBCTL_BASE_DIR` at the **candidate**, so the harness is present exactly when
it matters:

```sh
if [ -f "$BASE_DIR/scripts/contract-harness.mjs" ]; then
  node "$BASE_DIR/scripts/contract-harness.mjs" pin --repo . --sub vendor/base-webctl
  rc=$?
  if [ "$rc" -eq 1 ]; then exit 1; fi        # explicit; never `[ "$rc" = 2 ] && …`
else
  ...your fallback...
fi
```

⚠ **Both paths are then live, and both need testing** — a lane that adopts this
way is running the fallback locally and the harness under the gate.

