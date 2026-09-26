# `contract-harness.mjs` — the checks every contract was copying

A consumer's `test-against-base.sh` calls this instead of reimplementing the
checks that have rotted in three lanes at three different ages.

```sh
node "$BASE_DIR/scripts/contract-harness.mjs" generation
node "$BASE_DIR/scripts/contract-harness.mjs" pin         --repo . --sub vendor/base-webctl
node "$BASE_DIR/scripts/contract-harness.mjs" no-revendor --repo . --sub vendor/base-webctl --lib lib
```

**Exit:** `0` pass · `1` fail · `2` **no verdict** (reason is the last line) ·
`3` usage.

⇒ **The harness owns the exit code.** A contract never re-implements
`[ "$rc" = "2" ] && { … }`, which as an arm's last statement returns 1 under
`set -e` and turns a *green* suite red.

## Why a library

**A defective contract reports green.** Every other duplication in this family
fails loudly; this one fails by reassuring us. Three defects, three lanes, three
ages — and two of the three were found by someone looking *across* copies rather
than by any lane reading its own.

## The checks

### `pin`

Asserts the pin is an exact tag, read from the **committed gitlink** — not the
submodule worktree. Those differ exactly when the release gate has swapped the
submodule, which is when a contract is most likely to report a tag its own repo
does not declare.

⛔ **`WEBCTL_DECLARED_PIN` COMES FROM THE GATE PROCESS, NOT FROM YOUR PIN.** It
is set in your contract's environment at runtime by `test-all-consumers.sh`
before it swaps your submodule. ⇒ **A lane on any pin, however old, receives
it** — there is no version in which "my base does not export it yet" is a
reason to skip it. *(One lane deferred exactly on those grounds, which is the
likeliest reason the correct key was used zero times in four attempts.)*

⛔ **The carve-out is keyed on `WEBCTL_DECLARED_PIN`, not `WEBCTL_BASE_DIR`.**
The directory variable is a *proxy* — the gate sets it every run, so keying the
skip on it skips a computable check every time. Under a swap the check returns
**no verdict**, never a fail: a candidate is not yet tagged, and failing there
is a vacuous RED. *A gate that always blocks gets overridden.*

### `no-revendor`

Asserts no local file shadows a base module. **Asserts code, never prose** —
comments are stripped first, because the check this replaces grepped for the
vendor path and matched the string inside the shim's own comment.

⚠ Examining **zero** files FAILS. "No re-vendoring found" over nothing is the
shape that let the original grep pass.

### `generation`

Prints `HARNESS_GENERATION`. A consumer records the generation it was written
against, so a sweep asks **"who is below N?"** instead of "who differs?" —
because rot and legitimate per-lane customisation look identical in a diff.

⚠ **A generation marker is not sufficient on its own.** It says an old copy
carries old rot. It does *not* say a **correct** copy's assumptions have expired
against a newer pin. Two mechanisms.

See `.DEV_NOTES.md`.
