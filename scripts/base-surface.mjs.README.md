# `base-surface.mjs` — what does base actually expose?

Enumerates base's callable surface by **constructing**, not grepping.

```sh
node scripts/base-surface.mjs            # everything
node scripts/base-surface.mjs inspect    # just names containing "inspect"
```

```
driver surface  lib/browser-location/chromium-docker-xpra.js  createChromiumDockerXpra().createDriver().inspect
factory return  lib/browser-location/profile-lock.js          createProfileLock().inspect

  module export  140
  factory return 117
  driver surface 7
  ⇒ 47% of the callable surface is reachable ONLY by constructing
```

## Why

**46% of base is invisible to `grep 'export function X'`** — and that is the
query a consumer naturally writes. A lane and its manager independently
concluded *"`inspect()` does not exist in base"*, both from a module-export
query, both reporting *"verified at the tag"*. Neither was careless: `inspect`
is an inner function returned in an object literal, so the grep is structurally
blind to it **even in the right file**.

⇒ A lane that reaches that conclusion **reimplements the capability locally** —
the duplication the shared base exists to prevent, arrived at by due diligence.

⭐ This is the shim-completeness check mirrored: a shim re-exporting only *the
factory's return* is blind to *module-level* exports; a grep for *module-level*
exports is blind to *the factory's return*. **Completeness is not checkable from
either side alone.**

## ⛔ Before adding "show me what each member returns"

That is the obvious next feature and the unsafe one.

| | |
|---|---|
| **constructing** | pure — `createDriver()` has been side-effect-free since v0.11.0 |
| **invoking** | **not** — `resolveChromiumProfile()` mkdirs; `profilePathFor()` is the pure sibling |

The tool points everything at a throwaway `HOME` and **prints where**, so the
claim is checkable rather than trusted. A test asserts the real `~/.cache/CLIAI`
is unchanged across a run.

## Exit codes

`0` ok · `1` **zero factory returns found** — see `.DEV_NOTES.md`.

Credit: design and first implementation by the `linkedin-webctl` lane; base
ships the ESM copy so CJS lanes reach it like any other base module rather than
each carrying an enumerator.
