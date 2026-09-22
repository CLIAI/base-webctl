# `probe-contract-capability.sh` — dev notes

## The measurement that produced it

`deriveXpraPorts` sabotaged on a throwaway branch, `--against-head` run:

```
SWAP  chatgpt-webctl:  b2620e9 -> bea14a2 (base HEAD)
PASS  chatgpt-webctl                                   <- against destroyed code
SWAP  substack-webctl: 5c3db07 -> bea14a2 (base HEAD)
PASS  substack-webctl                                  <- against destroyed code
FAIL  fetlife-webctl (exit 1): candidate deriveXpraPorts: expected tcp 14427, got 99999
```

The **swap works** — that part of the gate is sound, and the earlier claim that
`--against-head` is structurally incapable of failing is too strong: it failed
here. What is true, and worse than it sounds, is that **before fetlife fixed its
contract that same day, no consumer in the registry could detect a broken
candidate.** So the arm ran, consumers executed, and the output was shaped
exactly like validation while having no way to say no.

## Both controls, and one I got wrong first

* **A — CAPABLE must mean "distinguishes", not "always red".** A contract that
  fails on everything would look capable. Verified: `fetlife` and `gemini` both
  return **0** against a healthy candidate and **1** against the sabotaged one.
* **B — the probe must abort if its own mutation did not land.** ⚠ My first
  attempt copied the script to a scratch dir, which broke `BASE_ROOT`; it exited
  **1** — the code I wanted — for a `FileNotFoundError` that had nothing to do
  with the abort path. *Asserting the status instead of the finding*, in the
  control for a script about exactly that. Redone in place: it now aborts with
  *"the sabotaged candidate does NOT misbehave (got '14427')"*.

## Why the sabotage is a temp directory and not a commit

The measurement above was made with a real commit on a throwaway branch in the
**live working copy**. It was restored within minutes, but during that window
another agent copied this repo to build its own "healthy" control and got a
sabotaged copy — so its healthy and broken cases both failed and it briefly
suspected its own patch.

> **A control is only as clean as the tree it was copied from.**

⇒ A destructive control belongs in a throwaway clone or worktree, never in the
working copy other agents read. This script takes that as a constraint: the
sabotage never enters git, so there is no window in which a reader can catch it.

## Deliberately not distinguished

"Ignores `WEBCTL_BASE_DIR`" and "honours it but never exercises the sabotaged
function" produce the same verdict. Splitting them would need a second probe and
would not change what the operator does, which is: fix the contract.
