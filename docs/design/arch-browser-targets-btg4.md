---
id: btg4
title: "Browser targets — pointing a tool at a browser, local or remote"
category: arch
created: "2026-09-27"
updated: "2026-09-27"
status: draft
tags: [targets, remote, ssh, tailscale, cdp, xpra, shared-browser, isolation, config]
tech:
  - name: "Node.js"
    version: ">=22.12"
  - name: "OpenSSH"
    version: ">=8"
  - name: "Docker"
    version: ">=24"
relates_to: [sm2t, f6rd, gu1d, v59v, k7m2]
depends_on: [v7m2, 2fc5, 8hw5]
expands: [8hw5]
similar_to: [f6rd]
---

# Browser targets

> **A TARGET says where a browser is and how to reach it. A PROFILE is the
> Chromium user-data directory. They are different things and only one of them
> is dangerous to copy.**

⛔ **Read that first sentence as the point of the document, not its preamble.**
The naming is not tidiness: Greg's standing rule — *"profiles are NEVER copied
between machines"* — is about the **profile**. A **target** is precisely the
thing you *would* sync. If both are called "profile", someone applies the rule
to the wrong one and either refuses to sync a harmless config or **syncs an
authenticated Chromium profile because it looked like one.**

⚠ And a distinct noun is **necessary and not sufficient**, because the failure
already happened *while the warning was being written*: `~/.config/chatgpt-webctl/`
was recorded as a per-tool **config** dir in the brief. It is a **118M Chromium
profile** with `Local State`, `Cookies` and `Login Data`. Nobody misread a
noun — ⇒ **a directory listing looked like config.**

Reproduced here, first run:

```
$ find ~/.config -path '*webctl*' \( -name Cookies -o -name 'Local State' -o -name 'Login Data' \)
~/.config/chatgpt-webctl/chromium-profile/Local State
~/.config/chatgpt-webctl/chromium-profile/Default/Login Data
~/.config/chatgpt-webctl/chromium-profile/Default/Cookies   ⇒ 118M
```

---

## 1. The guard, before the convention

⛔ **No Chromium user-data directory may live under the config root**, and this
is enforced rather than documented:

* any migration, consolidation or move **refuses** a directory containing
  `Local State`, `Cookies` or `Login Data`, naming the file it found;
* ⛔ **it matches file NAMES ONLY and never opens them.** The walk goes *into*
  authenticated profiles, so it passes `Cookies` and `Login Data` — and
  "names, never contents" belongs **in the guard's spec, beside it**, the way
  the `set -x` rule sits beside `set -x`. *(ccew.)*
* the check scans **the filesystem**, never the config files. ⚠ That is
  load-bearing: an orphaned 118M authenticated profile exists on this box
  **referenced by no config and mounted by no container**, so a config-keyed
  sweep would not see it, and a sweep keyed on *"directories named after a
  tool"* would hit a live profile no config mentions.

⇒ *A convention depends on being read carefully. A guard does not.*

### ⭐ Why the scan must walk the TREE — the worked example

The orphaned profile is the proof, and `cgwc:main` bounded it: **Chromium 144**
against its containers' 148, created 2026-03-23, last written 2026-09-09, and
**referenced in no code of the two lanes that share `browser-location`.**

⇒ **Three cheaper sweeps each look sufficient and all three are blind to it:**

| sweep | why it misses |
|---|---|
| config-keyed | no config names it |
| code-keyed | `grep` finds nothing in either lane |
| container-keyed | no container mounts it |

⇒ Only *"walk the tree and look for `Local State` / `Cookies` / `Login Data`"*
sees it. ⚠ And a fourth, plausible-sounding sweep — *"directories named after a
tool"* — is worse than blind: it would **hit a live profile that no config
mentions.**

## 2. A target never names a profile path

⭐ **A target references a profile by an OPAQUE ID. It does not own, name, or
resolve a path.** Resolution stays where it already is —
`mounts.profilePathFor()` / the driver's mount.

⇒ Then **"move the targets" and "move the profiles" cannot be the same
operation even by accident** — which is stronger than two nouns being read
carefully by someone in a hurry.

⚠ **And this is a REFUSAL of new authority, not a convenience.** For chatgpt's
default client `resolveUserDataDir()` returns **null** today: the profile path
is not a config value at all, it arrives from the driver's mount. That is
*accidentally protective*, and ⛔ **letting a target config name a profile path
would create authority over a 2.2G artifact that a human re-earned by signing
in** — something no config file has today.

## 3. Where targets live — a SIBLING, and nothing moves

```
~/.config/webctl/targets/<name>.toml            mode 600   ← new; nothing moves
~/.config/CLIAI/<client>/webctl/…               untouched
```

⛔ **REVISED. The first draft put targets at `~/.config/CLIAI/webctl/targets/`,
and that is the CLIENT slot.** Measured by `cgwc:main` against its own
resolver:

```
--client default  -> ~/.config/CLIAI/default/webctl
--client webctl   -> ~/.config/CLIAI/webctl/webctl      ← the same directory
--client targets  -> ~/.config/CLIAI/targets/webctl
```

⇒ A target directory there is **structurally indistinguishable from a client
named `webctl`**, and that is not hypothetical — verified on this box, **two of
the three entries in that slot are already tool names**:

```
~/.config/CLIAI/default   ~/.config/CLIAI/linkedin-webctl   ~/.config/CLIAI/telegram-webctl
```

Anything enumerating `CLIAI/*/` as the client list would report `webctl`
alongside them.

⭐ **And this is §1 applied to my own path choice.** Reserving `webctl` as
"not a client name" is a **convention** — and §1's entire argument is that a
convention is necessary and not sufficient, because **a directory listing is
what people and scripts actually read.** *A reserved name is invisible in `ls`.*

⇒ **The fix costs nothing that nesting was buying.** I chose nesting to avoid a
**migration** — but a sibling is a *new* directory, so nothing moves there
either. chatgpt's config stays exactly where it is; its migration cost stays
**nil** (2 keys, untouched since 2026-02-09); and the collision cannot occur
**by construction** rather than by convention.

⚠ If a future reason forces targets inside `CLIAI`, the structural form is a
segment that **cannot be a client name** — a leading dot (`CLIAI/.targets/`) —
never a reserved word. *(cgwc prefers the sibling regardless, so that "is this a
client?" never needs asking. Agreed.)*

⛔ **Host names and tailnet IPs never enter git.** Mode `600`, **fail loud when
absent, and no default IP anywhere in code** — a history import in one lane
nearly published tailnet IPs from older file versions.

## 4. What a target stores — enough to FIND, never the ports

⭐ **Ports are read live from the running containers** (`XPRA_TCP_BIND` on xpra,
`LWC_CDP_PORT` on chromium; absent ⇒ portless). **Never from image labels**,
which are Dockerfile literals rather than facts about a running stack.

⇒ **Store how to FIND the stack; never what you would have to MEASURE.**

⚠ My first draft generalised this as *"a reading is not a state, applied to
config"*, and `ccew` — whose measurement it came from — says that **overstates
it**. What was measured is narrower: ports and bindings read from the **running
containers** were true; **image labels**, being Dockerfile literals, were false.

⇒ A target legitimately stores **config it owns** — the ssh alias, the
transport choice, the slug. Those are not readings, and a rule phrased as
*"never store anything you could observe"* would forbid the file's own
contents.

```toml
# ~/.config/CLIAI/webctl/targets/workstation.toml
name       = "workstation"
# ⛔ TRANSPORT IS PER-SURFACE, NOT PER-TARGET. See below.
control    = "ssh"            # ssh | local      — CDP and X input. NEVER tailscale.
view       = ["ssh", "tailscale-relay"]   # xpra html5; tailscale ONLY via the relay
ssh        = "workstation"    # passed THROUGH to ssh; see §5
slug       = "default"        # base driver cfg slug -> container names
profile_id = "claude-main"    # OPAQUE. Resolved elsewhere. Never a path.
lifecycle  = "owner"          # owner | attach-only   — see §6
```

### ⛔ Transport is PER-SURFACE — a single field lets a user write the forbidden config

⚠ **The first draft had one `transport` field. That was wrong, and it
contradicted §5.** Measured by `ccew` on its remote workstation target, which runs **two transports at
once**:

| surface | what it carries | transport |
|---|---|---|
| **control** | CDP, and X input via `ssh … docker exec … xdotool` | **ssh only**, to loopback |
| **view** | xpra html5 | ssh tunnel for the operator machine **and** a tailscale relay with a source-IP allowlist for phone/tablet |

⇒ So `transport = "tailscale"` would mean **CDP reachable on a tailnet
interface** — exactly what §5 forbids. ⛔ **My own schema permitted the
configuration my own security rule prohibits.**

⇒ Split into `control` and `view`, with `control` accepting only `ssh` or
`local`. ⭐ **Then §5's rule is enforced by the schema rather than by prose** —
which is this document's own §1 argument, applied to the file format. *(ccew.)*

## 5. Transport: `--ssh <value>`, passed through

⛔ **Not a home-grown `--host` resolver.** `--ssh` takes whatever the user would
type after `ssh` and hands it over, so `~/.ssh/config` — aliases, users, jump
hosts, keys — works for free. Measured on a remote target: a bare `user@host` **fails**;
only the `Host` block works.

* ⛔ **CORRECTION — `ssh "$value" -- <argv…>` IS NOT INJECTION-SAFE.** The first
  draft said it was. It is not, and this was a security claim in a document
  about controlling signed-in browsers.

  ssh's own manual: *"the arguments will be **appended to the command,
  separated by spaces**, before it is sent to the server to be executed."*
  ⇒ The remote side receives a **string**, and the **remote shell re-parses
  it**. `--` only stops **local** option parsing. So `ssh host -- echo 'a;b'`
  still runs `echo a; b` remotely.

  ⇒ Safety requires one of:
  * **each remote argv element quoted for the remote shell** (`printf '%q'` per
    element), or
  * ⭐ **a fixed remote entry point that reads the data on stdin** — the shape
    `type-secret` already uses (`… xdotool type --file -`).

  ⚠ And it matters most for precisely the argv that carries untrusted text:
  **`xdotool type` payloads, URLs, search strings** — page-derived or
  user-supplied. Page text is attacker-controllable, so this is **a path from a
  web page to a shell on the target host.**

  ⭐ **Now specced, with the measurements, as `safety-safe-invocation-file-payloads-r7x2`
  §1b** — written by `ccew` from a real two-host pair, including the table showing
  `;` and `$(…)` executing remotely through an argv array. ⇒ Read that § rather
  than this paragraph: it also records **why Principle 1 of that document was not
  enough to prevent the claim above**, which is the more useful lesson than the
  correction itself.
* ⛔ **A DEDICATED connection: `ControlMaster=no`, `ControlPath=none`.** With
  multiplexing **the forward belongs to the master and outlives Ctrl-C** — a
  tunnel into a signed-in browser's control surface, still open after the user
  believes they closed it.
* **Loopback on the target, always.** CDP and xpra bind `127.0.0.1` on the
  remote host and are reached through the authenticated tunnel. ⛔ Never bind
  either on a routable interface: a "reachable" port would place a signed-in
  browser's full control surface beside whoever else is on that network.
* Tailscale viewers go through a relay with a **source-IP allowlist**
  (tailnet IPs are WireGuard-authenticated), re-resolved periodically, with a
  durable accept/refuse **audit log** — because a viewer is full keyboard and
  mouse on a signed-in browser.

## 6. Sharing one browser between tools

⚠ **This is the next real configuration, not a hypothetical** — Greg wants
`perplexity-webctl` on the same remote instance that already runs the Claude
extension and HoloTab.

### ⛔ (a) ONE lifecycle owner; everyone else is attach-only

A restart **logged the Claude extension out** — the cookie survived, the
extension token did not. ⇒ A second tool on a shared browser must be
**structurally unable** to restart it: `lifecycle = "attach-only"` removes the
verb, rather than documenting that you should not use it.

### ⛔ (b) X INPUT IS A SINGLE LEASED RESOURCE

Keystrokes go to **X focus**, not to a tab. Greg's own concurrent use moved
focus mid-run. Once two tools, a human, and an 11-device viewer can drive one
browser, **keys land in the wrong place** — and an effect-based after-check
only discovers it *afterwards*.

⇒ **A lease on X input is a PRECONDITION for sharing a browser, not an
optimisation.** Acquire before typing, release after; refuse to type without
it.

### ⭐ The lease reuses `profile-lock` — and its PLACEMENT is the whole question

⛔ **Put the lock where the CONTENTION is: on the TARGET HOST, beside the X
server.** A lock held where the *tools* run does not constrain a tool on
another machine — the operator machine and a laptop each take their own local lock and both
type into the same X display. ⇒ Acquire it over the same transport the tool is
already using. *(webctl:mgr.)*

⚠ **And `profile-lock` already spans hosts correctly, which was not obvious.**
Measured: `acquire()` records `hostname: os.hostname()` (`:155`), and
`isHolderAlive()` returns **`{alive: true, reason: 'remote'}`** for a lock held
by a different host (`:86`) — it **fails closed** on a foreign holder rather
than taking it over.

⇒ So there is nothing to build and nothing to replace. **But that correct,
already-paid-for check is reachable only if both parties see the SAME LOCK
FILE.** Place the lock locally and the hostname comparison has nothing to
compare against: the guard exists, is right, and is **structurally unable to
fire** — the same shape as a guard that could not fire until an `ENV` line came
out of three Dockerfiles.

⇒ ⭐ **The mechanism is sound; only the placement can make it vacuous.**

⭐ **And `ccew` measured the placement on its remote target: the profile AND
base's lock file already live on the TARGET's filesystem, where the X server
is.** Its operator-machine tools take
**no lock at all** today — they attach over ssh.

⇒ So the lease is taken **in the same remote process that injects the input**:

```
ssh "$TARGET" flock -w5 <lease> docker exec … xdotool …
```

Acquire and act become **one command on the target host, with no window between
them**, and a tool on any machine necessarily contends on the same file.
*(ccew: mgr's "the lock must be where the contention is", made atomic.)*

### ⛔ A LEASE IS NECESSARY AND NOT SUFFICIENT — the contender was a HUMAN

⚠ **This section first read as though the lease were the whole answer. It is
not.** The contender that moved X focus mid-run was **Greg, in a viewer** —
and **no lease binds a human.**

⇒ So the lease must be paired with **concurrent-use detection**: before and
after each input burst, check that **window focus, active tab and focused
element changed only as our own keys predict**; otherwise **pause and report**
rather than continue typing.

⭐ **And add "the xpra screen size changed" to the signals.** It changes when
any viewer **attaches or resizes** — measured repeatedly — which makes it **the
earliest sign a human has arrived, before they touch anything.** *(ccew.)* ⇒ The
other signals fire once the contention has already happened; this one fires
before it.

⚠ **Lease file: `profiles/<slug>/x-input.lease` — BESIDE the chromium dir, not
inside it**, because chromium owns the inside. Same argument already adopted for
`isolation-accept.json`. And never globbed. `flock` is present on the target
(util-linux 2.39.3, checked by ccew).

⚠ Without that, a shared browser is protected against other *tools* and
unprotected against the *person* most likely to be using it. *(ccew, correcting
a narrowing in my first draft.)*

### ⛔ Never glob `profiles/*/` — match the exact configured path

The protected pre-sign-in baseline (`profiles/<slug>/chromium.pre-signin-…/`)
still contains a stale `SingletonLock`. ⇒ Anything globbing for profiles or
locks **finds a live-looking lock inside an artifact that must never be
touched.**

✅ base does not glob today — verified, every path is matched exactly — and
this is recorded so it stays that way. *(ccew.)*

### (c) Tabs by `targetId`, never by index

`/json` is MRU-ordered, so an index names a different tab the moment anyone
touches the browser.

### ⛔ (d) FAMILY DEFAULT: in an authenticated profile, a guest tool gets NO CDP WRITE

**Ruled by `webctl:mgr` for `ccew` and raised here, by `ccew`, to be the default
for the family rather than one lane's deny-list. Adopted.**

In a profile holding **authenticated sessions**, a tool that is not the
lifecycle owner — a *guest* — gets:

* ✅ **READ-ONLY CDP, on its OWN tab, addressed by `targetId`** (§c), and nothing
  else;
* ⛔ **no CDP WRITE at all** — not `Input.*`, not `Runtime.evaluate`, not
  navigation;
* ⇒ **actions go through X, under the input lease** (§b).

⭐ **Why a deny-list of CDP methods is the wrong shape, and a posture is the
right one.** `Runtime.evaluate` on a signed-in tab is equivalent to the session:
it can read any cookie the page can, issue any authenticated request, and
exfiltrate to anywhere. So the guest/owner line is **not about which methods are
dangerous** — it is about which tool is *accountable for the browser*. A deny-list
enumerates today's dangerous methods; a posture survives CDP gaining a new one.

⚠ **And this is why the transport rules in §5 are load-bearing rather than
cautious.** If CDP is reachable on a routable interface, "guest tools get
read-only" is a statement about our own code and about nobody else's. The
posture is only meaningful behind loopback + an authenticated tunnel.

⇒ Note what the default costs: a guest cannot type, click or navigate without
taking the X-input lease, which is deliberately **serialised and contended**
(§b) — including against a human, who holds no lease at all. That is the intended
trade. A tool that finds this too slow is asking to be the lifecycle owner of its
own target, which is §6(a)'s answer, not an exception to this one.

### (e) One visible side panel, and the screen size

The xpra screen size follows the latest viewer; only one side panel is visible
at a time. Both are properties of the shared stack, so both belong to the
target rather than to whichever tool attached most recently.

## 7. Isolation is target-declared and tool-enforced

An extension holding **`cookies` (with host access to the signed-in site)** AND
**third-party egress** (`host_permissions`, or `connect-src` beyond its vendor)
can carry a session off the machine.

⇒ A target **declares which extensions it runs**, and the tooling **refuses**
to co-locate such an extension with a signed-in session — unless an **explicit
accept** has been recorded.

⛔ **But the check runs against the manifests of what is actually INSTALLED IN
THE PROFILE, never against the target's declared list.** Web-Store installs and
**auto-updates change the set with no config edit at all** — so a declared list
is a statement about intent, and the profile is the statement about fact.
⇒ The declaration says what *should* be there; the manifests say what *is*, and
a mismatch is itself a finding. *(ccew.)*

⛔ **The accept lives BESIDE THE PROFILE and is only REFERENCED from the
target**, by the same opaque id the target already uses for the profile.

* An accept is a judgement about **this profile's exposure on this machine** —
  which extensions, signed into what. ⇒ A **syncable** accept is *a declaration
  that was correct when written and silently becomes wrong later* — the same
  shape as the retired xpra `+1` port and the log-rotation filename patterns,
  *with a plane ticket*.
* ⭐ **And it comes free: profiles are already non-syncable by policy**, so
  placing the accept beside one **inherits** the right non-portability rather
  than asserting it. *A rule that must be remembered is weaker than a location
  that cannot travel.*
* Reference-not-contain keeps it discoverable: *"where is the accept"* is
  answerable from the target without the target **owning** it — the same
  separation §2 already makes for paths. *(cgwc:main, refining webctl:mgr.)*
* ⛔ **AND THE ACCEPT IS BOUND TO WHAT IT JUDGED** — extension **ids +
  versions + a hash of the permission set**. ⚠ Extensions **auto-update**: an
  accept given for HoloTab 1.4.0 must **re-prompt** if 1.5.0 adds a permission.
  An unbound accept is a judgement that silently outlives its subject.
* **Beside the chromium dir, not inside it** —
  `profiles/<slug>/isolation-accept.json` — because **chromium owns the
  inside**. *(ccew.)* ⚠ Refuse-by-default rather than warn: the
asymmetry is that a wrongly-refused bring-up prints what to do, and a wrongly
allowed one exfiltrates a session.

## 8. One tool, several targets

**Each invocation names exactly one target** (`--target <name>`, default from
config). A tool may *know* several; it acts on one.

⇒ `status` with three known targets shows **three rows**, each with its own
reachability — and per `gu1d`, a target that is configured but has no stack is
`configured: true, running: false`, which is not the same as one that is not
configured at all.

## ⛔ What this design does NOT do

* **It does not move anything.** No existing config is relocated; targets are a
  new, additive location. The one migration anyone might reach for —
  consolidating `~/.config/<tool>/` — is the one §1 refuses.
* **It does not give config authority over profile paths**, and that omission
  is the point rather than an oversight.
* **It does not build the remote mechanics.** `xq` owns the remote-execution
  capability; base owns the **convention**. ⇒ Coordinate rather than implement
  twice.
* **It does not decide `--client` vs `--target`.** ⚠ `--client` already means
  *driver cfg slug* in at least one lane; reusing it for a location is a second
  noun collision, which is what this document exists to avoid. Recommending
  `--target`, and flagging it as a question for the lanes that ship `--client`.

## ⚠ Open, for the lanes rather than for me

⚠ **Answers are attributed.** ⭐ **`ccew` has now answered from my summary and
has NOT yet read the doc** — it says so itself and will send a second pass. So
these are resolved on the questions it addressed and **open on anything the doc
says beyond my summary of it.**

1. **Does the lease need to be cross-machine?**
   ⇒ *webctl:mgr:* **yes, and it lives on the target host** — *the lock must be
   where the contention is*. ✅ Adopted into §6(b) above, with the correction
   that `profile-lock` already handles the cross-host case and only its
   **placement** can make it vacuous.
2. **Where does the §7 accept live?**
   ⇒ *webctl:mgr:* **beside the PROFILE, not in the target.** The accept is a
   judgement about *a specific browser's contents* — which extensions, signed
   into what. The target is syncable; the profile is not. ⛔ An accept in the
   target **travels to machines where the thing it judged is different**.
   ⭐ *"Clearance does not travel across a hop"* — a judgement is not
   transferable because its grounding is not transferred with the conclusion.
   ⇒ **The target may DECLARE that an accept is required; the accept itself
   stays with the profile it judges.** ✅ `ccew` agrees, and adds that the
   accept must be **bound to extension ids + versions + a permission-set hash**
   because extensions auto-update. Settled.
3. **`--client` holders**: rename to `--target`, or accept both with one
   documented as an alias?
   ⇒ *webctl:mgr:* `--target` is right for the new concept regardless;
   **whether and when `ccew` renames its existing `--client` is `ccew`'s call,
   since it pays.** ✅ `ccew` agrees and will pay the
   rename where they collide — `--target` for WHERE, `--client` for WHICH
   STACK. It also confirms **targets above client**: on that target slug and location
   move together *only by accident*, and one host could carry two slugs.
