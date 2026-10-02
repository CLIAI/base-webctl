---
id: rm7t
title: "Remote targets — shortcuts, remote build/refresh, and a read-only inventory"
category: arch
created: "2026-10-02"
updated: "2026-10-02"
status: draft
tags: [remote, ssh, tailscale, build, refresh, inventory, registry, versions]
tech:
  - name: "OpenSSH"
    version: ">=8"
relates_to: [btg4, ow9k, lg1n, r7x2, gu1d, f6rd, k3wn]
depends_on: [btg4, ow9k]
expands: [btg4]
similar_to: []
---

# Remote targets — shortcuts, remote build/refresh, and a read-only inventory

## 0. The ask, and what already exists

Greg, 2026-10-02: comfortable shortcuts such as `--ssh <host>` and `--tailscale
<host>` for attaching to browsers on other machines; building and refreshing their
containers remotely; and a registry under `~/.config/webctl/` listing where `*-webctl`
instances run, which versions, and what needs updating.

**Already designed in `arch-browser-targets-btg4`** (draft): `--ssh <value>` passed
through to `ssh` so `~/.ssh/config` works, on a dedicated connection; per-target files
`~/.config/webctl/targets/<name>.toml`, mode 600; `--target <name>`; transport split per
surface, with control never on tailscale.

**Not designed until now, and covered here:** (1) what `--tailscale` means, (2) remote
build/refresh, (3) a fleet inventory.

## 1. `--tailscale <host>` — reaches the SSH endpoint, nothing else

✅ **Ruled:** `--tailscale <host>` is **sugar for an ssh destination reached over the
tailnet**. It changes *how ssh gets there*, never *what is exposed*.

* ⛔ It **never puts CDP or xpra on the tailnet.** CDP and xpra stay bound to loopback
  on the target and reached **through ssh**. (`btg4` §5; `webctl:mgr`.)
* ⛔ `control = "tailscale"` is **refused with its own message**, not a generic schema
  error, so the operator learns *why*: *"control never travels over the tailnet; use
  `--tailscale <host>` to reach ssh, and control goes through ssh."*
* Tailnet **viewing** (a relay a phone or tablet can reach) is the node-ID allowlist in
  `webctl:mgr`'s template spec, D7. **Out of scope here.**
* Transport rules carry over unchanged: `--ssh` is a pass-through, **dedicated**
  connection (`ControlMaster=no`, `ControlPath=none`, `ForwardAgent=no`), and every
  remote command is a **fixed entry point reading data on stdin**
  (`safety-safe-invocation-file-payloads-r7x2` §1b) — never interpolated argv.

## 2. The registry — ONE host list, and it is not ours

⛔ **Two registries drift.** The xq zone manager already keeps
`~/.config/xq/machines.toml` (named machines, each with an ssh destination) and owns
image builds for the lanes that use it.

⇒ **Proposed, pending the zone-manager lane's answer:** the zone manager's machine list
is the **single source of truth for HOSTS**. webctl **reads** it — preferably through a
command such as `xq machines ls --json` rather than its file format, because a command
is an interface and a file is an implementation detail — and never writes or mirrors
it.

⇒ webctl adds only what that list does not model: the **target** — which browser, which
profile, which transport, which owner — in `~/.config/webctl/targets/<name>.toml`, and a
target **references a machine by name** rather than repeating its ssh value.

⇒ So the `WEBCTL-REMOTES-AND-VMS.yaml` Greg sketched is answered as **no new host
file**: the hosts layer exists, and a second one is exactly the drift above.

**Rules for webctl's own files:**

* mode **600**, and a file readable by group or other is **refused**, not warned about.
  On the family's shared hosts, accounts without container rights can already reach a
  signed-in browser over loopback (`webctl:mgr`'s D8); a host-and-target map is useful
  reconnaissance for exactly them.
* **Never in any repository.** Public base carries only role-named examples.
* ⛔ **The registry is never an ownership proof.** Being listed says where a browser is;
  only the `ow9k` claim says whose it is.

## 3. Build and refresh — a lifecycle action, behind the ownership claim

✅ **Ruled.** `<tool> gui build|refresh --target <name>` is uniform across lanes, and:

* ⛔ **It goes through the ownership claim** (`ow9k`, template spec §5.5): never build or
  replace a container you did not claim. A shared host is not a sandbox.
* **Images are per host** — the uid is baked in at build time, so an image built on one
  machine fails on another (measured: a moved image ran as the wrong uid and chromium
  exited 133). Build **on the target**, never ship an image to it.
* On zone-manager lanes, build/refresh **delegates to the zone manager**, which owns
  images there. Base does not build what it does not own.
* ⛔ **"Refresh" means FRESH PACKAGES, and it is verified by a READING.** Measured by
  `grok`: a plain rebuild reproduced a **stale** Chromium, because the package layer was
  cached; only a cache-busting rebuild fixed it. ⇒ A refresh is successful only when the
  browser binary's **own reported version** equals the **declared** candidate (e.g. the
  distro's package candidate). **Exit 0 is not success.**

## 4. The inventory — read-only, and every value is a reading

`<tool> targets ls | status | outdated`, plus a cross-tool view over the same data.

* **Read-only.** It never starts, builds or attaches anything.
* ⛔ **Every value is a timestamped READING with its instrument** — what the running
  binary or container reported, when, and via what (e.g. *"chromium --version, read in
  the container at T"*). **Never inferred from a tag name or an image label** — `btg4`'s
  lesson that image labels are Dockerfile literals, not facts about a running stack.
* ⛔ **An unreachable target is an UNKNOWN row, never an omitted one.** An inventory that
  silently drops what it could not reach reports a smaller fleet as a healthier one.
* **"Needs update" compares a reading against a DECLARED target, and names both** — the
  base tag a consumer pins, the browser's package candidate. *"outdated"* alone is not
  actionable; *"reads 154.0.8037.92, declared 155.0.8102.4"* is.
* ⛔ **No new listeners** (D8). The inventory reads over the same ssh connection; nothing
  binds a port to answer it.

## 5. QA — every item executes, with its control

1. `control = "tailscale"` is **refused with its own message**. *Control:* `view =
   ["ssh", "tailscale-relay"]` is accepted.
2. A target file readable by group or other is **refused**. *Control:* mode 600 loads.
3. A `profile_id` that looks like a path is **refused** (`btg4` §2). *Control:* an opaque
   id loads.
4. A refresh is verified by **reading** the browser's version and comparing it to the
   declared candidate. *Control:* a stale reading reports **outdated**, naming both.
5. An unreachable target yields an **UNKNOWN** row: the number of rows equals the number
   of targets.
6. Build or refresh **without** an ownership claim is **refused**.

⚠ **Prose, honestly:** whether a remote host is *suitable* (disk, uid layout, who else
uses it) is an operator judgement and stays one.

## 6. What base ships, and what the lanes do

| piece | owner |
|---|---|
| validators: target schema (incl. the tailscale refusal and opaque `profile_id`), config-file mode, version verdict, inventory completeness | ✅ **base**, `lib/remotes.js`, pure and zero-dependency |
| reading versions over ssh; delegating builds | the lane, or the zone manager on its lanes |
| the host list | the zone manager (pending, §2) |
| the `targets` / `gui build|refresh` verbs | the lane, uniformly; the template carries the shape |

## 7. What this does NOT do, and what is open

* **Open — the registry decision** (§2) waits on the zone-manager lane.
* **Out of scope — tailnet viewing** (D7).
* **Open — remote build for base-driver lanes.** Base's driver builds locally today;
  "build on the target" for those lanes needs the target transport first.
* **It does not make a shared host safe.** It refuses to touch what you have not
  claimed; it cannot stop another account from doing so.
