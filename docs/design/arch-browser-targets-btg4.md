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
* the check scans **the filesystem**, never the config files. ⚠ That is
  load-bearing: an orphaned 118M authenticated profile exists on this box
  **referenced by no config and mounted by no container**, so a config-keyed
  sweep would not see it, and a sweep keyed on *"directories named after a
  tool"* would hit a live profile no config mentions.

⇒ *A convention depends on being read carefully. A guard does not.*

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

## 3. Where targets live — NEST, do not re-home

Config is **already** shared-namespaced at `~/.config/CLIAI/<client>/webctl/`.
So this is *"re-home an existing shared location"*, and the answer is: **do not.**

```
~/.config/CLIAI/webctl/targets/<name>.toml      mode 600
```

* **Nesting is additive** — a new directory appears and nothing moves. Replacing
  the CLIAI namespace is a *migration*, and a migration near profile-shaped
  directories is the operation §1 exists to refuse. ⇒ Do not open with the
  hazard class this design is about.
* ⭐ **Targets sit ABOVE `<client>`, not inside it.** A target is *where a
  browser is*; a client is *which persona*. One target legitimately serves
  several clients, so nesting it under one would force a copy per client —
  duplication with a different shape.
* Migration cost measured: chatgpt's real config is **2 keys, untouched since
  2026-02-09**. ⇒ The cost was never in the files. It was entirely in the noun.

⛔ **Host names and tailnet IPs never enter git.** Mode `600`, **fail loud when
absent, and no default IP anywhere in code** — a history import in one lane
nearly published tailnet IPs from older file versions.

## 4. What a target stores — enough to FIND, never the ports

⭐ **Ports are read live from the running containers** (`XPRA_TCP_BIND` on xpra,
`LWC_CDP_PORT` on chromium; absent ⇒ portless). **Never from image labels**,
which are Dockerfile literals rather than facts about a running stack.

⇒ *A reading is not a state*, applied to configuration: **a port written into a
target goes stale the moment a container is recreated**, and a stale port in a
config file is indistinguishable from a current one.

```toml
# ~/.config/CLIAI/webctl/targets/bp17.toml
name       = "bp17"
transport  = "ssh"            # ssh | tailscale | local
ssh        = "bp17"           # passed THROUGH to ssh; see §5
slug       = "default"        # base driver cfg slug -> container names
profile_id = "claude-main"    # OPAQUE. Resolved elsewhere. Never a path.
lifecycle  = "owner"          # owner | attach-only   — see §6
```

## 5. Transport: `--ssh <value>`, passed through

⛔ **Not a home-grown `--host` resolver.** `--ssh` takes whatever the user would
type after `ssh` and hands it over, so `~/.ssh/config` — aliases, users, jump
hosts, keys — works for free. Measured on bp17: a bare `user@host` **fails**;
only the `Host` block works.

* **Injection-safe by construction**: `ssh "$value" -- <argv…>`, never a shell
  string assembled from parts.
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
`perplexity-webctl` on the same bp17 instance that already runs the Claude
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
it. ⚠ This is the same shape as `profile-lock` and should reuse its
already-paid-for semantics (ownership recorded, takeover only on a dead
holder) rather than inventing a second locking model.

### (c) Tabs by `targetId`, never by index

`/json` is MRU-ordered, so an index names a different tab the moment anyone
touches the browser.

### (d) Per-tool CDP posture, and (e) one visible side panel

The xpra screen size follows the latest viewer; only one side panel is visible
at a time. Both are properties of the shared stack, so both belong to the
target rather than to whichever tool attached most recently.

## 7. Isolation is target-declared and tool-enforced

An extension holding **`cookies` (with host access to the signed-in site)** AND
**third-party egress** (`host_permissions`, or `connect-src` beyond its vendor)
can carry a session off the machine.

⇒ A target **declares which extensions it runs**, and the tooling **refuses**
to co-locate such an extension with a signed-in session — unless the target
records an **explicit accept**. ⚠ Refuse-by-default rather than warn: the
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

1. **Does a shared target need the lease to be cross-machine?** The X server is
   on the target host; the tools may not be.
2. **Where does the accept in §7 live** — in the target file (syncable, and
   therefore travels to machines where the judgement may not hold), or beside
   the profile (not syncable, but then it is not target-declared)?
3. **`--client` holders**: is renaming to `--target` worth the break, or should
   base accept both with one documented as the alias?
