# `base-surface.mjs` — dev notes

## The vacuity guard is on the tool itself

If it reports **zero factory-return members**, it has silently become the grep
it replaces — same answers, same blind spot, and *nothing about a clean run
would say so*. A loader change, a rename, or a walk that stops matching all
present as a tidy report over a smaller surface.

⇒ So it **exits 1 and says why**. Controlled: mutating the factory-name pattern
to something unmatchable fails all three tests, one of them on the exit code and
message rather than on the count.

## The test asserts a PROPERTY, never a symbol

`at least one name is reachable only by constructing` — **not** `inspect` by
name.

⚠ Pinning a symbol couples the control to a surface base may legitimately
change. The control would then fail for a **correct** reason, and be deleted by
whoever refactored that symbol. ⭐ **Deleting a control that fails correctly
looks like tidying, and is indistinguishable from tidying at review time.** The
only defences are this note and an assertion no rename can satisfy.

The share assertion is deliberately loose (`> 20%`) for the same reason: pinning
46% fails on healthy growth, and a test that fails when nothing is wrong gets
removed.

## Why ESM, when the original is CJS

base is ESM. The original lives in a CJS lane and reaches base through
`require(esm)`. ⇒ base shipping the ESM copy means **one implementation**, which
CJS lanes consume exactly as they consume every other base module — rather than
three independent enumerators, which is what the week already produced.

⚠ The untested arm, named by its author: a lane running this under a different
loader. base's own use is native ESM, so that path is exercised here; a
consumer's is not.

## The constants bag is not base's own template

Deliberate. ⭐ A fixture that *is* the thing under test cannot show that the
thing under test is missing something.

## `needs opts` is a row, not a silence

Three factories require arguments (`localhost-direct` a port, `xpra-access-store`
a statePath, `xpra-html5-gateway` an upstreamPort). *"Cannot construct without
arguments"* is a **true answer about the surface** — omitting it would make a
factory look absent rather than differently-shaped.
