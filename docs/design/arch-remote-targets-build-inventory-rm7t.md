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

✅ **RESOLVED with the zone-manager lane, 2026-10-02:** its machine list is the
**single source of truth for HOSTS**, and webctl reads it **through the command, never
the file**: `xq machine ls --json`. The lane built that interface in answer to this
proposal.

```
{"schema": 1, "path": "...", "present": true|false,
 "machines": [{"alias", "ssh", "shadows_local_zone", "reachable"?}]}
```

* **`schema` IS the contract.** An unknown value is **UNKNOWN and refused** — the lane
  adopted base's fail-closed rule as its documented one. The file itself carries no
  version and is promised nothing: one versioned surface, not two that can disagree.
* **Only what the zone manager RESOLVES is exposed** (alias → ssh). A machine's
  description is not part of the contract; descriptions belong in webctl's target
  records, where webctl owns them.
* ⛔ **`reachable` appears ONLY when the command is run with `--check`. An ABSENT key
  means "not checked", never "unreachable"** — reading one as the other is the
  absence-is-not-a-zero error this family keeps meeting.
* `present: false` with an empty list means **no file**, which is a valid state, not an
  error.

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
* **Images are per host — but the REASON differs by lane, and I first stated it
  wrongly for all of them.**
  * **Base's own driver** passes `UID`/`GID` as build arguments, so its images *are*
    uid-baked: a moved image ran as the wrong uid and chromium exited 133 (measured).
  * ⚠ **Zone-manager lanes are NOT uid-baked any more.** Since that lane's `088bcbe`,
    every container runs as the **invoking** uid, so one image serves every user
    (verified against another user's image, 16/16). Its images are still per host only
    because **each docker daemon holds its own** — and they **drift with build time**:
    measured the same day, one host's Chromium read 152, another's 154.
  * ⇒ Either way, build **on the target**; and treat "same image name" as saying
    nothing about "same browser version" across hosts.
* On zone-manager lanes the fresh-packages refresh is **`xq build app <app> [<distro>]
  --pull --no-cache`**. ⚠ `--pull` alone refreshes only the **base image**: the package
  layer is cached on the *text* of its `RUN` line, so an unchanged line reuses the old
  layer and exits 0 — verified by the zone-manager lane on the property (with
  `--no-cache` only the base stayed cached and the package layer re-ran), not on the
  flag.
* ⚠ **Two different version readings, and a refresh needs the right one.** The
  *image that would run next* (`docker run --rm --entrypoint chromium <image> --version`)
  is what a **refresh** must verify. The *container that is running now* is what the
  **inventory** must report — and after a rebuild the two differ until a restart.
  Neither is an image label, which is a build-time claim.
  ✅ **Now a contract, built by the zone-manager lane:** `xq app version <zone>/<app>
  --json` (schema 1) reports **both** readings, each labelled — `next` (resolved exactly
  as `xq up` would) and `running` (read by `exec` into the live container) — plus
  `stale`, and exits 3 when stale. Base reads it with `parseAppVersion`.
* ⭐ **STALENESS IS AN IDENTITY QUESTION, NOT A VERSION ONE** *(zone-manager lane)*. It
  compares **image IDs**: two builds can print the same version string and still differ,
  so *"would a restart change what runs"* cannot be answered by comparing versions. ⇒ A
  refresh is therefore verified on **two** axes: the `next` version against the declared
  candidate (`versionVerdict`), **and** `stale` against the running container (identity).
  Version equality alone would call a refreshed-but-not-restarted browser current.
* Every version carries a `source`: `binary` (the binary was run and answered) is a
  measurement; `label` is the image's own build-time **claim**, a fallback, and base
  reports it as **not measured**.
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
* ⛔ **A target in LOGIN MODE is never read** *(found by `gemini` during rollout)*. The
  `running` reading is taken by `exec` into the container, and login mode's window belongs
  to the human signing in (`lg1n` §1). ⇒ It gets an UNKNOWN row **saying why**. The
  instrument's own side effect is the reason: an inventory is read-only toward the
  *config*, but `exec` is not read-only toward the *browser's moment*.
* **Versions are normalised in ONE place.** The binary prints a raw line (*"Chromium
  152.0.7977.82 built on Debian GNU/Linux 12 (bookworm)"*); compared as-is against the
  declared version it reads *differs* — a false outdated — and lanes had begun
  normalising it themselves, differently. `normalizeVersion` extracts the dotted version
  (cut at *"built on"*, then exactly one dotted token, else UNKNOWN) and keeps the raw line
  beside it.
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
| the host list | the zone manager, via `xq machine ls --json` (§2, resolved) |
| the `targets` / `gui build|refresh` verbs | the lane, uniformly; the template carries the shape |

## 7. What this does NOT do, and what is open

* ✅ **Resolved — the registry decision** (§2): `xq machine ls --json`, schema 1.
* **Open — `xq app version --json`** as the version contract, requested.
* **Open, Greg's — the host list's own file is world-readable** (mode 644, while the ssh
  config it partly republishes is 600). The zone-manager lane is putting that to Greg
  rather than changing a working machine unilaterally.
* **Out of scope — tailnet viewing** (D7).
* **Open — remote build for base-driver lanes.** Base's driver builds locally today;
  "build on the target" for those lanes needs the target transport first.
* **It does not make a shared host safe.** It refuses to touch what you have not
  claimed; it cannot stop another account from doing so.
