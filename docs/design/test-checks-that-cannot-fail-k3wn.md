---
id: k3wn
title: "Checks that cannot fail"
category: test
created: "2026-09-23"
updated: "2026-09-23"
status: draft
tags: [verification, controls, mutation-testing, vacuous-green, false-red, instruments, discipline]
tech:
  - name: "Node.js"
    version: ">=22.12"
relates_to: [xrl4, t2wf, sm2t]
depends_on: []
expands: []
similar_to: [xrl4]
---

# Checks that cannot fail

> **A check is only as good as its ability to fail.**

Most of the defects below were checks that were **structurally incapable of
reporting a problem**, and every one of them reported green while being so.

⚠ **This file leads with base's own failures, and that is deliberate.** A rules
file whose examples are all someone else's failures teaches the wrong lesson
about who it applies to — and hosted by the shared library, read by its
consumers, it would read as the library instructing them with their mistakes.
Every example in "base's own" below is a defect this repo **shipped**, and most
were found by a consumer rather than here.

⚠ **Scope.** `xrl4` owns the cross-repo **contract** rules — exit codes, pin
checks, `WEBCTL_BASE_DIR`, the gate's obligations. This file owns the general
verification discipline. Two homes for one rule diverge by age, and **prose has
no test to catch it**, so a rule belongs in exactly one of them.

---

## base's own, 2026-09-22/27

Each of these shipped from this repo. The finder is named where it was not base.

### A coverage test that walked one of two producers

`portOrigin()` shipped in **v0.13.0** classifying `resolvePort()`'s vocabulary
and not `deriveXpraPorts()`'s — so `'derived'` and `'jsonc.ports["xpra-tcp"]'`
returned `null`, **two of the three ports `inspect()` carries**, and a
fail-closed consumer would have refused every ordinary bring-up.

⛔ The test written to prevent exactly that **listed one resolver's channels by
hand**, while the commit message described it as walking *"the resolver's real
output"*. It walked **one** resolver's. ⇒ And *"fixing an omission at one call
site says nothing about the others"* had been written into this repo **the day
before**.

⇒ **Enumerate the real output, never a hand-maintained list of what you
remember producing it.** The repaired test walks `cfg.portSources` — the object
that actually reaches `inspect()` — and counts what it checked.
*(Found by `cgwc:main`, from adoption, within the hour of the tag.)*

### A contract asserted against itself

`TEARDOWN_CONTRACT.removes is EMPTY` checked **the constant**, never called
`shutdown()`. Adding `docker.rm()` to `shutdown()` left the suite green — in the
one contract whose entire content is a claim about what a verb does **not** do,
inside the file written to stop published data drifting from the code.

⚠ Note which check had it: the two that were control-tested caught their
mutations; the one that was not was the one asserting a **negative**. ⇒ **A
claim that something does not happen is the easiest to assert vacuously,
because the default state already satisfies it.**

### A field named for the measurement, which could never have fired

`tcpReachable`, implemented as a socket connect, cannot establish that a GUI is
reachable: **docker's published-port proxy accepts and then resets**, so
`connect()` returns true for a dead port.

```
port    connect()        HTTP GET
14327   TRUE             200        <- genuinely serving
14328   TRUE             reset      <- published, NOTHING behind it
14878   ECONNREFUSED     —          <- not published at all
```

⇒ And the consequence was fatal to the design: a running container always has
its port published, so the probe returns `true` whenever the stack is up — and
*"running but not serving"*, the row documented as **the single most valuable
thing the surface can say**, could essentially never fire. The field would have
restated `running`.

⭐ Renaming it `html5Answering` did not merely describe the check better — **it
made the check correct**, because the objection that was fatal to the old name
is no objection at all to the new one.
*(Found by `webctl:linkedin` and `fetlife-webctl`; re-measured here.)*

### A probe that aborted on a true positive

`probe-contract-capability.sh` refused to run: its verify compared
`console.log(<number>)` output against `'99999'`, and `util.inspect` **colours
numbers yellow** whenever node decides colour is on. The captured value was
`\e[33m99999\e[39m`, the compare failed, and the abort-if-the-mutation-did-not-
land path fired **while the mutation had landed**.

⇒ So *"the mutation did not land"* rendered identically to *"I cannot parse my
own output"* — this repo's own defect class, **inside the instrument built to
detect it**, two hours after shipping it.

⚠ It failed in the **safe** direction, which is why it took an outside report: a
tool that refuses to run looks cautious rather than broken. ⛔ And the fix was
*not* the one environment variable that made it work — a correctness check
defeatable by someone's colour setting is not a check.

### A published vocabulary nothing could read

`portOrigin`/`PORT_ORIGINS` shipped as **module-level** exports while consumers'
shims re-export what `createClientConfig()` returns. ⇒ **A published API a
consumer cannot reach is not published.**

⚠ And the deeper version, which is still open: **publication is not adoption.**
A consumer can reimplement the classification with a local regex and pass every
check, because nothing in a test can observe a vocabulary that is not used.
⇒ **A constant is load-bearing when deleting it turns some consumer's contract
red.** Right now, breaking one turned nothing red.

### Two fields that could not tell SAFE from DANGEROUS

`describeProfileResolution()` shipped with `isolatedBySlug` as its only boolean
— `false` for both an isolated bring-up and a throwaway-named container mounting
the **authenticated** profile. Byte-identical output; a consumer branching on it
got the same answer for a benign config and for the incident the function exists
because of.

⚠ And the sibling shipped in the same release: `warning` was a bare string
firing for two severities, so `warning !== null` was true for both.
*(Both found by `fetlife-webctl` consuming the release.)*

### A test suite that wrote into the user's real cache

`createDriver()` called the eager profile resolver, so **merely constructing a
driver created a directory** — before any bring-up, and whether or not one ever
happened. base's own registry suite wrote into `~/.cache` on every run.

⇒ **A query with a filesystem side effect is not a query.** ⚠ And the repair
immediately created a second instance of the same class: a pure resolver beside
an eager one is **two functions computing one value**, so suites stubbing only
one got the real path back from the other.

---

### A suite number that cannot tell "passed" from "asserted nothing"

Measured on this runner:

```
node --test <zero-byte file>        -> # tests 1 · # pass 1 · # fail 0
node --test <only imports assert>   -> # tests 1 · # pass 1 · # fail 0
node --test <test() with no assert> -> # tests 1 · # pass 1 · # fail 0
```

⇒ So `# pass 292` — the number this repo reports after every change and quotes
to every consumer — **cannot distinguish asserted-and-passed from
asserted-nothing.** *(Found by `cgwc:main` when its suite went 1381 → 1380 and
the deleted file was an empty one left by an errant heredoc: the count moved for
a reason unrelated to coverage, and nothing else would have said so.)*

⚠ The failure is invisible in the direction nobody investigates — **the number
goes up.**

⇒ Two properties the guard needs, and both are the rule turned on the guard
itself: **enumerate from what the runner actually runs**, cross-checked against
a second source so a narrowing pattern cannot hide; and **zero files discovered
FAILS** rather than reading as "nothing to check, OK".

### ⛔ A documented check that could not fail — in the validator every agent is told to run

`scripts/verify_yaml_frontmatter.py` states, in its own docstring, that it checks
*"No duplicate IDs across documents"*. It could not. The index was built as

```python
index: dict[str, Path] = {}
index[str(doc_id)] = md_file        # a second doc with the same ID OVERWRITES
```

and the duplicate check then **regrouped that already-unique mapping**:

```python
for doc_id, path in id_index.items():        # keys unique BY CONSTRUCTION
    seen_ids.setdefault(doc_id, []).append(path)
for doc_id, paths in seen_ids.items():
    if len(paths) > 1:                       # ⇒ UNREACHABLE. Every list has one element.
```

Measured 2026-09-27 over master plus the 21 unmerged `design/*` branches: **47
docs scanned, 40 indexed, `All files passed validation`, rc 0.** Eleven documents
collided across four IDs and the verdict was green.

⭐ **The container chosen for the index decided whether the defect was
expressible.** No amount of care in the checking loop could recover information
the data structure had already thrown away — so this is not a logic bug to be
found by reading the check; it is found by asking *what would a violation look
like by the time this code sees it?*

⚠ And the count that exposed it was **printed on every run and read as normal**:
`Scanning 47 … / 40 document(s) with IDs indexed`. A discrepancy is not a
signal until something asserts on it, which is why the repair pins
`indexed == scanned` rather than trusting the next reader to subtract.

⇒ Two further consequences worth separating from the vacuity:

* IDs are what `docs/design` cross-references **resolve through**. A collision
  did not merely go unreported — `relates_to: [v7m2]` silently resolved to
  whichever doc won the overwrite. **The corpus answers confidently and wrongly**,
  which is worse than refusing to answer.
* The check ran **only when an agent remembered the command in `AGENTS.md`**. A
  check nothing invokes is indistinguishable from one that cannot fail; the
  repair therefore wires it into `npm test` as well as fixing it.

⚠ **The design-doc corpus is the coverage instrument for the whole family** —
which specs a consumer applies is read off these IDs. An unenforced uniqueness
rule in *that* corpus is a measuring instrument with an unmarked scale.

## A fixture's assumptions have a shelf life

⭐ **Every other rule here is about a check that cannot fail. This is a check
that cannot fail CORRECTLY — and it degrades without anyone touching it.**

A fallback assuming `html5 == tcp + 1` was **correct when written** and harmless
while the pin was at or below the release that derived it that way. The moment
the pin crossed the release that retired that derivation, it became a
**guaranteed false RED** — in any git-less tree, against a perfectly correct
base, with **nothing changed in the test**. Caught three bumps later by the
pristine positive arm of a control written for something else.
*(`webctl:linkedin`.)*

⇒ **Observe the value rather than assume it. A fallback is a fixture's expiry
date written in invisible ink.**

⚠ This is the version-marker problem with the polarity reversed, and a shared
library shipped to lanes at different pins has **both**: a marker tells you an
old copy carries old rot; it does not tell you that a *correct* copy's
assumptions have expired against a newer pin. **Two mechanisms, not one.**

## The hypothesis ladder

When a test will not go red under a mutation, work down this list. **The first
rung is where everyone stops.**

1. **My test is wrong.**
2. **The mutation never reached the assertion.** A `sed` pattern containing a
   backtick or an apostrophe silently matches nothing; the run that "passed" is
   **inadmissible, not evidence**. Diff the file before believing the result.
3. **The assertion was never reached.** ⛔ `if (X) assert(Y)` passes silently
   whenever `X` stops being true — **and a shape change is exactly when `X`
   stops being true.** ⇒ Assert the **shape** first, match on a **stable key**,
   **count** what ran, and **fail on an unknown key rather than skip it**.
4. **The thing under test cannot report failure.** A tool that returns `{}` and
   exits 0 for a missing file cannot be tested by exit code.

## Accidental red ≠ deliberate red

⭐ **An accidental failure tells you the check CAN fire. Only a deliberate one
tells you it fires for the reason you think.** Two different claims, and the
first is routinely reported as the second.

## Control the instrument before believing a zero

* GNU BRE treats an unescaped `$` mid-pattern as an end-of-line anchor — six
  real matches, and the audit read clean.
* `x && x.kind === '…'` yields `null`, not `false`. Compared strictly against
  `false`, every benign case reads as a divergence.
* `ls-remote --tags | tail` reads **lexicographically**, so `v0.10.x` sorts
  between `v0.1.0` and `v0.2.0` and scrolls off the top — a **false blocker**,
  and a wrong report sent to another repo.

⇒ Cheap test for when to bother: **would a wrong answer here be obviously
wrong?** If not, run the instrument against a known-positive first.

⛔ **And a remedy that cannot fail cannot tell you the diagnosis was wrong.**
Re-pushing an already-pushed tag succeeds and changes nothing, so the "fix"
would have been followed by the problem disappearing — reading as confirmation.

## Do not read your expectation from the thing under test

A dependency sabotaged to lie about a derivation **and** about the constant the
derivation uses, consistently, defeats `tcp === C.OFFSET + cdp` and is caught by
`tcp === 14427`. The composed form *looks* more principled and is **blind to a
self-consistent lie**. ⇒ **Write the literal.**

## Assert the function, not a hand-made copy of its output

A fail-closed check mutated to fail **open** left the suite green: the test
built its input by hand and never called the classifier.

## Name the fact, not the measurement

`tcpReachable` promised *answering* and delivered *published*. ⇒ Renaming a
field to what it measures exposes the gap for free — and sometimes, as above,
**makes the check correct rather than merely better described**.

## ⛔ "Assert the fact, not the proxy" does not tell you WHICH fact

A lane keyed one carve-out three ways, each on a better-looking basis than the
last:

```
v1  skip when WEBCTL_BASE_DIR is set        -> skipped a computable check on EVERY gated run
v2  skip when BASE_DIR resolves to PIN_DIR  -> NEVER FIRED
v3  delegate to the shared harness          -> correct
```

⭐ **v2 is the instructive one.** Told that v1 was a proxy, the author reached
for a *fact* — path identity — and picked a fact about **the wrong thing**: the
gate sets `WEBCTL_BASE_DIR` and swaps the submodule as **two separate
operations**, so a carve-out keyed on the paths coinciding was **structurally
incapable of firing**.

⇒ So the rule is necessary and not sufficient. **A wrong fact reads exactly
like a right one** — both are facts, both are checkable, and only running the
real thing distinguishes them. ⚠ *"Assert the fact"* silently invites you to
pick the fact you can most easily observe, which is rarely the one the
behaviour depends on.

⇒ Practical: after choosing a fact, ask **"what produces it, and is that the
same operation as the thing I am carving out for?"** Here it was not, and
nothing but a gated run would have said so.

### ⭐ And the cost of a wrong fact is ASYMMETRIC

| key | failure | how it announces itself |
|---|---|---|
| a proxy that OVER-triggers (v1) | skips too much | eventually — someone notices a check never runs |
| a fact about the WRONG operation (v2) | **cannot fire at all** | **never** |

⇒ **A proxy that over-triggers announces itself eventually; a fact about the
wrong operation is silent forever.** So when the two candidate keys are
*observable but possibly unrelated* and *harder to observe but causally
connected*, the harder one is not merely better — **it is the only one whose
failure you will notice.**

⚠ Same shape one layer up, from the same lane: a guard
(`require_base_owned("LWC_CHROMIUM_PROFILE")`) that **could not fire** until an
`ENV` line came out of three Dockerfiles. It existed, it was correct, and it
asserted nothing.

### ⚠ A fallback goes dark the moment the primary path becomes available

A lane adopting the harness *under the gate* while keeping local logic has
**two live paths**. At its next bump the local one stops executing — and it is
the path nobody thinks to test, precisely because it is the one that always ran.

⇒ The remedy belongs in **the commit where the code goes dark**, which is the
only moment anyone is looking at it: either **delete** the fallback (the pinned
library owns it now) or **exercise** it deliberately against a fixture — and
say which. ⛔ Building that machinery earlier guards a path that is currently
the live one.

## ⭐ A contract's last line is API

Anything that consumes output **positionally** makes the tail a contract.

A release gate captures the trailing block of a contract's output as the FAIL
reason. One contract ended with a paragraph explaining *why* it reads `ls-tree`
rather than `describe` — correct, useful prose — so the verdict a reader saw
was the explanation rather than the finding.

⇒ **Explanation belongs above the verdict, never after it.** The actionable
line goes last:

```
FAIL: submodule pointer DIVERGED — we declare 5c3db07, worktree is at 020f93a.
  Fix with: git submodule update --init vendor/base-webctl
```

⚠ And the background reasoning moves to a file a reader opens **deliberately**,
rather than one a capture lands in **by accident**.

## ⛔ `git log -S` measures TRANSITIONS, not states — and its wrong answer has the right shape

Auditing *"which public commits contain this identifier?"* with `git log -S<string>`
returns the commits where the **count of matches CHANGED**. That is not the
question. Measured 2026-09-27, auditing a host alias across four commits:

| commit | matches present | listed by `-S`? |
|---|---|---|
| 8c31f54 | 12 | yes |
| 696ab9d | 10 | yes |
| b7d4395 | **6** | ⛔ **NO** — its edit did not change the count |
| 18e329b | 5 | yes |
| 8ad59e7 | **0** | ⛔ **YES** — this is the commit that REMOVED them |

⇒ So the instrument **omitted a genuinely exposed commit and included the fix**,
and still returned four commits — a plausible-looking list of the right length,
with two of the four wrong. ⭐ **A wrong answer shaped like a right one is not
caught by reviewing the answer.** The correct instrument counts matches in the
**blob at each commit**, which asks about states:

```sh
for c in $(git log --format=%h <ref> -- <path>); do
  printf '%s %s\n' "$c" "$(git show "$c:<path>" | grep -ic '<pattern>')"
done
```

⭐ **AND THE DIAGNOSIS IS THE TRANSFERABLE PART: when two parties disagree about
a SET, suspect the instrument before the arithmetic.** Both parties here had done
the counting correctly. `-S` is documented to do what it did — it is a pickaxe for
finding *when something changed*, which is a different and also useful question.
The defect was reaching for it to answer *what is present*.

⚠ The same shape applies to any transition-based tool used as a state query:
`git log -S`/`-G`, `git log --follow` for "did this file ever contain", a diff-based
"what changed" audit read as "what exists". *(Instrument diagnosed by
`webctl:mgr` on their own measurement, after `webctl:base` derived a different set
by counting blobs — which is why the disagreement surfaced at all: the two methods
were independent, not two people running the same command.)*

## ⛔ A REFUSAL TEST NEEDS A POSITIVE CONTROL ON THE SAME FIXTURE

*(Contributed by `ccew`, measured 2026-09-27, at `webctl:mgr`'s suggestion. Their
tool and file names are generalised here because base is public — the shape, not
the paths, is what transfers.)*

A lane has a tool that decides **which browser tab is on screen, by pixels**: each
tab's capture is located inside a screenshot of the window, and the tool must
**refuse** when 0 tabs match or when 2+ match. Its offline test used synthetic tabs
A, B (identical to A) and C, against a window showing A.

**The vacuous pass.** On the first run:

* *"two matches → refused"* — ✅ GREEN
* *"no match → refused"* — ✅ GREEN
* *"one match → A"* — ⛔ **RED**: the locator matched **nothing at all.**

The fixture was **pixel noise**, which the locator's quarter-resolution coarse
search cannot lock onto (best 83.0 against a runner-up of 83.07 — measured, not
inferred). ⇒ **So the 2-match refusal was the 0-match refusal wearing a different
label**: it refused because nothing matched, not because two things did. The
ambiguity guard — the thing the test existed for — was never exercised, and read as
exercised.

⭐ **THE GENERAL FORM.** A test asserting *"refuse when X"* passes whenever the
detector sees **nothing**: that is, whenever X is absent **and** whenever the
detector is **blind**. Those two are indistinguishable from the outside, and one
of them is a working guard while the other is a broken instrument.

⇒ **Only a case on the SAME FIXTURE where the detector must SEE something
separates them.** The positive arm is not an extra nicety beside the refusal
tests; it is **what makes the refusal tests mean anything.** The fix was
page-like fixtures (flat blocks, bars, lines — which is what real UIs are), after
which the positive arm found A and the ambiguous case reported *"2 tabs match the
window (A B) — ambiguous, refusing"* for the right reason.

⭐ **AND A SECOND LANE ARRIVED AT THIS INDEPENDENTLY, THE SAME DAY, BY A DIFFERENT
ROUTE.** Reviewing `arch-browser-targets-btg4`, `substack` argued that §1's
"no profile under the config root" guard **needs a known-positive fixture more than
any other assertion in the set** — create a temp dir containing a file named
`Cookies` and require the guard to report it — *"a sweep for `Cookies` that has
never been seen to FIND one is the false-zero shape"*, citing a false zero their
own repo produced from a grep that could not match, where the audit read clean.
⇒ One lane found it from a pixel locator that saw nothing; the other from a
filesystem sweep that matched nothing. **Two independent instruments, two
independent lanes, one shape** — which is the corroboration this document asks for
elsewhere, and the reason this entry is not merely one lane's anecdote.

⚠ This is the same family as *"a zero is evidence, an absence is not"* and as the
gate's stale-entry detector, arrived at **from the test side** rather than from the
instrument side. Every refusal-shaped assertion in this repo should be read against
it — including the `no-revendor` zero-files check and `gate-probe`'s own
no-verdict arms, which are refusals with positive controls precisely because of
this hazard.

## ⛔ A GUARD and a CLAIM that read the same input cannot disagree

Distinct from *"two checks that share an input do not corroborate"* below: this is
**one** check, whose precondition and whose assertion are computed from the same
value. The check then passes by construction.

Shipped in base 2026-09-27, in the tool written to prevent exactly this. A probe
was added to assert that the pin check DECLINES a verdict inside the release
gate's swap window. Its first draft:

```js
const swapped = declaredEnv !== worktree;      // ⛔ the comparison UNDER TEST
if (!swapped) return noVerdict('not exercised');
const v = judgePin(…);
if (v.code !== NO_VERDICT) return fail(…);      // ⇒ UNREACHABLE
```

`judgePin` decides "swapped" by that same comparison. So whenever the guard let
execution through, the assertion was already guaranteed — **the FAIL branch could
not run**, and the probe would have reported pass forever, including across a real
regression in the one arm it exists to watch.

⭐ **THE FIX IS STRUCTURAL, NOT A STRONGER ASSERTION.** No amount of care inside
the assertion recovers a guard that has already pre-decided the answer. The
precondition has to come from a **different source**: here, the gate exports
`WEBCTL_GATE_SWAPPED=1` because *it* knows it performed a swap, which makes the
claim about the comparison falsifiable.

⚠ **The tell is that a whole TEST becomes unwritable.** The mutation — the gate
reports a swap while declared equals worktree, so the check returns a real verdict
and the probe must fail — could not be expressed against the first design at all.
⇒ **If you cannot write the test that makes a check go red, the check is the
problem, not the test.** That is the cheapest available detector for this shape,
and it fires before any code ships.

### And the WIRING needs its own red

A probe's unit tests prove the probe can fail. They say nothing about whether the
system that invokes it acts on that. Here the gate's blocking path was verified by
sabotaging the library, committing locally, and running the real gate: `defect=4`,
exit 1, BLOCKED, attributed to base rather than to the four consumers. ⚠ The first
attempt proved nothing — the gate refuses a dirty tree, so it exited 2 before
reaching the probe, and *"the gate did not block"* and *"the gate never ran"* look
alike in an exit code nobody read carefully.

## Two checks that share an input do not corroborate

They **agree**. Two probes of the same derived port are satisfied by one foreign
service answering there. ⇒ Before trusting a pair, ask: **could these two ever
disagree?** A pair that cannot is one field with two names, and a reader seeing
both feels twice as confident for no additional evidence.

### ⛔ And the same holds for two PEOPLE sharing a habit

A lane reported that `inspect()` did not exist at a tag. It does — on the
**driver**, not on `client-config.js` — and the grep used was
`export function inspect`, which **cannot see a function returned in an object
literal**. Two independent errors, either sufficient.

⭐ **A second party then went to verify the correction at the tag, grepped for
an `inspect` export, found none, and logged it "confirmed" — about to go to
three lanes.** Two measurements, taken separately, both described as *verified
at the tag*, **sharing one blind spot.**

⇒ **Two measurements that share a blind spot corroborate nothing**, and the
shared input does not have to be a line of code — here it was **a habit of
grepping for `export`**. ⚠ Corroboration counts independent *methods*, not
independent people: two readers with the same reflex are one instrument used
twice.

📎 And the blindness was exactly mirrored. A shim re-exporting only a factory's
return is blind to **module-level** exports — the defect that motivated a
shim-completeness check. A grep for module-level exports is blind to **the
factory's return**. Same seam, opposite side, and in both cases the instrument
was correct about everything it looked at. ⇒ **Completeness is not checkable
from either side alone.**

## Published is not the same as understood

Branching on an upstream vocabulary needs **two** checks, and collapsing them
makes the second vacuous:

* **drift** — is the emitted value in upstream's published list?
* **coverage** — is it one *we* have classified?

⇒ A value upstream adds **and emits** passes the first and falls through an
unchanged branch. Put the coverage check in a **suite**, not only in a runtime
guard that fires when someone is mid-bring-up.

## A guard is correct only over the states that existed when it was written

A count guard reported *"62 tests, all green"* the day honestly **skipped** tests
appeared, with 4 asserting nothing — `node --test` exits 0 on a skip.
⇒ **Adding a new state is what tests a guard.**

## Behaviourally hermetic ≠ location hermetic

A handoff bundle's tests were independent of docker, the clock and boot state —
and not of the sender's directory layout. ⇒ **The test you hand someone must run
from the state THEY start in**, and when it genuinely cannot be self-contained,
say so with the clone commands. Honest packaging beats convenient packaging.

## Re-derive a past claim AS OF the claim

A claim about another repo is re-derived from its refs — and the axis that rule
does not name is **time**. Re-deriving from a **later** ref measures a subject
that has since changed. ⇒ In a fleet where lanes fix things within the hour,
*"I checked and it is fine now"* is not evidence about what was true when the
tool spoke.

## Trust the argument; re-run the measurement

> **Neither party needs corroboration on the reasoning. Both keep getting the
> instruments wrong.**

⇒ Do not respond to a good track record by dropping the cheap verification. The
reasoning is the part that has been reliable, and it is **not** the part that
fails.

## The constrained lane is the test, not the clean one

A lane that adopts a release painlessly reports it sound; a lane wiring it into
an existing surface finds the bug in an hour. ⇒ **Being able to adopt painlessly
is not evidence the design is right — it is evidence the design costs *you*
nothing.** When reviewing, say which of the two you are reporting.

## Duplication at different ages

A shared library fixes future duplication. It does **not** fix the lanes already
carrying old copies, and **you cannot find those by diffing**, because rot and
legitimate per-lane customisation look identical in a diff. ⇒ They need a
**version marker**.
