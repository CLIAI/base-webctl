---
id: xrl4
title: "Cross-Repo Consumer Test Loop & test-against-base Contract"
category: test
created: "2026-06-22"
updated: "2026-06-22"
status: draft
tags: [cross-repo, ci, test-loop, contract, headless, exit-codes, jsonl, drift-canary, semver-gate]
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
