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

## base's own, 2026-09-22/23

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

## Two checks that share an input do not corroborate

They **agree**. Two probes of the same derived port are satisfied by one foreign
service answering there. ⇒ Before trusting a pair, ask: **could these two ever
disagree?** A pair that cannot is one field with two names, and a reader seeing
both feels twice as confident for no additional evidence.

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
