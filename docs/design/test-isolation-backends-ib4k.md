---
id: ib4k
title: "Isolation backends — one contract, unshare → bwrap → docker → refuse"
category: test
created: "2026-10-07"
updated: "2026-10-11"
status: draft
tags: [isolation, sandbox, unshare, bubblewrap, docker, apparmor, mutation-arms, gate, portability]
tech:
  - name: "util-linux unshare"
    version: ">=2.38"
  - name: "bubblewrap"
    version: ">=0.11 (measured: 0.11.2 only)"
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
  termios-settable — a residual, §6, as under `bwrap --new-session`); the fresh path's pid 1 and inner half keep it, holding capabilities the command
  cannot trace. Signals: a terminal's Ctrl-C reaches the caller's group, `isolated` forwards it down
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
`not implemented yet (v0.35.0)`. Since v0.35.0, bwrap has its probe and runner (§2a); `docker` still
answers that until phase 3, so a pin to it is refused, and a host where neither namespace backend can
run is refused naming all three. An unknown pin is refused by rule (its value is not
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
| `--die-with-parent` | `--kill-child` | the namespace dies with bwrap — and with bwrap's PARENT, the harness (stronger: a harness killed under unshare leaves unshare running). ⛔ NOT enough in the early window: bwrap's child sets it only just before it execs (difference 6) |
| `--new-session` | (none) | the privileged halves hold no controlling terminal either. Under unshare they keep it (12b: "ancestors with a tty 2, capless 0"); under bwrap, 0. A strengthening, not a row: the shared chain's setsid carries 12b on both. ⚠ Since bwrap is spawned `detached` (difference 5) this flag is a SECOND layer: either one alone keeps the bwrap-only arm green, both gone turn it red (measured) |

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
2. **`nodev`** — `--dev-bind`, above.
3. **The session** — `--new-session`, above.
4. **NoNewPrivs** is already 1 in the inner half (bwrap always sets it). Harmless: `mount`,
   `hostname`, `keyctl`, `ip` and `setpriv` need no new privileges.
5. ⛔ **A terminal's signals.** `unshare --fork` ignores SIGINT and blocks SIGTERM; bwrap does
   neither. A group Ctrl-C reached the bwrap process, which died by it, and `--die-with-parent` then
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
   ⇒ bwrap is exec'd through `env --ignore-signal=TERM,INT,HUP,QUIT` (`BWRAP_SHIELDED`).
   *Measured:* bwrap installs no handler of its own that would undo this; in /proc its SigIgn has the
   four and its SigCgt is 0. Its child inherits the ignore. A non-interactive bash cannot trap a signal
   that was ignored when it started (*measured:* `trap … TERM` was then silently a no-op), and the
   command would inherit the ignore too. So pid 1's bash is exec'd through `env
   --default-signal=TERM,INT,HUP,QUIT`, and the probe reads back that pid 1 can trap all four (probe step 6).
   An `env` without those options (GNU coreutils < 8.31) is refused by name: bwrap never runs with the
   command's signals ignored.
   ⚠ bash ignores QUIT for itself (SigIgn 0x4 even after the reset) and still traps it. So the
   read-back is "SigCgt has all four after `trap`", not "SigIgn is clear".
   *Arms, on both creators:* a TERM to the harness, its creator and every descendant at once → the
   trap completes (CLEANED), rc 7; a TERM to the creator alone → the command runs to its own end.

**The probe** is side-effect free, and each step is a NAMED reason:

1. `bwrap` from the system dirs only. Otherwise: `bwrap: not installed (no bwrap in /usr/sbin,
   /usr/bin, /sbin, /bin)`.
2. **Not setuid** (S_ISUID on the resolved file), refused by rule before it is ever run: `bwrap:
   setuid — …`. A setuid bwrap is what a host installs when unprivileged user namespaces are off.
   Under it the inner half could not mask: bwrap's source refuses `--cap-add` to a non-root caller
   in setuid mode (*not measured here*: this host has no setuid bwrap). The command could not make a
   nested user namespace either, which row 7's control, the drop and the nested path all need. And
   bwrap ≥ 0.11 builds without setuid support by default (*measured*: the 0.11.2 binary here
   carries "setuid use of bubblewrap is not supported in this build"). `isolated` never executes a
   setuid binary as part of its chain.
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
`HARNESS_GENERATION` stays **7**: no verdict changes meaning. A host that refused before may now run
with `backend: bwrap` named.

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
* **v0.35.0 phase 3 — docker (§3, §3a):** not started.
