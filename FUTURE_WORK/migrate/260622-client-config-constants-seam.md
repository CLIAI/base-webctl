# FUTURE_WORK — the client-config.constants SEAM blocks 3 modules

* **Category:** migrate
* **Created:** 2026-06-22
* **Concerns:** base extraction of `chromium-prefs.js`, `client-config.js`,
  `profile-lock.js`; design `sb7q` §"API surface & semver" (the per-repo seam).

## What is deferred

These three modules are byte-identical across linkedin==chatgpt and otherwise
ready to extract, but each does, at module load:

```js
const C = require('./client-config.constants');   // or '../client-config.constants'
```

`client-config.constants.js` is the **per-repo seam** that `sb7q` says is *never*
shared (PROJECT / ARTIFACT_PREFIX / DEFAULT_CDP_PORT / ZOOM_DEFAULT_HOST /
ENV_PREFIX; Greg-approved co-design contract, 2026-05-30). If a base module
`require()`s `./client-config.constants`, that resolves **inside base**
(`vendor/base-webctl/lib/client-config.constants.js`) — which base must NOT ship
with real per-tool values. So a naive verbatim extraction would either fail to
resolve or smuggle one tool's constants into the shared library. **Blocked on a
design decision, not effort.**

## The design question (design-doc-first, per AGENTS.md)

How does a base module receive the *consumer's* constants without base shipping
them? Candidate mechanisms to spec in `docs/design/` before any code:

1. **Dependency injection / factory** — base exports `createChromiumPrefs(C)` /
   `createClientConfig(C)` etc.; the consumer's shim passes its own constants.
   Cleanest seam, but it's an **API change** (not a drop-in shim) and touches
   every call site in the consumer.
2. **Resolver + template** — base ships `client-config.constants.template.js`
   (shape/schema only, throwing placeholders) and a runtime **resolver** that
   loads the consumer's real constants from a well-known path / config
   (sb7q already hints: "base ships the resolver + a constants schema/template;
   each tool fills in its own values"). Keeps the import-style but needs a
   defined resolution order.
3. **Constructor-time config object** threaded from the consumer entrypoint.

`sb7q` already leans toward #2 ("resolver + schema/template"). Needs a short
design doc nailing the resolution order + the template's shape + how the shim
wires it, then implement + prove in scratch like the leaf modules.

## Why it does not block the v0.2.0 batch

The 5 dependency-free leaf modules shipped in v0.2.0 independently. These 3 wait
for the seam design; their registry/consumer entries stay on the byte-copy until
then (the drift canary only flags *wired* consumers, so no false alarm).

## What unblocks it

A merged seam design doc (recommend expanding `sb7q` or a new `infra-*` doc),
then the same extract → unit-test → tsc → scratch-prove → per-module-proposal
loop used for the leaves.
