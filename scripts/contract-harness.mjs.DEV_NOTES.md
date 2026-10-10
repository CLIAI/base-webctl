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
* **pid 1 ignores a signal it has no handler for.** *(Since v0.33.0 pid 1 is the reaping
  bash, which traps and forwards — see "pid 1 did not reap" below; the inner half is pid 2.)*
  So the inner half installs exit-on-signal handlers from its first line and swaps them for runCommand's forwarders only when the
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

### ⛔ The home's SECRETS were readable — read-only is not hidden (`perplexity`, v0.33.0; superseded below by hiding the WHOLE home)

*Measured by a consumer lane:* under the read-only home a mutated test could still READ and
print `~/.ssh` keys, live ControlMaster socket paths, an install salt and target configs
naming remote hosts — into a log that may land in a public repo. Read-only stops a mutant
WRITING the profile; it does nothing about it READING the operator's secrets.

⇒ `HIDDEN_DIRS` (`.ssh`, `.gnupg`, `.cache/CLIAI`, `.config/CLIAI`, `.local/state/CLIAI`,
`.config/webctl`): each that exists is realpath'd on the HOST side (protectedRoots — inside
we are uid 0 and the passwd lookup answers root's) and gets an EMPTY tmpfs (`mode=0555`,
source `webctl-isolated-hidden`), remounted `ro`.

* **Order.** After the ro-home step and after the new `/tmp`, in ONE sequence with the keeps
  moving back, sorted by path length (a hide before a keep at the same path). ⇒ a keep
  CONTAINING a hidden dir is moved first and the hide lands on top of it (does not unhide);
  a keep AT one lands on top of the hide (the caller's exception); a keep BENEATH one gets its
  mount point created in the fresh tmpfs before it is remounted ro, then lands on top.
* **Paths beneath a hidden dir must be bound** (planKeeps rule (c)): before, a read-only item
  under a protected root needed no bind — the root's own ro mount covered it. Under a hide it
  would vanish: base's root, node or an absolute command living under `~/.cache/CLIAI` would
  be unreachable. And the dedupe that drops a keep beneath a writable outer keep must NOT drop
  it when a hidden dir lies between them.
* **errnos, measured inside:** each hidden dir lists 0 entries; a read of the planted file is
  `ENOENT`; an exclusive create is `EROFS` (the per-mount ro flag wins over the 0555 mode).
* **Post-check from mountinfo** (`hiddenGaps`): the TOP mount at each hidden dir must be OUR
  ro tmpfs, unless a keep is exactly there. Tested with a fake `mount` that silently skips
  one hide — refused, nothing run.
* **Nesting fact 8:** each dir recorded in `WEBCTL_HIDDEN_DIRS` has the hide tmpfs somewhere
  in its mount stack (not necessarily on top: a keep at exactly it sits above).
* **Tests never plant in the real `~/.ssh`.** A FAKE passwd home (a throwaway dir) is given to
  the real uid by binding a fake `/etc/passwd` in a throwaway `unshare -rm` — the same device
  as the passwd-home refusals. The helper also asserts `getent` answers the fake home, so a
  host where NSS answers from elsewhere SKIPS by name rather than testing the real home.
* **BREAKING** for a test that reads one of these dirs; `--keep <path>` re-exposes that path.
* **Sabotage:** no hide → every hide arm red; no ro remount → refused by the post-check (and
  the arm's `EROFS` would read `EACCES`); no mount-point skeleton → the keep-beneath arm red
  (masking fails, EROFS); no bind for paths beneath a hidden dir → the command/cwd arm red;
  no hidden-between guard in the dedupe → keep-beneath red; hide sorted after a keep at the
  same path → keep-exception red; no post-check → the fake-`mount` arm red; nesting fact 8
  off → its nesting arm red.

### ⛔ pid 1 did not reap (`perplexity`, v0.33.0)

*Measured:* node as pid 1 leaves an orphaned, exited grandchild as a ZOMBIE — state `Z`,
`kill -0` succeeds. A test that daemonises a helper and asserts "it is gone" fails only under
`isolated`. libuv `waitpid()`s only the pids it spawned and node exposes no `waitpid(-1)`.
`PR_SET_CHILD_SUBREAPER` is no help: it is not reachable from node either, and a pid 1 is
already the reaper — the question is only whether it calls `wait`. bash does: its SIGCHLD
handler reaps ANY child, re-parented orphans included (measured: the orphan's
`/proc/<pid>` disappears).

⇒ unshare's forked child, on both paths, is `bash -c PID1_REAPER <node half> …`:

* the node half (inner half on the fresh path, the `__isolated-pid1` helper on the nested
  one) runs in the BACKGROUND, `<&0`: **a non-interactive bash gives a background job
  `/dev/null` as stdin** unless redirected explicitly (measured — `echo x | bash -c 'cat &
  wait'` prints nothing);
* fds 3/4 (status, plan) are inherited by the background child, which needs them; bash then
  closes its own copies (`exec 3>&- 4<&-` — measured: none left open in pid 1);
* INT/TERM/HUP trapped and forwarded. A trapped signal interrupts `wait` (returns >128), so it
  waits AGAIN until the child itself ended; **bash keeps a reaped child's status for a second
  `wait`** (measured: `wait` → 138 by a USR1 trap, `wait` again → 5, the child's). It then
  exits with the child's status. A signal after the traps but before the child exists:
  `exit 128+n` — pid 1 goes, the namespace with it. ⛔ A signal BEFORE the traps was LOST
  (pid 1 ignores what it has no handler for) — see "The early-signal window" below;
* ⚠ **a background job ignores SIGINT** (`SigIgn 0x6` on a `sleep &`), so the command is never
  bash's direct child: node resets its dispositions at start (measured: its SigIgn has no
  INT), and node spawns the command with defaults — which is why the nested path keeps the
  node helper under bash.
* Fail closed: `bashOnPath()` finds no bash → FAIL naming it (both paths). The restricted-PATH
  arms for unshare/ip/mount/setpriv now include bash, so they still fail on what they name.
* **Sabotage:** drop `<&0` → stdin arm red; `exec "$@"` instead of reaping → both orphan arms
  red; a single `wait` → the SIGTERM-trapper arm red (pid 1 exits 143 while the command's trap
  is still running, and the namespace dies with it); a trap that does not forward → the
  SIGTERM arms red; each bash check removed → the no-bash arm red. The Ctrl-C arms stay green
  under a non-forwarding trap: Ctrl-C signals the whole group, so the command gets INT anyway.
* The pre-child window is now closed from OUTSIDE and tested (below).

### More env scrubbed (`perplexity`, v0.33.0; now applied AFTER the allowlist, below)

`TMUX`, `TMUX_PANE` (send-keys into the human's panes), `XAUTHORITY`, `SSH_AGENT_PID`,
`DOCKER_CONTEXT` (a possibly remote daemon), and `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` —
the last three carry the operator's ADDRESSES, which a mutated test can print into a public
log. The arm and its control iterate the same list; the hostile values use the documentation
address range. Sabotage: dropping `SSH_CLIENT` from the list → the arm red.

### ⛔ The WHOLE home is hidden — a fixed list misses what nobody listed (v0.33.0, `webctl:mgr` ruling)

The fixed `HIDDEN_DIRS` hide still left every other secret in the home READABLE. Ruling
(2026-10-07): an empty read-only tmpfs over the passwd home; re-bind on top only what the arm
needs — READ-ONLY base's root, node, an absolute command, `WEBCTL_UNSHARE_BIN`, EVERY PATH
entry under the home, each new `--keep-ro`; WRITABLE the cwd and each `--keep`.

* **The home is a hide op, not a root.** It joins the outer-before-inner sequence as the
  shortest path, so every re-bind under it is moved back ON TOP. A hidden dir under the home
  gets its own hide only where a re-bind strictly CONTAINS it — elsewhere the home's tmpfs
  hides it, and its mount point would not even exist. One outside the home (a symlinked
  dot-dir's real path) is always hidden; that real path is still a read-only ROOT.
* **`mount` vanished mid-masking** (measured: the no-`setpriv` arm's PATH dir lives under the
  home). From the home's tmpfs until that dir's re-bind moves back, `spawnSync('mount')` found
  nothing. ⇒ right after `/run` is covered, `mount --bind -o ro <real mount> /run/.webctl-bin/mount`,
  and every later step runs that (MOUNT.bin). It stays visible inside, read-only.
* **Mount points only where MISSING.** The hide loop used to `writeFileSync(b.p, '')` for a FILE
  bind beneath the hide. If a hide silently fails (the fake-`mount` arm), `b.p` is the REAL file
  — node's binary, say — and that would truncate it. Same guard as the move-back already had.
* **Read back by RESOLVING the path** (review finding 7). `hiddenGaps` looked at the top of the
  stack AT each path; a later mount on an ANCESTOR shadows a hide that is still on top of its
  own stack. `resolveMount` walks the mount tree the way path lookup does (of two children of
  one parent covering the path, the shallower was mounted later and shadows the deeper), and
  the home and each hidden dir must land on our ro tmpfs. Logic-tested from explicit mountinfo,
  with a CONTROL showing the old per-path check passes the shadowed case.
* **Fact 6 vs the home.** Recording the home in `WEBCTL_RO_ROOTS` failed every nested call:
  under the 0555 tmpfs `access(W_OK)` is `EACCES` (mode bits first), not `EROFS`. The home was
  then recorded only in `WEBCTL_HIDDEN_DIRS`. ⚠ **Superseded** (gate regression, below): the
  hides are mode 0755 now and the home is in both lists again.
* **The rule** (planKeeps `rule`): a PATH entry or `--keep-ro` that IS the home, contains it,
  or contains / lies inside a hidden dir (nominal AND real paths, existing or not) is refused —
  a PATH entry as FAIL (the caller's env), `--keep-ro` as usage. Messages carry the label and
  position, never the path.
* **Cost** (measured, ~100 PATH entries under the home on the operator host): 1.29 s → 2.27 s
  per `isolated -- true` with stage + move + remount per entry; staging read-only binds
  `--rbind -o ro` and skipping already-ro mounts in makeTreeReadOnly → 1.46 s.
* **Existing arms changed meaning:** a write under the real home is `ENOENT` now, not `EROFS`
  (the dir is not there); the hidden-dir arm's dirs are absent, not empty; the fake-`mount`
  arm skips the hide of `~/.config/webctl` under `--keep ~/.config` (`~/.ssh` gets no mount of
  its own any more); the submount arm re-binds its dir `--keep-ro`.
* **Sabotage (9, all caught):** home not hidden → 8 arms red; PATH entries not re-bound → the
  PATH-dir and refusal arms; the rule off → the refusal arm; `--keep-ro` writable → 3 arms;
  `hiddenGaps` back to top-of-stack → 9 red (incl. the shadow logic arm); `mount` not pinned →
  the no-setpriv arm; under-home hidden dirs never re-hidden → keep-containing + fake-`mount`;
  nesting fact 8 off → its arm; verdict with absolute paths → 2 arms. base's root re-bound rw
  → the base-under-home arm.

### ⛔ pid 1 honoured the CALLER's shell config (review, v0.33.0)

`bash -c PID1_REAPER` as pid 1, with every namespace capability and before any mask: a
`BASH_ENV` script ran; `SHELLOPTS=xtrace` traced the reaper; an exported `wait()`
(`BASH_FUNC_wait%%`) replaced it, losing the exit code; `SHELLOPTS=errexit` + TERM ended the
namespace before the command's trap (143, not 7). ⇒ `-p` (privileged mode). ⛔ Then, while
fixing it: with the env ALLOWLIST `SHLVL` is unset, and with stdin a SOCKET (node's stdio pipes
are socketpairs) bash concludes rshd started it and sources `~/.bashrc` — the operator's real
rc ran as pid 1 (strace: `yarn global bin`, PATH grown by 109 entries). `-p` does not stop
that branch; `--norc` does (measured, all four flag combinations). ⇒ `bash --norc -p -c`.
* The BASH_ENV arm passed VACUOUSLY at first: the rshd branch sources `~/.bashrc` and RETURNS
  before BASH_ENV. It passes `SHLVL=5` now. Every arm uses `--pass-env` for its var — without
  it the allowlist alone stops the var and the arm passes whatever pid 1 is.
* **Sabotage:** no `-p` → BASH_ENV, xtrace/wait, errexit arms red; no `--norc` → the bashrc
  and allowlist arms; plain `-c` on the nested path only → 3 nested arms; on the fresh only → 5.

### ⛔ The early-signal window (review, v0.33.0)

pid 1 of a new PID namespace ignores a signal it has no handler for; bash traps a moment after
unshare's child exists. A TERM in that gap vanished and the command ran to exit 0 — 24/40
(review), here 4/40 fresh and **40/40 nested**. ⇒ forwardSignalsPastUnshare takes `started()`:
until the half under pid 1 reports `started` (fresh: the inner half; nested: the pid-1 helper
with `--status`, writing fd 3 only if it is a pipe/socket, then closing it BEFORE spawning the
command), a signal SIGKILLs unshare (`--kill-child`) and the harness dies by it (`early()`).
* **Arm design:** at 4/40 an 8-run arm would often pass a broken fix. A `bash` first on PATH
  that sleeps 0.3 s before exec holds pid 1 trapless for 300 ms — 16/20 fresh and 20/20 nested
  lost before the fix, 0 after (every run dies by TERM). Plus a nested trap arm (TERM after
  `started` must be FORWARDED: rc 7), which is what catches a helper that never reports.
* **Sabotage:** `started()` ignored → both early arms; helper never reports → the nested trap
  arm; nested early kill without dying by the signal → nested early arm; the fresh not-started
  branch exiting NOT RUN instead of dying → fresh early arm (it now requires death by TERM).

### ⛔ The env is an ALLOWLIST (review, v0.33.0)

37 vars matching `*_API_KEY`/`*_TOKEN`/`*SECRET` reached the arm; `SESSION_MANAGER` carries the
hostname; `CLIAI_<TOOL>_BROWSER_{SSH_,}TARGET` name remote targets. ⇒ `DEFAULT_PASS_ENV` +
`--pass-env NAME|PREFIX_*` (`PASS_ENV_RE`; a bare `*` refused; a SCRUBBED name refused), then
SCRUBBED_ENV removed again. The command gets it from the `__isolated-pid1` helper; every half
before that gets LESS (`PRIVILEGED_PASS_ENV`, next section). Nested: its own `--pass-env`.
* **The gate's tests** read `WEBCTL_TEST_FAKE_*` (world().env() renames `FAKE_*`): the gate's
  production call passes no `--pass-env`. Without the rename: 7 gate tests red.
* **Sabotage:** the command env back to the full env → the nested arm red (the fresh path is
  still filtered at the spawn — two layers, by design); `--pass-env` ignored → 2 arms; scrub
  only before → the `XDG_*` prefix assertion; validation off → the validation arm (×2).

### ⛔ Loader vars reached the PRIVILEGED halves (review of 5773fb8, v0.33.0)

The allowlist was applied to the WHOLE chain, so the chain got exactly what the command got —
including `NODE_OPTIONS` (default-passed) and anything `--pass-env`'d. **Measured by the
review:** `NODE_OPTIONS=--require preload.cjs` ran in pid 2 (`__isolated-inner`) as namespace
root, CapEff full, the real home readable, `/tmp/.X11-unix` reachable — before any mask. Here,
before the fix: the preload ran in the inner node and the nested pid-1 helper; `--pass-env
'LD_*'` with `LD_DEBUG=files` showed glibc loading the caller's LD_* into unshare, bash, ip,
every mount, setpriv, unshare -U and the inner node (LD_PRELOAD into setpriv would run with
the capabilities it is about to drop).
* ⇒ **Deny by default for the privileged halves:** `PRIVILEGED_PASS_ENV` = PATH, HOME, USER,
  LOGNAME, LANG, LC_*, TERM, TZ, TMPDIR, WEBCTL_*. A loader denylist (NODE_OPTIONS, NODE_PATH,
  LD_*, GCONV_PATH, LOCPATH, BASH_ENV, ENV, PERL5OPT, PYTHONSTARTUP, …) cannot be complete.
* The command's env (`isolatedEnv`, markers included) is computed ONCE on the host and travels
  in the fd-4 plan (`env`, validated by `isEnvObject`); the nested path computes it from its own
  `--pass-env`. **Only the `__isolated-pid1` helper applies it** (`--env <fd>`, a pipe from
  runCommand), after setpriv/unshare -U. ⚠ So the FRESH path now has that helper too:
  `setpriv … unshare -U … -- node SELF __isolated-pid1 --env 3 -- <cmd>` (it was `-- <cmd>`).
  One more node start per call; exit codes and signals behave as on the nested path (the
  helper returns 128+n; the inner half re-raises). The helper refuses — never runs the command
  with the privileged env — when the env does not arrive.
* **Arms:** a NODE_OPTIONS preload appends `{argv, CapEff}` per node: none may name
  `__isolated-*` or hold a capability; CONTROL in the same run: the fresh AND nested commands
  print SEES-NODE-OPTIONS and their preload ran. `--pass-env 'LD_*'` + `LD_DEBUG=files`
  (`transferring control:` per process): none of unshare/bash/setpriv/mount/ip, one node (the
  harness itself, the caller's own process); CONTROL: the command `true` got it. Skipped by
  name where glibc's LD_DEBUG output is not produced.
* The orphan CONTROL ("node as pid 1 leaves a zombie") ran `__isolated-pid1` directly; it now
  needs `--env`, so the control is an inline `node -e` spawn-and-wait — the same shape.
* **Sabotage (all caught, both arms each):** the unshare spawn given `cmdEnv`; runCommand's
  chain given `env`; NODE_OPTIONS + LD_* added to PRIVILEGED_PASS_ENV; the helper spawning
  without `env` (the CONTROL half: the command no longer sees NODE_OPTIONS).

### ⛔ The verdict line named every PATH re-bind (review of 5773fb8, v0.33.0)

`isolated: home HIDDEN; re-bound read-only: …` listed EVERY `~/…` re-bind — ~95 PATH entries
on an operator host, private repo names among them — and the gate tees stderr into its logs.
base is public; verdicts carry COUNTS. ⇒ `verdictLine`: listed by path only what the caller
NAMED (`Bind.named`: cwd, `--keep`, `--keep-ro`); PATH entries COUNTED (`N PATH entries`); the
other implicit re-binds by LABEL (base's repo root, node, the command, WEBCTL_UNSHARE_BIN); a
pointer `— WEBCTL_ISOLATED_VERBOSE=1 lists every path` whenever something was counted. The
opt-in restores the full `~/…` list. ⚠ A named path an implicit re-bind CONTAINS is merged into
it by planKeeps and is then counted, not listed.
* **Arm:** a PATH dir `~/private-repo-zq7x/bin` (and `~/bin`) under a fake home: by default
  neither name is on stderr and the line reads `~/data, 2 PATH entries`; CONTROL with the
  opt-in: both listed. The base-root arm now expects `base's repo root` (its label).
* **Sabotage:** verbose always on → 3 arms; the named filter ignored → 3 arms; the cwd not
  marked named → SURVIVED at first (no arm looked at a cwd's verdict) — the cwd-under-home arm
  now asserts `writable: ~/…<cwd>`, and catches it.

### ⛔ A cwd at a hidden dir was re-exposed WRITABLE (review of 5773fb8, finding 8b)

hiddenGaps exempted EVERY bind exactly at a hidden dir, and the cwd is a writable bind. Measured
here before the fix: cwd = `~/.ssh` → the command ran, the verdict said `writable: ~/.ssh`;
cwd beneath `~/.config/webctl` → ran, that subtree writable. The docs said only an explicit
`--keep` re-exposes a hidden dir. ⇒ planKeeps REFUSES a cwd at or beneath a hidden dir
(`noHidden`, FAIL, the rule named, no path) — the same hideRule the PATH/`--keep-ro` refusals
use; and the post-check exempts only `plan.exempt` (explicit `--keep`s), so no implicit
re-bind (base's root, a future one) can sit on a hide unnoticed.
* The keep-beneath arm used to assert "a cwd beneath a hidden dir still works"; it now runs its
  command-beneath-a-hidden-dir check from an ordinary cwd.
* **Arms:** cwd = `~/.ssh` and cwd beneath `~/.config/webctl` → FAIL, nothing written (CONTROL:
  an ordinary cwd under the home runs and writes); base's root AT `~/.config/webctl` → refused by
  the post-check. ⚠ The latter arm first "failed" on `SAW-HIDDEN` — the JSONL record echoes the
  command's argv; it matches the whole line now.
* **Sabotage:** refusal off → 2 arms; the cwd not flagged → 2 arms; the post-check exempting
  every bind again → the base-root arm. (⚠ The post-check narrowing was written before its arm;
  the arm was then confirmed red against the old exemption by that sabotage.)

### A nested keep under the outer's hidden home (review of 5773fb8, finding 8a)

A nested `--keep <a path under the outer call's hidden home>` failed `--keep #1 does not
exist` (exit 3) — true inside, and it sent people looking for a typo. ⇒ On the nested path, a
`--keep`/`--keep-ro` that does not exist here AND lies under a recorded `WEBCTL_HIDDEN_DIRS`
entry is a usage refusal saying the OUTER call hides it and to keep it there; no path printed.
* **Arm:** both options, refused with that reason (and not "does not exist"); CONTROL: the outer
  call keeps the dir → the same nested keep runs.
* **Sabotage:** the check off → arm red; the existence test dropped (an outer-kept path refused
  too) → arm red (its CONTROL half).

### Every forwarder is installed BEFORE its child (review of 5773fb8, finding 5)

Two gaps where a node half had NO listener while a signal could reach it: the inner half did
`process.off(early)` and only then did runCommand install its forwarder (after its spawn); the
pid-1 helper wrote `started` — the caller's cue to start forwarding to it — before any handler.
With no listener, node's DEFAULT disposition applies: the half dies by the signal, the command
(spawned or about to be) is orphaned under pid 1, pid 1's `wait` returns, the namespace ends and
the command is SIGKILLed — its trap never runs. (The caller still dies by the signal, so it is
"trap skipped", not "signal lost".) The same shape existed at every `spawn` → `forwardSignals*`
pair (the fresh unshare spawn, runCommand): a TERM between them killed the harness and left
unshare orphaned. ⇒ `forwarderBeforeSpawn(deliver)`: install first, spawn, then `attach(child)`;
a signal before `attach` is BUFFERED and delivered then. forwardSignals / forwardSignalsPastUnshare
are built on it; every call site installs before spawning; the inner half removes `early` only
AFTER runCommand returned (its executor installed the forwarder synchronously) — a listener is
present throughout. In the helper the forwarder precedes the `started` write.
* **Why no integration arm.** Each gap is a few synchronous statements (one `spawn()` — fork+exec
  — wide). Nothing outside the process can widen it: the slow-`bash` shim of the early-TERM arms
  delays pid 1's traps, which is BEFORE these windows, and spawn() returns once exec succeeded,
  so a slow command does not widen it either. Measured: putting either old order back (handler
  after `started`; `off(early)` before runCommand) SURVIVES all 14 signal arms. ⇒ A logic arm
  pins the mechanism instead: `forwarderBeforeSpawn` buffers a SIGHUP emitted before `attach`,
  delivers it on `attach`, delivers later ones at once, records `last()`, and `remove()` leaves no
  listener (SIGHUP only — the test runner may own INT/TERM in its process).
* **Sabotage:** pending dropped → logic arm; `attach` not flushing → logic arm; the old orders →
  SURVIVE (above, by construction — this is the reasoned part).

### Host policy: AppArmor, and `WEBCTL_UNSHARE_BIN` (v0.33.0)

`kernel.apparmor_restrict_unprivileged_userns=1` (reported from an Ubuntu 24.04 host) makes
`unshare -r` fail on uid_map with EPERM. `userNamespaceRefusal(stderr, sysctlPath)` names it a
HOST POLICY with both fixes; the sysctl path is a PARAMETER so the logic arm never reads the
host. The fresh path cannot read unshare's message (its stderr is the caller's), so after a
failure it probes `<bin> -r true`; privilegeDrop has the stderr already. `WEBCTL_UNSHARE_BIN`:
validated (absolute, regular file, X_OK; the refusal names the rule, not the path), used for
the outer spawn, the privilege drop and its probe, and every nested call; re-bound read-only.
* **Not integration-tested:** the AppArmor branch end to end (it needs the host sysctl at 1).
* **Sabotage:** fresh spawn ignoring the bin / the drop ignoring it / no re-bind → the wrapper
  arm (it counts 1 `-rnm` and 4 `-U` invocations); no validation → the bad-bin arm; sysctl
  ignored → the logic arm.

### Stripped markers, and version skew (v0.33.0)

* **Measured:** inside `isolated`, `env -u` of all six markers, then `isolated` → the FRESH
  path runs, inside: a new netns and pidns, the home hidden again (realIdentity accepts the
  hidden home: its tmpfs is owned by the outer root = our uid), `isolation-check` PASSes. Never
  "only inherited". The verdict states it from the kernel alone (MASK_SOURCE on /run and /tmp,
  only `lo`). Sabotage: detection off → the arm red.
* **Skew:** a ≤ v0.32.0 outer records no `WEBCTL_HIDDEN_DIRS`. Still refused (rc 2); when that
  is the ONLY failing fact the reason says "upgrade the outer". On the host (other facts fail
  too) it does not. Sabotage: message off, or shown whenever the var is absent → the arm red.

### ⛔ PATH picked the binary a PRIVILEGED half ran (re-review of v0.33.0)

The loader-var fix cut the privileged env to an allowlist — but kept PATH, and the tools were
still FOUND on it: `ip` (`execFileSync('ip')`), every `mount`, `setpriv` and the default
`unshare` by name, through the caller's PATH, empty and relative entries included; pid 1's `bash`
by an absolute-entries-only scan, which npm's prepended `<pkg>/node_modules/.bin` defeats. The
re-review measured a fake `ip` in the cwd + `PATH=":$PATH"` running as namespace root, CapEff
full, before any mask, listing the real home. The cwd is writable INSIDE, so run N plants it and
run N+1 executes it.
* **Arm, before the fix** (fakes that log `HIT <name>` and exec the real tool; 3 PATH shapes ×
  fresh/nested): empty entry → fresh `unshare, ip, mount, setpriv`, nested `setpriv, unshare`;
  relative `bin` → the same; absolute dir first → fresh `unshare, bash, ip, mount, setpriv`,
  nested `setpriv, unshare, bash`. After: none, in all six. CONTROL in the same runs: the
  command's PATH is byte-identical to the caller's and it runs the caller's `caller-tool` by it.
* ⇒ `SYSTEM_TOOL_DIRS` = `/usr/sbin /usr/bin /sbin /bin`; `systemTool(name)` returns the first
  executable regular file there, as that path — not realpath'd, a busybox `ip` dispatches on its
  name. `privilegedTools()` resolves unshare (unless `WEBCTL_UNSHARE_BIN`), bash, setpriv, and on
  the fresh path mount + ip/ifconfig, ON THE HOST before unshare; missing → FAIL naming the tool
  and the dirs. The fresh plan carries them (`tools`, validated by `isTools`); the inner half
  sets `MOUNT.bin` from it and passes `lo` to bringLoUp; privilegeDrop takes `tools`. And
  `privilegedEnv` sets `PATH=SYSTEM_PATH` — the second layer.
* **The `mount` pin is gone.** It bound PATH's `mount` read-only under the new /run because a
  PATH dir under the home vanished mid-masking — and it was itself a PATH lookup run as
  namespace root. A system dir never vanishes.
* ⚠ **The fail-closed arms had to move.** Twelve of them faked a tool by putting a dir FIRST on
  PATH (no setpriv, a flag-ignoring setpriv, a too-old unshare, no bash, the slow-bash early-TERM
  shim, …) — the very mechanism this closes. They now bind the fake OVER the system copy in a
  throwaway `unshare -rm` (`withBinds`, `overTool`; a non-executable file = "missing"; the real
  tool stays reachable at a bound copy where the fake must exec it). The slow bash's interpreter
  is that copy, since `/bin/sh` may be bash; EARLY_CMD is node for the same reason; the probe
  matches `…/unshare` (argv[0] is now absolute).
* ⚠ **Cost.** A host whose util-linux/bash/iproute2 live only under `/usr/local` or a Nix profile
  now FAILs; `WEBCTL_UNSHARE_BIN` covers unshare alone. Not widened: every extra dir is one more
  place a privileged binary can be planted.
* **Sabotage:** `systemTool` scanning `process.env.PATH` → arm red (the absolute-dir case runs a
  planted `mount` that vanishes with /tmp: the run FAILs); `bringLoUp` by name + the caller's PATH
  in `privilegedEnv` → arm red (`HIT ip` ×3); the caller's PATH in `privilegedEnv` ALONE →
  SURVIVES, by construction: no privileged half resolves a name any more — it is the second layer.

### A shadowed stack at a re-bound path read as "still WRITABLE" (found fixing the carry below)

A call nested in `isolated` masks /tmp AGAIN. A read-only re-bind at a path where the OUTER call
already had a mount (base's root, which the outer re-bound writable as its cwd) then leaves TWO
stacks at that path in mountinfo: the outer's, whose parent is the old /tmp mask — unreachable
now — and ours, under the new /tmp. `reachableMountsUnder` walked every bottom ("over-covering
is safe"), and `readOnlyGaps` reported the outer's rw mount as a gap: the stripped-markers call
FAILed "1 mount(s) … still WRITABLE" whenever its cwd was not base's root (measured: the carry
arm below, before the carry existed). ⇒ keep the stack `resolveMount` lands on; over-cover with
all bottoms only when none matches.
* **Logic arm** (explicit mountinfo): the re-masked case selects only ours (and flags our rw
  submount); CONTROL: without our re-mask, the outer stack is the live one. Red before.
* **Sabotage:** the filter off → the logic arm red.

### ⛔ Stripped markers hid what the OUTER call had re-bound (gate regression, v0.33.0)

Measured by the lead on the release gate: a nested call whose WEBCTL_* markers were stripped
takes the FRESH path and hid the home again, so the consumer repo (under `~/.cache/…`) and run
home the gate keeps, and the outer's cwd, vanished — a consumer suite failed 8 tests `Cannot find
module '<repo>/tools/isolated-run.mjs'`; the verdict read `… writable: nothing`. v0.32 hid
nothing, so it did not break.
* **Arm, before the fix** (fake home; outer `--keep ~/keep-rw --keep-ro ~/keep-ro --keep
  <scratch>`; inner stripped, cwd = scratch): `RW-READ ENOENT, RW-WRITE ENOENT, RO-READ ENOENT,
  RO-WRITE ENOENT`. ⚠ It first FAILED outright on the shadowed-stack false gap (previous
  section) — the carry's arm found that one. After: `ok, ok, ok, EROFS`, `~/.ssh` ENOENT; the
  verdict counts `1 outer re-bind` on each side, no path.
* ⇒ `outerRebinds(mounts, home, masked, tmp)` (pure, exported): null unless the mount table
  PROVES an outer call — our MASK_SOURCE tmpfs on top of every masked dir AND our read-only
  HIDE_SOURCE tmpfs on top AT the home; runIsolated adds lo-only and a mapped uid_map. Then every
  mount strictly under the home or /tmp that `resolveMount` lands on (visible, not shadowed or
  stacked over), minus our hides and masks, with `rw = !ro`. runIsolated drops one exactly AT a
  hideRule path (it would trip the post-check; noted) and non-dir/non-file ones (a /dev/null
  cover), and passes the rest to planKeeps as implicit, `quiet` (the outer call already noted
  them) items labelled `outer re-bind #n` — COUNTED by verdictLine (`COUNTED_BINDS`).
* **Why /tmp too:** the fresh call re-masks /tmp exactly as it re-hides the home; an outer
  `--keep /tmp/x` or a /tmp cwd vanished the same way.
* ⚠ **Counts can shift between the lines:** a PATH entry that reaches a re-bound dir through a
  symlink in the hidden home is skipped inside (the symlink is gone) and its real path arrives
  as an outer re-bind instead — measured on the operator host: `91 PATH entries` outside,
  `89 PATH entries, 2 outer re-binds` inside, the same 91 paths (verbose diff).
* **CONTROL arm:** not nested (a tmpfs under the fake home, visible to the caller) → `SUB ENOENT`
  inside, no `outer re-bind`. **Logic arm:** the carry with modes; null for each missing proof
  (home not hidden by us, /tmp not ours, a rw hide, something on top of the hide, no home).
* **Sabotage (all caught):** the hide-at-home proof dropped → logic; every carry `rw: true` →
  logic + the integration arm; the resolveMount (visible) filter off → logic; hides not excluded
  → logic; the carry not passed to planKeeps → the integration arm.
* ⛔ **AT or WITHIN (review F2, reasoned).** The drop was `hideRule.includes(b.p)` — equality —
  while planKeeps's rules use isWithin: an outer `--keep ~/.ssh` was dropped with a note, an
  outer explicit `--keep ~/.ssh/<sub>` (or `~/.config/webctl/<sub>`) was CARRIED rw, silently,
  into a call that never asked for it. ⇒ `inHidden` = isWithin any hideRule dir, for the drop
  AND the note's count (`N outer re-bind(s) AT or WITHIN a hidden dir … not carried`).
  **Arm** (fake home; outer `--keep ~/.ssh/sub --keep ~/.config/webctl/sub --keep ~/plain`, inner
  stripped): before, inner `ok ok ok`; after `ENOENT ENOENT ok` (CONTROL: `~/plain` still
  carried), the note with `2`, no path. **Sabotage (caught):** the carry by equality → the arm;
  the note's count by equality → the arm.

### ⛔ xq could not run inside (gate regression, v0.33.0)

Measured by the lead on the release gate: two private consumers' documented no-host-literals
check (`xq machine ls --json`, `UV_NO_CACHE=1`) went PASS → NO VERDICT / FAIL. `~/.local/bin/xq`
is a symlink into a git checkout elsewhere under the home; the PATH entry is re-bound, the
symlink dangles. Re-binding only the script fails `No module named 'lib'` (xq imports its repo's
`lib/`), and a nested `--keep-ro` of a path the outer hid is refused — a lane cannot fix it.
* **Arm, before the fix** (fake home; `~/.local/bin/xq` → `~/src/xq-checkout/bin/xq`, a script
  that cats `../lib/data.txt` through its real path; `~/.local/bin/other` → another checkout):
  `XQ FAILED ENOENT`. After: `XQ XQ-LIB-READ`, a write into its lib `EROFS`, `OTHER FAILED`, the
  other checkout `ENOENT`, `~/.ssh` `ENOENT`; the verdict says `xq's root`, never the name.
  ⚠ The arm's PATH is the fake `~/.local/bin` + `/usr/bin:/bin` ONLY: with the caller's PATH, the
  dangling fake fell through to the REAL `xq` further on PATH (it ran and printed its help).
* ⇒ `xqRoot(home, hideRule)`: the first `xq` on the caller's PATH (absolute entries), realpath'd;
  if under the home, walk up from its dir for `.git` (the home included); none → its dir.
  Refused (a note, no path; xq then does not run inside) when the root IS the home or contains
  it, or lies inside or contains a hideRule dir. Re-bound read-only as an implicit item, label
  `xq's root`.
* ⛔ **Deliberately NOT generic.** Following every PATH symlink to its git root would re-expose
  dozens of repos on an operator host (~95 PATH entries there, many symlinked checkouts) — the
  very exposure the verdict-count fix keeps out of logs would then be readable by the arm. One
  named tool, base's own runtime layer, is the scope; another tool needs its `--keep-ro`.
* **Sabotage (all caught):** a generic symlink-following rule → the main arm (`OTHER` ran); xq's
  root writable → the main arm; the hidden/home check off → the refusal arm; the root marked
  `named` (listed by path) → the main arm.

### Generation 6 (v0.33.0)

`isolated` CHANGED behaviour — the env allowlist (a lane's own vars now need `--pass-env`), the
hidden home, system-dir tools — so the marker moves 5 → 6, per its own rule ("bump when a check's
BEHAVIOUR changes"). The v0.30 note below ("Generation unchanged (4). These verbs are additive")
was right for ADDING the verb; this changes what it does. Practical reason: a lane must know
whether `--pass-env` exists before passing it — generation 5 refuses the unknown option (usage,
exit 3) — and `require-generation 6` is the question that answers it on every pin (CHANGELOG:
bash and node snippets). The test that pinned "stays at 5" now pins 6 and the snippet's exits.
* **Measured, the bash snippet on both pins:** v0.32.0's harness answers `require-generation 6`
  with 1 and `isolated --pass-env X` with 3 (the refusal the snippet avoids); the snippet then
  runs `isolated -- true` → 0. On this branch it passes `--pass-env 'CGWC_*'` and the command sees
  `CGWC_X=1`. **Sabotage:** the constant back to 5 → the generation arm red.

### runCommand: a synchronous spawn throw (re-review, LOW)

`spawn()` THROWS — rather than emitting `'error'` — for an argv node refuses (a NUL byte) and for
an exec failure outside node's "run-time" list (E2BIG: the chain adds pid 1's reaper and the
helper's argv to the command's, so a command just under the limit can tip over it here). The
forwarder is installed first (finding 5), so the throw rejected runCommand's Promise — a stack
trace, no `FAIL  isolated:` line — and left the forwarder's three listeners on the process.
⇒ try/catch around the spawn: `fwd.remove()`, then `NOT RUN: cannot start '<argv[0]>': …`, 127
(the code the async `'error'` path already used). The fresh path's own unshare spawn already
had this.
* **Arm:** `runCommand(['/bin/true', 'nul\0inside'])` in a child process (report() writes to
  stdout/stderr), exported for it: resolves 127, does not reject, listener counts unchanged,
  the FAIL line printed. Red before (`REJECTED`). E2BIG is not driven end to end: sizing an argv
  that fits node's exec but not the chain's is host-dependent.
* **Sabotage:** `fwd.remove()` dropped from the catch → the arm red (forwarder left installed).
* ⛔ **127 → EXIT.fail (review F3).** The fresh path's unshare spawn fails 1; runCommand's catch
  and its async `'error'` said 127 — "command not found" — about the isolation CHAIN (setpriv,
  argv[0]), not the command. Both now `EXIT.fail`, the message naming `(the isolation chain)`.
  The arm now expects 1, and calls `runCommand(['/nonexistent-webctl-chain'])` for the async
  path (`ASYNC 1`). Before: 127 / 127.
* ⛔ **runPid1 had no catch (review F3).** The helper that spawns the COMMAND: a synchronous throw
  rejected its Promise. Driven end to end after all, here: an env var of 256 KiB (over
  MAX_ARG_STRLEN, 128 KiB per string) passes the env PIPE untouched and makes the command's
  execve fail E2BIG, which node THROWS. **Arm:** runPid1 (exported for it) in a child, the env
  on fd 3: before, it REJECTED (`E2BIG`); after, resolves 1, listener counts unchanged,
  `FAIL  isolated: NOT RUN: cannot start '/bin/true': spawn E2BIG — …`. Its async `'error'`
  (the command absent inside) keeps 127: that one IS the command not found.
* **Sabotage (all caught):** runPid1's `fwd.remove()` dropped → its arm; runPid1's code 127 →
  its arm; runCommand's catch 127 → its arm; runCommand's `'error'` 127 → `ASYNC` red.

### TERM ×3 → 143 instead of the trap's code (re-review, LOW; pre-existing)

The re-review saw 4/25 runs (6/25 on the old tree) where TERM ×3 sent quickly after the
command's trap was set came back 143, not the trap's 7. **Reproduced here** with the TERMs 60 ms
apart: 9/25 fresh and 10/25 nested ended by SIGTERM (0, 3, 15, 30, 100 ms gaps: ≤ 1/25). The rate
depends on where the later TERMs land relative to the command's exit (a `sleep 0.1` loop defers
the trap by up to 100 ms).
* **Traced** (`strace -f`, one failing run): the command trapped TERM #1 and exited 7; the pid-1
  helper and then the inner half (pid 2) reaped their children and REMOVED their forwarders —
  restoring node's DEFAULT disposition — and TERM #3, forwarded by pid 1's bash, reached the
  inner half during `process.exit`'s teardown: `killed by SIGTERM`. pid 1 exited 143, unshare
  passed it on, and the harness (which had forwarded TERM) re-raised it.
* ⇒ **`quietLateSignals`**: in the CLI only (`LATE.cli`, set by the dispatcher — never on import,
  an importer's own Ctrl-C must work), removing a forwarder leaves a no-op listener until the
  process exits; `loudAgain()` restores the default right before a deliberate re-raise
  (exitOrDieBy, dieByForwarded). Deterministic: there is no longer an instant with neither a
  forwarder nor a listener. After: 150/150 runs → 7 (gaps 45/60/80 ms, fresh and nested).
* ⚠ A second, narrower path fixed on the way (found by reading, while the trace was pending):
  forwardSignalsPastUnshare treated "unshare has no child" as EARLY even after `started` — i.e.
  pid 1 had already EXITED — and SIGKILLed unshare, so the harness died by the signal. It now
  records the signal and forwards nothing. Alone it did NOT move the 60 ms rate (10/25, 7/25
  measured with only it applied): the trace's cause was the one above.
* **Arms:** TERM ×3 at 60 ms, 6 runs per path, every outcome 7 (statistical: before, ~40% per
  run ⇒ a false pass ≈ 0.6^12); a logic arm drives forwardSignalsPastUnshare (exported) with a
  real, childless stand-in for unshare: after `started` nothing is killed and it is not early;
  CONTROL before `started`: SIGKILL, early.
* ⚠ **The invariant it rests on (review F4), now stated at `LATE.cli = true`:** every verb ends
  in `process.exit`, one forwarder per process — so the no-op listeners live only while the
  process is exiting. A future LONG-LIVED verb must clear `LATE.cli` (or `loudAgain()`) once its
  forwarder is removed, or it ignores Ctrl-C for the rest of its life. A comment, not an arm:
  no such verb exists to test.
* **Sabotage (all caught):** `LATE.cli` off → the TERM ×3 arm (`7 SIGTERM 7 7 SIGTERM SIGTERM`);
  the old "no child ⇒ early" → the logic arm; no `loudAgain()` before a re-raise → the
  early-TERM and Ctrl-C arms (5 red: the harness no longer dies by the signal).

### ⛔ pid 1's `wait` lost the command's status to a late signal (bash; v0.33.0, pre-existing)

Seen as a flake of the `TERM ×3 (60 ms apart)` arm: `127` in 1 of 6 runs; reproduced 1 of 150
under 6× parallel load, stderr `webctl-isolated-pid1: line 7: wait: pid 2 is not a child of this
shell`. In plain bash too (no namespace, a node child: 13 of 240), so not pid-1 specific.
* **Not the window first assumed.** "wait completes, a trap runs after it, the loop waits again
  on a forgotten pid" is harmless on bash 5.3: a collected pid's status is kept, and `wait`
  answers it again (measured: three `wait`s in a row → 7, 7, 7). A splice-a-`sleep`-after-`wait`
  arm built on that theory PASSED on the old code — dropped.
* **Traced (strace -f, a failing run):** two TERMs interrupted `wait` (`wait4 … ERESTARTSYS`,
  each forwarded); the third wait4 RETURNED the child (`WEXITSTATUS == 7`) and SIGTERM was
  delivered in the same instant; bash's trap handler jumped out of the `wait` builtin before the
  status was recorded → `wait` said 143, the trap's `kill` got ESRCH, the next `wait` →
  `wait4(-1, WNOHANG) = ECHILD` → "not a child" → `exit_group(127)`. The 7 existed nowhere.
  ⇒ the proposed check — `kill -0 "$c"` after each `wait`, break when gone — would turn the 127
  into 143: the child IS gone, its status with it. Logged per wait: `143 t=1` ×3, then `127`.
  A burst also made a RE-`wait` of an already-recorded status come back 143 (`W rc=7`, then
  `W rc=143` with no trap logged in between).
* ⇒ **pid 1 never blocks in `wait` while a signal can arrive.** It POLLS: `kill -0 "$c"`, then
  `read -t 0.02 -u 9` on its own read-write end of `<(:)` (a pipe nobody writes: a sleep with no
  fork; fd 9 opened AFTER the child was forked, so the child never has it). A trapped signal
  interrupts the read, so forwarding stays prompt. The child's exit is reaped by bash's SIGCHLD
  handler — outside `wait` — and recorded. When `kill -0` fails (a zombie still passes; only
  bash reaps it, so failing means bash holds the status) there is nothing left to forward:
  `trap '' INT TERM HUP`, then ONE `wait`, which nothing can interrupt. `trap : CHLD` does NOT
  wake `read -t` (measured: the full timeout), hence the 20 ms poll. No /dev/fd → the old loop.
  Bash ≥ 5.1 (`wait -p`) is NOT required.
* ⚠ **pid reuse:** in our PID namespace pid 1 is the only reaper and pids are allocated upward,
  so `$c` can name another process only after bash reaped it AND pids wrapped (pid_max); even
  then the poll lasts only while that process lives. Same in plain bash.
* **Arm (deterministic in effect, statistical in form):** PID1_REAPER in plain bash over a child
  that traps TERM → `exit 7`; once it is READY, 30 TERMs 1 ms apart; 150 runs, all must be 7.
  The window is inside bash, so no splice can widen it; the burst hits it. **Before: 8 of 100**
  wrong sequentially (3× 127, 5× 143); 2–6% under load. After: 0/100 sequential, 0/1200 under
  5× load (sh and node children), 150/150 in the arm. A false pass of the old code ≈ 0.92^150.
  End to end (`isolated -- sh -c <trapper>`, TERM ×3 60 ms apart, 6× parallel): before 1/150
  wrong, after **0/300**.
  Second arm: no signal → the status as is (5), and fd 9 absent in the child.
* **Cost:** ≈ 6 ms more per run (100 sequential: 2.16 s → 2.57 s, the old one also losing 8).
* **Sabotage (all caught):** the old loop restored → the burst arm; the poll replaced by
  `wait` (traps still ignored after) → the burst arm (`not a child`); `trap ''` dropped → the
  burst arm; fd 9 opened before the fork → the fd arm.

### ⛔ The 0555 hide answered a write CHECK with EACCES (gate regression, v0.33.0)

Measured by the lead on the release gate — 8 of a consumer lane's 10 failures (earlier blamed
on the stripped-markers carry; only 1 was). A ≤ v0.32 harness nested inside v0.33 with its
markers stripped takes ITS fresh path, records the home as a read-only ROOT, and its
isolation-check judges each root by `access(W_OK)`: anything but `EROFS`/`ENOENT` is
"WRITABLE". Our hide tmpfs was mode 0555: DAC runs before the read-only check, so `EACCES` →
`1 of 1 protected root(s) — the home directory — are WRITABLE here`. A ≤ v0.32 read-only home
answered `EROFS`. (A real create was always `EROFS`: open(O_CREAT) takes the mount write lock
first.)
* ⇒ **`HIDE_MODE = '0755'`** for every hide (home and hidden dirs): owner-writable by MODE —
  the owner is the namespace root, i.e. the real uid — read-only by MOUNT. And the home is
  recorded in `WEBCTL_RO_ROOTS` again (first), as ≤ v0.32 did, so our own fact 6 checks it too.
* **Arm** (fake home; `--keep ~/.config` so `~/.config/webctl` has its own hide; fresh AND
  nested): `access(W_OK)` and an exclusive create on the home and on that hidden dir are all
  `EROFS`. Before: `HOME-ACCESS EACCES`, `HIDE-ACCESS EACCES` (creates `EROFS`).
* **Measured manually, not a repo test** (it needs git history): a throwaway worktree of
  v0.31.0 under scratch, `--keep`'d by a v0.33 outer; its `isolated -- isolation-check 4927 4937`
  with the six markers stripped → **PASS** (mode 0755); with 0555 → `FAIL … 1 of 1 protected
  root(s) — the home directory — are WRITABLE here`, as the lead measured. With the markers
  KEPT: PASS at 0755; at 0555 *with the home back in RO_ROOTS* → NO VERDICT (the same EACCES
  through the recorded root) — the two changes only work together. Re-measured with the v0.31.0
  worktree UNDER THE HOME (the lead's layout; `git worktree add --detach`, removed after with
  `git worktree remove --force`): identical — 0555 stripped FAIL / kept NO VERDICT; 0755 PASS / PASS.
* **Sabotage:** `HIDE_MODE` 0555 → the arm red, and 25 more — every arm with a nested call
  (the nested proof now reads the recorded home root as `WRITABLE`). Restored: the 77 nesting /
  home / hidden arms pass.

### ⛔ xqRoot followed a PLANTED `xq` (review F1, HIGH, v0.33.0)

Measured by the review: xqRoot took the first `xq` on the CALLER's PATH — and npm puts the
writable `<cwd>/node_modules/.bin` there. A mutated test writes `node_modules/.bin/xq -> <any repo
under the home>/<an executable>`; the NEXT run re-binds that repo's whole git root read-only
(no `.git` → the executable's dir, e.g. a tool's config dir). A private repo went from hidden to
11 entries visible; the verdict said only "xq's root" both times.
* ⇒ **(a)** the first `xq` on PATH is IGNORED when any hop lies — lexically or really — in a place
  a run can write: the PATH entry, each symlink of the chain (walked hop by hop with
  readlink, not only realpath'd: a link in /tmp between two legitimate ones is the case
  realpath hides), and the real file (the walk's last hop). The places: the cwd, every `--keep`
  AND `--keep-ro` (the caller can write them), `/tmp` (realpath'd), `os.tmpdir()` (TMPDIR),
  `/var/tmp`, `/dev/shm` (both shared with the host inside), a throwaway HOME, the outer call's
  writable re-binds. **(b)** the real file's basename must be exactly `xq`: a mutant cannot create
  files outside its writable dirs, so it can only point at an EXISTING file, and one named `xq`
  is xq's checkout or nothing. **(c)** ignored → no re-bind, a note by LABEL
  (`xq ignored: found in a writable location` / `…: not named xq`), never the path. The note
  is printed only when the real file is under the home (otherwise nothing would be re-bound).
* The FIRST `xq` is judged, never skipped past: it is the one the command's own PATH lookup
  finds, and falling through to a later one would make the planted entry a way to choose
  which `xq` is trusted. (A DANGLING first candidate still falls through, as before: statSync.)
* **Arms (one test, 6 cases; fake home):** a link at `<cwd>/node_modules/.bin/xq`, in a `--keep`
  dir, in a `--keep-ro` dir, in a dir under /tmp, an intermediate hop in /tmp
  (`~/.local/bin/xq → /tmp/…/xq → <repo>/bin/xq`), and a `~/.local/bin/xq` → `<repo>/bin/some-tool`
  — each into a private git repo under the home. **Before: all 6 `SECRET-READ ok`**, verdict
  `re-bound read-only: xq's root`. After: `ENOENT`, the note, no path. **CONTROL** per case
  (5 of 6): the same repo through the legitimate `~/.local/bin/xq → <repo>/bin/xq` → `ok`, no
  note. The existing main xq arm stays the readable / `EROFS`-on-write control.
* **Sabotage (all caught):** (a) off → cwd case; the hop walk off (PATH entry only) → the
  intermediate-link case; (b) off → the not-named-xq case; `--keep-ro` dropped from the places →
  its case; `--keep` dropped → its case; the cwd dropped → its case; /tmp and TMPDIR dropped →
  the /tmp case. A separate final-file-dir check was REMOVED: its sabotage passed — the walk's
  last hop realpaths that same dir.

### ⛔ xqRoot: three more writable places, and `..` judged as the kernel resolves it (review round 4, F1/F3/F4)

* **F1 — a RELATIVE `--keep`** (`--keep ../sibling`) was skipped (`!path.isAbsolute(w)`) while
  planKeeps binds `path.resolve()` of it read-write: a planted `sibling/bin/xq` on PATH passed.
  ⇒ every non-empty entry is `path.resolve`d (and realpath'd). The audit found one more of the
  same: a relative `TMPDIR` (os.tmpdir() returns it as given) — covered by the same change.
* **F3 — the list was fixed.** A user-owned dir outside the home (`/opt/x`, `/mnt/data`) is
  writable inside exactly as on the host: the command runs as the real uid and nothing outside
  the home is re-mounted. ⇒ a hop dir whose REAL path is outside the home and passes
  `access(W_OK)` counts as writable. Inside the home access() would say yes to everything, so
  there the list still decides (the home is hidden; only the listed re-binds are writable).
  ⚠ Under an outer `unshare -r` access() runs as the namespace root: it over-approximates
  (a user-owned 0555 dir counts as writable) — the safe direction.
* **F4 — lexical `..`.** `path.join(d, 'xq')` and `path.resolve(dirname, readlink())` normalise
  `..` lexically; the kernel resolves it AFTER following the link before it. So
  `~/.local/bin/xq -> sym/../xq` with `sym -> /tmp/w/d` was judged as ITSELF (64 hops of the
  same non-writable dir) while execvp ran `/tmp/w/xq`. ⇒ the chain is joined RAW (`join`) and
  each hop dir is realpath'd, so the kernel does the `..`. Same for a PATH entry with `..`.
* ⛔ **Found on the way: Node's JS `fs.realpathSync` HANGS on such a link.** It also resolves
  `..` lexically, so `sym/../xq` resolves to itself — forever, in a sync loop (no signal, no
  diagnostic report fires). Measured: the F4 arm's harness spun at 100% CPU until killed;
  `fs.realpathSync.native` (libc realpath) returns the right file at once. A run could plant
  such a link in the writable `node_modules/.bin` and hang every later `isolated` before it ran
  anything. ⇒ all 18 call sites use `.native` — every one feeds a mount path or a judgement
  that must match what the kernel does.
* **Not added: a separate check of `dirname(realpath(xq))`.** With the walk physical, its last
  hop IS that dir (realpath'd) — the check is redundant, and its sabotage already passed once
  (previous section).
* **Arms** (4 new cases in the planted-xq table, each with the legitimate-shape CONTROL): a
  relative `--keep ../sibling`; a tmpfs over `/mnt` in the throwaway namespace (owned by the
  mapped real uid); a link target `sym/../xq` through a symlink into /tmp; a PATH entry
  `<…>/sym/..`. **Before: the first three `SECRET-READ ok`** (the repo re-bound), the third by
  killing a hung harness; the fourth judged a file that does not exist (no note). After: all
  `ENOENT` + `xq ignored: found in a writable location`.
* **Sabotage (all caught):** relative entries skipped again → the relative case; the access()
  rule off → the /mnt case; the walk and the PATH join normalised again → both `..` cases;
  `.native` reverted → the link-target case HANGS (test timeout).

### ⛔ A keep beneath a SYMLINKED hidden dir was carried writable (review round 4, F2)

With `~/.ssh -> dotfiles/ssh` (inside the home), an outer `--keep ~/.ssh/sub` is bound at its
REAL path `~/dotfiles/ssh/sub`. In the stripped-markers call the home is hidden, so
`realpath(~/.ssh)` fails, hideRule holds only the nominal `~/.ssh`, and the carry kept `sub`
WRITABLE, silently. The review's suggested source — the recorded `WEBCTL_HIDDEN_DIRS` — does
not help: this path runs only because the markers were stripped, and that var is one of them.
* ⇒ the record comes from the KERNEL: the outer now also mounts its hide tmpfs on a hidden dir
  under the home that a re-bind lies strictly BENEATH (before: only one a re-bind CONTAINS).
  The keep lands on top, so the outer's command sees exactly what it saw (the dir holding only
  the keep). The nested call reads every `HIDE_SOURCE` mount below the home from mountinfo
  (`outerHides`, only once `outer` proved the outer call) and drops carries at or within them,
  with the same `AT or WITHIN a hidden dir` note.
* **Arm** (fake home, `.ssh -> dotfiles/ssh`; outer `--keep ~/.ssh/sub --keep ~/plain`; inner
  stripped): before, inner `KEPT 0 ok`; after `KEPT 0 ENOENT`, CONTROL `KEPT 1 ok`, the note
  with `1`, no path. The non-symlinked `~/.ssh/sub` arm (previous round) stays green.
* **Sabotage (both caught):** the carry ignoring `outerHides` → the arm; the outer's hide only
  where a re-bind CONTAINS the dir (as before) → the arm (nothing in mountinfo to read).

### v0.34.0 phase 1 — backends, and rows 8–10 of the shared arm table (ib4k)

**Selection.** `selectBackend(pinned, probes)` is pure and exported (logic-tested with injected
probes); `runIsolated` hands it three probes: unshare (`probeUnshare`), and bwrap/docker as
`not implemented yet (v0.34 phase 2/3)`. The unshare probe is everything that used to refuse
before `unshare` was spawned — a bad `WEBCTL_UNSHARE_BIN`, a privileged tool missing from the
system dirs — plus one side-effect-free `unshare -rnm --uts --pid --fork true`, whose stderr goes
through `userNamespaceRefusal()` (so the AppArmor case keeps its v0.33 HOST-POLICY text). It is
checked AFTER the usage/plan refusals, so a bad `--keep` still reads as usage on a host without
user namespaces. The nested path makes no sandbox: it validates the pin's value and ignores it.
Cost: one extra fork+exec of unshare per fresh call (not measurable against the ~1.5 s run).
⚠ `ub.override && ub.bin` — with an invalid override, `ub.bin` is '' and `path.resolve('')` is the
cwd: the old early return hid that; the plan now guards it.

**Row 8 — scratch.** `maskedDirs()` now returns `scratch` (/tmp, /var/tmp, /dev/shm — real paths,
existing dirs only, deduplicated against what is already listed) and `sockets` (the v0.33 set).
Every rule that special-cased `tmp` (planKeeps' beneath-a-masked-dir refusal and its push
condition, throwawayHome, the mount mode 1777, the "cover after staging" order) now reads
`scratch`. `outerRebinds` keeps keying its PROOF on `sockets` (so a stripped-markers call under an
outer that lacks only the new masks still carries) and carries from every scratch dir.

**Row 9 — keyring.** Measured with keyutils 1.6.3: `keyctl session - <cmd>` joins a new
anonymous keyring but prints `Joined session keyring: N` to stderr — the COMMAND's stderr. ⇒ pid 1
runs `keyctl new_session` instead (KEYCTL_JOIN then KEYCTL_SESSION_TO_PARENT onto bash itself,
which works because bash is single-threaded — a node half cannot be the parent; measured: rc 0,
id changed, also as pid 1 of a new PID namespace). PID1_REAPER takes keyctl (or '') as `$1`; the
join runs after the traps, before the child. Read back in the inner half: `keyctl show @s`'s first
key id vs the id the outer half read on the host. The user keyring: measured per user namespace on
this kernel (`@u` id differs inside the child userns) — Linux ≥ 5.3 moved it into the userns.

**Row 10 — identity.** Measured: `echo … > /proc/sys/kernel/hostname` as namespace root →
`Permission denied` (the uts sysctls are owned by the host's root; only net sysctls follow the
namespace owner), and node has no sethostname ⇒ the system `hostname` tool, run by the inner half
after `--uts`. **sysfs:** `mount -t sysfs` from inside our own netns works unprivileged (the netns
belongs to our userns) and shows only `lo` in `/sys/class/net` and `/sys/devices/virtual/net`. It
covers every host submount of /sys — mounting ON TOP of locked mounts is allowed, removing them is
not — so `/sys/fs/cgroup` is rbind-staged under the new /run and `--move`d back (measured: works;
`process.constrainedMemory()` still answers inside). Fallback when sysfs is refused: an empty ro
tmpfs over `/sys/class/net` + a note (tested with a fake `mount` that fails `-t sysfs`; the real
mount reached through a bind on /mnt, because /tmp is masked mid-run). We MOUNT (fresh sysfs) rather
than mask, because a mask over /sys/class/net alone leaves `/sys/devices/pci…/net/<name>` readable.
**machine-id:** a fixed constant, `NEUTRAL_MACHINE_ID` (hex of `webctl-isolated\0`), bound read-only
over `/etc/machine-id` (and `/var/lib/dbus/machine-id` when it is a separate file) and a neutral
`/etc/hostname`. Measured what breaks: `systemd-id128 machine-id` and `dbus-uuidgen --get` answer
the neutral id and exit 0 inside (an arm). An absent or all-zero id was rejected: systemd/dbus read
both as "no machine id". **Nesting:** `identityGaps()` is the read-back AND a kernel-proof fact; a
v0.33 outer fails it (and the scratch fact) alone → "older than v0.34.0 — upgrade the outer".

**The arm table** (`test/isolation-arm-table.test.js`, helpers `isolation-arm-world.cjs` /
`isolation-arm-probe.cjs`): one world per backend — `keyctl session - unshare -rm` (throwaway keyring
and mount ns; host netns and pidns so rows 1 and 3 have a host side), a tmpfs over a neutral dir
(/mnt) holding a fake passwd home, tmpfs over /dev/shm and /var/tmp with planted files. One run
reads every row outside (controls) and inside on three paths; ~7 s. Measured red before the fixes:
exactly rows 8, 9, 10 (failing for the named reason: planted /dev/shm file visible; host key named
by `keyctl show @s`; hostname not neutral); every other row and every control green.

**Sabotages** (each applied by hand to the committed code, the focused tests run, then reverted):

| # | sabotage | caught by |
|---|---|---|
| S1 | no /var/tmp, /dev/shm masks (`SCRATCH_DIRS = []`) | 4 red: table row 8, both keep-rule arms, the skew arm |
| S2 | pid 1 skips `keyctl new_session` | 3 red: every fresh run refused by the read-back ("still the HOST's"), table row 9 |
| S3 | S2 + no keyring read-back | 1 red: table row 9 (the host key is named by `keyctl show @s`) |
| S4 | no `--uts` | 1 red: table row 10 (`hostname` → EPERM in the host's UTS ns, refused — never renamed the host) |
| S5 | no fresh sysfs (and so no fallback either) | 2 red: table row 10, the refused-sysfs arm |
| S6 | machine-id / hostname files not bound | 1 red: table row 10 (read-back refuses) |
| S7 | a pinned backend falls back to unshare | 3 red: the pin logic arm, the bwrap/docker pin arm, the table's coverage guard |
| S8 | the unshare probe ignores the kernel's refusal | 1 red: the AppArmor end-to-end arm |
| S9 | the nesting proof ignores identity | **survived** at first (the skew arm also failed the scratch fact); an identity-only fake outer was added — now 1 red |
| S10 | the gate never tallies a backend | 2 red: the byte-identical and the isolation-unavailable gate arms |

### v0.34.0 review fixes (F1–F9, R1–R4)

The review of phase 1 (scratch rigs: a throwaway `unshare -rm` world with a fake passwd home, as the
table builds) found the items below. Each arm was written first and shown RED on the phase-1 code;
each sabotage below copies the tree, removes the fix with a `perl -0pi` edit, runs the table there.

**F1 — host SysV IPC and POSIX mqueues (row 8).** Measured before (a throwaway `unshare -rm --ipc`
"host" with an `ipcmk -M` segment and a queue in a fresh /dev/mqueue): inside `isolated` the segment
was listed by `ipcs -m`, a python-ctypes `shmat` write inside LANDED in the host's segment, and the
planted queue was visible. `unshare` without `--ipc` shares the caller's IPC namespace, and the
host's mqueue mount shows the host namespace's queues whoever reads it. After: `--ipc` on the fresh
spawn and the probe; the inner half proves the IPC ns id differs from the caller's (`plan.hostIpc`)
and mounts a fresh mqueue (`webctl-isolated-mqueue`) on /dev/mqueue, read back by resolving it.
Measured after: not listed, `shmat` → EINVAL (22), the host segment untouched, the queue absent.
The world now runs `unshare -rm --ipc` with its own mqueue, so the planted segment is throwaway;
two decoy segments come first because a fresh IPC ns numbers from 0 too (an inside segment must not
share the planted id). The shmat control is read back BEFORE the arms run, so a leaking arm cannot
turn the control red. The nested path makes no IPC ns of its own: it inherits its outer's.

| # | sabotage | caught by |
|---|---|---|
| F1a | no `--ipc` on the spawn, no `maskIpc` | table row 8 (`ipcs -m` lists the host's segment) |
| F1b | `--ipc` kept, the fresh /dev/mqueue mount and its read-back dropped | table row 8 (the host's queue is visible) |

**F3 — the sysfs fallback left host interfaces visible (row 10).** Phase 1 answered a refused fresh
sysfs with an empty ro tmpfs over `/sys/class/net` and a note, and ran; the review measured
`/sys/devices/virtual/net` still naming the host's virtual interfaces (and their MAC files readable).
Now a refused sysfs is a REFUSAL (`cannot mount a fresh sysfs: … — the host's network interfaces would
stay visible under /sys`), and `identityGaps()` reads `/sys/devices/virtual/net` as well as the class
dir, so the read-back (and the nesting proof) refuse any non-lo entry there. The table's row 10 reads
both dirs too (control: the host lists a virtual interface; a diagnostic where it lists none). Arms:
a `mount` that fails `-t sysfs` → NOT RUN, command not run (was: ran with a note); a `-t sysfs` that
only masks `/sys/class/net` → NOT RUN by the read-back (was: ran). Both RED before, GREEN after.

| # | sabotage | caught by |
|---|---|---|
| F3a | the read-back reads `/sys/class/net` only | the class-net-only arm (the command ran) |
| F3b | the phase-1 fallback restored (mask + note + run) | the refused-sysfs arm |

**F5 + R3 — the keyring join and its read-back (row 9).** Two silent paths. (1) keyctl installed but
the HOST's `keyctl show @s` failing gave `plan.keyring = ''`, and the inner half then skipped the
read-back without a word. Now, like the keyctl-absent ruling, the run goes ahead and the verdict says
`keyring: unverified (keyctl show failed)`; the table SKIPs row 9 by name when its world's
`keyctl show @s` fails. (2) pid 1's `keyctl new_session || :` — on the fresh path the read-back caught
a failed join (as "still the HOST's"), on the NESTED path nothing did: the nested command ran in its
outer's keyring, silently. Now (ruling R3) pid 1 itself refuses: `fail cannot join a fresh session
keyring (…)` on fd 3 — the status channel on both paths — then exit 1, before starting anything; the
nested path's `runCommand` reports a `fail` line it receives before `started` (it reported nothing).
Arms with a fake `keyctl` (`show`/`new_session` failing; the nested case keyed on a flag file the
outer command creates just before its nested call — `WEBCTL_HOST_NETNS` would not do, the fresh pid 1
sees it too): all three RED before (the nested one ran), GREEN after.

| # | sabotage | caught by |
|---|---|---|
| F5a | the `unverified` note dropped | the show-fails arm |
| R3a | pid 1's `|| :` restored | the fresh and the nested join arms |
| R3b | the nested `runCommand` ignores a `fail` line | the nested join arm |

**F6 — the neutral machine-id could be rewritten through its backing copy (row 10).** The copies
(`/run/.webctl-identity/N`, mode 0444) were bound over `/etc/machine-id` etc. and the BINDS remounted
ro — but each copy kept a name in our writable /run, owned by the real uid: `chmod u+w` + a write
there changed what `/etc/machine-id` read inside (measured by the review; the arm reproduced it).
Tried first: unlink the copies once bound. ⛔ That broke the STRIPPED path — measured: the kernel
refuses a mount on top of a bind whose file is unlinked (`cannot bind a neutral machine-id`), and a
stripped-markers call binds its own over the outer's. ⇒ The copies live on a tmpfs of their own
(`webctl-isolated-identity`), remounted `bind,ro` after the binds (a superblock `remount,ro` is refused
while binds of it exist — measured), and read back (resolves to that tmpfs, `ro`). Arm (table row 10):
the probe finds the bind's backing file from mountinfo (same device, root prefix), chmods and writes
it, then re-reads; control: the same routine changes a 0444-copy-bound-ro file the world made outside.
RED before (`REWRITTEN`), GREEN after, on all three paths.

| # | sabotage | caught by |
|---|---|---|
| F6a | the identity tmpfs left writable (no ro remount, no read-back) | table row 10 (`REWRITTEN through its backing copy`) |

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
* **`WEBCTL_RO_ROOTS` and `WEBCTL_HIDDEN_DIRS` are recorded input.** `[]` would satisfy the
  nested home / hidden fact; the other facts still require being inside a real masked
  namespace, so it does not let the host pass as "inside".
* **The home is hidden whole**, but what a re-bind brings back is visible: a PATH entry, the
  cwd, a keep, base's root. A secret INSIDE one of those (other than the six HIDDEN_DIRS) is
  exposed. A secret OUTSIDE the home (and not via a symlinked dot-dir) is not covered at all.
* **Planned for v0.34.0 (ib4k shared arm set), not addressed here:** `/var/tmp` and `/dev/shm`
  are writable and shared with the host (review, minor 9); the host's session keyring is shared
  (`keyctl show @s` lists it, `alswrv`); no UTS namespace (the hostname is visible);
  `/sys/class/net` (interface names, MACs) and `/etc/machine-id` are readable (review of 5773fb8).
* **`--kill-child` and the PDEATHSIG race** (review of 5773fb8, finding 6). Read in util-linux's
  `sys-utils/unshare.c`: the forked child calls `prctl(PR_SET_PDEATHSIG)`, and since **2.39** it
  first `pidfd_open`s the parent and, after the prctl, `poll`s it — gone ⇒ the child exits
  (`HAVE_PIDFD_OPEN` builds; 2.38 has no such check; this host runs 2.42). So on ≥ 2.39 a SIGKILL
  to unshare between fork and prctl cannot leave pid 1 orphaned. On 2.38 (the floor, for
  `--map-user`) it can. Our own partial cover: if the HARNESS is gone too, the inner half's
  `started` write on fd 3 fails (EPIPE, node ignores SIGPIPE) or its plan read hits EOF, and it
  refuses — nothing runs. Not covered: unshare killed alone in that window while the harness
  lives (the command then runs, unsignalable by the harness), or a command already started. A
  cheap check from inside is not available: pid 1's parent is outside its PID namespace
  (`getppid()` is 0), so "is unshare still there" cannot be asked from the namespace.
  Not reproduced (not attempted: the window is a few syscalls wide).
* **`NODE_OPTIONS` is default-passed to the COMMAND** (and its `--require` runs there, capless,
  after every mask). It no longer reaches any half that runs before the drop (above).
* **`bash` is required** (pid 1, the reaper). Absent → FAIL.

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
