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

## 0. ⭐ LEAD WITH THE GRANULARITY, NOT THE REFUSALS

**`cgwc` argued the ordering and is right: the three refusals below harden a lock
that is currently guarding the wrong thing.** Measured by them with two lanes'
constants against one profile:

```
createProfileLock(<tool A> constants).lockPath('/p')  ->  /p/.<tool-a>.lock.json
createProfileLock(<tool B> constants).lockPath('/p')  ->  /p/.<tool-b>.lock.json
```

⇒ **Mutual exclusion over the resource that actually matters — the profile — is
absent today, in every wired lane, and no fail-open case is involved.** Dropping the
tool name from the filename (§3) is therefore the larger win; §2's refusals make a
correct lock trustworthy, and §3 makes it a lock over the right resource.

⭐ **And `cgwc` extracted the rule that generalises it.** This is the third
scope-mismatch in their lane this month, and the earlier two point the *opposite*
way: a shared log directory needed pruning scoped **by tool** (a blanket filter ate
siblings' files), a tab-activity ledger had to be **tool-scoped** for the same
reason — and this one is tool-scoped where it must be **resource-scoped**. ⇒ The rule
is not *"scope by tool"* or *"scope by resource"* but **scope by WHAT MUST BE
MUTUALLY EXCLUSIVE** — a different question each time, and the one nobody asks.

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

**Control:** a well-formed v1 lock held by a live pid conflicts correctly.

⛔ **BUT MY CAUSAL CLAIM WAS WRONG, AND `linkedin` ISOLATED IT.** I varied
`schemaVersion`; the outcome is driven by **`containerName` and `pid`**:

```
container + pid           -> {alive:true,  reason:'unknown'}
container, NO pid         -> {alive:true,  reason:'unknown'}   <- fail-CLOSED
NO container + pid        -> {alive:true,  reason:'pid'}
NO container, NO pid      -> {alive:false, reason:'no-pid'}    <- the fail-open
v99, NO container NO pid  -> {alive:false, reason:'no-pid'}    <- schema IRRELEVANT
```

⇒ **A `schemaVersion: 99` lock that carries a recognisable `containerName` or `pid`
is treated as ALIVE and refused.** The takeover in my experiment came from **no
locatable holder**, not from the schema. ⚠ They also checked whether it was a
regression: the liveness code is **byte-identical between v0.13.1 and v0.16.0**, so it
is longstanding.

### ⛔ AND MY BAD FIXTURE BECAME TWO OTHER LANES' CONCLUSIONS

**This is the most expensive mistake in the document, so it is recorded at length.**
My probe wrote the holder pid under **`holderPid`** and gave the lock **no
`containerName`**. So it was not a "future-format lock" at all — it was **a lock with
no holder field this reader looks at**, and the schema number was decoration.

Two lanes then measured against my claim and reached **opposite, incorrect
conclusions:**

* one reported *"case 2 does not reproduce at v0.13.1"* — correct observation, because
  their fixture named the pid `pid`, where the reader looks;
* the other concluded it was a **regression** introduced by the factory refactor, on
  the theory that newer base **gates the pid read on a recognised schema** — and was
  preparing not to adopt base's module because adopting would make their lane *less
  safe*.

✅ **Both settled by measurement, and there is NO regression and NO schema gate:**

```
profile-lock.js md5   v0.13.1  6124d14c1734
                      v0.16.0  6124d14c1734
                      HEAD     6124d14c1734     ⇒ byte-identical
grep schemaVersion    ONE occurrence, at the WRITE  ⇒ nothing branches on it
same fixture, pid under `pid`     -> acquire ok=FALSE   (refused, correctly)
same fixture, pid under `holderPid` -> acquire ok=TRUE  (my result)
```

⭐ **THE LESSON IS NOT "CHECK YOUR FIXTURES".** It is that **a wrong CAUSAL claim in a
circulated design doc is executed by other lanes as if it were a specification.** They
did the right thing — they measured rather than believed — and the measurement still
cost them, because the *variable I named* determined what they varied. ⇒ A finding must
state **what was varied and what was held constant**, or the next reader reproduces the
framing rather than the fact.

⭐ **So these are TWO defects, not one, and the fix I was heading for was wrong.**
`SCHEMA_VERSION` being unread is real. A lock presenting neither a pid nor a container
*where this reader looks* being declared dead is also real — and it is the one my
control actually exercised. ⇒ **The guard therefore cannot be "add a schema check."** A
genuinely newer format is dangerous **precisely because it may put the holder
somewhere this reader does not look**, so the rule has to be:

> ⛔ **"I cannot LOCATE a holder ⇒ refuse"** — independent of version.

A version check would pass a future format that *did* declare its version honestly
while still hiding its holder field, and would refuse a future format that was
perfectly readable. The version is a proxy; **locating the holder is the fact.**



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

## 2a. ⛔ A REFUSING API IS NOT A REFUSING SYSTEM — and ow9k cannot fix that alone

**`linkedin` measured the consumer side and it inverts the expected benefit.** Their
driver does:

```js
try {
  const r = await profileLock.acquire(profilePath, {…}, { force: true, dockerInspect });
  if (r.tookOver && r.previous) logger.warn('took over stale profile lock…');
} catch (e) {
  logger.warn('could not write lock … (continuing anyway)');
}
```

Two independent problems, **either sufficient**:

* **`force: true`** bypasses the conflict check by construction. Verified:
  `acquire(force:true)` over a lock held by their **own live pid** returns
  `{ok:true, tookOver:true}`. It steals a live lock.
* **`r.ok` is never checked** — only `r.tookOver`. ⇒ If §2 refuses by returning
  `ok:false`, this code **ignores it and starts the container**. If it refuses by
  **throwing**, the `catch` logs and says *"continuing anyway"*.

⛔ **So §2 as specified would not stop that lane — it would make it proceed with NO
LOCK AT ALL, which is strictly worse than today**, where at least a record gets
written.

⭐ **⇒ "Every wired lane refuses" is NOT a property this design can assert.** A
refusing API needs a **consumer that checks**, and no return value or exception can
compel one.

### ✅ RULED: `{ok:false}` for the OLD verdicts, THROW for the NEW ones

`linkedin` asked which, because the check they must add differs. **Neither form is
ignore-proof** — they demonstrated both failure modes in one call site. But they differ
in **what ignoring looks like**:

| form | ignoring it requires | evidence left |
|---|---|---|
| `{ok:false}` | writing **nothing** — the default path proceeds | ⛔ none |
| **throw** | writing a `catch` that swallows | ✅ **an explicit, greppable act** |

⇒ So a throw is not chosen because it cannot be ignored; it is chosen because
**ignoring it leaves evidence in the source** that a reviewer, or a contract
assertion, can find.

⭐ **And the rule that follows is sharper than "throw everything": THE FORM SHOULD
DEPEND ON WHETHER THE CASE IS NEW.**

* **HELD by a known live holder — keep `{ok:false, conflict:true}`.** Consumers already
  have code for this; one lane's recovery depends on the adjacent takeover path (§2b).
  Changing its form would break working code to no benefit.
* ⛔ **The NEW UNKNOWN verdicts — corrupt, holder-not-locatable, unreadable format —
  must THROW**, with a **distinctly named error type**. Because they are new, **no
  consumer has code for them**, and a new `{ok:false}` is absorbed silently by every
  existing caller that only checks `tookOver`. A throw is the only form existing code
  **cannot absorb without saying so.**
* ⇒ Throwing here **breaks nobody's working path**: it interrupts only a path that
  would otherwise have proceeded unsafely, which is the definition of the change.
* A named type also lets a lane catch **narrowly**, and lets a contract assert *"no
  handler swallows `ProfileLockRefused` without rethrowing"* — which is the closest
  base can get to enforcing a consumer-side property.
* ⚠ **`force` must never be the convenient default.** The measured call site passes
  `force: true` unconditionally; whatever base ships must make the safe call the short
  one.

⚠ The rest is consumer-side, and this document must not claim otherwise.

⚠ **AND THE JUSTIFICATION AT THAT CALL SITE IS THIS DOCUMENT'S OWN FAILURE SHAPE.**
The comment defends `force: true` with *"`ensureRunning()` above already refused if a
LIVE holder existed"* — **a precondition assumed at one site and enforced at another.**
`linkedin` drew the parallel themselves: it is the same shape as a check whose
precondition was the thing under test (`k3wn`). ⇒ If the pre-check's liveness verdict
ever diverges from `acquire`'s — and §2d says liveness is **caller-dependent** — then
`force` quietly steals.

## 2b. ✅ RULED: a stopped-or-missing LOCAL CONTAINER stays an AUTOMATIC takeover

**`substack` asked for this explicitly because it gates a human action, and their
argument decides it.** Their containers exited at a reboot (no restart policy,
family-wide) and sat `Exited` with a valid lock present for two weeks. `start` worked
only because `container-stopped` ⇒ dead ⇒ takeover.

⇒ **§2's `--force` requirement scopes to a REMOTE holder ONLY.** It does **not**
reclassify a local container-backed holder.

⭐ **And the reason is the distinction the whole document turns on: a stopped
container is a FACT YOU CAN CHECK, not an inference across a network.** `--force`
exists where liveness cannot be established. Where it *can* be established — by
asking the local container runtime — requiring a human adds no safety and removes
recovery. ⚠ Getting this wrong would mean every reboot leaves that lane needing
manual intervention, and the thing it blocks is the operator sign-in that has been
its only open action for weeks.

## 2c. ⚠ WHAT THE MODULE ALREADY GETS RIGHT, AND A REWRITE MUST NOT REGRESS

*(`cgwc`, who nearly reported it as a bug and checked first.)* They found a **dead
pid while the container was running** and started writing it up — then found
`isHolderAlive()` asks **docker** whenever `containerName` is present, and returns
`{alive: true, reason: 'unknown'}` when **no inspector is supplied**.

⇒ **So the liveness question ALREADY FAILS CLOSED: unprobeable means held.** This
document is about replacing fail-open with refusal, and this is a place base is
**already correct**. ⛔ A rewrite that tightened the corrupt path while regressing
that default would be a **net loss**. The lock record carrying **both** `pid` and
`containerName` is what makes it possible: for a container-backed browser the pid is
a CLI that exits seconds later, and **the container is the holder.**

## 2d. ⛔ LIVENESS IS CALLER-DEPENDENT — the load-bearing gap for guest ownership

*(`substack`, sharpening their own earlier warning.)* There are **three** claims where
I had written two:

1. *the code refuses an unparseable lock* — offline-testable with planted files;
2. *no unparseable lock is ever acquired in production* — **not** asserted by (1);
3. *every caller decides liveness the same way* — ⛔ **FALSE today.**

(3) fails because `dockerInspect` is **injected**. base's own driver injects it; a
caller that does not — another lane's tooling, or a guest tool — sees **the same lock
file as alive forever**.

⇒ **So a guest that cannot inject `dockerInspect` can never learn that the owner is
gone.** For a design whose purpose is letting a guest determine ownership, that is the
load-bearing gap, and it is not fixed by any of §2's refusals. ⚠ A contract that
asserts the refusals **with a stub** has said nothing about what production callers
inject.

## 2e. ⚠ A PID FROM A PREVIOUS BOOT, and the field that is recorded but never read

*(`substack`.)* `process.kill(pid, 0)` cannot distinguish *"my holder lives"* from
*"an unrelated process now has that number"*. On a machine where `pid_max` is
4,194,304 and live pids already span nearly that whole range, a reboot restarts the
counter into the same dense region. ⇒ Not a tail risk.

⭐ **Scoped honestly, because it does NOT bite the lane that found it:** the container
branch returns *before* the pid branch, so for a container-held lock the `pid` field is
**recorded and never read**. The hazard is real only for a lock **without** a
`containerName` — a direct, non-containerised browser. ⚠ **And a field that looks
load-bearing while being unreachable is worth knowing about on its own**: someone will
eventually "fix" a stale lock by checking that pid.

⇒ **Fix: record `boot_id` beside the pid** (`/proc/sys/kernel/random/boot_id`). A pid
from a previous boot then reads as **known meaningless** rather than plausibly alive.
This document is titled *lock identity*, and a pid is only an identity within one boot.

## 3. Lock identity: key on the TARGET, not on the tool

⇒ The lock filename must be derived from **what is being contended** — the target
and the profile — not from **who is contending**.

```
<profile>/.webctl-target.<target>.<profile_id>.lock.json      (shape, not final)
```

⛔ **REOPENED — I MARKED THIS DECIDED ON ONE LANE'S INPUT AND A SECOND LANE HAS
MEASUREMENT AGAINST IT.** Recording both arguments rather than the one that arrived
first, because they are both strong and they point opposite ways.

**BESIDE** *(`ccew`, from existing practice — `profiles/<slug>/x-input.lease` beside
`chromium/`)*: Chromium owns the inside; **a profile move or copy must not carry a
lock**; a sibling is trivially flockable from a remote shell without touching
Chromium's files. Same argument they won for `isolation-accept.json`.

**INSIDE** *(`cgwc`, with 20 days of evidence)*: their profile lock has sat inside a
constantly-written profile since 2026-09-07, **unmodified**, beside Chromium's own
`.org.chromium.Chromium.*` artifact. ⇒ *"Chromium owns the inside"* is true but
**namespaced** — it prefixes its own files and empirically does not sweep unknown
dotfiles. That is a measurement, not a preference.
⭐ **And their stronger argument is SEPARABILITY, not tidiness:** a beside-lock
**survives the profile moving**, and then guards a directory that is not there — or
worse, **a NEW profile created at the old path inherits a stale lock asserting
ownership of data it has never seen.** Inside means the lock cannot be separated from
what it guards **by construction**.

⚠ **AND THE INVERSE HAZARD, WHICH `substack` FOUND IN BASE AS IT STANDS:** the
profile lock is inside today, so **anything that resets or wipes the chromium profile
dir while the container keeps running silently RELEASES a lock whose holder is still
alive.** ⇒ So each placement has a way of decoupling the lock from the truth:
*beside* survives a move it should not survive, *inside* is destroyed by a wipe it
should survive. Neither is free, and the choice is which failure a lane can detect.

✅ **RESOLVED — and by a criterion rather than a preference, which is why it settles
it.** `linkedin` supplied it, with evidence that argues **against their own instinct**:

> **The inside file must be RECONSTRUCTIBLE, not outside.** A lock whose loss is
> **recoverable** can live inside; a file whose loss **silently re-grants** something
> cannot.

⇒ **So the two files get DIFFERENT answers, and the earlier disagreement dissolves:**

| file | loss means | placement |
|---|---|---|
| **profile lock / X-input lease** | a lock is missing ⇒ the next acquire re-creates it, and a lost lease is **released**, which is safe | ✅ **INSIDE** |
| **`isolation-accept.json`** | an accept is missing ⇒ ⛔ **silently re-grants** what it recorded a decision about | ✅ **BESIDE** |

⭐ So `ccew` was right about `isolation-accept.json` and `cgwc` was right about the
lock, and neither generalises to the other file. ⚠ **Do not generalise either.**

⚠ **And what a SIBLING actually costs, measured:** a sibling sits in whatever directory
the profile's parent happens to be — which for real profiles on one machine means
`~/priv/` for some and `~/.config/` directly for others, across ~20 Chromium-shaped
profiles most of which are **not ours**. ⇒ Sibling files scatter into directories we do
not own, and a sweep for them degenerates into *"any file next to anything
profile-shaped"* — which is the *"directories named after a tool"* sweep that §1 of
`btg4` rejects as **worse than blind**.

⚠ `ccew`'s objection survives as a **requirement, not a veto**: Chromium may delete
unknown files during profile repair, so an inside lock must be **reconstructible** and
its absence must never read as permission. Chromium's own `SingletonLock` is precedent
that the inside is not exclusively Chromium's.

⚠ **AND ONE ARGUMENT NEITHER CRITERION ANSWERS** *(`fetlife`, measured)*: the profile
dir is **rw bind-mounted into the container**, so an inside lock is **writable by the
very process it arbitrates** — and across machines the container runs as a **different
uid**, which they hit this week (`Permission denied` ⇒ chromium `Exited(133)`). ⇒ On a
remote target an inside lock may be a file **the arbitrating process cannot write at
all.** That is a *writability* objection, not a *loss* objection, so
reconstructibility does not dispose of it.

### ✅ AND THE QUESTION DISSOLVES — placement was never the correctness axis

**`cgwc` reframed it and I think they are right.** A wipe that destroys a profile under
a live holder is **a bug at any placement**: inside, the lock vanishes and nothing false
is asserted; beside, the lock survives and asserts ownership of data that is gone. Each
is bad differently and **neither is fixed by moving the file.**

⇒ **The rule is not where the lock lives but WHO MAY DESTROY:**

> ⛔ **A wipe must ACQUIRE the lock before destroying, and refuse if it cannot.**

⭐ **And this repo already has the precedent twice**, which is what makes it a pattern
rather than a new rule: `ttl-gc` never deletes, and log-rotation's *"a file you did not
create is not yours to delete"*. An unsynchronised destroyer cannot be made safe by file
placement, and this is the third instance of the same shape.

⇒ **For MOVE, the answer is identity, not path:** if the record carries a **profile
identity checkable against the profile actually present**, then a moved-away lock is
**self-invalidating**, and a new profile created at an old path **cannot inherit a stale
claim**. ⭐ With both rules in place, placement becomes a **tidiness** question rather
than a correctness one — which is why the two strong arguments above could both be
right without either being decisive.

* **`<target>`** — the target name from `btg4` §3/§4.
* **`<profile_id>`** — `btg4` §2's **opaque** id.
* ⛔ **No `C.PROJECT` anywhere in the path.** That is the defect.
* ⚠ **`profile_id` must resolve to ONE concrete path outside every per-tool cache
  namespace**, or the indirection re-introduces the split it removes (`fetlife`).

⚠ **CORRECTED — I OVERSTATED THIS, AND THE LANE SAID SO.** I had called
`perplexity`'s lock *"a working existence proof that target-keyed locking is
implementable"*. It is **target-keyed WITHIN ONE TOOL**: the lock lives under **that
tool's own cache directory**, so a second tool locking the same browser takes a
different file and never contends — **the same failure reproduced in §1(a), one level
up.** ⇒ It proves per-tool target keying, **not cross-tool arbitration**, which is
the thing §6(b) needs. *(Their filename prefix `port-` also shows the mutex API still
assumes its key is a port.)*

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

⚠ **PROPOSED BY ONE LANE, UNIMPLEMENTED — corrected at their insistence.** I had
cited this as prior art. Today `perplexity`'s `connect()` attaches to a **stated**
local port and checks engine kind; the label-resolved, ephemeral, stdin-driven tunnel
is **written down as a follow-up and nothing more.** ⇒ Do not read what follows as
something that exists.

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
   ⛔ **And TWO live legacy holders is not an edge case, it is the DESIGN** *(`linkedin`)*:
   the legacy name is **per-tool**, so on a shared profile two tools hold two locks that
   are both valid and both live. ⇒ **Which wins? NEITHER.** Two live holders on one
   profile means the invariant is **already violated**, and the honest action is to
   **refuse and name both**. ⚠ A tie-break rule would be a mechanism for *resolving* a
   state that should be impossible, and the first time it fired it would resolve it
   wrongly.
   ⚠ **And note what this does to clause 1:** with per-tool legacy names there is no
   single legacy name to read. The reader must **enumerate every `.{tool}.lock.json` it
   does not own** — which is a **glob, not a name**, inside one known profile directory.
   ⇒ That is compatible with `ccew`'s *"never glob `profiles/*`"* rule, which forbids
   globbing **across** profiles; this globs **within** one configured profile path. The
   distinction has to be stated or the two rules read as contradictory.
3. **A legacy lock that cannot be read is UNKNOWN ⇒ refuse** (§2).
4. **Write only the new name.** Never write both; two lock files for one resource is
   `t2wf` by construction, and the moment they disagree neither is authoritative.
5. ⛔ **NEVER STOP READING THE LEGACY NAME** *(`cgwc`, strengthening this clause).*
   *"Read both during migration"* implies an end date, and **the end date is governed
   by the slowest lane on the machine** — which base cannot know and no lane can
   observe. ⇒ Reading an extra filename costs one `stat`; getting the window wrong
   **silently removes mutual exclusion**. So there is no release that stops reading it.

### ⚠ And migration state is per-MACHINE, not per-repo

*(`cgwc`.)* During any window, one box can run a lane on the **old** name and another
lane on the **new** one simultaneously. They write different files and do not see each
other ⇒ **the very period in which you are being careful is the period with NO mutual
exclusion.** That is the strongest argument for (5): the window cannot be closed by
coordination between repos, because the state is not in a repo.

⚠ **Also: for at least one lane, adoption is a SHIM, not a migration.** `cgwc` carries
its own pre-factory copy of `profile-lock` (its own file, never loading base's) whose
**export surface is identical** to base's factory return, and whose `lockPath()` yields
**the same path** given the same constants. ⇒ So they are the same module at different
**ages**, not forks, and ow9k reaches that lane only when it adopts. ⭐ Which is also
why they will pin the corrupt and `schemaVersion: 99` cases in their suite **before**
adopting: those cases are currently uncovered, so *"tests still pass"* would be
evidence of nothing.

### ⭐ And it must be proven with a PLANTED OLD-FORMAT LOCK

*(`webctl:mgr`'s instruction, and `ccew`'s rule applied: a refusal test needs a
positive control on the same fixture.)*

⛔ **ENUMERATE THE ARMS FROM THE REASON CODES, NOT FROM FOUR SHAPES** *(`substack`).*
The module already distinguishes **eight**: `remote · unknown · container ·
container-missing · container-stopped · no-pid · pid · pid-dead`. My proposed "fifth
state" (a lock left by a removed container) **already exists** as `container-missing`,
and the reboot case is `container-stopped`. ⇒ A fixture set enumerated from shapes
drifts from an implementation enumerated from reasons.

⭐ **And the state to ADD is not a lock shape but a lock READING: `reason:'unknown'`**
— the same file, two callers, opposite verdicts, decided by dependency injection
rather than by any fact (§2d). It fails closed, so it is safe; and it is precisely the
state that makes guest ownership-detection impossible.

✅ **More is offline-testable than I credited** *(`substack`)*, because `dockerInspect`
is an injectable async: planted files plus a stub cover corrupt, future-schema,
foreign-hostname (⇒ HELD, `remote`), `{running:true}` (⇒ HELD), `{exists:false}` and
`{running:false}` (⇒ takeover), and the test process's own pid (⇒ HELD, live and local).
⚠ What is genuinely **not** offline-testable is narrower than *"two tools contend"*: it
is **cross-HOST** contention, plus anything needing a real container lifecycle or X
server. Same-host two-process contention is already covered by a shipped concurrency
test.

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
5. ✅ **ANSWERED — no lane relies on the current fail-open.** `ccew`, `cgwc`,
   `substack` and `perplexity` all answered **no**, each from measurement, and all four
   asked for the refusals. ⚠ But `substack` distinguished a case I had conflated: they
   **do** rely on a **dead-holder takeover** (§2b), which is not the same thing.
   ⛔ And `perplexity` measured **three rows that still ACQUIRE** in their own
   per-invocation lock — corrupt metadata with the pid file removed, future-schema with
   the pid file removed, and, worst, **valid metadata naming a LIVE pid alongside a
   corrupt pid file ⇒ acquired**. That last one *ignores metadata it could have read*,
   which is the same shape as §1(c) reached from the opposite direction.
6. ✅ **ANSWERED — there is no fifth SHAPE; there are eight REASONS** (§5), and the
   state worth adding is a **reading**, not a shape: `reason:'unknown'` (§2d).
7. ⛔ **NOW THE MAIN OPEN QUESTION: placement** (§3). Two lanes, two strong arguments,
   opposite directions, and each placement decouples the lock from the truth in a
   different failure. Needs a rule for the profile **moving** and for the profile being
   **wiped**, not a preference.
8. **OPEN: how does a GUEST establish liveness at all** (§2d)? Every refusal in §2 is
   reachable by a guest; `reason:'unknown'` is not escapable by one, because it cannot
   inject the inspector. ⇒ Either the claim carries enough to decide, or a guest can
   never learn the owner is gone — which would make §4's posture undecidable in exactly
   the case it exists for.
