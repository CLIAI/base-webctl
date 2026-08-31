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
| `2`  | blocked — needs human (login wall / captcha / quota; see `k7m2`, `dip7`) | counts as **SKIP**, not fail |

**Output:** emit JSONL typed envelopes per the machine-interface spec (`lszd`),
one per suite: `{type, ts, consumer, suite, result}` where `result ∈
{pass,fail,skip}`. The loop aggregates these.

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
