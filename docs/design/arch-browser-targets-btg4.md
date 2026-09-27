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
kind       = "docker-xpra"    # docker-xpra | direct — see below; `direct` has no
                              # container, so `slug` and `view` do not apply
slug       = "default"        # base driver cfg slug -> container names
base       = "debian"         # chromium image variant: debian | arch | ubuntu
profile_id = "claude-main"    # OPAQUE. Resolved elsewhere. Never a path.
lifecycle  = "owner"          # owner | attach-only   — §6, and see the (tool,target) note
```

#### ⛔ `base` and `kind` were MISSING — found independently by TWO lanes

**`linkedin` and `fetlife` reported the same gap from different code**, which makes
it a design signal rather than one lane's local detail.

`linkedin`, measured — the container name does **not** carry the image variant:

```
base=debian  xpra=<tool>-xpra-default  image=<tool>/chromium-debian:latest
base=arch    xpra=<tool>-xpra-default  image=<tool>/chromium-arch:latest
```

⇒ **Same container name, different image.** Two targets differing only by base are
**indistinguishable in the schema and collide on container identity in reality.**
⚠ And `buildDriverCfg()` returns `mode: null, base: null` — the mode arrives
separately through an env var — so a target **cannot inherit it from the cfg**
either. `fetlife` reports the same from its side: `--base ubuntu|debian|arch`
selects the driver mode, `DEFAULT_BASE` is `debian`, and container names plus the
Dockerfile path both derive from it, so a target naming `slug` but not `base`
**cannot address a stack someone brought up as `arch`.**

`linkedin`, second gap — **not every mode is containerised.** `localhost-direct` is
a live mode: a plain host Chromium on a CDP port, whose module contains **zero**
mentions of slug or container. A target for it would carry `slug` as a meaningless
field and `view` as inapplicable, because there is no xpra. ⇒ Hence `kind`:
`slug`, `base` and `view` are **conditional on `kind = "docker-xpra"`**, and a
schema that pretends otherwise forces two lanes to write fields that mean nothing.

##### ⛔ `kind` NEEDS A THIRD VALUE, AND IT WAS MIXING TWO CONCEPTS

**`perplexity` measured that neither value covers them, and found the worse problem
underneath.** Their targets are two **pre-existing** browsers in manager-created
zones on a remote host, reached over ssh:

* `"direct"` does **not** fit — their CDP port is **neither stable nor owned by a
  local browser**; it is resolved **live from a zone manager's labels over ssh**.
* Proposed third value, working name **`managed-zone`**, with `{ssh, zone, app,
  control}`.

⭐ **AND THE DEEPER FINDING: `kind` as drafted CONFLATED LIFECYCLE/TRANSPORT WITH
BROWSER ENGINE.** One of their two targets is **Opera**. ⇒ **Engine belongs in its
own field**, because a target can be (managed-zone, Opera) or (managed-zone,
Chromium) and `kind` cannot express both axes. This is
`arch-coincident-fields-t2wf` in advance: two concepts sharing one field are
indistinguishable from one concept, and the collision only shows up when a
deployment needs them to differ.

⚠ **AND THE ENGINE CANNOT BE SNIFFED FROM CDP.** Measured by `perplexity`:
Opera's `/json/version` reports **`Browser: Chrome/151`**. Only the user-agent's
`OPR/` token or the brand list identifies it. ⇒ So a target must **declare** its
engine; a tool that detects it from `/json/version` will confidently call Opera
Chromium, and any engine-conditional behaviour will silently take the wrong branch.
That is a stated-not-measured field by necessity — the one case where §4's *"store
how to FIND, never what you would MEASURE"* inverts, because the measurement lies.

#### ⚠ `lifecycle` is per-target, and OWNERSHIP IS PER (TOOL, TARGET)

**`substack` falsified the single-value form, measured.** Their lane has an owner
tool and a separate extractor that **always attaches to a browser it did not bring
up**:

```
grep -c "driver.start|createChromiumDockerXpra|makeDriver" <extractor>  ->  0
```

The extractor takes `--cdp <url>`, checks reachability, and tells the operator to
start the container first. ⇒ **It is structurally an attacher.** One lane, one
stack, **two lifecycle values**, and `linkedin` reports the same split shape from
its own code.

⇒ So either `lifecycle` belongs to the **(tool, target)** pair, or a lane needs two
target files naming one stack — which would be a lie about there being two stacks.
**Not resolved here.** ⭐ And note what the field cannot do even then: `lifecycle`
states **intent**, and **nothing states the FACT of who brought the browser up.**
That is §7's declaration-versus-installed distinction applied to ownership — and
§7 already argues the fact side is the one that matters.

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

### ⛔ FALSIFIED: the lease CANNOT reuse `profile-lock` as it stands

**`fetlife` falsified this section against base's own code, and I reproduced it.**
An earlier draft said *"the mechanism is sound; only the placement can make it
vacuous."* ⇒ **Placement is not the only thing.**

```
lib/browser-location/profile-lock.js:36
  const LOCK_FILENAME = `.${C.PROJECT}.lock.json`;
```

The lock filename **embeds the consuming tool's project name**. Measured here,
two tools against one shared profile directory:

```
tool A lock:  <shared-profile>/.alpha-webctl.lock.json
tool B lock:  <shared-profile>/.beta-webctl.lock.json
SAME FILE? false   ⇒ THEY NEVER CONTEND
```

⭐ **So two tools sharing one profile take two DIFFERENT lock files and never
contend** — with perfect placement, on the target host, beside the X server, over
one transport. The cross-host `isHolderAlive() -> {alive:true, reason:'remote'}`
guard is real and correct, and **it has nothing to compare against between tools,
because the two parties never open the same file.**

⚠ **And there is a second layer beneath it** *(also `fetlife`)*: the profile
PATHS are per-tool too — `cacheRoot()` resolves through `createStoragePaths(C)`,
so each tool's profiles live under its own cache root. Sharing therefore needs an
explicit `userDataDir` override in **both** tools, and even then the filename
splits them.

⇒ **This is this document's own guard-that-cannot-fire shape, in the mechanism it
chose to enforce §6.** The lease was the part of §6(b) doing the work, and as
specified it could not have arbitrated anything.

⇒ **The fix must make both parties name the SAME file.** Either a lock keyed by
**target + `profile_id`** rather than by `C.PROJECT`, or an explicit lease path
carried in the target file. ⚠ Whichever is chosen, §2's *"a target names a profile
only by an OPAQUE id, never a path"* must resolve to **one concrete path outside
every per-tool cache namespace** — otherwise the indirection re-introduces the
split it was meant to remove. **Not yet designed; this is the open item §6(b)
depends on.**

✅ **What IS already satisfied, measured by `fetlife`:** repeated `docker up` on
one target is **idempotent** — `StartedAt` unchanged across three ups,
`RestartCount=0` — so base's driver already refuses to restart a running stack,
which is exactly the §6(a) hazard *within one tool*. ⇒ **§6(a) is satisfied for
same-tool contention and unenforced for cross-tool contention.** Those read as one
problem and are two.

### On PLACEMENT, which was the original question here

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

#### ⭐ GUEST IS ABOUT WHOSE BROWSER IT IS, NOT ABOUT WHAT THE TOOL DOES

**The categories are named by OWNERSHIP.** A tool driving a browser **it owns** is
that target's lifecycle owner and **may evaluate in its own profile**. The guest
posture applies **only** to a tool that is a guest in **another tool's**
authenticated browser.

⚠ **This had to be said explicitly, because as first written the posture read as
banning `Runtime.evaluate` outright — which would have broken every extraction
lane.** DOM extraction commonly *uses* `Runtime.evaluate`: it is how computed
text, shadow content and virtual-scroll state get out of a page. A posture that
forbade it to all tools would have made `data-dom-content-extraction` work
impossible, and the doc would have shipped a rule the family could not follow.

⇒ Ruled by `webctl:mgr`: this **reclassifies nobody today** — each lane runs its
own stack with its own login, so each is already an owner. The only live guest
case is a lane joining another lane's browser.

⛔ **Two resolutions REJECTED, with reasons**, because the discarded options are
the useful part:

* *"Guests may evaluate, but only on their own `targetId` and with no network side
  effects"* — **rejected: CDP cannot enforce it.** It would be honour-system, and
  §1 of this document exists to say a guard beats a convention.
* *"Add a third posture between owner and guest"* — **held, not adopted.** An
  unused posture is spec for code that does not exist. Add it when a real lane
  needs it.

#### ⛔ OPEN: nothing ESTABLISHES ownership at the point of use

**`substack` found the hole under the ruling, and it is the one I would fix next.**
The postures are defined; **how a tool KNOWS which one it is in is not.**

Their extractor takes `--cdp <url>` — a free-form URL. ⇒ **A copied command line
or a typo'd port points it at another tool's authenticated browser, where it would
evaluate page JS.** Nothing in the CDP connection carries ownership, nothing in
this document stops it, and nothing in their code can tell.

⭐ **So ownership as specified is a property of a (tool, target) pair established
by WHO CALLED `start` — and that fact is not recorded anywhere a second tool can
read it.** ⚠ That means the earlier ruling's *"this reclassifies nobody today"* is
true of today's **intent** and is not **enforced** by anything.

#### ⛔ BUT "WHO CALLED START" IS THE WRONG TEST — THE HARM IS WHOSE SESSIONS ARE IN THE PROFILE

**I had this wrong, and `webctl:mgr` corrected it from the code.** I reasoned that a
tool which never calls `start` is a guest by construction, and concluded that a lane
attaching to browsers it did not itself launch had been misclassified. ⇒ That
conflates the **mechanism** with the **harm**.

§6(d) exists because **`Runtime.evaluate` in a profile holding SOMEONE ELSE'S
authenticated sessions is equivalent to those sessions.** So the test is *whose
sign-ins are in this profile*, not *which process called start*:

| situation | guest? |
|---|---|
| tool evaluates in a profile holding **another party's** sessions | ⛔ **yes** — §6(d) applies |
| lane's bring-up script starts a browser; lane's CLI attaches to it | ✅ **no** — **one owner split across two processes** |
| tool attaches to a profile holding only **its own** sign-ins | ✅ no |

⭐ **"An owner split across two processes" is a real third category, and it is not
a guest.** A lane whose own bring-up script creates the target, whose profiles hold
only its own sign-ins, and whose CLI then attaches, is the target's owner — the
split is an implementation detail of that lane, not a trust boundary. Measured by
`webctl:mgr` by reading one lane's own bring-up script rather than inferring from
its CLI's flags.

⇒ **What survives of the original finding is the half that matters:** nothing lets
a tool CHECK which row of that table it is in. If a bring-up script and a CLI
disagree about the target, or another lane's browser answers on the stated port, the
attacher cannot tell. The classification is sound; it is simply **unverifiable at
the point of use**.

#### ⭐ CANDIDATE ANSWER: AN OWNERSHIP TOKEN, VERIFIED BEFORE ANY ATTACH

*(Design adopted by `webctl:mgr` for the new-tool template; recorded here because
btg4 is where it has to be settled.)*

* **Established when the tool — or its own bring-up script — CREATES the target.**
* **Token = (tool id, target name, a random nonce)**, written into the target's own
  metadata (container labels, or a file inside the target's data dir) **and mirrored
  in the tool's target config.**
* **Verified before ANY CDP attach.**
* ⛔ **Mismatch or absence is a REFUSAL, not a warning** — consistent with §7, which
  refuses rather than warns for the same reason: a warning on a path that otherwise
  works is a warning nobody reads twice.

⭐ **AND A LANE ARRIVED AT A STRONGER FORM INDEPENDENTLY.** `perplexity` audited
its own attach path after reading this section and found the hole in it: their CDP
port is *stated* in a target file rather than a free-form URL, and `connect()`
verifies the browser **kind** — but **a stale or typo'd tunnel reaching another
tool's Chromium would pass a kind check.** Their planned fix does not add a token to
a stable port; it removes the stable port:

* the CLI builds its tunnel **per invocation**;
* it resolves the remote CDP port through the **zone manager's ownership labels**
  (zone + app + owner uid) on the target host;
* it forwards to an **ephemeral local port it owns for that call**;
* the remote command travels **on stdin** (`safety-safe-invocation-file-payloads-r7x2`
  §1b), not as interpolated argv;
* a stable port survives only for an explicit persistent mode, **which warns that
  identity is weaker there**.

⇒ **Identity established BY CONSTRUCTION at the point of use, rather than checked
against a record.** That is strictly better than a token wherever it is achievable:
there is no stale port left to typo, so the failure mode is *absent* rather than
*detected*. ⚠ It is not always achievable — it needs a manager that labels
ownership and a transport you can build per call — so the token remains the general
answer and this remains the preferred one.

⭐ **Prior art for the LOCK fix, from the same lane:** their lock is keyed by
**target name, per invocation** — which is exactly the identity §6(b) needs and
`C.PROJECT` is not.

⚠ **Design this WITH the lock-identity question, not after it.** Both are *"who owns
this target"*: the lease needs an identity that is not `C.PROJECT`, and the attach
check needs an identity a second process can verify. ⇒ Solving them separately
means the second fix re-derives the first, and the two answers can disagree — which
is how a profile ends up with one notion of ownership for locking and another for
attaching.

⇒ `substack`'s minimum viable form, which I think is right: **the thing that
brought the browser up leaves a token beside the profile, and an attacher that
cannot present it knows it is a guest.** That does not make the posture
enforceable against a determined caller — but it converts an **honour system into
a detectable state**, which is the difference §1 of this document is about.

⚠ **This is the same gap as the lease's**, one level up: both need an identity
that lives with the TARGET rather than with the tool. Solve them together or the
second fix will re-introduce the first.

#### A guest is not blind — and where it genuinely goes dark

Much read-only extraction does **not** need to run page JS *(toolkit contributed
by `webctl:mgr`; not re-measured here)*:

| need | CDP method | runs page JS? |
|---|---|---|
| markup, incl. shadow roots | `DOM.getDocument({pierce: true})` | no |
| an element's markup | `DOM.getOuterHTML` | no |
| computed accessible names | `Accessibility.getFullAXTree` | no |
| **rendered article text** | **`Runtime.evaluate` (`innerText`)** | **YES** |

⛔ **THE GAP HAS TWO HALVES, AND THE SECOND IS THE DANGEROUS ONE.** The first
draft of this section named only the first, which `substack` falsified by
measurement.

**(i) State not yet MATERIALISED.** Virtual-scroll content that does not exist in
the DOM until a scroll handler runs; lazy state behind an event. No markup read
reaches it.

**(ii) RENDERED-TEXT SEMANTICS.** The content *is* in the markup, and page JS and a
markup read **disagree about what the text IS.** `innerText` is
**layout-dependent**: it excludes `display:none`, `<template>` and `<script>`
bodies, and collapses whitespace per CSS. Measured by `substack` against a live
stack with a self-authored `data:` URL — no network, no third-party content:

| read | contains `display:none` text? | contains `<script>` body? |
|---|---|---|
| `innerText` (page JS) | **no** | **no** |
| `DOM.getOuterHTML`, tags stripped | **yes** | **yes** |

⇒ **No markup read reproduces `innerText`**, and `Accessibility.getFullAXTree`
gives accessible *names*, not an article body.

⭐ **AND THE TWO HALVES FAIL IN OPPOSITE DIRECTIONS, WHICH IS WHY (ii) LEADS:**

| gap | symptom | is it noticed? |
|---|---|---|
| (i) not materialised | **EMPTY** result | ✅ yes — emptiness is loud |
| (ii) rendered-text semantics | **LONGER, plausible, CONTAMINATED** result | ⛔ **no** |

⚠ **AND IT CAN INVERT A SAFETY GATE RATHER THAN MERELY DIRTY AN OUTPUT.**
`substack`'s recovery check passes when extracted text is *substantially longer*
than a known preview and free of paywall markers. Markup-derived text is **longer**
(hidden boilerplate, `<template>`, `<script>`) and can be marker-free ⇒ so a
guest-mode extraction pushes **toward a false "recovered" verdict** instead of
failing closed. Their suite already carries a known-failing case of exactly that
over-capture shape, which is how the direction is known rather than guessed.

⇒ **That is the point at which a guest must become an owner of its own target** —
not a reason to weaken the posture. And extending the original wording: not
something to leave a lane to discover as a mysterious empty result — **a
mysterious WRONG result is not discovered at all.**

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

## 8. One tool, several targets — and one tool, ONE target that is not local

⭐ **§8's title was costing it its most relevant reader** *(`substack`)*. For a
cache/extraction lane, *"several targets"* is an interactive-driver problem it does
not have: one publication, one browser; multiple publications would be multiple
**slugs**, not multiple targets. Target *switching* buys such a lane nothing — so
its reviewer skims the heading, concludes the document is not for them, and misses
the only part that is.

⇒ **The part that is:** the authenticated browser **need not be on the machine
that runs the extraction.** Their blocker for weeks has been that a **human** must
sign in at a GUI, and that GUI is xpra html5 on one box. If the human were at
another machine, they would need exactly the `view` transport of §4 — with
`control` staying loopback, because the extraction itself is CDP.

⇒ So the second shape is **"one tool, ONE target that is not local", driven by
WHERE THE HUMAN IS** rather than by which browser to pick. Same mechanism, opposite
motivation, and the two deserve separate names.

### ⚠ A remote target implies THAT HOST BUILT ITS OWN IMAGES

*(`fetlife`, measured the hard way.)* base passes **UID/GID as build args**, so
images are **machine-specific**. Moving one with `docker save | ssh docker load`
produced a container running as the *source* machine's uid against a profile
directory owned by a different one ⇒ `Permission denied` ⇒ chromium
`Exited(133)` with a crashpad error **several layers from the cause.**

⇒ State it in the target contract, because **the failure surfaces as a browser
crash rather than as a mismatch** — and a crash sends the reader to the browser,
which is the one place the answer is not.

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
* **It does not build the remote mechanics.** A separate **zone-manager** tool owns
  the remote-execution capability; base owns the **convention**. ⇒ Coordinate rather than implement
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
