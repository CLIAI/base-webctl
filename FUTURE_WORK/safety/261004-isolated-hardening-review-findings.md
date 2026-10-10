# isolated-hardening @4285c61 — review findings to fix before v0.33.0

> **STATUS 2026-10-10: fixes DONE on `isolated-hardening`** (62b830b env allowlist + `bash
> --norc -p`; 56cbbb0 early-signal window; 65bb06c AppArmor / `WEBCTL_UNSHARE_BIN`; d10716b
> whole home hidden + `--keep-ro`; f51aa66 stripped markers + version skew; ec0739c). Every
> numbered finding 1–8 and every ruling is implemented, armed, mutation-checked and in the
> CHANGELOG. **A second review (of 5773fb8, below) is also fixed.** **Still open:** finding 9
> (`/var/tmp`, `/dev/shm`, `/sys/class/net` — "does NOT cover", planned for v0.34.0), and the
> release steps under **Then** below (integrate, bump, gate both
> registries, tag, tell `perplexity` and `webctl:mgr`). Delete this note when those are done.

## Second review, of 5773fb8 (2026-10-10): Ship-with-fixes — status

Probes kept outside the repo. All fixed on `isolated-hardening` with a failing arm first, a
control, and sabotages logged in `scripts/contract-harness.mjs.DEV_NOTES.md`:

* **1 DONE (6d30097)** — NODE_OPTIONS / passed LD_* reached the privileged halves (a preload ran
  in the inner node, CapEff full). Privileged halves get `PRIVILEGED_PASS_ENV` only; the
  command's env travels in a pipe to the `__isolated-pid1` helper (now on the fresh path too).
* **2 DONE (137838b)** — the verdict listed every `~/…` PATH re-bind. Now: named paths only,
  PATH entries counted, `WEBCTL_ISOLATED_VERBOSE=1` for all. Headline softened (717066a).
* **5 DONE (cc40757)** — forwarders installed before their child, signals buffered. Logic arm;
  the ordering itself is reasoned (cannot be widened from outside; old orders survive).
* **6 DOCUMENTED (717066a)** — PDEATHSIG race: closed by util-linux ≥ 2.39 (pidfd poll after
  the prctl, read in its source); open on 2.38; under "does NOT cover".
* **7 DONE (717066a)** — CHANGELOG line: under the gate a host-exported toggle is absent.
* **8a DONE (18babed)** — nested keep under the outer's hidden home says so (exit 3).
* **8b DONE (83d16e8)** — a cwd at/under a hidden dir is refused; the read-back exempts only
  explicit `--keep`s.
* **Deferred to v0.34.0 (ib4k shared arm set), documented only:** shared session keyring, no UTS
  ns, `/sys/class/net` MACs, `/etc/machine-id`, `/var/tmp` + `/dev/shm` (first review's 9).

## First review (2026-10-04)

Review verdict: **Ship-with-fixes** (code reviewer subagent of the base lane, 2026-10-04).
Paused for a token freeze; resume here. All MEASURED unless marked reasoned.

What holds: hidden-dir reads refused (direct, symlinks from outside home, `..` from a keep,
/proc/N/root); caller fds do not reach the command; a nested `unshare -rm` cannot peel the
hide (locked); reaper exit codes, INT/TERM/HUP, stdin/stdout, argv safety (`-x` → 127,
metacharacters literal); hidden dirs come from the PASSWD home. Suite 739/740 (1 skip).

## Fix before release

1. **pid 1 is `bash -c` → honours the caller's BASH_ENV, SHELLOPTS, exported functions**
   (contract-harness.mjs ~:1509, ~:1572). A BASH_ENV script ran as pid 1 WITH full caps
   before any mask; SHELLOPTS=xtrace traced the reaper; an exported `wait()` replaced it;
   SHELLOPTS=errexit + TERM killed the namespace before the command's trap (rc 143 not 7,
   cleanup skipped). Fix: `bash -p -c` (measured: skips all three for pid 1). One arm per var.
2. **Early-signal window is real, and the comment (~:1237) claims otherwise.** TERM sent the
   moment unshare's child appears: 24/40 runs the command RAN and exited 0 (v0.32.0: 15/40 —
   pre-existing). Fix fresh path: in forwardSignalsPastUnshare, no `started` on fd 3 yet ⇒
   SIGKILL unshare (--kill-child). Nested path: re-send once after ~50 ms, or document.
   Correct the comment and the CHANGELOG ("untested" undersells a lost signal).

## Biggest remaining exposure (pre-existing, outside this diff)

3. **Env CREDENTIALS reach the arm**: 37 vars matching *_API_KEY / *_TOKEN / *SECRET inside
   `isolated` on the operator host; the gate passes the full env. Fix: scrub by pattern, or
   invert to an allowlist + tool prefixes. At minimum list under "does NOT cover".

## Minor

4. Scrub SESSION_MANAGER (embeds the hostname + ICE socket) and ICEAUTHORITY. Reasoned:
   CLIAI_<TOOL>_BROWSER_{SSH_,}TARGET name remote targets.
5. v0.33 nested under a ≤v0.32 outer is refused (exit 2, "WEBCTL_HIDDEN_DIRS is not set"),
   and the message misdiagnoses version skew. Keep failing closed; special-case the message
   (HOST_NETNS set, HIDDEN_DIRS absent ⇒ "upgrade the outer"); CHANGELOG line.
6. CHANGELOG breaking note: indirect readers — git ssh-signing (`gpg.format=ssh`), git/ssh
   reading ~/.ssh/config / known_hosts, gpg. (reasoned)
7. hiddenGaps (~:2050) checks only the top of the stack AT the path; a later mount on an
   ANCESTOR would shadow the hide. No current op does it; a shadow check future-proofs it.
8. Tests to add: a HUP arm; a "peel the hide from a nested `unshare -rm`" arm (docs claim
   "locked (measured)" untested); BASH_ENV/SHELLOPTS arms after #1.
9. Note: /var/tmp and /dev/shm are writable and shared with the host; /sys/class/net lists
   host interface names. Outside this diff.

## Then

Integrate (isolated-hardening → a release branch), bump 0.33.0, `--against-head --scratch`
over the public AND the private registry (~/.config/webctl/gate-consumers.private.jsonc),
tag only on green. Tell perplexity and webctl:mgr.

## Rulings (webctl:mgr, 2026-10-07) — v0.33.0 scope

* (a) HIDE the whole passwd home (tmpfs over it). Re-bind READ-ONLY: base's repo root, node,
  the absolute command, every PATH entry under the home. WRITABLE: cwd + each --keep.
  1. A PATH entry is NEVER re-bound if it is the home itself, or contains / lies inside a
     hidden dir (~/.ssh, ~/.gnupg, CLIAI roots, ~/.config/webctl): refuse with a message.
  2. Generic `--keep-ro <path>` (e.g. uv's managed python under ~/.local/share/uv/python).
  3. The verdict lists the re-bound paths.
* (b) `bash -p` reaping pid 1 — agreed.
* (c) ENV ALLOWLIST (CLIAI_* NOT passed by default), `--pass-env NAME|PREFIX_*`; BREAKING:
  the CHANGELOG lists every default-passed name and the syntax. mgr's pre-check: chatgpt
  (CGWC_*, CLIAI_CHATGPT_WEBCTL_TESTS_HOST_NETWORK), substack (SUBSTACK_WEBCTL_TESTS_HOST_PID),
  perplexity (FIXTURE_PARENT_NETNS), aliexpress (ALIEXPRESS_WEBCTL_ARM_REAL_HARNESS) must
  declare theirs.
* Host policy (an Ubuntu 24.04 host): kernel.apparmor_restrict_unprivileged_userns=1 ⇒ uid_map
  EPERM. (1) A refusal that NAMES the sysctl and the fix (a host-policy fault, not a lane
  fault). (2) WEBCTL_UNSHARE_BIN (absolute path to an executable) so a host can grant userns
  to one dedicated binary via an AppArmor profile.
