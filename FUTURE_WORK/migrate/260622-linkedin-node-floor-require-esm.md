# FUTURE_WORK — Node floor raised by `require(esm)` shim — RESOLVED

* **Category:** migrate
* **Created:** 2026-06-22
* **Status:** **RESOLVED 2026-06-22** — Greg decided **Option A: adopt Node
  `>=22.12` fleet-wide.** Codified as the consumption-floor policy in `sb7q`
  (substrate section) + base `package.json` `engines`. linkedin merges PR #72
  as-is; chatgpt/telegram inherit the same floor when they wire the submodule.
  No per-consumer decision remains; kept for provenance.
* **Concerns:** base `lib/browser-location/docker-ctl.js` (sb7q); consumer
  linkedin-webctl; `proposals/2026-06-22-linkedin-docker-ctl-submodule.md`.

## What is deferred

The pilot's CJS→ESM consumption shim relies on Node's `require(esm)`, stabilised
in **Node ≥22.12**. linkedin-webctl declares `"engines": { "node": ">=18" }`.
Adopting the submodule shim either:

* raises linkedin's engine floor to `>=22.12`, or
* keeps `>=18` but documents that the *submodule path* needs 22.12+ at runtime.

This is a **consumer-side** decision owned by `webctl:linkedin@knot`, so base
does not force it. The same choice recurs for every CJS consumer
(chatgpt/telegram) as they adopt base.

## Why it does not block

base ships valid zero-dep ESM regardless. The fully-ESM consumer (fetlife) has
no such floor. The CJS tools adopt on their own schedule; until then their
registry entry stays `"wired": false` and the gate SKIPs them.

## What unblocks it

A one-line decision from each CJS consumer's owner (bump engines vs. document),
recorded in that consumer's repo. base's only obligation: keep the module
TLA-free so `require(esm)` stays synchronous (already true; add a CI assert if we
ever grow the lib).

## Alternative (if 22.12 is unacceptable)

Interim `await import()` from CJS (sb7q §substrate) — but that forces async call
sites and a larger refactor of linkedin's `require('./docker-ctl')` consumers.
The synchronous `require(esm)` shim was chosen precisely to avoid that.
