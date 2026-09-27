---
id: ow9k
title: "Target ownership and lock identity — one question, asked twice"
category: safety
created: "2026-09-27"
updated: "2026-09-27"
status: draft
tags: [ownership, locking, mutex, identity, migration, fail-closed, targets, cdp]
tech:
  - name: "Node.js"
    version: ">=22.12"
relates_to: [btg4, v8m2, p06y, k7m2, k3wn, t2wf]
depends_on: [btg4]
expands: [btg4]
similar_to: []
---

# Target ownership and lock identity — one question, asked twice

`arch-browser-targets-btg4` left two things unresolved, and they are the same
thing:

* **§6(b)** — the X-input lease needs an identity two tools will both name.
* **§6(d) / the ownership open item** — an attaching tool needs to know whether it
  is the owner of the browser it is about to drive.

⭐ **Both are "who owns this target".** Designing them separately means the second
fix re-derives the first, and the two answers can then disagree — one notion of
ownership for locking and another for attaching, on the same profile.

⛔ **Nothing here has been implemented.** Every wired consumer already uses
`profile-lock`, so this is circulated for review **before** any `lib/` change.

## 1. Three measured defects, not three hypotheses

All reproduced 2026-09-27 against base at `v0.16.0`, each with a control.

### ⛔ (a) The lock identity is the TOOL, so two tools never contend

```
lib/browser-location/profile-lock.js:36
  const LOCK_FILENAME = `.${C.PROJECT}.lock.json`;
```

Two tools, one shared profile directory:

```
tool A lock:  <profile>/.alpha-webctl.lock.json
tool B lock:  <profile>/.beta-webctl.lock.json
SAME FILE? false   ⇒ THEY NEVER CONTEND
```

⇒ The lease that §6(b) relies on **cannot arbitrate between the two parties it
exists for.** *(Falsified by `fetlife`; reproduced here.)*

⚠ And a second layer: profile **paths** are per-tool too, because `cacheRoot()`
resolves through `createStoragePaths(C)`. So sharing needs an explicit
`userDataDir` override in **both** tools, and even then the filename splits them.

### ⛔ (b) A corrupt lock reads as FREE

`readLock()` warns and returns `null`; `acquire()` sees no previous holder and
succeeds.

```
corrupt lock        -> acquire ok=true  conflict=false
```

⇒ **Fail-open on a safety mechanism.** The warning goes to stderr, where an
automated caller does not read it and a green exit code says the lock was taken.

### ⛔ (c) `SCHEMA_VERSION` is written and NEVER READ — and the mismatch is "stale"

`SCHEMA_VERSION` is exported and stamped into every record. It appears **exactly
once** in the module: at the write. Nothing validates it.

A lock written in a future format, **whose holder is alive**, with the holder's pid
under a different field name:

```
schemaVersion 99    -> acquire ok=true  conflict=false
  log: "taking over stale lock … previous holder mode=test host=… (no-pid)"
```

⭐ **The log line is the worst part.** It does not say *"I do not understand this
lock"*. It states a **conclusion** — `stale`, reason `no-pid` — derived from a field
it failed to find. A live holder is declared dead and **taken over**, and the
message reads like a successful diagnosis.

**Control:** a well-formed v1 lock held by a live pid conflicts correctly. ⇒ The
mechanism works for the one format it knows and fails **open** for everything else.

⚠ This is `t2wf` and `k3wn` at once: a published version marker nothing reads is
indistinguishable from no marker at all, and "unrecognised" and "dead" arrive at
`acquire()` as the same value.

## 2. The rule that governs all three

> ⛔ **An unrecognised, unreadable or newer lock is HELD/UNKNOWN. Never free.**

A lock exists to say *"someone may be using this."* The only safe reading of "I
cannot tell" is **someone might be**. ⇒ Three outcomes, not two:

| state | verdict | acquire |
|---|---|---|
| no lock file | FREE | proceed |
| valid lock, holder provably dead | STALE | take over, logged |
| valid lock, holder alive | HELD | refuse |
| **corrupt / unparseable** | **UNKNOWN** | ⛔ **refuse** |
| **`schemaVersion` > ours** | **UNKNOWN** | ⛔ **refuse** |
| **`schemaVersion` < ours, unmigratable** | **UNKNOWN** | ⛔ **refuse** |

⭐ **`--force` is the escape hatch, and it must be the ONLY one.** A human can
override; an inference cannot. ⚠ And a refusal must name the file and say *why it
could not be read*, or the operator's only recourse is to delete a lock they do not
understand — which converts a fail-closed design back into a fail-open habit.

## 3. Lock identity: key on the TARGET, not on the tool

⇒ The lock filename must be derived from **what is being contended** — the target
and the profile — not from **who is contending**.

```
<profile>/.webctl-target.<target>.<profile_id>.lock.json      (shape, not final)
```

* **`<target>`** — the target name from `btg4` §3/§4.
* **`<profile_id>`** — `btg4` §2's **opaque** id.
* ⛔ **No `C.PROJECT` anywhere in the path.** That is the defect.
* ⚠ **`profile_id` must resolve to ONE concrete path outside every per-tool cache
  namespace**, or the indirection re-introduces the split it removes (`fetlife`).

⭐ **Prior art, not the answer:** `perplexity` already keys its lock by **target
name, per invocation** — which is exactly this identity, arrived at independently
by a lane that needed it. Their lock is a working existence proof that target-keyed
locking is implementable; it is not evidence about migration, which they did not
have to do.

## 4. Ownership: a claim, and the stronger form that needs no claim

The lease answers *"may I act now?"*. Ownership answers *"is this browser mine at
all?"* — and today nothing answers it, because `--cdp <url>` is free-form and
nothing in a CDP connection carries provenance (`substack`).

### (i) The general answer — a claim minted at creation, verified before attach

*(Shape from `webctl:mgr`'s template spec; recorded here as the general case.)*

* **Minted when the tool — or its own bring-up script — CREATES the target.**
* **Claim = (tool id, target name, a random nonce)**, written into the target's own
  metadata (container labels, or a file in the target's data dir) **and mirrored in
  the tool's target config**.
* **Verified before ANY CDP frame is sent.**
* ⛔ **Mismatch or absence is a REFUSAL, not a warning** — consistent with §2 above
  and with `btg4` §7.

### (ii) ⭐ The stronger form — identity by CONSTRUCTION

*(`perplexity`, designed after auditing their own attach path.)* Rather than
guarding a stable port with a claim, **remove the stable port**: build the tunnel
per invocation, resolve the remote endpoint through the manager's own ownership
labels, forward to an ephemeral local port owned by that call, and send the remote
command on **stdin** (`r7x2` §1b).

⇒ **The failure mode becomes *absent* rather than *detected*.** There is no stale
endpoint left to point at the wrong browser.

⚠ **It is not always available** — it needs a manager that labels ownership and a
transport you can build per call. ⇒ **(ii) where achievable, (i) as the floor.**

### ⚠ Ownership is per (TOOL, TARGET), and "owner" has three readings

`substack` and `linkedin` both have a tool that brings the browser up and a
separate tool that drives it. `webctl:mgr` then corrected the test itself: the harm
is **whose sessions are in the profile**, not who called `start`. ⇒ So:

| | |
|---|---|
| **owner** | drives a browser holding only its own sign-ins |
| **owner, split across processes** | its bring-up script started it; its CLI attaches — **not a guest** |
| **guest** | evaluates in a profile holding **another party's** sessions |

⇒ A claim must therefore be **per-lane**, not per-process, or a lane's own CLI
fails to recognise a browser its own script created.

## 5. ⛔ Migration is the part most likely to go wrong

Every wired consumer already writes `.<PROJECT>.lock.json`. Changing the filename
means a running tool's lock **becomes invisible to the new code** — and an
invisible lock is an unlocked profile.

⇒ **Required behaviour, and it is the inverse of the usual migration instinct:**

1. **Read BOTH** the target-keyed name and the legacy `.<PROJECT>.lock.json`.
2. **A legacy lock whose holder is alive is HELD.** Not "old format, ignore".
3. **A legacy lock that cannot be read is UNKNOWN ⇒ refuse** (§2).
4. **Write only the new name.** Never write both; two lock files for one resource is
   `t2wf` by construction, and the moment they disagree neither is authoritative.
5. **Removing legacy support needs its own release**, and the CHANGELOG must say
   which version stops reading the old name — because that is the release in which
   an old running holder silently becomes invisible.

### ⭐ And it must be proven with a PLANTED OLD-FORMAT LOCK

*(`webctl:mgr`'s instruction, and `ccew`'s rule applied: a refusal test needs a
positive control on the same fixture.)*

The suite must plant, in one fixture:

* a **legacy-named lock with a live holder** → the new code must report **HELD**;
* a **legacy-named lock with a dead holder** → **STALE**, taken over, logged;
* a **corrupt legacy lock** → **UNKNOWN**, refused;
* a **`schemaVersion` above ours** → **UNKNOWN**, refused;
* ⭐ and a **positive control on the same fixture**: a valid new-format lock with a
  live holder → **HELD**. Without it, every refusal above passes whenever the reader
  is simply blind, which is exactly how `no-revendor` spent generation 1.

## 6. What this design does NOT do

* **It does not make the posture enforceable against a determined caller.** A claim
  converts an honour system into a **detectable state**. A tool that wants to lie
  still can.
* **It does not lock across hosts by itself.** `isHolderAlive()` already returns
  `{alive: true, reason: 'remote'}` for a different hostname — correct and
  conservative, and it means a remote holder is never taken over automatically.
  ⚠ Which also means a **genuinely dead remote holder needs `--force`**, by design.
* **It does not decide where `profile_id` resolves.** That is `btg4` §2's job, and
  this design is blocked on it: the path must be outside every per-tool cache
  namespace.
* **It does not address the lock record's contents.** ⚠ Lock records contain a
  **hostname** today. Anything that copies, exports or commits a profile carries
  that — which is why base docs forbid defaulting a profile into a publishable
  location, and why a lock record should never grow more host detail than it needs.

## 7. Open, for the lanes rather than for me

1. **Filename shape.** Is `.webctl-target.<target>.<profile_id>.lock.json` right, or
   should the lease live in a **sibling** directory as `btg4` §3 chose for targets,
   leaving the profile dir to Chromium? ⚠ `ccew` argued the sibling case for
   `isolation-accept.json` and it applies here.
2. **Who mints the claim** when a lane's bring-up script and its CLI are separate
   programs — the script, with the CLI reading it? And what happens on a manual
   `docker start` that bypasses both?
3. **Does any lane rely on the CURRENT fail-open?** ⇒ If a tool today recovers from
   a corrupt lock by acquiring anyway, fail-closed will surface as a new refusal.
   **Say so now**, not after the release.
4. **`--force` semantics across hosts.** Should it override a remote holder, or only
   a local one? Overriding a live remote holder is the one case that can log a human
   out of a signed-in browser.
