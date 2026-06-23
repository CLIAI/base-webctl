# FUTURE_WORK — dockerfilesDir must be injected (not module-relative) when vendored

* **Category:** migrate
* **Created:** 2026-06-23
* **Concerns:** v0.4.0 step 1 (mounts — DONE) and step 2 (`chromium-docker-xpra`
  driver, which calls `mounts.dockerfilesDir()` / `dockerfilePath()`).
* **Status:** RESOLVED for mounts; **carry the contract into the driver step.**

## The finding (not flagged by the v0.4.0 plan)

The plan said mounts.js "uses `C.ARTIFACT_PREFIX` / `IMAGE_CHROMIUM_REPO` /
`IMAGE_XPRA` / `CACHE_DIRNAME` — all function-scope → clean factory." True for
those — but it missed `dockerfilesDir()`, which resolved **module-relative**:

```js
path.resolve(__dirname, '..', '..', 'dockerfiles')   // old consumer mounts.js
```

The Dockerfiles (`dockerfiles/chromium/*.Dockerfile`, `dockerfiles/xpra/*`) are
**consumer-owned** — they live in each tool's repo. base ships **no** `dockerfiles/`.
Vendored at `vendor/base-webctl/lib/browser-location/mounts.js`, the module-relative
path resolves to `vendor/base-webctl/dockerfiles` → **wrong / nonexistent**.

## Resolution (mounts, shipped in base@v0.4.0 createMounts)

`createMounts(C, { dockerfilesDir })` takes the dir as an injected absolute path
or thunk (mirrors the established deps-injection seam: profile-lock's
`dockerInspect`, and the planned driver `createChromiumDockerXpra(C, deps)`). The
consumer shim supplies its own `dockerfiles/` via the shim file's `__dirname`:

```js
module.exports = mounts.createMounts(require('../client-config.constants'), {
  dockerfilesDir: path.resolve(__dirname, '..', '..', 'dockerfiles'),
});
```

A module-relative fallback remains for standalone/in-tree use, but **vendored
consumers MUST inject** (documented in the JSDoc + both v0.4.0 mounts proposals).

## Carry into step 2 (driver)

`chromium-docker-xpra.js` builds images using `mounts.dockerfilesDir()` /
`mounts.dockerfilePath()`. Once mounts is the injected base surface, the driver
gets the consumer-owned path **for free** through the same `mounts` instance — no
separate injection needed, **provided** the driver receives the already-built
`mounts` surface via its `deps` (the `createChromiumDockerXpra(C, deps)` contract)
rather than constructing its own. Confirm this when porting the driver.
