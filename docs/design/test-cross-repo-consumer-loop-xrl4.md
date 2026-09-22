---
id: xrl4
title: "Cross-Repo Consumer Test Loop & test-against-base Contract"
category: test
created: "2026-06-22"
updated: "2026-08-31"
status: draft
tags: [cross-repo, ci, test-loop, contract, headless, exit-codes, jsonl, drift-canary, semver-gate, gate-validity, vacuous-green, mutation-testing]
tech:
  - name: "Node.js"
    version: ">=18"
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: [sb7q, lszd, dip7, k7m2, v7x3]
depends_on: [sb7q]
expands: []
similar_to: []
---

# Cross-Repo Consumer Test Loop & `test-against-base` Contract

## Principle

**A base change must be provable not to break any consumer — before any consumer
adopts it.** When shared code became a submodule (`sb7q`), the old byte-identity
check stopped being meaningful (one source of truth now). It is replaced by an
automated gate: against a candidate base commit, loop every registered consumer,
run its standard test entrypoint **headlessly**, and refuse to release base if any
consumer fails. The honest boundary: this gates the **browser stack + mocks**, not
live gated sites.

## The consumer contract: `./test-against-base.sh`

Every consumer repo implements one standard executable at its root. This is the
**single contract** `base` loops over; each tool maps it onto whatever runners it
already has.

```
./test-against-base.sh [--offline | --unit | --stack]
```

* `--offline` (**default; MUST be fully no-human**) — unit suites + mocked
  browser-location / docker-mode suites. No login, no real browser, no network to
  a gated site. This is what the base release gate runs.
* `--unit` — unit suites only (fastest).
* `--stack` — headless real-browser stack (Xvfb + xpra + chromium pair), CDP
  probe, teardown. Gated behind `{TOOL}_DOCKER_TESTS=1`. docker-tier consumers only.

**Exit codes (authoritative):**

| Code | Meaning | Effect on the base gate |
|------|---------|--------------------------|
| `0`  | pass | counts as PASS |
| `1`  | fail | **blocks** the base release |
| `2`  | **no verdict** — the contract ran but declined to judge. The consumer MUST print why as its last line. | counts as **SKIP**, not fail |

⛔ **Exit 2 does NOT mean "needs human".** It once did, and the gate printed
that label — asserting a cause it was never told. A consumer returns a NUMBER;
only the consumer knows the reason. The two states routinely differ, and a
*single* contract holds both: `gemini-webctl` exits 2 for "no unit suite yet"
(nobody is blocked, no human is wanted) and for "needs docker plus a human
Google sign-in" (somebody is). A third exit code cannot separate them — they
come from the same script under different modes — so the reason travels as
TEXT, not as a code. Adding codes 3, 4, 5 for each new flavour re-runs the same
mistake at higher arity; see `arch-coincident-fields-t2wf`.

⇒ **Contract obligation:** a contract exiting 2 prints its reason as its last
non-blank line. ⇒ **Gate obligation:** the gate quotes that line and never
substitutes a cause of its own.

### ⛔ Assert the FINDING, never a proxy for it

*(Originally written as "never the exit status". The status is one proxy; it is
not the only one, and naming the general form changes the fix — see the clock
below.)*

A status says *something* was wrong. It does not say *the thing you are testing
for* happened — and a check that accepts the status accepts every other reason
too.

Measured three ways on 2026-09-05, in three repos, all failing toward green:

* A replay fixture reverted to its pre-fix state still exited 1, but for a
  different reason than the defect it replays: `mutated -> exit=1, ledger-FAIL
  lines: 0` against `fixed -> exit=1, ledger-FAIL lines: 1`. A control asserting
  `rc === 1` passes the broken fixture cleanly. *(cgwc:main)*
* `tags-since-pin`'s negative arm asserted `rc=0 and no matches`, which is also
  what the probe returns over an EMPTY RANGE — so the arm proving it can say
  NOT FOUND went green while comparing nothing. It now asserts it verifiably saw
  the range.
* A consumer contract returning 2 for "no suite yet" and 2 for "needs a human"
  is the same shape one layer up: the right number, an unstated reason. Which is
  why the reason travels as text (above) rather than as more codes.

⇒ **A control must assert the finding it exists to produce, and a control that
replays only part of a condition misrepresents the history it claims to replay.**
Both failures are toward GREEN, which is the direction nobody investigates.

⚠ **THE CLOCK IS THE MOST COMMON PROXY, AND NAMING IT "TIMING" INVITES THE WRONG
FIX.** A test that reads a directory straight after `closeLogging()` and expects
the new file is observing a *listing* (a proxy) for *the stream having flushed*
(the fact). Calling that "a timing bug" suggests **wait longer** — which is still
a proxy and still wrong under load. Calling it what it is suggests **await the
subject's own completion signal**, which is different code. Same shape as
inferring "was blocked" from "did not acquire within 150 ms".
*(linkedin-webctl's reclassification, adopted; it immediately caught two more
instances in the reporting repo, where `sleep(200)` was replaced by awaiting the
last message — causal and free, since ordered delivery on one socket proves every
earlier frame was processed.)*

⇒ A clock proxy differs from the others in ONE respect only: it is
**load-dependent**, so its false result appears and disappears while nothing
changes. That alters the SYMPTOM — a flake rather than a steady false green — and
therefore how it is misdiagnosed (as flakiness, "fixed" with a longer sleep). It
does not alter what it is or how to fix it. ⚠ Under a CPU cap, every wall-clock
margin is a joint measurement of the code and the cap; prefer a completion signal,
and where something genuinely must be timed, measure CPU time.

⇒ A deadline is still legitimate where it **bounds a failure** rather than
standing in for a success: a 5 s "give up" is a timeout, a 200 ms "it must be done
by now" is a proxy.

### ⛔ Enumerate what a teardown KEEPS — silence misleads as well as a false claim

Two teardown messages for the same behaviour, measured 2026-09-22:

| message | accurate? | belief produced |
|---|---|---|
| `"containers removed"` | **false** | everything is gone |
| `stopped.` | **true** | everything is gone |

⇒ **Both produce the same wrong belief**, and the reader of the accurate one
loses an hour on a `docker volume rm` that cannot succeed while a stopped
container holds the volume. ⇒ So the requirement is **"enumerate what is KEPT,
and the removal order"** — not "do not make false claims". **An accurate message
creates a false belief by omission**, which is the same reason a green summary
line is not a verdict.

⚠ **Sweep BOTH artifact classes after a verification run.** A verification slug
litters two places, by two mechanisms base owns — a stop keeps the volume, and
the profile resolver used to `mkdir` eagerly. Measured on this box: **13 x11
volumes, 11 of them orphans from verification slugs in two lanes, neither of
which had found them.** All 0 B. ⇒ The cost is never disk — *clutter nobody can
explain is how a stale artifact gets read as a live one*. The names are
slug-anchored and therefore enumerable, so the sweep is mechanical.

### ⛔ A fixture where RIGHT and WRONG agree is not coverage

A property test whose mutation **passes** is testing something else.

Measured twice on 2026-09-22, in two repos, both by the author of the test:

* A fixture for an ordering rule used a one-second-old reading, which never
  trips the age check — so reordering the two checks changed nothing and the
  test passed **under the mutation it was written to catch**. The pre-existing
  test was doing all the work.
* base's own `TEARDOWN_CONTRACT` test asserted `removes === []` **against the
  constant** and never called `shutdown()`. Adding `docker.rm()` to `shutdown()`
  left it GREEN — in the one contract whose entire content is a claim about what
  a verb does NOT do.

⇒ **The fixture must be one where the wrong implementation gives a DIFFERENT
answer.** This is the same defect as an assertion reading its expectation from
the artifact under test: in both, right and wrong agree, and agreement is
mistaken for confirmation.

⚠ Note which half of base's suite had it. The `required`/`forbidden` checks were
control-tested and caught their mutations; the teardown check was not, and it
was the one asserting a *negative*. **A claim that something does not happen is
the easiest to assert vacuously**, because the default state already satisfies
it.

### ⛔ Hermetic means BEHAVIOURALLY hermetic, not LOCATION-hermetic

A bundle of reference tests was verified independent of docker, the clock and
the machine's boot state — and never checked for independence from the author's
**directory layout**. Handed over flat, its repo-relative imports resolved
outside the bundle and the run died with `ERR_MODULE_NOT_FOUND` before a single
assertion, while its README stated *"every check control-tested, each failing
with its own distinct message"*.

⇒ The defect is not the import path. It is that **a reader records those
properties as verified on the strength of a suite they believe ran.** Artifact
correct, packaging carrying an assumption from the sender.

### ⛔ Fixing an eager side effect at ONE call site says nothing about the others

A consumer made its own profile resolver pure and recorded the fix as complete.
base's driver went on calling the eager one — so **constructing a driver still
created a profile directory**, before any bring-up and whether or not one ever
happened. base's own registry suite was writing into the real `~/.cache` on
every run.

⚠ And the repair introduced a second instance immediately: a pure resolver
beside an eager one is **two functions computing one value**, so a test stubbing
only the eager one got the real path back from the pure one — and the profile
lock then created it. ⇒ The eager form must be **defined in terms of** the pure
one, never derive the path independently.

⇒ When you remove a side effect, enumerate every caller of the thing you fixed,
and check the repair did not split one value into two sources.

### ⛔ Re-derive a past claim AS OF the claim, not from the present

A claim about another repo must be re-derived from its refs. ⚠ The axis that
rule does not name is **time**: re-deriving from a **later** ref measures a
subject that has since changed.

Measured 2026-09-22. `probe-contract-capability.sh` judged a consumer
**INCAPABLE** at ~15:30. That consumer fixed its contract at **17:42** —
honouring `WEBCTL_BASE_DIR` and asserting a value for the first time; its parent
commit at 16:50 contained **zero** matches for either. A second party then
re-checked *after* the fix, found the contract sound, and concluded **the probe
had misjudged it** — preparing to tell the consumer its work had been
unnecessary and to record a rule about two instruments agreeing while both were
wrong.

Both instruments had been right. The consumer's own commit message credits the
probe by name and quotes its BEFORE/AFTER output.

⇒ **In a fleet where lanes fix things within the hour, "I checked and it is fine
now" is not evidence about what was true when the tool spoke.** Use
`git show <commit>:<file>` and the commit's timestamp, not the working tree.

⚠ The cost of getting this backwards is not symmetric with an ordinary error. It
recasts a genuine fix as unnecessary AND makes a working instrument look
unreliable — *a tool that appears to lie once gets distrusted permanently* —
manufactured by a mistaken retraction rather than by any defect.

### ⚠ A FALSE ABSENCE from the right source, read with the wrong assumption

`git ls-remote --tags` sorts refs **lexicographically, not by version**:

```
v0.1.0   v0.10.0   v0.10.1   v0.2.0   …   v0.9.0   <- last line
```

So reading the tail and concluding *"tops out at v0.9.0, the v0.10 tags were
never pushed"* is wrong while every command succeeded and every byte of output
was correct. Reported 2026-09-22 by a lane about to mount base; the tags had been
on origin for weeks.

⇒ This is harder to catch than a failed command, because **nothing looks broken**.
It is the same shape as a grep whose pattern spanned a line break returning a
confident zero: right source, complete output, wrong reading.

⛔ **And note the trap in its proposed remedy — "just push the tags again".**
Re-pushing an already-pushed tag SUCCEEDS and changes nothing, so the fix would
have been followed by the problem disappearing (it was never there), reading as
confirmation. ⇒ **A remedy that cannot fail cannot tell you the diagnosis was
wrong.** Prefer a remedy whose failure would be informative, or verify the
diagnosis before applying a harmless one.

⇒ Practical: `| sort -V`, or grep for the specific tag. Never read version
ordering off git's ref output.

⚠ Corollary for delete paths, from the same review: *deletion is eventually
loud, accumulation never is* ranks NOTICEABILITY — it does not rank
RECOVERABILITY, and the two come apart exactly where an argument is malformed.
When the only options are a loud stop and an irreversible one, prefer the loud
stop even where a silence argument otherwise holds.

### ⛔ A contract MUST keep TWO directory variables

`WEBCTL_BASE_DIR` names the base **under test**. A contract that hardcodes
`vendor/base-webctl` answers questions about **its own pin** while the verdict
line names the candidate.

| variable | what it is | what it answers |
|---|---|---|
| `PIN_DIR` | our submodule | facts about OUR repo: pin-is-a-tag, the re-vendor check |
| `BASE_DIR` | `${WEBCTL_BASE_DIR:-$PIN_DIR}` | the base under test |

When the gate names a candidate, import **that** module by absolute path and
inject your constants into it.

⚠ **And it must be two NAMES, not one repointed one.** Merely repointing
`BASE_DIR` at the candidate breaks the re-vendor check, which interpolates the
path into a grep while the shim imports the literal submodule path — **a false
RED introduced by the fix for a false GREEN**, invisible in a diff and caught
only by control-testing.

#### ⛔ The candidate check must assert a VALUE, not a TYPE

Repointing the variable correctly is **necessary and not sufficient**.
`typeof cc.deriveXpraPorts === 'function'` passes against a totally sabotaged
base, because **a broken module still exports a function**. Measured by
substack-webctl on the same broken input:

```
typeof assertion, sabotaged base -> PASSES   (the bug)
 value assertion, sabotaged base -> FAILS    (correct)
```

⚠ **Consequence for anyone fixing a contract:** a consumer that mis-scopes the
variable *and* only checks `typeof` will **not** move to CAPABLE when the scope
alone is fixed — and the probe will look as though it lied.

#### ⛔ A PORT ASSERTION IS NOT PORTABLE BETWEEN PINS

`xpraHtml5Port === xpraTcpPort` is correct from **v0.6.0** onward and a
**guaranteed false RED** against a v0.5.0 pin, which legitimately derives
`html5 = tcp + 1`. Same signature as the path trap — a false RED introduced by
the fix for a false GREEN — and **invisible in a diff, because the line is
correct in the repo it was copied from.**

⇒ The candidate check asserts **equality**; the pin check accepts `tcp` **or**
`tcp + 1` and **prints which**, each carrying a comment saying why it is not the
other one reused. Neither tolerance hides the sabotage.

⇒ **Measure your own pin's derivation before pasting anyone's port assertion.**
A consumer on v0.5.0 and one on v0.10.0 cannot share that line.

#### ⛔ A MUTATION-BASED CONTROL MUST ABORT IF ITS MUTATION DID NOT LAND

Not a nicety — a requirement. **Three separate lanes** have now written a control
whose mutation silently failed, and in **all three** the only thing that caught it
was an explicit did-it-land check:

* a submodule mispinned with `git checkout` of unfetched objects — failed
  silently, tree stayed clean, output indistinguishable from a passing control;
* a patch aimed at a **top-level** `export function deriveXpraPorts` that does not
  exist (it is an inner function inside the factory);
* this repo's own capability probe, whose verify compared ANSI-coloured output
  against a plain string and **aborted on a true positive** — *"the mutation did
  not land"* rendered identically to *"I cannot parse my own output"*, inside the
  instrument built to detect that class.

⇒ An unlanded mutation reports **everything healthy**, which is indistinguishable
from a healthy fleet. ⚠ And the check must compare the **value**, stripped of
formatting: `console.log(<number>)` is coloured by `util.inspect` whenever node
decides colour is on.

⇒ **A contract that cannot FAIL is not a contract.** Measured 2026-09-22
against a base whose `deriveXpraPorts` returned `{99999, 1}`: two of four wired
consumers reported PASS, having genuinely run the destroyed code. Verify with
`scripts/probe-contract-capability.sh`, which is the gate-side half — a
consumer silently not participating is otherwise indistinguishable from one that
validated the candidate.

### ⛔ A contract must not assert properties of its OWN pin

`WEBCTL_BASE_DIR` is set by the gate and means: **the base you are testing was
chosen by the gate, not by your pin.** Under `--against-head` the gate points a
consumer at a release CANDIDATE, which by definition is not yet tagged — that
is the whole point of validating before tagging.

So a contract check like *"vendor/base-webctl must be pinned to an exact tag"*
is **structurally incapable of passing the pre-release arm**. It is a correct
check about the consumer's own release hygiene and a guaranteed failure about
the gate's candidate, and it fails for a reason that has nothing to do with the
base under test.

Observed 2026-09-05: `gemini-webctl` blocked a base release this way. Nothing
was wrong with either repo; the check was answering a different question from
the one the gate asked.

⇒ **Rule:** a check that asserts a property of the PIN (is it a tag, which tag,
is it pushed) must be skipped when `WEBCTL_BASE_DIR` is set, and should say it
is skipping and why. A check that asserts a property of the base's CONTENTS
(does this module exist, does this behaviour hold) runs in both modes and is
the point of the exercise.

This is the vacuous-green failure inverted — a **vacuous red**: a verdict that
is guaranteed regardless of the state it claims to measure. It is not the safer
direction. A gate that always blocks gets overridden, and then it is not a gate.

**Output:** emit JSONL typed envelopes per the machine-interface spec (`lszd`),
one per suite: `{type, ts, consumer, suite, result, reason?}` where `result ∈
{pass,fail,skip}` and `reason` is a human-readable string — the consumer's own
last line for exit 2, the gate's own words only where the gate genuinely knows
(not wired, repo absent, dirty pointer). Omitted rather than empty when there is
none. The loop aggregates these.

### Example mappings (per current consumers)

* **linkedin** → `--offline`: `node test/*-test.js` + mocked location suites;
  `--stack`: `LINKEDIN_WEBCTL_DOCKER_TESTS=1 ./docker-live-test.sh`.
* **chatgpt** → `--offline`: `npm test` (node --test tests/unit) + top-level
  `*-test.js`; `--stack`: `QA/*.sh`.
* **telegram** → `--offline`: `npm test` + `smoke-test.sh --offline`; no `--stack`.
* **fetlife** → `--offline`: `node --test test/` (after fixing the stale
  `package.json` test stub); no `--stack`.

## The registry: `consumers.jsonc`

base holds the registry centrally (it loops over consumers). One entry per repo:

```jsonc
{
  "consumers": [
    {
      "name": "linkedin-webctl",
      "repo": "git@github.com:CLIAI/linkedin-webctl.git",
      "submodulePath": "vendor/base-webctl",
      "testCmd": "./test-against-base.sh --offline",
      "dockerOptIn": true,          // also expose --stack under {TOOL}_DOCKER_TESTS=1
      "tier": "full"                // full | cdp-client | contracts
    }
    // chatgpt-webctl, telegram-webctl, fetlife-webctl, + future tools...
  ]
}
```

A **new** tool registers here at creation so the gate picks it up automatically.

## The gate: `scripts/test-all-consumers.sh`

For a candidate base commit:

1. read `consumers.jsonc`;
2. for each consumer: check the candidate base commit into the consumer's
   `submodulePath`, run its `testCmd` **headlessly**, collect the JSONL envelopes;
3. aggregate pass/fail/skip;
4. **exit non-zero (block the release) if ANY consumer reports a FAIL.** `skip`
   (exit 2, needs-human) never blocks.

Pairs with `scripts/verify-no-byte-drift.sh`, which asserts no consumer has copied
a base file back into its own `lib/` (catches regression to byte-duplication).

## Gate validity: the green that means nothing

**A gate must distinguish "ran and passed" from "was never reached." A summary
line that renders those two identically is not a gate.** This is a stronger
requirement than it sounds, and the loop violated it for months without anyone
noticing, because everything downstream of the violation looked healthy.

On 2026-08-31 this exact class was hit **three times in one day**, in three
different repos, by three different agents working independently. All three have
the same shape: *a reassuring zero produced by something structurally incapable
of producing anything else.*

* **The gate could not find a consumer, and said OK.** `consumers.jsonc`
  resolved each working copy as `$WEBCTL_CONSUMERS_DIR/<name>`, but one
  consumer's local directory name was not its registry name and lived outside
  that directory entirely. The gate looked for a path that had never existed,
  reported `skip` "repo not present" on every run since registration, and
  summarised OK. Its registry entry meanwhile claimed the gate was REAL-GREEN on
  it. The consumer was genuinely green — its contract exits 0 when run at its
  real path — so nothing was wrong with the consumer; the gate simply never
  reached it. Measured baseline at discovery: **`pass=0 skip=5`, summary "OK: no
  consumer FAILed."** The gate would have approved any base release whatsoever.
* **A contract's early bail masked the state it existed to detect.** A
  consumer's `test-against-base.sh` checked "no base module was re-vendored as a
  byte copy" *after* its "no adopted modules yet -> exit 2 (skip)" bail. So a
  consumer that had re-vendored **everything** would report SKIP rather than
  FAIL — silently removing itself from the gate, in precisely the scenario the
  check was written to catch, while the gate stayed green.
* **A mutation-based control that never mutated.** To prove a differential
  harness could fail, a source line was mutated with `sed` in a scratch copy.
  The pattern targeted `graceMisses >= 3`; the source said `graceMisses = 3` — a
  default parameter, not a comparison. `sed` matched nothing, the file was never
  touched, and the harness dutifully reported **0 mismatches** — a result
  indistinguishable from a control that passed. The check whose entire job is to
  prevent a false all-clear nearly recorded one.

* **The release gate could not see the release it gates.** `test-all-consumers.sh`
  computes `BASE_ROOT` and then never uses it: it invokes each consumer's
  `./test-against-base.sh`, which resolves `vendor/base-webctl` — *the
  consumer's own pin*. So a green gate proves every consumer works against the
  commit it **already** pins, and says nothing whatsoever about the base commit
  being released. `PASS against base v0.5.0` was routinely read as "base is
  releasable" when it meant "the consumer still works against the version it
  pinned last month". A defect introduced on master could not have been caught
  by the gate at any point before or after tagging.

### Requirements

These are normative for the gate, for every consumer contract, and for any
control used as evidence about either.

* **Report what was executed, not only what passed.** `pass=0` under an OK
  summary MUST be visibly distinguishable from real coverage. A gate that cannot
  say how many consumers it actually ran cannot support the claim it is making.
* **Every skip names its cause AND the resolved thing it looked for** — the
  expanded path, the command, the missing file. "repo not present" is useless;
  "repo not present at `/home/u/github/CLIAI/substack-webctl`" is what makes a
  path-resolution bug visible on sight rather than after an audit.
* **Ordering inside a contract is load-bearing.** A check that can exit early
  MUST come after the checks that detect the degenerate states it would
  otherwise mask. Order the cheap bail last, not first.
* **A mutation-based control MUST prove the mutation landed** — diff the mutated
  copy, or assert the substitution count — *before* its result is admissible as
  evidence of anything. An unproven mutation makes a passing control and a
  broken control identical.
* **Two fields that agree today are one field** — see `t2wf`. The gate's
  six-week false-green was exactly this: `consumers.jsonc` `name` served as both
  registry identity and on-disk location, so no code could tell them apart.
* **Enumerate from disk, never from a hand-maintained list.** A hardcoded module
  or consumer list silently narrows as the thing it enumerates grows; the
  narrowing is invisible precisely because the check keeps passing. A
  non-recursive walk is the same bug with a smaller blast radius: one consumer's
  require()-ability check verified 7 of 16 modules and was silent about the 9 it
  skipped.
* **A gate states what it VALIDATED AGAINST, in the line a human reads.** Not
  "PASS" but "PASS against <the exact thing under test>" — and that thing must
  be the artefact whose release is being decided, not whatever the runner
  happened to resolve. The gap between "what was tested" and "what is being
  approved" is invisible in a summary line and total in effect.
* **Guard tests carry a negative control.** A guard that has never been observed
  to fail is indistinguishable from a guard that cannot fail. base's
  no-top-level-await guard ships a fixture that deliberately violates the
  guarantee for this reason.

> The uncomfortable general lesson: all three failures were found by someone
> verifying a *different* claim, not by the check itself. Trust in a green run
> should be proportional to how recently that specific check was last seen to go
> red.

## Programmatic end-to-end scope (be honest)

* **Fully no-human (gated):** all unit suites; mocked browser-location / docker-mode
  suites; and for docker-tier consumers the headless xpra+chromium **stack**
  bring-up + CDP probe + teardown.
* **NOT no-human (excluded from the gate; reported as SKIP/exit 2):** real gated-site
  flows — login walls, human-like-pacing policy, SMS/captcha, image-gen quota,
  multi-variant UIs. These need one-time human profile seeding (via gui/xpra
  attach); after seeding the persisted profile makes them no-human, but
  anti-detection policy + blocked-state handling (`k7m2`, `dip7`) keep them out of
  the automated loop.

> Do not over-promise "the loop tests everything end-to-end." It tests the stack
> and the contracts; live sites are deliberately out of scope.

## Proactive drift mitigation: the selector canary

Because the loop cannot drive live sites, DOM drift on real pages is caught by a
**selector-canary "doctor"** command (already in chatgpt + telegram): a tool
subcommand that checks its critical selectors against a recorded expectation and
warns on drift. Promote this **pattern** to base as a shared helper so every tool
gets proactive drift detection without live-site stress in CI.
