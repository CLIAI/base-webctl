# `contract-harness.mjs` — dev notes

## The three defects it exists for

Each was found by running something, none by reading, and each was in a *copy*:

1. **A re-vendor check its own documentation satisfied.**
   `grep -q "$BASE_DIR" lib/client-config.js` matched the vendor path inside the
   shim's explanatory comment, and returned **PASS across a genuine re-vendor.**
2. **`[ "$rc" = "2" ] && { … }` as an arm's last statement** returns 1 under
   `set -e`, so a **green suite exits 1**. Invisible in the lane it was copied
   *from* — that lane had no suite, so `rc` was always 2 — and it fires on the
   copier's first passing test, reading as *"the tests broke the base adoption"*.
3. **Naming the pin from the worktree rather than the committed gitlink.**
   4 of 5 contracts. Worst under the release gate, because the gate is the thing
   that makes the two differ.

## The carve-out has now been keyed wrong four times, by four people

Each fix corrected the previous keying, in the same file or its copies. Measured
2026-09-26: a lane added the gitlink-divergence check with **zero** occurrences
of `WEBCTL_DECLARED_PIN` and ten of `WEBCTL_BASE_DIR`, and **blocked a release**
when the gate's swap tripped its own new check.

⇒ That is the argument for the library rather than another rule: the rule has
been written down four times and re-derived wrong four times.

### ⭐ And the likely CAUSE, which is worth more than the count

One lane deferred reading `WEBCTL_DECLARED_PIN` *"until I bump, since v0.5.0
does not export it"*. ⛔ **It is not exported by the pinned library at all** —
the gate process sets it in the contract's environment at runtime, so a lane on
any pin receives it.

⇒ So the variable looked like part of base's API, subject to the adoption
ordering every other base capability has, and was deferred on that reasoning.
**Gate-provided env is independent of the consumer's pin**, and saying so is
cheaper than counting the mis-keyings. *(webctl:mgr's diagnosis.)*

## Controls

Every check is exercised in **both** directions against a hermetic fixture repo
built with real `git` objects — not a mocked filesystem, because the defects are
about what `ls-tree` and `describe` actually return.

⭐ **The re-vendor control replays THE SHAPE THAT SHIPPED**: a local file that
defines the surface while mentioning the vendor path only in a comment. *A
synthetic mutation proves a check can fail; replaying the shape that shipped
proves it fails on the thing that happened.*

⚠ And the pin control asserts the carve-out does **not** fire when
`WEBCTL_DECLARED_PIN` is merely *set* to the value already checked out —
otherwise the skip triggers on every gated run and the check is decorative.

## ⛔ `gate-probe`'s first draft could not fail — in the tool built to prevent that

The probe asserts that `pin` declines a verdict inside the gate's swap window.
The first draft established "a swap is in effect" like this:

```js
const swapped = declaredEnv !== worktree;   // ⛔ the SAME comparison judgePin makes
if (!swapped) return noVerdict(…);
const v = judgePin(repo, sub);
if (v.code !== EXIT.noVerdict) return fail(…);   // ⇒ UNREACHABLE
```

`judgePin` decides "swapped" by that same comparison, so whenever the probe's
guard let it through, `judgePin` was guaranteed to decline. **The FAIL branch
could not execute.** The probe would have reported pass forever, including across
a real regression in the arm it exists to watch.

⭐ **The fix is structural, not a stronger assertion: take the PRECONDITION FROM
A DIFFERENT SOURCE than the claim.** The gate knows it performed a swap, so it
exports `WEBCTL_GATE_SWAPPED=1`, and the probe's statement about `judgePin`'s own
comparison becomes falsifiable. The mutation test — gate reports a swap while
declared equals worktree, so `judgePin` returns a real verdict and the probe must
FAIL — **could not even be written against the first design.**

⇒ Generalised in `test-checks-that-cannot-fail-k3wn`: *a guard and a claim that
read the same input cannot disagree.*

### Proving the GATE blocks, not just that the probe can fail

The probe's own unit tests cover its FAIL branch. That leaves the WIRING
untested — so the gate's blocking path was itself verified by sabotage: set
`swapped = false` in `judgePin`, commit locally, run `--against-head`. Result:
`ok=0 defect=4`, exit 1, `BLOCKED`, attributed to base rather than to the four
consumers, each quoting the wrong verdict verbatim — *"declared gitlink 0c47272
is tag v0.13.0"*, a true sentence about the wrong subject. Then reset.

⚠ Note the ordering trap: the gate **refuses a dirty base tree** (exit 2, and
correctly so — consumers would be tested against a commit that does not exist),
so sabotage has to be committed locally before it can be exercised. The first
attempt measured nothing and reported exit 2, which is not the same as "the gate
did not block".

## ⛔ `no-revendor` could not see the case it exists for (generation 1 → 2)

`readdirSync` on both trees, plus a filename-equality match. **Half of base's own
lib is nested** (12 flat, 12 under `lib/browser-location/`), so `profile-lock.js`,
`mounts.js` and `chromium-docker-xpra.js` were never in the comparison set at all.

Measured with three planted copies — nested→flat, into a subdirectory under a new
name, and renamed in place. **All three reported `pass`**, with the confident reason
*"3 local file(s) examined; none shadows a base module"*. It even under-counted: one
of the four local files was in a subdirectory and was not examined.

⇒ Fixed by walking both trees recursively and matching on **normalised content**
(comments stripped, whitespace collapsed) as well as on name. Content matching is
what makes a rename or a move detectable; the name match is kept for a copy that was
edited after being taken.

⭐ **Three guards on the check itself**, since this is a check about checks:
* zero base modules discovered ⇒ **FAIL** (the comparison set is gone, which is not
  a clean bill);
* zero local files examined ⇒ **FAIL** (already there from generation 1);
* **the normaliser must DISCRIMINATE** — if distinct base modules collapse to fewer
  than two hashes, the detector is broken and no conclusion is offered. That is the
  silent direction: a degenerate normaliser would shrink the comparison set without
  any symptom.

⚠ **Stated limit:** an **edited AND renamed** copy still escapes. Catching that
needs content shingles rather than whole-file hashing. The PASS reason says so, so
the limit is published rather than implied.

### How it was found, which is the reusable part

`webctl:mgr`'s template survey reported it **and said it had not been re-measured**,
asking for verification before action. ⇒ That instruction is why it arrived here as
three concrete planted copies with an exit code, rather than as an adopted
description — and the re-measurement found it was **worse** than reported, because
the nested half of base's lib was missing from the comparison set entirely, which
the report had not identified.

## ⛔ A generation number renders TWO STATES IDENTICALLY

*(Raised by `linkedin` as a consistency point against this repo's own spec, not as a
new idea.)*

`HARNESS_GENERATION` certifies *"this consumer's copy has property P"*. ⇒ But a
consumer that **never had the defect** and a consumer that **found and fixed it**
record the **same `2`** — and those are different facts. Only the second implies that
somebody **verified** the repair.

⚠ **So the field cannot answer the question a sweep will eventually want:** *which
lanes actually ran the planted-re-vendor check, and which inherited a number?* One
lane has already planted both a nested and a top-level re-vendor against its own
contract and watched them fail by path — and its `2` will be indistinguishable from a
`2` copied from a template.

⭐ **This is the same shape as `xrl4`'s own `pass=0` under an `OK` summary: a field
that renders two states identically.** The generation marker was introduced to fix
exactly that kind of blindness, and it reproduces it one level up.

⇒ **Cheap now, expensive at six lanes:** record **HOW** the generation was
established, not only that it was — e.g. `{generation: 2, established: "verified" |
"inherited"}`. ⚠ Not yet implemented, and deliberately not rushed into the v0.16.0
tag: changing what a contract records is a change to what every lane writes, and it
should land with the ownership work rather than alone.

## ⛔ `isolated` — a mutant does not refuse

*Incident, 2026-10-02 18:43 UTC (verified with `docker inspect` by `webctl:mgr`):* a
consumer lane's mutation control planted "the default port is a location". The arms
ATTACHED to the real signed-in browser listening on the host's loopback, closed its last
tab, and Chromium exited. Correct code refuses, so the green runs were safe all along. **A
mutant does not refuse — that is what makes it a mutant** — so every mutation control that
perturbs target resolution can reach a live browser on the same host. The family's
sandboxes isolated HOME, CWD, env and PATH. Not the network.

### The measurement it rests on

Measured on the operator machine by the `webctl:base` lead, and again while building this:

```
unshare -rn sh -c '…'                works unprivileged
inside: connect 127.0.0.1:<host port> "Network is unreachable" (lo is DOWN in a fresh netns)
inside: ip link set lo up            works as mapped root
inside: /proc/self/net/dev           lists ONLY lo
inside: /proc/self/net/tcp           no LISTEN rows (host has dozens)
```

⇒ Bringing `lo` up turns *unreachable* into *refused* — local fakes and stubs work again,
and the host's listeners are still absent, because they live in a different namespace.

### ⭐ It asserts the property, not `unshare`'s exit code

The inner half runs **inside** the namespace and refuses to start the command unless:
the netns id differs from the caller's; the only interface is `lo`; no TCP listener is
visible; `lo` comes up and a self-connect works. ⇒ A fake `unshare` that just runs its
arguments is caught (a test plants one), and calling the inner verb directly on the host
refuses (the interface check fails), so it is not a bypass.

⚠ The refusal reports a COUNT of extra interfaces, never their names: interface names
describe the host, and refusal lines get pasted into issues.

### Status channel on fd 3

The outer half cannot tell "isolation refused" from "the command exited 1" by exit code
alone. So the inner half writes `started` — or `fail <reason>` — on an extra pipe (fd 3),
and closes it before spawning the command so the command does not inherit it. No
`started` ⇒ FAIL, reported once, by the outer half; the command never ran.

### Sabotage (2026-10-03)

`isolated` changed to run the command directly (`sh -c 'echo started >&3; exec "$@"'`, no
unshare) → the QA arm failed with *"the host fake was reached from inside isolation"*
(1 connection), and both fail-closed arms that depend on the namespace failed too.
Restored → 15/15.

### Second incident — and why the namespace comes FIRST

A lane's mutation control navigated a real signed-in browser's only tab. ⇒ **A port pin
cannot stop a mutant that restores a LITERAL port**: `sandbox-port` and `guard-live-port`
act on the port the lane NAMES, and a mutant that hardcodes the default never asks. Only
the namespace removes the host's listeners regardless of which number is dialled. Hence
the README's order: `isolated` → `isolation-check` as its precondition → `guard-live-port`
as the fallback only where unshare is unavailable.

### `isolation-check` asserts the EXACT errno (from `substack`'s isolation work)

"The connect failed" is not the property. In a namespace whose `lo` is DOWN the connect
fails `ENETUNREACH` — which looks like isolation — and then every in-namespace fake fails
for the wrong reason. Measured: with lo down a LISTEN on 127.0.0.1 still succeeds, but a
connect to it fails `ENETUNREACH`, so the control must CONNECT, not merely bind. ⇒ PASS
requires `ECONNREFUSED` for each named port, a reachable control, and the kernel proof
(without it, a host on which the browser merely happens to be down right now passes).

### "Already inside" is read from the KERNEL — three facts, each closing a measured hole

| proof used alone | beaten by | measured |
|---|---|---|
| env marker (`…_IN_NETNS=1`) | setting it on the host | a lane's whole suite ran on the host network |
| recorded host netns id ≠ current | fabricating the id | fleet manager |
| + uid_map not identity | `unshare -r` WITHOUT `-n` + a fabricated id that differs | while building this: both facts pass, on the host network |
| + only `lo` in /proc/self/net/dev | the OLD `unshare -rn` itself: all three pass, every host PATH socket answers | 2026-10-03, below |
| + mntns ≠ recorded `WEBCTL_HOST_MNTNS` | `unshare -rnm` + a fabricated id | while building this |
| + our `webctl-isolated` tmpfs on TOP of /run, /tmp in mountinfo | — | the fact is about the SOCKETS; "a tmpfs at /run" is a proxy (the host's is one) |

A marker whose proof fails is refused with exit 2 before anything runs. The refusal
names every failed fact (counts, never interface names).

### ⛔ No host UNIX SOCKETS either (2026-10-03)

The `webctl:base` coordinator measured that `-n` does not cover PATH unix sockets: inside
`unshare -rn`, `curl --unix-socket /var/run/docker.sock` was answered. ⇒ `-rnm`, a
`webctl-isolated` tmpfs over /run, /tmp (and a real /var/run), keep-binds, a residual
connect test, an env scrub. Measured while building it, on one workstation:

```
host path sockets in /proc/net/unix   307
  answering on the host               220 CONNECTED
  answering inside `isolated`           0   (241 ENOENT, 60 ECONNREFUSED, 6 EACCES)
/proc/<host-pid>/root/… from inside   EACCES (ptrace-mode check across the userns)
```

* **Staging order.** /run first; each kept path is `--rbind`-ed to `/run/.webctl-keep/<i>`
  while the old /tmp is visible; then /tmp; then the skeleton is recreated and each staged
  mount `--move`-d back. rbind, not bind: a subtree with LOCKED child mounts (inherited
  from the parent userns) refuses a plain bind.
* **⛔ The cwd leak.** The inner node inherits its cwd as a reference to the OLD directory,
  and so does the command: `ls ../<sibling>` from a cwd two levels below /tmp listed the
  unmasked /tmp. ⇒ `process.chdir(cwd)` by PATH after masking. ⚠ The first test of this
  used a cwd ONE level below /tmp and the no-chdir mutation SURVIVED: there `..` is the
  dentry the new tmpfs is mounted on, so the walk crossed INTO the new /tmp. Test fixed.
* **The residual test** connects to every listed host socket not under a `--keep` —
  stream sockets to a DGRAM/SEQPACKET socket give `EPROTOTYPE`, which is NOT treated as
  unreachable, so those are covered too. A connect to /dev/null bound over a socket is
  `ECONNREFUSED`. Only `--keep` exempts: an implicit keep (cwd) is not test-owned enough —
  `cwd = $HOME` would otherwise exempt the ssh ControlMaster.
* **The $HOME guard reads passwd, not `$HOME`.** `os.homedir()` honours `$HOME`, so the
  `--scratch` gate's throwaway HOME inside its scratch dir made `--keep <scratch>` look
  like "contains the home directory". Measured with the gate's layout; fixed.
* **Sabotage, each run against the test file:** no /dev/null cover → the kept-cwd socket
  test fails (CONNECTED); no env scrub → env test fails; no tmpfs fact → the old
  `unshare -rn` nesting test RAN; no re-chdir → keep-binds `UP` fails; no /tmp mask →
  unkept-/tmp test fails; no keep-binds → keep-binds fails; exemption ignored → `--keep`
  test fails. Restored → all green.

### ⛔ The home directory is READ-ONLY (2026-10-03)

The coordinator `webctl:mgr` measured that, with the network and the sockets gone, the real
home was still writable from inside — profiles under `~/.cache/<tool>`, `~/.config/webctl`,
`~/.ssh`. A mutant restoring a literal path needs no network. Measured while building it:

```
inside unshare -rnm: rbind H H; remount,bind,ro H          create in H      EROFS
  + bind <dir under H> onto itself; remount,bind,rw         create there     ok
locked nosuid,nodev mount (inherited): remount,bind,ro      OK (util-linux 2.42 keeps the flags)
top-only ro remount of an rbind with a tmpfs submount       touch in submount SUCCEEDED
  + remount the submount too                                EROFS
mount --move onto a directory of a ro tree                  OK
```

* **Order** (`maskSocketDirs`): cover /run → **stage the keeps** (copies of the untouched
  tree, host modes and submounts intact) → **rbind each root onto itself, remount it and
  every reachable submount ro** → cover /tmp → move the keeps back on top, outer first,
  remounting a read-only keep (base's root under /tmp) ro right after its move — before an
  inner writable keep lands on it.
* **Reachable** (`reachableMountsUnder`, exported for the unit test): start at the bottom
  mount AT the root, follow each same-path stack to its top, recurse into children, skip a
  child that a sibling mounted later on an ancestor path shadows. The ORIGINAL submounts
  (beneath the new rbind) descend from a different parent and are never selected. Octal
  escapes (`\040`) in mountinfo are decoded.
* **Roots are computed on the HOST side.** Inside the user namespace we are uid 0, and
  `os.userInfo()` answers root's home — the inner half gets the roots in the fd-4 plan, the
  nested proof gets them from `WEBCTL_RO_ROOTS`. Measured: the submount probe's outer
  `unshare -r` made the harness protect `/root`, hence its second userns mapping back to the
  caller's uid.
* **Protected roots**: the passwd home, plus the real path of `.ssh`, `.gnupg`, `.config`,
  `.cache`, `.local`, `.mozilla`, `.pki` when one symlinks OUT of home. A root containing
  /run or /tmp (home = `/`) is refused; a root under them is dropped (the mask hides it).
* **Writable vs read-only keeps.** cwd, `$HOME` under /tmp and `--keep` are writable;
  base's root, node and an absolute command are read-only — **under /tmp too**. Decided for
  base's root because the release gate runs every consumer against ONE base checkout (and it
  is the harness's own code); base's own suite has cwd = its root and is unaffected. Dedup:
  a keep inside a writable keep is covered; a writable keep inside a read-only one gets its
  own mount on top.
* **Refusals.** A cwd containing the home: **was not refused before** (only `--keep` was) —
  now FAIL, cwd `/` included. `throwawayHome()` never returns something containing the
  passwd home.
* **Not covered by `ro`: unix sockets.** `connect(2)` checks write permission on the inode,
  not the mount's ro flag, so the residual socket check still matters under home.
* **Nesting fact** uses `access(W_OK)` = `EROFS` on each recorded root rather than a
  mountinfo walk: it asks the exact question through path resolution; the full submount
  sweep needs the writable keeps, which only the inner half knows.
* **npm** (12.0.2): `npm test` / `npm install` under the ro home: rc 0, rc 1 propagated;
  the debug logfile is skipped (EROFS), a one-line notice on error. No change needed.

**Sabotage, each run against the test file, each red, restored → green:** ro step off +
read-back off → the home arm created the file (and its `finally` removed it); ro step off
alone → refused by the read-back; top-only remount + read-back off → submount arm `ok`;
top-only alone → refused by the read-back; no re-chdir → the `..` arm — **which first
SURVIVED**: from a cwd one level below home, `..` is the home dentry, now a mount point, so
the walk crossed into the ro mount (the /tmp keep-bind test's trap, again). Moved two
levels down; red. Base root writable → its arm red; no recursion into submounts → both
logic units red; cwd-contains-home unrefused → red; keeps not realpath'd → the symlink arm
red; no note → red; no nested home fact → the previous-`isolated` nesting arm red.

### ⛔ The command held EVERY capability — and could undo every mask (2026-10-03)

*Measured by the final review:* inside `isolated`, `id -u` 0 and CapEff `000001ffffffffff`.
`umount <cwd>/m2.sock` (the /dev/null cover) and `umount -l /tmp` took both probe sockets
from ENOENT/ECONNREFUSED to CONNECTED; the same root could `remount,bind,rw` the ro home.
CAP_DAC_OVERRIDE also read a chmod-000 file — a consumer's `EACCES` test went false-red
only under the gate.

⇒ `privilegeDrop()`: `setpriv --no-new-privs --bounding-set=-all --inh-caps=-all
--ambient-caps=-all --` before the command, on the fresh AND the nested path. Measured:

```
inside, after setpriv          CapInh/Prm/Eff/Bnd/Amb 0, NoNewPrivs 1
umount -l /tmp                 "must be superuser to unmount"
mount -o remount,bind,rw <H>   "permission denied", rc 32
chmod-000 file                 EACCES (raw `unshare -r`: readable)
setpriv --bounding-set=-all    "Operation not permitted" when ALREADY capless (needs
                               CAP_SETPCAP) ⇒ passed only while CapBnd is non-zero
nested `unshare -rm` (capless) "write failed /proc/self/uid_map: Operation not permitted"
nested `unshare -Um`           CapEff 0; `umount -l /tmp` EINVAL
nested `unshare -rm` WITH caps `umount -l /tmp` → "not mounted": inherited mounts LOCKED
```

* **The drop is asserted, not trusted.** The prefix runs node once to print its own
  `/proc/self/status`; every CapXxx must be 0 and NoNewPrivs 1. A missing setpriv and a fake
  one that execs its argv are both tested refusals.
* **Last, after every mount**, just before `started`: the inner half itself needs the caps.
* **Sabotage:** drop removed → CapEff arm, `umount -l /tmp` arm, chmod-000 arm, both
  fail-closed arms red. ⚠ The remount arm first **SURVIVED**: it used `remount,rw`, a
  SUPERBLOCK remount that needs init-ns CAP_SYS_ADMIN and fails even with every namespace
  cap. The attack is `remount,bind,rw` (the per-mount flag); fixed, red. The nested-unshare
  arm survives the mutation **by design** — it tests mount locking, which holds with caps.

### ⛔ No PID namespace — host processes were signalable (2026-10-03)

*Measured by the final review:* `kill -0 <host pid>` from inside succeeded (same kuid, no
pid ns) and `/proc` showed every host process. ⇒ `unshare -rnm --pid --fork --mount-proc
--kill-child`. The inner half is now **pid 1** of the new namespace; when it exits, the
kernel SIGKILLs everything left in it — an arm's stray background processes included.

* ⛔ **`unshare --fork` BLOCKS SIGTERM in its own process until its child exits** (and
  ignores INT/QUIT: `SigIgn 0x6`). Measured: TERM to unshare never reached the child, which
  ran to completion. The old `forwardSignals(unshare)` would have silently stopped
  delivering — no test covered it (the brief assumed one did). ⇒
  `forwardSignalsPastUnshare`: signal unshare's CHILD (from
  `/proc/<pid>/task/<pid>/children`, else a `/proc` scan); none yet ⇒ SIGKILL unshare, and
  `--kill-child` takes the namespace down — nothing had started.
* **pid 1 ignores a signal it has no handler for.** So the inner half installs exit-on-signal
  handlers from its first line and swaps them for runCommand's forwarders only when the
  command starts. ⚠ That pre-command window has no test: it needs a signal inside a ~100 ms
  masking window, which is a race, not an arm.
* **Nesting fact 7:** `/proc/self/ns/pid` ≠ `WEBCTL_HOST_PIDNS`. Recorded, so fabricable —
  like the netns/mntns ids; the env-free facts carry the rest.
* **Sabotage:** no `--pid --fork --mount-proc` → the ESRCH arm red (the SIGTERM arm stays
  green: without `--fork` unshare execs, and the old path works); signals to unshare instead
  of its child → the SIGTERM arm red (`TIMEOUT` after 10 s — the trapper is bounded so a lost
  signal cannot leave an orphan); nested pid fact off → its nesting arm red.

### The import guard

The dispatch ran at module top level unconditionally, so importing the file would have
dispatched on the IMPORTER's argv (usage + `process.exit(3)` at best, a real verb at
worst). Nothing in the repo imported it yet, so this was latent. ⇒ `isEntryScript()`
compares realpath(argv[1]) with realpath(this file) — realpath on both, because argv[1]
keeps a symlinked path while `import.meta.url` is resolved. The dispatch body is
deliberately not re-indented, to keep the guard a two-line diff against concurrent edits.

### Known limits

* **The home is whatever passwd says for the CALLER's uid.** Run from inside another user
  namespace that maps the caller to 0 (a bare `unshare -r`), that is root's home, and the
  real one stays writable — measured with the submount probe's first draft. No passwd entry
  at all ⇒ nothing is protected. A profile directory configured OUTSIDE home (and not via a
  symlinked dot-dir) is not covered either.
* **`WEBCTL_RO_ROOTS` is recorded input.** `[]` would satisfy the nested home fact; the
  other five facts still require being inside a real masked namespace, so it does not let
  the host pass as "inside".

* **Mapped root, no capabilities.** The command runs as uid 0 inside the namespace, with
  every capability set empty (below). A tool that refuses root (Chromium without
  `--no-sandbox`) refuses here; a port below 1024 cannot be bound.
* **`ip` or `ifconfig` is required** to bring `lo` up; node has no ioctl. Absent → FAIL.
  So is **`mount`** (util-linux, the package `unshare` comes from).
* **Sockets the list misses.** One created on the host AFTER start-up (still masked if it
  is under /run or /tmp); ones bound in another network namespace (not in this netns's
  /proc/net/unix). A keep under /run is refused rather than supported.
* **Linux only.** No unprivileged netns elsewhere ⇒ FAIL, never a host run. The tests
  SKIP with a named reason where userns is unavailable.
* **Generation unchanged (4).** These verbs are additive: no existing verdict changes
  meaning, so a bump would send every lane looking for rot that is not there (the
  `gate-probe` precedent).

## Deliberately not here yet

* **Exercisable under the gate.** The pin check's swap arm is the one path that
  only the release gate produces on demand; it is currently controlled by a
  forged fixture. ⇒ *The forged control is the only one you can schedule; the
  accidental one is a gift.* Running the harness's own checks **during** an
  `--against-head` run would convert the gate into a control, and that is the
  next step rather than a shipped property.
* **The ESM/CJS arm from a consumer.** base uses this natively; a CJS lane
  invokes it as a subprocess, so there is no loader question — but no lane has
  run it yet.
* **A floor the GATE enforces, so a lane cannot forget it.** `require-generation`
  fails closed on old harnesses, but only a contract that *calls* it is protected,
  and base cannot make a lane call it. The gate is the one piece of base that is
  never downgraded (it runs from base HEAD). It could open a **downgrade window**:
  point each consumer at a generation-2 tag, run its contract, and require a FAIL
  whose reason names `require-generation`. A green there means the lane has no
  floor. Not built yet: a consumer's suite on an old base can fail for unrelated
  API reasons, so the probe must judge the *reason*, not the exit code, and that
  needs the JSONL `check` field rather than prose.
