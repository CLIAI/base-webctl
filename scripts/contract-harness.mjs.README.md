# `contract-harness.mjs` — the checks every contract was copying

A consumer's `test-against-base.sh` calls this instead of reimplementing the
checks that have rotted in three lanes at three different ages.

```sh
node "$BASE_DIR/scripts/contract-harness.mjs" generation
node "$BASE_DIR/scripts/contract-harness.mjs" pin         --repo . --sub vendor/base-webctl
node "$BASE_DIR/scripts/contract-harness.mjs" no-revendor --repo . --sub vendor/base-webctl --lib lib
```

**Exit:** `0` pass · `1` fail · `2` **no verdict** (reason is the last line) ·
`3` usage.

⇒ **The harness owns the exit code.** A contract never re-implements
`[ "$rc" = "2" ] && { … }`, which as an arm's last statement returns 1 under
`set -e` and turns a *green* suite red.

## Why a library

**A defective contract reports green.** Every other duplication in this family
fails loudly; this one fails by reassuring us. Three defects, three lanes, three
ages — and two of the three were found by someone looking *across* copies rather
than by any lane reading its own.

## The checks

`require-generation`, `pin`, `no-revendor` and `generation` are for your contract;
`gate-probe` is for the release gate (see below); `isolated`, `isolation-check`,
`sandbox-port` and `guard-live-port` are for your **mutation arms** (see *no host network and no host unix sockets* below).

## ⛔ LOAD-BEARING: the checker lives INSIDE the thing it checks

The harness is `vendor/base-webctl/scripts/contract-harness.mjs` — **inside the
submodule.** So drifting a lane to an **older** base also **downgrades the checker**
meant to catch that drift. *Measured by `substack`:* its first drift control reported
`"generation":2` PASS, because the drift had replaced generation 3 with generation 2.

⇒ **Every fix in a newer harness protects only a contract that ENFORCES a floor.**
Recording `CONTRACT_HARNESS_GENERATION` in a comment is not enforcing it. Put this
first in your contract, and treat **any** non-zero as FAIL:

```bash
node "$H" require-generation 6 || { echo "FAIL: base harness below generation 6 (downgraded submodule?)"; exit 1; }
```

* ⭐ **Why a VERB, not `generation --min N`.** Measured: every harness before
  generation 4 **ignores unknown flags** — generation 2 answers `generation --min 3` with
  "generation 2", exit 0. A floor spelled as a flag **fails open on exactly the
  downgraded harness it exists to catch.** An unknown **verb** exits 3 on every older
  harness, so `require-generation` fails **closed** even where it does not exist.
  Generation 4+ refuses `generation <args>` so nobody adopts the flag form.
* ⚠ **Base cannot make you call it.** Base's code is what gets downgraded; only your
  contract, which lives in your repo, survives. ⇒ Prove it with a **downgrade arm**.

**Reference arms** (`substack`'s `test/pin-drift-test.js`, the shape every lane proves):

| arm | set-up | expected |
|---|---|---|
| control | worktree = gitlink = a tag | PASS |
| same-generation drift | worktree moved to another commit of the same generation | FAIL — `pin` DRIFT |
| ⛔ **downgrade drift** | worktree moved to an **older** base whose harness is a lower generation | FAIL — **`require-generation`**, because the old `pin` cannot see it |
| undeclared | a checkout with no committed gitlink | FAIL — `pin` UNDECLARED |
| swap signal | `WEBCTL_DECLARED_PIN` set, `WEBCTL_GATE_SWAPPED=0`, drift | FAIL — DRIFT (see below) |

### `pin`

Asserts the pin is an exact tag, read from the **committed gitlink** — not the
submodule worktree. Those differ exactly when the release gate has swapped the
submodule, which is when a contract is most likely to report a tag its own repo
does not declare.

⛔ **`WEBCTL_DECLARED_PIN` COMES FROM THE GATE PROCESS, NOT FROM YOUR PIN.** It
is set in your contract's environment at runtime by `test-all-consumers.sh`
before it swaps your submodule. ⇒ **A lane on any pin, however old, receives
it** — there is no version in which "my base does not export it yet" is a
reason to skip it. *(One lane deferred exactly on those grounds, which is the
likeliest reason the correct key was used zero times in four attempts.)*

⛔ **THE ONLY SWAP SIGNAL IS `WEBCTL_GATE_SWAPPED=1`. `WEBCTL_DECLARED_PIN` is a
declaration, not a swap.** Since v0.24 the gate sets the declared pin on **every**
run, swapped or not. A carve-out keyed on "DECLARED_PIN is set" — or, as base's own
generation 3 did, on "DECLARED_PIN ≠ worktree" — **passes real drift under the gate**:
`fetlife` measured it in its contract, and base then measured the same defect in its
own harness (`SWAPPED=0` + drift ⇒ *"the release gate has swapped this submodule"*, NO
VERDICT — a false sentence). Fixed in generation 4. *(Keyings so far: `WEBCTL_BASE_DIR`,
then `DECLARED_PIN`, then declared ≠ worktree; the fifth asks the one party that knows
— the swapper.)*

⚠ **A test that scrubs the gate's variables must scrub ALL of them** —
`WEBCTL_GATE_SWAPPED`, `WEBCTL_DECLARED_PIN` and `WEBCTL_BASE_DIR`. Scrubbing the
declared pin but not the swap flag leaks `SWAPPED=1` into a local fixture under the
gate (measured in a lane at the v0.26.0 candidate: its control arm went NO VERDICT).
`pin` names that state *INCONSISTENT gate signal* rather than calling it a swap.

Under a real swap the check returns **no verdict**, never a fail: a candidate is
not yet tagged, and failing there is a vacuous RED. *A gate that always blocks gets
overridden.*

### `no-revendor`

⚠ **GENERATION 2 CHANGED WHAT `pass` MEANS HERE.** Generation 1 read only the TOP
LEVEL of both trees and matched only IDENTICAL FILENAMES. Since **half of base's own
lib is nested**, that check could not see most of the library: three planted
re-vendors (a nested module copied flat, a copy into a subdirectory under a new
name, and a rename in place) all reported `pass`. ⇒ Generation 2 walks both trees
**recursively** and matches by **normalised content** as well as by name, so a copy
is caught under any name in any directory, and after reformatting or re-commenting.

⛔ **GENERATION 5 CHANGED IT AGAIN — the name match found copies and then excused
them.** Generation 4 cleared any same-named file that imported *anything* from base's
lib. An edited copy of a base module imports that module's **siblings**, as the
original does, so the realistic re-vendor was exactly the case the excuse fired on
(`substack`: a stale `lib/cdp-client.js` requiring base's `cdp-rewrite.js` reported
PASS). **The rule now:**

* A local file whose **basename** equals that of any base module — at any depth on
  either side; directory position is ignored, so moving a copy does not hide it — is
  a **FAIL**,
* **unless** its code imports, requires or re-exports **that same base module**: a
  relative or absolute specifier resolving to a base module of the same basename. A
  sibling module does not count — it is what a copy imports too.
* **or** it **defines nothing** (no `function`, `class`, `=>` or method shorthand)
  and either re-exports through base's **`lib/index.js`** (base's own rule: consumers
  import only the barrel — `module.exports = require('…/lib/index.js').cdpClient`),
  or is a local **`index.js`** whose every specifier is a relative path **outside** the
  submodule (the consumer's own barrel). Importing the barrel **and** defining code is
  judged by the main rule: the barrel reaches every sibling.
* Specifiers are read from **tokens**, not text: only a string in a module-syntax
  position counts (`… from '<s>'` in an import/export clause, `import '<s>'`,
  `import('<s>')`, `require('<s>')`). Text in a line, trailing or block comment, or
  inside another string or template, never counts.
* "Defines nothing" means no `function`, `class`, `=>`, no `( … ) {` other than an
  `if/for/while/switch/catch/with` head (so method shorthand under any key form), and
  no string-to-code route (`eval`, `Function`, `constructor`, `vm.*`, a `data:` or
  computed `import()`).
* ⛔ **An AMBIGUOUS file gets no exception.** Where tokens cannot decide how a `/` reads
  (after a `}`, or after `of`/`yield`/`await`) or whether `<!--` / a line-leading `-->`
  is a comment (it is in CommonJS, not in an ES module), the file is lexed **both
  ways**. If the readings disagree on what it imports, defines or contains, a
  same-named file FAILs, naming the line — make it read one way (e.g. assign the regex
  to a variable first). Any reading's hash matching base is a copy. A file not named
  like a base module still PASSes, and the reason names it.
* Bare specifiers (package names, import maps) are not resolved, so they do not
  excuse a file: fails **closed**, naming it.
* A same-named file that is an **unrelated** module (base has generic names:
  `registry.js`, `mounts.js`, …) also FAILs; the message says to **rename it**.

Measured 2026-10-03 across every locally present consumer: all same-named shims
(bare re-exports, factories bound to local constants, wrappers that add functions)
import their own base module and stay green; the only reds are two local
`cdp-client.js` copies.

⛔ **What it still does NOT catch:** a copy that was **edited** and **renamed**
(whole-file hashing cannot see it), and a same-named file that imports its base
module is treated as a wrapper however much else it defines. The PASS reason says
both explicitly rather than leaving an impression of coverage. Also OPEN, but only for
a file written to evade: a locally shadowed `require`, an unreachable import
(`if (false) require('<same module>')` still counts as importing it), and code built
from a string by a route the lexer does not name. The full table, with the direction each limit fails,
is in DEV_NOTES ("the lexer failed OPEN").


Asserts no local file shadows a base module. **Asserts code, never prose** — a
small zero-dependency lexer separates comments, strings and templates from code,
because the check this replaces grepped for the vendor path and matched the string
inside the shim's own comment (and the first fix stripped only WHOLE-LINE comments,
so a trailing comment or a string literal still satisfied it).

⚠ Examining **zero** files FAILS. "No re-vendoring found" over nothing is the
shape that let the original grep pass.

### `generation`

⚠ **Now 6.** History, each a change in what a verdict MEANS:

* **2** — `no-revendor` sees copies in subdirectories and under new names.
* **3** — `pin` FAILS on drift and on an undeclared submodule; only a mode-160000
  entry is a gitlink (`substack`).
* **4** — the swap carve-out keys on `WEBCTL_GATE_SWAPPED=1` only (`fetlife`);
  `require-generation` added; `generation` refuses arguments.
* **5** — `no-revendor`: a file named like a base module is a shim only if it imports
  **that** module; importing a sibling no longer excuses an edited copy (`substack`).
  ⚠ Lanes that were green on 4 with a same-named copy go **red** — that is the fix.
* **6** (v0.33.0) — `isolated` changed behaviour: the env is an **allowlist** (`--pass-env`,
  which generation 5 refuses as an unknown option), the passwd home is **hidden**, privileged
  tools come from the system dirs only. Key `--pass-env` on `require-generation 6` to stay green
  on both pins (CHANGELOG v0.33.0).

A sweep asks *"who is below 6?"* — and, since generation 4, *"whose contract does not
call `require-generation`?"*, because a recorded number nobody checks protects nothing.

### `require-generation <N>`

Exit 0 when this harness is generation ≥ N (with a note on stderr when above, so a
stale floor is visible), **1 when below**, 3 for a bad N — and **3 on every harness
older than generation 4**, which does not know the verb. ⇒ **ANY non-zero = FAIL.**


Prints `HARNESS_GENERATION`. A consumer records the generation it was written
against, so a sweep asks **"who is below N?"** instead of "who differs?" —
because rot and legitimate per-lane customisation look identical in a diff.

⚠ **A generation marker is not sufficient on its own.** It says an old copy
carries old rot. It does *not* say a **correct** copy's assumptions have expired
against a newer pin. Two mechanisms.

See `.DEV_NOTES.md`.

### `gate-probe` — for the GATE, not for your contract

```sh
node <base>/scripts/contract-harness.mjs gate-probe --repo . --sub vendor/base-webctl
```

⚠ **A lane does not call this.** The release gate calls it, inside the window
where it has swapped a consumer's submodule to a release candidate, and it
asserts that `pin` **declines a verdict** there — because a candidate is not
tagged. Run by hand it always returns **no verdict** (exit 2), never pass: there
is no swap window, so there is nothing to assert.

| state | result |
|---|---|
| `WEBCTL_GATE_SWAPPED` unset | **no verdict** — not exercised, and not a pass |
| gate reports a swap, no `WEBCTL_DECLARED_PIN` | **fail** — the state that variable exists to prevent |
| gate reports a swap, `pin` declines and names both SHAs | **pass** |
| gate reports a swap, `pin` returns PASS or FAIL | **fail** — base's defect, not the consumer's |

⇒ Its precondition comes from **`WEBCTL_GATE_SWAPPED`, set by the gate**, and
deliberately not from comparing the declared pin against the worktree — which is
the comparison it is testing. A guard and a claim that read the same input cannot
disagree.

## ⛔ Mutation arms run with no host network, no host unix sockets, a HIDDEN home and an env ALLOWLIST — `isolated`, `isolation-check`, `sandbox-port`, `guard-live-port`

*Incident, 2026-10-02 (a consumer lane's mutation control):* the mutant planted "the
default port is a location", the arm **attached to the real signed-in browser on the
host's loopback**, closed its last tab, and Chromium exited. Correct code refuses; **a
mutant does not refuse — that is what makes it a mutant.** The sandboxes isolated HOME,
CWD, env and PATH. Not the network. Spec: xrl4, *"Mutation arms run with no host network, no host unix sockets and a hidden home"*.

*A second incident* followed: a lane's mutation control navigated a real signed-in
browser's only tab. **A port pin cannot stop a mutant that restores a LITERAL port** —
so the namespace is THE mechanism, and everything else is second.

⇒ **The order, plainly:**

1. **Every runner-spawning mutation arm runs under `isolated`.**
2. **`isolation-check <your real default port(s)>`, run under `isolated`, is its
   precondition** — *"my real default port is unreachable from in here; my own fake is
   reachable."*
3. **`guard-live-port` is the fallback ONLY where unshare is unavailable** — and it is
   second because it **cannot stop a literal port**: it guards the port you name, not the
   one a mutant hardcodes.

```bash
H="$BASE_DIR/scripts/contract-harness.mjs"

# precondition: real default port(s) refused INSIDE, own control listener reachable
node "$H" isolated -- node "$H" isolation-check 4327 4527 || exit 1

# a port with nothing behind it; every port DERIVED from it is dead too
export MYLANE_PORT="$(node "$H" sandbox-port --bare)" || exit 1

# each mutation arm: the runner sees its OWN loopback only — the host's browser does not exist
node "$H" isolated -- node test/my-mutation-arm.js
```

⛔ **A lane that falls back to the HOST network when unshare is unavailable is NOT
COMPLIANT.** `isolated` fails closed; a contract must not wrap it in "warn and run
anyway" (`isolated … || run-it-anyway`). `guard-live-port` is the **only** sanctioned
fallback, and it does not make an arm safe against a literal port — say so in the
contract's output when it is used.

| verb | does | exit |
|---|---|---|
| `isolated [--keep <path>]… [--keep-ro <path>]… [--pass-env <NAME\|PREFIX_*>]… -- <cmd> [args…]` | runs `<cmd>` in private user+network+mount+**PID** namespaces (`unshare -rnm --pid --fork --mount-proc`) — no host process can be seen or signalled, and everything the arm started dies with it: the ONLY interface is its own `lo`, brought up first so local fakes/stubs work; `/run`, `/tmp`, `/var/tmp`, `/dev/shm` (and a real `/var/run`) are a fresh tmpfs, so the host's unix sockets — docker, X11, ssh-agent, session bus — are gone. The **passwd home is HIDDEN, whole** (an empty read-only tmpfs); re-bound on top **read-only**: base's repo root, node, an absolute `<cmd>`, `WEBCTL_UNSHARE_BIN`, **every PATH entry under the home**, each `--keep-ro`; **writable**: the cwd, a `$HOME` under `/tmp`, each `--keep`. `~/.ssh`, `~/.gnupg`, `~/.cache/CLIAI`, `~/.config/CLIAI`, `~/.local/state/CLIAI` and `~/.config/webctl` stay hidden under any re-bind that contains them. **pid 1 is `bash --norc -p`, and reaps orphans.** Caller's cwd and stdio; the **env is an ALLOWLIST** — `PATH HOME USER LOGNAME SHELL LANG LC_* TERM TZ NODE_OPTIONS NODE_PATH npm_config_* WEBCTL_*` plus each `--pass-env`, never `DISPLAY`/`WAYLAND_DISPLAY`/`SSH_AUTH_SOCK`/`DBUS_SESSION_BUS_ADDRESS`/`DOCKER_HOST`/`XDG_RUNTIME_DIR`, `XDG_{CACHE,CONFIG,STATE,DATA}_HOME`, `TMUX`/`TMUX_PANE`/`XAUTHORITY`/`SSH_AGENT_PID`/`DOCKER_CONTEXT`, `SSH_{CONNECTION,CLIENT,TTY}`; `TMPDIR=/tmp`; argv as an array (no shell). One stderr verdict line: `isolated: home HIDDEN; re-bound read-only: …; writable: …` — paths only for what you named (cwd, `--keep`, `--keep-ro`), PATH entries COUNTED; `WEBCTL_ISOLATED_VERBOSE=1` lists every path. | the command's exit code; **1** (FAIL, with a JSONL `"check":"isolated"` record) when isolation could not be established — **the command is then not started**; a signal before it started: **dies by that signal** |
| `isolation-check <port>…` | run INSIDE `isolated`. Each named port: a connect to `127.0.0.1:<port>` must fail with **exactly `ECONNREFUSED`** (lo up, nothing listening) — `ENETUNREACH` means the loopback is DOWN and is a FAIL. A control listener it opens on the namespace loopback must be reachable. The kernel proof below must hold. | 0 pass · 1 fail, naming every condition that failed · 3 usage |
| `sandbox-port [--bare]` | binds `127.0.0.1:0`, reads the port, closes it, **asserts a connect is refused**, prints it (JSONL + human line; `--bare` = the number only, for `$(…)`) | 0 |
| `guard-live-port <port> [--pin-verified]` | defence in depth where `isolated` is not used: **REFUSES** when `127.0.0.1:<port>` listens **or** answers CDP (`GET /json/version` 200), naming both facts, unless `--pin-verified` | 0 pass · 1 refused · 3 usage |

* ⭐ **Every refusal is ONE tagged line**: `FAIL  isolated: NOT RUN…` on stderr plus a JSONL
  `"check":"isolated","result":"fail"` record — usage refusals included (`NOT RUN (usage): …`,
  still exit **3**). Grep `^(FAIL|NO VERDICT) +isolated: ` and you have the reason. *(Usage
  refusals used to be a bare `isolated: …` line; the gate's grep missed them and blamed
  unshare / user namespaces.)*
* ⭐ **The BACKEND (v0.34.0, `ib4k` §2).** `isolated` probes **unshare → bwrap → docker** and uses
  the first that can run; none → refused, naming each and why (`NOT RUN: no isolation backend can
  be used here — unshare: <reason>; bwrap: …; docker: …`). **`WEBCTL_ISOLATION_BACKEND=<name>`**
  pins one — unavailable is a refusal, never a fallback. ⚠ Phase 1: only **unshare** is
  implemented; bwrap and docker answer `not implemented yet (v0.34 phase 2/3)`. The verdict line
  ends `; backend: unshare`; a refusal's JSONL record carries `"backend"` and `"skipped"`. The one
  arm table every backend must pass: `test/isolation-arm-table.test.js`.
* ⛔ **Private scratch, keyring and identity (v0.34.0, `ib4k` §1a).** `/var/tmp` and `/dev/shm` get
  a fresh tmpfs like `/tmp` (a `--keep` beneath one is re-bound; a keep that IS one is usage 3).
  pid 1 runs `keyctl new_session`: the command gets a FRESH session keyring (read back; keyctl not
  installed → it runs, the verdict says `keyring: shared (keyctl not installed)`). The hostname is
  **`webctl-isolated`** (a UTS namespace; set with the system `hostname` tool — without it the
  verdict says `hostname: the host's`), `/sys/class/net` lists only `lo` (a fresh sysfs; the cgroup
  tree carried back), and `/etc/machine-id` / `/etc/hostname` are neutral (`NEUTRAL_MACHINE_ID`;
  systemd-id128 and dbus-uuidgen keep working). All read back before the command starts; a nested
  call under a v0.33 outer is refused saying "upgrade the outer". *Not hidden:* `/etc/hosts`,
  boot_id, DMI strings.
* ⛔ **`isolated` fails CLOSED.** No `unshare`, unprivileged user namespaces disabled (or refused
  by AppArmor — named as **HOST POLICY**, below), a bad `WEBCTL_UNSHARE_BIN`, no
  `ip`/`ifconfig`, no `mount`, no `setpriv`, no `bash` (pid 1) — each looked up in
  `/usr/sbin:/usr/bin:/sbin:/bin` ONLY, never on your PATH (below) — an `unshare` without `--map-user` (or a child
  namespace that leaves a capability), a loopback that will not come up, a mask that fails, a home
  that cannot be hidden, a re-bind (or any submount of it) that cannot be made read-only, a hidden
  dir that does not resolve to its mask, a PATH entry that would expose a hidden dir, a host
  socket that still answers after masking → FAIL, reason printed (counts and rule names, never
  socket or home paths), command not run. **There is no path on which it runs the command on the host.**
* ⭐ **It checks the PROPERTY, not the exit of `unshare`.** Inside, before the command
  starts, it asserts: the network namespace differs from the caller's; the only interface
  is `lo`; **no TCP listener is visible**; the mount namespace differs; `lo` is up and a
  self-connect works; our tmpfs is on top of `/run` and `/tmp`; **no writable mount is left
  under a read-only re-bind** outside a writable keep; **the home and each hidden dir RESOLVE
  to our read-only tmpfs** — path resolution through the mount tree, so a later mount on an
  ANCESTOR that shadows a hide is caught (unless a keep sits exactly there); and **every host path socket
  the outer half listed is connect-tested** — one that still answers (a socket under home)
  gets `/dev/null` bound over it, and is tested again. A fake `unshare` that just runs its
  arguments is caught (tested).
* ⛔ **BREAKING (v0.33.0): the home directory is HIDDEN, WHOLE** — not read-only with a fixed
  list hidden. It holds the signed-in browser profiles (`~/.cache/<tool>`), `~/.config/webctl`
  and `~/.ssh`: a mutant restoring a literal path needs no network to corrupt a profile (so it
  was made read-only), read-only still let a mutated test READ and print ssh keys, live
  ControlMaster socket paths, an install salt and target configs naming remote hosts (measured
  by `perplexity`, so those dirs were hidden) — and a fixed list misses every secret nobody
  listed. ⇒ the **passwd** home (not `$HOME`) gets an **empty, read-only** tmpfs; inside, a
  read of anything in it is `ENOENT`, a create `EROFS`. Re-bound on top, at the same paths:
  * **read-only** — base's repo root, node, an absolute `<cmd>`, `WEBCTL_UNSHARE_BIN`, **every
    PATH entry under the home** (else the tools there vanish), and each **`--keep-ro <path>`**
    (e.g. uv's managed python under `~/.local/share/uv/python`). Each re-bind's submounts are
    read-only too (a remount hits only the top mount — measured);
  * **writable** — the **cwd** and each **`--keep <path>`**.

  `~/.ssh`, `~/.gnupg`, `~/.cache/CLIAI`, `~/.config/CLIAI`, `~/.local/state/CLIAI` and
  `~/.config/webctl` get their **own** empty tmpfs wherever a re-bind contains them: `--keep
  ~/.config` does **not** unhide `~/.config/webctl`; `--keep <path>` at or beneath one
  re-exposes **that path only**, writable, named on stderr.
  * ⛔ **Refused**, naming the rule and **no path**: a PATH entry (FAIL) or `--keep-ro` (usage 3)
    that **is** the home, **contains** a hidden dir, or **lies inside** one — re-bound read-only
    it would expose what the hiding is for. A cwd that is (or contains) the home → FAIL; a
    `--keep` containing it → usage 3 (symlinks are realpath'd first). A writable keep in
    `~/.ssh`, `~/.config`, `~/.cache`, … is allowed and **named** on stderr (`isolated: note: …`).
  * ⛔ **Hidden EXCEPT what is re-bound** — and every PATH dir under the home is re-bound: a
    secret in one (a token file in `~/bin`, a repo checkout on PATH) is readable inside.
  * ⭐ **The verdict line** lists by path (home-relative) only what you NAMED — the cwd,
    `--keep`, `--keep-ro`; PATH entries are COUNTED, other implicit re-binds named by label:
    `isolated: home HIDDEN; re-bound read-only: ~/data, 2 PATH entries; writable: ~/work —
    WEBCTL_ISOLATED_VERBOSE=1 lists every path`. ⛔ It used to list them all (~95 on an operator
    host, private repo names among them) and the gate tees stderr into logs (review of 5773fb8).
    `WEBCTL_ISOLATED_VERBOSE=1` restores the full `~/…` list for a local debug run.
  * ⛔ **A cwd at or beneath a hidden dir is REFUSED** (FAIL): it was re-bound writable there.
    Only an explicit `--keep` re-exposes a hidden dir. A NESTED `--keep` under the outer call's
    hidden home says the OUTER call hides it — keep it there.
  * **What breaks:** anything that reads the home **indirectly** — git's `~/.gitconfig` (and
    `gpg.format=ssh` commit signing), ssh's `~/.ssh/config` and `known_hosts`, gpg's keyring,
    an rc file, a tool's cache or config under `~/.cache` / `~/.config` / `~/.local`. Give the
    arm a throwaway `HOME` with what it needs, or `--keep-ro` the one dir. A PATH entry reached
    through a symlink **outside** the home is re-bound at its real path only.
  * A sensitive dot-dir that **symlinks out** of the home (`~/.cache` on a bigger disk) is made
    **read-only** at its real path, with the hidden dirs under it hidden there.
  * ⇒ **base's repo root is read-only, unless it is your cwd**: the gate runs every consumer
    against ONE base checkout.
  *npm:* `npm test` behaves as on the host; it only skips its debug logfile under
  `~/.npm/_logs` (set `npm_config_cache` under `/tmp` if you want it).
  *xq:* a check that asks xq for machine names (e.g. a no-host-literals scan) ran INSIDE
  under v0.32 (measured by `fetlife`, with `UV_NO_CACHE=1`). ⛔ With the home hidden it broke
  (measured under the gate: PASS → NO VERDICT / FAIL in two consumers): `~/.local/bin/xq` is a
  symlink into a git checkout elsewhere under the home, and xq imports that checkout's `lib/`.
  ⇒ If `xq` on your PATH really lives under the home, **its git root is re-bound READ-ONLY**
  (named `xq's root` in the verdict, never by path). For `xq` ONLY — following every PATH
  symlink would re-expose dozens of repos on an operator host. A root that is the home, or is,
  contains or lies inside a hidden dir is NOT re-bound (a note says so). ⛔ Nor is one a run
  could have PLANTED: if the PATH entry `xq` is found in, any link on the way to it, or the
  real file lies in the cwd (npm's `node_modules/.bin`!), a `--keep` / `--keep-ro`, `/tmp`,
  `TMPDIR`, `/var/tmp` or `/dev/shm` — or the real file is not named exactly `xq` — it is
  ignored (`isolated: note: xq ignored: …`, no path). Install xq as `~/.local/bin/xq` → its
  checkout and keep both out of your keeps. Pass `UV_NO_CACHE` with
  `--pass-env` if your check sets it. A lane should still treat "xq did not answer" as a FAIL,
  not a warning, when xq is installed — it falls back to fewer names silently.
* ⛔ **BREAKING (v0.33.0): the env is an ALLOWLIST.** Measured by the review: 37 vars matching
  `*_API_KEY`, `*_TOKEN`, `*SECRET` reached the arm on an operator host — and the gate passes its
  full env. Default-passed: `PATH HOME USER LOGNAME SHELL LANG LC_* TERM TZ NODE_OPTIONS
  NODE_PATH npm_config_* WEBCTL_*`, plus `TMPDIR=/tmp` and `isolated`'s own markers. **`CLIAI_*`
  is NOT passed by default** (`CLIAI_<TOOL>_BROWSER_{SSH_,}TARGET` name remote targets), nor
  `SESSION_MANAGER` (it embeds the hostname) or `ICEAUTHORITY`. Pass more with **`--pass-env
  NAME`** or **`--pass-env PREFIX_*`** (repeatable; a bare `*` is refused; a scrubbed socket
  name is refused, and a prefix pass cannot bring one back). A nested call honours only its
  OWN `--pass-env`. ⛔ **The privileged halves get LESS** — `unshare`, pid 1's bash, the inner
  node (namespace root, full caps, before any mask), `mount`/`ip`, `setpriv`/`unshare -U`: only
  `HOME USER LOGNAME LANG LC_* TERM TZ TMPDIR WEBCTL_*`, and **not your PATH**:
  `PATH=/usr/sbin:/usr/bin:/sbin:/bin`. Measured by the review of 5773fb8:
  a `NODE_OPTIONS=--require` preload ran in the inner node with a full CapEff, and a passed
  `LD_*` reached every C binary of the chain. The command's env travels in a pipe and is
  applied by the helper that spawns it, after the drop — the command still gets it all.
  ⛔ **And PATH never picks a privileged tool** (re-review): `ip`, `mount`, `setpriv`, `unshare`
  and pid 1's `bash` were found on the caller's PATH — empty and relative entries (the cwd)
  included, and npm prepends an absolute `node_modules/.bin`. A fake `ip` planted in the cwd
  ran as namespace root, full caps, before the masks. Now each is resolved on the host from
  `/usr/sbin:/usr/bin:/sbin:/bin` only and passed on by absolute path; missing → FAIL naming it.
  `WEBCTL_UNSHARE_BIN` remains the explicit override for `unshare`. The COMMAND keeps your PATH.
  ⚠ Under the release gate the OUTER call passes no extras: a nested `--pass-env X` finds only
  an `X` your contract sets; a toggle exported on the host is absent there.
* ⭐ **pid 1 reaps orphans.** pid 1 of the namespace (fresh and nested) is a small bash that
  runs the real work in the background and `wait`s on it, forwarding INT/TERM/HUP and exiting
  with its status. ⛔ node as pid 1 left a re-parented, exited grandchild as a **zombie** —
  `kill -0` succeeded and `/proc` showed state `Z` (measured by `perplexity`), so "my
  daemonised helper is gone" failed only under `isolated`. `bash` must be in
  `/usr/sbin:/usr/bin:/sbin:/bin` (else FAIL) — never taken from PATH.
  stdin reaches the command as before.
  ⛔ It is **`bash --norc -p`**: as `bash -c` it honoured the caller's shell config — as pid 1,
  with every namespace capability, before any mask (measured by the review): a `BASH_ENV`
  script ran, `SHELLOPTS=xtrace` traced the reaper, an exported `wait()` replaced it, and
  `SHELLOPTS=errexit` + TERM killed the namespace before the command's trap (143, not its 7).
  `--norc` because, with `SHLVL` unset and stdin a socket, bash sources `~/.bashrc` as if
  started by rshd — `-p` alone does not stop that (measured).
* ⛔ **A signal before the command starts is never lost.** pid 1 of a new PID namespace
  IGNORES a signal it has no handler for, and bash traps a moment after it exists: a TERM in
  that gap vanished and the command ran to exit 0 (review: 24 of 40 runs). Until the half under
  pid 1 reports `started`, `isolated` turns a forwarded signal into a SIGKILL of the namespace
  and **dies by the signal** — fresh and nested (the nested pid-1 helper reports `started` too).

* ⛔ **`/tmp` is masked, and your arm probably lives there.** A fixture, a marker file or
  anything else you share with the arm under `/tmp` needs `--keep <dir>` (or `--keep-ro`) —
  otherwise the arm sees an empty `/tmp` and writes land in it, not on the host. Only `--keep`
  paths are exempt from the socket test; a socket in the cwd or under a `--keep-ro` is still
  covered if it answers.
* ⛔ **Nested calls are detected from the KERNEL, never from an env marker.** `isolated`
  exports `WEBCTL_HOST_NETNS`, `WEBCTL_HOST_MNTNS`, `WEBCTL_HOST_PIDNS` (the host namespace
  ids it saw at entry), `WEBCTL_RO_ROOTS` (the read-only roots outside the home) and
  `WEBCTL_HIDDEN_DIRS` (the home, then the hidden dirs). A nested `isolated` proceeds as
  *already inside* — without unsharing the network again — only when **all eight** hold:
  `/proc/self/ns/net` ≠ the netns id; `/proc/self/uid_map` is **not** the identity map;
  `/proc/self/net/dev` lists **only `lo`**; `/proc/self/ns/mnt` ≠ the mntns id;
  `/proc/self/ns/pid` ≠ the pidns id; `/proc/self/mountinfo` shows the `webctl-isolated`
  tmpfs **on top of** `/run` and `/tmp`; each recorded root answers `access(W_OK)` with
  `EROFS`; and each recorded hidden dir has the read-only `webctl-isolated-hidden` tmpfs at it
  or at an ancestor (the home's). Otherwise: **exit 2, nothing run.**
  * **Version skew:** under a ≤ v0.32.0 outer (no `WEBCTL_HIDDEN_DIRS`, home not hidden) a
    v0.33 call is still refused — and, when that is the only failing fact, says **"upgrade
    the outer"**.
  * **Stripped markers** (`env -u …`, `env -i`): the call takes the FRESH path, inside, and
    isolates **again, fully** — its own netns and pidns, the home hidden again (measured); the
    verdict adds `ALREADY INSIDE an isolated namespace whose markers were stripped`.
    ⛔ It **keeps what the outer call re-bound** under the home and `/tmp`, each with the SAME
    mode (counted: `N outer re-binds`) — hiding them again broke a consumer suite under the gate
    (`Cannot find module '<repo under ~/.cache>/…'`). Only with the kernel's proof of the outer
    sandbox (our masks, our hide AT the home, lo only, a mapped uid_map); never a parent, never a
    hidden dir (one kept AT or WITHIN a hidden dir — `--keep ~/.ssh/sub` — is not carried,
    a note counts them; keep it again).
  *(A lane's
  own `…_IN_NETNS=1` marker, set on the host, skipped isolation for a whole suite. The id
  alone can be fabricated; uid_map alone proves only a USER namespace — `unshare -r`
  without `-n` passes it; and the two together are still beaten by `unshare -r` plus a
  fabricated id that merely differs, which the interface fact refuses. The old net-only
  `unshare -rn` passes all three network facts and is refused by the tmpfs fact; the
  previous `isolated` — full mask, writable home — is refused by the home fact, and one with
  the secrets visible by the hidden fact. All are tested.)*
* ⚠ **The command runs as YOUR uid/gid, WITH NO CAPABILITIES** — in a child user namespace
  (`setpriv --no-new-privs -- unshare -U --map-user <your uid> --map-group <your gid>`)
  inside the isolating one. ⛔ As namespace root it held **every** capability (CapEff
  `000001ffffffffff`, measured by the final review) and could `umount -l /tmp`, unmount a
  `/dev/null` cover or `remount,bind,rw` the home — every mask undone by one call. The drop is
  **checked**, not trusted: the same prefix reports its own `/proc/self/status`, ids and
  uid_map/gid_map first; any non-zero CapInh/Prm/Eff/Amb, no NoNewPrivs, other ids or another
  mapping — or no `setpriv`, or an `unshare` older than util-linux 2.38 — is a FAIL, nothing run.
  ⛔ **Why not simply drop every capability with `setpriv`** (the first fix): measured, it
  breaks **nested namespaces** — a capless namespace *root* cannot map uid 0 into a nested
  user namespace — so a lane self-isolating with `unshare -rn` failed under the gate, a netns
  probe went inconclusive, and Chromium ("CDP never came up") could not start its sandbox.
  Consequences for your arm: `id -u` is your real uid; files it creates are owned by you on
  disk; a **chmod-000 file is NOT readable** (no CAP_DAC_OVERRIDE — as namespace root it was,
  so an `EACCES` assertion went false-red only under the gate); no port below 1024; it MAY
  make its own namespaces — `unshare -rn` (and bring that `lo` up), a pid ns, Chromium's
  sandbox — but a nested mount namespace cannot unmount or remount what it inherited (the
  mounts are locked).
* ⭐ **Calling `isolated` from inside your own `unshare -r` / `unshare -rn` works**, and protects
  YOUR home: the real uid/gid are read from the outside of `/proc/self/{uid,gid}_map` and the
  home from passwd for that uid, accepted only if the kernel shows it owned by us. ⛔ Before,
  getuid() was 0 there and the "read-only home" was root's — the real one stayed writable
  (measured). A STACK of `unshare -r` (the real uid two levels up), no passwd entry, or a
  home not owned by us → FAIL, nothing run.
* ⛔ **HOST POLICY — AppArmor.** On a host with `kernel.apparmor_restrict_unprivileged_userns=1`
  (Ubuntu ≥ 23.10; measured on 24.04) an unprivileged `unshare -r` fails with uid_map `EPERM`.
  The refusal then says it is a **host-policy fault, not the lane's**, and gives the fixes:
  `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile granting
  `userns,` to a **dedicated copy** of `unshare`, named by **`WEBCTL_UNSHARE_BIN=<absolute
  path>`** — used for EVERY unshare `isolated` runs (outer, privilege drop, nested), validated
  (absolute, a regular file, executable; else FAIL naming the rule), re-bound read-only inside.
* ⭐ **Ctrl-C stops your script.** When a signal `isolated` forwarded ended the command, it
  re-raises it and dies BY it, so a parent bash without an INT trap stops instead of carrying
  on with `$? = 130` (bash's cooperative-exit rule). A command that HANDLES the signal and
  picks its own exit code keeps that code; a plain `exit 130` stays an exit.
* ⚠ **A harness older than these verbs exits 3 on `isolated`** — which, since your
  contract must treat it as FAIL, fails closed too. Do NOT write `isolated … || <run it
  anyway>`: that is the host fallback this verb exists to remove.
* *(A listener with a dead browser behind it — docker-proxy — still counts for
  `guard-live-port`: the browser may come back mid-run. A connect that times out is not
  proof of absence, so it refuses too.)*

## ⛔ Contract checklist: a green exit is not a green run

* **Run your suite through `scripts/run-tests-strict.mjs`** (or add
  `scripts/strict-reporter.mjs` as a second reporter). node:test lets a `describe()`
  that throws while registering **vanish** — `not ok`, `# fail 0`, exit 0 — and a
  zero-test guard does not catch it, because the tests that did register still count.
  The strict reporter fails on the failure EVENT, fails a file that registers zero
  tests (node counts one as a pass), and strips `NODE_TEST_CONTEXT` for nested runs.
* **The gate also scans your output:** exit 0 with a TAP `not ok` (TODO/SKIP excepted)
  or spec's `✖ failing tests:` is a **FAIL**, named. ⚠ It can only scan what you
  PRINT: a contract that logs its suite and prints a summary gives it nothing to read
  (5 of 7 at v0.27.0). That is fine — **if** the summarising step is itself strict.
* **Read your own `"test"` script.** `echo "No tests yet" && exit 0` over a real suite
  (measured in a lane) never reaches node, so no reporter or scan can see it.
* **Restrict discovery to test files.** Bare `node --test` runs every `.js`/`.mjs`
  under `test/`, helpers included — base ran three helper scripts as "tests", one of
  them taking a real lock in the real `~/.cache`. Pass a glob such as
  `"test/**/*.test.{js,mjs,cjs}"`.

## ⭐ A contract's last line is API

The release gate captures the **trailing block** of your output as the FAIL
reason. ⇒ Put the actionable line last and the explanation above it; background
reasoning belongs in a file a reader opens deliberately, not one a capture lands
in by accident.

## Using the harness from a lane pinned BEFORE it existed

You do not need a tag or a bump. Under `--against-head` the gate points
`WEBCTL_BASE_DIR` at the **candidate**, so the harness is present exactly when
it matters:

```sh
if [ -f "$BASE_DIR/scripts/contract-harness.mjs" ]; then
  node "$BASE_DIR/scripts/contract-harness.mjs" pin --repo . --sub vendor/base-webctl
  rc=$?
  if [ "$rc" -eq 1 ]; then exit 1; fi        # explicit; never `[ "$rc" = 2 ] && …`
else
  ...your fallback...
fi
```

⚠ **Both paths are then live, and both need testing** — a lane that adopts this
way is running the fallback locally and the harness under the gate.

