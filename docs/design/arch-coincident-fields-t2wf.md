---
id: t2wf
title: "Coincident Fields: Two Values That Agree Today Are One Field Tomorrow"
category: arch
created: "2026-09-02"
updated: "2026-09-02"
tags: [invariants, schema, naming, latent-defects, testing, cross-cutting]
status: stable
relates_to: [xrl4, sm2t, f868, v59v, lf4f]
depends_on: []
expands: []
similar_to: []
---

# Coincident Fields: Two Values That Agree Today Are One Field Tomorrow

> **This doc exists separately ON PURPOSE.** Filing a cross-cutting rule under
> one topic makes it findable only by someone already inside that topic — which
> is precisely how instances 2 and 3 below happened. The registry lesson lived in
> the registry's domain, so nobody carried it into cache paths; the cache lesson
> lived in the storage domain, so nobody carried it into config keys. A fourth
> instance was guaranteed. Cross-linked from `xrl4`, `sm2t` and `f868`.

## The rule

**Two fields that currently hold the same value are indistinguishable from one
field, and the code will quietly pick one.**

Nothing fails. Every test passes. The choice is never made by anyone — it is
made by whichever line was written first, and it stays invisible for exactly as
long as the two values agree. The bill arrives when someone sets them apart,
which is usually a new consumer doing something entirely reasonable, and the
symptom appears somewhere far from the decision.

## The remedy — the actionable half

⭐ **WHEN TWO FIELDS AGREE TODAY, WRITE A TEST THAT DISAGREES THEM.**

Give them deliberately different values and assert which one each consumer of
the pair uses. That converts an accident into a decision, at the cost of about
four lines. Without it, "they agree" is load-bearing and nobody ever decided it
should be.

The test is the whole remedy. Documenting the distinction is not enough — a
comment saying "these are different fields" does not stop the next author from
using whichever is in scope, because both produce a passing suite.

## Three instances, all in this family, all found the hard way

The pattern is only visible in aggregate, which is why it took three.

* **`consumers.jsonc` `name` = registry identity AND on-disk location.** One
  string served both; a consumer whose directory name differed from its registry
  name resolved to a path that had never existed. The release gate reported
  `skip "repo not present"` on every run for **six weeks** while its summary read
  `OK` — the false-green documented in `xrl4` "Gate validity". Separating the two
  jobs needed a new `localDir` field.
* **The cache segment = tool identity AND instance slug.** `~/.cache/CLIAI/`
  holds per-TOOL directories (`chatgpt-webctl`, `linkedin-webctl`) *alongside*
  per-INSTANCE ones (`default`, `integration-test`, `test-lifecycle`). Nothing in
  the path distinguishes the two kinds, so no reader can tell what a directory
  is. Named in `v59v` §3; deliberately not split, for continuity.
* **Config keyed on `C.PROJECT`, cache keyed on `C.CACHE_DIRNAME`.** In all four
  real consumers these are EQUAL, so the divergence is invisible. `v59v` §6
  sketched the config root on `CACHE_DIRNAME`; the shipped code uses `PROJECT`.
  Two artifacts disagreed about which field owned the config tree and neither was
  wrong yet. Resolved toward the code — it is what already has files under it —
  and pinned with a test using deliberately different values.

## Why it is hard to see

* **It is invisible to review.** A reader checks whether the code is correct; it
  *is* correct, for every input that exists today.
* **It is invisible to tests.** Fixtures are written from real data, and in real
  data the fields agree — so the test that would catch it is the one nobody has
  a reason to write.
* **It survives a rename.** Renaming one of the two fields does not separate
  them; it just gives the same coincidence a new spelling.
* **The failure is remote from the cause.** Config silently relocates, or a repo
  becomes invisible to a gate. The symptom names the consumer that set the
  fields apart, not the line that conflated them.

## How to spot one before it bites

* Two fields in the same constants object that you would struggle to describe
  differently without using the word "and".
* A path segment that holds values from two different vocabularies (`default`
  next to `chatgpt-webctl`).
* A spec and its implementation naming *different* fields for the same slot,
  with no test failing — a strong signal, because it means the author of each
  believed something different and neither was contradicted.
* A field used as a lookup key in one place and as a display label in another.

## Relationship to the surrounding rules

This is the schema-level sibling of `xrl4`'s "Gate validity": there, a check
returns a reassuring result it is structurally unable to vary; here, a field
distinction is one the code is structurally unable to observe. Both are cases
where **the absence of failure is not evidence**, and both are fixed the same
way — by constructing the input that would make the two answers differ, and
asserting which one you get.
