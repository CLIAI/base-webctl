# FUTURE_WORK — service-agnostic naming/example scrub in base/lib

* **Category:** reconcile
* **Created:** 2026-06-23
* **Concerns:** `lib/lru-cleanup.js`, `lib/systemd-timer.js`,
  `lib/browser-location/cdp-rewrite.js`, `lib/browser-location/localhost-direct.js`;
  AGENTS.md "Service-agnostic" invariant.

## What this is

The verbatim CJS→ESM ports (v0.1.0–v0.3.0) carried over a few platform-named or
tool-named **comments / JSDoc examples / parameter names** from the consumer
source. These are NOT per-repo VALUES and do NOT drive base behaviour (the seam
invariant — base ships no real constants as data — holds; verified), but they
brush against the service-agnostic-naming invariant:

* `lru-cleanup.js` — `annotateTabs({ linkedInTabs })` param name + a couple of
  JSDoc references (`classifyLinkedInUrl`, "LinkedIn pages"), and a provenance
  comment naming both repos.
* `systemd-timer.js` — a JSDoc example slug `"chatgpt-webctl-lru"`.
* `cdp-rewrite.js` / `localhost-direct.js` — illustrative `4327` in explanatory
  comments / `@property` examples.

## Why it's deferred (not fixed inline now)

* The `linkedInTabs` **destructured param name is the public API** —
  consumers call `annotateTabs({ linkedInTabs: tabs })`. Renaming it to
  `appTabs` is a **breaking API change** that must be coordinated with a consumer
  bump (a `major`), not a silent edit. It belongs in a planned rename, not a
  drive-by.
* The rest are comment/example-only; harmless to behaviour. Batching them with
  the param rename keeps the change reviewable as one "service-agnostic scrub".

## What unblocks it

A coordinated minor/major: rename `linkedInTabs` → a neutral name (e.g.
`appTabs`) in base + update consumers' call sites in the same version bump, and
sweep the comment/example strings to neutral placeholders (`<tool>-webctl`,
`<cdp-port>`). Low priority; cosmetic + one API name. Schedule after the
higher-value driver/registry extraction.
