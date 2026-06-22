# `verify-no-byte-drift.sh` — dev notes

## Why byte-comparison (not import-graph analysis)

The failure mode we guard against is concrete and crude: someone copies
`vendor/base-webctl/lib/.../docker-ctl.js` back into `consumer/lib/.../docker-ctl.js`
verbatim (the pre-submodule habit). `cmp -s` against the base source catches
exactly that with zero false positives — a correct adoption leaves a *shim* in
that path (re-export of the submodule), which differs from the base source.

## What it does NOT catch (and why that's fine)

* A consumer that *partially* edits a copied file (no longer byte-identical) is
  not flagged here. That is a different problem (divergent fork) and is better
  surfaced by the behavioural gate (`test-all-consumers.sh`) plus review.
* A consumer importing the wrong base version (stale pin) — that's the
  submodule SHA's job, checked at `git submodule status` review time.

## Path assumption

The canary compares **same relative path** in base and consumer
(`lib/browser-location/docker-ctl.js` ↔ `lib/browser-location/docker-ctl.js`).
The fleet keeps the lib layout uniform, so same-path comparison is correct. If a
consumer ever relocates the shim, extend the registry with an explicit
path-map rather than loosening the comparison.

## Wired-only

Like the gate, it only inspects `"wired": true` consumers. Before adoption a
consumer legitimately holds its own full copy (that IS the current source of
truth); flagging it then would be wrong. The check becomes meaningful exactly
when the consumer claims to consume base.
