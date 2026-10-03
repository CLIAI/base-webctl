---
id: rx9q
title: "The runtime layer is xq — base speaks the protocol, xq runs the app"
category: arch
created: "2026-10-03"
updated: "2026-10-03"
status: review
tags: [xq, runtime, dependency, boundary, containers, remote, firefox, bidi, capabilities]
tech:
  - name: "xq"
    version: "capability-pinned (no semver yet)"
relates_to: [rb7s, rm7t, nl0c, lg1n, ow9k, btg4, v8p3, sb7q, k3wn]
depends_on: [nl0c]
expands: [rm7t]
similar_to: []
---

# The runtime layer is xq — base speaks the protocol, xq runs the app

## 0. The ask, and why it is urgent

Greg, 2026-10-03: no duplication between base and **xq** (the zone manager that runs GUI
apps in containers, locally and remotely, with versions, upgrades and config) — *"maybe
[xq] should be used under the hood of webctl-base as [a] dependency required to be
installed in [the] system"*. And the new lanes develop for **chromium, opera and firefox**,
each in docker.

It is urgent because base was about to duplicate xq: `rb7s` phases 2–3 (run base's own
driver on a remote host, own a tunnel) are what xq's remote zones and `forward` already do.
And three base files are literally **copies of an early xq** (`docker-ctl.js`,
`xpra-attach.js`, `mounts.js`, each headed *"Adapted from xq … commit 64e5f9d"*, 143 xq
commits ago) — xq's lane reports several since-fixed defects of exactly that age,
including a by-name teardown that removed other users' containers.

## 1. ✅ The boundary — proposed by xq's lane, adopted here

> **xq owns everything up to "a running GUI app in a container, with a reachable, DECLARED
> control port". Base owns everything above it.** xq never learns CDP; base never builds an
> image. Each side stays replaceable on its own side.

| xq owns | base owns |
|---|---|
| images, recipes, build/refresh (`build app --pull --no-cache`) | speaking the control protocol: **CDP** (chromium, opera) and **WebDriver BiDi** (firefox) |
| running as the invoking uid (one image serves every user) | target resolution (`nl0c`), the shared config |
| zones and apps, local and remote; multi-user naming and ownership labels | tabs, leases, human-concurrency, the `ow9k` identity |
| attach / view / html5; the machine registry | the login-mode verdict (`lg1n`) — measured from argv |
| version reading (`app version`) | judging versions and inventories (`rm7t`), contracts, the harness |
| publishing each app's control surfaces (image labels) | the runtime **seam** below, and refusing when xq cannot serve |

## 2. Evidence — measured, not recalled

From a read-only survey of xq and xq's own lane:

* **Uid**: xq runs every container `--user <uid>:<gid>` with a per-uid tmpfs, so one image
  serves all users. Base bakes `UID`/`GID` into the image — the defect class `rm7t` §3
  measured (chromium exiting 133 on a mismatch). xq is ahead here.
* **Control surfaces** are image labels (`xq.app.control.<name>.{kind,internal_port,
  adapter,default_external_port}`). ⛔ **Vocabulary:** in xq, `kind` is the TRANSPORT
  (`tcp`) and **`adapter` is the PROTOCOL** (`cdp`, `raw`). Chromium and opera declare adapter
  `cdp`; **firefox declares none**. A `bidi` adapter is a recipe change. Labels exist only
  on a **built image**: an unbuilt app's control is `null` = UNKNOWN, never `[]` = NONE, and
  controls can differ by distro.
* **Firefox removed CDP in version 141** (140 ESR is the last with it); its automation
  protocol is WebDriver BiDi (Mozilla's CDP-retirement notice; Selenium's removal notice;
  Mozilla bug 1882096). ⇒ Base's CDP client drives chromium and opera, **not** firefox.
* **Remote is PARTIAL by xq's own account**: never run end-to-end against a real host; no
  version-skew guard; the remote machine needs xq and uv on its non-interactive ssh PATH.
  ⚠ *Corrected by xq's lane against its code:* remote `up` forwards `--control` since
  e4d46ca (the survey read was stale), and "does not create the zone / takes no app args"
  is not remote-specific — LOCAL `up` behaves the same, by design: creating a zone fixes its
  template, mounts and netvm, so it is an explicit act.
* **`forward`** is a foreground `ssh -N -L` the caller must kill; a second call fails on the
  local bind. Not owned.
* **Profiles**: xq's profile always lives under its data dir (or the whole host home);
  a caller cannot choose the path. Base's lanes have signed-in profiles at chosen paths,
  and **profiles are never copied between machines**.
* **Machine-readable surface**: only `machine ls` and `app version` carry a `schema`;
  `zone ls --json` has none; `wait-ready`/`forward` are prose. `xq --version` is a fixed
  string that has not changed in 166 commits — **pinning it pins nothing** (xq's lane).

## 3. The recommendation

1. **xq is the runtime for every container mode.** Base stops growing its own container
   runtime: `rb7s` phases 2–3 are **superseded** by this document; the adapted-from-xq copies
   are **retired** as lanes migrate (and, until then, patched for whatever xq's lane reports
   they inherited from the fork point).
2. **"Required" is a FLEET policy, enforced by a capability check — not a hard import.**
   Base defines a runtime **seam** (§4) with xq as its implementation. A container-mode run
   with no usable xq is **refused with instructions**; `direct` and attach-only modes need
   no xq. Reasons: (a) base is the ONE public repo and xq is private — a hard dependency
   would point public users at something they cannot install; (b) xq checkouts drift
   (measured: one host ten days without fetching), so "installed" is never the same as
   "able"; only a run-time capability check is honest about it.
3. **Pin capabilities, never a version string.** xq's lane offers `xq capabilities --json`,
   derived from its parser and image labels. Base pins the capabilities it needs and
   degrades to UNKNOWN / REFUSED when one is missing — the same fail-closed rule as base's
   harness floor (an unknown verb on an older xq must exit non-zero).

## 4. The seam — what base calls, what xq must answer

```
capabilities()        -> {schema, verbs:[{verb, json_schema}],
                          apps:[{app, images:[{distro, scope, built, control: [...] | null}]}]}
ensureApp(target)     -> `xq zone create` (idempotent on identical config, REFUSED on a
                         different one — never implicit) then `xq up`, control enabled
controlEndpoint(...)  -> {name, kind: "tcp", adapter: "cdp"|"bidi", host: "127.0.0.1", port}
ownedForward(...)     -> a tunnel with a handle: started, reported, torn down by its owner
appVersion(...)       -> the existing schema-1 contract
```

⛔ **The seam keys on xq's `adapter`, using xq's own field names** — a field renamed to
base's vocabulary is a copy that drifts (xq's lane). Base picks its CDP or BiDi backend
from `adapter`.

Base adds the **control protocol layer** above `controlEndpoint`: one operation surface
(navigate, evaluate, screenshot, tabs) with a **CDP backend** (exists) and a **BiDi
backend** (new; zero dependencies, over the same WebSocket implementation) — its own
design doc, before any lane writes firefox code.

## 5. What xq is asked for (the gaps that gate migration)

| # | ask | gates |
|---|---|---|
| X1 | `capabilities --json`, derived (verbs + json schemas; apps + control surfaces) | everything |
| X2 | `wait-ready --json` → the control endpoint `{name, kind, host, port}` | the seam |
| X3 | an **owned** forward (handle, idempotent, teardown) | any remote control |
| X4 | remote `up` honouring `--control`, creating the zone; one real end-to-end proof; a skew guard (compare remote capabilities) | remote by default |
| X5 | a caller-chosen profile dir (`--profile-dir`) — ✅ accepted, with two refusals: the path must be owned by the invoking uid, and a profile another live container holds is refused (two chromiums on one profile corrupt it) | migrating signed-in lanes **without moving their profiles** |
| X6 | a firefox **`bidi`** control surface (Firefox serves BiDi on `--remote-debugging-port`) | firefox |
| X7 | a `schema` on `zone ls --json` | inventory |
| X8 | `--no-sandbox`: ⚠ **not a flag — Greg's security decision** (§7). Chromium's sandbox inside docker needs CAP_SYS_ADMIN or an unconfined seccomp profile, i.e. WIDER container privileges. xq's counter-proposal, adopted: xq declares the boundary in an image label ("the sandbox is the container"), `lg1n` reads that label, Greg rules; until then the flag stays | login mode on xq |
| X9 | ✅ ANSWERED by xq's lane (read AT the fork commit): see §5a | patching base meanwhile |
| X10 | the **GL-docker attach** for the human viewer (ssh → 0700 socket → relay → GL client, with desktop scaling) — copied in 4 lanes + one kit | attach is xq's side (§1); retires the lane copies |
| X11 | `app inspect --argv --listeners --json` — the in-container READING | login mode on xq: xq reads, base's `lg1n` judges |
| X12 | a version **candidate** field in `app version` (the distro's package candidate) | "outdated" verdicts; closes opera's missing candidate |
| X13 | `app restart --control none\|cdp`, keeping the profile | the login-mode cycle (with X8) |
| X14 | **raw X primitives** as verbs: input injection, pixel/region capture, viewer-presence count | the X half of hover-proof click, displayed-tab-by-pixels and human presence — base composes them with CDP and owns the X-input LEASE identity (`ow9k`) |
| X15 | `rm --purge` stops first and reports the removed path | lifecycle hygiene |

*X10–X15 were reconciled by `webctl:mgr` from every lane's shared-core list, against this
table, so xq is asked once.* The rule each was placed by is §1's: what touches the running
app, its container or its display is xq's; what interprets the browser — a protocol, a
verdict, an identity — is base's.

## 5a. What base's copies inherited from xq's fork point — fix NOW, migration or not

Judged by xq's lane by reading xq **as it stood at 64e5f9d**, not from memory:

* ⛔ **Teardown by computed name, no owner check — INHERITED, and present in base's driver
  today.** Container names are `<prefix>chromium-<slug>` / `<prefix>xpra-<slug>`; labels
  carry role and slug only; the driver force-removes and stops by that name. Exact `^name$`
  matching does **not** help: the name carries no OWNER, so two accounts with the same tool
  and slug (the default slug is `default`) produce the identical name, and an exact match
  removes the OTHER account's running browser. xq's cure was discovery **by owner label**,
  so a verb acts only on what it found. ⇒ Base fix: an owner label on every container, and
  no rm/stop of a container not proven ours (an unrecognised one is HELD — `ow9k`).
* **The baked uid — INHERITED (T1's form).** The cure is running as the invoking uid
  (`--user uid:gid` + a tmpfs at `/run/user/<uid>`) for BOTH the session and the app
  container, with a writable tmpfs HOME for the session.
* **`XDG_RUNTIME_DIR` hard-coded to `/run/user/1000` in images — INHERITED by anything
  adapted from the fork.** Outside uid 1000, sockets, pulse and dbus fall back silently.
  Pass `XDG_RUNTIME_DIR=/run/user/<uid>` at RUN time; never trust the image ENV.
* **xpra's 5-second audio-start deadline — INHERITED only by a native attach with speaker
  on** (`XPRA_SOUND_START_TIMEOUT=20000`).
* Not inherited (the code did not exist at the fork): the mux-owned forward, port-range
  parsing, remote flags — but they become base's the moment base writes that code, which is
  the strongest argument for §3.1.

## 6. Migration order

1. X1, X2, X3 in xq; base's seam + capability check; the BiDi design.
2. **The new lanes (aliexpress, amazonde) run on xq first** — they have no signed-in
   profiles to move. Locally, then remote once X4 lands. Their shared-config record moves
   from `kind = "docker-xpra"` (base's driver) to `kind = "managed-zone"`.
3. Lanes already on xq zones (grok, gemini, perplexity) adopt the seam.
4. **Signed-in lanes last**, and only with X5 — never by copying a profile.

## 7. Decisions that are Greg's

* **xq as a required system dependency for container modes, fleet-wide** — recommended,
  via the capability check above.
* **Public base depending on a private xq** — either xq becomes public, or base keeps xq
  behind the seam (recommended) so public base stays usable without it.
* **Login mode without Chromium's own sandbox** (X8): accept "the container is the sandbox"
  for a human sign-in, or grant the container the privileges Chromium's sandbox needs.

## 8. What this does NOT do

* It does not move any signed-in browser. It does not change any lane today.
* It does not make xq learn a browser protocol, or base build an image.
