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

⚠ **AND THE TITLE IS HALF WRONG — my own premise, corrected by review.** *"One
question asked twice"* is right about **identity** and wrong about **mechanism**.
`ccew` showed that the X-input lease and the profile lock have **different lifetime
semantics** (§1b): they must agree on **what** is being contended, and they must
**not** share an implementation, because giving the lease a persistent record would
manufacture a staleness problem it does not have. ⇒ Read this document as *one
identity, two mechanisms*.

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

## 1b. ⭐ TWO RESOURCES, TWO LIFETIME SEMANTICS — and only one of them can go stale

**`ccew` measured this and it changes the shape of the design.** Their lane does
**not** use a `profile-lock` record for the X-input lease at all: the lease is a
**separate `flock` file with a plain-text holder note**. ⇒ The two things §1 treats
as one problem have **different lifetime semantics**, and conflating them imports a
failure mode that one of them does not have:

| | **profile lock** | **X-input lease** |
|---|---|---|
| form | a JSON **record** on disk | an **open file descriptor** under `flock` |
| held by | a recorded pid/host | the **process itself** |
| release | the record is rewritten or removed | the fd closes |
| on a **crash** | ⚠ the record **survives** ⇒ STALE | ✅ the kernel closes the fd ⇒ **released** |
| can it go stale? | **yes** — hence §2 and §5 | ⛔ **no, by construction** |

⭐ **So §2's fail-closed table and §5's migration apply to the RECORD, and the
lease needs neither** — there is no stale lease to misread, so there is nothing for
a schema check to get wrong. A design that gave the lease a record would be
*creating* the problem §2 exists to contain.

⚠ **AND THIS IS THE SECOND TIME A LANE HAS SOLVED A PROBLEM BY REMOVING THE BAD
STATE RATHER THAN GUARDING IT.** `perplexity` removed the stable endpoint so there
is nothing to point at the wrong browser (§4(ii)); `ccew` removed the persistent
lease record so there is nothing to misjudge as stale. ⇒ **Prefer a construction in
which the bad state cannot exist over a guard that detects it** — and when you
cannot, say which you built, because a guard needs a positive control and a
construction does not.

## 1c. The acquire mechanism, in `ccew`'s words and measured by them

> *"Take the lease **ON THE TARGET HOST**, in a process owned by the acting tool, and
> **HOLD IT FOR THE WHOLE INPUT BURST, not per command**: per-command locking still
> lets another tool interleave between one tool's click and its typing. Mechanism:
> `ssh HOST flock -n -E 75 LEASE -c 'write holder note; echo HELD; cat >/dev/null'`,
> whose stdin is a **FIFO** only the acting tool writes. RELEASE = the tool closes
> its fd → remote `cat` gets EOF → the lock drops; a **CRASH does the same**, because
> the kernel closes the fd. So no stale lease survives the holder. BUSY → refuse,
> naming the holder from the note."*

**Measured arms:** holder A acquires; a contender is refused with `rc 75` **and the
holder named**; explicit release frees it; `kill -9` of the holder frees it within
2 s; an integrated task script refuses with its own exit code while a second tool
holds the lease.

⭐ **"For the whole burst, not per command" is the load-bearing clause.** A
per-command lease is not a weaker version of this — it is a **different and broken
guarantee**, because the interleaving it permits (another tool's keystrokes between
this tool's click and its typing) is exactly the corruption the lease exists to
prevent, and every individual acquire would report success.

### ⚠ Two traps met while building it

* **Do not feed ssh's stdin from a process substitution.** `<(sleep N)` **orphans**
  the helper, which inherits the caller's stderr pipe — so a later `tool | grep`
  **hangs** on a pipe nothing will close. Use a **FIFO**.
* **The release path must not fail under `set -e`.** `kill` of an ssh that has
  already exited returns 1, which aborts the cleanup that was meant to be
  unconditional.

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
override; an inference cannot.

⛔ **AND A REMOTE HOLDER IS OVERRIDABLE ONLY BY NAMING IT** *(`ccew`)*. `--force`
must take the **exact holder token** from the lock — host + pid + since — **refuse on
mismatch**, and log the override. Reason: **liveness of a remote holder cannot be
checked locally**, so a bare `--force` is a guess with a signed-in session at stake,
and two tools driving one X display send keystrokes into the wrong place in a browser
holding the operator's sessions. ⇒ A **local** holder is different: liveness *is*
checkable, so auto-take-over is allowed **only when provably dead**.

⚠ **And no lock binds a HUMAN in a viewer.** `--force` policy cannot protect against
the contender `ccew` actually met. ⇒ `btg4` §6(b)'s concurrent-use detection is the
other half of this, and neither half is sufficient alone. ⚠ And a refusal must name the file and say *why it
could not be read*, or the operator's only recourse is to delete a lock they do not
understand — which converts a fail-closed design back into a fail-open habit.

## 3. Lock identity: key on the TARGET, not on the tool

⇒ The lock filename must be derived from **what is being contended** — the target
and the profile — not from **who is contending**.

```
<profile>/.webctl-target.<target>.<profile_id>.lock.json      (shape, not final)
```

✅ **DECIDED — BESIDE the profile, not inside it.** `ccew` already does exactly this
(`profiles/<slug>/x-input.lease`, beside `chromium/`) and gave three reasons, each of
which survives on its own: **Chromium owns the inside** (its own `Singleton*` files,
its scrubs, its layout); **a profile move or copy must not carry a lock**; and a
**sibling path is trivially flockable from a remote shell** without touching
Chromium's files. ⇒ That closes open question #1, and it matches the argument they
won for `isolation-accept.json`.

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

1. ✅ **ANSWERED — sibling, not inside.** `ccew`, from existing practice plus three
   independent reasons (§3). Chromium owns the inside; a profile copy must not carry
   a lock; a sibling is flockable from a remote shell.
2. **Who mints the claim** when a lane's bring-up script and its CLI are separate
   programs — the script, with the CLI reading it? And what happens on a manual
   `docker start` that bypasses both?
3. **Does any lane rely on the CURRENT fail-open?** ⇒ If a tool today recovers from
   a corrupt lock by acquiring anyway, fail-closed will surface as a new refusal.
   **Say so now**, not after the release.
4. ✅ **ANSWERED — a remote holder only by NAMING it** (§2): `--force` takes the exact
   holder token, refuses on mismatch, logs the override; a local holder may be
   auto-taken-over only when provably dead. *(`ccew`.)*
5. **STILL OPEN: does any lane rely on the current fail-open?** `ccew` answers **no**
   and asks for all three cases to refuse. Other lanes outstanding.
6. **STILL OPEN: is there a fifth lock state?** A record left by a container that was
   `docker rm`'d, for instance — raised as a candidate, not yet measured.
