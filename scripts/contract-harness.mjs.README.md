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
node "$H" require-generation 5 || { echo "FAIL: base harness below generation 5 (downgraded submodule?)"; exit 1; }
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

⚠ **Now 5.** History, each a change in what a verdict MEANS:

* **2** — `no-revendor` sees copies in subdirectories and under new names.
* **3** — `pin` FAILS on drift and on an undeclared submodule; only a mode-160000
  entry is a gitlink (`substack`).
* **4** — the swap carve-out keys on `WEBCTL_GATE_SWAPPED=1` only (`fetlife`);
  `require-generation` added; `generation` refuses arguments.
* **5** — `no-revendor`: a file named like a base module is a shim only if it imports
  **that** module; importing a sibling no longer excuses an edited copy (`substack`).
  ⚠ Lanes that were green on 4 with a same-named copy go **red** — that is the fix.

A sweep asks *"who is below 5?"* — and, since generation 4, *"whose contract does not
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

## ⛔ Mutation arms run with no host network, no host unix sockets and a READ-ONLY home — `isolated`, `isolation-check`, `sandbox-port`, `guard-live-port`

*Incident, 2026-10-02 (a consumer lane's mutation control):* the mutant planted "the
default port is a location", the arm **attached to the real signed-in browser on the
host's loopback**, closed its last tab, and Chromium exited. Correct code refuses; **a
mutant does not refuse — that is what makes it a mutant.** The sandboxes isolated HOME,
CWD, env and PATH. Not the network. Spec: xrl4, *"Mutation arms run with no host network, no host unix sockets and a read-only home"*.

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
| `isolated [--keep <path>]… -- <cmd> [args…]` | runs `<cmd>` in private user+network+mount+**PID** namespaces (`unshare -rnm --pid --fork --mount-proc`) — no host process can be seen or signalled, and everything the arm started dies with it: the ONLY interface is its own `lo`, brought up first so local fakes/stubs work; `/run` and `/tmp` (and a real `/var/run`) are a fresh tmpfs, so the host's unix sockets — docker, X11, ssh-agent, session bus — are gone. The **passwd home is READ-ONLY**, every submount included. The cwd, base's repo root, an absolute `<cmd>`, node, a `$HOME` under `/tmp` and each `--keep` stay at their paths; **writable**: the cwd, a `$HOME` under `/tmp`, each `--keep` — **read-only**: base's repo root, node, the command. Caller's cwd and stdio; env minus `DISPLAY`/`WAYLAND_DISPLAY`/`SSH_AUTH_SOCK`/`DBUS_SESSION_BUS_ADDRESS`/`DOCKER_HOST`/`XDG_RUNTIME_DIR`, `TMPDIR=/tmp`; argv as an array (no shell). | the command's exit code; **1** (FAIL, with a JSONL `"check":"isolated"` record) when isolation could not be established — **the command is then not started** |
| `isolation-check <port>…` | run INSIDE `isolated`. Each named port: a connect to `127.0.0.1:<port>` must fail with **exactly `ECONNREFUSED`** (lo up, nothing listening) — `ENETUNREACH` means the loopback is DOWN and is a FAIL. A control listener it opens on the namespace loopback must be reachable. The kernel proof below must hold. | 0 pass · 1 fail, naming every condition that failed · 3 usage |
| `sandbox-port [--bare]` | binds `127.0.0.1:0`, reads the port, closes it, **asserts a connect is refused**, prints it (JSONL + human line; `--bare` = the number only, for `$(…)`) | 0 |
| `guard-live-port <port> [--pin-verified]` | defence in depth where `isolated` is not used: **REFUSES** when `127.0.0.1:<port>` listens **or** answers CDP (`GET /json/version` 200), naming both facts, unless `--pin-verified` | 0 pass · 1 refused · 3 usage |

* ⭐ **Every refusal is ONE tagged line**: `FAIL  isolated: NOT RUN…` on stderr plus a JSONL
  `"check":"isolated","result":"fail"` record — usage refusals included (`NOT RUN (usage): …`,
  still exit **3**). Grep `^(FAIL|NO VERDICT) +isolated: ` and you have the reason. *(Usage
  refusals used to be a bare `isolated: …` line; the gate's grep missed them and blamed
  unshare / user namespaces.)*
* ⛔ **`isolated` fails CLOSED.** No `unshare`, unprivileged user namespaces disabled, no
  `ip`/`ifconfig`, no `mount`, no `setpriv`, an `unshare` without `--map-user` (or a child
  namespace that leaves a capability), a loopback that will not come up, a mask that fails, a home
  (or any submount of it) that cannot be made read-only, a host
  socket that still answers after masking → FAIL, reason printed (counts, never socket
  paths), command not run. **There is no path on which it runs the command on the host.**
* ⭐ **It checks the PROPERTY, not the exit of `unshare`.** Inside, before the command
  starts, it asserts: the network namespace differs from the caller's; the only interface
  is `lo`; **no TCP listener is visible**; the mount namespace differs; `lo` is up and a
  self-connect works; our tmpfs is on top of `/run` and `/tmp`; **no writable mount is left
  under the home** outside a writable keep; and **every host path socket
  the outer half listed is connect-tested** — one that still answers (a socket under home)
  gets `/dev/null` bound over it, and is tested again. A fake `unshare` that just runs its
  arguments is caught (tested).
* ⛔ **The home directory is READ-ONLY** — it holds the signed-in browser profiles
  (`~/.cache/<tool>`), `~/.config/webctl` and `~/.ssh`, and a mutant restoring a literal
  path needs no network to corrupt one. The **passwd** home (not `$HOME`) is rbound onto
  itself and it **and every submount** remounted ro (a remount hits only the top mount —
  measured); the result is read back from mountinfo before the command starts. Writable on
  top: the **cwd** and each **`--keep`**. A cwd that is (or contains) the home → FAIL; a
  `--keep` containing it → usage 3 (symlinks are realpath'd first). A writable keep in
  `~/.ssh`, `~/.config`, `~/.cache`, … is allowed and **named** on stderr
  (`isolated: note: …`). ⇒ **base's repo root is read-only too, unless it is your cwd**: the
  gate runs every consumer against ONE base checkout.
  *npm:* `npm test` behaves as on the host; it only skips its debug logfile under
  `~/.npm/_logs` (set `npm_config_cache` under `/tmp` if you want it).
* ⛔ **`/tmp` is masked, and your arm probably lives there.** A fixture, a marker file or
  anything else you share with the arm under `/tmp` needs `--keep <dir>` — otherwise the
  arm sees an empty `/tmp` and writes land in it, not on the host. Only `--keep` paths are
  exempt from the socket test; a socket in the cwd is still covered if it answers.
* ⛔ **Nested calls are detected from the KERNEL, never from an env marker.** `isolated`
  exports `WEBCTL_HOST_NETNS`, `WEBCTL_HOST_MNTNS`, `WEBCTL_HOST_PIDNS` (the host namespace
  ids it saw at entry) and `WEBCTL_RO_ROOTS` (the read-only roots). A nested `isolated`
  proceeds as *already inside* — without unsharing again — only when **all seven** hold:
  `/proc/self/ns/net` ≠ the netns id; `/proc/self/uid_map` is **not** the identity map;
  `/proc/self/net/dev` lists **only `lo`**; `/proc/self/ns/mnt` ≠ the mntns id;
  `/proc/self/ns/pid` ≠ the pidns id; `/proc/self/mountinfo` shows the `webctl-isolated`
  tmpfs **on top of** `/run` and `/tmp`; and each recorded root answers `access(W_OK)` with
  `EROFS`. Otherwise: **exit 2, nothing run.** *(A lane's
  own `…_IN_NETNS=1` marker, set on the host, skipped isolation for a whole suite. The id
  alone can be fabricated; uid_map alone proves only a USER namespace — `unshare -r`
  without `-n` passes it; and the two together are still beaten by `unshare -r` plus a
  fabricated id that merely differs, which the interface fact refuses. The old net-only
  `unshare -rn` passes all three network facts and is refused by the tmpfs fact; the
  previous `isolated` — full mask, writable home — is refused by the home fact. All are
  tested.)*
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

