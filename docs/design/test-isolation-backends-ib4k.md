---
id: ib4k
title: "Isolation backends — one contract, unshare → bwrap → docker → refuse"
category: test
created: "2026-10-07"
updated: "2026-10-13"
status: draft
tags: [isolation, sandbox, unshare, bubblewrap, docker, apparmor, mutation-arms, gate, portability]
tech:
  - name: "util-linux unshare"
    version: ">=2.38"
  - name: "bubblewrap"
    version: ">=0.11 (measured: 0.11.2 only)"
  - name: "Docker Engine"
    version: "any (measured: 29.1.3)"
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
| 3 | no host processes | a host pid → ESRCH; the caller's own `cgroup.kill` and `cgroup.procs` do not open for write (EROFS/EACCES/ENOENT) — by the host path and by the path `/proc/self/cgroup` gives inside (EROFS/EACCES); the command's `kill -TERM 0` leaves a sentinel in its caller's process group, and the caller, alive | the same pid alive outside; the same files open for write outside (never written); `kill -TERM 0` with no `isolated` kills the sentinel |
| 4 | the home HIDDEN | ~/.ssh/config, ~/.config/webctl/config.toml → ENOENT | readable outside; a `--keep-ro` path readable, not writable |
| 5 | no privilege | CapEff 0, NoNewPrivs 1; umount / remount refused | — |
| 6 | env allowlist | a planted unknown var absent | `--pass-env` passes it |
| 7 | writable only where declared | a user-owned dir outside the home, base's root, the home → EROFS/absent; a mount the host makes AFTER the start never appears inside (every mount private, read back) | the cwd, `--keep` (inside and outside /tmp) writable; procfs writes and a nested `unshare -rn` still work; a raw slave mount namespace sees the late mount |
| 8 | no host-shared scratch | a file planted in the host's `/dev/shm` and `/var/tmp` → absent; a write there is not visible outside; the host's SysV IPC (a segment from `ipcmk -M`) not listed by `ipcs -m`, a `shmat` write never reaching it; the host's POSIX mqueues absent from `/dev/mqueue` | a file, a segment and a queue made inside are seen inside; a write made outside is read back |
| 9 | no host keyring | `keyctl show @s` names no host keyring; a key added inside is gone outside; (9b) a host key's possessor-only PAYLOAD → EACCES by id. *Residual: descriptions and ids stay enumerable (§1a)* | a key added inside is readable inside; the payload is readable outside |
| 10 | no host identity | hostname ≠ the host's; `/sys/class/net` and `/sys/devices/virtual/net` list only `lo`; `/etc/machine-id` absent or neutral, and not rewritable through its backing copy | the same reads outside show the host's values; the rewrite works on such a bind made outside |
| 11 | no loader injection into the privileged half | `NODE_OPTIONS` / `LD_*` preloads never run before the masks | the command itself sees its allowed env |
| 12 | no host devices | `/dev` holds only `null zero full random urandom tty pts ptmx shm mqueue fd stdin stdout stderr`; `/dev/pts` is not the host's devpts and lists none of its terminals; the host's `/dev/uinput` and `/dev/snd` absent (each one the host lacks is a named SKIP); (12b) under the caller's pty: `/dev/tty` → ENXIO, TIOCSTI on fd 0 → EPERM where `dev.tty.legacy_tiocsti` is 1 or absent (at 0 the kernel answers EIO before the terminal check: NOT TESTED, named), no capless ancestor holds the terminal | inside behaves EXACTLY as outside: `/dev/fd/N`, `/dev/stdin|stdout|stderr` resolve; `null zero full random urandom` read; `/dev/full` write → ENOSPC; `/dev/tty` with no controlling tty answers as outside (ENXIO); (12b) under a pty the caller owns, `/dev/tty` opens outside; plus a pty opens (`/dev/ptmx`, `script -qc true /dev/null` — master AND slave), `/dev/shm` writable, a nested `unshare -Ur --pid --fork --mount-proc` works; the host `/dev` holds more |

Row 12 and row 3's cgroup arm come from the re-review of v0.34 phase 1 (2026-10-10): the host `/dev`
had been passed through whole, and the caller's cgroups were writable, in EVERY released `isolated` up
to v0.33.1 (§1a). Rows 8–10 come from the v0.33.0 review of the namespace backend. They were MEASURED open there (deferred because they are not regressions and change keep-refusal rules), so v0.34.0 closes them in the shared arm set, for every backend at once. Row 11 is fixed in v0.33.0 and must stay fixed for every backend.

**The table is code:** `test/isolation-arm-table.test.js` runs rows 1–12 per IMPLEMENTED backend
(pinned with `WEBCTL_ISOLATION_BACKEND`), each on the fresh, nested and stripped-markers paths, each
with its control, in a throwaway world (a fake passwd home on a tmpfs, tmpfs "host" `/dev/shm` and
`/var/tmp`, a throwaway session keyring; host identity compared as digests). A guard fails when the
harness can run a backend the table does not judge. The unshare-specific depth (mutants, refusals,
races) stays in `test/contract-harness-isolation.test.js`; each row names it.

### 1a. Rulings for rows 7–10 and 12 (v0.34.0 phase 1, unshare; amended by the phase-1 review and the re-review, 2026-10-10)

Measured on the unshare backend before the change: a file planted in the host's `/dev/shm` and
`/var/tmp` was readable inside and a write there landed on the host; `keyctl show @s` inside listed
the host's session keyring (possessor `alswrv`) and a host key was found; the hostname, every host
interface name in `/sys/class/net` and `/etc/machine-id` were the host's. After: all closed, on all
three paths (the table's rows 8–10).

* **Row 7 — CLOSED (ruling R1): the whole tree read-only.** Measured open in phase 1: a **user-owned
  dir outside the home** (an `/opt/x` of one's own) was writable inside. Now, after the keeps are
  staged and BEFORE the scratch masks, the hides and the keeps moving back, every mount reachable
  from `/` — the root mount included — gets a per-mount `remount,bind,ro` (a mount ON `/` would not
  move the process's root), except `/proc` (procfs writes — `oom_score_adj`, a nested userns's
  `uid_map` — must keep working; measured: with `/proc` read-only the privilege drop itself fails),
  `/dev` (replaced whole, row 12) and our own `/run`. ⛔ **`/sys` is NOT exempt** (re-review, item 7):
  the exemption was not load-bearing (measured: every arm passes with it gone); the host's `/sys`, its
  cgroup tree included, goes read-only underneath the fresh sysfs (row 10). The fresh sysfs ON TOP
  stays read-write, and the read-back exempts exactly that one mount — not its submounts: ⚠ *measured:*
  a fresh sysfs mounted `ro` makes every nested sysfs mount — `ro` or not — fail "Mount too revealing",
  the stripped-markers path's own included (kernel 7.1). Sysfs writes from the user namespace are
  governed by sysfs's own permissions — and NOT every file belongs to the host's root (corrected by
  the third review, F4): an attribute udev granted the user's uid (`uaccess` — e.g. a backlight's
  `brightness`) stays writable inside the fresh sysfs. Residual: §6. Every WRITABLE item (cwd, `--keep`, a throwaway HOME, an outer's rw
  re-bind) gets its own bind on top; one that CONTAINS a masked dir (a cwd of `/`) is refused. READ
  BACK: `readOnlyGaps` over `/` minus the declared writable set → refuse on any gap. A mount point no
  lookup can reach (EACCES — measured: docker's overlay rootfs under a root-owned 0710 dir) is
  skipped: the capless command, the same uid, cannot reach it either. A stripped-markers call
  carries an R1 outer's writable mounts wherever they are. ⚠ Lanes lose writes outside the declared
  set (CHANGELOG v0.34.0 lists them). ⛔ It locks nothing over a `/proc` or `/sys` FILE (the kernel
  then refuses any new procfs/sysfs in a child userns): an arm runs the nested path's
  `unshare -U -m --pid --fork --mount-proc`, the stripped path's `unshare -rnm --uts --ipc --pid --fork
  --mount-proc` and a nested sysfs mount inside, each rc 0, on all three paths.
* **Row 8 — `/dev/shm` and `/var/tmp` get a fresh private tmpfs (mode 1777), as `/tmp` does.**
  ⇒ The keep rules are `/tmp`'s, NOT a new refusal: a `--keep` / `--keep-ro` BENEATH one is staged
  and re-bound with its mode (the write lands on the host); a keep that IS one, or an ancestor, is a
  usage error; a cwd AT one fails, a cwd beneath one runs; a throwaway `HOME` beneath one is kept. A
  dir that does not exist is skipped, and so is one whose real path lies in a dir already masked
  (`/dev/shm → /run/shm`, `/var/tmp → /tmp`). The nesting proof requires the masks; under a v0.33
  outer a nested v0.34 call is refused saying **upgrade the outer** (it cannot mask its caller's).
  * **SysV IPC and POSIX mqueues (review F1).** Measured open: `unshare` without `--ipc` shares the
    caller's IPC namespace — a host `ipcmk -M` segment was listed by `ipcs -m` inside, a `shmat`
    write inside landed in it — and the host's mqueue mount shows the host namespace's queues
    whoever reads it. ⇒ `unshare --ipc` on the fresh path (and its probe); the inner half PROVES the
    IPC namespace differs from the caller's and mounts a fresh mqueue on `/dev/mqueue` (read back).
    A nested call inherits its outer's IPC namespace.
* **Row 9 — a fresh session keyring, made by pid 1.** pid 1's bash runs `keyctl new_session`
  (keyctl from the system dirs) after its traps and before its child: an anonymous session keyring
  everything below inherits, on the fresh and the nested path. Not `keyctl session -`: it prints
  `Joined session keyring: N` on the command's stderr. ⛔ **Read back**: the fresh path's inner half
  compares the session keyring id with the host's and refuses when it is unchanged or unreadable
  (a keyctl that ignores `new_session` is caught). **keyctl NOT installed (ruling, `webctl:base`):**
  the run goes ahead, the verdict says `keyring: shared (keyctl not installed)`, and row 9 is a
  named SKIP — untested, never a pass. ⛔ **keyctl installed but the join refused → REFUSAL** (ruling
  R3), on EVERY path: pid 1 writes `fail …` on the status channel and exits before starting anything
  (it was `|| :` — silent on the nested path, review F5). **keyctl installed but the host's
  `keyctl show @s` fails** (review F5): the join runs, but cannot be read back — the verdict says
  `keyring: unverified (keyctl show failed)` and row 9 is a named SKIP. ⚠ The user keyring (`@u`) is
  per user namespace on the measured kernel (its id differs inside); on kernels before 5.3 it was per
  uid. ⚠ **RESIDUAL — key DESCRIPTIONS and ids (review F2; ruling (c), no mask):** the
  description (type, uid, perms, name) and id of every key owned by the user's uid stay enumerable
  inside — via `/proc/keys` and `keyctl rdescribe` — because the user VIEW bit applies without
  possession, and the kernel lists every key whose owner uid is mapped in the reader's user namespace
  (the real uid always is). What IS guaranteed (arm 9b): a PAYLOAD needs possession or the user READ
  bit — a host key with possessor-only read (`0x3f010000`) answers EACCES inside, since the fresh
  session keyring takes possession away. ⛔ Not masked, deliberately: a masked `/proc/keys` was
  measured to break every nested `--mount-proc` (EPERM — `mnt_already_visible` wants a fully visible
  procfs), this verb's own nested and stripped paths included, and a fresh nested procfs lists the
  keys again anyway (measured: 11 lines).
* **Row 10 — host identity.**
  * **hostname:** a UTS namespace (`unshare --uts`) named `webctl-isolated`. node has no
    `sethostname`, and `/proc/sys/kernel/hostname` belongs to the host's root (measured:
    `Permission denied` as namespace root), so the system **`hostname` tool** sets it, and the name
    is READ BACK. ⛔ **The tool is REQUIRED (ruling R2):** without it in the system dirs, a REFUSAL
    naming the providing packages (`inetutils` or `hostname`) — never a run under the host's name,
    never a raw syscall number.
  * **`/sys/class/net`:** a **fresh sysfs** mounted from inside the new network namespace lists only
    `lo` (and `/sys/devices/virtual/net` likewise). It covers every host submount of `/sys`, the
    cgroup tree included: a FRESH cgroup2 is mounted on `/sys/fs/cgroup` (row 3). ⚠ *Corrected by the
    third review (F3):* until then the host's tree was staged and moved back, and this line said
    node's `process.constrainedMemory()` "still answers" — it answered **0** inside (the host's tree,
    mount root `/../../..`, where `/proc/self/cgroup` said `0::/`: no `memory.max` there) against
    2^64 outside. ⛔ **If the kernel refuses the sysfs mount: a
    REFUSAL** (review F3). Phase 1 put an empty tmpfs over `/sys/class/net` and ran, but
    `/sys/devices/virtual/net` still named the host's interfaces; the read-back now checks both dirs.
  * **`/etc/machine-id`** (and `/var/lib/dbus/machine-id` when a separate file) and
    **`/etc/hostname`:** a NEUTRAL copy bound over each, read-only. The id is a fixed constant
    (`NEUTRAL_MACHINE_ID`, the hex of `webctl-isolated\0`) — not absent and not all zeros, which
    systemd/dbus treat as "no machine id". *Measured:* `systemd-id128 machine-id` and
    `dbus-uuidgen --get` answer the neutral id inside and keep working. ⛔ The copies live on a tmpfs
    of their own, remounted read-only and read back (review F6: in the writable `/run`, a copy could
    be `chmod`ed and rewritten, changing what `/etc/machine-id` read). Not unlinked instead: the
    kernel refuses a mount on top of a bind of an unlinked file, so a stripped-markers call could not
    bind its own (measured).
  * All of it READ BACK before the command starts (hostname, `/sys/class/net`, both files); the
    nesting proof requires it too (skew: "upgrade the outer").
  * *Not covered:* `/etc/hosts` (may name the host), `/proc/sys/kernel/random/boot_id`, DMI strings
    under `/sys/class/dmi/id`, **disk serials** (`/sys/class/block/*/device/serial` — block devices
    are not per network namespace, so the fresh sysfs lists them), the kernel release in `uname`.
* **Row 3 — the caller's cgroups (re-review, item 2).** Measured open in every released `isolated` up
  to v0.33.1: no cgroup namespace, and the cgroup2 tree read-write inside (v0.34 phase 1 moved it back
  read-write under the fresh sysfs) — the command could open its caller's scope's `cgroup.kill` or
  `cgroup.procs` for write, i.e. kill or move the processes that called it, the release gate among
  them. Now `unshare --cgroup` on the fresh path (and in its probe), and — as namespace root, after
  the fresh sysfs — a **FRESH cgroup2 mounted on `/sys/fs/cgroup` inside the new cgroup namespace**,
  then made read-only (a BIND remount: a superblock remount would be the hierarchy's) (third review,
  F3). It is rooted at the namespace — the caller's scope, `/` in `/proc/self/cgroup` — so the host's
  tree is not moved back: before, the view was the host's, mount root `/../../..`, every host scope
  name listed, and node's `process.constrainedMemory()` 0 inside (2^64 outside). ⛔ READ BACK
  (`cgroupGaps`): the cgroup namespace differs from the caller's, no reachable cgroup mount is
  writable, and `/sys/fs/cgroup` is a cgroup2 whose mount root is `/` — else REFUSED; the nesting proof
  requires the same (an older outer: "upgrade the outer"). node READS its memory limit there:
  `constrainedMemory()` and the own cgroup's `memory.max` read the same inside as outside (row 10's
  control). A nested cgroup2 mount inside (a cgroup namespace of the command's own) still works — row
  7's arm; that route is what the `nsdelegate` check below guards. The arms only OPEN the files for
  write (and close them), in the throwaway world — they never write the real scope.
  ⛔ **`nsdelegate` (third review, F2).** Inside, the command can still make a cgroup namespace of its
  own (`unshare -rm --cgroup`) and mount cgroup2 there: a WRITABLE view rooted at its own cgroup — the
  caller's scope. Only cgroup2's `nsdelegate` option stops a `cgroup.kill` write at that namespace root
  (and a `cgroup.procs` write that would move a process across it). It is one flag of the whole
  hierarchy, set only from the initial cgroup namespace, shown in the SUPER options of every cgroup2
  line of `/proc/self/mountinfo`. ⇒ `isolated` REFUSES when the host's cgroup2 lacks it — and on a host with
  NO cgroup2 mount (cgroup v1 only), named as such: "no cgroup2 mount visible; isolated needs cgroup2
  with nsdelegate" (ruling: fail closed; "probably safe" is not a check) — naming the option and the remedy (mount cgroup2 with
  `nsdelegate`; systemd does so by default). The verdict states the check (`; cgroup2: nsdelegate`);
  the read-back (`cgroupGaps`) and the nesting proof require it too. ⇒ Row 3's cgroup half is closed
  **where cgroup2 is mounted with `nsdelegate` (systemd's default); `isolated` refuses otherwise.** The
  arm drives the refusal with a FAKE mount table, through a seam only an importer reaches
  (`runIsolated(a, {readHostMounts})`, never an env var or a flag) — the real tree is never written or
  `mkdir`ed in, not even as a probe. Residual: §6.
* **Row 12 — CLOSED: a minimal FRESH `/dev`, like `bwrap --dev`** (re-review, item 1). Measured
  open in every released `isolated` up to v0.33.1 and in phase 1: the host `/dev` was passed through
  WHOLE — `/dev/uinput` opened for write inside (virtual-keyboard injection into the host desktop),
  and the host devpts (the user's other terminals), `/dev/video*`, `/dev/snd/*`, `/dev/kvm`, `/dev/fb0`
  and `/dev/vcs*` were writable. Now, as namespace root and before the drop, after the keeps are
  staged and before the scratch masks: a tmpfs (mode 0755) built in our `/run` with `null`, `zero`,
  `full`, `random`, `urandom` and `tty` BOUND from the caller's `/dev` (a user namespace cannot
  `mknod`), a fresh `devpts` (`newinstance,ptmxmode=0666`) on `pts` with `ptmx -> pts/ptmx`, `fd`,
  `stdin`, `stdout`, `stderr` -> `/proc/self/fd/*`, and empty `shm` and `mqueue` — made read-only,
  then MOVED onto `/dev`; the private `/dev/shm` tmpfs and the fresh mqueue (row 8) land on it.
  ⛔ READ BACK (`devGaps`), after the mqueue: `/dev` lists nothing beyond that set, is our read-only
  tmpfs, `/pts` is our devpts, every mount under `/dev` is one of those (or beneath `/dev/shm`), and
  each node is the character device it is named for — else REFUSED. The nesting proof requires it
  too (skew: "upgrade the outer"); the nested path inherits its outer's `/dev`, the stripped-markers
  path builds its own from it. A `--keep` / `--keep-ro` / cwd AT or beneath `/dev` is REFUSED (usage
  3 for an explicit keep), except beneath a scratch dir there (`/dev/shm/<dir>`, row 8's rule).
  ⚠ *Measured:* mode 0755 is load-bearing — on tmpfs's default 1777 (sticky, world-writable) an
  `O_CREAT` open of a bound node (`> /dev/null`, node's `writeFileSync`) is EACCES (kernel 7.1).
  ⚠ *Not there, deliberately:* `/dev/fuse`, `/dev/net/tun`, `/dev/kvm`, `/dev/dri`, `/dev/console`,
  `/dev/log` — a lane that needs one is refused nothing; it fails visibly (ENOENT) inside.
  ⛔ **12b — no controlling terminal (third review, F1).** The command shared its caller's session:
  `/dev/tty` (the bound node) opened the caller's terminal, and TIOCSTI on it — or on fd 0 when that is
  the terminal — types into it (kernels < 6.2, or `dev.tty.legacy_tiocsti=1`; CVE-2017-5226, which
  `bwrap --new-session` answers). Now the privilege-drop chain is spawned in a NEW SESSION (`setsid`,
  node's `detached`): the `__isolated-pid1` helper and, on the nested path, its pid 1 — both capless,
  the command's uid in its user namespace, so traceable by it where yama's `ptrace_scope` is 0 — hold
  no CONTROLLING terminal either (fds 0/1/2 that are the terminal stay open: readable, writable,
  termios-settable — a residual, §6, as under `bwrap --new-session`). The fresh path's pid 1 and inner half
  hold none either: since the sixth review (B1) the creator itself is spawned detached on both backends
  (*measured:* tty_nr 0 throughout; they hold capabilities the command cannot trace as well). Signals: a terminal's Ctrl-C reaches the caller's group, `isolated` forwards it down
  the chain, and the helper — which spawns the command in a session and GROUP of its own — forwards
  INT/TERM/HUP to that whole group, as the terminal did (to the command alone, a shell loop ran on:
  its `sleep` never saw the INT). Exit codes are unchanged. Arms (row 12b, all three paths, under a
  pty the world makes with `script`): `/dev/tty` → ENXIO; TIOCSTI on fd 0 → EPERM or EIO — attempted
  only when fd 0 is verified (st_dev:st_rdev) to be that throwaway pty; no capless ancestor holds a
  terminal (`/proc/<pid>/stat` tty_nr); control: `/dev/tty` opens outside under the same pty. And a
  Ctrl-C to the group stops a shell loop, fresh and nested. ⚠ **What changes for a lane:** anything
  that opens `/dev/tty` inside fails ENXIO (ssh or gpg prompts, a TUI — as under `bwrap --new-session`); **Ctrl-Z** stops `isolated`
  but NOT the command, which runs on until `fg` (no TSTP/CONT is forwarded); a backgrounded command
  reading the terminal is not stopped by SIGTTIN; a TERM sent to the `isolated` pid reaches the
  command's whole group.

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
`unshare -rnm --uts --ipc --pid --fork true` — its failure keeps v0.33's text, WORD FOR WORD: the
HOST-POLICY text (the sysctl and both remedies) when the AppArmor sysctl reads 1, else `unshare exited
<n> before the isolated side reported in — …`. ⛔ **An unpinned refusal LEADS with that unshare
reason** (review F4, ruling — a lane matches `/NOT RUN: unshare exited 1/`), then appends `; no
isolation backend can be used here — bwrap: <why>, docker: <why>`; unshare's own stderr is printed
above it, as v0.33's was. A pin keeps the pin's text. ⛔ A backend that is SELECTED but has no runner
yet is refused (`internal: backend <x> has no runner yet`, review F7) — everything after selection
is unshare's runner until each phase adds its own. Only a PROBE failure moves on to the next backend;
once a backend is chosen, a failure inside it (a mask that fails, a read-back that disagrees) is a
FAIL, never a reason to try the next. Until v0.35.0, `bwrap` and `docker` answered
`not implemented yet (v0.35.0)`. Since v0.35.0, bwrap has its probe and runner (§2a), and since phase 3
docker has its own (§3b); a host where no backend can run is refused naming all three. An unknown pin is refused by rule (its value is not
printed). A **nested** call makes no sandbox of its own (it runs inside its outer call's): the pin
is validated there, and selects nothing.

### 2a. The bwrap backend (v0.35.0, phase 2)

**What bwrap is, here: the namespace CREATOR, nothing more.** It replaces the fresh path's
`unshare -rnm … --fork` — the namespaces and the reaping pid 1 — and nothing else. Everything inside
is the SAME code as under unshare, unchanged: pid 1's bash (`PID1_REAPER`, the keyring join), the
`__isolated-inner` half (the masks, the read-only root, the fresh `/dev`, sysfs and cgroup2, the
identity), every read-back (`readOnlyGaps`, `hiddenGaps`, `devGaps`, `identityGaps`, `cgroupGaps`),
the privilege drop (`privilegeDrop`, read back) and the `__isolated-pid1` helper. One implementation
meets the contract; the table (§1) judges it under each creator.

⛔ **bwrap's own mount flags are NOT used** (`--ro-bind / /`, `--dev`, `--tmpfs`, `--hostname`,
`--clearenv`/`--setenv`, `--cap-drop ALL`), because they would be a second, weaker implementation of
the masks:

* bwrap has no option for a FRESH sysfs or cgroup2 (rows 10 and 3), so the inner half must still
  run, with capabilities, after it. `--cap-drop ALL` would leave it unable to mount anything.
* `--dev` is not the contract's `/dev`: it adds `core -> /proc/kcore` (and `console` when stdin is a
  tty), has no `mqueue`, and stays writable. `devGaps` refuses it. The inner half builds the
  minimal one and reads it back, on both creators.
* `--clearenv`/`--setenv` would put the command's env on bwrap's argv, readable in
  `/proc/<pid>/cmdline` by every process of the uid, and on the privileged halves (row 11).
  bwrap is spawned with `privilegedEnv`, as unshare is; the command's env travels by pipe to the
  helper.
* A mask done twice means two writers to keep in step, and a read-back that passes only because one
  creator happened to do it is a defect.

**The argv** (`BWRAP_FLAGS`; bwrap is spawned `detached`, difference 5, and through `env`, difference 7), and
what each flag carries:

    env --ignore-signal=TERM,INT,HUP,QUIT
      bwrap --unshare-user --uid 0 --gid 0 --cap-add ALL
            --unshare-net --unshare-ipc --unshare-uts --unshare-cgroup --unshare-pid
            --as-pid-1 --die-with-parent --new-session
            --dev-bind / / --proc /proc
            -- env --default-signal=TERM,INT,HUP,QUIT
               <bash> --norc -p -c PID1_REAPER webctl-isolated-pid1 <keyctl> <node> <harness> __isolated-inner <netns> -- <cmd…>

| flag | unshare's equivalent | carries |
|---|---|---|
| `--unshare-user --uid 0 --gid 0 --cap-add ALL` | `-r` | the inner half is namespace root WITH capabilities (every mask; without them it refuses) |
| `--unshare-net` | `-n` | row 1 (the inner half refuses a shared netns) |
| `--unshare-ipc` | `--ipc` | row 8 (`maskIpc` refuses a shared IPC ns) |
| `--unshare-uts` | `--uts` | row 10 (the neutral hostname needs a UTS ns of its own) |
| `--unshare-cgroup` | `--cgroup` | row 3 (`cgroupGaps` refuses a shared cgroup ns) |
| `--unshare-pid --as-pid-1` | `--pid --fork` | row 3; pid 1 is OUR reaping bash, as under unshare. Without `--as-pid-1` bwrap's own reaper is pid 1 and the harness's forwarding past the creator reaches it, not bash |
| `--proc /proc` | `--mount-proc` | a procfs of the new PID namespace (row 3) |
| `--dev-bind / /` | `-m` | the caller's tree, as `unshare -m` gives it. ⚠ *Measured:* `--bind / /` makes it `nodev`, and `/dev/null` answers EACCES |
| `--die-with-parent` | `--kill-child` + `setpriv --pdeathsig KILL` | the namespace dies with bwrap — and with bwrap's PARENT, the harness. Since v0.35.0 unshare gets the same from `setpriv --pdeathsig KILL` (difference 8); before, a harness killed by a signal it does not forward left unshare running. ⛔ NOT enough in the early window: bwrap's child sets it only just before it execs (difference 6) |
| `--new-session` | (none) | the privileged halves hold no controlling terminal either. Under unshare they kept it (12b: "ancestors with a tty 2, capless 0") until the sixth review detached the unshare creator too (item 9): now 0 on both. A strengthening, not a row: the shared chain's setsid carries 12b on both. ⚠ Since bwrap is spawned `detached` (difference 5) this flag is a SECOND layer: either one alone keeps the terminal half of the bwrap-only arm green, both gone turn it red (measured). So that arm also reads the RUNNING bwrap's argv from /proc and requires `--new-session`, `--die-with-parent` and `--as-pid-1`; dropping the flag alone turns it red (fifth review, F9) |

⛔ **Not `--unshare-all`**: its user and cgroup parts are the `-try` variants, so a namespace bwrap
cannot make is silently skipped. Each namespace is named, and its absence is a failure.
**Not `--disable-userns`**: the command must keep making namespaces of its own (row 7's control,
Chromium's sandbox, the nested path's drop).

**Measured differences, and what closes each** (bwrap 0.11.2, kernel 7.1):

1. ⛔ **Mount propagation.** bwrap makes `/` an rslave, so a mount the host makes AFTER the start
   appears inside. *Measured:* a tmpfs mounted in a throwaway "host" 0.8 s after the start was
   listed twice in the sandbox's mountinfo, and writable there. It lands outside the read-only step,
   which ran before it existed. Under `unshare --propagation=private` it was listed 0 times. ⇒ The
   inner half makes every mount PRIVATE (`mount --make-rprivate /`, its first mount, a no-op under
   unshare). It then READS BACK `propagationGaps`: no mount reachable from `/` may carry a `shared:`
   or `master:` tag. Both creators run this, and so does the nesting proof. *Arm (row 7):* a mount the
   "host" makes after the start never appears inside. *Control:* a raw slave namespace started at the
   same time sees it.
   ⚠ The table's world has PRIVATE mounts, so on the main bwrap path the private step was a no-op
   (fifth review, F10). *Arm:* one bwrap run in a world whose mounts are SHARED (*control:* they are)
   must pass; without the private step it is refused.
2. **`nodev`** — `--dev-bind`, above.
3. **The session** — `--new-session`, above.
4. **NoNewPrivs** is already 1 in the inner half (bwrap always sets it). Harmless: `mount`,
   `hostname`, `keyctl`, `ip` and `setpriv` need no new privileges.
5. ⛔ **A terminal's signals.** `unshare --fork` BLOCKS SIGINT and SIGTERM and ignores nothing
   (*read back:* SigIgn 0, SigBlk 0x4002; item 8); bwrap does neither. A group Ctrl-C reached the bwrap process, which died by it, and `--die-with-parent` then
   SIGKILLed the namespace. *Measured:* the command's own INT trap never ran (unshare: `GOT-INT`,
   rc 7; bwrap: nothing). ⇒ bwrap is spawned in a session of its own (`detached`), so a terminal's
   signals reach only `isolated`, which forwards them past the creator exactly as past unshare.
   *Arm:* a group Ctrl-C reaches the command's INT trap, rc 7, under both creators.
6. ⛔ **The early window: the command ran after the caller had died by its TERM (fifth review, F1–F3).**
   A TERM before the inner side reports in SIGKILLed the creator, which under `unshare --kill-child`
   takes the namespace with it: unshare's child sets PDEATHSIG at once. bwrap's child does not. It
   blocks in `read(child_wait_fd)` until bwrap writes it, and sets PR_SET_PDEATHSIG only just before
   it execs (bubblewrap.c v0.11.0). So:
   * bwrap killed BEFORE its write: the child waits for ever, as a pid-namespace init that ignores TERM,
     holding the caller's stdio. `isolated` HUNG (F2: seen 3 times, once in the pinned depth suite).
   * bwrap killed AFTER the write: the child went on with no parent to die with. The harness lived
     until its pipes closed, so the inner half's `started` reached it, and the command ran. *Measured
     (the review's reproducer, `race2.cjs`):* ranAfterTerm 24/30 under bwrap, 0/20 under unshare.
   * The arm did not see it (F3): its probe counted "died by TERM" before it looked for RAN.

   Two layers close it, both backend-agnostic:
   * **(A) teardown** (`killCreatorTree`): SIGSTOP the creator and wait until it IS stopped. It can then
     neither fork nor write, and a fork in flight restarts. Then SIGKILL each of its children and then
     the creator. SIGKILL from the parent namespace reaches a pid-namespace init, and the kernel then
     kills every process in it.
   * **(B) the go-handshake** (`statusChannel`, `awaitGo`): the far side reports `started` and then
     waits for `go` on the status pipe before it starts the command. The harness answers only if no
     early signal came first; one thread decides, so it is one or the other. On an early signal the
     harness also closes its end, so a survivor of (A) reads EOF and exits with nothing started.
     EOF, or anything other than `go`, means the command never starts. The nested path's pid-1 helper
     does the same.

   *Measured after:* ranAfterTerm 0/30 under bwrap (orphans 0, hung 0) and 0/20 under unshare.
   *Arms:* the early-TERM arms judge RAN first, and assert nothing is left by tag and no run hangs.
   The GO arm freezes the harness (SIGSTOP) once the inner half exists, and keeps it frozen until the
   inner half sits in `read` on the status pipe. The command must not start, and once the harness is
   SIGKILLed the run ends with nothing left, under both creators. The
   teardown arm: a raw bwrap without `--die-with-parent` whose pid 1 outlives a SIGKILL of bwrap
   alone does not outlive the early teardown. Sabotage: (A) off → the teardown arm is red (B16), and
   (B) off → the GO arm is red (B17).

7. ⛔ **A signal sent to bwrap ITSELF (fifth review, F4).** It does not come from a terminal (difference 5) but
   from a supervisor: a systemd stop or a CI cancel signals every process of the unit at once, and anyone may
   aim a TERM at bwrap. bwrap died, and `--die-with-parent` then SIGKILLed the command in the middle of its
   own trap. *Measured by the review:* with the trap `echo GOT-TERM; sleep 0.5; echo CLEANED; exit 7`,
   unshare (which blocks TERM) completed it 3/3, while under bwrap CLEANED was never printed (3/3).
   ⇒ bwrap is exec'd through `env --ignore-signal=TERM,INT,HUP,QUIT` (`CREATOR_SHIELDED`; since the sixth
   review the unshare creators too, item 9).
   *Measured:* bwrap installs no handler of its own that would undo this; in /proc its SigIgn has the
   four and its SigCgt is 0. Its child inherits the ignore. A non-interactive bash cannot trap a signal
   that was ignored when it started (*measured:* `trap … TERM` was then silently a no-op), and the
   command would inherit the ignore too. So pid 1's bash is exec'd through `env
   --default-signal=TERM,INT,HUP,QUIT`, and the probe reads back that pid 1 can trap all four (probe step 6).
   An `env` without those options (GNU coreutils < 8.31) is refused by name: bwrap never runs with the
   command's signals ignored.
   ⚠ bash ignores QUIT for itself (SigIgn 0x4 even after the reset) and still traps it. So the
   read-back is "SigCgt has all four after `trap`", not "SigIgn is clear".
   ⛔ *And the shield itself is READ BACK (sixth review B5):* an `env` that accepts `--ignore-signal` and does
   nothing passes the probe. So when the far side reports `started`, before `go`, the harness reads the
   running creator's SigIgn from the host side (`/proc/<creator>/status`); without all four it tears the
   creator down and refuses, naming the read-back (`creatorShieldWhy`). An unreadable SigIgn is a refusal too.
   *Arms, on both creators:* a TERM to the harness, its creator and every descendant at once → the
   trap completes (CLEANED), rc 7; a TERM to the creator alone → the command runs to its own end.

8. ⛔ **A signal the harness does not forward (fifth review, item 4) — both creators.** Only INT, TERM and HUP
   were forwarded. Any other default-fatal signal killed the harness, and `unshare --fork` does not die with
   its parent. The command ran on, orphaned: every released `isolated` up to v0.34.0. ⚠ *Corrected (sixth
   review B6):* this item said unshare also "ignores QUIT". It does not; it DIES by it (item 9). Spawned by
   the harness it ignores nothing and blocks only INT and TERM (SigIgn 0, SigBlk 0x4002); the `SigIgn 0x6`
   once recorded was unshare run as a background job of a shell, which ignores INT and QUIT for it. The
   orphan came from the missing parent-death signal alone: the QUIT went to the harness, not to unshare.
   *Measured:* QUIT, USR2 and ALRM each left processes of the run alive under unshare, and none under bwrap
   (`--die-with-parent`). The count depends on the command: **6** with a command that has a child (unshare,
   pid 1's bash, both node halves, the command, its child), **5** in the arm, whose command `exec`s its sleep
   (the arm's message, and sabotage B21: `unshare SIGUSR2: 5 process(es) … outlived the harness`). ⇒ QUIT is forwarded like INT (`FORWARDED_SIGNALS`; pid 1 traps it, 131). The
   unshare creator, and the nested path's `unshare --fork`, run under `setpriv --pdeathsig KILL`: the
   parent-death signal is set before unshare runs and survives its exec and its user namespace (*measured*:
   2 left without, 0 with). Whatever kills the harness, SIGKILL included, now ends the namespace on both
   creators. It is a contract fix: the orphan stayed inside its namespaces, masks and drop.
   *Arm:* HUP, INT, QUIT, TERM, USR2, ALRM, PIPE and KILL to the harness leave no process of the command
   alive, under both creators. PIPE leaves the harness alive: node ignores it. USR1 is not in the list: every
   node half SWALLOWS it (v0.34.1, SECURITY — node's default opened an unauthenticated inspector), so it
   neither kills the harness nor is forwarded.

9. ⛔ **A stop signal to the caller's GROUP, or to every pid (sixth review B1, B2) — the unshare creators.**
   *Measured by the review, unshare only:* a QUIT or HUP to the caller's process group killed `unshare --fork`
   (it blocks INT and TERM, nothing else), and `--kill-child` ended the command mid-trap, rc 131/129, with no
   cleanup. The INT/TERM it survived reached pid 1 and the inner half directly — they were in the caller's
   group — as well as forwarded, so the command got one group signal 2–3 times. bwrap, detached and shielded,
   was fine. ⇒ The fresh path's unshare is spawned `detached` and exec'd through the same `env` shield as
   bwrap (`unshareCreator`); the nested path's `unshare --fork` gets the shield too (`privilegeDrop`).
   `probeUnshare` refuses an `env` without the options and reads back that pid 1 can trap all four through a
   shielded unshare; the running creator's SigIgn is read back before `go` (item 7).
   ⛔ *The nested path reads back BOTH shields too (seventh review, item 1):* `privilegeDrop` only sees `env`
   ACCEPT the options. *Measured:* an `env` that took `--default-signal` and dropped it left the nested pid 1
   at SigIgn 0x4007, and a forwarded TERM never reached the command (rc 5, not the trap's 7). So before `go`
   the nested call reads its unshare's SigIgn (`creatorShieldWhy`) and its pid 1's SigCgt (`nestedPid1Why`:
   the unshare child that is pid 1 by NSpid) from the host side; either one short, or unreadable, tears the
   chain down and refuses, named. *Arm:* a fake `env` that accepts and drops each option, for the nested
   call alone → `NOT RUN`, nothing run; control: the real `env` runs it.
   * **A terminal-group signal reaches the command EXACTLY ONCE** on both creators: only the harness is in
     the caller's group, and each half forwards it once. *Arm:* group HUP/QUIT/INT/TERM → `GOT` ×1, the trap
     completes, rc 7.
   * **An every-pid signal reaches each half directly as well as forwarded**, so the count varies (standard
     signals coalesce while pending). *Measured once, 2026-10-12:* unshare HUP ×2, QUIT ×3, INT ×3, TERM ×5;
     bwrap HUP ×2, QUIT ×5, INT ×4, TERM ×2. Not asserted; the arm asserts the trap completes, rc 7.
   * **B3:** the early teardown and the post-`started` forward never signal a creator node has REAPED (its pid
     may be reused) or that pid's children, and the teardown runs at most once.
   * **B4:** an import-only `teardown` seam on `runIsolated` (never an env var) disables the early teardown;
     the arm proves the inner half reports in, waits in `read` on the status pipe, and is never answered.
     Another arm SIGKILLs a nested harness and finds nothing of its namespace left while the outer run goes on.
   * **B9:** pid 1 (the reaping bash) SWALLOWS USR1, USR2, ALRM, PIPE, VTALRM, XCPU, XFSZ, SYS, TRAP and ABRT
     (`PID1_SWALLOWED`: a no-op trap while it polls, ignored for its final `wait`). Its `read -t` made bash
     catch them, so one sent from inside used to end pid 1 and the run. Not SEGV, BUS, ILL or FPE: a returning
     trap would re-run a genuine fault for ever. *Arm:* each sent twice from inside → the command's status.
   ⚠ **`runIsolated` must not be called from a Worker thread.** PDEATHSIG fires when the THREAD that forked
   the creator exits, not the process: a Worker that ends would SIGKILL a run still in progress.

**The probe** is side-effect free, and each step is a NAMED reason:

1. `bwrap` from the system dirs only. Otherwise: `bwrap: not installed (no bwrap in /usr/sbin,
   /usr/bin, /sbin, /bin)`.
2. **Not setuid** (S_ISUID on the resolved file), refused by rule before it is ever run: `bwrap:
   setuid — …`. A setuid bwrap is what a host installs when unprivileged user namespaces are off.
   Under it the inner half could not mask: bwrap's source refuses `--cap-add` to a non-root caller
   in setuid mode (*not measured here*: this host has no setuid bwrap). The command could not make a
   nested user namespace either, which row 7's control, the drop and the nested path all need. And
   bwrap ≥ 0.11 builds without setuid support by default (*measured*: the 0.11.2 binary here
   carries "setuid use of bubblewrap is not supported in this build"). The refusal rests on those
   capabilities. It does not rest on "`isolated` never executes a setuid binary", which is false:
   `/usr/bin/mount` is setuid and runs inside on both creators, where the bit has no effect (fifth
   review, F5).
3. `env` from the system dirs, able to ignore and reset signals (`env --ignore-signal=… --default-signal=…
   true`; difference 7). Otherwise: `its \`env\` cannot reset signal dispositions (…GNU coreutils ≥ 8.31)…`.
4. Every privileged tool, exactly as for unshare (`privilegedTools`). ⚠ bwrap does NOT remove the
   need for util-linux: the drop is `setpriv … unshare -U --map-user` (util-linux ≥ 2.38), and so
   is the nested path.
5. The argv above around the inner half's own first mount, `mount --make-rprivate /` (it needs
   CAP_SYS_ADMIN, so it proves the namespace root can MOUNT, not only that bwrap starts), then
   the privilege drop exactly as the inner half runs it (`setpriv … unshare -U --map-user`). A
   tmpfs on `/tmp`, as first planned, hid a `WEBCTL_UNSHARE_BIN` kept there from the drop step
   (measured).
6. Before both, inside the same run: pid 1 sets a trap for TERM, INT, HUP and QUIT and reads its own
   SigCgt back. All four must be caught; otherwise: `pid 1 cannot trap TERM, INT, HUP or QUIT …`
   (difference 7). Its failure reads `bwrap exited <n> before the
   isolated side reported in (<bwrap's last stderr line>)`. When the AppArmor sysctl reads 1, it
   adds `kernel.apparmor_restrict_unprivileged_userns = 1 — AppArmor denies bwrap a user namespace
   too`.

**No override** (no `WEBCTL_BWRAP_BIN`). `WEBCTL_UNSHARE_BIN` exists so that a host can grant user
namespaces to ONE dedicated binary instead of the system `unshare` (§0). The bwrap backend cannot
use that remedy on its own: it still runs `WEBCTL_UNSHARE_BIN` (or the system unshare) for the drop.
No host is known that needs a dedicated bwrap. A binary that runs every privileged step is exactly
what `systemTool` keeps off PATH. ⇒ Not added; a host that needs one is a ruling to ask for, with a
measurement.

**When bwrap actually runs** — the honest answer:

| host | unshare probe | bwrap probe | `isolated` |
|---|---|---|---|
| unprivileged userns allowed (*measured, this host*) | passes | passes | **unshare**. bwrap runs only when pinned — and pinned, it passes the whole table on all three paths (*measured*) |
| `user.max_user_namespaces=0` or `kernel.unprivileged_userns_clone=0`, bwrap not setuid | EPERM | EPERM (the same kernel check: "No permissions to create a new namespace") | refused, naming both |
| the same, bwrap setuid | EPERM | refused by rule (setuid) | refused, naming both |
| Ubuntu ≥ 23.10, `apparmor_restrict_unprivileged_userns=1`, no profile for bwrap (*measured on a lane's host*, §0) | EPERM | EPERM | refused (HOST POLICY text) |
| the same, with Ubuntu's `bwrap-userns-restrict` profile (*not measured*: no AppArmor here) | EPERM | bwrap gets its namespace, but its children run with every capability denied, so the probe's mount fails | refused, named |
| the same, with an admin's profile granting `userns,` to `/usr/bin/bwrap`, children unconfined (*not measured*) | EPERM | passes | **bwrap**. The one class found. The same admin could profile a dedicated unshare (`WEBCTL_UNSHARE_BIN`) instead |

⇒ **The honest answer (ruling, `webctl:base`, 2026-10-12): bwrap runs where unshare can't ONLY when an
admin's AppArmor profile grants `userns` to `/usr/bin/bwrap`. That case is UNMEASURED. The
policy-blocked lane waits for docker.** ⛔ **Its arm is UNTESTED here:** no table row, selection test or
gate run in this repo exercises an AppArmor-profiled bwrap. This host has no AppArmor, and the
selection tests reach bwrap only with a FAKE unshare that fails its probe. Until a host with that
profile runs the table pinned to bwrap, "bwrap works under that profile" is a claim, not a result.

⇒ **On no measured host does bwrap run where unshare cannot.** It is a second, independently built
namespace creator. A host can pin it, or reach it in the one AppArmor case above, and the same
table judges it. A host blocked by policy (§0) is not unblocked by bwrap; that host waits for docker
(§3, phase 3).

**Nested and stripped paths.** These are unchanged. A nested call makes no sandbox of its own (§2),
whatever created its outer. A stripped-markers call isolates again with the backend IT selects. A
pin is inherited through the `WEBCTL_*` allowlist, so a pinned bwrap outer runs bwrap again inside
(*measured*: the table's stripped path is green under bwrap).

**Verdict and gate.** `…; backend: bwrap` — with `(skipped unshare: <v0.33's reason>)` when unshare's
probe failed. unshare's own stderr is then printed above the verdict, so the reason's "unshare's own
message, if any, is above" stays true. The gate reads the backend exactly as before (§4).
`HARNESS_GENERATION` is **9** (fifth review; 8 is v0.34.1's SIGUSR1 fix, which v0.35.0 contains): no verdict changes meaning, but behaviour does. A host
that refused before may now run with `backend: bwrap` named. There is a new propagation refusal. The
signal semantics changed (QUIT forwarded, the go-handshake, the early teardown, the creator dying with
the harness). Lanes find v0.34-vendored harnesses with "who is below 9".

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
4. **Reaping, signals, no leftovers.** `--init` for pid 1 (*as built:* our own reaping bash, §3b) (orphans reaped, as v0.33.0 does
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

### 3b. The docker backend as built (v0.35.0, phase 3)

*Approved 2026-10-13 by the gating instance, with the rulings and additions marked **(ruling)**.*

§3 and §3a were written on 2026-10-07, before v0.34/v0.35 hardened the contract. This section replaces
them as the spec; they stay above as the original conditions, each answered here. *Measured* below
means on a policy-blocked host: `kernel.apparmor_restrict_unprivileged_userns=1`, Docker Engine
29.1.3 (rootful, local unix socket, cgroup v2, `cgroupns` on, default seccomp and AppArmor
profiles), kernel 7.0, a throwaway container per measurement removed by exact name.

**What docker is, here: the WHOLE sandbox, not a creator.** bwrap could be a mere namespace creator
(§2a) because the inner half then masks with capabilities. Under docker it cannot. *Measured:*
`unshare -rn` inside → EPERM (default seccomp, and the host's AppArmor userns rule), `mount -t
tmpfs` → refused, and a `/dev` tmpfs replacement fails container init. Giving the inner half
`CAP_SYS_ADMIN` would need the AppArmor or seccomp profile off, which §3a.2 forbids. ⇒ The
DAEMON builds the sandbox from `docker create` flags. A capless inner half (`__isolated-docker`,
node, the caller's uid) then READS BACK every property with the shared gap functions before
anything runs. Where a gap function assumes our own masks (the `webctl-isolated` tmpfs sources,
the HIDE tmpfs), it gets a docker branch that checks the same PROPERTY (e.g. a hidden dir is
ENOENT, not "under our hide"). Every read-back that fails is a REFUSAL, as on the namespace
backends.

#### Two rules from the final review (2026-10-14)

* **Hidden dirs inside a bind are covered.** A docker bind shows everything beneath it, so each
  hidden dir (§1 row 4) inside a bind gets an empty read-only cover. As on the namespace backends,
  only a `--keep` AT a hidden dir unhides it; a keep beneath it is mounted on top of the cover. The
  read-back judges the cover: empty, not writable, its only entries leading to a keep beneath.
  There is no exemption for a hidden dir INSIDE a keep: that exemption made the check unable to fail.
* **No mount path may carry a comma, a quote or a control character.** docker's `--mount` is
  comma-separated with the last field winning, so such a path is a mount spec of the caller's
  choosing. Refused before the create, by label.

#### The run, host side

1. **Probe** (side-effect free; each failure a NAMED reason, §2):
   1. `docker` from the system dirs only.
   2. ⛔ `DOCKER_HOST` or `DOCKER_CONTEXT` set to anything but the local unix socket → REFUSED
      by name (§3a.1). Not silently overridden: a lane that set one meant something.
   3. Every docker call carries `-H unix:///var/run/docker.sock` explicitly. *Measured:* `-H`
      wins over both `DOCKER_HOST=ssh://…` and `DOCKER_CONTEXT`. The CLI gets
      `privilegedEnv` with every `DOCKER_*` removed (row 11: it is the half that talks to a
      root-equivalent daemon).
   4. `docker version` answers; `docker info` lists `seccomp`, and `apparmor` when the host
      kernel has AppArmor; the daemon is not rootless. ⚠ A rootless daemon's socket is elsewhere
      and its uid mapping differs: a NAMED reason (unmeasured, not supported in phase 3).
   5. The image (below) exists locally. A missing one is a reason that names the build command.
2. **Backend-specific refusals after selection** (FAIL, never a fallback): a native addon
   (`*.node`) under the cwd's `node_modules` (§3a.6); a `--keep`/`--keep-ro`/cwd that is or
   contains a docker socket; a keep or cwd beneath `/dev`, `/proc` or `/sys`.
   ⛔ **(ruling) A symlink anywhere in a bind source is REFUSED.** The bind sources are resolved
   by a ROOT daemon, not by the caller. So the cwd, every `--keep`, every `--keep-ro` and base's
   root must each equal their own `realpath`, component by component. Otherwise the run is
   refused, naming the option and its position, never the path. A link swapped in between our
   check and the daemon's resolve would bind whatever it then points at, with root's reach. The
   check makes the daemon bind exactly what the caller named. *Arm:* a `--keep` and a cwd through a
   symlinked component → refused before any `create` (fake CLI).
3. **The reaper first** (§3a.4, hard point (a)). A host-side process (node), spawned `detached`,
   reads a pipe whose only write end the harness holds. It CATCHES and drops TERM, INT, HUP and
   QUIT in-process. *Measured:* `env --ignore-signal` does not hold for it, because node resets
   every inherited disposition at start (SigIgn 0). The arm reads its SigCgt and sends it a TERM. On EOF it runs `docker rm -f <exact name>` and, once the harness has written
   it, `<exact id>`. EOF is how the reaper learns the harness died, by ANY signal, SIGKILL
   included. It needs no parent-death signal and no polling. The container name is fixed BEFORE
   the create, so the reaper can remove a container whose create was still in flight; it retries
   by exact name for a short window. *Measured (prototype):* harness SIGKILLed mid-run, 3/3, no
   container left. ⚠ The write end must reach no other process (the CLI children are spawned with
   explicit stdio only).
   ⛔ **(ruling) The reaper is BOUNDED and always exits.** After EOF, each `docker rm -f` gets 10 s
   (`timeout`) and the retries stop at **30 s** in total; then it exits, whatever docker did. A
   run that ended normally writes `done` first, and the reaper exits after one `rm -f` by exact
   id. *Arm:* a fake CLI whose `rm` hangs for ever → the reaper is gone within the bound, and it
   reports what it could not remove on stderr, by exact name. Residual (also in §6): a SIGKILL to
   every pid of the uid (`kill -9 -1`) kills the reaper too. Named, not closed.
4. **`docker create`, then `docker start -a -i`**, split so the id is known before anything runs
   and the reaper holds it. The flags:

       --name webctl-iso-u<uid>-<lane>-<pid>   --label org.cliai.webctl-iso.owner=u<uid>
       --rm  --network none  --read-only  --cap-drop ALL
       --security-opt no-new-privileges  --user <uid>:<gid>  --hostname webctl-isolated
       --cpus <c> --memory <m> --pids-limit <p>
       --tmpfs /tmp:mode=1777 --tmpfs /var/tmp:mode=1777 --tmpfs /run:mode=1777
       -v <cwd>:<cwd>  -v <keep>:<keep>  -v <keep-ro>:<keep-ro>:ro  -v <base root>:<base root>:ro
       --mount type=bind,src=/dev/null,dst=<host socket under a bind>,readonly   (each one)
       -v <channel>/machine-id:/etc/machine-id:ro   (and /var/lib/dbus/machine-id)
       -v <channel dir>:/run/webctl-isolated:ro
       --interactive <image id> /bin/bash … PID1_REAPER … node … __isolated-docker -- <cmd…>

   *As built:* pid 1 is the harness's own reaping bash (`PID1_REAPER`, the same as on the namespace
   backends, with no keyctl), NOT `--init`. *Measured:* `--init` binds the host's `docker-init`
   into the container as a SLAVE mount (`master:1`), so a later host mount there would appear
   inside. The propagation read-back refused it, correctly. A bind whose propagation we do not
   control is not used.

   ⛔ Never `--privileged`, `seccomp=unconfined`, `apparmor=unconfined`, a published port, the host
   network, `--pid host`, `--ipc host`, `--userns host`, or a docker.sock mount (§3a.2,
   §3a.5). `<lane>` is `[a-z0-9-]{1,24}` from `WEBCTL_LANE`, else from the cwd's basename. The
   defaults are `--cpus 2 --memory 4g --pids-limit 4096`, overridable via `WEBCTL_ISOLATION_DOCKER_CPUS`,
   `_MEMORY` and `_PIDS`. ⛔ Never prune. Removal is only by exact id or exact name (§3a.5).
5. **The channel** is a private `0700` dir (`mkdtemp`), bound read-only at `/run/webctl-isolated`.
   It holds `plan.json` (`0600`), `marker`, the neutral `machine-id`, and two FIFOs: `status` (out)
   and `go` (in). *Measured:* a FIFO in a read-only bind is read and written across the container
   boundary. The harness holds each FIFO `O_RDWR`, so the inner half's open never blocks, and
   closing `go` unanswered is EOF for it. The plan is a FILE, not a FIFO: the host side would block
   opening a FIFO for write before the container exists. It is the same JSON the namespace
   backends send on fd 4: the command's env, the binds, the host socket list and the ids. It is
   readable only by the caller's uid, which is the same exposure as `/proc/<pid>/environ`. ⇒ The
   command's env is never on any argv, never in the CLI's env, never in `docker inspect` (row 11).
   The dir is removed when the run ends.
6. **Signals.** *Measured:* the 29.1.3 CLI proxies TERM, but it DIES by HUP, QUIT, USR2, ALRM
   and USR1, and the container RUNS ON (5 of 5 left running). After a SIGKILL of the CLI the
   container runs on. ⇒ The harness never relies on the CLI to deliver a signal. It forwards each
   signal in `FORWARDED_SIGNALS` ONCE as `docker kill --signal=<sig> <exact id>`. That reaches pid 1
   (the reaping bash), which forwards it to the inner half, which forwards it to the command's
   group (as the pid-1 helper does). That gives **exactly once** for a terminal-group signal.
   *Measured:* group TERM, INT, HUP and QUIT each gave GOT ×1 and the trap completed.
   *As built, against the draft:* `docker start` has no `--sig-proxy=false` (its `--attach` always
   proxies), and the CLI **cannot be shielded**. Go resets a signal the process started with
   ignored once it installs a handler for it. *Measured:* `start --attach` under
   `env --ignore-signal` read back SigIgn 0, and the shield read-back refused the run. ⇒ The CLI is
   spawned `detached`, so only a signal aimed at the CLI itself reaches it, and it is NOT the
   run's authority. If it dies by a signal while the container runs on, the harness follows the
   container to its end with `docker wait <exact id>` and reports that status. A signal aimed at
   the CLI is proxied by it as well: an extra delivery, like an every-pid signal on the other
   backends (§2a item 9: counted, not asserted). **128+n**: pid 1 exits 128+n when its child dies
   by n (*measured:* self-TERM → 143). The harness then dies by n as it does on the other backends
   (`exitOrDieBy`). **Nothing outlives the harness, SIGKILL included:** the
   reaper, item 3. **An early signal means the command never runs:** the go-handshake over the
   FIFOs (§2a difference 6 (B)), and an early signal also means no `docker start`. **SIGUSR1:** every node
   half swallows it, the inner half included; it is not forwarded.
7. **Stdio:** the command's stdout and stderr are the CLI's pipes (`--attach`, never `-t`), and its
   stdin is EOF. *As built:* never `--interactive`. *Measured* by the acceptance run on the
   policy-blocked host: with it, the CLI READS the caller's stdin eagerly and forwards it, whether or
   not the command reads. The gate's own `while read` loop over its registry lost the next
   consumer's line, so that consumer never ran. The command therefore never holds the caller's
   terminal. Row 12b holds (`/dev/tty` → ENXIO, TIOCSTI has no
   terminal to reach), and §6's "stdio that IS the terminal" residual does not exist on this
   backend.

#### Every row of §1, mapped

| # | docker mechanism | read back by the inner half | status (*measured*) |
|---|---|---|---|
| 1 | `--network none` | lo only, no listener, self-connect | MET: lo only |
| 2 | only declared binds; a host socket under one masked by a `/dev/null` bind | connect-test of the planned list, as today | MET: an unmasked socket in a bind answered CONNECTED; masked → ECONNREFUSED |
| 3 | own PID ns; `cgroupns` private; `/sys/fs/cgroup` a read-only cgroup2 rooted at `/`; container in its own session | `cgroupGaps` (docker branch: no `nsdelegate` needed, see below); host pid → ESRCH | MET: `0::/`, cgroup2 ro. kill(0) cannot reach the caller's group (no shared session) |
| 4 | the home is never mounted | `hiddenGaps` (docker branch: ENOENT) | MET |
| 5 | `--cap-drop ALL`, `no-new-privileges`, `--user` | CapEff/CapBnd 0, NoNewPrivs 1, mount refused | MET: CapBnd 0, NNP 1, Seccomp 2 |
| 6 | the plan's env, applied when the command is spawned | as today | MET |
| 7 | `--read-only`, each bind's mode, the tmpfs set | `readOnlyGaps` over `/` | MET for writes. ⛔ **CONTROL NOT MET:** a nested `unshare -rn`, procfs and sysfs mount are EPERM inside (seccomp + AppArmor). Late-mount: docker binds are `rprivate`; the arm needs a mount the HOST makes, so it runs where the table's world can make one |
| 8 | `--tmpfs` `/tmp`, `/var/tmp`, `/run` and `/dev/shm` (1777, `exec`: docker's tmpfs default is `noexec`, the namespace backends' is not, and a lane's PATH-stub test failed on it, measured 2026-10-14); private IPC ns and mqueue | `maskIpc`'s read-back | MET: all four writable, private, nosuid, nodev, exec |
| 9 | the default seccomp denies `add_key` and `keyctl`; `/proc/keys` is masked | `add_key` → EPERM | MET, more strongly: the §1a description residual is closed. ⛔ **CONTROL NOT MET:** a key added inside is EPERM. Verdict `; keyring: none (docker seccomp)` |
| 10 | `--hostname webctl-isolated`; the neutral machine-id bound read-only; a fresh sysfs per netns. `/etc/passwd` and `/etc/group` hold root, nobody and the CALLER only (its real name, ids and passwd home), bound read-only. On the namespace backends the host's own files are visible; under docker the image's knew no caller, and a lane's home guard (`getent passwd "$(id -u)"`) died with exit 2 (measured, 2026-10-14) | `identityGaps` | MET: hostname, machine-id, `/sys/class/net` and `/sys/devices/virtual/net` = lo; the caller resolves |
| 11 | the CLI gets `privilegedEnv` minus `DOCKER_*`; the env travels by FIFO | as today | MET by construction (arm: an `LD_PRELOAD` in the caller never runs in the CLI or the inner half) |
| 12 | docker's own `/dev`, which cannot be replaced | `devGaps` (docker branch) | MET with ONE accepted extra **(ruling)**: `core`. Docker's `/dev` holds the 15 listed names plus `core` → `/proc/kcore`. Read back: `/dev/core` is a symlink whose target is exactly `/proc/kcore`, and `/proc/kcore` is docker's mask: a char device 1:3, bind-mounted from `/dev`'s `null` (*measured*), whose read is EACCES (*measured*, AppArmor) or 0 bytes. Any OTHER extra name → REFUSED. Docker's `/dev` is a rw tmpfs (mode 755, root's): a create there must be EACCES or EROFS (*measured:* EACCES), nothing else. `/dev/pts` is a new instance; `uinput` and `snd` are absent. Verdict `; dev: +core` |
| 12b | no tty: stdio via the CLI's pipes | `/dev/tty` → ENXIO | MET, more strongly (no terminal at all) |

**Rows docker cannot meet, named (never papered over):**

1. **Row 7's control:** no namespaces of the command's own. Chromium's own sandbox fails inside, so a
   lane that runs Chromium inside needs `--no-sandbox`, which is a weaker browser.
2. **Row 9's control:** no keyring at all.
3. **The nested path cannot drop or re-isolate** (below): a nested command shares its nested
   caller's PID namespace and uid.
4. **The userland is the IMAGE's.** The host's PATH tools are not re-bound (another libc). A lane
   calling a host tool inside finds the image's, or ENOENT.
5. **The command's stdin is EOF** (item 7). The namespace backends pass the caller's stdin. Here it
   is not forwarded, because forwarding means the CLI reads it whether or not the command does.

⇒ The verdict names this backend's deviations. The table marks each unmet control as a named
DEVIATION for docker, never a pass. A lane that needs one of them is refused nothing: it fails
visibly inside.

#### Nested under docker (§3a.3, hard point (b))

**The proof** (`dockerInsideProof`) must be something a process inside cannot forge, and the
process inside can mount nothing (*measured:* mount refused, `unshare` EPERM). So:

* a read-only bind at `/run/webctl-isolated` whose mountinfo row is a bind (not our tmpfs, not a
  plain dir) and holds the run's marker file;
* CapBnd 0, NoNewPrivs 1, Seccomp 2;
* hostname `webctl-isolated`;
* lo only, no listener;
* AND every read-back of the table above, run again in place: the properties, the loopback, and
  row 2's masked host sockets (`dockerReadBacks`, the one function the inner half runs too). Until
  2026-10-13 the nested path re-ran the properties only.

A forged marker means the env is set and/or a marker file exists, but there is no such mount, or
any property fails. That is REFUSED (exit 2, as `kernelInsideProof`). The nested call cannot
unshare, so it runs the command IN PLACE: the env allowlist is applied again, and it runs in a
session and group of its own, forwarding signals. The **stripped-markers** path is the same:
under docker the proof does not depend on the env at all. `isolation-check` accepts this proof
too. *Arms:* nested and stripped calls pass the table (minus the named deviations); a forged
marker (the env set, plus a plain file) is refused, both on the host and inside an unshare outer.

#### The image

* `docker/isolated/Dockerfile`: `FROM node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4`
  (node 22.23.3 ≥ engines 22.12), plus a short, listed tool set. *Measured:* the base image has
  `bash setpriv unshare mount hostname`, but no `git`, `ps`, `python3` or `keyctl`. Each added tool
  is an explicit line; lanes ask for more through webctl:mgr.
* **(ruling) The tool survey.** It covers what the consumers' contract runs invoke under `isolated`. Two wired
  consumers on the policy-blocked host each run their WHOLE `test-against-base.sh` under
  `isolated` (their `npm test`). They are named here by role only, as A and B: both are private
  repos. The public registry's consumers have no clone on that host, so the gating instance runs
  the same survey there. *Measured in the base image:* `hostname diff sed awk grep sort mktemp
  timeout id env realpath stat find tar gzip script` are present; `git ps xq uv python3 curl jq`
  are absent.

  | tool | needed by | in the base image | decision |
  |---|---|---|---|
  | `git` | A, B: the pin check (`ls-tree`, `rev-parse`), the downgrade arms (`checkout`), the PASS line (`describe`) | no | **added** |
  | `ps` (procps) | none of A and B; base's own arms read `/proc` | no | **added**: diagnostics in a shared harness, small |
  | `hostname`, `diff`, `sed`, `awk`, `grep`, `sort`, `mktemp`, `timeout`, `id`, `env` | A, B | yes | (base) |
  | `xq` | A, B: the no-host-literals step lists machine names with `xq machine ls --json` | no | **REFUSED**: a host-specific tool whose checkout lives under the hidden home, and it needs uv and python. **(ruling) The DATA goes in instead:** see "Machine names" below, on every backend |
  | `uv`, `python3`, `curl`, `jq` | none of A and B | no | not added until a lane names one |
* **(ruling) Acceptance on the real target.** Before the merge, each consumer on the policy-blocked
  host that waits on docker passes its OWN `./test-against-base.sh` there, under the docker
  backend. It runs in a SCRATCH clone (never the lane's live tree), by the method of
  `scripts/test-all-consumers.sh --scratch`. The report gives pass/fail and the verdict line for
  each consumer.
* It is built ONLY by an explicit verb (`contract-harness.mjs isolated-image build`). The pull of
  the digest-pinned base happens there and never at test time. It is tagged
  `webctl-iso/node22:<first 12 hex of the recipe's sha256>` and labelled with that recipe hash
  and the owner `u<uid>`. The run resolves the tag to an image ID once, checks the label, and
  runs by ID, so a retag mid-run cannot swap it. ⚠ Any user of a shared daemon is root-equivalent
  and could build a same-tagged image. The label check catches an accident, not an attacker.
* Size: the base is 231 MB. The image adds well under 1 GB.

#### Machine names for a no-host-literals check (every backend) — (ruling, 2026-10-13)

A lane's "no host literal in code" check (nl0c §3, `findHostLiterals`) needs the lane's machine
names. They used to come from `xq machine ls --json` run INSIDE the sandbox, which broke when the
home was hidden (DEV_NOTES "xq could not run inside") and cannot work under docker (no xq in the
image). **Pass the data in, not the tool.** Putting xq in the image would tie the image to xq's
version, and xq needs its own state, which the sandbox hides anyway. Skipping the check under one
backend is not allowed either: a check that skips there is a check that cannot fail there (k3wn).

* **Host side, before entering ANY backend** (unshare, bwrap or docker; one mechanism for all):
  the harness runs `xq machine ls --json` on the HOST, with a bounded timeout and no `--check`, so
  nothing goes over the network.
  * ⛔ **Which xq:** only the FIRST `xq` on the caller's PATH, judged by the same planted-xq rule
    as xq's root (DEV_NOTES "xq could not run inside"): a PATH entry, link or real file in a
    writable dir, or a real file not named `xq`, is NOT run. Running a planted `xq` on the host,
    outside the sandbox, would be an escape. An `xq` that is absent or not judged safe, a non-zero
    exit, a timeout, output that is not JSON, or a `schema` other than 1 → no names are passed,
    and the verdict says why. A consumer's check then REFUSES by name.
  * ⛔ **How it is run (review, BLOCKER, measured):** xq is a uv script, and its interpreter is
    resolved on PATH. With the caller's PATH, npm's writable `<cwd>/node_modules/.bin` came
    first, and a planted `uv` ran on the host. ⇒ xq runs with a JUDGED PATH: only entries the
    run cannot write, and an entry outside the home only when it is root-owned. It runs with
    cwd `/`, and an env of identity only (the real home from passwd; no `UV_*`, `PYTHON*`,
    `XDG_*` or display). Not trusted either: an xq whose FILE is writable (outside the home),
    or whose checkout holds a writable path (a `--keep` of its `lib/`).
  * **The names:** each machine's `alias`, and the host of its `ssh` destination, deduplicated.
    *Per xq (2026-10-13):* `ssh` is an OPAQUE ssh destination, exactly as in xq's config, and
    untrusted text: xq runs `ssh -- <value>`. So base reads it as ssh(1) does,
    `ssh://[user@]host[:port]` (an IPv6 host in brackets) or `[user@]host` (an IPv6 host bare;
    an `~/.ssh/config` alias is a host). A dotted name also adds its first label. ⛔ Anything
    else (`host:port`, which is not ssh syntax, `h -p 22`, a leading `-`) refuses the whole list:
    it would yield a name that never matches, and the check would say clean. Within schema 1,
    keys are never removed or redefined, new keys may appear, and unknown ones are ignored
    (xq's contract). An xq with no machines configured gives an EMPTY
    list. The file is still passed, and the check refuses "no names supplied" (it scans for
    nothing otherwise).
* **A second host-side source (adm's ruling, 2026-10-14): `~/.config/webctl/machine-names`.** On a
  host whose xq lists no machines, the operator declares the names in the family's shared config dir,
  one per line, mode 600, never committed. `isolated` reads it on the HOST, and its names are UNIONED
  with xq's. ⛔ It is a FIXED path, never one taken from the env: a caller-chosen path could name
  `~/.ssh/id_rsa` (also mode 600 and owned) and carry a key into the sandbox. The file is refused
  (`none (<why>)`, and nothing is passed from it) unless it is a regular file (not a symlink), owned by
  the caller, mode 600 or stricter, at most 64 KiB, and every non-blank line is a host-name-like token
  (`[A-Za-z0-9._:-]`, at most 253 characters). `#` starts a comment line.
* **The file:** one name per line, at the fixed path `/run/.webctl-identity/machine-names`
  inside, READ-ONLY, and `WEBCTL_MACHINE_NAMES_FILE` is set to that path. ⚠ The path is the same
  on every backend, so a lane needs one code path.
  * unshare and bwrap: the names travel in the run's plan over its pipe (never argv, never a file
    on the host), and the inner half writes them onto the identity files' own tmpfs, which is
    then made read-only (as `/etc/machine-id`'s neutral copy is). They are gone with the namespace.
  * docker: a 0600 file in the run's private 0700 channel dir on the host, never in git, bound
    read-only at that path, and removed with the channel dir on every exit path.
  * A nested call keeps the variable while the outer call's file is there. A caller's own
    `WEBCTL_MACHINE_NAMES_FILE` is scrubbed: only `isolated` sets it.
* ⛔ **The names are private data.** None of them may reach base's repo, a log, argv, an env dump
  or the verdict. The verdict says only `; machine-names: passed`, or `; machine-names: none
  (<why>)` with a reason that names no machine. The env var holds a PATH, never a name.
* **Base owns the check:** `scripts/no-host-literals.mjs`. It reads `WEBCTL_MACHINE_NAMES_FILE`,
  scans the files git TRACKS in its cwd with `findHostLiterals`, and prints each hit as
  `path:line` plus the name's index in the file, never the name itself. Exit 0 = clean,
  1 = found, 2 = REFUSED. It refuses when the variable is unset ("not passed by `isolated`"), the
  file is unreadable or empty, or no file is tracked. Lanes switch to it at the relocation wake
  (every lane copies the same script today).
* **Arms:**
  * under each backend, a name planted in a fixture is caught through the passed file;
  * with no file, the check gives the named refusal;
  * the names never appear in argv, an env dump or the verdict;
  * a planted `xq` (in a writable PATH dir) is never run on the host;
  * a schema other than 1 passes nothing, and the reason is named.

#### Selection, verdict, generation

* §2 is unchanged: docker is probed only after unshare and bwrap fail their probes, or when it is
  pinned. A pinned docker that cannot run is a REFUSAL. An unpinned refusal still LEADS with
  unshare's v0.33 text, then `…; no isolation backend can be used here — bwrap: <why>, docker:
  <why>`. A probe failure falls through; a failure after selection is a FAIL.
* Verdict: `…; backend: docker (skipped unshare: …, skipped bwrap: …)` is the LAST `; backend:`
  clause, then `; keyring: none (docker seccomp)`, then `; dev: +core`. **(ruling)** `; cgroup2:
  nsdelegate` is OMITTED under docker, and nothing replaces it. That check does not run there
  (the command cannot make a cgroup namespace), and a verdict never claims a check that did not
  run. The JSONL carries `"backend": "docker"` and `"skipped"` as today.
* **(ruling) `HARNESS_GENERATION` stays 9.** The number marks a RELEASE's behaviour change, and docker
  lands in the same unreleased v0.35.0 that took 9. Every older outer is v0.34.x (≤ 8), so "who
  is below 9" still finds exactly the lanes without v0.35.

#### Arms (§3a.5: fake docker CLI for units; real docker within limits)

* **Unit**, against a FAKE `docker` on a throwaway system-dir path that records every argv:
  * the name matches `^webctl-iso-u\d+-[a-z0-9-]{1,24}-\d+$`;
  * `--cpus`, `--memory`, `--pids-limit`, `--rm`, `--read-only` and `--network none`
    are present;
  * none of the forbidden flags appears (nor `--init`: its host bind is a slave mount), and no `prune`
    verb appears anywhere;
  * `-H unix:///var/run/docker.sock` is on every call;
  * a planted `DOCKER_HOST=ssh://192.0.2.1` is refused before any `create`;
  * the command's env appears in no argv;
  * selection order and pin refusals;
  * a missing image names the build command;
  * a native addon is refused;
  * a symlinked bind source is refused (ruling 7);
  * the reaper exits within its bound against a hanging `rm` (ruling 6).
* **Real docker:** the table (§1) pinned to docker, on the fresh, nested and stripped paths.
* **§3a.2:** `docker inspect` of the RUNNING container: `Privileged` false, `SecurityOpt` is
  exactly `no-new-privileges`, AppArmor `docker-default`.
* **§3a.4:** harness SIGKILLed after `started` and before it (in the create window), and every
  forwarded and unforwarded fatal signal → no container by exact name, no process of the run.
* **The v0.35 signal arms:** group HUP/QUIT/INT/TERM → `GOT` ×1, rc 7; an early TERM → never RAN.
* **Sabotages** on a copy, logged in DEV_NOTES:
  * no reaper → the §3a.4 arm is red;
  * the harness forwarding nothing (relying on the CLI) → the HUP arm is red;
  * the `/dev/null` socket mask dropped → row 2 is red;
  * the env passed as `-e` → the argv arm is red;
  * the proof skips its mount check → the forged-marker arm is red;
  * the symlink check off → its arm is red;
  * the reaper unbounded → the bound arm is red;
  * any extra `/dev` name accepted → a planted one (in a fake `/dev` read-back) is not refused.

## 4. Verdict and gate

* The verdict line and JSONL record name the backend used and, for each skipped one, the
  reason (e.g. `unshare: EPERM (apparmor_restrict_unprivileged_userns=1)`).
  *As built:* the verdict ends `…; backend: unshare` (with `(skipped bwrap: …)` when a backend
  before it was skipped), then `; keyring: …` when that deviates, then `; cgroup2: nsdelegate` (§1a
  row 3, the check every run passed); a refusal's JSONL record carries `"backend"` (null when none) and
  `"skipped": [{backend, why}]`. A successful run still prints nothing on stdout.
* The release gate records the backend per consumer, and the summary shows the mix.
  *As built:* read from the GATE's own `isolated` verdict (the last before the contract's start
  line), so no consumer prints anything new: each scratch-mode envelope gains
  `"isolation": "<backend>"` (`none` when refused, `unknown` when no verdict named one), and the
  summary prints `----- isolation backends: unshare=N … -----`. ⚠ It takes the verdict's LAST
  `; backend:` (review F8): the paths the caller named come before the clause and may contain it.
* `HARNESS_GENERATION` is **7** (ruling R4): a lane matching `; backend:` keys it on
  `require-generation 7` (CHANGELOG v0.34.0 has the guard).
* AppArmor fallback: on EPERM with the sysctl at 1, the refusal (when no backend works)
  names the sysctl and both remedies: a host sysctl, or a profile for `WEBCTL_UNSHARE_BIN`.

## 5. Order

After v0.33.0 (hidden home, env allowlist, `--keep-ro`, `WEBCTL_UNSHARE_BIN`):

* **v0.34.0 — the unshare hardening release, unshare only:** §1's shared arm set (parameterised by
  backend) and the selection frame (§2, §4); rows 7–12 closed for unshare, plus the cgroup arm of
  row 3. The `/dev` (row 12) and cgroup (row 3) holes were open in every released `isolated` — a
  security update.
* **v0.35.0 — bwrap, then docker** (§3, §3a), each judged by the same table.

A lane blocked by host policy (the Ubuntu host above) resumes on v0.35.0, with bwrap or docker.

## 6. Status (2026-10-11)

* **Phase 1 — done (unreleased, v0.34.0):** the selection frame (§2, §4), the shared arm table
  (§1, run against unshare), rows 8–10 closed for unshare (§1a), the gate's per-consumer backend
  and mix.
* **Phase-1 review (2026-10-10) — done:** SysV IPC and mqueues (row 8), the sysfs refusal and the
  `/sys/devices/virtual/net` read-back (row 10), the keyring join on every path and `unverified`
  (row 9, R3), the identity files read-only (row 10), the v0.33 refusal lead (§2), the runner guard
  (§2), the gate's last-match parse (§4), generation 7, `hostname` required (R2).
* **Row 7 closed (R1):** the read-only root (§1a), on the fresh, nested and stripped paths.
* **Re-review (2026-10-10):** the host `/sys` read-only under the fresh sysfs (§1a row 7); row 12 — a minimal fresh `/dev` — and row 3's cgroup arm — a cgroup
  namespace and a read-only cgroup tree (§1a): two holes in every released `isolated` up to v0.33.1.
* **Residual by ruling (F2, option c):** key descriptions and ids enumerable (§1a row 9) — no mask.
  The read-only root is proved not to block nested procfs/sysfs mounts (an arm in row 7).
* **Residual (re-review, item 8): `pathUnreachable` trusts ONE `stat`.** The read-only root skips a
  mount point whose `stat` answers EACCES/EPERM (§1a row 7) — in the ro step and in its read-back.
  A user's own FUSE daemon could answer EACCES to that one `stat` and grant access later, leaving its
  mount read-write inside. The command cannot drive this itself: it cannot reach the daemon (host
  unix sockets masked, row 2) and holds no capability to mount one; the daemon must already be
  running on the host, as the same user, and choose to lie.
* **Third review (2026-10-11):** no controlling terminal — a new session above the capless chain,
  signals forwarded to the command's group (row 12b, F1); row 3's cgroup view is a fresh cgroup2
  rooted at the namespace (F3), and `nsdelegate` is required (F2); the fresh `/dev`'s links are read
  back (F5).
* **Residual (third review, F2): empty child cgroups.** With `nsdelegate`, the command can still
  `mkdir` child cgroups beneath the caller's scope through a nested cgroup2 mount (a cgroup namespace
  of its own): the boundary refuses `cgroup.kill` at the namespace root and any move across it, not a
  `mkdir` under it. Such a cgroup may outlive the run (an emptied cgroup is not removed by the kernel)
  and goes when the scope does. It cannot kill or move the caller's processes. Without `nsdelegate`,
  `isolated` refuses (§1a row 3).
* **Residual (third review, F4): user-writable sysfs attributes.** The fresh sysfs is read-write (a
  read-only one breaks every nested sysfs mount, §1a row 7), and sysfs's own permissions govern it: an
  attribute udev granted the user's uid (`uaccess`, e.g. a backlight's `brightness`) is writable
  inside, as outside. Not masked, by ruling: a mount over a sysfs file blocks nested sysfs mounts
  (`mnt_already_visible`). Not counted in the verdict: walking the tree measured 2.8 s for
  `/sys/devices` (27,381 files) and 7 s for all of `/sys`, far over a per-run budget.
* **Residual (pre-tag review): stdio that IS the terminal.** Row 12b removes the controlling
  terminal, not the terminal: fds 0/1/2 inherited from a terminal stay open in the command — it can
  read keystrokes typed during the run, set termios (persisting after exit) and write escape
  sequences a terminal may answer into its own input. As under `bwrap --new-session`. The gate and
  lanes run with no terminal. The same new session also closes `kill(0)` reaching the caller's
  process group (measured pre-tag: a sentinel there died on v0.33.1, lives on v0.34.0); row 3's kill(0)
  arm since v0.35.0 (red only with BOTH setsids gone — the chain's and the helper's).
* **v0.35.0 follow-ups from the pre-tag review:** the row-12b TIOCSTI assertion cannot fail where
  `dev.tty.legacy_tiocsti=0` (EIO comes before the ctty check) — accept EPERM only when it is 1,
  else mark it untested; the `/dev/tty` ENXIO arm carries the property meanwhile. Merge
  `runIsolated`'s two stacked JSDoc blocks.
* **v0.35.0 follow-ups — done:** the TIOCSTI half judged by `dev.tty.legacy_tiocsti` (a named
  NOT TESTED where it is 0); row 3's kill(0) arm — a sentinel in the caller's process group survives;
  the JSDoc blocks merged.
* **v0.35.0 phase 2 — bwrap (§2a): implemented (unreleased).** Its probe, its runner (the namespace
  creator only, spawned detached) and its name in the table's IMPLEMENTED list. Every row passes on all
  three paths under both creators. Mount propagation is closed for both, and so is the terminal
  Ctrl-C that SIGKILLed the command under bwrap (difference 5). 15 sabotages (DEV_NOTES B1–B15) are all
  caught; `--new-session` is caught only together with the detach. One wired consumer was run through
  a one-consumer `--against-head --scratch` gate pinned to bwrap: PASS, and its log is identical to the
  unshare run apart from the backend.
* **Fifth review of phase 2 (2026-10-12): the early window (§2a difference 6).** The command ran after the
  caller died by an early TERM, and `isolated` could hang. Closed by the teardown and the go-handshake
  on both creators (B16, B17).
* **Residual (fifth review): the harness SIGKILLed during bwrap's setup.** With the handshake the command
  never runs. A leak remains possible in one window: the harness dies between bwrap's own
  `prctl(PR_SET_PDEATHSIG)` and its child_wait_fd write, a few syscalls. That would leave bwrap's child
  blocked in `read`, as a pid-namespace init holding the caller's stdio, and nothing in it can be
  signalled except by SIGKILL. *Measured:* 160 harness SIGKILLs spread over the setup window gave
  0 runs, 0 hangs and 0 leaks.
* **v0.35.0 phase 3 — docker (§3b): design approved (2026-10-13) with rulings: `/dev/core` accepted with a read-back; `; cgroup2: nsdelegate` omitted under docker; generation stays 9; a tool survey; acceptance per consumer on the policy-blocked host; a bounded reaper; a refusal of symlinked bind sources.**
  **Implemented (unreleased):**
  * the probe, the runner, the inner half's read-backs, the reaper, nested in place, and the image verb;
  * rows 1–12 and 12b judged on all three paths by `isolation-docker-table.test.js`, the deviations
    asserted as deviations, plus 17 unit arms;
  * 11 sabotages (DEV_NOTES D1–D11), all caught. Three of them first exposed a vacuous or missing arm
    (D1, D4, D11), each fixed.
  Measured on one policy-blocked host only. Consumer acceptance there is pending.
* **Residual (phase 3): `kill -9 -1` as the user.** It kills the docker backend's reaper with everything else, so a container may outlive it. Named; no layer closes it.
