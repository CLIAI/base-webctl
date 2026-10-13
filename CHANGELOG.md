# Changelog — base-webctl

Consumers pin base by **tag**. This file is what you read when deciding whether
to move a pin, and it states the LIMITS of each release as prominently as its
contents — a release note that lists only what was fixed lets a reader conclude
they are safe on the strength of a headline.

> ⚠ **A checkout of an older tag does not contain this file's later entries.**
> Read it on `master` (or on GitHub), not from inside your pinned submodule.

## ⛔ Before tagging: write down what the headline does NOT cover

An accurate headline is not a sufficient one, and this has now happened **three
times running** — each caught by a reader rather than by the author:

* **v0.6.0** — "the html5 port collapse". True, and it fixed **1 of 101**
  affected CDP ports; the other 100 needed v0.7.0.
* **v0.9.0** — "the CDP command client". True, and it was the **enumeration
  half only** — unable to replace the hand-rolled clients it was cut to retire.
* the `LWC_CHROMIUM_PROFILE` hazard table — accurate per consumer and **carrying
  no revision**, so it could not be checked and could not be wrong detectably.
  It shipped ranking the most-exposed lane as safe.

The pattern is not carelessness: a true headline reads as complete, so nobody —
including its author — looks for the part it omits.

⇒ **So the release step is: state the limit in the entry, before cutting.** What
is in, what is deliberately NOT in, and what a consumer therefore still cannot do
on this version. If a table describes other repos, **stamp each row with the
commit it was observed at** — in a fleet where lanes are actively fixing, an
unstamped observation is presented as a standing fact and rots within hours.

## v0.7.0 — 2026-09-02

⭐ **THIS IS THE RELEASE WHERE THE TCP PORT OVERFLOW IS FIXED.** The v0.6.0 entry
below says the html5 collapse addressed **one** of the 101 affected CDP ports; the
other **100** (`65436..65535`) are fixed *here*. Until this tag there was no
tagged release containing that fix, so a consumer at or above `65436` had the
caveat and no remedy.

### Fixed

* **An out-of-range derived xpra-tcp port is refused, not returned.** The defect
  was never the arithmetic — it was that the resolver returned impossible ports
  with `sources:{tcp:'derived'}`, indistinguishable from a valid answer, so the
  failure surfaced later as an unrelated bind error. Now throws, naming the
  affected window and both remedies. An explicit `xpraTcpPort` still bypasses
  derivation, so a high CDP port stays usable.

### Added

* **`lib/url-marking.js`** — counterparty-URL detectors and the two record
  projections, contributed by the chatgpt lane. Field selection is an explicit
  **required** argument; the scan-everything mode is named
  `scanAllStringsUnsafe` so choosing it is a decision rather than an omission.
  Two consumers were carrying local copies and can now shim it.
* `scripts/assert-pin-compat.mjs` — refuses a base pin that cannot serve the
  consumer's configured port. Probes capability, not version.

### Deprecated

* `PORT_OFFSET_HTML5` — ⚠ **removal RETARGETED from v0.7.0 to v0.8.0.** The note
  in v0.6.0 said it would go here. It has not, deliberately: v0.7.0 landed one
  day later and **no consumer had adopted v0.6.0**, so removing now would honour
  the letter of the deprecation while giving an effective window of zero
  adopted releases. Verified before deciding that no consumer reads the value
  (three comments, one QA name-list), so the removal stays cheap whenever it
  happens. It is still **DO NOT USE**.

### Gate (affects consumers only via base's release process)

* A dirty submodule pointer is a **FAIL** — a consumer whose checkout disagrees
  with its index produces a result about a base it does not declare.
* A dirty working tree is a **SKIP** with a named reason, in every mode.
* `--against-head` announces swaps with a PID marker, so an in-flight swap reads
  as busy and an abandoned one reads as the incident it is.

## v0.8.0 — 2026-09-02

**No migration required.** v0.6.0's `--html=on` entrypoint migration still
applies if you are coming from v0.5.0.

### Added

* **`cfg.containerEnv` — caller-controlled container env** on the docker-xpra
  driver, as `{KEY: string|null}`. Absent means byte-unchanged. A string sets or
  overrides; **`null` REMOVES** a key the driver would otherwise set.
  * Deletion is in the contract for a reason: the container entrypoint adds
    `--remote-debugging-port` only when `LWC_CDP_PORT` is **set**, so "no CDP" is
    expressed by *absence*. An additive-only seam could never say it.
  * `DISPLAY` and `LWC_CHROMIUM_PROFILE` are **refused** at construction. They
    are correspondences with the netns/Xvfb wiring and the profile bind-mount
    computed in the same function — overriding either does not error, it gives a
    black screen or a browser writing where nothing is mounted.
  * Scope is the **chromium** container only.
* ⭐ **Portless mode** — a browser with no CDP, via
  `containerEnv: { LWC_CDP_PORT: null }`. The image always supported it; the
  driver set the variable unconditionally, so the branch had never been taken.
  * Five places treated CDP-unreachable as a fault, which made "no CDP was
    requested" and "CDP is down" the same observation. Bring-up, reuse and
    `healthCheck()` now use chromium liveness when no port was requested.
  * The CDP port is **not published and not pre-flight reserved**, and
    `cdpHttpUrl` is `null` rather than an address for a port nobody opened.
  * `inspect().cdpEnabled` states the mode explicitly.
  * A portless stack whose chromium **exits still fails**, with a message saying
    the failure is real rather than an unreachable port.

### Fixed

* `PORT_OFFSET_HTML5` is still deprecated and still **DO NOT USE**; removal
  remains targeted at a future release (see v0.7.0 for why it moved).

## v0.9.0 — 2026-09-02

> ⚠ **The copy of this file inside the `v0.9.0` TAG carries a WRONG version of
> the hazard table below** — it swapped two consumers and marked the most-exposed
> one as safe. Corrected here on `master`; the tag was not re-cut, because moving
> a published tag trades a documentation error for two people holding the same
> tag name with different content. **Read this table from `master`.**

**No migration required.** v0.6.0's `--html=on` entrypoint migration still
applies if you are coming from v0.5.0.

### Added

* ⭐ **`lib/cdp-client.js` — the CDP command client.**
  ⚠ **SCOPE CORRECTION: v0.9.0 shipped only the ENUMERATION half.** The entry
  below said "the CDP command client", which reads as the whole thing. It is
  accurate and partial: `openPage`, `closePage` and `navigate` are **NOT in
  v0.9.0** — 68 of the 237 lines it was extracted from, including the
  `/json/new` PUT-then-GET fallback, which appears four times in the original
  and zero times here. ⇒ **A consumer on v0.9.0 cannot use this to replace a
  hand-rolled client**; it must keep its own lifecycle code. Fixed in v0.10.0 —
  take that instead. If you are already on v0.9.0, keep your local lifecycle
  half and mark it NOT-YET-EXTRACTED rather than as a fork, so the next reader
  does not "reconcile" it against base by deleting behaviour base never had.
  * The session/transport half is substack-webctl's, carried over rather than
    rewritten — it runs in production. The target-discovery half is the
    claude-chrome-extension lane's rewrite of it.
  * `listPageTargets()` **preserves the existing per-site behaviour by name**,
    so adopting consumers change nothing at their call sites. ⚠ The
    implementation UNDER it was widened — if you rely on the page-only filter
    anywhere other than through that wrapper, check those places.
  * ⭐ `listTargetsViaBrowser()` is **authoritative**; `GET /json` is not. The
    HTTP list's membership has varied across Chromium versions and it does not
    reliably enumerate `service_worker` targets, so **asserting an absence on it
    yields a result indistinguishable from "not running"**. Use the browser
    endpoint whenever an absence would be read as a finding.
  * `listTargetsCorroborated()` reads both and **warns by default** when they
    disagree; silence requires explicitly passing `onDisagree: null`. An
    unreadable HTTP list is reported as *disagreement*, never as agreement.
  * **Deliberately NOT included:** an observer-only guard, per-axis target
    vocabulary, and a credential-method deny-list. The last is scoped to one
    repo's threat model and would break a wired consumer that legitimately reads
    cookies. A test asserts all three are absent from the public surface.

### ⚠ Consumer-side hazard worth acting on (base cannot fix this for you)

**`LWC_CHROMIUM_PROFILE` is BASE-OWNED. Do not default it downstream.**

base sets it on every run, so a downstream default is a **masked default** — a
code path that has never executed, which arms the moment base stops setting the
variable or changes its value. That is precisely how `XPRA_HTML5_BIND` behaved
before v0.6.0.

The failure mode is a **silently discarded login**: the browser writes its
profile to a path nothing is mounted at, so the session looks fresh and the real
one is still on disk, unreferenced. Nothing errors.

⚠ **Status below is a TIMESTAMPED OBSERVATION AT A NAMED COMMIT, not a standing
fact.** Three of the four consumers fixed this within hours of it being
reported — one of them *while this table was being written* — so an unstamped
version of it would already be wrong. Re-check at your own HEAD before acting.

Measured against each consumer's **HEAD**, 2026-09-02:

| consumer | at commit | bakes it as `ENV` | entrypoint read | status |
|---|---|---|---|---|
| claude-chrome-extension-webctl | `f38be2a` | **yes — 2 Dockerfiles** | `os.environ.get(…, default)` — **silent** | ⚠ **EXPOSED, both layers** |
| linkedin-webctl | `febba4b` | no | `require_env` ×2 (loud) | fixed |
| chatgpt-webctl | `686007a` | no | `require_env` (loud) | fixed |
| substack-webctl | `940fd6d` | no | `require_base_owned` ×2 (loud) | fixed |

Two independent layers can mask this — a baked `ENV` and a silent
`environ.get` fallback — and **neither is visible from the other**. Auditing only
Dockerfiles, or only entrypoints, gives a clean bill either way. Check both.

Three worked fixes now exist in the family; copy any of them. `require_base_owned`
is the strongest form: it names the ownership in the function that reads it.

## v0.10.0 — 2026-09-02

### Added

* ⭐ **The CDP client's PAGE-LIFECYCLE half** — `openPage`, `closePage`,
  `navigate`. **v0.9.0 shipped only the enumeration half** (see its entry), which
  meant the extraction could not actually replace a hand-rolled client. It can
  now; the surface is a superset of the client it was extracted from.
* Three behaviours in it are **environment knowledge, not style**, and a
  reimplementation gets all three wrong by default:
  * **reuse before minting** — an existing page target is reused; minting per
    operation leaks a tab per page (measured over a 220-page run);
  * **`/json/new` is a FALLBACK, tried PUT then GET** — ⭐ that endpoint is
    **restricted or disabled in some chromium builds**, so a client that mints
    first works on its author's machine and fails on someone else's;
  * ⛔ **only close the tab you minted** — a reused tab is the browser's own,
    frequently its only page, so closing it tears down the session the caller is
    standing on. `close()` encodes this.

## v0.35.0 — (unreleased)

**Headline: `isolated` gains its second backend: bwrap, a second namespace CREATOR judged by the same
arm table (ib4k §2a).** Pin it with `WEBCTL_ISOLATION_BACKEND=bwrap`, or reach it when unshare's probe
fails. It runs every row on the fresh, nested and stripped paths, with the same inner half, read-backs
and drop as unshare. Building it found a hole bwrap opens, mount propagation, now closed for every
backend. ⚠ **bwrap does NOT unblock a host that forbids user namespaces** (below): on no measured host
does bwrap run where unshare cannot. **Phase 3, the docker backend (ib4k §3b), does:** where both namespace
backends are refused, `isolated` runs on the local docker daemon, judged by the same rows, with six named
deviations. Harness, tests and an image recipe; no `lib/` change.
`HARNESS_GENERATION` is **9** (it was 7; v0.34.1 took 8 — see "For lanes").

### The bwrap backend (ib4k §2a)

* **What it is:** bwrap replaces only the fresh path's `unshare -rnm … --fork`, which makes the
  namespaces and the reaping pid 1. Everything inside is the same code on both creators: pid 1's bash,
  the `__isolated-inner` half (masks, read-only root, fresh `/dev`, sysfs, cgroup2, identity), every
  read-back, the privilege drop and the `__isolated-pid1` helper. bwrap's own mount flags (`--ro-bind`,
  `--dev`, `--tmpfs`, `--hostname`, `--setenv`, `--cap-drop`) are deliberately not used. They would be a
  second, weaker implementation: bwrap cannot make a fresh sysfs or cgroup2, and its `--dev` adds
  `core` and `console`.
* **argv:** `env --ignore-signal=TERM,INT,HUP,QUIT bwrap --unshare-user --uid 0 --gid 0 --cap-add ALL
  --unshare-net --unshare-ipc --unshare-uts --unshare-cgroup --unshare-pid --as-pid-1 --die-with-parent
  --new-session --dev-bind / / --proc /proc -- env --default-signal=TERM,INT,HUP,QUIT <pid 1 …>` (the
  `env` parts: F4, below). ib4k §2a says what each flag carries.
* **Probe** (named reasons). Steps:
  * bwrap is taken from the system dirs only, with no override (`not found … — install bubblewrap`).
  * A **setuid** bwrap is refused by rule before it is ever run (`setuid — refused by rule …`).
  * The same privileged tools as unshare are required. ⚠ bwrap still needs util-linux ≥ 2.38: the drop
    is `setpriv … unshare -U --map-user` (`WEBCTL_UNSHARE_BIN` when set).
  * Inside bwrap, the probe runs the inner half's first mount (`mount --make-rprivate /`), which shows
    the namespace root can mount. It then runs the drop exactly as a real run would.
  * Failures read: `bwrap exited <n> … (<bwrap's last line>)`, `its namespace root cannot mount (…)`
    (Ubuntu's `bwrap-userns-restrict` shape), or `the privilege drop … fails inside bwrap`, plus an
    AppArmor note when that sysctl is 1.
* **Selected when unshare's probe fails:** the verdict reads `backend: bwrap (skipped unshare:
  <v0.33's reason>)`, and unshare's own stderr is printed above it, so "unshare's own message, if any,
  is above" stays true.
* **A terminal's Ctrl-C reaches the command's own trap, as under unshare.** bwrap, unlike `unshare
  --fork`, dies by a group INT. With `--die-with-parent` that SIGKILLed the namespace, and the command's
  INT trap never ran (found by sabotage, measured). bwrap is therefore spawned in a session of its own;
  `isolated` forwards the signal. Arm: group Ctrl-C → `GOT-INT`, rc 7, under both backends.
* **Measured under the pin, not only in the table:** base's whole isolation depth suite runs green with
  `WEBCTL_ISOLATION_BACKEND=bwrap`. On both backends, the arms show:
  * a command killed by INT, TERM, HUP or QUIT gives 130, 143, 129 or 131;
  * the same signal sent to `isolated` REACHES the command, whose own handler prints it, and `isolated`
    then dies by that signal. (Fifth review: this arm used to judge only the death. A harness that
    re-raised the signal without forwarding it passed it.)
  * a group Ctrl-C stops a shell loop;
  * the command's `kill(0)` does not reach its caller's process group (row 3).
  One difference: bwrap sets no_new_privs for the whole sandbox, so a broken `setpriv` cannot remove
  it there.
* **Once stronger than unshare in one place:** `--new-session` means pid 1 and the inner half hold no
  controlling terminal either. Since the sixth review (B1) the unshare creator is spawned detached, so its
  halves hold none either (the arm now reads 0 on both creators). `--die-with-parent` takes the namespace
  down with a SIGKILLed harness; unshare got the same, below.
* **Refusal text:** every v0.33 shape of an unpinned refusal still LEADS with v0.33's unshare text. The
  perplexity regex `/NOT RUN: unshare exited 1/` keeps matching. One shape is new, and leads with its own
  reason: a host whose `env` lacks `--ignore-signal` / `--default-signal` (v0.33 ran there) reads
  `NOT RUN: its \`env\` cannot reset signal dispositions …`. bwrap's part of the appended summary is now a real
  reason instead of `not implemented yet (v0.35.0)`.

### ⛔ Mount propagation, closed for every backend (found building bwrap)

bwrap makes `/` an rslave. A mount the host made AFTER the start appeared inside, listed twice and
writable, landing after the read-only step (measured). Under `unshare --propagation=private` it was
listed 0 times. ⇒ The inner half now makes every mount private (`mount --make-rprivate /`, its first
mount; a no-op under unshare) and READS BACK that no mount carries a `shared:` or `master:` tag
(`propagationGaps`). The nesting proof checks the same. A new refusal (fail closed):
`after making every mount private, N mount(s) still receive propagation`. Row 7 arm: a tmpfs the
world mounts under a SHARED dir after each path starts is never listed inside. Control: a raw
`unshare -m --propagation=slave` sees it.

### ⛔ An early signal under bwrap: the command ran after the caller had died (fifth review, F1–F3)

* **What was wrong:** a TERM that came before the inner side reported in SIGKILLed bwrap. bwrap's
  child (pid 1 of the new PID namespace) sets PDEATHSIG only just before it execs, so it either went
  on and ran the command after `isolated` had died by the TERM, or, killed before bwrap released it,
  waited for ever holding the caller's stdio. The second case is a hang.
  *Measured with the review's reproducer:* the command ran after the TERM in 24 of 30 runs under
  bwrap, with 12 runs leaving orphans. Under unshare it was 0 of 20.
* **Why the arm missed it:** its probe counted "died by TERM" before it looked for the command's
  output.
* **Fix, two layers, on both backends and both paths:**
  * the early path tears the creator down with its namespace: STOP it, SIGKILL its children, then it;
  * the command starts only on a `go` the harness sends back on the status pipe, and only if no early
    signal came first. If the harness dies first, the far side reads EOF and starts nothing.
* *After:* 0 of 30 under bwrap (orphans 0, hung 0), and 0 of 20 under unshare.
* **Arms:** the early-TERM arms judge the command's output first and assert nothing is left and
  nothing hangs. A GO arm freezes the harness once the inner half exists: the command does not start,
  and a SIGKILL of the harness ends the run with nothing left. A teardown arm covers a pid 1 that
  outlives a SIGKILL of its creator.

### ⛔ A stop signal aimed at bwrap cut the command's trap short (fifth review, F4)

* **What was wrong:** a TERM, INT or HUP that reached bwrap itself killed it, and `--die-with-parent`
  then SIGKILLed the command in the middle of its own trap. Such a signal comes from a supervisor: a
  systemd stop or a CI cancel signals every process of the unit at once. *Measured by the review:* with
  the trap `echo GOT-TERM; sleep 0.5; echo CLEANED; exit 7`, unshare (which blocks TERM) completed it
  3/3, while under bwrap CLEANED was never printed (3/3).
* **Fix:** bwrap is exec'd through `env --ignore-signal=TERM,INT,HUP,QUIT`. Its pid 1 gets them back
  through `env --default-signal=…`. Without that reset, a non-interactive bash cannot trap a signal
  ignored at its start, and the command would inherit the ignore. `isolated` itself still receives
  these signals and forwards them, as under unshare.
* **Probe:** two new named reasons.
  * An `env` without these options (GNU coreutils < 8.31) is refused:
    `its \`env\` cannot reset signal dispositions …`.
  * pid 1 must read back from its own SigCgt that it can trap all four:
    `pid 1 cannot trap TERM, INT, HUP or QUIT …`.
* **Arms, under unshare and bwrap:**
  * TERM to the harness, its creator and every descendant at once → the trap completes, rc 7;
  * TERM to the creator alone → the command runs to its own end.

### ⛔ A QUIT to `isolated` orphaned the command under unshare — in every released `isolated` (fifth review, item 4)

* **What was wrong:** `isolated` forwarded INT, TERM and HUP only. Any other default-fatal signal killed
  the harness (node's default), and `unshare --fork` does not die with its parent. The namespace ran on
  with the command in it. ⚠ *Corrected (sixth review B6):* this entry used to add that unshare "ignores
  QUIT". It does not — it DIES by it. Spawned by the harness, `unshare --fork` ignores nothing and blocks
  only INT and TERM (read back: SigIgn 0, SigBlk 0x4002). The earlier measurement ran unshare as a
  background job of a shell, which ignores INT and QUIT for it. A QUIT that reached unshare itself killed
  it and, by `--kill-child`, the command mid-trap — fixed below ("The unshare creator is shielded"). *Measured on this branch's previous
  head under unshare:* QUIT, USR2 and ALRM each left 6 processes running after the harness died (unshare,
  pid 1's bash, both node halves, the command and its child); the review counted 5 for QUIT. Under
  bwrap, `--die-with-parent` already took the namespace down.
* **This closes an orphan leak present in every released `isolated` up to v0.34.0.** It is a contract
  fix, not an isolation breach. The orphan stayed inside its namespaces, masks and drop; it ran on after
  its caller had gone, with nothing left to stop it or report its result.
* **Fix, two layers:**
  * **QUIT is forwarded like INT** (Ctrl-\ is a terminal's QUIT): to pid 1's trap, the inner half, the
    helper and the command's group. A command killed by it gives 131, and `isolated` then dies by QUIT.
  * **The unshare creator dies with the harness:** it runs under `setpriv --pdeathsig KILL`, and so does
    the nested path's `unshare --fork`. The parent-death signal survives unshare's exec and its user
    namespace (measured: 2 processes left without it, 0 with it).
  * So every signal the harness does not forward, SIGKILL included, now ends the namespace with it on
    both backends. A setpriv without `--pdeathsig` (util-linux < 2.33) is refused by name.
* **Arm, under unshare and bwrap:** HUP, INT, QUIT, TERM, USR2, ALRM, PIPE and KILL to the harness leave
  no process of the command alive (by a unique tag). Node ignores PIPE, so the harness lives through
  it. RED on f3cb50f: `unshare SIGQUIT: 5 process(es) of the command outlived the harness`.
* Not forwarded: USR1 — every node half SWALLOWS it (v0.34.1, SECURITY): node's default opened an
  unauthenticated inspector, so no half honours it and none forwards it; PIPE and XFSZ, which node ignores. The synchronous fault signals (SEGV, BUS,
  FPE, ILL, TRAP, ABRT, SYS) were not measured; whatever kills the harness, the creator's parent-death
  signal takes the namespace with it.

### Sixth review (B1–B6, B9)

* **The unshare creator is shielded and detached, as bwrap is (B1).** `unshare --fork` blocks INT and
  TERM and nothing else. A QUIT or HUP to the caller's process group — a terminal's Ctrl-\ or a hangup —
  or from an every-pid stop killed it, and `--kill-child` then ended the command mid-trap: rc 131/129,
  cleanup never run. bwrap was fine. Now the unshare creator is spawned in a session of its own and run
  through `env --ignore-signal=TERM,INT,HUP,QUIT … env --default-signal=…`, like bwrap. The nested path's
  `unshare --fork` gets the same shield. The unshare probe refuses an `env` without those options and reads
  back that pid 1 can trap all four.
  *Arms, both creators:* HUP, QUIT, INT and TERM, sent to the group and to every pid, each reach the trap,
  which completes with rc 7.
* **A terminal-group signal reaches the command EXACTLY ONCE (B2).** Under unshare one group signal arrived
  2–3 times: pid 1 and the inner half were in the caller's group, so they got it directly AND forwarded.
  Detached, only the harness gets it. *Arm:* GOT ×1 on both creators. An every-pid signal still reaches
  each half directly, so the count varies; measured once: unshare HUP ×2, QUIT ×3, INT ×3, TERM ×5; bwrap
  HUP ×2, QUIT ×5, INT ×4, TERM ×2 (ib4k §2a item 9). Not asserted.
* **The teardown never signals a reaped pid (B3).** The early teardown and the post-`started` forward
  used the creator's pid even once node had reaped it, and a reaped pid can be reused. Now both skip a
  creator whose exit is recorded, and the teardown runs at most once.
* **Coverage (B4).** An import-only `teardown` seam on `runIsolated` (never an env var) disables the
  early teardown. The arm shows the far side reports in, waits for `go`, and never gets it. A second arm
  SIGKILLs a NESTED harness and finds nothing of its namespace left while the outer run goes on; it is
  red without `--pdeathsig` on the nested unshare.
* **The shield is READ BACK (B5).** Before `go`, the running creator's SigIgn
  (`/proc/<creator>/status`, read from the host) must hold TERM, INT, HUP and QUIT, or the creator is torn
  down and the run refused: `NOT RUN: <creator> is running WITHOUT its shield (read back: SigIgn …)`. An
  `env` that accepts `--ignore-signal` and does nothing passes the probe and is caught here.
* **pid 1 survives a fatal signal sent from inside (B9).** v0.34.1 recorded this as a residual: the reaping
  bash spends nearly all its time in `read -t`, during which bash CATCHES the fatal signals, so a namespace
  init's kernel protection no longer applied. USR1, USR2, ALRM, PIPE or VTALRM sent from inside ended pid 1
  and the run (138, 140, 142, 141, 154), and XCPU, XFSZ, SYS, TRAP or ABRT crashed bash (139). pid 1 now
  traps these as no-ops while it polls and ignores them for its final `wait`. A trapped signal is reset in
  every child, so the command's own dispositions are unchanged. *Arm:* each one is sent twice to pid 1 from
  inside, on the fresh and nested paths, under both creators, and the run ends with the command's 5. The
  inside SIGUSR1 arm signals pid 1 again. ⚠ SEGV, BUS, ILL and FPE are NOT swallowed: a trap that returns
  would re-run a genuine fault in bash for ever. Sent with `kill` from inside, they still end the run (139).
* **Docs (B6):** "unshare ignores QUIT" was wrong (above). `runIsolated` must not be called from a Worker:
  a parent-death signal fires at THREAD exit. The orphan count is 5 for the arm's command (it `exec`s its
  sleep) and 6 for a command with a child.
* **Sabotages**, each on a detached copy. Every one is red:
  * unshare neither shielded nor detached: both arms;
  * not detached (shield kept): group arm, `got it 3 times, not once`;
  * not shielded (detached): caught first by the read-back, `NOT RUN: unshare is running WITHOUT its
    shield`;
  * not shielded, and the read-back disabled: every-pid arm, `the trap was cut short`;
  * no `--pdeathsig` on the nested unshare: nested arm, `1 process(es) … outlived`;
  * `go` after an early signal: B4 arm, `the command RAN after an early signal`;
  * the read-back trusting: B5 fake-env arm;
  * the reaped check off: B3 logic arm;
  * pid 1's swallow trap removed: the B9 arm and the inside SIGUSR1 arm.

### Seventh review

* **The nested path reads back both shields (item 1).** On the nested path neither shield was read back:
  `privilegeDrop` only checked that `env` ACCEPTS `--ignore-signal` / `--default-signal`. *Measured:* an
  `env` that took `--default-signal` and dropped it left the nested pid 1 at SigIgn 0x4007, and a forwarded
  TERM never reached the command (rc 5 instead of the trap's 7). Now, before `go`, the nested call reads back
  its unshare's SigIgn, as the fresh path reads its creator's, and its pid 1's SigCgt, as the fresh probe
  does. Either one short is refused and nothing runs: `NOT RUN: the nested unshare is running WITHOUT its
  shield (read back: SigIgn …)` or `NOT RUN: the nested call's pid 1 cannot trap TERM, INT, HUP or QUIT
  (read back: SigCgt … lacks one)`. *Arm:* a fake `env` that accepts and drops each option, for the nested
  call alone → refused, nothing run (red before the fix: the nested command ran, rc 0); control: the real
  `env` runs it.

### Fifth review, smaller items

* **F5:** the claim "`isolated` never executes a setuid binary in its chain" was false. `/usr/bin/mount`
  is setuid and runs inside on both backends, where the bit has no effect. The setuid-bwrap refusal
  stands on its capability argument alone, and its text no longer makes the claim.
* **F7:** when `WEBCTL_UNSHARE_BIN` is set and bwrap's privilege drop fails, bwrap's part of the
  refusal ends ` (WEBCTL_UNSHARE_BIN)`, naming which unshare failed.
* **F9:** the bwrap-only terminal arm is named for what it tests: "detached OR --new-session". Either
  layer alone keeps the terminal half green. It now also reads the RUNNING bwrap's argv from /proc and
  requires `--new-session`, `--die-with-parent` and `--as-pid-1`. Dropping `--new-session` alone (B1)
  turns it red.
* **F10:** the arm table's world has private mounts, so on the main bwrap path the inner half's
  `mount --make-rprivate /` was a no-op. Only row 7's late-mount sub-arm exercised it. One more arm runs
  bwrap in a world whose mounts are SHARED. Control: they are. Removing the private step (B11a) turns it
  red.

### The docker backend (ib4k §3b, phase 3)

* **What it is:** the WHOLE sandbox, not a namespace creator. Inside a container nothing can mount or
  unshare, so the local daemon builds the masks from `docker create` flags. A capless inner half
  (`__isolated-docker`, the caller's uid) READS BACK every property before the command runs:
  capabilities, seccomp, namespaces, lo only, `/dev`, identity, cgroups, the read-only root,
  propagation, the hidden home, and host sockets. Any failed read-back is a refusal.
* **When it runs:** pinned (`WEBCTL_ISOLATION_BACKEND=docker`), or when both unshare and bwrap fail
  their probes. Its probe:
  * the docker CLI from the system dirs;
  * no remote `DOCKER_HOST`/`DOCKER_CONTEXT` (refused by name, the value never printed); every call
    carries `-H unix:///var/run/docker.sock`;
  * a daemon that answers, with seccomp (and AppArmor where the host has it), not rootless;
  * the image built locally with this recipe's label.
  A missing image is refused, naming `node <base>/scripts/contract-harness.mjs isolated-image build`. The
  run never builds and never pulls.
* **The image:** `docker/isolated/Dockerfile`. It is node 22.23.3 on Debian trixie slim, pinned by
  digest, plus `git` and `procps`, tagged `webctl-iso/node22:<recipe hash>` (332 MB). It is built only by
  `isolated-image build`.
* **The container:**
  * `--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user <uid>:<gid>
    --hostname webctl-isolated`;
  * caps `--cpus 2 --memory 4g --pids-limit 4096` (`WEBCTL_ISOLATION_DOCKER_CPUS/_MEMORY/_PIDS`);
  * private tmpfs on `/tmp`, `/var/tmp` and `/run`; the neutral machine-id;
  * the cwd and each `--keep` bound writable; each `--keep-ro` and base's root bound read-only; a host
    socket inside a bind covered with `/dev/null`;
  * named `webctl-iso-u<uid>-<lane>-<pid>`. Removal is by exact id or name only, never a prune.
  The command's env travels in a `0600` plan file in a private channel dir, never on an argv or in
  `docker inspect`.
* **Refused after selection:**
  * a symlink in any bind source (the daemon resolves them as root);
  * a bind at or beneath `/dev`, `/proc` or `/sys`, or one containing the daemon's socket;
  * a native addon (`*.node`) in the cwd's `node_modules`.
* **Signals, as on the other backends:**
  * a terminal-group INT/TERM/HUP/QUIT reaches the command exactly once (`docker kill` by exact id),
    and its trap completes;
  * exit 128+n, and the harness dies by a forwarded signal;
  * an early signal means the command never runs (the go-handshake, over FIFOs);
  * SIGUSR1 is swallowed.
  ⚠ The docker CLI dies by HUP, QUIT, USR2, ALRM and USR1 and cannot be shielded (Go resets the
  ignore). So it is not the run's authority: the harness follows the container with `docker wait`.
* **Nothing outlives the harness, SIGKILL included:** a reaper reads a pipe only the harness holds. On
  EOF it runs `docker rm -f` by exact id and name, bounded at 30 s, then exits.
* **Nested and stripped-markers calls run IN PLACE.** The proof is the read-only channel bind, which a
  process inside cannot make, plus every read-back run again. A forged marker is refused (exit 2).
* **The verdict:** `…; backend: docker (skipped unshare: …; bwrap: …); keyring: none (docker seccomp);
  dev: +core`. ⚠ It has no `; cgroup2: nsdelegate` (ruling 2: that check does not run under docker).
  The gate reads the LAST `; backend:`, as before.
* **Measured on a policy-blocked host** (Docker Engine 29.1.3, kernel 7.0, the AppArmor userns sysctl
  at 1):
  * rows 1–12 and 12b pass on the fresh, nested and stripped paths, each with its control (the
    deviations below asserted AS deviations);
  * 17 unit arms run against a fake CLI;
  * 11 sabotages were all caught (DEV_NOTES D1–D11).
  Building it found a go-handshake race (a hang under load), closed before any release.

### v0.34.0 pre-tag review follow-ups

* **Row 12b's TIOCSTI half could not fail where `dev.tty.legacy_tiocsti=0`.** The kernel answers EIO
  there before the controlling-terminal check. Now only EPERM passes, and only where the sysctl is 1
  or absent (kernel < 6.2). At 0 the half is a named `NOT TESTED HERE` diagnostic, and `/dev/tty` →
  ENXIO carries the property.
* **Row 3: a `kill(0)` arm.** In a throwaway `setsid` group, a sentinel and the wrapper that called
  `isolated` both survive the command's `kill -TERM 0`, on all three paths. Without `isolated`, both die.
* `runIsolated`'s two stacked JSDoc blocks are merged.

### What lanes lose

Expected: nothing, for a lane that runs `isolated` on a current Linux with util-linux and GNU coreutils.
The changes that can show:

* **Generation 9.** A lane that floors on 8 still passes: 8 is v0.34.1's SIGUSR1 fix, and v0.35.0 contains
  it. To require this release's behaviour, use `require-generation 9`.
* **The orphan fix.** A harness that dies — any signal, SIGKILL included — now takes the namespace and the
  command with it, under both creators. Lost: a command that kept running after `isolated` itself was killed.
  Nothing should have relied on that, since its result had nowhere to go.
* **The signal changes:**
  * QUIT is forwarded, so the command sees a Ctrl-\ and `isolated` dies by QUIT (a core dump, unless
    `ulimit -c 0`).
  * A terminal-group signal now reaches the command once, not 2–3 times. A trap that counted deliveries
    sees one.
    ⚠ "Exactly once" is per group signal: a terminal HANGUP can arrive twice. The harness gets HUP from both
    the tty driver and the shell's job HUP, and forwards each once (measured: twice under unshare, once under
    bwrap; without `isolated`, the command gets HUP then CONT).
  * The unshare creator is no longer in the caller's process group. A signal to that group still reaches
    the command, forwarded by the harness.
  * A HUP or QUIT to the creator, or to every pid, no longer ends the command mid-trap.
  * USR1 is swallowed, not forwarded (v0.34.1).
* **The go-handshake.** The command starts only after the harness answers `go`: one more round trip on the
  status pipe at start-up. A harness that is stopped (SIGSTOP, a debugger) holds the command back until it
  runs again, and one killed before answering means the command never starts.
* **Probes now refuse a host without:**
  * `setpriv --pdeathsig` (util-linux ≥ 2.33);
  * an `env` that takes `--ignore-signal` / `--default-signal` (GNU coreutils ≥ 8.31) in the system dirs —
    now for unshare AND bwrap, the nested path included. Before this release only bwrap needed it. A
    busybox-only or older-coreutils host that ran v0.34 under unshare is REFUSED, named
    (`its \`env\` cannot reset signal dispositions …`);
  * a running creator whose SigIgn shows the shield applied — and, on the nested path, a pid 1 whose SigCgt
    shows it can trap TERM, INT, HUP and QUIT.

### For lanes

* **On a host whose policy blocks user namespaces** (the AppArmor sysctl at 1): build the docker
  backend's image ONCE — `node vendor/base-webctl/scripts/contract-harness.mjs isolated-image build`
  (a pull of the digest-pinned base, then local) — and `isolated` runs there, on the local daemon.
  Nothing else changes; a lane whose arms run Chromium inside needs `--no-sandbox` there (row 7's
  deviation), and a step that needs a host tool the image lacks fails visibly (ENOENT).
* **Nothing to change** unless you want bwrap. `WEBCTL_ISOLATION_BACKEND=bwrap` on the gate host (or
  around your own suite) pins it. The pin passes through the `WEBCTL_*` allowlist, so your nested
  `isolated` calls validate it and run inside the bwrap outer. A stripped-markers call isolates again
  with bwrap.
* A lane matching `; backend: unshare` should match `; backend: [a-z]+` (generation ≥ 7, as v0.34.0
  says).
* **`HARNESS_GENERATION` 7 → 8.** `isolated`'s behaviour changed:
  * a bwrap pin runs, and some hosts that were refused now run under bwrap;
  * there is a new propagation refusal;
  * QUIT is forwarded, the command starts only on the harness's `go`, and the namespace dies with the
    harness on both backends.

  It is **9**, not 8: v0.34.1 (a SECURITY patch, the SIGUSR1 fix) took 8, and v0.35.0 contains that fix
  as well as its own changes. Find v0.34-vendored harnesses with "who is below 9". A contract that
  depends on any of this keys it on `require-generation 9`. `require-generation 8` still proves the
  SIGUSR1 fix; `require-generation 7` still gates `; backend:`.
* **Refusal text where bwrap runs (fifth review, F8).** On a host where unshare's probe fails but bwrap
  runs, a run that then fails reads `NOT RUN: bwrap exited <n> before the isolated side reported in — …`
  or the inner half's own refusal, not v0.33's unshare text. Every v0.33 shape where NO backend runs
  still LEADS with v0.33's unshare reason. So the regex `NOT RUN: unshare exited 1 before the isolated
  side reported in — ` matches wherever it matched on v0.33. The one new shape — an `env` without
  `--ignore-signal` / `--default-signal`, which v0.33 did not need — leads with
  `NOT RUN: its \`env\` cannot reset signal dispositions …` instead.

### ⛔ What this does NOT cover

* **Docker's deviations from the namespace contract** (ib4k §3b, named, never counted as passes):
  * **Row 7's control:** the command cannot make namespaces of its own (seccomp and AppArmor), so
    Chromium's own sandbox fails inside, and a lane runs it with `--no-sandbox`, a weaker browser.
  * **Row 9's control:** no keyring at all (`add_key` is EPERM).
  * **Row 12:** `/dev/core` exists, read back as a link to docker's masked `/proc/kcore`. `/dev` is
    docker's root-owned rw tmpfs (a create there is EACCES, not EROFS).
  * **A nested call cannot drop or re-isolate.** It runs in place: same uid, same PID namespace as
    its nested caller.
  * **The userland is the image's.** Host PATH tools are not there; `xq` is not in the image, so a lane's
    no-host-literals step takes its documented "xq is not installed" path.
  * **The command's stdin is EOF.** `docker start --interactive` READS the caller's stdin eagerly
    whether or not the command does. *Measured:* the gate's registry loop lost a consumer that way, so
    it is not forwarded.
* **The docker backend: measured on ONE host and daemon** (29.1.3). Not measured: a rootless daemon
  (refused), Docker Desktop, other engines, and a remote daemon (refused by rule).
* **`kill -9 -1` as the user** kills the docker backend's reaper with everything else, so a container
  may outlive it (named residual, ib4k §6).
* **The unshare/bwrap suites and arm table were NOT run on the docker host** (its AppArmor policy blocks
  user namespaces). They run on a gating host.

* **A host that forbids unprivileged user namespaces is NOT unblocked by bwrap.**
  * The sysctls (`user.max_user_namespaces=0`, `kernel.unprivileged_userns_clone=0`) refuse bwrap
    by the same kernel check.
  * A setuid bwrap is refused by rule: no `--cap-add` for a non-root caller, and no nested user
    namespace for the drop.
  * Ubuntu's AppArmor restriction denies bwrap too (§0, measured on a lane's host).
  * Its `bwrap-userns-restrict` profile, where enabled, strips capabilities inside (not measured here).
  * The one class where bwrap runs and unshare cannot is an admin AppArmor profile granting `userns,`
    to `/usr/bin/bwrap` (not measured). That lane waits for docker.
* **A harness SIGKILLed in one narrow part of bwrap's setup could still leave a process behind.** The
  window is between bwrap's own PDEATHSIG and its release of the child: a few syscalls. The command
  never runs there (it needs `go`), but bwrap's child would stay blocked, holding the caller's stdio.
  *Measured:* 0 leaks in 160 harness SIGKILLs spread over the setup window (ib4k §6).
* **Measured on one host only:** bubblewrap 0.11.2, kernel 7.1, no AppArmor. Older bubblewraps are not
  measured. The AppArmor profile behaviour above comes from the profile's design, not a run.
* **No `WEBCTL_BWRAP_BIN`.** A host that needs a dedicated bwrap must ask for one, with a measurement.
* **`--dev`, `--ro-bind`, `--cap-drop` are not bwrap's job here** (the inner half's). A sabotage of one
  of them is not an arm.
* **v0.34.1's residuals, narrowed:** the host harness's short same-uid SIGUSR1 window before its first
  statement still applies. pid 1 dying of a signal sent from inside is fixed (B9) except for SEGV, BUS, ILL
  and FPE sent with `kill`: those still end the run (139).
* **The nested path's every-pid counts were not measured** (the shield is there; the arm runs on the fresh path).
* Everything under v0.34.0's "does NOT cover" still applies, on both backends: key descriptions,
  user-writable sysfs attributes, empty child cgroups, stdio that is the terminal, the identity not
  hidden.

## v0.34.1 — 2026-10-12

**Headline: a SECURITY patch to `isolated` — no node half of it honours SIGUSR1 any more.**
Harness only; no `lib/` change. **`HARNESS_GENERATION` is 8.** No consumer change expected.

### ⛔ SECURITY

* **The isolated command could make a node half open its debugger, and that reached the
  PRIVILEGED half.** Node's default reaction to SIGUSR1 is to start its inspector: an
  unauthenticated debugger on `127.0.0.1:9229` that evaluates code inside the receiving process.
  The command could signal the node halves in its own PID namespace — among them
  `__isolated-inner`, which runs as namespace root with full capabilities before any mask is in
  place. Code evaluated there runs with that half's privileges, inside the sandbox's network
  namespace.
* **The host harness opened an unauthenticated loopback debugger on SIGUSR1.** Any process of the
  same uid could signal a running `isolated`, which then listened on host loopback for the rest of
  the run.
* **Fixed, in two layers, each enough on its own:**
  * every node half — the host entry, `__isolated-inner`, `__isolated-pid1` — installs a no-op
    SIGUSR1 listener as its first statement (its own, never relying on inheritance);
  * the three node re-execs (inner, pid 1, the preflight probe) carry `--disable-sigusr1` when
    the running node accepts it (node ≥ 22.14). The engines floor stays 22.12; on 22.12–22.13 the
    listener alone protects.
* **Affected:** every release whose `isolated` has a node inner half — **v0.31.0 through v0.34.0**
  (v0.31.0 introduced `__isolated-inner`; v0.32.0 added `__isolated-pid1`). The host-side exposure
  is node's default and applies to the harness in every release, but only `isolated` (v0.31.0+)
  keeps it running for the length of a command.
* **What lanes do:** bump the pin to v0.34.1 and raise the floor to `require-generation 8` — it
  answers 0 only on a harness that has this fix. Nothing a contract matches changed.

### What lanes lose

Expected: **nothing**. Measured against the full suite: no output, verdict or exit code changed.
Two edges, neither used by any contract we know of:

* `kill -USR1` no longer attaches a debugger to a running harness or to its halves. Debug one with
  an explicit `node --inspect …` instead.
* The inner and pid-1 halves' argv now carries `--disable-sigusr1` before the script path (on node
  ≥ 22.14). A tool that finds a half by argv POSITION (`argv[2] === '__isolated-inner'`) must match
  by inclusion instead.

### Arms

* Inside, on the fresh, nested and stripped-markers paths: the command sends SIGUSR1 to every pid
  it can see; no LISTEN row may appear in `/proc/net/tcp{,6}`, every target survives, the run ends
  0, and the re-exec'd halves carry the flag where node supports it.
* Host: a running harness is sent SIGUSR1; its socket inodes (`/proc/<pid>/fd`) are mapped against
  the LISTEN rows — it must own none, survive and end 0. No arm connects to any port.
* Sabotaged copies: the listener removed (flag kept) is caught by the host arm; the flag removed
  (listener kept) by the inside arm's argv check; both removed by both arms, on behaviour.

### ⛔ What this does NOT cover

* **The host harness keeps a short window** between node start and its first statement (module
  loading) in which SIGUSR1 still opens the inspector. Reachable only by the same uid, which can
  already ptrace the harness. The privileged halves have no such window where the flag is supported.
* **pid 1 (the reaping bash) dies of a fatal signal sent from inside** — USR1, USR2, ALRM, PIPE,
  measured — because its `read -t` wait loop makes bash catch them; `--kill-child` then ends the
  namespace. That is the command ending its own run (it could simply exit), not an escalation; it is
  pre-existing and left for a later release. The new arm skips pid 1 for this reason.
* Everything under v0.34.0's "does NOT cover" still applies.

## v0.34.0 — 2026-10-11

**Headline: `isolated` chooses its BACKEND — unshare → bwrap → docker → refuse, never unisolated
— and is judged by ONE arm table (ib4k §1, rows 1–12); and it closes the gaps v0.33 left open: a
private `/var/tmp`, `/dev/shm`, SysV IPC and POSIX mqueues, a fresh session keyring, the host's
identity hidden — a READ-ONLY root (row 7) — and, holes in every released `isolated` found by review,
a fresh minimal `/dev` (row 12) and a read-only cgroup tree in a cgroup namespace of its own (row 3).**
⛔ **A SECURITY update — not optional:** the `/dev` and cgroup fixes close holes in EVERY released
`isolated` up to v0.33.1 (below). **The unshare hardening release:** only the **unshare** backend is
implemented; **bwrap and docker land in v0.35.0**. Harness and gate only; no `lib/` change. **`HARNESS_GENERATION` is 7** (below). No consumer change expected,
except a contract that matches the new verdict field or a refusal's tail.

### Backend selection (ib4k §2, §4)

* Backends are probed in order — **unshare, bwrap, docker** — and the first that can run is used;
  each one skipped before it is recorded with its NAMED reason. None → **refused**, naming all
  three. A probe is side-effect free (unshare: `unshare -rnm --uts --ipc --cgroup --pid --fork true` after
  its tool checks) and a probe that throws is a reason, never a crash. Only a PROBE failure moves
  on: once a backend is chosen, a failure inside it is a FAIL.
* **`WEBCTL_ISOLATION_BACKEND=unshare|bwrap|docker`** pins one. A pinned backend that cannot be used
  is a **refusal**, never a fallback; an unknown value is refused by rule. A nested call validates
  it and selects nothing (it runs inside its outer call's sandbox).
* ⚠ **unshare only:** `bwrap` and `docker` answer `not implemented yet (v0.35.0)`. So on a host
  where unshare cannot run (the AppArmor sysctl — v0.33's HOST-POLICY text is kept as unshare's
  reason) `isolated` still REFUSES; a pin to bwrap or docker is refused. A backend that is selected
  but has no runner yet is refused, `internal: backend <x> has no runner yet` (review F7) — it is
  never run on unshare's runner under its own name.
* **The refusal keeps v0.33's leading text** (review F4, ruling): an unpinned refusal reads
  `NOT RUN: <the unshare reason, worded exactly as v0.33>; no isolation backend can be used here —
  bwrap: <why>, docker: <why> (the command is never run unisolated). The command was NOT started.`
  — e.g. `NOT RUN: unshare exited 1 before the isolated side reported in — …`. unshare's own message
  is printed above it, as v0.33's was. A PIN keeps its own text (`… pins the <x> backend …`). Still
  one `FAIL  isolated: NOT RUN…` line + a JSONL record, which now carries `"backend"` and
  `"skipped"`. ⚠ An earlier phase-1 build said `NOT RUN: no isolation backend can be used here —
  unshare: …`; it broke a lane's regex and is gone.
* **The verdict line ends `…; backend: unshare`** (then `; keyring: …` when that deviates), then
  **`; cgroup2: nsdelegate`** — the check every run passed (third review, F2). ⚠ A test anchoring
  `backend: unshare —` or `backend: unshare$` must allow it.
* **`writable:` counts writable binds OUTSIDE the home** (re-review item 4): a cwd and a `--keep`
  under `/tmp` printed `writable: nothing`. Now `writable: ~/work, 2 named paths outside the home`
  (implicit ones by label or tally, as under the home); `WEBCTL_ISOLATED_VERBOSE=1` lists them by
  absolute path. `; backend:` still follows every path. ⚠ A test anchoring `writable: nothing` or
  `writable: ~/x;` where its cwd lies outside the home must allow the count.
  ⚠ A test anchoring the verdict's END (after `writable: …`) must allow it.
* **The release gate** records the backend per consumer — read from its OWN `isolated` verdict, so
  nothing a consumer prints changes: scratch-mode envelopes gain `"isolation": "<backend>"` (`none`
  when refused), and the summary prints `----- isolation backends: unshare=N -----`. It takes the
  verdict's LAST `; backend:` (review F8): a named path containing `; backend: docker` cannot win.

### The shared arm table (ib4k §1)

* `test/isolation-arm-table.test.js`: rows 1–12 as ONE table, run per implemented backend, each row
  on the fresh, nested and stripped-markers paths with its positive control, in a throwaway world
  (a fake passwd home on a tmpfs, tmpfs "host" scratch dirs, its own IPC namespace and mqueue, a
  throwaway keyring; host identity compared as digests — nothing touches the real host). A guard
  fails when the harness can run a backend the table does not judge.
* Arms added by the phase-1 review: **row 8** — a host SysV segment not listed by `ipcs -m`, a
  `shmat` write inside never reaching it, the host's POSIX mqueue absent (controls: a segment and a
  queue made inside are seen inside; the write outside is read back); **row 10** —
  `/sys/devices/virtual/net` lists only `lo`, and the neutral `/etc/machine-id` cannot be rewritten
  through its backing copy (`chmod` + write; control: the same routine changes such a bind made
  outside); **row 9** is a named SKIP where `keyctl show @s` fails, and **9b**: a host key's
  possessor-only payload → EACCES inside by id (control: readable outside); **row 7**: the read-only
  root locks nothing over `/proc` or `/sys` files — the nested and stripped paths' `--mount-proc`
  prefixes and a nested sysfs mount still work inside.
* Arms added by the re-review: **row 12** (no host devices — `/dev` beyond the minimal set, the
  host's devpts, `/dev/uinput`, `/dev/snd`; controls: a pty master and slave, `/dev/null`,
  `/dev/urandom`, `/dev/tty`, `/dev/shm`, a nested `unshare -Ur --pid --fork --mount-proc`); **row 3**
  — the caller's `cgroup.kill` / `cgroup.procs` do not open for write (opened, never written; control:
  they do outside). ⛔ An ARM with a half this host cannot test (no `ipcmk`, no `/dev/uinput`, a
  cgroup not delegated, …) is now a named **SKIP**, never a green pass (item 6).

### Rows 8–10 closed (unshare)

* **Row 8 — no host-shared scratch.** `/var/tmp` and `/dev/shm` get a private tmpfs, like `/tmp`.
  Measured before: a file planted in the host's was readable inside, and a write inside landed on
  the host. Keep rules are `/tmp`'s: a `--keep`/`--keep-ro` BENEATH one is re-bound with its mode; a
  keep that IS one (or an ancestor) is usage 3; a cwd AT one fails, beneath one runs. **And SysV IPC
  and POSIX mqueues** (review F1): measured, a host `ipcmk -M` segment was listed inside, a `shmat`
  write inside landed in it, and a host queue was visible. Now `unshare --ipc` (proved: the IPC
  namespace differs from the caller's) and a fresh mqueue on `/dev/mqueue` (read back).
* **Row 9 — a fresh session keyring.** Measured before: `keyctl show @s` listed the host's session
  keyring (possessor `alswrv`), a host key was found. pid 1 now runs `keyctl new_session`; the
  fresh path READS BACK the keyring id and refuses when it is still the host's. A **failed join is
  a refusal** on every path (ruling R3; it was `|| :`, silent on the nested path — review F5).
  **keyctl not installed:** the command runs and the verdict says `keyring: shared (keyctl not
  installed)`. **keyctl installed but the host's `keyctl show @s` fails** (review F5): the join still
  runs, but cannot be read back — the verdict says `keyring: unverified (keyctl show failed)`.
* **Row 10 — host identity hidden.** Measured before: hostname, every interface name in
  `/sys/class/net`, `/etc/machine-id`. Now: a UTS namespace named **`webctl-isolated`**, set with the
  system `hostname` tool — ⛔ **required** (ruling R2): without it `isolated` REFUSES, naming the
  packages (`inetutils` or `hostname`); a **fresh sysfs** listing only `lo` in `/sys/class/net` and
  `/sys/devices/virtual/net` (a fresh cgroup2 on `/sys/fs/cgroup`, row 3) — ⛔ **if the kernel refuses the sysfs
  mount, `isolated` REFUSES** (review F3; an earlier build masked `/sys/class/net` alone and ran, while
  `/sys/devices/virtual/net` still named the host's interfaces); a **neutral `/etc/machine-id`** (a
  fixed constant — systemd-id128 and dbus-uuidgen keep working) and `/etc/hostname`, their copies on
  a tmpfs of their own made read-only (review F6: a copy left in the writable `/run` could be
  `chmod`ed and rewritten). All READ BACK.
* ⚠ **Nesting:** the kernel proof now requires the scratch masks and the hidden identity. A v0.34
  call nested under a **v0.33 outer is refused** (exit 2) saying **"upgrade the outer"**. Under the
  release gate the outer is base HEAD, so this bites only a lane whose own outer call is older. The
  nested path makes no IPC namespace of its own: it inherits its outer's.

### ⛔ SECURITY: holes in EVERY released `isolated` (up to v0.33.1), found by review — closed

**Bumping to v0.34.0 is a security update, not optional.** On every released version, a command
run under `isolated` — the mutant, the untrusted page, the code under test — could:

* **inject keystrokes into the user's desktop:** `/dev/uinput` opened for write, i.e. a virtual
  keyboard typing into whatever window has focus, a terminal included;
* **type into the caller's terminal** (third review, F1): it shared the caller's session, so
  `/dev/tty` opened the caller's terminal, and TIOCSTI there — or on fd 0 when that is the terminal —
  injects input (kernels before 6.2, or `dev.tty.legacy_tiocsti=1`; CVE-2017-5226's class);
* **kill its caller:** the caller's own `cgroup.kill` opened for write — one write kills every
  process of the caller's scope: the release gate, the lane's harness, the user's session there;
  and, without any cgroup, `kill(0)` inside signalled the caller's whole PROCESS GROUP (measured
  pre-tag: a sentinel in the caller's group died on v0.33.1; at v0.34.0 it lives — closed by row 12b's
  new session).

* **Row 12 — the host `/dev` was passed through WHOLE.** Measured inside: `/dev/uinput` opened for
  write (virtual-keyboard injection into the host desktop); the host devpts (the user's other
  terminals), `/dev/video*`, `/dev/snd/*`, `/dev/kvm`, `/dev/fb0` and `/dev/vcs*` were writable. Now a
  minimal FRESH `/dev`, like `bwrap --dev`: `null zero full random urandom tty` bound from the host, a
  fresh `devpts` (ptys of its own; `ptmx -> pts/ptmx`), `fd stdin stdout stderr` -> `/proc/self/fd`,
  the private `/dev/shm` and `/dev/mqueue` — nothing else; read-only, and READ BACK (anything else
  there → refused). A pty, `/dev/null`, `/dev/urandom`, `/dev/tty`, `/dev/shm` and a nested
  `unshare -Ur --pid --fork --mount-proc` (Chromium's sandbox) still work — arms in row 12.
  ⚠ **What lanes lose:** every other device — `/dev/fuse`, `/dev/net/tun`, `/dev/kvm`, `/dev/dri`,
  sound, video, input, block devices. ⛔ A `--keep` / `--keep-ro` / cwd under `/dev` is **refused**
  (except beneath `/dev/shm`, as before). The nesting proof requires the fresh `/dev` (a nested call
  under an older outer: "upgrade the outer").

* **Row 12b — no controlling terminal** (third review, F1). The privilege-drop chain now starts in a
  NEW SESSION, like `bwrap --new-session` — above the capless helper and the nested path's pid 1 too,
  so nothing the command could ptrace holds the terminal as its CONTROLLING terminal (its stdio fds
  may still BE the terminal — see "does NOT cover"). Inside, `/dev/tty` → ENXIO and TIOCSTI →
  EPERM/EIO. Ctrl-C still stops the command: `isolated` forwards INT/TERM/HUP down the chain, and the
  last hop sends them to the command's whole process GROUP (a shell loop's `sleep` included). Exit
  codes are unchanged. ⚠ **What lanes lose:** opening `/dev/tty` inside (ssh or gpg prompts, a TUI — as under `bwrap --new-session`)
  fails ENXIO; **Ctrl-Z stops `isolated` but not the command** — it runs on until `fg` (TSTP/CONT are
  not forwarded); a backgrounded command reading the terminal is no longer stopped (SIGTTIN); a TERM
  sent to the `isolated` pid alone now reaches the command's whole group.

* **Row 3 — the caller's cgroups were WRITABLE.** No cgroup namespace, and the host's cgroup2 tree
  read-write inside: the command could open its caller's scope's `cgroup.kill` or `cgroup.procs` for
  write — kill (or move) the processes that called `isolated`, the release gate among them. Now
  `unshare --cgroup` (the probe too) and a FRESH cgroup2 on `/sys/fs/cgroup`, mounted inside that
  cgroup namespace and made READ-ONLY (third review, F3) — rooted at the caller's scope, so no host
  scope name is visible; READ BACK (a writable cgroup mount, the caller's cgroup namespace, or a
  `/sys/fs/cgroup` not rooted at the namespace → refused); the nesting proof requires it.
  ⛔ **Closed where cgroup2 is mounted with `nsdelegate` (systemd's default); `isolated` refuses
  otherwise** (third review, F2): inside, the command can still make a cgroup namespace of its own and
  mount cgroup2 there — a writable view rooted at the caller's scope — and only `nsdelegate` stops a
  `cgroup.kill` write at its root. So `isolated` reads cgroup2's super options in
  `/proc/self/mountinfo` and REFUSES without `nsdelegate` (or with NO cgroup2 mount: a cgroup v1-only host is refused by name, "no cgroup2 mount visible; isolated needs cgroup2 with nsdelegate"),
  naming the option and the remedy; the verdict states the check (`; cgroup2: nsdelegate`), and the
  read-back and the nesting proof require it.
  ⚠ **What lanes lose:** cgroup writes inside (a test that made a sub-cgroup of its own scope).
  ⚠ **Corrected (third review, F3):** an earlier build of this release moved the HOST's tree back
  read-only and this entry said node's memory limit "still works" — measured, `process.constrainedMemory()`
  was **0** inside (2^64 outside), and every host scope name was listed. Now it reads the SAME inside
  as outside (an arm), as does the own cgroup's `memory.max`; the view is the caller's scope and below.

### Row 7 closed — the whole tree READ-ONLY (ruling R1)

* Measured before: a user-owned dir OUTSIDE the home (an `/opt/x` of one's own) was WRITABLE inside —
  `isolated` protected the home, base's root and the keeps, and left the rest of `/` as it was.
* Now every mount reachable from `/` is remounted read-only (per mount, in the private mount
  namespace), EXCEPT `/proc` (procfs writes — `oom_score_adj`, a nested userns's `uid_map` — keep
  working for Chromium's sandbox and for `isolated`'s own privilege drop) and `/dev` (replaced whole,
  row 12). The host `/sys` goes read-only too, underneath the fresh sysfs, which itself stays
  read-write (a read-only one breaks every nested sysfs mount — measured). Then, on
  top and WRITABLE: the cwd, every `--keep`, a throwaway `HOME`, and the private `/tmp`, `/var/tmp`,
  `/dev/shm`, `/run`. READ BACK: any other writable mount → refused. A mount point nothing can reach
  (a root-owned 0710 dir — e.g. docker's overlay rootfs) is skipped: the command cannot reach it either.
* A stripped-markers call carries an outer's writable mounts wherever they are (so a `--keep` outside
  the home stays writable on all three paths).
* ⚠ **What lanes LOSE** — writes anywhere outside the declared set now fail with **EROFS**:
  * a user-owned dir outside the home, the cwd, the keeps and the scratch dirs (an `/opt/<own>`, a
    `/srv/<own>`, a user-owned `/usr/local/...`);
  * a tool CACHE there (a package manager, a compiler or a browser cache configured outside the
    home) — point it at the cwd, a `--keep`, or `/tmp` (TMPDIR is `/tmp` already);
  * a NESTED `isolated --keep <path>` of a path its outer did not keep writable (it is read-only in
    the outer, and a nested call cannot widen that) — keep it in the outer call;
  * a cwd that CONTAINS a masked dir (`/`, `/var`) is now refused: its writable bind would undo the
    mask. Run from a test-owned directory.
  * ⛔ **a `git worktree` whose gitdir lies outside the cwd and every keep** — the case lanes hit:
    the worktree's `.git` is a FILE pointing into the MAIN repo's `.git/worktrees/<name>`, which is
    now read-only, so `git add` and `git commit` fail with **EROFS on `index.lock`** (and `HEAD`,
    refs). Fix: **`--keep <the main repo>`** (or its `.git`). A gitdir under `/tmp` or the home was
    already unusable before R1 (the scratch mask and the hidden home put it out of reach).

### New refusals (fail closed)

* no `hostname` tool in `/usr/sbin:/usr/bin:/sbin:/bin` (R2); a fresh sysfs the kernel refuses (F3);
  pid 1's `keyctl new_session` failing, on the fresh AND the nested path (R3, F5); the IPC namespace
  still the caller's, or `/dev/mqueue` not resolving to the fresh mqueue (F1); the identity files'
  tmpfs not read-only (F6); a selected backend without a runner (F7); a mount under `/` that cannot
  be made read-only, or one still writable outside the declared set after it (R1); a cwd containing
  a masked dir (R1); a fresh `/dev` that cannot be built, or anything beyond the minimal set in it
  after (row 12); a `--keep` / `--keep-ro` / cwd under `/dev` other than beneath `/dev/shm` (row 12);
  a cgroup mount still writable, or the cgroup namespace still the caller's (row 3); the host's
  cgroup2 without `nsdelegate`, or no cgroup2 mount at all (a cgroup v1-only host) (row 3, third review F2); an interface
  dir or identity file that cannot be READ (anything but ENOENT) in the identity read-back — it was
  read as "nothing shown" (re-review item 5).

### Generation 7 (ruling R4)

`HARNESS_GENERATION` is **7**: `isolated` changed behaviour (the verdict field, the refusal tails,
the new refusals, rows 8–10 and 12). A contract that MATCHES the new verdict field must key it on the
generation, or it goes red on an older pin:

```bash
# bash: assert the backend only where the harness names it (generation ≥ 7)
if node "$H" require-generation 7 >/dev/null 2>&1; then
  grep -qE '^isolated: home HIDDEN; .*; backend: [a-z]+' "$LOG" || { echo "FAIL: no backend in the verdict"; exit 1; }
fi
```

```js
// node: the same guard
const gen7 = spawnSync(process.execPath, [H, 'require-generation', '7'], { stdio: 'ignore' }).status === 0;
if (gen7) assert.match(stderr, /^isolated: home HIDDEN; .*; backend: [a-z]+/m);
```

⚠ Take the LAST `; backend:` on the line (the paths you named come before it), as the gate does.
`require-generation 6` still gates `--pass-env` (v0.33.0) and still answers 0.

### Per lane

* **perplexity**: its regex `/NOT RUN: unshare exited 1/` keeps matching (review F4) — measured with
  a fake `WEBCTL_UNSHARE_BIN` printing `Operation not permitted`, exit 1, which is the lane's own
  case. No change needed there.
* A lane that matches a refusal's END must allow the appended `; no isolation backend can be used
  here — bwrap: …, docker: … (the command is never run unisolated)`.
* A lane on a host without the `hostname` tool, or where the kernel refuses a sysfs mount in a user
  namespace, now gets a REFUSAL where phase 1 ran with a note — install the tool (`inetutils` or
  `hostname`).

### ⛔ What this does NOT cover

* **bwrap/docker backends: v0.35.0** (ib4k §3/§3a): not implemented here. A host that forbids
  unprivileged user namespaces is still refused — the lane blocked by AppArmor is NOT unblocked yet.
* **Identity not hidden:** `/etc/hosts` (may name the host), `/proc/sys/kernel/random/boot_id`, DMI
  strings under `/sys/class/dmi/id`, **disk serials** (`/sys/class/block/*/device/serial` — block
  devices are not per network namespace, so a fresh sysfs still lists them), the kernel release.
* **Key DESCRIPTIONS and ids** (review F2; ruled: no mask): the description (type, uid, perms, name)
  and id of every key the user's uid owns stay enumerable inside — `/proc/keys`, `keyctl rdescribe` —
  because the user VIEW bit applies without possession. PAYLOADS need possession or the user READ
  bit: a host key with possessor-only read answers EACCES inside (arm 9b). A masked `/proc/keys` was
  measured to break every nested `--mount-proc` (the kernel's `mnt_already_visible`), this verb's own
  nested and stripped paths included, and a fresh nested procfs lists the keys again anyway.
* **User-writable sysfs attributes** (third review, F4): the fresh sysfs stays read-write (a
  read-only one breaks nested sysfs mounts), so an attribute udev granted the user's uid — e.g. a
  backlight's `brightness` — is writable inside, as it is outside. Not masked: a mount over a sysfs
  file breaks nested sysfs mounts.
* **Empty child cgroups** (third review, F2): with `nsdelegate`, the command can still `mkdir` child
  cgroups beneath the caller's scope through a nested cgroup2 mount of its own. They may outlive the
  run and are removed with the scope. It cannot kill or move the caller's processes.
* **Stdio that IS the terminal** (pre-tag review): row 12b removes the controlling terminal, not the
  terminal. When `isolated` is run with fds 0/1/2 on a terminal, the command still holds them: it can
  read keystrokes typed during the run, change termios (e.g. echo off, persisting after it exits)
  and write escape sequences, some of which make a terminal answer into its own input. Same as
  `bwrap --new-session`. The gate and the lanes run with no terminal; run `isolated` with stdin from
  `/dev/null` and output to a pipe or file to remove this.
* Everything under v0.33.x's "does NOT cover" that is not listed above still applies (what a
  re-bind brings back is visible; the util-linux 2.38 PDEATHSIG window).

## v0.33.1 — 2026-10-10

**Headline: `isolated` hardening from the last v0.33.0 review — which `xq` it trusts, and what
it carries into a nested call.** Harness only; no `lib/` change; `HARNESS_GENERATION` stays 6.
No consumer change expected.

* **`xq`'s root is trusted more narrowly.** v0.33.0 already ignores an `xq` a run could have
  planted. Now that rule also covers:
  * a RELATIVE `--keep` or `TMPDIR`, resolved before comparing (they were skipped);
  * any dir OUTSIDE the home that the caller can write (`access(W_OK)`), e.g. a user-owned
    `/opt/x`. ⚠ An `xq` installed through such a dir is now ignored; install it from a dir
    only root can write, or from the home;
  * `..` after a symlink, judged as the kernel resolves it, not lexically.
* **A hang is fixed.** Node's JS `fs.realpathSync` loops forever on a link like `sym/../xq`, so
  one planted in `node_modules/.bin` could hang every later `isolated`. Every call site now uses
  `fs.realpathSync.native`.
* **Carry rule under a SYMLINKED hidden dir.** With `~/.ssh` a symlink (dotfiles), an outer
  `--keep ~/.ssh/<sub>` used to be carried WRITABLE into a nested call with stripped markers. The
  outer call now also mounts its hide on a hidden dir that has a keep beneath it. The nested call
  reads those hides from the mount table and drops anything at or within them, with the same
  note. What the outer command sees is unchanged.
* Docs: a real home path in a June status note is redacted.

### ⛔ What this does NOT cover

Everything listed under v0.33.0's "does NOT cover" still applies: `/var/tmp` and `/dev/shm`
shared with the host, the host session keyring, host identity (hostname, interface names,
machine-id), and the util-linux 2.38 PDEATHSIG window. These are planned for v0.34.0 (ib4k).

## v0.33.0 — 2026-10-10

**Headline: `isolated` HIDES the whole home — except what it re-binds, among them EVERY PATH dir
under the home, which may itself hold secrets — passes an env ALLOWLIST (and a shorter one to the
privileged halves), its pid 1 is `bash --norc -p` and REAPS orphans, and a signal can no longer
slip in before it is heard.** Measured gaps
from `perplexity` and from the review of this branch; scope ruled by `webctl:mgr` (2026-10-07).
xrl4 §"Mutation arms run with no host network, no host unix sockets and a hidden home".
Harness only; no `lib/` change. **`HARNESS_GENERATION` is 6** — `isolated`'s behaviour changed
(below: how to pass `--pass-env` and stay green on a generation-5 pin too).

### ⛔ BREAKING — the env is an ALLOWLIST

37 vars matching `*_API_KEY`, `*_TOKEN`, `*SECRET` reached the arm on an operator host
(measured by the review), and the gate passes its full env. **Only these reach the command
by default:**

* `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TZ`, `NODE_OPTIONS`,
  `NODE_PATH`, `npm_config_*`, `WEBCTL_*` — plus `TMPDIR=/tmp` and `isolated`'s own markers
  (`WEBCTL_HOST_NETNS`, `WEBCTL_HOST_MNTNS`, `WEBCTL_HOST_PIDNS`, `WEBCTL_RO_ROOTS`,
  `WEBCTL_HIDDEN_DIRS`, `WEBCTL_HOST_IDS`), on the fresh and the nested path.
* **`CLIAI_*` is NOT passed by default** (`CLIAI_<TOOL>_BROWSER_{SSH_,}TARGET` name remote
  targets), nor `SESSION_MANAGER` (it embeds the hostname) or `ICEAUTHORITY`.
* **Pass more:** `--pass-env NAME` or `--pass-env PREFIX_*` (repeatable; letters, digits, `_`;
  a prefix ends in `_*`; a bare `*` is refused). The socket/display/address names isolation
  removes (`DISPLAY`, `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR`, …) are refused by name and stripped
  even from a prefix pass. A nested call honours only its OWN `--pass-env`.
* ⛔ **Loader vars — and the caller's PATH — never reach a PRIVILEGED half.** Everything that runs
  before the command's capability drop — `unshare`, pid 1's bash, the inner node (namespace root,
  full caps, before any mask), the `mount`/`ip` it runs, `setpriv`/`unshare -U` — gets only `HOME
  USER LOGNAME LANG LC_* TERM TZ TMPDIR WEBCTL_*` and `PATH=/usr/sbin:/usr/bin:/sbin:/bin` (next
  section). Measured by the review of 5773fb8: `NODE_OPTIONS=--require
  <preload>` ran the preload in the inner node with a FULL CapEff, the real home readable; a
  `--pass-env 'LD_*'` reached every C binary of the chain. The command's env travels in a pipe
  and is applied by the small node helper that spawns it, after the drop — so the command still
  gets `NODE_OPTIONS` and whatever you `--pass-env`, and nothing before it does.
* ⚠ **One more process: on the FRESH path the command's parent is now that node helper**
  (`node …/contract-harness.mjs __isolated-pid1 …`; it used to be the inner half, through an
  exec'ing `setpriv`/`unshare -U`). A test that inspects its own process tree — `getppid()`,
  `/proc/<ppid>/cmdline`, `ps` from pid 1 down — sees the helper between pid 1's bash and the
  command, as the nested path already did. Exit codes and signals are unchanged (128+n, re-raised).
* **Declare yours** — ready to copy into each lane's `isolated` call (`webctl:mgr`'s pre-check):

  ```bash
  # chatgpt
  node "$H" isolated --pass-env 'CGWC_*' --pass-env CLIAI_CHATGPT_WEBCTL_TESTS_HOST_NETWORK -- …
  # substack
  node "$H" isolated --pass-env SUBSTACK_WEBCTL_TESTS_HOST_PID --pass-env UV_CACHE_DIR -- …
  # perplexity
  node "$H" isolated --pass-env FIXTURE_PARENT_NETNS -- …
  # aliexpress
  node "$H" isolated --pass-env ALIEXPRESS_WEBCTL_ARM_REAL_HARNESS -- …
  ```

  ⚠ **Under the release gate**, the gate's own (outer) `isolated` call passes no extra env, so
  your nested `--pass-env X` only finds an `X` your contract sets itself: a toggle exported on
  the host (`…_TESTS_HOST_NETWORK=1` in your shell) is ABSENT under the gate.

  ⚠ **A lane that runs `uv` inside must pass its uv knobs:** `--pass-env UV_CACHE_DIR` (or
  `--pass-env 'UV_*'` if it sets several, e.g. `UV_NO_CACHE`). Dropped by the allowlist, uv falls
  back to `~/.cache/uv` — under the HIDDEN home — and fails `ENOENT` / `EROFS`. Measured by a
  consumer lane: its contract set `UV_CACHE_DIR=/tmp/uv-cache`, the allowlist dropped it, and a
  cwd test failed.

* ⛔ **Stay green on BOTH your current pin and v0.33.0.** A v0.32 harness (generation 5)
  REFUSES `--pass-env` as an unknown option (usage, exit 3) — so pass it only when the vendored
  harness is **generation ≥ 6** (`HARNESS_GENERATION`, bumped by this release). Ask the harness
  with `require-generation 6` (exit 0 = yes; ANY non-zero = no — a harness older than
  generation 4 does not know the verb and exits 3):

  ```bash
  PASS_ENV=()
  if node "$H" require-generation 6 >/dev/null 2>&1; then PASS_ENV=(--pass-env 'CGWC_*'); fi
  node "$H" isolated "${PASS_ENV[@]}" -- …          # bash ≥ 4.4 for an empty array under set -u
  ```

  ```js
  const { spawnSync } = require('node:child_process'); // ESM: the same names from 'node:child_process'
  const gen6 = spawnSync(process.execPath, [H, 'require-generation', '6'], { stdio: 'ignore' }).status === 0;
  const passEnv = gen6 ? ['--pass-env', 'CGWC_*'] : [];
  spawnSync(process.execPath, [H, 'isolated', ...passEnv, '--', ...cmd], { stdio: 'inherit' });
  ```

  ⚠ Ask the VERB; do not load the harness as a module to read the constant: a harness older
  than v0.31.0 has no import guard and would run a verb from YOUR argv.

* The release gate's own `isolated` call passes **no** extras: a contract gets the default
  list (its `WEBCTL_*` included). base's gate tests now name their fake-contract knobs
  `WEBCTL_TEST_FAKE_*`.

### ⛔ BREAKING — the WHOLE passwd home is HIDDEN

Read-only still let a mutated test READ and print the operator's ssh keys, ControlMaster
socket paths, an install salt and remote target configs (`perplexity`); hiding a fixed list
of dirs missed every secret nobody listed. ⇒ the passwd home (not `$HOME`) gets an **empty
read-only tmpfs**: a read of anything in it is `ENOENT`, a create `EROFS`. Re-bound on top:

* **read-only** — base's repo root, node, the command if absolute, `WEBCTL_UNSHARE_BIN`,
  **every PATH entry under the home**, and each **`--keep-ro <path>`** (new, repeatable; e.g.
  uv's managed python: `--keep-ro ~/.local/share/uv/python`);
* **writable** — the cwd and each `--keep <path>`, as before.

`~/.ssh`, `~/.gnupg`, `~/.cache/CLIAI`, `~/.config/CLIAI`, `~/.local/state/CLIAI` and
`~/.config/webctl` stay hidden under any re-bind that contains them (`--keep ~/.config` does not
unhide `~/.config/webctl`); `--keep` at or beneath one re-exposes that path only.

* **Refused**, naming the rule and no path: a PATH entry (FAIL) or `--keep-ro` (usage, exit 3)
  that IS the home, or contains or lies inside one of those dirs.
* **A verdict line** on stderr says what came back. ⛔ It lists by path (home-relative) ONLY what
  you named — the cwd, `--keep`, `--keep-ro`; PATH entries are COUNTED and other implicit
  re-binds named by label (review of 5773fb8: it listed ~95 PATH dirs, private repo names among
  them, and the gate tees stderr into logs):
  `isolated: home HIDDEN; re-bound read-only: ~/data, 2 PATH entries, base's repo root; writable:
  ~/work — WEBCTL_ISOLATED_VERBOSE=1 lists every path`. `WEBCTL_ISOLATED_VERBOSE=1` restores the
  full `~/…` list.
* ⛔ **A cwd at or beneath a hidden dir is REFUSED** (FAIL, the rule named, no path): it used to be
  re-bound WRITABLE there — a cwd at `~/.ssh` ran with `~/.ssh` writable (review of 5773fb8). Only
  an explicit `--keep` re-exposes a hidden dir; the read-back now exempts only those.
* A NESTED `--keep`/`--keep-ro` under the OUTER call's hidden home now says the outer call hides
  it (keep it there), not "does not exist" (still exit 3).
* ⛔ **A write CHECK on the hidden home answers `EROFS`, as a read-only home did** (gate
  regression, measured: 8 of a consumer lane's 10 gate failures). The hide tmpfs was mode 0555,
  so `access(home, W_OK)` answered `EACCES`, and a ≤ v0.32 harness nested with its markers
  stripped refused: `1 of 1 protected root(s) — the home directory — are WRITABLE here`. The
  hides are mode 0755 now, read-only by their mount; the home is recorded in `WEBCTL_RO_ROOTS`
  again. Measured: a v0.31.0 harness's stripped-markers `isolation-check` inside → PASS.
* The note for a writable re-bind inside `~/.ssh`, `~/.config`, `~/.cache`, … reads right for a
  cwd: `the working directory is in ~/.cache — re-exposed WRITABLE because the command runs
  there` (it said "at the caller's request", which only a `--keep` is).
* ⛔ **What now breaks: anything that reads the home INDIRECTLY** — git's `~/.gitconfig` (and
  commit signing with `gpg.format=ssh`, which reads the key under `~/.ssh`), ssh or git-over-ssh
  reading `~/.ssh/config` / `known_hosts`, gpg's keyring and config, shell rc files, a tool's
  own cache or config under `~/.cache` / `~/.config` / `~/.local`. Give the arm a throwaway
  `HOME` holding what it needs, or `--keep-ro` the one dir it must read.
* ⛔ **`xq`'s checkout is re-bound READ-ONLY** (gate regression, measured: two consumers'
  no-host-literals check `xq machine ls --json` went PASS → NO VERDICT / FAIL, unfixable from a
  lane under the gate). `~/.local/bin/xq` is a symlink into a git checkout elsewhere under the
  home and xq imports its `lib/` (`No module named 'lib'` with only the script). If `xq` on the
  caller's PATH really lives under the home, its git root (walk up for `.git`; none → its dir)
  is re-bound read-only, named `xq's root`. **For `xq` only** — a generic "follow PATH
  symlinks" would re-expose dozens of repos on an operator host. A root that is the home, or
  is, contains or lies inside a hidden dir is not re-bound (noted, no path).
  ⛔ **And never an `xq` a run could have planted** (measured by review: npm puts the writable
  `<cwd>/node_modules/.bin` on PATH; a planted `node_modules/.bin/xq -> <any repo under the
  home>/<an executable>` made the NEXT run re-bind that repo — hidden → 11 entries visible).
  The first `xq` on PATH is ignored (`xq ignored: found in a writable location` / `…: not named
  xq`, by label) when its PATH entry, any link of its symlink chain or its real file lies in the
  cwd, a `--keep` / `--keep-ro`, `/tmp`, `TMPDIR`, `/var/tmp` or `/dev/shm`, or its real file is
  not named exactly `xq`.
* A PATH entry that reaches the home through a symlink OUTSIDE it is re-bound at its real path
  only. Cost measured on the operator host (~100 PATH entries under the home): `isolated --
  true` 1.29 s → 1.46 s.
* Read back from mountinfo by RESOLVING each path through the mount tree, so a later mount on
  an ancestor that shadows a hide is caught (review finding 7). A nested `unshare -rm` cannot
  peel the hide (tested).

### ⛔ PATH never picks the binary a PRIVILEGED half runs

Measured by the re-review: a fake `ip` in the cwd + `PATH=":$PATH" isolated -- true` → the fake
ran as namespace root, CapEff full, **before the masks**, listing the real home. `ip`, `mount` and
`setpriv` were run by name (the caller's PATH, empty and relative entries included); `unshare` and
pid 1's `bash` by PATH too. The cwd is writable inside, so a mutated test plants `./ip` — or
`node_modules/.bin/ip`, a dir npm PREPENDS as an absolute path — and the NEXT run executes it
privileged. Here, before the fix, a planted fake ran on every path tried: fresh (`unshare`, `bash`,
`ip`, `mount`, `setpriv`) and nested (`setpriv`, `unshare`, `bash`).

* ⇒ **Every tool a privileged half runs comes from `/usr/sbin`, `/usr/bin`, `/sbin`, `/bin` only**
  — `unshare`, `bash` (pid 1), `mount`, `ip`/`ifconfig`, `setpriv` — resolved ON THE HOST before
  `unshare` and passed on as absolute paths; the privileged halves' own `PATH` is that list.
  `WEBCTL_UNSHARE_BIN` stays the one explicit override. A tool in none of them → FAIL naming the
  tool (and the dirs), nothing run. **The command still gets your PATH, unchanged.**
* ⚠ A host whose util-linux, bash or iproute2 live ONLY elsewhere (e.g. under `/usr/local`, or
  a Nix profile) now fails closed; `WEBCTL_UNSHARE_BIN` covers `unshare` alone.

### pid 1 is `bash --norc -p`, and reaps orphans (fresh and nested paths)

* node as pid 1 left a re-parented, exited grandchild as a **zombie** (state `Z`, `kill -0`
  succeeds), so "my daemonised helper is gone" failed only under `isolated`. pid 1 is now a
  small **bash** that runs the node half in the background, forwards INT/TERM/HUP and exits
  with its status; the orphan disappears (measured, on both paths). **`bash` must be in the system
  dirs** (above), else FAIL, nothing run.
* ⛔ As `bash -c` it honoured the CALLER's shell config as pid 1 — with every namespace
  capability, before any mask (review): a `BASH_ENV` script ran; `SHELLOPTS=xtrace` traced it;
  an exported `wait()` replaced it; `SHELLOPTS=errexit` + TERM killed the namespace before the
  command's trap (143, not its 7). And with `SHLVL` unset and stdin a socket, bash sourced
  `~/.bashrc` as if rshd had started it. ⇒ `--norc -p`. A HUP arm is added.

### ⛔ A signal before the command starts is no longer lost

The old comment said "a signal before the child exists ends pid 1, nothing starts". Measured
false by the review: a TERM sent the moment unshare's child appeared was **lost** in 24 of 40
runs (v0.32.0: 15/40) — pid 1 ignores a signal it has no handler for until bash has trapped —
and the command **ran to exit 0** after the caller gave up. Here: 4/40 fresh, 40/40 nested.
⇒ Until the half under pid 1 reports `started`, a forwarded signal SIGKILLs unshare (the
namespace dies with it) and `isolated` **dies by the signal** — fresh and nested. Arm: 8 runs
per path with pid 1 held trapless for 300 ms; 0 lost.
* And every node half now installs its signal forwarder BEFORE its child exists (a signal before
  the spawn is buffered, then delivered): the inner half and the pid-1 helper each had a gap with
  no handler at all, where a TERM killed the half outright and the command was SIGKILLed with its
  trap unrun (review of 5773fb8). Pinned by a logic arm; the gap is too narrow to hit from outside.

### Host policy: AppArmor, and `WEBCTL_UNSHARE_BIN`

* On a host with `kernel.apparmor_restrict_unprivileged_userns=1` (Ubuntu ≥ 23.10; reported
  from 24.04) an unprivileged `unshare -r` fails with uid_map `EPERM`. The refusal now says it
  is a **HOST-POLICY fault, not the lane's**, and gives the fixes: `sysctl -w
  kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile granting `userns,`
  to a dedicated copy of `unshare`.
* **`WEBCTL_UNSHARE_BIN=<absolute path>`** names that binary; `isolated` uses it for EVERY
  unshare (outer, privilege drop, nested). It must be an absolute path to an executable regular
  file — else FAIL naming the rule. Re-bound read-only inside.

### Nesting

* **Version skew:** a v0.33 call nested under a ≤ v0.32 outer is still refused (exit 2, the
  outer recorded no `WEBCTL_HIDDEN_DIRS` and hid nothing) — the message now says **upgrade the
  outer**, rather than looking like a forged marker.
* **Stripped markers** (`env -u WEBCTL_…`, `env -i`) inside `isolated`: measured to isolate
  AGAIN, fully (fresh path: its own netns and pidns, the home hidden again), never "only
  inherited"; the verdict line says `ALREADY INSIDE … isolated AGAIN, fully, keeping what the
  outer call re-bound (same modes)`.
* ⛔ **…and it KEEPS what the outer call re-bound** (gate regression, measured by the lead on the
  release gate): hiding the home again made the paths the OUTER call had re-exposed — the
  consumer repo and run home the gate keeps, the outer's cwd — vanish; a consumer suite failed 8
  tests `Cannot find module '<repo under ~/.cache/…>/tools/isolated-run.mjs'` (v0.32 hid nothing,
  so it did not break). When the KERNEL proves the outer sandbox — our tmpfs on `/run` and
  `/tmp`, our read-only hide AT the home, a lo-only netns, a mapped uid_map — every mount a path
  lookup reaches under the home or `/tmp` is re-bound with its SAME mode (rw stays rw, ro stays
  ro); counted in the verdict as `N outer re-binds`. Never wider: only what is visible inside,
  never a parent, the hidden dirs hidden again; an outer re-bind AT **or WITHIN** a hidden dir
  is not carried (noted by count; `--keep` it again — review F2: one strictly inside, an outer
  `--keep ~/.ssh/<sub>`, was carried writable, silently). Without the proof nothing is carried.
* A read-only re-bind at a path where the outer call already had a mount (base's root, when the
  outer's cwd was base's root) was FALSELY reported "still WRITABLE" — the outer's stack, shadowed
  by the re-masked `/tmp`, was checked too. Only the stack path resolution reaches is checked now.

### ⛔ What this does NOT cover

* ⛔ **What a re-bind brings back is visible — and EVERY PATH dir under the home is re-bound.** A
  secret inside the cwd, a keep, a PATH dir (a `~/bin` holding a token file, a repo checkout on
  PATH) or base's root — other than the six hidden dirs — is readable. A profile or config
  OUTSIDE the home (and not via a symlinked dot-dir) is not covered at all.
* *Planned for v0.34.0 (ib4k shared arm set):* `/var/tmp` and `/dev/shm` are writable and shared
  with the host; the host's session keyring is shared (`keyctl show @s` lists it, possessor
  `alswrv`); there is no UTS namespace (the hostname is visible); `/sys/class/net` (interface
  names and MACs) and `/etc/machine-id` are readable.
* `--kill-child` relies on util-linux closing its fork/`PR_SET_PDEATHSIG` race: ≥ 2.39 polls a
  pidfd of the original parent after the prctl and exits if it is gone (read in its source).
  On 2.38 — the minimum, for `--map-user` — a SIGKILL to unshare in that window can leave pid 1
  orphaned; if the harness died too, the inner half's `started` write then fails (EPIPE) and
  nothing runs, but one that already started runs unsupervised.
* The signal-forwarder ORDERING (finding 5 above) is reasoned and logic-tested, not hit end to
  end.
* `runCommand` fails cleanly when spawn throws synchronously (an argv node refuses, E2BIG): it
  rejected with a stack trace and left its signal forwarder installed. It — and its async
  `'error'` — now exit **1** (the harness's FAIL), not 127: argv[0] there is the isolation
  chain, and 127 reads "command not found" (review F3; the fresh path's unshare spawn already
  failed 1). The pid-1 helper that spawns the COMMAND had no catch at all: an env var over
  128 KiB (MAX_ARG_STRLEN; the env pipe has no such limit) → E2BIG rejected it — now FAIL, 1.
* Fixed (pre-existing): a signal landing as the command exited could LOSE its exit status —
  `127` (`wait: pid 2 is not a child of this shell`) or `143` instead of the command's own
  code; 1 of 150 under load with TERM ×3, ~8% with a 1 ms burst. A bash race: the blocking
  `wait` reaped the child as a trapped signal arrived and returned before recording its status.
  pid 1 now never blocks in `wait` while a signal can arrive: it polls (`kill -0` + a 20 ms
  fork-free `read -t`), lets bash's SIGCHLD handler reap, then ignores INT/TERM/HUP for one
  final `wait`. About 6 ms more per `isolated` call; no newer bash required.
* Fixed (pre-existing): TERM ×3 in quick succession after the command's trap came back **143**
  instead of the trap's code (measured: 9–10/25 with the TERMs 60 ms apart). A late TERM killed a
  node half during its own exit, after it had dropped its forwarder. Now 150/150 return the
  trap's code.
* `WEBCTL_RO_ROOTS` and `WEBCTL_HIDDEN_DIRS` are recorded input; the other nesting facts still
  require a real masked namespace.
* The AppArmor message is tested by its logic (the sysctl path is a parameter), not end to end.

## v0.32.0 — 2026-10-03

**Headline: base drives only a tab base opened — `openPage()` / `navigate()` MINT a
background tab by default and never drive the human's tab unless told whose it is**
(`v7x3` §"base drives only a tab base opened"). Plus: an option a CDP factory does not
honour is REFUSED, naming it, never silently dropped.

### ⛔ BREAKING — `openPage()` no longer reuses the first page target

*Incident, 2026-10-03:* `openPage()` took `listPageTargets()[0]` → `reused: true`, and a
consumer's mutation arm navigated the human's ONLY tab in a signed-in browser. The tab a
person is reading is, by construction, the first page target. The old decision 1, "reuse
before minting", was right for an unattended browser and is superseded.

| caller passes | `openPage` does | `reused` | `close()` closes the tab |
|---|---|---|---|
| nothing (the default) | **mints a new target, in the background** | `false` | yes, unless `keep: true` |
| `{targetId, owner: 'minted'}` | drives it only if `ownedTargets.has(targetId)`; else refused | `true` | no, unless `close: true` |
| `{targetId, owner: 'adopted'}` | drives a tab base did NOT mint, for this call only | `true` | **never** |
| `{targetId}` with no `owner`, or any other value | **refused**, naming both choices | — | — |

* **Mint:** `Target.createTarget({url, background: true, newWindow: false})` over the
  browser endpoint — no `browserContextId` (a fresh context lacks the sign-in). Fallback:
  `/json/new` PUT, then GET. Both dial the caller's **rewritten** authority, never the raw
  one `/json/version` prints from behind an ssh forward. ⚠ `/json/new` has **no background
  flag**: on a build where only the fallback works, the new tab may take focus in the
  person's window.
* **If both mint paths fail, `openPage` REFUSES** with the opt-in hint
  (`{targetId, owner: 'adopted'}`). It never falls back to an existing tab.
* ⛔ **`/json/new` is tried only when nothing can have been minted**: the browser endpoint
  was unreachable before the request left, or `createTarget` got an explicit CDP ERROR
  reply. A LOST reply (timeout, dropped socket) is refused, saying a tab may have been
  created — a fallback would mint a second tab and orphan the first. CDP error replies
  now carry `err.cdpError` (`{code, message}`).
* **`ownedTargets`** (any object with `has(id)`; a `Set` works) defaults to the ids THIS
  process minted. A lane with a durable ledger passes its own. Adopting never adds to it.
  ⛔ Only a literal `true` from `has()` vouches; a `has()` that returns a Promise (an async,
  db- or file-backed ledger) is REFUSED — a Promise is truthy and would vouch for any id.
  Resolve the ledger first (e.g. into a `Set`).
* A reused target must exist and be a `page` with no `subtype` (checked on
  `Target.getTargets`); otherwise refused, naming the id. A `subtype`'d page (a prerender) is
  not a tab, and does not count toward the last-page rule either.
* **`onMinted(id)`** is awaited after the mint and BEFORE the first attach. If it throws,
  the tab is closed (or blanked, if it is the last page) and `openPage` refuses, carrying
  the hook's error (`cause`). Likewise, if the first ATTACH to a minted tab fails, the error
  names the id and its fate: kept open (`keep: true`), closed, or NOT closed with the reason.
* **`close()` is now on `openPage()`'s result too**, and returns `{closed: true}` or
  `{closed: false, reason}` with reason `'keep' | 'owned-reuse' | 'adopted' | 'last-page' |
  'not-a-tab' | 'close-failed'` (`'not-a-tab'`: our target is still there but now carries a
  `subtype`, so it is left, never reported closed). ⛔ **The LAST page target is never closed** — closing it exits Chromium;
  it is navigated to `about:blank` instead (`reason: 'last-page'`). "Last" is read from the
  browser endpoint at close time. Closes of our own tabs are serialised per browser
  authority within a process (the loopback spellings `localhost`, `127.0.0.1` and `[::1]`
  count as one authority). ⚠ A person or another process closing a tab in the same
  instant is a residual race: the read and the close cannot be made atomic.
* `navigate(base, url, opts)` passes `targetId` / `owner` / `ownedTargets` / `keep` /
  `close` / `onMinted` (and now `defaultTimeout`) through, returns `openPage()`'s result,
  and closes a minted tab if the navigation itself fails.
* No "this tab is blank, so it is free" heuristic, anywhere.

**Migration.** A caller that uses `openPage()` only to get a session for BROWSER-level
calls (e.g. `Storage.getCookies`) must switch to `connectBrowser()`. Under mint-by-default,
every such call would otherwise open, and possibly leave, a blank tab.

Where reuse was meant, say whose tab it is: record the id from a `keep: true` mint (in
`onMinted`), pass your ledger as `ownedTargets`, and reuse with `{targetId, owner:
'minted'}`. Lanes adopt this deliberately: it changes what a signed-in browser shows.

### ⛔ BREAKING — what `openPage()` / `navigate()` need from the endpoint, and return

* **`openPage()` now needs the BROWSER websocket on every path**: `/json/version` and its
  `/devtools/browser/…` socket, for the mint (`Target.createTarget`), for a reuse
  (`Target.getTargets`) and for `close()` (the page count and `Target.closeTarget`). Before,
  it needed only HTTP `/json` and `/json/close` plus the page socket. A forward or proxy that
  exposes HTTP and page sockets only used to work and now fails: the mint falls back to
  `/json/new`, but a reuse is refused and `close()` returns `'close-failed'` (tab left open).
* **`navigate().close()` closes through `Target.closeTarget`** (not `closePage`'s
  `/json/close`) and returns a `CloseResult` instead of `undefined`.

### ⛔ BREAKING — unknown options are refused

`openPage`, `navigate`, `connectBrowser` and `listTargetsCorroborated` throw a
`TypeError` naming any option key they do not honour. Measured by `ccew`:
`connectBrowser({readOnly: true})` returned an ordinary session that still sent
`Storage.getCookies` — a guard that looked applied. A stale `openPage({reuse: true})` is
now told so. Contradictory combinations are refused too: `keep` + `close`, `close: true`
on an adopted tab, `onMinted` or `owner` without a mint/`targetId` respectively.

* ⛔ **BREAKING: the `CdpSession` CONSTRUCTOR refuses unknown option keys too** (honours
  only `defaultTimeout`, `WebSocketImpl`): `new CdpSession(url, {readOnly: true})` returned
  an unguarded session that looked guarded. A subclass must strip its own keys before
  `super()` *(raised by `webctl:mgr`)*.

### Tests

* `test/cdp-open-page-own-tab.test.js` (29 tests): the nine `v7x3` QA arms and the ten
  added after review (`v7x3` QA 10–19: async `has()`, a lost `createTarget` reply,
  concurrent closes and two loopback spellings, prerender ×2, present-but-not-a-tab, the
  attach-failure fate, the `CdpSession` constructor, refused combinations), each with its
  control, against a recording fake CDP browser (`test/helpers/fake-cdp-browser.mjs`:
  ephemeral ports, a trap that records any dial of the raw authority, a delayed
  `getTargets`, a lost `createTarget` reply, refused attaches, `subtype` targets).
* `test/cdp-client-lifecycle.test.js`: arm 1 ("an existing page is REUSED") and the
  reuse half of arm 3 asserted the old default; both now assert the new one.

### Harness and gate (since v0.31.0)

* **`isolated` also unsets `XDG_{CACHE,CONFIG,STATE,DATA}_HOME`.** base's storage paths prefer
  them over `$HOME`, so a test that set a temp HOME but inherited one resolved to the REAL
  dirs (`perplexity`; a sibling lane's suite wrote and deleted the human's real tab ledger and
  captcha lock through the same class of mistake). `v59v` §4 now states the rule for tests.
* **A nested `isolated` gets its own PID namespace.** Its command cannot see or signal the
  process that called it. Before, two lanes' "a pid outside cannot be signalled" arms failed
  only under the gate, where their `isolated` was nested in the gate's (the host stayed
  hidden; the caller did not). Network and masks are inherited, locked.
* **xq inside `isolated`:** with xq ≥ f9a7bad and `UV_NO_CACHE=1`, `xq machine ls --json` runs
  inside, so a no-host-literals check need not weaken under the gate (harness README).
* **Gate:** an unwritable scratch root is a named setup FAIL (it used to attempt a clone at the
  filesystem root); orphaned clones (their gate is gone, by pid + start time) are pruned at
  start, a live gate's clone never; the gate's own tests wait by a deadline, not a 10 s count,
  so they hold under a heavily loaded host.

### Docs — a correction to the v0.31.0 entry

* the v0.31.0 entry said the home-under-/run-or-/tmp refusal applies under an outer
  `unshare -r`; it applies on the host path too (a CI image whose passwd home is under /tmp
  is refused). This is v0.31.0 behaviour, not new code.

### ⛔ What this does NOT cover

* The per-method **policy hook** (`v7x3` §"An option the library does not honour is
  REFUSED") is not implemented — only the refusal of unknown keys is.
* `closePage(base, id)` is unchanged: a low-level primitive with no ownership check and no
  last-page rule. Use the `close()` that `openPage()` / `navigate()` return.
* Unknown-key refusal covers the four factories above, not `getVersion`, `listTargets`,
  `listPageTargets` or `listTargetsViaBrowser`.
* ⚠ **An HTTP-only forward leaks a tab per mint.** Without the browser websocket each mint
  goes through `/json/new`, but `close()` cannot read the page count and returns
  `'close-failed'`, leaving the tab open — safe (it never closes a last page), but a long run
  piles up tabs. Use a forward that exposes the browser websocket (`/devtools/browser/…`).
* Nothing here was run against a real browser; the arms use a fake that implements only
  the CDP surface listed in its header.

## v0.31.0 — 2026-10-03

**Headline: the docker driver never touches, reuses or restarts a container that is not
proven ours — and upgrading base never restarts a running signed-in browser.** Plus **the
harness no longer lets a consumer's tests reach the host** (mutation arms and the release
gate run with no host network and no host unix sockets), the engine vocabulary, base's
reader of xq's capabilities, and the design that makes **xq the runtime layer** (`rx9q`).

### ⛔ BREAKING — container names carry the owner

The driver named containers `<prefix>chromium-<slug>` / `<prefix>xpra-<slug>` with no owner,
and force-removed and stopped them by that name. On a shared docker daemon, two accounts
running the same tool with the same slug (the default is `default`) would remove or DRIVE
each other's signed-in browser. Inherited from the early xq the driver was adapted from
(xq's lane traced it, reading xq as it stood at the fork commit).

| old | new |
|---|---|
| `<prefix>chromium-<slug>` | `<prefix>u<uid>-chromium-<slug>` |
| `<prefix>xpra-<slug>` | `<prefix>u<uid>-xpra-<slug>` |
| `<prefix>x11-<slug>` (volume) | `<prefix>u<uid>-x11-<slug>` |
| `<prefix>net-<slug>` | `<prefix>u<uid>-net-<slug>` |

* **Proof of "ours" is what a container MOUNTS**: a chromium is ours only if a bind-mount
  Source is our resolved profile path; an xpra only if its same-slug chromium is ours. The
  new owner label is a FILTER (another uid → not ours), never proof alone.
* Every rm / stop / **reuse** goes through that proof; a container not proven ours is
  refused (exit 4) — never removed, never stopped, never driven.
* **What happens after a lane bumps:** on the first **`ensureRunning()`** (never on a read
  — `healthCheck`, `describe`, `inspect` never mutate), a running browser in a
  pre-owner-named container is **renamed in place** (`docker rename`) — it keeps running,
  same container, same CDP URL, NOT restarted — and its profile lock is rewritten to the new
  name. One info line says so. `shutdown()` stops a pre-owner pair under its old names
  (renaming it first when it can), never removes it. A partial pre-owner pair, or a migrated pair whose CDP does
  not answer, is REFUSED with instructions, never repaired by a restart.
* Bring-up and shutdown are serialised per PROFILE (process mutex), so two commands at once
  cannot both migrate one profile.
* New consumer-facing API: `mounts.names(slug, base, uid)` (uid defaults to the process),
  `names().owner`, `mounts.legacyNames(slug)`, `docker-ctl.rename`, the driver's `opts.uid`
  and **`opts.attachOnly`** (ensureRunning/shutdown refuse before any docker call — lanes pass
  it from resolveTarget's `attachOnly`), `inspect().names` reports the new names.

### Added

* **Engine vocabulary** (`nl0c` §1c): `firefox` is a valid `app`; `ENGINES`,
  `ENGINES_PENDING = ['firefox']` (base's WebDriver BiDi backend has not shipped — Firefox
  removed CDP in v141), `resolveEngine` with the fixed codes `no-engine`, `invalid-engine`,
  `engine-conflict`, `engine-pending`; `targetEnvKey(tool, 'engine')`;
  `resolveSharedTarget(...)` — the shared-config glue two lanes had each hand-written.
  No message prints the user's home path (`SHARED_CONFIG_DISPLAY`). ⚠ `resolveTarget`'s human
  `reason` for the shared layer now reads "from the shared config (~/.config/webctl)" (it was
  the fragment "from the shared"). Match on the machine field `source` (still `'shared'`),
  never on the reason text.
* **`runtimeXq`** — base's reader of `xq capabilities --json` (`rx9q` §4): fail-closed on the
  schema and malformed known fields, tolerant of additive fields; `hasVerb`, `controlFor`
  (`null` = UNKNOWN, `[]` = NONE), and **`hasFlag`** — never send a flag the target xq does
  not list (an older xq passes unknown flags to the APP with exit 0; an xq without a `flags`
  field is too old to vouch → refused). Pin capabilities, never `xq --version`.
* `docker-ctl.createDockerCtl({dockerHost})` — the same interface bound to a remote daemon.
* **The driver REFUSES a remote docker-ctl** (one carrying `dockerHost`) at construction,
  exit 4, with zero docker calls: its paths, uid, port check, prefs and lock are local, so a
  remote bring-up would run half-local (measured by `webctl:mgr`). Remote browsers run
  through xq (`rx9q`).

### Added — the harness and the gate (`xrl4`)

* **`contract-harness.mjs isolated [--keep <dir>]… -- <cmd…>`** runs `<cmd>` in private
  user, network, mount and PID namespaces:
  * The only network interface is its own `lo`, which is brought up.
  * There is a fresh tmpfs over `/run` and `/tmp`. The cwd, a `$HOME` under /tmp and
    `--keep <dir>` are bound back WRITABLE. Base's repo, node and the command are visible
    READ-ONLY when they live under /tmp or the home (as in the gate), so a mutant cannot
    change the base that the next consumer is judged against. Elsewhere they keep their
    normal permissions, and base's repo is writable when it is the cwd.
  * Host path sockets that are still reachable are masked.
  * The user's home directory is READ-ONLY, except the kept paths.
  * The command runs as the REAL uid and gid (a real uid of 0 is refused), in a child user
    namespace that has
    no mount namespace of its own. So it holds NO capabilities over the masks and cannot
    unmount or remount them. Inherited mounts are locked even in a namespace it nests
    itself. The no-new-privs bit is set, which blocks setuid binaries. A probe run through
    the same prefix before the command starts must read back zero capabilities, the real ids
    and exact single-line uid/gid maps, or the run is refused.
    ⇒ **Nested namespaces still work**: a lane that self-isolates with its own `unshare -rn`
    can bring its own `lo` up, and Chromium's sandbox starts. An earlier design that dropped
    every capability from a namespace root broke both (measured on the first real gate run:
    since Linux 5.12, mapping the parent's uid 0 needs CAP_SETFCAP).
  * It has its own PID namespace, so host processes cannot be signalled, and anything it
    leaves running dies with it. A signal forwarded to it is re-raised, so the caller sees
    the command die BY that signal (a Ctrl-C is never an ordinary exit 130).
  * Called inside a lane's own `unshare -r`, it resolves the REAL uid and home from the
    kernel's uid/gid maps and the passwd database (`getent` by absolute path, cross-checked
    against `/etc/passwd`), accepting a home only if the kernel shows it owned by us. It
    refuses when it cannot resolve them, when there is no passwd entry, when the two sources
    disagree, or when the home lies under /run or /tmp (it would protect nothing).
  * A tool that writes under the home (e.g. npm's `~/.npm/_logs`) gets EROFS. npm itself
    carries on with one warning line; point `npm_config_cache` under `/tmp` to keep its logs.
  * DISPLAY, WAYLAND_DISPLAY, SSH_AUTH_SOCK, DBUS_SESSION_BUS_ADDRESS, DOCKER_HOST and
    XDG_RUNTIME_DIR are unset, and TMPDIR=/tmp.

  **Fails closed**: there is never a fallback to the host. "Already inside" is proven from
  the kernel (namespace ids, uid_map, interfaces, mounts); an env marker alone is refused.
  Why: twice on 2026-10-03 a consumer's mutation control reached a live signed-in browser.
  Separately, `unshare -rn` alone was measured still reaching the docker socket. And the
  final review measured that a command left as namespace root could unmount every mask.
  Companions: `isolation-check <port>…` (a precondition run inside: the real port must give
  exactly ECONNREFUSED, and a self-made fake must answer); `sandbox-port`; `guard-live-port`.
* **Harness generation 5**: the `no-revendor` check counts a same-named file as a shim only if
  it actually imports THAT base module (a lexer, not a regex: comments, strings, templates,
  regex literals including after `break`/`continue`/`debugger`, Unicode identifiers).
  Contracts that `require-generation 4` keep working; `require-generation 5` gets the fix.
* **Gate `--against-head --scratch`** — the recommended pre-release arm. Each wired consumer
  is cloned at its committed HEAD, OUTSIDE /tmp (`WEBCTL_GATE_SCRATCH_DIR`, default
  `${XDG_CACHE_HOME:-~/.cache}/webctl-base/gate-scratch`, because lanes mask /tmp in their
  own sandboxes), with the live tree's INSTALLED `node_modules` copied in (not a fresh
  `npm ci`; an `npm link` symlink inside still points at its live target, which is read-only
  under the home and masked under /tmp), and base's
  candidate is placed in the clone's submodule.
  The contract runs there under `isolated`, with a throwaway HOME. **A change to the live
  tree BLOCKS:** its git-visible state (HEAD, submodule HEAD, `git status`) is fingerprinted
  before and after. Gitignored files (`.env`, profile or state dirs) are NOT covered. A live
  tree under the home dir is read-only from inside, so it cannot be written; a live tree
  elsewhere can be, and an ignored-file write there goes unseen. A live tree with
  uncommitted tracked changes → SKIP, because the commit is not what runs. Isolation
  unavailable → a GATE-ENVIRONMENT fault, never a lane FAIL. Why: some live trees are what
  unattended timers run from, so the in-place swap could run an untested candidate.
* **The gate keeps every run's logs** in its own never-reused directory
  (`WEBCTL_GATE_LOG_DIR`, default `${XDG_STATE_HOME:-~/.local/state}/webctl-base/gate-logs`,
  mode 700): one log per consumer plus the whole run.

### Docs

* `rx9q` — **the runtime layer is xq**: xq runs the app up to a declared control port; base
  speaks CDP/BiDi above it. Capability-pinned, fleet-required via a run-time check. Asks
  X1–X17 to xq; most have landed.
* `rb7s` — remote bring-up over ssh: phases 2–3 SUPERSEDED by `rx9q` (§1's survey of the
  driver's ten local assumptions stays valid).
* `bd1x` — the WebDriver BiDi client spec, with four constraints measured on Firefox 156.
* `v7x3` + `k3wn` — an option a library does not honour is refused, never ignored (to be
  implemented in cdp-client next).

### ⛔ Lanes: anything that looks a container up by its OLD name now finds it ABSENT

A guard keyed on a container name (e.g. "the protected browser is unchanged") then passes
**vacuously** — it reads "not running" before and after. Get names from `describe().names`.
Measured exposure (`webctl:mgr`, git grep at each lane's HEAD): **ccew** HIGH (tool scripts
hard-code `ccew-xpra-$SLUG` / `ccew-chromium-$SLUG`); **linkedin** (a test asserts the old
names; a QA guard is keyed on the old name — vacuous after the rename); **chatgpt** (a test,
README commands); **substack** (AGENTS.md commands). xq-zone lanes and the new lanes: none.
⚠ Read paths do not yet report a pre-owner pair (`describe().names` shows the new names
while the live pair has the old ones) — `inspect().legacy` comes in the next release.

### ⛔ What this does NOT cover

* A runner still on an OLDER base takes no mutex; a few milliseconds of race remain against it.
* A pair that was NEVER migrated is still recreated when its CDP is unreachable or only one of
  its containers runs (pre-existing behaviour).
* The process mutex treats a holder with pid 1, or one in another pid namespace, as dead; its
  10-minute timeout message assumes the dead holder's pid is not reused.
* A uid in the name identifies the owner on ONE docker daemon; two machines whose users share a
  uid are not distinguished (remote containers move to xq per `rx9q`).
* Firefox is still `ENGINES_PENDING`: the BiDi client is specified (`bd1x`), not built.
* cdp-client still ignores unknown options (the rule is written; the code is next).
* `isolated` covers what a lane RUNS UNDER IT. A lane's arm that is not wrapped is not
  isolated; adopting it is each lane's change. It needs unprivileged user namespaces, and
  where they are off it refuses rather than bypassing. **Host unix sockets it does NOT
  mask:**
  * sockets created on the host after the arm starts;
  * sockets bound in another network namespace (e.g. a rootless container's volume), which
    are absent from the host's `/proc/net/unix`;
  * sockets bound by a RELATIVE path, whose location cannot be known;
  * a masked socket the host unlinks and re-creates while the arm runs.
  * sockets under an explicit `--keep` path: those paths are exempt from the check, by
    design (the gate keeps only its own throwaway HOME).

  Paths under `/run` and `/tmp` are covered whatever their kind, because those trees are
  replaced, not checked. ⚠ Outside the home dir, `/run` and `/tmp`, the rest of the
  filesystem keeps its normal permissions (e.g. `/var/tmp`, `/dev/shm`).
* The read-only "home" is the passwd home of the real uid. Two or more stacked
  `unshare -r` levels cannot be resolved from inside, so that case is refused, as is an
  account with no passwd entry (a CI container running an arbitrary uid must add one).
  Browser profiles kept outside the home dir are not covered,
  unless reached through a dot-dir (`~/.cache`, `~/.config`, …) that is ITSELF a symlink out
  of it. A deeper symlink (`~/.cache/<tool>` pointing elsewhere) is not covered.
* A command under `isolated` cannot bind ports below 1024 on the isolated namespace's own `lo`
  (a network namespace it nests itself is its own, as intended).
* The gate's default and plain `--against-head` modes are NOT isolated and still swap in
  place; only `--scratch` gives both guarantees.
* **openPage() currently drives the first existing tab; v0.32.0 changes the default to a new
  target.** Callers that rely on reuse will have to ask for it by target id. Grep your
  `openPage` callers now.

## v0.30.0 — 2026-10-03

### ⛔ BREAKING (for v0.29.0 adopters) — the shared default is the LOWEST layer

* `loadSharedWebctlConfig().configLayer` is now **`{source: 'shared', …}`** (was
  `'config'`), and `resolveTarget` ranks **flag > env > config (the lane's own) > shared**
  (nl0c §1b). In v0.29.0 the shared default sat AT the lane-config rank. A lane wiring it
  beside its own configured target would have raced them, and a signed-in lane would have
  followed the family default to a machine with no profile and no login (raised by
  `webctl:mgr` before any existing lane wired it).
* **A record is whole, never merged.** The resolved name selects one file's record; a
  lane's partial record never inherits from the shared default.
* ⇒ **The two lanes started this morning on v0.29.0** should take v0.30.0 before wiring:
  their code should not compare `source` against `'config'` for the shared layer.

### Added

* `TARGET_KNOBS` gains `shared`: a lane can name `~/.config/webctl/config.toml` in its
  no-target refusal. The generic text is unchanged.

## v0.29.0 — 2026-10-03

**Headline: one loader for the shared `~/.config/webctl/` (nl0c §1a).** Greg: every
lane "sources from shared ~/.config/webctl/", with a declared default browser host.

### Added

* `sharedConfig.loadSharedWebctlConfig({home})`. It reads `config.toml`
  (`default_target`) and `targets/<name>.toml`, and returns the default as a **config
  layer** for `resolveTarget`, so a stated flag or env still wins, plus every valid record
  and an error per bad file.
  * A file wider than mode 600 is refused, not read.
  * A record failing `validateTarget` is refused, naming the key, never the value.
  * A `default_target` naming no valid record, and an unknown key in `config.toml`, are
    errors.
  * No directory is an ordinary state: no default, and the loader **never creates** it
    (tests prove no write).
* `sharedConfig.parseTomlSubset` — `key = "string" | integer | bool | ["str"]` and
  comments; anything else is refused with its line number. Zero dependencies.

### ⛔ What this does NOT cover

* **It does not make a lane use it.** Each lane must call it and feed `configLayer` to
  `resolveTarget`. Lanes that today read a per-tool config only are not switched over by
  this release.
* The record says WHERE (`ssh`, `kind`); reaching it — the ssh transport and running the
  driver remotely — is still per lane (btg4 §5, rm7t §7 "remote build for base-driver
  lanes" is open).

### Also in this release (from v0.28.0 adopters)

* `run-tests-strict`: a caller's own stdout reporter is kept and the runner adds none, so
  TAP streams once; `--tap`/`--spec` beside one is refused (exit 3, "replace, don't add").
  Each stdout reporter repeated every test, which double-counted in the gate's scan
  (`substack`). README: a visibility guard measures the contract's STDOUT, not its log
  (`grok`).

## v0.28.0 — 2026-10-02

### Added — `run-tests-strict` compatibility (from `linkedin` and `gemini`)

* **`--serial`** = `--test-concurrency=1`, and it wins over an earlier concurrency flag.
  node runs test files concurrently; suites that spawn processes or take lock dirs collide.
* **`--allow-plain-scripts`** for direct-script suites (asserts, no node:test). v0.27.0
  failed every such file as EMPTY, because it is indistinguishable from a file that
  registered nothing, and linkedin has 32. The flag accepts them at the cost of the
  empty-file guard for that run. A non-zero exit and a vanished `describe()` still fail;
  an inherited env var cannot enable it.

* ⛔ **`--tap` — REQUIRED in a gate contract.** On `gemini`'s and `substack`'s suites,
  v0.27.0's runner printed **zero TAP lines** to stdout (spec default), which would leave a
  contract green locally and dark to the gate's line scan. Both lanes measured it, kept TAP
  visible by passing the reporter through, and reported it. ⚠ The default stays **spec**. A candidate of this release
  flipped it to TAP, and the gate went red on `fetlife`, whose contract parses spec's
  `ℹ tests N`. That broke the rule this repo wrote the same day: a change must not alter
  what an existing caller already gets. Visibility is therefore a documented required flag,
  and a contract should FAIL if no TAP line streamed.
* A run of **only** `skip`/`todo` tests fails as "ZERO tests ran"; a placeholder-only
  file run alone goes red on adoption (`chatgpt`, `substack`). Documented.
* A file pattern that matches **nothing** fails with a message naming the pattern (plain
  node exits 0). Base's `*.test.*` glob is base's: lanes pass their own (`gemini` names
  files `*-test.js`).

### Fixed

* **Gate false red (v0.27.0):** spec lists failing **TODO** tests under `✖ failing tests:`
  even at `fail 0`, and the gate matched the header alone. Every lane with deliberate
  failing TODOs read FAIL at exit 0 (`ccew`, whose prompt-injection todos fail by
  design). ⚠ The first fix (exempt entries ending `# TODO`) was itself wrong, and the next
  gate run showed it: **a TODO with a reason prints `# <reason>` INSTEAD of `# TODO` in
  spec** (TAP keeps `# TODO <reason>`), so spec text cannot identify a TODO at all. Now:
  the strict reporter's own verdict, when present, is authoritative (it reads events);
  a strict failure verdict in a run that exited 0 is a FAIL (the contract swallowed it);
  and without it, more `✖` entries than the summary's `ℹ todo N` is a FAIL.
* The strict reporter printed its "a describe() threw while registering" hint on every
  failure; the first gate run that exercised it showed it misdirecting on an ordinary
  failing test. It now appears only when a suite failed.

### ⛔ What this does NOT cover

* ⚠ **v0.27.0's runner fails direct-script suites.** A lane with them must use v0.28.0's
  flag (or keep its own runner) before switching.
* Tested on a box reporting `availableParallelism() = 1`; the tests force concurrency so
  both arms are falsifiable here, but multi-core behaviour was not run.

## v0.27.0 — 2026-10-02

**Headline: a green exit is not a green run.** node:test lets a `describe()` that throws
while registering vanish: `not ok`, `# fail 0`, exit 0 (node v22, reproduced; found by
`chatgpt`). Zero-test guards miss it, because the tests that did register still count.

### Added

* `scripts/strict-reporter.mjs` + `scripts/run-tests-strict.mjs`. They fail on any
  failure EVENT (TODO/SKIP excepted), including a vanished suite. They fail a test file
  that registers zero tests (node counts it as a pass), and they strip `NODE_TEST_CONTEXT`
  for nested runs. One implementation for the family; lanes with their own runners
  (`grok`, `chatgpt`, `fetlife`, `gemini`) can fold into it.
* **Release gate:** a contract that exits 0 while printing a TAP `not ok` (TODO/SKIP
  excepted) or spec's `✖ failing tests:` is a **FAIL**, named. `WEBCTL_CONSUMERS_FILE`
  overrides the registry, for the gate's own tests against fake consumers.

### Fixed — in base itself

* Base's own `npm test` was bare `node --test`. Behind the strict runner it failed at
  once: default discovery ran **three helper scripts as tests**. They registered nothing
  and each counted as a pass. One (`mutex-worker.mjs`, given no arguments) took a lock in
  the real `~/.cache/CLIAI/demo-webctl/locks` on every run. Now `npm test` passes an
  explicit `test/**/*.test.{js,mjs,cjs}` glob through the strict runner. The real test
  count is 416, not the 419 reported before.

### ⛔ What this does NOT cover

* **A `"test"` script that never runs node** (`echo "No tests yet" && exit 0` over a
  114-test suite, measured by `fetlife`). No reporter or scan sees it; only reading the
  script does.
* ⚠ **The gate's scan only sees contracts that STREAM their test output — measured at
  the tag: 2 of 7.** gemini (50 TAP lines) and substack (27) stream. linkedin, chatgpt,
  fetlife, perplexity and grok log their suite and print a **summary**, so the scan read
  no result lines for them and their clean result there is **vacuous**. For those lanes
  the protection must be inside the contract (`run-tests-strict` or an equivalent), and
  the gate cannot tell whether it is. *(Stated in the tag message; this line corrected
  on master after tagging.)*

## v0.26.0 — 2026-10-02

### ⛔ BREAKING — reading a config key off `loadJsoncConfig()`'s wrapper now THROWS

* `loadJsoncConfig()` returns `{merged, layers}`. `chatgpt` passed that **wrapper** to
  resolvers that read top-level keys, so every config value read as `undefined`, i.e.
  "unset", silently. Hiding the wrapper's fields would not have helped: an absent key is
  `undefined` either way. ⇒ Now reading any other string key off the wrapper, or `'k' in
  wrapper`, **throws** *"read 'k' from .merged"*. `merged`, `layers`, destructuring, `await`,
  `JSON.stringify`, spread and inspection keep working (tested).
* Breaking only for code that already had the bug: it now crashes where it was silently
  unset. ⇒ **Lanes:** grep for `loadJsoncConfig(` and check every consumer reads `.merged`.

### Added

* `resolveTarget` `hints.configKey`: the refusal names the config key the lane actually
  reads (`chatgpt`: `browser_location`), validated on every call.
* `sb7q`: "additive" is judged from the caller's side, so a new base option must not change
  what an existing caller already gets (the v0.25.0 `scaling` red).

## v0.25.0 — 2026-10-02

### ⛔ BREAKING — harness generation 4: drift under the gate now FAILS

* **v0.24.0's `pin` passed real drift under the gate.** It decided "swapped" from
  `WEBCTL_DECLARED_PIN ≠ worktree`, and since v0.24 the gate sets the declared pin on
  **every** run, so a gate run that had NOT swapped (`WEBCTL_GATE_SWAPPED=0`) still read as
  *"the release gate has swapped this submodule"*. The verdict was NO VERDICT, under a false
  sentence. This voided generation 3's drift FAIL for every lane delegating to `pin`.
  Found in hand-written contracts by `fetlife`, then in base's harness by `gemini` and
  `chatgpt`; base measured it in its own gen 3 before fixing. **Now the only swap signal is
  `WEBCTL_GATE_SWAPPED=1`.** Lanes that scrubbed `DECLARED_PIN` as an interim workaround can
  drop the scrub at generation 4.
* **`require-generation <N>`** — a version floor that fails CLOSED, including on harnesses that
  predate it. The harness lives inside the submodule, so drifting to an older base also
  downgrades the checker (`substack`). A **flag** (`generation --min N`) was measured to
  fail OPEN: generation 2 ignores it and exits 0. An unknown **verb** exits 3 everywhere.
  `generation` now refuses arguments. ⇒ **Contracts: put `require-generation 4` first, and
  treat ANY non-zero as FAIL.** The test runs base's real generation-2 harness from v0.22.0.

### Fixed

* `xpra-attach`: `html5Port` defaulted to `port + 1`, the dead derivation the family
  removed in v0.6/v0.7 (html5 rides the same bind-tcp socket). Now it defaults to `port`.
  A base test had **enshrined** the +1. *(From `chatgpt`'s re-shim.)*

### Added

* `xpra-attach` **`desktopScaling`** → `--desktop-scaling`, accepting every form `xpra
  attach` takes: decimal `1.5`, fraction `3/2`, pixels `1024x768`, per-axis `2x1.5`,
  `on|off|auto` (forms as measured by `chatgpt`). Junk throws. Lanes drop their local
  mapping by renaming their field to `desktopScaling`.
  ⚠ **It is NOT named `scaling`, and the release gate is why.** The first candidate
  (`095c13b`) took `scaling`. Lanes already pass their own `scaling` through and append the
  flag, so chatgpt's suite went red: the flag was emitted twice, and base threw on `3/2`.
  A new base option must not change what an existing caller already gets.
* `resolveTarget` `hints.portFlag`: the refusal spells the port flag the way the tool does
  (`fetlife`: `--remote-debugging-port`). Hints are validated on **every** call, so a typo
  in `supports` surfaces on a run that resolves, not only on a refusal.

### ⛔ What this does NOT cover

* **Base cannot make a lane call `require-generation`.** Only the lane's contract survives a
  downgrade. A gate-side downgrade probe is described in the harness DEV_NOTES; it is not
  built.
* `xpra-attach` still falls back to port `14500` when `port` is unstated. That is nl0c §7 #6,
  which is circulated before it changes.

## v0.24.0 — 2026-10-02

### ⛔ BREAKING — three things that used to pass silently now refuse

* **`createMounts` requires `dockerfilesDir`** (path, thunk, or `null` = "builds no
  images"). Omitting it **throws at construction**, and that reaches every factory that
  builds mounts: `createChromiumDockerXpra(C, opts)` and `createRegistry(C, opts)`. There was
  a fallback to `../../dockerfiles`, and **base ships no dockerfiles**, so it named a
  directory that exists in no layout. A shim that forgot the option ran **stale images
  silently** whenever the image already existed (measured by `linkedin`: a lost
  browser-version assert, caught only by its docker-mode test). ⇒ **Every shim:** pass
  `dockerfilesDir` (or `null` if the tool never builds).
* **Docker up's profile lock is no longer forced, and a failed acquire stops the start**
  (`ow9k`). Force only when the lock already names this container. A live foreign holder,
  or a lock that cannot be written, ⇒ the containers this call started are removed and
  `ensureRunning` throws. ⚠ A consumer test whose fake `profileLock.acquire` returns
  something without `ok: true` now fails that start.
* **Harness generation 3 — `pin` FAILS on drift** (no gate signal, worktree ≠ gitlink) and
  on an **undeclared** submodule (a checkout with no gitlink); a plain vendored directory is
  no longer read as a gitlink. The gate's swap is still NO VERDICT. *(Measured by
  `substack`.)* ⇒ A lane mid-bump with an uncommitted pointer now sees red outside the gate.

### Added

* `resolveTarget` `hints.supports` — the refusal names only the knobs a lane has
  (`TARGET_KNOBS`); unknown or empty `supports` throws. *(From `substack`.)*
* nl0c §3b records `webctl:mgr`'s rulings for `fetlife`: an env port alone refuses; a named
  target's `local_cdp_port` counts; precedence `--target`/`--ssh` > bare `--port` > env >
  config.

### ⛔ What this does NOT cover

* **Lock-before-start is not done.** Step 9 now fails closed, but a container is still
  started before the lock is taken; moving the acquire earlier needs every later failure
  path to release it.
* `null` for `dockerfilesDir` is a declaration the lane makes; base cannot check a lane
  that declares it builds nothing and then calls `docker build` itself.

## v0.23.0 — 2026-10-02

**Headline: an explicit `--port` is a stated location (`nl0c` §3a), so the family's
unattended timers keep running.** Ruled at `webctl:mgr`'s request before a lane adopted
`resolveTarget`.

### ⛔ What this headline does NOT cover

* **`attachOnly` is a field, not an enforcement.** Base returns `attachOnly: true` for a
  `flag:port` target; the lane must refuse to start, build or restart anything for it.
* **No identity check ships here.** §3a says driving identity is the `ow9k` claim, which is
  still blocked on its open question (guest liveness).

### Added

* `resolveTarget` accepts `{source: 'flag', port, host?}`: alone it resolves as loopback,
  source `flag:port`, `attachOnly: true`; beside a location flag it qualifies it (`port`).
  New refusal codes `invalid-port`, `non-loopback-host`; two ports are `ambiguous`. An env
  or config port alone is still `no-target`.
* `LOOPBACK_HOSTS` — the literals a `--port` target may name (`localhost` is not one).

## v0.22.0 — 2026-10-02

**Headline: never assume where the browser runs (`nl0c`), and never restart a browser a
human is using (`lg1n`).** Both from Greg's rulings today; the second after an incident.

### ⛔ What this headline does NOT cover

* **Base does not migrate anyone.** A lane whose users relied on an implicit location will
  start refusing once it adopts `resolveTarget`; the refusal's instructions are the
  migration path, and that lane's own release notes must say so.
* **`findHostLiterals` needs the lane's host names** (from its own machine list). Base ships
  no list — it is public, and a list of hosts to forbid would publish them.
* **`lifecycleGuard` needs a READ viewer count.** Base does not read the display server;
  the lane does, and an unread count refuses.
* ⚠ **lg1n §0 is revised:** a second sign-in with CDP measured OFF was still blocked, so
  CDP is now unlikely to be the cause. Per-device protection and the missing WebGL remain
  candidates; neither is proven.
* Unchanged: no live login-mode reader for base's own driver; hardware acceleration in
  login mode not achieved.

### Added

* `resolveTarget(layers, hints)` — flag > env > config, reporting the winning layer and
  what it shadowed; nothing set ⇒ **refused with instructions naming all three fixes**,
  never echoing a value. A default is allowed only where a person declared it in config.
* `resolveTarget` scope: a caller that will not contact the browser passes `needsTarget:
  false` and gets `not-needed`, never a refusal; two locations in one layer are refused.
* `resolveTarget` refusals are a **reason object** — `{verdict:'refused', code, reason,
  instructions}`, `code` ∈ `no-target` | `ambiguous` — never an exit code: each lane maps
  the code to its own exit table. Only flag, env and config are sources; a layer named
  anything else (`default`, `local`) is ignored, so it refuses as `no-target` (tested per
  source).
* `targetEnvKey(tool, kind)` — the family's one env-name pattern
  (`CLIAI_<TOOL>_BROWSER_TARGET` / `_SSH_TARGET`).
* `findHostLiterals(files, names)` — the "no host literal in code" check; refuses with no
  names or no files rather than reporting clean.
* `lifecycleGuard({mode, viewerCount, humanOverride})` — a restart, stop or re-mint is
  **refused in login mode or with any viewer attached**; an unknown count refuses; only an
  explicit boolean human override proceeds. Its refusal **says a human is signing in**:
  in the incident the reason was misread, and sabotage showed a verdict-only test could
  not catch a generic reason.

### Fixed

* The docker-up **port-conflict hint** printed `lsof -i :<port>`, which also lists every
  process *connected* to the port; a lane acting on that form SIGTERM'd its own test
  process. It now prints the listener form, `lsof -nP -iTCP:<port> -sTCP:LISTEN`. This path
  had no test; `test/port-conflict-hint.test.js` now holds two real ports to reach it, and
  a sabotage run with the old form fails it.

### Docs

* New: `arch-target-resolution-no-implicit-location-nl0c` — named targets on the
  `~/.ssh/config` model; **`--target` is THE location flag, `--client` survives only as
  a synonym** (closing `btg4`'s open question); executable QA with controls.
* `lf4f` marked **superseded in part**: its implicit `default`, its `user_data_dir` path and
  its stored `port` contradict later rules.

## v0.21.0 — 2026-10-02

### ⛔ BREAKING — `parseAppVersion`'s `version` field

* **`version` was the binary's raw line; it is now the NORMALISED dotted version. The raw
  line moved to a new `raw` field.** `"Opera 120.0.1.2"` is now `version: "120.0.1.2"`,
  `raw: "Opera 120.0.1.2"`. Anything asserting or displaying the raw line must read `.raw`.
* Why break it rather than add a field: `version` is the field everyone already compares,
  and it was producing a **false outdated** (the raw line read *differs* against a declared
  dotted version). Leaving it raw would have left that bug in place for every reader that
  did not adopt a new field. Ruled by `webctl:mgr`.
* 0.x, so a minor bump — but stated as breaking, because it is: the release gate caught a
  consumer test pinning the old raw value.

**Headline: versions are normalised in ONE place, and the inventory never reads a
login-mode browser.** Both from lanes' v0.20.0 rollouts.

### ⛔ What this headline does NOT cover

* ⚠ **`parseAppVersion`'s `version` field CHANGES:** it is now the normalised dotted
  version (`152.0.7977.82`), with the binary's raw line moved to a new `raw` field. A
  lane that normalised the raw line itself should find its normaliser idempotent on the
  clean value — but check, and then delete it, which is the point.
* `normalizeVersion` returns **null** (UNKNOWN) when a line has no dotted version or more
  than one outside its *"built on"* part. It never guesses; a browser whose line has an
  unusual shape reads UNKNOWN until someone adds a fixture from its real text.
* Unchanged: no live login-mode reader for base's own driver; hardware acceleration in
  login mode not achieved.

### Added

* `normalizeVersion(raw)` — cut at *"built on"* (the distro part can carry a dotted
  number, e.g. Ubuntu `24.04`), then exactly one dotted token. Fixtures are REAL lines read
  from the local images' binaries (Chromium, Opera) plus the zone-manager lane's measured
  Firefox line.
* `inventoryRows(targets, readings, { loginMode })` — a target in login mode gets an
  UNKNOWN row saying why, never a reading: the `running` reading is taken by `exec` into
  the container, and login mode's window belongs to the human signing in.
* `parseAppVersion` names an **xq too old** for `app version` (its argparse *"invalid
  choice: 'version'"*) instead of blaming a swallowed argument.

### Fixed

* A false **outdated**: the raw line (*"Chromium 152.0.7977.82 built on Debian…"*)
  compared as-is against `152.0.7977.82` read *differs*.

## v0.20.0 — 2026-10-02

**Headline: `parseAppVersion` — base reads the zone manager's `xq app version --json`,
which reports the image that WOULD run and the container that IS running, separately.**
Built by the zone-manager lane in answer to rm7t's distinction.

### ⛔ What this headline does NOT cover

* ⛔ **`versionVerdict` alone does NOT verify a refresh.** It compares version strings;
  staleness is an **identity** question (image IDs), because two builds can print the
  same version and differ. A refresh needs both: `versionVerdict` on `next`, and
  `stale` from `parseAppVersion`.
* A version whose source is an image **label** is a build-time claim; `parseAppVersion`
  reports it as `measured: false` rather than treating it as a reading.
* Base does not run `xq`; lanes do. Unchanged: no live login-mode reader for base's own
  driver; hardware acceleration in login mode not achieved.

### Added

* `parseAppVersion(text)` and `APP_VERSION_SCHEMA` — `next` / `running` / `stale`, each
  version with `measured`; unknown schema or non-JSON → UNKNOWN (the zone manager's
  documented bug class is an argument swallowed and the HUMAN table printed with exit 0);
  no container → `stale: null`, never `false`.

## v0.19.0 — 2026-10-02

### ⛔ SECURITY — read this first

* **An ssh alias beginning with `-` was ACCEPTED by `validateTarget` (v0.18.0), and is
  now refused.** An alias is passed *through* to ssh, and ssh reads a leading-dash
  argument as an **option**: `-oProxyCommand=…` there is **command execution on the
  operator's machine**. A lane's own config already refused it; base did not. The same
  rule now applies to `machine`. If you validated a target with v0.18.0 and then passed
  its `ssh` value to ssh, re-validate it on this release.
* **Refusals never echo the value.** Every message names the key and the rule, never
  the offending value — a config value can be a host, and an error message is the
  most-copied text a tool prints. Tested by planting a distinctive value and asserting
  it appears in no error.

**Headline: `validateTarget` is now CLOSED, and the zone manager's host list has a
reader.** v0.18.0's validator accepted any key and checked only the fields it looked at
— so `{role:'prod', placement:'cloud', zone:'..', bogus_key:1}` read "valid" (found by
gemini, reproduced by webctl:mgr). Closing it is what exposed the alias hole above.

### ⛔ What this headline does NOT cover

* ⚠ **This TIGHTENS validation.** A config that v0.18.0 called valid may now be
  refused: an unknown key, an out-of-range enum, a zone like `..`, an ssh alias starting
  with `-`. That is the point, and it is why this is a minor release, not a patch.
* The enums are the **superset of what lanes run on today**. A lane may narrow them (the
  template's v0.1 does); a value no lane uses yet — e.g. a Firefox app, a persistent
  tunnel — is refused until someone adds it deliberately.
* `parseMachineList` judges the output of `xq machine ls --json`; **base does not run the
  command**. Lanes do.
* Base's own driver still has no live login-mode reader; hardware acceleration in login
  mode is still not achieved (unchanged).

### Changed

* `validateTarget`: **closed key set** (`TARGET_KEYS`), with **forbidden keys refused
  with their reason** (`FORBIDDEN_TARGET_KEYS`, incl. `owner` — ownership is state, not
  config); enums for control, view, app, lifecycle, role, placement, tunnel, kind, base
  (`TARGET_ENUMS`); rules for name, ssh, machine, zone, slug, profile_id, local_cdp_port.
  `name` is now OPTIONAL in the record (lanes key targets by map key) and checked via
  `opts.name`. **Messages name keys, never values.** Vocabulary taken from two lanes'
  real code and btg4, and three real shapes are fixtures that must stay valid.
* ⛔ **`ssh` / `machine` may not start with `-`.**

### Added

* `parseMachineList(text)` and `MACHINE_LIST_SCHEMA` — the reader for the zone
  manager's `xq machine ls --json` (rm7t §2, **resolved** with that lane). Unknown
  `schema` → UNKNOWN and refused; a malformed entry makes the list UNKNOWN rather than
  silently dropping a host; an **absent `reachable` means NOT CHECKED, never
  unreachable**; `present: false` is a valid state.

### Docs

* `rm7t` §2 resolved; §3 corrects my premise that images are per-host because of a baked
  uid — true for base's own driver, **no longer true for zone-manager lanes**, whose
  images are per-host only because each daemon holds its own, and which drift by build
  time. Refresh is `xq build app … --pull --no-cache`; a refresh verifies the image that
  would run, the inventory reports the container that is running — two readings.

## v0.18.0 — 2026-10-02

**Headline: remote-target validators (`rm7t`), usable on their own.** `lib/remotes.js`:
`validateTarget` (with its own refusal for `control = "tailscale"`), `checkConfigMode`,
`versionVerdict`, `inventoryRows`. Tagged now at `webctl:mgr`'s ruling, because lanes can
only consume base through a tag.

### ⛔ What this headline does NOT cover

* **§2's host source of truth is PROPOSED, pending the zone-manager lane (xq:dev).
  NO host-registry reader ships**, and no host-file schema. The open interface question
  is whether webctl reads xq's machine list through a command (`xq machines ls --json`,
  preferred: a command is an interface) or its file. ⇒ **Lanes must not build on the
  registry-reading part** — it waits for that answer and a later tag.
* **Nothing here builds, refreshes or reads anything remote.** These are validators for
  what a lane reads; the transports and the `targets` / `gui build|refresh` verbs are
  lane work.
* `versionVerdict` compares dotted numeric versions; anything else is only checked for
  equality (`differs`), never ordered.
* Base's own driver still has no live login-mode reader, and hardware acceleration in
  login mode is still not achieved (unchanged from v0.17.x).

### Added

* `lib/remotes.js`, exported as `remotes`:
  * `validateTarget` — control `ssh | local`; `control = "tailscale"` refused **with its
    own message** telling the operator to use `--tailscale` to reach ssh; view `ssh |
    tailscale-relay`; `kind`; an opaque `profile_id` (a path is refused, `btg4` §2).
  * `checkConfigMode` — refuses group/other access; an unreadable mode is refused, not
    assumed to be 600.
  * `versionVerdict` — current | outdated | ahead | differs | unknown, naming both the
    reading and the declared target; **a reading without its instrument is UNKNOWN** (a
    claim, not a measurement). Built because a rebuild was measured reproducing a stale
    browser from a cached package layer: exit 0 is not a refresh.
  * `inventoryRows` — every target gets a row; unreachable is UNKNOWN, never omitted.

### Docs

* New: `arch-remote-targets-build-inventory-rm7t`.
* `btg4`: its example no longer shows the target path §3 had refused.

## v0.17.1 — 2026-10-02

**Headline: two traps that lanes hit in LIVE login-mode readings, now handled in base,
plus a value/reason mismatch of my own.** The first two consumers of `loginMode`
(grok, gemini) read real browsers within hours of v0.17.0 and found what fixtures
built from expectations had not.

### ⛔ What this headline does NOT cover

* **Base's own driver still has no live reader** — unchanged from v0.17.0. Lanes on
  base's driver still cannot prove login mode.
* **Hardware acceleration in login mode is still NOT achieved** — unchanged.
* **`joined: true` means reduced fidelity:** a setproctitle-joined argv is split on
  whitespace, so a switch value containing spaces is not reproduced exactly. Switch
  *presence* is reliable; such *values* are not.
* `pickBrowserRoot` identifies Chromium by executable basename. A browser renamed to
  something else is not found — it reads as UNKNOWN, not as clean.

### Added

* `pickBrowserRoot(procs)` — the browser by **parentage** (`{pid, ppid, argv}`):
  exactly one Chromium root, else UNKNOWN. *(gemini: setproctitle-joined children made
  `--type` unusable — ~10 "browsers".)*
* `normalizeArgv` — undoes a setproctitle join and reports `joined`.
* `classifySockets(ssOutput, cdpPort)` and `DOCKER_EMBEDDED_DNS` — keyed on address +
  port, naming `127.0.0.11` as `docker-dns`. *(grok: Docker's resolver listens inside
  the container.)* `parseListeningPorts` now also returns `listeners` with addresses.

### Fixed

* **Advisories are value-conditional.** An empty `--load-extension=` (loads nothing)
  was reported as extension code running; `--disable-blink-features` was flagged for
  *any* feature while its own reason said *AutomationControlled*. A reason that
  disagrees with its code is a claim nobody checked.
* `pickBrowserProcess` normalises setproctitle-joined argvs before checking `--type`.

### Registry

* `grok-webctl` flipped to `wired: true` — verified: gitlink is exactly v0.17.0, tree
  clean, contract present, and its own code imports base.

## v0.17.0 — 2026-10-02

**Headline: login mode (`lg1n`) — a clean, exclusive, non-retrying window for a
human sign-in, with its verdict functions in `lib/login-mode.js`.** Base owns the
VERDICT; each lane owns the READING, because base does not own any lane's browser
launch line and so cannot assume "clean" from the flags it asked for.

### ⛔ What this headline does NOT cover

* **The live reader for base's OWN driver is NOT implemented.** Base's driver can
  *launch* without CDP (portless mode, `containerEnv: { LWC_CDP_PORT: null }`) but
  cannot yet *read back* the running browser's argv and sockets to prove it. Lanes that
  can already read their own browsers (zone-manager lanes) can use the verdicts now;
  lanes on base's driver must wait for the reader.
* ⛔ **Hardware acceleration in login mode is NOT currently achieved.** On the
  family's xpra setup the browser renders on a virtual X server on a host with **no
  GPU** (measured: WebGL1 blocklisted during a real sign-in). The viewer has GL; the
  browser does not. Absent `--disable-gpu` is necessary, not sufficient, and the
  viewer's GL check says nothing about what the page sees. Browser-side GPU is not yet
  checked by anything.
* **It does not prove CDP causes login failures.** The one measured incident was
  confounded, and the site's rate limit appeared with CDP already off.
* **It narrows D8 during sign-in only.** Control mode and the xpra port are untouched.
* **The sign-in predicate is lane-owned** — base ships no "is signed in" check, by
  design, since what signed-in looks like is per site.
* **Ownership re-mint is specified, not implemented** — it depends on `ow9k`, which
  remains a design.

### ✅ RELEASE-GATE EXCEPTION — RULED, THEN NOT NEEDED

**This release is VALIDATED, not excepted.** Recorded anyway, because the gate caught
a real gate-validity defect and it was fixed rather than waived.

* The first `--against-head` run BLOCKED on `perplexity-webctl`: 4 of 602 unit tests
  (#112, #307, #308, #309) derived "the pin" from the **submodule worktree**, so they
  failed against **any** untagged candidate. Their contract layer had handled the swap
  correctly; the defect was one layer down. Not a base regression — 602/602 at their
  real pin, separated only by a real git checkout at the pin vs at the candidate (a
  `git archive` reproduction had first suggested, wrongly, that they failed at the pin
  too).
* `webctl:mgr` ruled a scoped exception on the premise that the lane was paused.
  **The premise was stale:** the lane was live and committed the fix before the tag —
  the pin now read from `WEBCTL_DECLARED_PIN` or the committed gitlink, never the
  worktree, with a sabotage control that turns red if it regresses.
* ⚠ A second gate run came back green **only because perplexity was SKIPPED**: its
  working tree was dirty, because the lane had checked out this base's untagged master
  in its real submodule to reproduce the gate, alongside uncommitted edits. A skip is
  untested, not passed, so that run was not used. ⚠ *Corrected after tagging:* I first
  attributed the dirty tree to the lane's sabotage runner patching files. It does not —
  it works in a temp copy and never touches the live tree (verified by `webctl:mgr`).
  An inference, stated as a cause, about another lane's tooling.
* The **final** run, at this release's commit: `pass=5 skip=5 fail=0`, perplexity
  **PASS**.

### Added

* **Gate: `WEBCTL_GATE_SWAPPED` is now passed to contracts** (`"1"` swapped, `"0"` no
  swap, unset = not under the gate), beside `WEBCTL_DECLARED_PIN`. A lane's unit tests
  can now learn they are under a swap from the gate itself rather than re-deriving it
  from the comparison they are testing — the change that would have prevented the
  block above.
* `lib/login-mode.js`, exported as `loginMode`: `classifyLoginArgv` (CLEAN | VIOLATIONS
  | UNKNOWN, advisories separate), `classifyControlArgv` (the control arm, which must
  FIND CDP), `pickBrowserProcess`, `parseListeningPorts` (`ss -ltn` WITH its header),
  `sameProfile`. Handles Chromium's single-dash switch prefix, the `--` terminator, and
  an argv without a program name — each proven by sabotage.
* ⚠ **`CdpSession` fix — NEW in this release, not v0.16.0:** pending command and
  `waitForEvent` timers are now cleared on socket close (a rejected call previously
  held the process alive for the full command timeout), and the socket is injectable
  via `WebSocketImpl`. A consumer on v0.16.0 still has the leak.
* `contract-harness.mjs gate-probe` and `no-revendor` generation 2 shipped in v0.16.0;
  unchanged here.

### Docs

* New: `arch-login-mode-clean-signin-lg1n`.
* `ow9k`, `btg4`, `gu1d` (`docker-gl` attach mode ruled) and `k3wn` revised under
  review since v0.16.0.

## v0.16.0 — 2026-09-27

**Headline: `HARNESS_GENERATION` is 2, because `no-revendor` could not see the case
it exists for.** Cut immediately and deliberately: consumers run the harness **from
their pinned vendor copy**, so generation 2 reaches nobody without a tag — and a
bare-commit pin stays forbidden. ⇒ **Bump to v0.16.0 before writing a new contract.**

### ⛔ What this headline does NOT cover

* **An EDITED AND RENAMED copy still escapes `no-revendor`.** Whole-file
  normalised hashing catches a copy that was reformatted or re-commented; it does not
  catch one that was edited *and* renamed. That needs content shingles. ⇒ The PASS
  reason **says so on every run**, because a green that implies coverage it does not
  have is how this check spent generation 1.
* **Generation 2 does not audit your existing copies.** It tells a sweep *"who is
  below 2?"*. A contract recording 1 is not broken — it was written against a check
  that could not see a subdirectory copy, and it answers honestly.
* **§6(b)'s LEASE IS STILL BROKEN**, exactly as in v0.15.0. `LOCK_FILENAME` is built
  from `C.PROJECT`, so two tools sharing a profile never contend. Recorded, not fixed.
  ⚠ Anyone building on §6(b) is building on a guard that cannot fire.
* **Ownership is still unverifiable at the point of use.** btg4 now records the
  candidate answers — an ownership token, and one lane's stronger per-invocation form
  — but neither is implemented.
* **btg4 remains `status: draft`** with no `lib/` implementation. Nothing here points
  a tool at a remote browser.

### Fixed

* **`no-revendor` walks both trees RECURSIVELY and matches by NORMALISED CONTENT.**
  Generation 1 read only the top level and matched only identical filenames — while
  **half of base's own lib is nested**, so `profile-lock.js`, `mounts.js` and
  `chromium-docker-xpra.js` were never in the comparison set. Measured: three planted
  re-vendors (nested→flat, subdirectory + rename, rename in place) **all reported
  `pass`**. Now all three are caught, each naming the base module it copies and how.
  ⭐ A legitimate **re-export shim is still not flagged** — the control that matters,
  because flagging the pattern consumers are meant to use would get the check
  overridden. And the normaliser must **discriminate**: distinct base modules
  collapsing to fewer than two hashes is a broken detector, reported as such.

### Docs

* **btg4**: the guest test is **whose sessions are in the profile**, not who called
  `start` — so *"one owner split across two processes"* is a real third category and
  not a guest. `kind` was **two fields wearing one name** (transport/lifecycle vs
  browser ENGINE), with a third value `managed-zone` proposed; and an engine
  **cannot be sniffed** — Opera's `/json/version` reports `Browser: Chrome/151`, the
  one place §4's *"store how to FIND, never what you would MEASURE"* inverts because
  the measurement lies.

## v0.15.0 — 2026-09-27

**Headline: three consumer lanes reviewed `arch-browser-targets-btg4` and two of
them FALSIFIED parts of it against base's own code.** The review found more than
the design did. `inspect()` gained a diagnostic; everything else in this release is
specification and verification.

### ⛔ What this headline does NOT cover

* **§6(b)'s LEASE IS STILL BROKEN — this release records it, it does not fix it.**
  `profile-lock.js:36` builds `LOCK_FILENAME` from `C.PROJECT`, so two tools sharing
  one profile take two DIFFERENT lock files and never contend. Reproduced:
  `.alpha-webctl.lock.json` vs `.beta-webctl.lock.json`, *SAME FILE? false*. ⇒ The
  X-input lease **cannot arbitrate between the two parties it exists for.** Fixing it
  means deciding where lock identity lives (target + `profile_id`, or an explicit
  lease path), which is a design decision and deliberately not rushed into a patch.
  ⚠ **If you are building on §6(b), you are building on a guard that cannot fire.**
* **Nothing ESTABLISHES ownership at the point of use either.** A tool cannot tell
  whether it is an owner or a guest; `--cdp <url>` is free-form and a typo'd port
  reaches another lane's authenticated browser. Same missing identity as the lease,
  one level up. Open.
* **`portSourcesUnavailable` explains an absence; it does not create provenance.**
  If your cfg does not come from `buildDriverCfg()`, the sources are still `null` —
  you now get told why instead of guessing. Two causes remain indistinguishable from
  inside base (stale pin vs hand-built cfg) and the field says so.
* **`gate-probe` is for the GATE, not for your contract.** A lane never calls it. It
  returns no-verdict by hand, every time.
* **`HARNESS_GENERATION` is still 1.** An additive verb creates no stale copies, so
  contracts written against generation 1 are current. Not a bug.
* **btg4 is still `status: draft`,** with two open items above and no `lib/`
  implementation. Nothing here lets you point a tool at a remote browser yet.

### Added

* `contract-harness.mjs gate-probe` — asserts, **inside the gate's real swap
  window**, that `pin` declines a verdict and that its reason names both SHAs. The
  gate runs it per swapped consumer, counts it separately, and **blocks the release
  on a defect, attributed to base rather than to the consumer**. Zero exercises
  reports *"UNTESTED, not passed"*. Previously this arm was proven only against a
  forged fixture.
* `inspect().portSourcesUnavailable` — present **only** when `cfg.portSources` is
  missing, naming both causes and both remedies, so the healthy case stays silent
  and the field cannot become wallpaper.

### Fixed

* `judgePin()` split from `checkPin()` so `gate-probe` asserts on **the same
  verdict** the `pin` verb produces rather than a re-derivation.

### Docs

* **btg4** gained: the two-half guest gap (rendered-text semantics, which fails
  *silently plausible* rather than silently empty, and can invert a safety gate);
  `kind` and `base` in the schema, both found independently by two lanes; ownership
  as a **(tool, target)** property; §8 retitled to carry *"one tool, ONE target that
  is not local"*; and that a remote target implies **that host built its own images**,
  because UID/GID are build args and the failure surfaces as a browser crash.
* **r7x2** — new: argv arrays, file payloads, and §1b, **the remote shell an argv
  array does not cross.** `execFile('ssh', [host, '--', ...argv])` satisfies the
  array rule exactly and is still an injection. ⭐ Records that the stdin form is not
  merely an alternative to per-element `%q`: it is **the only one that stays correct
  when someone later adds an argument.**
* **k3wn** gained three shapes: `git log -S` measures **transitions, not states**,
  and its wrong answer has the right shape; **a guard and a claim that read the same
  input cannot disagree** — detected because *a whole test became unwritable*; and
  **a refusal test needs a positive control on the same fixture**, reached
  independently by two lanes the same day.
* **AGENTS.md**: base is the one **PUBLIC** repo — provenance by ROLE, and our own
  agent handles carry machine names, so cite the LANE.

### Registry

* `claude-chrome-extension-webctl` corrected to `wired:true` (the gate caught the
  registry under-reporting a real consumer), and `perplexity-webctl` registered at
  `tier: contracts`.

## v0.14.0 — 2026-09-27

**Headline: the contract harness.** The checks every consumer contract was
copying are now a library a contract **calls** — `scripts/contract-harness.mjs`,
verbs `generation` / `pin` / `no-revendor`. The harness **owns the exit code**
(0 pass / 1 fail / 2 no-verdict / 3 usage) so no contract re-implements the
`[ "$rc" = "2" ]` handling that already turned one lane's green suite into
exit 1. Cut because three defects were found in three lanes' copies at three
different ages, and **a defective contract reports green** — the one duplication
in this family that fails by reassuring us.

### ⛔ What this headline does NOT cover

* **The harness is three checks, not the contract.** A lane still writes its own
  suite invocation, teardown enumeration and version marker. Adopting the harness
  does not make a contract complete; it removes the three that were provably
  rotting.
* **The gate-swap arm is proven by a FORGED fixture only.** `pin` returns
  no-verdict when `WEBCTL_DECLARED_PIN` disagrees with the worktree, and that
  state is reproduced in tests by constructing it by hand. It is **not yet
  exercisable during a real `--against-head` gate run**, which is the only place
  the state occurs on demand. Until that lands, the arm is tested against a model
  of the gate rather than the gate.
* **It fixes FUTURE duplication, not the copies already out there.** Lanes
  carrying older copies keep their rot, and you cannot find them by diffing —
  rot and legitimate per-lane customisation look identical in a diff.
  `HARNESS_GENERATION = 1` makes "who is below N?" answerable, but **nothing
  sweeps automatically**; someone has to ask.
* **`verify_yaml_frontmatter.py`'s duplicate-ID repair is forward-looking.**
  master's corpus is clean and now provably so, but the four colliding IDs that
  exposed the defect live on **unmerged `design/*` branches**. Any lane that
  merged those locally has collisions that resolved silently until this release.
* **`base-surface.mjs` proves purity for the surface it walks**, not for every
  factory base will add. Enumerating by calling is not free — `resolveChromiumProfile()`
  mkdirs — so the tool constructs against a throwaway `HOME` and asserts it did
  not write. A future factory that writes somewhere else is not covered by that
  guard.
* **No runtime behaviour changed.** `lib/` gained data on an existing frozen
  contract and comments; a consumer bumping to v0.14.0 gets tooling, contract
  data and docs, **not** new browser capability. If you are waiting on the CDP
  client extraction, this is not it.

### Added

* `scripts/contract-harness.mjs` + `.README.md` + `.DEV_NOTES.md`, with
  `HARNESS_GENERATION` exported so a sweep can ask who is behind.
* `scripts/base-surface.mjs` + docs — enumerate base **by constructing**, because
  `grep 'export function'` is structurally blind to the ~46% of the callable
  surface that is only reachable through a factory. The tool carries a vacuity
  guard on itself: zero factory returns exits 1 rather than becoming the grep it
  replaces.
* `CONTAINER_LIFECYCLE_CONTRACT` gains `pairOrder`, `recovery` and
  `recoveryNote` — additive fields on a frozen contract, naming the pair ORDER
  rather than only the absence of a restart policy.

### Fixed

* **`verify_yaml_frontmatter.py`: the duplicate-ID check could not fail.** The
  index was `dict[str, Path]`, so a colliding ID overwrote its predecessor and
  the check downstream regrouped an already-unique mapping — `len(paths) > 1` was
  unreachable while the docstring advertised the check. Measured over master plus
  the unmerged design branches: **47 docs scanned, 40 indexed, "All files passed
  validation", rc 0**, with eleven docs colliding across four IDs. Cross-references
  resolve through these IDs, so `relates_to: [v7m2]` had been resolving to
  whichever doc won the overwrite. The verifier now also runs under `npm test`;
  it previously ran only when an agent remembered the command.
* The release gate exports `WEBCTL_DECLARED_PIN` before each swap, because the
  swap is exactly what makes a contract unable to know its own declared pin.

### Docs

* New: `arch-browser-targets-btg4` — a target says WHERE a browser is and how to
  reach it; a profile is the Chromium user-data directory. Includes the
  per-surface transport split (`control` never leaves ssh/local; `view` may use a
  tailscale relay), and a correction: `ssh host -- <argv>` is **not**
  injection-safe, because ssh joins the remote argv with spaces and the remote
  shell re-parses it.
* New: `test-checks-that-cannot-fail-k3wn` — verification discipline, led
  deliberately by base's **own** shipped defects rather than other lanes'.
* `xrl4` gains the harness's version-marker requirement.
* `AGENTS.md` records that roughly half of base's callable surface is not a
  module export, with the measurement.

### Registry

* `perplexity-webctl` registered, `wired:true`, `tier: contracts`. Tier is the
  honest value rather than the proposed one: the submodule is mounted but no file
  outside `vendor/` imports it yet, so any browser tier would be a statement
  about future code. Flip to `cdp-client` when an import exists.
* **`claude-chrome-extension-webctl` flipped `wired:false` → `true` — the gate
  caught this registry lying.** The stale-entry detector reported "wired:false but
  submodule mounted", and the mount is real: pinned at tag **v0.7.0**, submodule
  checked out, ten-plus non-vendor files importing it. This was not an aspiration
  registered early; it was a real consumer the registry under-reported, counted as
  a skip on every run. ⚠ v0.7.0 is **7 minor releases / 11 tags / 71 commits**
  behind, so making it visible starts a conversation about a very old pin rather
  than closing one. (The v0.14.0 tag's own copy of this entry says "six releases
  behind" — wrong, corrected here on master. A published tag does not get moved.)

### Docs (index)

* `AGENTS.md`'s corpus list was missing **7 of 26** design docs, including two
  written that week. `test/agents-md-indexes-the-corpus.test.js` now fails on an
  uncited doc or a citation resolving to no file — the list is checked rather than
  maintained by memory.

## v0.13.1 — 2026-09-23

⛔ **v0.13.0's `portOrigin()` could not classify TWO OF THE THREE PORTS
`inspect()` carries.** Adopt v0.13.1 if you adopted v0.13.0.

There are **two producers** of port sources and v0.13.0 handled one:

```
resolvePort()      'default' | 'cli' | 'env:FOO' | 'jsonc:port'      classified
deriveXpraPorts()  'derived' | 'derived (== tcp; …)'
                   'jsonc.ports["xpra-tcp"]' | 'jsonc.xpraTcpPort'   -> null
```

⇒ So a **fail-closed consumer — the shape base itself recommends — would have
refused every ordinary bring-up**, because the default `xpra-tcp` source
(`'derived'`) returned `null`.

* `portOrigin()` classifies both producers. `jsonc.` joins `jsonc:`; anything
  base COMPUTED (`derived…`, `default`) is `derived-from-constants`.
* ⚠ **`portOrigin` and `PORT_ORIGINS` are re-exported on the FACTORY surface.**
  They were module-level only, and consumers' shims expose what
  `createClientConfig()` returns — so the lane that needed them could not reach
  them. **A published API a consumer cannot reach is not published.**

⭐ **Why the test missed it.** v0.13.0's coverage test listed `resolvePort`'s
channels BY HAND while the commit described it as walking *"the resolver's real
output"*. It walked ONE resolver's. It now enumerates `cfg.portSources` — the
object that actually reaches `inspect()` — so a producer added later cannot be
missed by a hand-maintained list, and it counts the assertions it ran.

⇒ *Fixing an omission at one call site says nothing about the others* — a rule
this repo recorded the previous day, applied to a single producer.

*(Both gaps reported by cgwc:main within the hour of the tag, from adoption.)*

### ⛔ What this release does NOT cover

* **It does not make the vocabulary load-bearing.** A consumer can still
  reimplement the classification with a local regex and pass every check —
  nothing in a test can observe a vocabulary that is not used. Publishing data
  is not adoption; the shared harness reading it is what would make it binding.
* **Two values only.** `derived-from-constants` covers anything base computed,
  including a port derived from another already-resolved value plus an offset.
  A third value would be a breaking change for every fail-closed consumer.

## v0.13.0 — 2026-09-23

⭐ **Port provenance, end to end — the first `gui` prerequisite, and useful on
its own to every lane whether or not it ever ships `gui`.**

* **`buildDriverCfg()` keeps `portSources`; `inspect()` reports
  `ports: {<key>: {value, source}}`.** These were computed with care by
  `deriveXpraPorts()` and `resolvePort()` and then dropped on the next line —
  nothing in `lib/` consumed them, so the provenance existed for one statement
  and died at the seam. ⇒ A caller could not tell a DERIVED port from a
  CONFIGURED one, which is the distinction this family paid weeks for when a
  derived html5 port was published, reserved and advertised while answering
  nothing.
* **`PORT_ORIGINS` + `portOrigin(source)`** make the family rule *"a CDP port
  must be STATED, never GUESSED"* shareable. ⛔ Deriving from a project constant
  is **not** guessing — `C.DEFAULT_CDP_PORT` is a decision someone wrote down —
  and `'default'` is the word that invites the opposite reading:

```
stated                  a human wrote this value for THIS run
derived-from-constants  computed from C, deterministic and auditable
```

⚠ `portOrigin()` returns **`null`** for anything unrecognised, never a default.
Fail-closed by asymmetry: a wrongly-refused run prints what to do; a
wrongly-accepted one is the bare-default ship the rule forbids.

### ⛔ What this release does NOT cover

* **It does not ship `gui`.** This is one of its prerequisites. The design is
  `ux-gui-subcommand-surface-gu1d`; the two probes it needs (`guiReachable`,
  `html5Answering`) are not implemented.
* **It does not enforce the port rule.** base classifies; the consumer decides
  whether a `derived-from-constants` origin is acceptable for a given verb —
  and for `docker up` it must be, since requiring the port before you may start
  the thing providing it is backwards.
* **A single `PORT_ORIGINS.includes()` check is not sufficient.** Publishing a
  vocabulary closes *drift* and opens *coverage*: an origin base adds and emits
  passes that check and falls through an unchanged branch. Check against the
  list AND against your own handling, and put the second in a suite.
* **`source` is absent, not guessed, for a cfg predating `portSources`** — an
  older consumer passing its own object gets `null`.

## v0.12.0 — 2026-09-22

⭐ **`describeProfileResolution().warning` gains `severity`, and base publishes
the complete vocabulary** as `PROFILE_WARNING_SEVERITIES`.

`kind` says **what** it is. Nothing said **how bad**. ⇒ So every consumer had to
independently decide which kinds are refusals, and they would drift — the
copy-rot mechanism this family has now hit five times.

⛔ **The specific failure it prevents:** a consumer branching on a single kind
string **silently allows a third dangerous kind added later**. That is the
skipping form, and the vocabulary is base's to grow, so the classification is
base's to own.

```
danger  ⛔ refuse — a slug claiming isolation resolving to the DEFAULT profile
notice  proceed; fine, but not what the caller may have assumed
```

⚠ A consumer should still **refuse an unknown severity** rather than assume it
is benign. The asymmetry is the argument, not taste: a new benign value blocking
a bring-up prints what to do; a new dangerous value silently allowed is a
throwaway-named container mounting an authenticated profile.

*(The gap was reported by fetlife-webctl, which had already implemented
fail-closed-on-unknown-kind and asked for the classification to live with the
kind rather than in eleven lanes' hardcoded sets.)*

### ⛔ What this release does NOT cover

* **base still does not refuse.** It classifies. A lane deliberately sharing one
  profile is entitled to, so the policy stays with the consumer.
* **It does not make a single-value check safe.** Branch on `severity` and
  assert against `PROFILE_WARNING_SEVERITIES`; a consumer that hardcodes
  `severity === 'danger'` and nothing else is back in the skipping form the day
  a third severity ships.
* **Nothing else moves.** No driver, teardown or contract-data behaviour change.

## v0.11.2 — 2026-09-22

⛔ **`describeProfileResolution().warning` is now `{kind, text}`**, not a bare
string. ⚠ A shape change, and the third in a day for the one lane consuming this.

It fires for two materially different situations and `warning !== null` is
**true for both**:

```
default-profile-under-throwaway-slug   ⛔ the incident
isolated-but-not-by-slug               a fine bring-up, just not isolated BY the slug
```

⇒ A consumer branching on *"is there a warning?"* would refuse a perfectly safe
configuration, and the only alternative was matching the prose — which silently
weakens the moment the wording changes.

⭐ **Found by applying v0.11.1's own lesson rather than waiting for it to be
reported.** `TEARDOWN_CONTRACT.keeps` was changed from prose to `{key, text}` in
v0.11.1 for exactly this reason; `warning` had the same defect one field over
and shipped in the same release.

### ⛔ What this release does NOT cover

* **It does not decide the refusal policy.** `isDefaultProfile` is `true` for an
  ordinary `--slug default` bring-up too, which must be allowed — the dangerous
  combination is *a slug claiming isolation that resolves to the default
  profile*. base reports the fact and the `kind`; the consumer owns the policy,
  because a lane deliberately sharing one profile is entitled to.
* **Nothing else changed.** No driver, contract-data or teardown behaviour moves
  in this release.

## v0.11.1 — 2026-09-22

⛔ **`describeProfileResolution()` could not tell SAFE from DANGEROUS.** Shipped
in v0.11.0 with `isolatedBySlug` as its only boolean, and it is `false` for both
of these:

```
slug 'qa' + userDataDir '/tmp/isolated'        -> a fine isolated bring-up
slug 'qa' + userDataDir <the DEFAULT profile>  -> a throwaway-named container
                                                  mounting the authenticated one
```

Byte-identical output. A consumer branching on that boolean — the obvious use —
got the same answer for a benign config and for the incident the function exists
because of. ⇒ `isolatedBySlug` answers *"did the SLUG do the isolating?"*; a
bring-up guard asks *"will this touch the DEFAULT profile?"*, and they diverge
exactly where it matters.

* **new `isDefaultProfile`** — the safety question, as its own field.
* the two cases now produce **different warnings**, the dangerous one naming the
  resolved path.
* `isolatedBySlug` stays narrow deliberately, and a test pins that too, so it is
  not later "fixed" into a safety flag and the conflation reintroduced from the
  other side.

**`TEARDOWN_CONTRACT.keeps` entries are now `{key, text}`.** ⚠ A shape change
for anyone already consuming it. The consumer asserting that every kept artifact
is named in its user-facing message was substring-matching prose, so rewording
an entry would silently WEAKEN that check without failing anything. The key is
the contract; the text is for humans.

### ⛔ What this release does NOT cover

* **It does not make `createDriver()`'s purity remove a consumer's scratch
  `userDataDir`.** That was overstated in v0.11.0's notes. A test that CAPTURES
  driver behaviour drives `ensureRunning()`, which still creates the directory —
  so the workaround stays for capture tests. The fix buys the read-only case: a
  `gui status` constructing a driver to read `inspect()`.
* **It does not refuse anything.** `isDefaultProfile` is reported; the policy
  stays with the consumer, because two containers on one profile is legitimate.

## v0.11.0 — 2026-09-22

⭐ **THE RELEASE THAT MAKES BASE'S CONTAINER CONTRACTS CHECKABLE.** Three facts
consumers were re-deriving from base's COMMENTS now ship as frozen data, each
compared against what the driver actually does:

* `XPRA_CONTAINER_ENV_CONTRACT` — `required` / `forbidden` / `htmlFlag` /
  `since`. ⛔ `forbidden` is a **real list**, never the complement of `required`:
  only "must not be set" catches an entrypoint still consuming a variable base
  STOPPED setting, which is the live failure (an entrypoint requiring
  `XPRA_HTML5_BIND` hard-fails against any base at or after v0.6.0).
* `TEARDOWN_CONTRACT` — `removes` is **empty**. `shutdown()` stops; containers,
  volumes, network and profile dir all survive, and **stopped containers still
  hold the volume**, so a later `docker volume rm` refuses.
* `CONTAINER_LIFECYCLE_CONTRACT` — ⛔ **no `--restart`, deliberately**, so
  nothing survives a reboot. Recorded as a DECISION rather than a gap: lanes
  hold sessions authenticated as a real person, a container revived by dockerd
  has no runner while the profile lock records one, and making 14 lanes'
  browsers into boot services is not a change base makes silently. *(An
  undocumented absence cost one lane two weeks: it reported "containers up ~33h"
  to three audiences with both containers EXITED since a reboot.)*

**fix(profile): `createDriver()` no longer creates a profile directory.** It
called the eager resolver, so merely BUILDING a driver made a directory — before
any bring-up, and whether or not one ever happened. Every consumer constructing
a driver to read `inspect()` (what a `gui status` does) littered one per slug.
The `mkdir` moved to `ensureRunning()`.

* `mounts.profilePathFor()` — pure path resolution, creates nothing.
* `mounts.describeProfileResolution()` — names the slug/profile footgun BEFORE
  docker is touched: when `userDataDir` is set the slug is ignored, so a
  "throwaway" slug renames the containers and still mounts the configured,
  often authenticated, profile.
* `scripts/probe-contract-capability.sh` — asks whether each consumer's contract
  can FAIL at all.

### ⛔ What this release does NOT cover

* **It does not change what `shutdown()` does.** It documents it. Volumes and
  stopped containers still need removing by name.
* **It does not add a restart policy.** After a reboot your containers are gone;
  the contract now says so, and a reachability probe is the only thing that
  notices.
* **It does not ship `gui`.** The design is in `ux-gui-subcommand-surface-gu1d`;
  the surface is not implemented, and for the lanes with no driver it
  presupposes a docker harness this release does not provide either.
* **The contract data is not the ground truth** — the driver is. A consumer
  asserts against captured `runDetached` args and uses the data for the message
  and the forbidden set. Grepping base's source returns the NEGATION: a grep for
  `XPRA_HTML5_BIND` matches the comments saying it is deliberately not set.
* **`describeProfileResolution()` reports; it does not refuse.** Two containers
  on one profile is legitimate, so the policy is the consumer's.

## v0.10.1 — 2026-09-05

⭐ **fix(cdp): `listTargetsCorroborated` compared two key spaces**, so
`sourcesAgree` was **false on a healthy stack** and the loud-by-default warning
fired on every call. `Target.getTargets` returns rows keyed `targetId`;
`GET /json` returns rows keyed `id`; `listTargetsViaBrowser` passed its rows
through unnormalised, so browser rows fell back to the url while HTTP rows used
the id. Now normalised (`targetId` -> `id`, `targetId` preserved) at the source,
so no downstream comparison can inherit it. A row carrying neither id nor url is
reported with its own reason rather than collapsing every such row onto the key
`worker:`. *(Measured on a live stack by substack-webctl at v0.10.0; mechanism
confirmed by webctl:mgr.)*

  ⇒ **The rule, which is the durable half:** a known-positive proves an
  instrument can say FOUND; an **ALARM additionally needs a known-NEGATIVE** —
  proof it can say NOT FOUND — because a thing that always fires and a thing
  that correctly fired are indistinguishable from outside.

* **fix(release): the version string agrees with the tag, and is now asserted.**
  Six tags shipped disagreeing with the tree inside them (`v0.4.0`/`v0.5.0` said
  `0.3.0`; `v0.7.0`..`v0.10.0` said `0.6.0`). A one-off correction was
  deliberately NOT the fix: a field wrong for five releases is inert, while a
  field silently corrected once is one people start trusting again.
* **gate: exit 2 is "no verdict", not "needs human"** — the gate was asserting a
  cause it was never told. It now quotes the consumer's own last line and
  carries it in the JSONL envelope.
* **xrl4: a contract must not assert properties of its own pin** when
  `WEBCTL_BASE_DIR` is set. A vacuous RED is not the safe direction.
* **`scripts/tags-since-pin.sh`** — watch base's refs, not your vendored
  snapshot. Soft by default; `--self-test` controls on immutable refs.
* registry comments no longer carry pin VALUES, only the property.
* **gate: the whole reason is quoted, not its last line.** A contract wrapping
  its reason over two lines was being quoted from the tail alone, so the summary
  showed a sentence FRAGMENT — the gate truncating the very words it had just
  been changed to relay faithfully.
* **`tags-since-pin --self-test`: the negative arm now asserts its own subject.**
  "rc=0 and no TOUCHES" is also what an EMPTY RANGE produces, so the arm proving
  the probe can say NOT FOUND would have gone green while measuring nothing.
  ⇒ *A control that replays only part of the condition it claims to replay fails
  toward green.* (cgwc:main, who hit the same shape replaying a log pattern
  without its coupled sort.)

### ⚠ Migration note — crossing v0.5.0 -> v0.6.0 with docker+xpra

Once `xpraHtml5Port == xpraTcpPort`, a consumer whose publish list still carries
a SEPARATE html5 entry emits **two identical `-p` flags**. Docker fails with
**exit 125, "failed to set up container networking"** — an error naming nothing
about duplicate ports, so it presents as a mysterious networking failure on the
first `docker up` after the bump. base itself publishes one entry and is not
affected; this is for consumers carrying their own publish list. Four such sites
were still assuming `tcp+1` in one lane at the time of writing.
*(Measured with a control by the linkedin-webctl lane, 2026-09-05.)*

### ⛔ What this release does NOT cover

* **It does not make `sourcesAgree` mean more than it says.** It compares
  sorted identity key SETS from both sources. It does **not** verify that a
  target is *functional*, and it is still not a basis for concluding a
  service_worker is ABSENT — the browser endpoint remains authoritative and
  `GET /json` is still not reliable for that, exactly as in v0.9.0.
* **It does not fix the six already-published tags.** They are immutable and
  still contain wrong version strings. `git describe` remains the only truthful
  answer to "which base am I on" for anything at or below v0.10.0.
* **`tags-since-pin.sh` does not help retroactively.** It ships inside the thing
  it watches, so a consumer pinned before this tag does not have it.
* **It reports paths, not semantics.** "v0.11.0 touched cdp-client.js" is not
  "the thing you were waiting for landed."
* **No lifecycle or enumeration behaviour changed.** A consumer already on
  v0.10.0 that never called `listTargetsCorroborated` gains nothing here.
* ⚠ **A suite file's NAME is now load-bearing for at least one consumer**
  (`test/portless-mode.test.js`). Renaming or moving a test file is release-note
  material, not housekeeping.

<!-- released in v0.7.0:
* **fix(ports): an out-of-range derived xpra-tcp port is refused, not returned.**
  `xpraTcpPort = port < 55535 ? port + 10000 : port + 100` runs off the end of
  the port space: CDP `65436` derives `65536`, which is not a port. **100 CDP
  ports (`65436..65535`) are affected.** The defect was not the arithmetic but
  the confidence — the resolver returned those values with
  `sources:{tcp:'derived'}`, indistinguishable from a valid derivation, so the
  caller could not tell an impossible port from a good one and the failure
  surfaced later as an unrelated bind error. Now throws, naming the window and
  both remedies. An explicit `xpraTcpPort` still bypasses derivation, so a high
  CDP port remains usable — you just have to say which xpra port you want.
  *(Found and bounded by the chatgpt-webctl lane; reproduced independently
  here.)*
* `PORT_OFFSET_HTML5` note strengthened to **DO NOT USE — RETAINED FOR IMPORT
  COMPATIBILITY ONLY**. Its value is still literally `1` while its meaning is
  now "there is no offset", so anyone who greps, finds it and applies it
  reproduces the defect v0.6.0 removed.
* `WEBCTL_BASE_DIR` exported by the release gate to the consumer contract.
* Gate rollback now traps `INT`/`TERM`/`HUP`, not only `EXIT`.
-->

## v0.6.0 — 2026-09-01

⚠ **MIGRATION REQUIRED. base cannot make this edit for you.** Container
entrypoints must pass `--html=on`, **not** `--html=host:port`. xpra ≥6 rejects
the host:port form. A consumer taking v0.6.0 without this edit gets a correct
base and a broken stack.

⚠ **READ THIS BEFORE CONCLUDING THE PORT FAMILY IS FIXED.** The headline is "the
html5 port collapse", and that is accurate but **partial**. Two separate
overflow paths existed:

* the **html5** `+1` derivation — addressed here, and it accounted for
  **exactly 1** of the 101 affected CDP ports (`65435`);
* the **tcp** derivation itself — **NOT fixed in v0.6.0**. The other **100**
  ports (`65436..65535`) still derive an out-of-range value in this release,
  silently and with full confidence. **Fixed in v0.7.0** — see that entry above.

So: if you pin v0.6.0 and your CDP port is below `65436`, you are unaffected by
either. If it is at or above `65436`, v0.6.0 does **not** help you and you want
v0.7.0. The collapse fixing one boundary case is easy to mistake for the port
family being sound.

### Fixed

* **xpra html5 port collapses onto the tcp socket.** base derived, published,
  bound (`XPRA_HTML5_BIND`), pre-flight-checked and advertised
  `xpraTcpPort + 1` — a port xpra never listens on, because it multiplexes the
  html5 client and its websocket onto the bind-tcp listener. Every docker+xpra
  consumer inherited a reserved, advertised, dead port. Measured on two
  independent live stacks before the fix: `14527`/`14877` served the client;
  `14528`/`14878` answered nothing.
  * `xpraHtml5Port` is **kept and made equal to** `xpraTcpPort`, so cross-repo
    readers of `inspect()` or `deriveXpraPorts()` become correct with no change.
  * `inspect()` additionally advertises `xpraHtml5Url`.
  * An explicitly-configured html5 port that **differs** from tcp is now
    refused rather than silently ignored.
  * **Observationally**, html5 access is unchanged for anyone whose `+1` was
    already dead (probably everyone). Not a no-op overall: one less port
    reserved per stack, and one less spurious "port in use" pre-flight conflict.
* Consumers resolve by optional `localDir`. Three consumers do not live at
  `$WEBCTL_CONSUMERS_DIR/<name>`; one had been invisible to the release gate for
  six weeks while the summary read `OK`.

### Added

* `scripts/test-all-consumers.sh --against-head` — the **pre-release arm**.
  Previously the gate resolved each consumer's *own pin* and never used
  `BASE_ROOT`, so a green result said nothing about the commit being released.
  Both modes now print what they validated against.
* `createProcessMutex(C, opts)` becomes **reachable**: it landed after v0.5.0,
  so the mutex adoption proposals were un-actionable from any consumer's pin
  until this tag.
* `scripts/base-webctl-drift.sh` (lifted from chatgpt-webctl), separating
  packaging drift from logic drift.
* A test enforcing base's **no-top-level-await** guarantee — the property every
  consumer's one-line CJS shim depends on, previously asserted only in comments.

### Deprecated

* `PORT_OFFSET_HTML5` — deprecated. (This entry said "removed at v0.7.0"; that
  was retargeted to v0.8.0 when v0.7.0 was cut — see the v0.7.0 entry for why.)

### Docs

* `xrl4` gains "Gate validity: the green that means nothing".
* `sazn` gains the rotation constraint: rotation prunes only what it created.
* `f6rd` no longer contradicts itself between §2 and its P1 correction.

## v0.5.0 and earlier

Not retrospectively documented here; see the annotated tags and
`FUTURE_WORK/status/`.
