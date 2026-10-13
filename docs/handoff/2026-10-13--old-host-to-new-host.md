# Handoff 2026-10-13 — `webctl:base` moves to its replica host

The owner ordered this lane relocated today. Its copy on the old host goes on
standby, and the replica on the new host continues from here. **Read this first.**

⛔ base is PUBLIC, so this file names hosts by ROLE, never by name:

* **the old host** has unprivileged user namespaces, so `unshare` and `bwrap` work;
* **the new host** blocks user namespaces by policy, so only the docker backend
  can isolate there.

The details a public file must not carry are in a private note on the new host.
The new host's lane already has its path, from its adm.

## 1. State at handoff

Every line of work is pushed. Nothing lives only in a pane, a `/tmp` worktree or
a machine-local memory.

| branch / tag | head | state |
|---|---|---|
| `master` | see `git log` | v0.34.1, plus the "no window on a real display" rule in AGENTS.md |
| tag `v0.34.1` | `b93f4d1` | released; gated on both registries |
| `claim/xpra-owner-channels` | `b97387d` | v0.34.2 (owner-only browser channels, gvlx + 6gi0), review rounds 1 and 2 fixed |
| `release/v0.34.2` | `17fe728` | `b97387d` + the gate stdin fix (below) |
| `release/v0.34.2-fix3` | `6e4898d` | `17fe728` + review round 3 (8 commits). **Reviewed: SHIP.** This is the v0.34.2 candidate. |
| `isolation-backends-v035` | `24affa8` | v0.35.0 base: bwrap backend, signal hardening, HARNESS_GENERATION 9, CHANGELOG "unreleased" |
| `claim/docker-backend` | `3684b3c` | the docker backend (ib4k §3b), on top of v035; paused until v0.34.2 is tagged |
| `xpra-local-auth` | `019015a` | frozen record of the first xpra handoff; do not build on it |

Every commit on the two `claim/` branches carries the owner's normal identity.
They were rewritten today to remove a machine alias from the author metadata,
with the trees unchanged. The old ids may stay reachable on GitHub for a while,
and whether to ask GitHub to purge them is an open question for the owner (§4).

### The gate stdin fix (`17fe728`)

`scripts/test-all-consumers.sh` fed its registry rows to its loop on stdin, and
every consumer's test inherited that stdin. A contract that read stdin swallowed
the rows after it, and the summary covered only the lanes reached. The registry
is now read on fd 3, the loop's stdin is `/dev/null`, and the gate is BLOCKED
when it reaches fewer lanes than are registered. Arm:
`test/gate-registry-stdin.test.js`, red on the old gate (3/3), green after.

### Verification done on the old host

* The full suite at `17fe728`, with no display variables and no integration
  images: **347 passed and 1 FAILED** when this was written, and the run had not
  finished. It ran on one CPU at a load average near 70. The failure is the
  isolation arm "a host process this test started → kill(pid, 0) is ESRCH
  inside, and /proc does not list it", after 167 s. v0.34.2 does not touch
  `scripts/contract-harness.mjs`, and v0.34.1 passed this arm, so a timeout under
  load is the likely cause. **But it is unconfirmed: a red arm is red until a
  re-run proves otherwise.** It needs user namespaces, so it can only be re-run
  on the old host or in a VM (open question 1).
* Review round 3 (`17fe728..6e4898d`): 137/137 of the touched unit files pass,
  and `tsc` 5.9.3 is clean. The implementer ran 193/193 across ten unit files.
* Not yet run on `6e4898d`: the full suite, and the gate.

## 2. Next steps, in order

1. **v0.34.2 follow-ups from review 3**, all LOW. Fix them, or list them under
   "What this does NOT cover":
   * F1: a more specific mount shadows a judged dir. `bindSrc` matches only
     `Destination === /run/webctl-secret` (and the same for `/run/webctl`).
     A file bind at `/run/webctl-secret/xpra.pass` from an unsealed source
     still reads owner-only. Fix: any mount whose Destination lies under either
     dir, other than the dir itself → `unknown`.
   * F2: `chromium-docker-xpra.js` ~1639 sets `relayGone = true` even when the
     relay had already vanished, so the message claims a removal that did not
     happen. Wording only.
   * F3: name the test guard's remaining edges in the limits: `--network host`
     plus an image-level `DISPLAY` (the abstract X socket); global flags before
     the subcommand (`docker --context x volume create …`); relative `-v ./:/x`
     sources; an Xauthority file bound from outside the home and `/run/user`.
2. **Gate and tag v0.34.2**, on the final head: the full suite, then
   `./scripts/test-all-consumers.sh --against-head --scratch` twice: once on the
   public registry, and once with `WEBCTL_CONSUMERS_FILE` pointing at the
   private registry. Tag only on green at that exact commit, then fast-forward
   `master`.
   ⚠ **The gate needs an isolation backend, and v0.34.x has only `unshare`.**
   On the new host it will refuse every lane as a GATE-ENVIRONMENT fault, which
   is correct behaviour and not a lane failure. So v0.34.2 is gated on a host
   with user namespaces, in a VM, or after the docker backend lands. That choice
   is the owner's, and it is open question 1.
3. **Send the tag to `webctl:mgr`**, which drafts the lanes' bump-and-restart.
4. **Resume the docker backend** (`claim/docker-backend`):
   * the PID1_REAPER race found today. A TERM between the fork and `c=$!` makes
     the reaper exit 143 without forwarding, and the child's status is lost.
     This is the BURST flake. The reaper is shared, so fix it on
     `isolation-backends-v035` for all backends, with an arm;
   * machine-name data passed in through `WEBCTL_MACHINE_NAMES_FILE`, with base
     owning the no-host-literals check;
   * the arm table skips by name on userns-blocked hosts;
   * read-back parity on docker's nested path.
5. **Acceptance runs** for the relocating lanes under the docker backend: fresh
   clones from GitHub in a scratch dir, a private registry (mode 600, outside
   any repo), never a live tree. The lane list is in the private note. A lane
   that fails is NAMED in the release with its reason.
6. **v0.35.0**: a final review, then merge `claim/docker-backend` into
   `isolation-backends-v035`, then the gate, then the tag (generation 9), then
   tell `webctl:mgr` for the single relocation wake the owner chose.
7. **Later:**
   * eg7p step 2, including xq's gaps: non-proxy apps fail closed, WebRTC/QUIC
     must fail, the Firecrawl question, and xpra on the egress network;
   * the joint unix entrypoint contract with xq, which replaces the socat
     sidecar;
   * adopting ubertmux's scoped runner for the isolation tests, after the arm
     table passes inside a scope.

## 3. Rules this lane runs under (beyond AGENTS.md)

* **Subagent-driven development.** Every subagent is told its identity,
  `(webctl:base/subagent)`, and is shut down as soon as its result is in.
  Subagents are tmux panes, so keep few.
* **GUI**: no test or agent ever puts a window on a real display (AGENTS.md).
  xpra development and testing happen only on the new host, inside a private
  Xvfb or a container.
* **Docker**: never prune. Remove only by exact name or id. Use owner-prefixed
  names, no publish beyond loopback, never `--privileged`, never an unconfined
  seccomp profile, never a docker socket mount. Respect the host admin's
  container allowance.
* **Processes**: never blanket-kill. `pgrep -u "$USER" -f` first, SIGTERM before
  SIGKILL, kill by exact pid. A message does not stop a subagent's running tool
  call; its processes do stop by pid.
* **Never** restart or connect to a signed-in browser. Tests never touch the
  real home, the real `~/.ssh` or the real cgroup tree.
* A host admin's guard or STOP file is respected, never worked around.
* Cross-host `jdsend` messages over about 600 bytes do not deliver. Copy the
  text to the recipient host and send a short pointer instead.

## 4. Open questions for the owner

1. **Where v0.34.2 is gated**, given the new host has no user namespaces:
   wake the old host's copy for the gate only, use a VM, or wait for the docker
   backend (v0.35.0).
2. **Whether the new host's lane may tag** releases at all.
3. **The old public commit ids** that carried a machine alias in their author
   metadata: ask GitHub to purge them, or leave them.
4. The earlier review note on a cgroup breach in the isolation arms (ib-review3).
5. **A host firewall stopgap** that matches by socket owner and also covers the
   docker bridge subnets: defence in depth for the owner-only channels before
   Phase 2 makes them the default.
6. **The new host's umask 0002**: it keeps creating group-writable files under
   the state root, which owner-only mode refuses. The host admin says this is
   the owner's call.
7. A non-webctl container on the old host that listens on all interfaces.

## 5. What must NOT move

* **No credentials, cookies, session state or tokens**, ever, in any direction.
  Nothing of the kind is in this repo or in the handoff.
* **The private gate registry** (`~/.config/webctl/gate-consumers.private.jsonc`,
  mode 600). It holds lane names and the old host's paths. Build a fresh one on
  the new host with that host's paths. Never commit it.
* **Browser profiles and signed-in browsers** stay where they run. Lanes move
  their own; base does not.
* **The gate logs** (`~/.local/state/webctl-base/gate-logs/`) are host-local
  evidence for the tags already cut. They stay on the old host; the new host
  starts its own.
* **Machine-local agent memory** stays behind. Its durable lessons are already
  in AGENTS.md: the real-display rule, and stopping a subagent by pid.
