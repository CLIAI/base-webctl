# `contract-harness.mjs` — dev notes

## The three defects it exists for

Each was found by running something, none by reading, and each was in a *copy*:

1. **A re-vendor check its own documentation satisfied.**
   `grep -q "$BASE_DIR" lib/client-config.js` matched the vendor path inside the
   shim's explanatory comment, and returned **PASS across a genuine re-vendor.**
2. **`[ "$rc" = "2" ] && { … }` as an arm's last statement** returns 1 under
   `set -e`, so a **green suite exits 1**. Invisible in the lane it was copied
   *from* — that lane had no suite, so `rc` was always 2 — and it fires on the
   copier's first passing test, reading as *"the tests broke the base adoption"*.
3. **Naming the pin from the worktree rather than the committed gitlink.**
   4 of 5 contracts. Worst under the release gate, because the gate is the thing
   that makes the two differ.

## The carve-out has now been keyed wrong four times, by four people

Each fix corrected the previous keying, in the same file or its copies. Measured
2026-09-26: a lane added the gitlink-divergence check with **zero** occurrences
of `WEBCTL_DECLARED_PIN` and ten of `WEBCTL_BASE_DIR`, and **blocked a release**
when the gate's swap tripped its own new check.

⇒ That is the argument for the library rather than another rule: the rule has
been written down four times and re-derived wrong four times.

### ⭐ And the likely CAUSE, which is worth more than the count

One lane deferred reading `WEBCTL_DECLARED_PIN` *"until I bump, since v0.5.0
does not export it"*. ⛔ **It is not exported by the pinned library at all** —
the gate process sets it in the contract's environment at runtime, so a lane on
any pin receives it.

⇒ So the variable looked like part of base's API, subject to the adoption
ordering every other base capability has, and was deferred on that reasoning.
**Gate-provided env is independent of the consumer's pin**, and saying so is
cheaper than counting the mis-keyings. *(webctl:mgr's diagnosis.)*

## Controls

Every check is exercised in **both** directions against a hermetic fixture repo
built with real `git` objects — not a mocked filesystem, because the defects are
about what `ls-tree` and `describe` actually return.

⭐ **The re-vendor control replays THE SHAPE THAT SHIPPED**: a local file that
defines the surface while mentioning the vendor path only in a comment. *A
synthetic mutation proves a check can fail; replaying the shape that shipped
proves it fails on the thing that happened.*

⚠ And the pin control asserts the carve-out does **not** fire when
`WEBCTL_DECLARED_PIN` is merely *set* to the value already checked out —
otherwise the skip triggers on every gated run and the check is decorative.

## ⛔ `gate-probe`'s first draft could not fail — in the tool built to prevent that

The probe asserts that `pin` declines a verdict inside the gate's swap window.
The first draft established "a swap is in effect" like this:

```js
const swapped = declaredEnv !== worktree;   // ⛔ the SAME comparison judgePin makes
if (!swapped) return noVerdict(…);
const v = judgePin(repo, sub);
if (v.code !== EXIT.noVerdict) return fail(…);   // ⇒ UNREACHABLE
```

`judgePin` decides "swapped" by that same comparison, so whenever the probe's
guard let it through, `judgePin` was guaranteed to decline. **The FAIL branch
could not execute.** The probe would have reported pass forever, including across
a real regression in the arm it exists to watch.

⭐ **The fix is structural, not a stronger assertion: take the PRECONDITION FROM
A DIFFERENT SOURCE than the claim.** The gate knows it performed a swap, so it
exports `WEBCTL_GATE_SWAPPED=1`, and the probe's statement about `judgePin`'s own
comparison becomes falsifiable. The mutation test — gate reports a swap while
declared equals worktree, so `judgePin` returns a real verdict and the probe must
FAIL — **could not even be written against the first design.**

⇒ Generalised in `test-checks-that-cannot-fail-k3wn`: *a guard and a claim that
read the same input cannot disagree.*

### Proving the GATE blocks, not just that the probe can fail

The probe's own unit tests cover its FAIL branch. That leaves the WIRING
untested — so the gate's blocking path was itself verified by sabotage: set
`swapped = false` in `judgePin`, commit locally, run `--against-head`. Result:
`ok=0 defect=4`, exit 1, `BLOCKED`, attributed to base rather than to the four
consumers, each quoting the wrong verdict verbatim — *"declared gitlink 0c47272
is tag v0.13.0"*, a true sentence about the wrong subject. Then reset.

⚠ Note the ordering trap: the gate **refuses a dirty base tree** (exit 2, and
correctly so — consumers would be tested against a commit that does not exist),
so sabotage has to be committed locally before it can be exercised. The first
attempt measured nothing and reported exit 2, which is not the same as "the gate
did not block".

## ⛔ `no-revendor` could not see the case it exists for (generation 1 → 2)

`readdirSync` on both trees, plus a filename-equality match. **Half of base's own
lib is nested** (12 flat, 12 under `lib/browser-location/`), so `profile-lock.js`,
`mounts.js` and `chromium-docker-xpra.js` were never in the comparison set at all.

Measured with three planted copies — nested→flat, into a subdirectory under a new
name, and renamed in place. **All three reported `pass`**, with the confident reason
*"3 local file(s) examined; none shadows a base module"*. It even under-counted: one
of the four local files was in a subdirectory and was not examined.

⇒ Fixed by walking both trees recursively and matching on **normalised content**
(comments stripped, whitespace collapsed) as well as on name. Content matching is
what makes a rename or a move detectable; the name match is kept for a copy that was
edited after being taken.

⭐ **Three guards on the check itself**, since this is a check about checks:
* zero base modules discovered ⇒ **FAIL** (the comparison set is gone, which is not
  a clean bill);
* zero local files examined ⇒ **FAIL** (already there from generation 1);
* **the normaliser must DISCRIMINATE** — if distinct base modules collapse to fewer
  than two hashes, the detector is broken and no conclusion is offered. That is the
  silent direction: a degenerate normaliser would shrink the comparison set without
  any symptom.

⚠ **Stated limit:** an **edited AND renamed** copy still escapes. Catching that
needs content shingles rather than whole-file hashing. The PASS reason says so, so
the limit is published rather than implied.

### How it was found, which is the reusable part

`webctl:mgr`'s template survey reported it **and said it had not been re-measured**,
asking for verification before action. ⇒ That instruction is why it arrived here as
three concrete planted copies with an exit code, rather than as an adopted
description — and the re-measurement found it was **worse** than reported, because
the nested half of base's lib was missing from the comparison set entirely, which
the report had not identified.

## ⛔ `no-revendor` found the copy by name and then excused it (generation 4 → 5)

The name arm flagged a same-named file only if it *defined* a surface and did **not**
match `(from|require\() '…<sub>/lib/…'` — i.e. it was excused by importing **anything**
from base. An edited copy of `cdp-client.js` requires base's `cdp-rewrite.js`, because
the original does; so the excuse fired on the realistic re-vendor. Reported by
`substack` (its 237-line local `lib/cdp-client.js` → PASS, *"none is a copy by content
or by name"*), reproduced by `webctl:mgr`, re-measured here with a fixture before the
fix: sibling-importing edited copy → PASS, same copy importing nothing → FAIL. ⇒ The
discriminator was "touches base", which a copy and a shim both do.

⇒ Fixed by asking **what the file wraps**: the specifier must resolve to a base module
of the **same basename**. Chosen over "defines nothing" because the fleet's real shims
DO define things (wrappers that add `normalizeMaxFiles`, a bound
`createClientConfigSurface`): a definition test would have turned them red, and a red
that is wrong gets overridden. Surveyed every locally present consumer before and
after: every real shim imports its own base module; the only new reds are two local
`cdp-client.js` copies (`substack`, and the extension lane's — the source base's
cdp-client was extracted from).

Also fixed in passing: `byName` was single-valued, and base has **two** `index.js`
(`lib/` and `lib/browser-location/`), so one silently shadowed the other.

⚠ Rejected: accepting base's `lib/index.js` as a counterpart. It re-exports every
module, so a copy could reach its siblings through it and be excused — the same hole
by another door. No surveyed shim needs it.

### Review of generation 5 (same generation; tightening + two exceptions)

* ⛔ **"Comments stripped" was whole-line `//` only.** Measured in review: a copy
  ending in `// forked from require('…/cdp-client.js')` → PASS, exit 0; the same text
  in a string literal → PASS. The regex ran over text that still held prose. ⇒
  Replaced by a zero-dependency **lexer** (`lexJs`): strings `' " \``, template
  `${…}` nesting, regex literals (keyword/punctuation heuristic), line/trailing/
  block comments. `moduleFacts` then takes a string as a specifier **only** in a
  module-syntax position — `from` inside an `import`/`export {…}|*` clause (so a
  plain identifier `from` followed by a string after ASI does not count),
  `import '<s>'`, `import('<s>')`, `require('<s>')` with that single literal as the
  argument and not `x.require`. `normHash` uses the same lexer's comment-free text,
  so a TRAILING comment added to a copy no longer changes its hash (symmetric: both
  sides go through it).
* ⛔ ~~Lexer limits: a regex literal right after `)` or `}` is read as division~~ —
  **that limit was stated as harmless and it FAILED OPEN.** See the re-review below.
* ⭐ **Base's own house rule conflicted with generation 5.** AGENTS.md tells
  consumers to import only `lib/index.js`, and gen 5 failed a same-named pure
  re-export through it; it also failed a consumer's own local barrel `lib/index.js`
  (gen 4 passed it). ⇒ Two exceptions, both gated on **defines nothing** (no
  `function`, `class`, `=>`, or method shorthand `name(…) {`): a re-export through
  base's top-level `lib/index.js`; and a local `index.js` whose every specifier is a
  relative path outside the submodule. The rejection above still holds for any file
  that **defines code**: the barrel reaches every sibling, so a copy can import it.
  A false "defines" fails closed (not excused), the safe direction.
* `byName` multi-valued now has a test (two base `util.js`, a shim of each); a
  single-valued map fails it whatever order the walk takes. `walkJs` order is
  readdir order, so the test does not rely on it.
* The FAIL text no longer says "base's index.js does not count" (wrong for a file
  that is itself `index.js`, misleading under the barrel exception) and now tells an
  unrelated module that only shares a generic base name to **rename** itself.
* Every new rule sabotaged once (12 mutations: regex-over-text, each exception off,
  `defines` constant, single-valued `byName`, rename advice removed, regex / template
  / spread lexing off, method shorthand ignored, `from` outside a clause, `x.require`
  counted); each turned at least one test red.

### Re-review of generation 5: the lexer failed OPEN (same generation)

⛔ **The stated limit was the wrong way round.** The note above said a regex right
after `)` or `}` "is read as division", and the code comment called that a false
FAIL. Measured in re-review (25 probe repos, all exit 0 where they should have been
1): when that regex holds a quote or a backtick, division-reading opens a **phantom
string or template**, and then

* comment text after it is lexed as CODE — `if (x) /'/.test(a) // ' ; require('…/cdp-client.js')`
  made an edited copy a "shim" (also with a backtick, after `{ }`, and inside `${…}`);
* real code is HIDDEN inside it, with no prose at all — a `cdp-client.js` requiring
  base's `lib/index.js` with `if (name) /[\`]/.test(name) && …` "defined nothing", so
  the barrel exception passed it (the same file without that line FAILed);
* the content hash kept a comment, so a re-commented copy under a new name escaped.

⇒ **Fixed in two layers, both failing closed:**

1. **Precision** — a bracket stack. A `)` closing `if`/`while`/`for`/`with` is followed
   by a regex, any other `)` by division; `${` by a regex; `]`, `++`, `--` by division.
   These are decidable from tokens, so they are decided.
2. **What is left is read BOTH ways.** A `/` after `}` (block → regex; object or
   function expression → division) or after a contextual keyword (`of`, `yield`,
   `await`), and an **HTML-like comment** — `<!--`, or `-->` leading a line, which is a
   comment in a CommonJS script (Node runs `.js` CJS that way; measured) and code in an
   ES module — are **fork points**. `readJs` lexes every combination (≤ 32), drops a
   reading only if it is not lexically valid JS (unterminated string/regex/template,
   bad flags, unbalanced brackets), and `analyse` uses the facts (specifiers, defines,
   hash) only when every remaining reading agrees. **A disagreeing file is AMBIGUOUS:
   it gets no shim, barrel or local-barrel exception**, and the FAIL names the line and
   says how to make it read one way. The content arm compares **every** reading's
   hash, on both sides. A fork exists only where a regex could close on the same line,
   so real code almost never forks: the fleet's ~950 JS files (`--lib .` in every
   local consumer) produced **zero** ambiguous files.

Also from the re-review: "defines nothing" now counts **any** `( … ) {` that is not an
`if/for/while/switch/catch/with` head (computed `['f']() {`, string `'f'() {`, computed
getter `get ['x']() {` all were "nothing"), and string-to-code routes — `eval`,
`Function`, `constructor`, `vm.*` as a name **or a string key**, a `data:` specifier,
an `import()` whose argument is not one literal. Identifier escapes are decoded
(`Function` is `Function`; `require` is `require`).

⚠ **What remains, and which way each fails:**

| limit | direction |
|---|---|
| more than 32 readings → ambiguous (the walk stops at the first fork with no room) | CLOSED for every exception |
| …and its content arm compares only the readings explored | OPEN — needs a base module with > 5 forks AND a copy matching only past the cap |
| a file invalid in EVERY reading → ambiguous | CLOSED |
| a locally SHADOWED `require` (`function require(){}`) is still require | OPEN — only for a file written to look like a shim; no copy taken from base does |
| code reached by a name built at runtime, a string timer, a worker | OPEN — same: an evasion, not a re-vendor |
| an edited copy under a different name | OPEN — whole-file hashing, as stated since gen 2 |
| a same-named file that imports its base module is a wrapper, however much it defines | OPEN — by design (the fleet's real wrappers add code) |
| an UNREACHABLE import still counts — `if (false) require('<same module>')` makes a copy a wrapper | OPEN — reachability is control flow, not tokens; only for a file written to look like a shim |

Sabotaged, each against the new tests (13 mutations, every one red): no dual lexing;
no paren stack (`)` → division); `)` → fork instead of decided; `${` → division; `++`
as two tokens; invalid readings kept; disagreeing readings trusted; `( … ) {` only after
an identifier; EVALS ignored; escapes not decoded; HTML-like comments not forked;
`data:`/computed `import()` not counted; content arm on the first reading only.

### Final review of generation 5: three more ways to fail OPEN (same generation)

Each measured by the reviewer as a **false PASS**, each now an arm that must FAIL:

1. **ASI makes a `/` a regex where the lexer said division.** `REGEX_AFTER` lacked
   `break`, `continue`, `debugger` (and `extends`). After one of them a `/` on the
   same line is a syntax error, and after a line break ASI ends the statement — so
   `break⏎/'/.test(s) // ' ; require('<same module>')` is a regex and a COMMENT to node
   (the require never runs), while the lexer opened a phantom string and counted the
   require. Same class, found while fixing it, all now decided from tokens: a label on
   a `break`/`continue` line; a binding with no initializer (`let x⏎/…/`); a module
   specifier (`import 'x'⏎/…/`, `… from 'x'⏎/…/`); a **prefix** `++`/`--` (after a line
   break, or wherever a `/` would start a regex — `a⏎++/'/.lastIndex`). `var a = 1, b⏎/`
   needs to know whether the declaration is still open, a parse question: **forked**.
   Every arm is checked with `node --check` in the test before it is believed.
2. **Line terminators.** Line comments, the regex scan and the line-leading `-->` test
   knew only `\n`; node also ends a line at `\r`, U+2028 and U+2029. In a CR-only file,
   `require(<index.js>); // x⏎function createCdpClient(){}` — node DEFINES the function,
   the lexer hid it in the comment, so the file "defined nothing" and the barrel
   exception passed it. Now every terminator ends a line comment and fails a regex;
   a quoted string ends (unterminated) at `\r` as at `\n` (U+2028/9 are legal inside
   one); line numbers in messages count every terminator, CRLF as one. A CRLF file is
   read exactly like an LF one (control arms).
3. **Cost was not bounded by the cap.** Each fork enqueued a prefix before the cap was
   checked (O(F²) memory), and `lineAt` re-split the source per fork per reading. A
   generated 132 KB line with 6000 forks took 91 s and 4.3 GB. Now at most
   `MAX_READINGS − readings − todo` prefixes are ever queued; the first fork with no
   room **stops the walk** and the file is AMBIGUOUS (closed); readings are summarised
   as they are lexed (no token arrays kept); line numbers come from a line-start index
   with binary search, and only the first 5 are kept. The test's 6000-fork file (120 KB)
   measures 0.2–0.4 s CPU and ≈ 78 MB peak RSS (bare `node -e 0`: ≈ 40 MB) in a child that reports its own
   `process.resourceUsage()` — CPU, not wall time, because the shared machine's load
   swings wall time tenfold.

Sabotaged, each against the new tests: the four keywords removed → the break,
continue and debugger arms red; line comments ending at `\n` only → the CR, U+2028,
U+2029 arms red; the enqueue cap removed → the cost test red (its child exhausts a
1 GB heap; the pre-fix harness on the same file was at 4.2 GB RSS after 44 s of CPU).

## ⛔ A generation number renders TWO STATES IDENTICALLY

*(Raised by `linkedin` as a consistency point against this repo's own spec, not as a
new idea.)*

`HARNESS_GENERATION` certifies *"this consumer's copy has property P"*. ⇒ But a
consumer that **never had the defect** and a consumer that **found and fixed it**
record the **same `2`** — and those are different facts. Only the second implies that
somebody **verified** the repair.

⚠ **So the field cannot answer the question a sweep will eventually want:** *which
lanes actually ran the planted-re-vendor check, and which inherited a number?* One
lane has already planted both a nested and a top-level re-vendor against its own
contract and watched them fail by path — and its `2` will be indistinguishable from a
`2` copied from a template.

⭐ **This is the same shape as `xrl4`'s own `pass=0` under an `OK` summary: a field
that renders two states identically.** The generation marker was introduced to fix
exactly that kind of blindness, and it reproduces it one level up.

⇒ **Cheap now, expensive at six lanes:** record **HOW** the generation was
established, not only that it was — e.g. `{generation: 2, established: "verified" |
"inherited"}`. ⚠ Not yet implemented, and deliberately not rushed into the v0.16.0
tag: changing what a contract records is a change to what every lane writes, and it
should land with the ownership work rather than alone.

## ⛔ `isolated` — a mutant does not refuse

*Incident, 2026-10-02 18:43 UTC (verified with `docker inspect` by `webctl:mgr`):* a
consumer lane's mutation control planted "the default port is a location". The arms
ATTACHED to the real signed-in browser listening on the host's loopback, closed its last
tab, and Chromium exited. Correct code refuses, so the green runs were safe all along. **A
mutant does not refuse — that is what makes it a mutant** — so every mutation control that
perturbs target resolution can reach a live browser on the same host. The family's
sandboxes isolated HOME, CWD, env and PATH. Not the network.

### The measurement it rests on

Measured on the operator machine by the `webctl:base` lead, and again while building this:

```
unshare -rn sh -c '…'                works unprivileged
inside: connect 127.0.0.1:<host port> "Network is unreachable" (lo is DOWN in a fresh netns)
inside: ip link set lo up            works as mapped root
inside: /proc/self/net/dev           lists ONLY lo
inside: /proc/self/net/tcp           no LISTEN rows (host has dozens)
```

⇒ Bringing `lo` up turns *unreachable* into *refused* — local fakes and stubs work again,
and the host's listeners are still absent, because they live in a different namespace.

### ⭐ It asserts the property, not `unshare`'s exit code

The inner half runs **inside** the namespace and refuses to start the command unless:
the netns id differs from the caller's; the only interface is `lo`; no TCP listener is
visible; `lo` comes up and a self-connect works. ⇒ A fake `unshare` that just runs its
arguments is caught (a test plants one), and calling the inner verb directly on the host
refuses (the interface check fails), so it is not a bypass.

⚠ The refusal reports a COUNT of extra interfaces, never their names: interface names
describe the host, and refusal lines get pasted into issues.

### Status channel on fd 3

The outer half cannot tell "isolation refused" from "the command exited 1" by exit code
alone. So the inner half writes `started` — or `fail <reason>` — on an extra pipe (fd 3),
and closes it before spawning the command so the command does not inherit it. No
`started` ⇒ FAIL, reported once, by the outer half; the command never ran.

### Sabotage (2026-10-03)

`isolated` changed to run the command directly (`sh -c 'echo started >&3; exec "$@"'`, no
unshare) → the QA arm failed with *"the host fake was reached from inside isolation"*
(1 connection), and both fail-closed arms that depend on the namespace failed too.
Restored → 15/15.

### Second incident — and why the namespace comes FIRST

A lane's mutation control navigated a real signed-in browser's only tab. ⇒ **A port pin
cannot stop a mutant that restores a LITERAL port**: `sandbox-port` and `guard-live-port`
act on the port the lane NAMES, and a mutant that hardcodes the default never asks. Only
the namespace removes the host's listeners regardless of which number is dialled. Hence
the README's order: `isolated` → `isolation-check` as its precondition → `guard-live-port`
as the fallback only where unshare is unavailable.

### `isolation-check` asserts the EXACT errno (from `substack`'s isolation work)

"The connect failed" is not the property. In a namespace whose `lo` is DOWN the connect
fails `ENETUNREACH` — which looks like isolation — and then every in-namespace fake fails
for the wrong reason. Measured: with lo down a LISTEN on 127.0.0.1 still succeeds, but a
connect to it fails `ENETUNREACH`, so the control must CONNECT, not merely bind. ⇒ PASS
requires `ECONNREFUSED` for each named port, a reachable control, and the kernel proof
(without it, a host on which the browser merely happens to be down right now passes).

### "Already inside" is read from the KERNEL — three facts, each closing a measured hole

| proof used alone | beaten by | measured |
|---|---|---|
| env marker (`…_IN_NETNS=1`) | setting it on the host | a lane's whole suite ran on the host network |
| recorded host netns id ≠ current | fabricating the id | fleet manager |
| + uid_map not identity | `unshare -r` WITHOUT `-n` + a fabricated id that differs | while building this: both facts pass, on the host network |
| + only `lo` in /proc/self/net/dev | the OLD `unshare -rn` itself: all three pass, every host PATH socket answers | 2026-10-03, below |
| + mntns ≠ recorded `WEBCTL_HOST_MNTNS` | `unshare -rnm` + a fabricated id | while building this |
| + our `webctl-isolated` tmpfs on TOP of /run, /tmp in mountinfo | — | the fact is about the SOCKETS; "a tmpfs at /run" is a proxy (the host's is one) |

A marker whose proof fails is refused with exit 2 before anything runs. The refusal
names every failed fact (counts, never interface names).

### ⛔ No host UNIX SOCKETS either (2026-10-03)

The `webctl:base` coordinator measured that `-n` does not cover PATH unix sockets: inside
`unshare -rn`, `curl --unix-socket /var/run/docker.sock` was answered. ⇒ `-rnm`, a
`webctl-isolated` tmpfs over /run, /tmp (and a real /var/run), keep-binds, a residual
connect test, an env scrub. Measured while building it, on one workstation:

```
host path sockets in /proc/net/unix   307
  answering on the host               220 CONNECTED
  answering inside `isolated`           0   (241 ENOENT, 60 ECONNREFUSED, 6 EACCES)
/proc/<host-pid>/root/… from inside   EACCES (ptrace-mode check across the userns)
```

* **Staging order.** /run first; each kept path is `--rbind`-ed to `/run/.webctl-keep/<i>`
  while the old /tmp is visible; then /tmp; then the skeleton is recreated and each staged
  mount `--move`-d back. rbind, not bind: a subtree with LOCKED child mounts (inherited
  from the parent userns) refuses a plain bind.
* **⛔ The cwd leak.** The inner node inherits its cwd as a reference to the OLD directory,
  and so does the command: `ls ../<sibling>` from a cwd two levels below /tmp listed the
  unmasked /tmp. ⇒ `process.chdir(cwd)` by PATH after masking. ⚠ The first test of this
  used a cwd ONE level below /tmp and the no-chdir mutation SURVIVED: there `..` is the
  dentry the new tmpfs is mounted on, so the walk crossed INTO the new /tmp. Test fixed.
* **The residual test** connects to every listed host socket not under a `--keep` —
  stream sockets to a DGRAM/SEQPACKET socket give `EPROTOTYPE`, which is NOT treated as
  unreachable, so those are covered too. A connect to /dev/null bound over a socket is
  `ECONNREFUSED`. Only `--keep` exempts: an implicit keep (cwd) is not test-owned enough —
  `cwd = $HOME` would otherwise exempt the ssh ControlMaster.
* **The $HOME guard reads passwd, not `$HOME`.** `os.homedir()` honours `$HOME`, so the
  `--scratch` gate's throwaway HOME inside its scratch dir made `--keep <scratch>` look
  like "contains the home directory". Measured with the gate's layout; fixed.
* **Sabotage, each run against the test file:** no /dev/null cover → the kept-cwd socket
  test fails (CONNECTED); no env scrub → env test fails; no tmpfs fact → the old
  `unshare -rn` nesting test RAN; no re-chdir → keep-binds `UP` fails; no /tmp mask →
  unkept-/tmp test fails; no keep-binds → keep-binds fails; exemption ignored → `--keep`
  test fails. Restored → all green.

### ⛔ The home directory is READ-ONLY (2026-10-03)

The coordinator `webctl:mgr` measured that, with the network and the sockets gone, the real
home was still writable from inside — profiles under `~/.cache/<tool>`, `~/.config/webctl`,
`~/.ssh`. A mutant restoring a literal path needs no network. Measured while building it:

```
inside unshare -rnm: rbind H H; remount,bind,ro H          create in H      EROFS
  + bind <dir under H> onto itself; remount,bind,rw         create there     ok
locked nosuid,nodev mount (inherited): remount,bind,ro      OK (util-linux 2.42 keeps the flags)
top-only ro remount of an rbind with a tmpfs submount       touch in submount SUCCEEDED
  + remount the submount too                                EROFS
mount --move onto a directory of a ro tree                  OK
```

* **Order** (`maskSocketDirs`): cover /run → **stage the keeps** (copies of the untouched
  tree, host modes and submounts intact) → **rbind each root onto itself, remount it and
  every reachable submount ro** → cover /tmp → move the keeps back on top, outer first,
  remounting a read-only keep (base's root under /tmp) ro right after its move — before an
  inner writable keep lands on it.
* **Reachable** (`reachableMountsUnder`, exported for the unit test): start at the bottom
  mount AT the root, follow each same-path stack to its top, recurse into children, skip a
  child that a sibling mounted later on an ancestor path shadows. The ORIGINAL submounts
  (beneath the new rbind) descend from a different parent and are never selected. Octal
  escapes (`\040`) in mountinfo are decoded.
* **Roots are computed on the HOST side.** Inside the user namespace we are uid 0, and
  `os.userInfo()` answers root's home — the inner half gets the roots in the fd-4 plan, the
  nested proof gets them from `WEBCTL_RO_ROOTS`. Measured: the submount probe's outer
  `unshare -r` made the harness protect `/root`, hence its second userns mapping back to the
  caller's uid.
* **Protected roots**: the passwd home, plus the real path of `.ssh`, `.gnupg`, `.config`,
  `.cache`, `.local`, `.mozilla`, `.pki` when one symlinks OUT of home. A root containing
  /run or /tmp (home = `/`) is refused; a root under them is dropped (the mask hides it).
* **Writable vs read-only keeps.** cwd, `$HOME` under /tmp and `--keep` are writable;
  base's root, node and an absolute command are read-only — **under /tmp too**. Decided for
  base's root because the release gate runs every consumer against ONE base checkout (and it
  is the harness's own code); base's own suite has cwd = its root and is unaffected. Dedup:
  a keep inside a writable keep is covered; a writable keep inside a read-only one gets its
  own mount on top.
* **Refusals.** A cwd containing the home: **was not refused before** (only `--keep` was) —
  now FAIL, cwd `/` included. `throwawayHome()` never returns something containing the
  passwd home.
* **Not covered by `ro`: unix sockets.** `connect(2)` checks write permission on the inode,
  not the mount's ro flag, so the residual socket check still matters under home.
* **Nesting fact** uses `access(W_OK)` = `EROFS` on each recorded root rather than a
  mountinfo walk: it asks the exact question through path resolution; the full submount
  sweep needs the writable keeps, which only the inner half knows.
* **npm** (12.0.2): `npm test` / `npm install` under the ro home: rc 0, rc 1 propagated;
  the debug logfile is skipped (EROFS), a one-line notice on error. No change needed.

**Sabotage, each run against the test file, each red, restored → green:** ro step off +
read-back off → the home arm created the file (and its `finally` removed it); ro step off
alone → refused by the read-back; top-only remount + read-back off → submount arm `ok`;
top-only alone → refused by the read-back; no re-chdir → the `..` arm — **which first
SURVIVED**: from a cwd one level below home, `..` is the home dentry, now a mount point, so
the walk crossed into the ro mount (the /tmp keep-bind test's trap, again). Moved two
levels down; red. Base root writable → its arm red; no recursion into submounts → both
logic units red; cwd-contains-home unrefused → red; keeps not realpath'd → the symlink arm
red; no note → red; no nested home fact → the previous-`isolated` nesting arm red.

### ⛔ The command held EVERY capability — and could undo every mask (2026-10-03)

*Measured by the final review:* inside `isolated`, `id -u` 0 and CapEff `000001ffffffffff`.
`umount <cwd>/m2.sock` (the /dev/null cover) and `umount -l /tmp` took both probe sockets
from ENOENT/ECONNREFUSED to CONNECTED; the same root could `remount,bind,rw` the ro home.
CAP_DAC_OVERRIDE also read a chmod-000 file — a consumer's `EACCES` test went false-red
only under the gate.

⇒ `privilegeDrop()`: `setpriv --no-new-privs --bounding-set=-all --inh-caps=-all
--ambient-caps=-all --` before the command, on the fresh AND the nested path. Measured:

```
inside, after setpriv          CapInh/Prm/Eff/Bnd/Amb 0, NoNewPrivs 1
umount -l /tmp                 "must be superuser to unmount"
mount -o remount,bind,rw <H>   "permission denied", rc 32
chmod-000 file                 EACCES (raw `unshare -r`: readable)
setpriv --bounding-set=-all    "Operation not permitted" when ALREADY capless (needs
                               CAP_SETPCAP) ⇒ passed only while CapBnd is non-zero
nested `unshare -rm` (capless) "write failed /proc/self/uid_map: Operation not permitted"
nested `unshare -Um`           CapEff 0; `umount -l /tmp` EINVAL
nested `unshare -rm` WITH caps `umount -l /tmp` → "not mounted": inherited mounts LOCKED
```

* **The drop is asserted, not trusted.** The prefix runs node once to print its own
  `/proc/self/status`; every CapXxx must be 0 and NoNewPrivs 1. A missing setpriv and a fake
  one that execs its argv are both tested refusals.
* **Last, after every mount**, just before `started`: the inner half itself needs the caps.
* **Sabotage:** drop removed → CapEff arm, `umount -l /tmp` arm, chmod-000 arm, both
  fail-closed arms red. ⚠ The remount arm first **SURVIVED**: it used `remount,rw`, a
  SUPERBLOCK remount that needs init-ns CAP_SYS_ADMIN and fails even with every namespace
  cap. The attack is `remount,bind,rw` (the per-mount flag); fixed, red. The nested-unshare
  arm survives the mutation **by design** — it tests mount locking, which holds with caps.
* ⛔ **SUPERSEDED the same day** — see the next section: this drop broke nested namespaces.

### ⛔ The setpriv drop broke NESTED namespaces — the command now runs as the real uid (2026-10-03)

*Measured by a run over the real consumers:* a capless namespace-**root** process cannot
create a nested user namespace — `unshare: write failed /proc/self/uid_map: Operation not
permitted`. Mapping uid 0 (the writer's own euid, which is the parent namespace's root)
needs CAP_SETFCAP since Linux 5.12. So under the release gate a lane whose contract
self-isolates with its own `unshare -rn` FAILED, a lane probing for a netns went
INCONCLUSIVE, and a lane launching a real Chromium failed with "CDP never came up" — its
sandbox needs an unprivileged user namespace, and as uid 0 it refuses to start at all
(*"Running as root without --no-sandbox is not supported"*, measured).

⇒ `privilegeDrop(ids)`: `setpriv --no-new-privs -- unshare -U --map-user <uid> --map-group
<gid> --` before the command, fresh AND nested path. The command runs in a CHILD user
namespace as the REAL uid/gid number, mapped onto the outer namespace's root (= the
caller). No new mount namespace: the masks stay in the one the OUTER user namespace owns.
The real ids are read on the HOST side (inside, getuid() is 0) and passed in the masking
plan (`ids`) and in `WEBCTL_HOST_IDS` for the nested path, as `WEBCTL_RO_ROOTS` is.
Measured inside our `unshare -rnm`, after the masks and ro remounts:

```
inside the child               id -u = the real uid; CapInh/Prm/Eff/Amb 0 (CapBnd full)
chmod-000 file                 EACCES
umount -l /tmp                 refused; an unkept-dir socket stays ENOENT
mount -o remount,bind,rw <ro>  refused; a write to the ro mount refused
nested `unshare -rn`           OK, and `ip link set lo up` in it OK
nested `unshare -rnm`          made; `umount -l /tmp`, `remount,bind,rw` both refused (locked)
nested `unshare -Ur --pid --fork --mount-proc`   OK (pid 1)
nested `unshare -U --map-user <uid>`             OK — the nested `isolated` path
write to the fresh /tmp        OK
Chromium --headless --dump-dom, sandbox ON   OK (under the setpriv drop: refused, uid 0)
same, under setpriv --bounding-set=-all …   nested `unshare -rn`: uid_map EPERM
```

* **`--no-new-privs` is KEPT.** Measured with and without it: nested `unshare -rn` + lo up,
  a nested pid ns, a nested `--map-user` and Chromium all work either way. It stops a setuid
  or file-capability binary from handing the command capabilities in its child namespace.
  The bounding set is NOT dropped: a new user namespace starts with a full one regardless,
  and dropping it needs CAP_SETPCAP, which the nested caller lacks.
* **Read back, not trusted.** The prefix runs node once and reports its `/proc/self/status`,
  getuid/getgid and uid_map/gid_map: CapInh/Prm/Eff/Amb 0, NoNewPrivs 1, the real ids, and
  EXACTLY one map line `<real id> <our euid/egid> 1`. Tested refusals: no setpriv; a setpriv
  that execs its argv (NoNewPrivs 0); an `unshare` without `--map-user` (util-linux < 2.38);
  one that accepts it and makes no namespace (caps, ids and map all wrong); a nested call
  with `WEBCTL_HOST_IDS` unset. A real uid of 0 is refused up front. ⚠ The ids are passed
  as SEPARATE argv words and redacted from any quoted stderr — getopt echoes `--opt=value`.
* **The nesting proof is unchanged and still holds**: uid_map is now the child's (one line,
  not the identity), netns/mntns/pidns are the outer level's. Tested: `isolation-check`
  PASSES from the child and from a nested call's grandchild.
* **Sabotage:** (1) child userns removed, read-back kept → every `isolated` arm red with the
  refusal (fail closed). (2) Also the read-back removed → the CapEff, `id -u`, `umount -l
  /tmp`, `remount,bind,rw` and chmod-000 arms red; the LOCKING arm stays green by design
  (inherited mounts are locked with caps too). (3) be3471f's setpriv harness → the
  REGRESSION arm (nested `unshare -rn` + lo up), the nested pid-ns arm and the LOCKING arm
  (its nested namespace is no longer made — the old arm was vacuous there) red.

### ⛔ No PID namespace — host processes were signalable (2026-10-03)

*Measured by the final review:* `kill -0 <host pid>` from inside succeeded (same kuid, no
pid ns) and `/proc` showed every host process. ⇒ `unshare -rnm --pid --fork --mount-proc
--kill-child`. The inner half is now **pid 1** of the new namespace; when it exits, the
kernel SIGKILLs everything left in it — an arm's stray background processes included.

* ⛔ **`unshare --fork` BLOCKS SIGTERM in its own process until its child exits** (and
  ignores INT/QUIT: `SigIgn 0x6`). Measured: TERM to unshare never reached the child, which
  ran to completion. The old `forwardSignals(unshare)` would have silently stopped
  delivering — no test covered it (the brief assumed one did). ⇒
  `forwardSignalsPastUnshare`: signal unshare's CHILD (from
  `/proc/<pid>/task/<pid>/children`, else a `/proc` scan); none yet ⇒ SIGKILL unshare, and
  `--kill-child` takes the namespace down — nothing had started.
* **pid 1 ignores a signal it has no handler for.** So the inner half installs exit-on-signal
  handlers from its first line and swaps them for runCommand's forwarders only when the
  command starts. ⚠ That pre-command window has no test: it needs a signal inside a ~100 ms
  masking window, which is a race, not an arm.
* **Nesting fact 7:** `/proc/self/ns/pid` ≠ `WEBCTL_HOST_PIDNS`. Recorded, so fabricable —
  like the netns/mntns ids; the env-free facts carry the rest.
* **Sabotage:** no `--pid --fork --mount-proc` → the ESRCH arm red (the SIGTERM arm stays
  green: without `--fork` unshare execs, and the old path works); signals to unshare instead
  of its child → the SIGTERM arm red (`TIMEOUT` after 10 s — the trapper is bounded so a lost
  signal cannot leave an orphan); nested pid fact off → its nesting arm red.

### Refusals are tagged lines — usage ones too (final review, finding 7)

Usage refusals printed a bare `isolated: --keep #1 is beneath /run…`; the gate greps
`^(FAIL|NO VERDICT) +isolated: `, missed it, and told the operator to fix unshare / user
namespaces (e.g. TMPDIR under /run makes the gate's own `--keep` invalid). ⇒
`usageRefusal()` → `report('isolated', EXIT.usage, 'NOT RUN (usage): …')`, and `report()`
now tags every code that is neither pass nor no-verdict as FAIL (no caller passed exit 3
before; the exit code is unchanged). The inner half called on the host reports too. Tested
against the gate's literal regex, with a control that the regex misses the old shape;
sabotage (old output restored) → both arms red. ⚠ A command that cannot be found is NOT a
refusal: it was started, `unshare` prints *"failed to execute …"* and the rc is 127.

### ⛔ Under an outer `unshare -r` the "read-only home" was ROOT's (final review, 2026-10-03)

Lanes self-isolate with `unshare -rn` and may call `isolated` inside it. There getuid() is 0
and os.userInfo() answers root: the ro step protected root's home, and a file appeared in the
REAL one (measured by the review). With the child-userns drop the same call was simply
refused (uid 0) — a lane that self-isolates could not use `isolated` at all.

⇒ `realIdentity()`, host side, at entry:

* identity uid_map ⇒ getuid()/getgid() and os.userInfo() as before (NSS-aware);
* otherwise two candidates — the OUTSIDE id of `/proc/self/{uid,gid}_map` (the `unshare -r`
  case), and our own ids (a `--map-user=<uid>` namespace: the submount fixture's shape, and
  `isolated`'s own child). Home: `getent passwd <uid>`, else `/etc/passwd` parsed;
* ⭐ a candidate is ACCEPTED only when its home is owned by us as the kernel shows it here
  (`stat().uid === getuid()`): a kernel fact, not a guess about how namespaces were stacked.
  ⚠ The first draft refused "maps onto 0 one level up" outright — and the submount ARM went
  red: its fixture (`unshare -rm` + `--map-user=<uid>`) is exactly that shape, legitimately;
* refused, naming no id or path: unmapped ids; a stack of `unshare -r` (0 → 0); no passwd
  entry; no candidate's home owned by us. ⚠ **No passwd entry is REFUSED, not noted**: the
  home would go silently unprotected, and every other gap in this verb fails closed. A CI
  container running an arbitrary uid without an entry will be refused — add one.

Measured: inside `unshare -r`, a write into the real home → EROFS, absent on the host;
`id -u` real; a nested `unshare -rn` works. Sabotage: home from os.userInfo() → the ARM red
(the write landed); the old identity wholesale → the ARM and both refusal arms red.

### ⛔ Ctrl-C did not stop the caller (final review, 2026-10-03)

`isolated` forwarded SIGINT, then EXITED NORMALLY with 130. bash's wait-and-cooperative-exit
rule reads a normal exit as "the child handled it" and carries on. ⇒ `exitOrDieBy()`: when
a FORWARDED signal ended the child — killed by it, or exit 128+n, the shape it takes through
unshare and the namespace's pid 1 (whose self-sent signals the kernel ignores) — remove the
handlers and `process.kill(process.pid, sig)`. Fresh path, nested path, and a signal before
the command started.

```
parent shape (INT to its group)            before         after
bash, no trap: isolated …; echo AFTER      AFTER rc=130   dies by SIGINT
bash, no trap: ( isolated … ) | cat        AFTER rc=130   dies by SIGINT
bash WITH INT trap, gate shape             trap runs      trap runs   (bash 5.3)
async-launched gate (`setsid bash … &`)    INT IGNORED from entry: `trap -p` → '' SIGINT
```

⚠ **The review's measurement was confounded**: its probe launched the gate as an async job
from a script, and bash then starts it with SIGINT ignored — a non-interactive shell cannot
trap a signal ignored at entry, so no harness change can make that trap run. With a real
terminal Ctrl-C the trapped gate runs its trap on bash 5.3 either way; the fix matters for
every caller WITHOUT a trap (lane scripts). A command that HANDLES the signal keeps its own
code (the rc-7 trapper arm); `exit 130` without a signal stays 130 (CONTROL). Sabotage: no
re-raise → the three no-trap arms red.

### The import guard

The dispatch ran at module top level unconditionally, so importing the file would have
dispatched on the IMPORTER's argv (usage + `process.exit(3)` at best, a real verb at
worst). Nothing in the repo imported it yet, so this was latent. ⇒ `isEntryScript()`
compares realpath(argv[1]) with realpath(this file) — realpath on both, because argv[1]
keeps a symlinked path while `import.meta.url` is resolved. The dispatch body is
deliberately not re-indented, to keep the guard a two-line diff against concurrent edits.

### Known limits

* **The home is passwd's for the REAL uid** (realIdentity, below) — one level up at most: a
  stack of `unshare -r` is refused, not resolved. No passwd entry ⇒ refused. A profile
  directory configured OUTSIDE home (and not via a symlinked dot-dir) is not covered.
* **`WEBCTL_RO_ROOTS` is recorded input.** `[]` would satisfy the nested home fact; the
  other five facts still require being inside a real masked namespace, so it does not let
  the host pass as "inside".

* **The real uid, no capabilities.** The command runs as the caller's own uid/gid in a
  child user namespace (above); it can make namespaces of its own, but cannot bind a port
  below 1024 in the isolated netns. Running `isolated` as host root is refused. Needs
  util-linux ≥ 2.38 (`unshare --map-user`) and `setpriv`.
* **`ip` or `ifconfig` is required** to bring `lo` up; node has no ioctl. Absent → FAIL.
  So is **`mount`** (util-linux, the package `unshare` comes from).
* **Sockets the list misses.** One created on the host AFTER start-up (still masked if it
  is under /run or /tmp); ones bound in another network namespace (not in this netns's
  /proc/net/unix). A keep under /run is refused rather than supported.
* **Linux only.** No unprivileged netns elsewhere ⇒ FAIL, never a host run. The tests
  SKIP with a named reason where userns is unavailable.
* **Generation unchanged (4).** These verbs are additive: no existing verdict changes
  meaning, so a bump would send every lane looking for rot that is not there (the
  `gate-probe` precedent).

## Deliberately not here yet

* **Exercisable under the gate.** The pin check's swap arm is the one path that
  only the release gate produces on demand; it is currently controlled by a
  forged fixture. ⇒ *The forged control is the only one you can schedule; the
  accidental one is a gift.* Running the harness's own checks **during** an
  `--against-head` run would convert the gate into a control, and that is the
  next step rather than a shipped property.
* **The ESM/CJS arm from a consumer.** base uses this natively; a CJS lane
  invokes it as a subprocess, so there is no loader question — but no lane has
  run it yet.
* **A floor the GATE enforces, so a lane cannot forget it.** `require-generation`
  fails closed on old harnesses, but only a contract that *calls* it is protected,
  and base cannot make a lane call it. The gate is the one piece of base that is
  never downgraded (it runs from base HEAD). It could open a **downgrade window**:
  point each consumer at a generation-2 tag, run its contract, and require a FAIL
  whose reason names `require-generation`. A green there means the lane has no
  floor. Not built yet: a consumer's suite on an old base can fail for unrelated
  API reasons, so the probe must judge the *reason*, not the exit code, and that
  needs the JSONL `check` field rather than prose.

## Identifier characters follow Unicode ID_Start / ID_Continue (final re-review)

The lexer's identifier class once spanned every code point from U+0080 up. That swallowed
U+2028/U+2029 line terminators, NBSP, the BOM and every Zs space INTO an identifier, so
`break`+NBSP read as one non-keyword word: the ASI rule that makes the next `/` a regex never
fired, and a comment hiding `require(<same module>)` was read as code — a false PASS. NBSP is
common in copy-pasted code, so this needed no exotic input. Identifiers now use
`\p{ID_Start}` / `\p{ID_Continue}` (plus `$`, `_`, `#`, ZWNJ, ZWJ). Six arms pin it
(break/return/typeof/else/prefix-`++`/`-->` with NBSP, BOM or U+2028); restoring the old range
turns them red. Unicode identifiers (`café`, `π`) still lex as identifiers.
