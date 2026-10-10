---
id: ib4k
title: "Isolation backends — one contract, unshare → bwrap → docker → refuse"
category: test
created: "2026-10-07"
updated: "2026-10-10"
status: draft
tags: [isolation, sandbox, unshare, bubblewrap, docker, apparmor, mutation-arms, gate, portability]
tech:
  - name: "util-linux unshare"
    version: ">=2.38"
  - name: "bubblewrap"
    version: "any"
  - name: "Docker Engine"
    version: "any"
relates_to: [xrl4, k3wn, dip7]
depends_on: [xrl4]
expands: [xrl4]
similar_to: []
---

# Isolation backends — one contract, unshare → bwrap → docker → refuse

## 0. Why

`isolated` (harness, `xrl4`) runs a consumer's mutation arms so a mutant cannot reach a
signed-in browser, a host socket, a secret, or another process. It is built on unprivileged
user namespaces (`unshare`). **Some hosts forbid those.** Measured on a lane's Ubuntu 24.04
host (`kernel.apparmor_restrict_unprivileged_userns=1`): `unshare -r` and `bwrap` both fail
with EPERM; `isolated` refuses (fail closed, correctly), so that lane cannot test at all.

**Ruling (the human, relayed by the coordinator, 2026-10-07):** an ADAPTIVE, PORTABLE fix,
not a host change. Backends in order **unshare → bwrap → docker → else REFUSE; never run
unisolated.** A narrow AppArmor profile for one dedicated binary (`WEBCTL_UNSHARE_BIN`)
stays only as a fallback a host may choose.

## 1. ⛔ One contract, whatever the backend

A backend is acceptable only if it meets the SAME contract, proven by the SAME arm set,
each with its positive control (`k3wn`). A backend that passes fewer arms is not a backend.

| # | Property | Arm (inside) | Control |
|---|---|---|---|
| 1 | no host network | 127.0.0.1:<live port> → exactly ECONNREFUSED; no non-lo interface | a self-made listener inside answers |
| 2 | no host unix sockets | docker.sock, an X display socket, the session bus → ENOENT | a socket made inside connects |
| 3 | no host processes | a host pid → ESRCH | the same pid alive outside |
| 4 | the home HIDDEN | ~/.ssh/config, ~/.config/webctl/config.toml → ENOENT | readable outside; a `--keep-ro` path readable, not writable |
| 5 | no privilege | CapEff 0, NoNewPrivs 1; umount / remount refused | — |
| 6 | env allowlist | a planted unknown var absent | `--pass-env` passes it |
| 7 | writable only where declared | cwd and `--keep` writable | everything else EROFS/absent |
| 8 | no host-shared scratch | a file planted in the host's `/dev/shm` and `/var/tmp` → absent; a write there is not visible outside | a file made inside is readable inside |
| 9 | no host keyring | `keyctl show @s` names no host keyring; a key added inside is gone outside | a key added inside is readable inside |
| 10 | no host identity | hostname ≠ the host's; `/sys/class/net` lists only `lo`; `/etc/machine-id` absent or neutral | the same reads outside show the host's values |
| 11 | no loader injection into the privileged half | `NODE_OPTIONS` / `LD_*` preloads never run before the masks | the command itself sees its allowed env |

Rows 8–10 come from the v0.33.0 review of the namespace backend. They were MEASURED open there (deferred because they are not regressions and change keep-refusal rules), so v0.34.0 closes them in the shared arm set, for every backend at once. Row 11 is fixed in v0.33.0 and must stay fixed for every backend.

**The table is code:** `test/isolation-arm-table.test.js` runs rows 1–11 per IMPLEMENTED backend
(pinned with `WEBCTL_ISOLATION_BACKEND`), each on the fresh, nested and stripped-markers paths, each
with its control, in a throwaway world (a fake passwd home on a tmpfs, tmpfs "host" `/dev/shm` and
`/var/tmp`, a throwaway session keyring; host identity compared as digests). A guard fails when the
harness can run a backend the table does not judge. The unshare-specific depth (mutants, refusals,
races) stays in `test/contract-harness-isolation.test.js`; each row names it.

### 1a. Rulings for rows 7–10 (v0.34.0 phase 1, unshare)

Measured on the unshare backend before the change: a file planted in the host's `/dev/shm` and
`/var/tmp` was readable inside and a write there landed on the host; `keyctl show @s` inside listed
the host's session keyring (possessor `alswrv`) and a host key was found; the hostname, every host
interface name in `/sys/class/net` and `/etc/machine-id` were the host's. After: all closed, on all
three paths (the table's rows 8–10).

* **Row 7 — OPEN, needs a ruling.** `isolated` makes the home, base's root, the sensitive dot-dirs'
  real paths and the keeps read-only or hidden; it does **not** remount the rest of `/`. A
  **user-owned dir outside the home** (an `/opt/x` of one's own) is writable inside — measured, and
  recorded in the table as a `todo`. Closing it means a read-only root with the declared paths
  re-bound writable: a wider change, not taken in phase 1.
* **Row 8 — `/dev/shm` and `/var/tmp` get a fresh private tmpfs (mode 1777), as `/tmp` does.**
  ⇒ The keep rules are `/tmp`'s, NOT a new refusal: a `--keep` / `--keep-ro` BENEATH one is staged
  and re-bound with its mode (the write lands on the host); a keep that IS one, or an ancestor, is a
  usage error; a cwd AT one fails, a cwd beneath one runs; a throwaway `HOME` beneath one is kept. A
  dir that does not exist is skipped, and so is one whose real path lies in a dir already masked
  (`/dev/shm → /run/shm`, `/var/tmp → /tmp`). The nesting proof requires the masks; under a v0.33
  outer a nested v0.34 call is refused saying **upgrade the outer** (it cannot mask its caller's).
* **Row 9 — a fresh session keyring, made by pid 1.** pid 1's bash runs `keyctl new_session`
  (keyctl from the system dirs) after its traps and before its child: an anonymous session keyring
  everything below inherits, on the fresh and the nested path. Not `keyctl session -`: it prints
  `Joined session keyring: N` on the command's stderr. ⛔ **Read back**: the fresh path's inner half
  compares the session keyring id with the host's and refuses when it is unchanged or unreadable
  (a keyctl that ignores `new_session` is caught). **keyctl NOT installed (ruling, `webctl:base`):**
  the run goes ahead, the verdict says `keyring: shared (keyctl not installed)`, and row 9 is a
  named SKIP — untested, never a pass. ⚠ keyctl installed but the join refused (a policy) is a
  REFUSAL (fail closed), not a note — flagged for review. ⚠ The user keyring (`@u`) is per user
  namespace on the measured kernel (its id differs inside); on kernels before 5.3 it was per uid.
* **Row 10 — host identity.**
  * **hostname:** a UTS namespace (`unshare --uts`) named `webctl-isolated`. node has no
    `sethostname`, and `/proc/sys/kernel/hostname` belongs to the host's root (measured:
    `Permission denied` as namespace root), so the system **`hostname` tool** sets it. *Without the
    tool* the run goes ahead and the verdict says `hostname: the host's (no \`hostname\` tool)` — by
    analogy with the keyctl ruling; **flagged for review**. With the tool, the name is READ BACK.
  * **`/sys/class/net`:** a **fresh sysfs** mounted from inside the new network namespace lists only
    `lo` (and `/sys/devices/virtual/net` likewise). It covers every host submount of `/sys`, so the
    cgroup tree is staged first and moved back (node reads its memory limit there; measured:
    `process.constrainedMemory()` still answers). If the kernel refuses the sysfs mount, an empty
    read-only tmpfs goes over `/sys/class/net` and a note says **MASKED** (no interface at all).
  * **`/etc/machine-id`** (and `/var/lib/dbus/machine-id` when a separate file) and
    **`/etc/hostname`:** a NEUTRAL copy bound over each, read-only. The id is a fixed constant
    (`NEUTRAL_MACHINE_ID`, the hex of `webctl-isolated\0`) — not absent and not all zeros, which
    systemd/dbus treat as "no machine id". *Measured:* `systemd-id128 machine-id` and
    `dbus-uuidgen --get` answer the neutral id inside and keep working.
  * All of it READ BACK before the command starts (hostname, `/sys/class/net`, both files); the
    nesting proof requires it too (skew: "upgrade the outer").
  * *Not covered:* `/etc/hosts` (may name the host), `/proc/sys/kernel/random/boot_id`, DMI strings
    under `/sys/class/dmi/id`, the kernel release in `uname`.

The coordinator's cross-backend escape script (an independent python driver used against
v0.31.0) is run against every backend as an extra, independent check.

## 2. Selection

1. **unshare** (today's implementation; the fast path where it works).
2. **bwrap** (bubblewrap), when installed and permitted — same kernel mechanism, different
   policy surface on some distributions.
3. **docker**, when the namespace backends are unavailable for a NAMED reason (EPERM from
   the userns write, the AppArmor sysctl read as 1, the binary absent).
4. Otherwise **refuse**, naming each backend and why it was skipped.

⛔ Never "unisolated". Probing a backend is side-effect free (a throwaway namespace or a
`docker version`); a probe failure is a reason, recorded, never a crash.

`WEBCTL_ISOLATION_BACKEND=unshare|bwrap|docker` pins one (a test, or a host that wants a
specific one); a pinned backend that is unavailable is a refusal, never a silent fallback.

*As built (v0.34.0 phase 1):* `selectBackend()` in the harness. The **unshare probe** is: a valid
`WEBCTL_UNSHARE_BIN` (when set), every privileged tool in the system dirs, then
`unshare -rnm --uts --pid --fork true` — its failure keeps v0.33's HOST-POLICY text (the sysctl and
both remedies) when the AppArmor sysctl reads 1. Only a PROBE failure moves on to the next backend;
once a backend is chosen, a failure inside it (a mask that fails, a read-back that disagrees) is a
FAIL, never a reason to try the next. Until phases 2–3 land, `bwrap` and `docker` answer
`not implemented yet (v0.34 phase 2/3)`: a pin to either is refused, and a host where unshare
cannot run is refused naming all three. An unknown pin is refused by rule (its value is not
printed). A **nested** call makes no sandbox of its own (it runs inside its outer call's): the pin
is validated there, and selects nothing.

## 3. The docker backend — as strong as the namespace one

* Flags: `--network none --read-only --cap-drop ALL --security-opt no-new-privileges
  --pids-limit <n> --user <host uid>:<host gid>` (files written in the cwd stay the user's),
  tmpfs on `/tmp` and `/run`, `--rm`.
* Mounts: the cwd and each `--keep` (rw), each `--keep-ro` (ro), and base's repo root (ro).
  ⛔ **NEVER** docker.sock, the real home, `/run/user/<uid>`, or any path not declared.
  HOME is a tmpfs in the container.
* The image is **base-owned, pinned by DIGEST**, built offline-capable (no pull at test
  time), carrying the node version a lane's `engines` names. A missing image is a refusal
  naming the build command. The env allowlist (§1 #6) is applied to `docker run -e`.
* ⚠ The docker daemon is root-equivalent on the host; the sandbox is only as strong as the
  flags above, which is why §1 is asserted per backend rather than assumed.

### 3a. Review conditions (`webctl:mgr`, 2026-10-07) — each with an arm

1. ⛔ **The LOCAL daemon only.** `docker` obeys `DOCKER_HOST` / `DOCKER_CONTEXT`; a remote
   context would run a lane's tests on ANOTHER machine with the cwd shipped there. Unset both,
   address the local unix socket explicitly, and refuse when the effective endpoint is not the
   local unix socket. *Arm:* `DOCKER_HOST=ssh://x` planted → refused before any `docker run`.
2. **Docker's default seccomp and AppArmor profiles stay ON.** Never `--privileged`, never
   `seccomp=unconfined`. *Arm:* `docker inspect` of the running container → no `Privileged`,
   no unconfined `SecurityOpt`.
3. **Nested under the docker backend.** Lanes call `isolated` inside their suite; inside the
   container there is no docker, and the default seccomp blocks user namespaces, so a nested
   call would refuse. ⇒ The docker backend gives the container a proof of where it is that a
   process inside cannot forge (e.g. a read-only bind of a base-owned marker file, verified in
   `/proc/self/mountinfo`, together with the lo-only network and an empty capability bounding
   set). A nested `isolated` that PROVES it is inside runs the command in place. *Arm:* a nested
   call under the docker backend passes the §1 arm set and never escapes; a forged marker
   (no such mount) is refused.
4. **Reaping, signals, no leftovers.** `--init` for pid 1 (orphans reaped, as v0.33.0 does
   for the namespace backend); SIGTERM forwarded to the container; `--rm` plus a parent-death
   cleanup. *Arm:* kill the outer harness mid-run → no container is left.
5. **A shared daemon (one host's daemon serves five accounts): recognisable, owned, bounded,
   never sweeping.** Container names are `webctl-iso-u<uid>-<lane>-<pid>` (the v0.31.0 `u<uid>`
   owner rule); `--rm` always, and a stop on signal; `--cpus` and `--memory` caps with
   defaults, overridable; the image built or pulled under a PREFIXED name
   (`webctl-iso/…@<digest>`). ⛔ **Never prune** — no `docker system/image/container prune`,
   ever; removal only by exact id or exact name. *Arm:* a run against a FAKE docker CLI records
   every invocation: the name matches the pattern, `--cpus`/`--memory` are present, and no
   `prune` verb (or name pattern) appears anywhere.
6. **Host-built `node_modules`.** Native addons (`*.node`) built on the host may not load in
   the image (libc). The docker backend REFUSES with a clear message when the cwd's
   `node_modules` holds any, rather than flaking. Most lanes have no native dependencies.

## 4. Verdict and gate

* The verdict line and JSONL record name the backend used and, for each skipped one, the
  reason (e.g. `unshare: EPERM (apparmor_restrict_unprivileged_userns=1)`).
  *As built:* the verdict ends `…; backend: unshare` (with `(skipped bwrap: …)` when a backend
  before it was skipped); a refusal's JSONL record carries `"backend"` (null when none) and
  `"skipped": [{backend, why}]`. A successful run still prints nothing on stdout.
* The release gate records the backend per consumer, and the summary shows the mix.
  *As built:* read from the GATE's own `isolated` verdict (the last before the contract's start
  line), so no consumer prints anything new: each scratch-mode envelope gains
  `"isolation": "<backend>"` (`none` when refused, `unknown` when no verdict named one), and the
  summary prints `----- isolation backends: unshare=N … -----`.
* AppArmor fallback: on EPERM with the sysctl at 1, the refusal (when no backend works)
  names the sysctl and both remedies: a host sysctl, or a profile for `WEBCTL_UNSHARE_BIN`.

## 5. Order

After v0.33.0 (hidden home, env allowlist, `--keep-ro`, `WEBCTL_UNSHARE_BIN`): v0.34.0
implements §1's shared arm set first (parameterised by backend), then bwrap, then docker.
A lane blocked by host policy (the Ubuntu host above) resumes on v0.34.0.

## 6. Status (2026-10-10)

* **Phase 1 — done (unreleased, v0.34.0):** the selection frame (§2, §4), the shared arm table
  (§1, run against unshare), rows 8–10 closed for unshare (§1a), the gate's per-consumer backend
  and mix.
* **Open:** row 7 for dirs outside the home (§1a, needs a ruling); the two "flagged for review"
  rulings in §1a (a refused keyring join fails closed; no `hostname` tool runs with a note).
* **Phase 2 — bwrap; phase 3 — docker (§3, §3a):** not started. Each lands by adding its probe,
  its run path, and its name to the table's IMPLEMENTED list — the guard test fails until it does.
