---
id: gu1d
title: "The `gui` subcommand surface"
category: ux
created: "2026-09-22"
updated: "2026-09-22"
status: draft
tags: [cli, gui, xpra, subcommand, inspect, provenance, reachability, extraction]
tech:
  - name: "Node.js"
    version: ">=22.12"
  - name: "xpra"
    version: ">=5"
  - name: "Docker"
    version: ">=24"
relates_to: [sm2t, f6rd, nho9, lszd]
depends_on: [v7m2, 2fc5]
expands: [8hw5]
similar_to: [v59v]
---

# The `gui` subcommand surface

## Why this exists

Greg, verbatim, 2026-09-22:

> *"I want `gui {subcommands}` in all `-webctl` tools, so probably go to base, so
> not only linkedin-webctl or chatgpt-webctl have it but also fetlife-webctl and
> others."*

⭐ **The generality is STATED, not inferred.** That is the whole difference from
`ws-client`, which this lane and `cgwc:main` correctly declined to harvest: there
the only evidence for a shared design was two implementations with one documented
lineage, which is one observation reported twice. Here the requirement comes from
outside the code, so consumer agreement is not the gate.

⛔ **But that does not make the existing implementation the design.** Two of ten
lanes ship `gui`, and `chatgpt-webctl/lib/help.js:760` states its version is
*"symmetric with linkedin-webctl `gui`… the underlying viewer lib is
shared/byte-identical"*. **One lineage, two copies.** So the contract below is
adopted on its merits, and the implementation is a **rewrite against base's own
state**, not a lift.

## ⛔ The blocking finding: base cannot currently answer `gui status`

`webctl-mgr`'s brief describes `gui` as a surface over `inspect()`, which
*already returns ports + reachability*. Measured against `lib/` at `f2fb61d`,
**half of that is not true today**, and the missing half is the valuable half.

### 1. Port provenance is computed and then thrown away

`client-config.js:377 deriveXpraPorts()` returns provenance with real care —
including the excellent `'derived (== tcp; html5 rides the tcp socket)'`:

```js
return { xpraTcpPort: tcp, xpraHtml5Port: html5,
         sources: { tcp: tcpSource, html5: html5Source } };
```

`buildDriverCfg()` at `:538` consumes `xpra.xpraTcpPort` and
`xpra.xpraHtml5Port` — **and drops `xpra.sources` entirely.** `resolvePort()`
loses its `.source` the same way, at `:534`, to a bare `.value`.

⇒ There is **no consumer of `xpra.sources` anywhere in `lib/`.** The provenance
exists for exactly one statement and dies at the seam into the driver. So
`inspect()` cannot report it, and the `ports.*.source` field — the one
`webctl:mgr` specifically flagged as *"the distinction that cost this family
weeks when a derived html5 port was published and answered nothing"* — is
**unreachable from base**.

⚠ This is also why the two existing implementations are inline: they had to
recompute or re-plumb the provenance themselves. It is evidence for the rewrite,
not against it.

### 2. `tcpReachable` does not exist, and `healthCheck()` answers a different question

`inspect()` returns no reachability field at all. The nearest thing,
`healthCheck()` at `:727`, probes **CDP** (`pollCdp(host, port, …)`) — or, in
portless mode, degrades to `containerRunning()`.

The GUI socket is a **different port** (`xpraTcpPort`) serving a different thing.
A CDP probe passing tells you nothing about whether a human can attach, and in
portless mode `healthCheck()` is not a probe at all.

⇒ `gui status` needs its own probe of the xpra socket. Reusing `healthCheck()`
would be asserting a proxy for the fact (`xrl4`): *"CDP answered"* usually
accompanies *"the GUI is reachable"* and is not it.

## The contract

Adopted as-is where it is genuinely symmetric; the JSONL envelope follows `lszd`.

```
gui-status  {slug, base, container, running, chromiumRunning,
             ports: { "xpra-tcp":   {value, source},
                      "xpra-html5": {value, source} },
             html5Answering, html5Url, attach: {native, html5, dockerGl}}

gui-attach  {slug, mode: "native"|"html5"|"docker-gl", ok, exitCode|url|command, printCli?}
```

### ⛔ Three states, never two

`running` and `html5Answering` are **separate fields and must stay separate**.

| `running` | `html5Answering` | meaning |
|---|---|---|
| `false` | **`null`** | **stopped** — never probed, bring it up |
| `true` | `false` | **running but not serving** — a real incident |
| `true` | `true` | answering |

⛔ **THE FIELD IS NOT CALLED `tcpReachable`, AND THE PROBE IS NOT A SOCKET
CONNECT.** This section said both. Measured on the live fleet:

```
port    connect()        HTTP GET
14327   TRUE             200        <- the xpra client, genuinely serving
14328   TRUE             reset      <- published, NOTHING behind it
14878   ECONNREFUSED     —          <- not published at all
```

**Docker's published-port proxy ACCEPTS and then resets.** So `connect()`
distinguishes *published* from *not published* — which is not the question the
field is named after.

⇒ And the consequence is fatal to the design as first written: **the most
valuable row in this very table could essentially never fire.** A running
container always has its port published, so a `connect()`-based probe returns
`true` whenever the stack is up, and *"running but not serving"* — the one state
no other command reports — becomes invisible. The field would have been a
restatement of `running`.

⭐ This is base's own v0.6.0 rationale — *"a published port that answered
nothing"* — reproduced inside the check written to detect it. `tcpReachable`
names the MEASUREMENT; `html5Answering` names the FACT.

⇒ **The probe speaks the protocol: an HTTP GET against the advertised
`html5Url`, requiring a 2xx.** Nothing weaker establishes that a human can
attach.

### ⛔ TWO PATHS, TWO PROBES — and one of them must not speak HTTP

`attach: { native, html5 }` offers two ways in. A single reachability field
describes one of them and silently condemns the other.

    xpra html5 client DISABLED, xpra protocol serving normally:
      html5Answering -> false   (correct, and useful)
      native attach  -> WORKS
      ...and nothing here reported that second fact

⇒ An operator reads one `false`, concludes the GUI is down, and the native
viewer would have attached fine. Same *wrong action from an undistinguished
state* as the tri-state and `configured: false`, one level down.

**Measured here, all three ports, three probe strengths:**

```
port    connect()      connect-then-WAIT                    HTTP GET
14327   TRUE           HELD-OPEN (605ms)                    200
14328   TRUE           CONNECTED-then-CLOSED-by-peer (2ms)  reset
14878   ECONNREFUSED   ECONNREFUSED (1ms)                   —
```

⭐ **Connect-then-wait separates all three states without speaking any
protocol** — and the *timing* is diagnostic on its own: an immediate peer close
is docker's proxy with nothing behind it, while a genuine server holds the
socket. The bare `connect()` and the HTTP GET are not the only two options; the
middle one exists.

| field | probe | question it answers |
|---|---|---|
| `guiReachable` | connect-then-wait on `xpraTcpPort` | **is the transport serving at all** |
| `html5Answering` | HTTP GET on `html5Url`, 2xx | **can a browser open it** |

⇒ Connect-then-wait is right for the first **because** it is protocol-agnostic:
the thing on the other end may be xpra's own protocol rather than HTTP. The
REFUSED-vs-RESET split applies to it unchanged and is what makes it a three-way
answer rather than a boolean.

⚠ **And this is why the rename mattered more than it looked.** The objection to
an HTTP probe was that it false-REDs when xpra's html5 client is disabled and
the port speaks only the xpra protocol. That is fatal to a field called
`tcpReachable` — and **not an objection at all** to one called
`html5Answering`, where `false` is then simply *true and useful*. Naming the
fact instead of the measurement did not merely describe the check better; it
made the check correct. *(Probe from linkedin-webctl PR #92, hermetic against
three local `net.createServer` cases so it proves out on a machine with no
docker; the two-fields reading is fetlife-webctl's.)*

⭐ **AND the derived port is reported beside the SERVING port, as two fields.**
Their agreement is the fact, and one field cannot express it:

```
v0.5.0 pin   derived 14328, serving 14327   <- disagree: the defect
v0.6.0 pin   derived 14399, serving 14399   <- agree: the bump working
```

⚠ These two checks are **complementary, not redundant**, and neither supersedes
the other. The protocol probe catches *"the URL we advertise is dead"* directly.
Derived-vs-serving additionally (a) says **why** — the derivation is wrong rather
than the viewer being down — and (b) catches the case the probe cannot: **something
else answering 200 on the derived port**, where a lone probe reports healthy.
That is the `listTargetsCorroborated` shape again: two independent sources, and
the disagreement is itself the finding. *(Found by linkedin-webctl (PR #92) after fetlife-webctl probed its
running container; re-measured independently by fetlife and again here.)*

#### The failure has two distinguishable causes, and both are actionable

| observation | meaning | remedy |
|---|---|---|
| connection **refused** | not published — container down, or port not mapped | bring the stack up |
| connects, then **reset**/non-2xx | published, but nothing serving inside | the container is up and the viewer is not |

⇒ Report which. They are the same `false` and they send the operator to
different places.

⛔ **`html5Answering` IS NULLABLE, AND THAT IS THE WHOLE POINT.** A boolean `false`
means two different things — *"probed and it failed"* and *"never probed"* — and
only `running` disambiguates them. A consumer reading the one field it cares
about would conclude "unreachable" from a probe that never ran.

The probe is short-circuited when the container is down (correctly — there is
nothing to probe), so the field MUST be able to say "I did not measure this".
`null` is not a missing value here; it is the measurement's own absence, stated.

*(linkedin-webctl found this in its own shipped implementation while answering
these questions: the tri-state is rendered correctly for HUMANS —
`OK` / `NO` / `n/a (container stopped)` — and flattened to a boolean in the
JSONL. The human surface was more honest than the machine one.)*

#### ⛔ And there is a FOURTH state: no GUI stack is configured at all

`running: false` says **"bring it up"**. For a lane with no driver there is
nothing to bring up, and reporting a stopped container describes one that was
never configured. Today that is `fetlife`, `gemini`, and the three unwired
lanes — the majority of the family.

⇒ `gui status` called from a lane without the harness must say **`configured:
false`** rather than report a stopped container. Same argument as `null` above:
a state that cannot be distinguished gets acted on wrongly, and here the wrong
action is "start it", which will never work. *(fetlife-webctl.)*

Collapsing the middle row into either neighbour is the failure this family
already paid for once: a port that was published, reserved, advertised through
`inspect()`, and answered nothing (`f6rd`, and the v0.6.0 html5 collapse). A
boolean `up` reports that stack as healthy or as absent, and both readings send
the operator somewhere useless.

⇒ **`html5Answering: false` with `running: true` is the single most valuable
thing this surface can say.** It is the state no other command in the family
reports — and only a protocol-level probe can produce it.

⭐ **AND THE CONCRETE CASE IS A REAL INCIDENT, NOT A CONSTRUCTED ONE.** base
starts containers with no `--restart` policy, deliberately (see
`CONTAINER_LIFECYCLE_CONTRACT`), so **nothing survives a reboot.** A lane ran
for **two weeks** with both containers EXITED since a reboot while reporting
*"containers up ~33h"* to three audiences — it kept quoting a reading taken
before the boot.

After a reboot a lane is `configured: true`, containers gone, and
**`guiReachable: false` is the only field that would have caught it.** ⇒ That is
the row this surface exists for, and the failure it prevents is not a crash but
**a status claim that ages into a lie** — nothing breaks, and the claim quietly
stops being true. *(fetlife-webctl, which checked base's `runDetached` before
assuming the affected lane had misconfigured itself.)*

### Exit codes are part of the contract — and ⛔ code 4 currently means two things

Scripts branch on exit codes, so they are a wire contract, not a CLI detail.
base therefore defines the **vocabulary as data**; the consumer's CLI applies it.

Measured in `chatgpt-webctl/lib/docker-cmd.js`, `EXIT_CONFIG_ERROR = 4` is
returned for **both**:

* `:86`, `:327` — **docker is unavailable** (the environment is not ready)
* `:296`, `:307` — **`--scaling` with `--html5`** (the flag combination is wrong)

⇒ These are the two states a wrapper most needs to tell apart, because they
imply opposite actions: *retry after starting docker* versus *never retry, the
command was wrong*. A script branching on `4` cannot distinguish "the machine is
not ready" from "you made a typo".

This is the exit-2 defect from `xrl4` one layer down — **two distinct states
wearing one code** — with one difference that changes the remedy. There, a single
contract legitimately produced both meanings and no code could separate them, so
the reason had to travel as text. **Here the emit site KNOWS which case it is.**
It is not that a number cannot carry the distinction; it is that the same number
was assigned to two things we can already tell apart.

⇒ **Ruled vocabulary for base:**

| code | meaning |
|---|---|
| `0` | ok |
| `1` | error — not running, or bad subcommand |
| `4` | **environment not ready** (docker unavailable) |
| `5` | **usage/config error** (bad flag combination) |

⚠ **This is a deliberate behaviour change for the two existing lanes**, and the
only one I expect their adoption diff to show. `--scaling --html5` moves `4 -> 5`.
Flagging it in advance so it reads as a designed delta rather than a regression —
an unexpected diff and an expected one look identical after the fact.

⭐ The `--scaling --html5` refusal itself is adopted verbatim and must not be
softened into a warn-and-ignore: the HTML5 path opens a URL instead of running a
client, so the flag *could only ever silently do nothing*.

### ⛔ `--readonly` — a flag that manufactures a false belief

Measured in `linkedin-webctl` today, BEFORE its fix (PR #90):

```
gui attach --readonly    --html5 --print-cli  ->  http://127.0.0.1:14328/
gui attach --no-readonly --html5 --print-cli  ->  http://127.0.0.1:14328/
```

Byte-identical. The flag was parsed, accepted, and **silently dropped** on the
HTML5 path. The native path was correct throughout.

⇒ On a profile authenticated as a real person, **an attach believed to be
read-only that accepts input is worse than no flag at all.** An obviously
interactive viewer gets handled carefully; a labelled-read-only one does not.
The flag does not merely fail to protect — it *manufactures* the false belief
that protection is present.

**base adopts the REFUSAL, not an implementation.** `--readonly` with `--html5`
is refused. This is correct whether or not the HTML5 client turns out to accept a
readonly URL parameter, and if it is later confirmed, turning a refusal into a
pass-through is a strictly smaller change than undoing a shipped silent-ignore.

⚠ **CARRY THIS CAVEAT VERBATIM.** On the native path we emit `--readonly=yes`
and **xpra** enforces it. That enforcement is xpra's, not ours, and **nothing
tests that the viewer obeys**. The existing assertions prove our flag *reaches
the viewer or is refused* — not that the viewer honours it. A real guarantee
needs input-injection against a live attach, which does not exist and should not
be written against an authenticated session without asking first.

### What base should own FIRST

`lib/browser-location/xpra-attach.js` in `linkedin-webctl` is already factored
out and byte-identical across the two lanes — the natural first thing for base to
take.

⭐ But note which half carried the bug: **the byte-identical viewer wrapper was
correct, and the per-repo `--html5` glue was not.** The usual instinct is that
shared code is the risky part and glue is safely local. Here it was the reverse,
and it is an argument for extracting the glue too rather than leaving each lane
to re-derive it.

### ⚠ A pre-v0.6.0 candidate must not produce a false RED

A consumer's candidate arm asserts `xpraHtml5Port === xpraTcpPort`. That is
correct from v0.6.0 onward and **wrong against a pre-v0.6.0 base**, which
legitimately derives `tcp + 1`.

⇒ **Ruled:** the candidate arm asserts equality, and when the candidate
*predates v0.6.0* the contract returns **exit 2 — no verdict** with the reason
printed, never a FAIL. A false RED against a legitimately supported pin is the
trap this fleet keeps paying for; a silent pass is worse; "no verdict, and here
is why" is the mechanism already ruled for exactly this shape.

⚠ In practice `--against-head` names base's own HEAD, so it should never point
at a pre-collapse base. The guard is cheap insurance against a candidate handed
over by hand — and it stops four lanes each inventing a different answer.

### ⛔ Example assertions ship as LITERALS

Any assertion base publishes — in the contract data, the recipe, or this doc —
uses a **literal** expected value, never one derived from a constant exported by
the thing under test.

Demonstrated rather than reasoned: a base sabotaged to lie about the derivation
**and** the offset constant, so the two agree —

```
tcp === cc.PORT_OFFSET_XPRA_TCP + cdp   ->  PASSES, sabotage undetected
tcp === 14327   (literal)               ->  FAILS,  sabotage caught
```

⇒ The constant-based form *looks* more principled and is, against a
self-consistent lie, **blind**. Reading your expectation from the artifact under
test cannot detect that artifact lying consistently.

## ⛔ The profile is a second knob wearing the slug's name

Measured in `mounts.js:133`:

```js
function resolveChromiumProfile(slug, userDataDir) {
  const p = userDataDir ? expandHomePath(userDataDir) : profileDir(slug);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
```

⇒ **When `userDataDir` is set, the slug is ignored entirely.** Moving the slug
renames the containers and leaves the profile where it was. A lane crossing
v0.6.0 hit this on its first careful attempt: told *"test on a throwaway slug,
never `default`"* precisely to keep an authenticated profile out of the path, it
followed the instruction and **was pointed at the authenticated profile anyway**.
Two containers would have shared one profile directory had the lock not refused.

⭐ **The guard that caught it was `createProfileLock`, not the slug** — a lock
doing load-bearing work on a path nobody designed it for. Worth knowing before
anyone treats it as belt-and-braces.

### Ruled

* **The slug does NOT move an explicit `userDataDir`.** An explicit value wins
  over a derived one (`2fc5`), and silently relocating a configured profile path
  is the migration-that-moves-data hazard this family has already ruled against.
  Two containers on one profile is also a legitimate thing to want.
* **⛔ But the dangerous COMBINATION is reported loudly**: a non-default slug
  *together with* an explicit `userDataDir` means the caller asked for isolation
  and will not get it. Name both values and say so.
* **`gui status` reports the profile path AND ITS PROVENANCE** — derived from the
  slug, or set explicitly. This is the same gap as `ports.*.source`: the moment
  the value's origin is reported, *"why did moving the slug not move this"*
  answers itself. ⇒ *"Which profile am I about to open"* must be answerable
  **before** a start, not after a lock refusal.

### ⛔ And a status command must not CREATE the thing it reports

`resolveChromiumProfile()` calls `fs.mkdirSync` unconditionally. So resolving
the path for a **read-only** `gui status` would create the profile directory as
a side effect — and `configured: false` lanes would start manufacturing empty
profile dirs merely by being asked their status.

⚠ **Stated precisely, because the status of the defect matters:** inside base
the only caller is the bring-up path (`chromium-docker-xpra.js:271`), where the
`mkdir` is correct. ⇒ So this is **prospective for base's own code — it arrives
with the feature** — and *"answerable before a start"* is what creates the
caller class in which it is a bug. ⛔ But both `resolveChromiumProfile` and
`ensureProfileDir` are **public exports**, so a consumer writing its own status
command can reach it today without any change here.

⇒ base needs a **pure** resolver that answers the path without creating it, with
the `mkdir` kept on the bring-up path where it belongs. **A query with a
filesystem side effect is not a query.**

⇒ **Sequencing:** this is *not* a third prerequisite for `gui`. The pure
resolver and the profile provenance ship **with `gui status`**, because
`gui status` is the caller that turns them into bugs — a status command that
creates directories is not a correct status command, so they are part of the
feature rather than gates in front of it.

## The container env contract, as data

Ruled shape — **flat current contract plus `since`**, not a version-keyed map:

```js
export const XPRA_CONTAINER_ENV_CONTRACT = Object.freeze({
  required:  Object.freeze(['XPRA_TCP_BIND']),
  forbidden: Object.freeze(['XPRA_HTML5_BIND']),  // and WHY, in a comment
  htmlFlag:  '--html=on',
  since:     'v0.6.0',
});
```

* ⛔ **A version-keyed map would be a second source of truth**, maintained by
  hand, and wrong the moment someone adds a key without changing behaviour. It
  also invites a consumer to *look up its own pin* instead of observing the
  driver — the thing the assertion exists to avoid.
* **`since` is for the human reading a failure, not a lookup key.** It turns
  *"XPRA_HTML5_BIND is required but not passed"* into *"your entrypoint predates
  v0.6.0"*. One string does that; a map is not needed.
* **A consumer on an older base gets the truth from the code it mounts** — its
  own `vendor/` — not from a newer base's table describing what it used to do.
* ⛔ **`forbidden` is a REAL LIST, never the complement of `required`.** *"Not
  required"* and *"must not be set"* are different, and only the second catches
  an entrypoint still consuming a variable base stopped setting — which is the
  exact live failure.

### ⛔ What a teardown LEAVES is the same class of fact

`shutdown()` stops; it does not remove. Containers, volumes, network and profile
dir all survive — and **stopped containers still hold the volume**, so a caller
that stops and then runs `docker volume rm` gets a refusal it cannot predict
from the verb's name.

⇒ This belongs in the published contract beside the env contract, for the same
three reasons: it is **base-owned** (base decides what the verb does), it is
**enforced in N consumer-written sentences** (every lane writes its own
user-facing "removed" string), and **nobody can check it** — there is no
assertion a consumer can run to find out that its own wording is wrong.

⚠ `shutdown` is the one driver verb whose NAME implies more than it does, which
is exactly why the fact travels badly. *(fetlife-webctl wrote a teardown message
specifically to carry a "say what teardown leaves" warning and overstated it by
the very inference that warning was about — then corrected it at `bdced17`.)*

⚠ The consumer-side assertion keeps **injected-docker capture** as its ground
truth and uses this data only for the message and the forbidden set. Verifying
base's behaviour by grepping base's source returns the negation: a grep for
`XPRA_HTML5_BIND` in the driver matches the two comments saying it is
deliberately not set. *(Shape specified by fetlife-webctl.)*

## Ruling — the `xpra` alias

⚠ **The premise this was first written on was wrong.** The relay reported that
linkedin deprecates `xpra` and chatgpt does not. Re-derived from both trees
(the standing rule: a claim about another repo is re-derived from its refs, never
taken from a report about it):

| | deprecated? | where |
|---|---|---|
| chatgpt | **yes** | `lib/args.js:28`, `lib/help.js:755` |
| linkedin | **yes** | `linkedin-runner.js:4983`, `:5235`, and three titled topics at `:5287`/`:5308`/`:5323` |

**Both retain it, both document it as deprecated, neither removes it.** There is
no divergence to reconcile, which makes the ruling smaller, not larger:

* **base ships the `gui` verb only.** `xpra` is never introduced by base.
* **A lane that already ships `xpra` keeps it, as a deprecated alias**, declared
  by that lane through `C`. Removing it breaks muscle memory and scripts for no
  gain, and an alias that resolves is cheaper than a wrong-command error.
* **The other eight lanes do not get it.** Introducing `xpra` there would be new
  debt on day one, and it names an **implementation** (the viewer) rather than a
  **capability** (the GUI). Both lanes already say so: the backend is
  *"xpra now; possibly wprs/xvfb later"*.

### Two alias behaviours that must survive extraction

1. ⭐ **THE EMITTED JSONL TYPE IS ALWAYS `gui-*`, WHICHEVER ALIAS WAS TYPED.**
   The deprecated name does not leak into the machine interface, so a parser
   never has to know about it. This is the single most droppable detail here and
   the most expensive to rediscover.
2. ⚠ **The alias resolves FULLY SILENTLY** — no warning, *not even at `-vv`*
   (`linkedin-runner.js:11149`, deliberately, "to keep scripts quiet").
   **This paragraph first said base should preserve that. It should not**, and
   the lane that wrote the silence is the one that argued me out of it.

   Verified there today: `xpra status` and `gui status` produce byte-identical
   stdout *and* stderr, and the word "deprecated" appears on neither. ⇒ **A
   deprecated alias and a fully supported one are indistinguishable to the person
   using it.** Nobody ever migrates, and the deprecation is a fact known only to
   its author — the same *two states rendered identically* failure as
   `html5Answering` above, in the same repo, found the same way.

   I had read the code's stated intent ("to keep scripts quiet") and preserved
   the behaviour it described instead of asking whether the behaviour was right.
   A comment explaining a choice is not evidence the choice was correct.

   ⇒ **RULED: warn on `stderr`, and only when `stderr` is a TTY.** A human sees
   the notice; a script or pipeline never does; no state file is needed to make
   it "one-time". The JSONL contract lives on stdout and is untouched either way.
   A silent deprecation is the worst of the available options — worse than not
   deprecating at all, which is what the other lane is accidentally closer to
   being right about.

### ⚠ The deprecation lives in THREE places, for three audiences

The args table (a maintainer reading the parser), the human help topic, and
`ai_notes` (**agent-only** — agents read the reference form exclusively).

⇒ A surface that emits the command but leaves each consumer to re-describe it
**loses the agent-facing line first**, because it is the one nobody reads by
accident. base therefore ships the alias's *description* alongside its
registration, not just its name. *(cgwc:main's catch.)*

⚠ The naming matters more the moment the browser axis lands: `xpra` is the
transport for chromium *and* firefox today, so it never distinguished what a user
was choosing — and a future non-xpra viewer would make the name actively wrong.

⇒ Alias registration is therefore a **per-lane compatibility fact**, passed in
through `C`, not a family design baked into base.

## What base ships, and what it does not

**base ships:**

1. provenance carried through the seam — `buildDriverCfg` keeps the port
   `sources` it already computes, and `inspect()` reports them;
2. a GUI-socket reachability probe, distinct from `healthCheck()`;
3. `createGuiSurface(C, opts)` (`sm2t`) returning the two JSONL projections
   above — **pure over injected state**, no CLI parsing, no `process.exit`;
4. the `attach` descriptors (`native`, `html5`) as **data** — the command and URL
   a caller would use.

### ⛔ THE SURFACE MUST NOT BE CJS-SHAPED

Both lanes that ship `gui` today are **CJS**, and they reach base through the
`require(esm)` shim. `fetlife-webctl` — the lane Greg named, wired 2026-09-22 —
is **`"type": "module"`**. It is the family's first ESM consumer.

⇒ A `require()`-based command loader, or a CJS-shaped entry point copied from
either existing lane, **hard-errors there rather than degrading**. base is
zero-dep ESM already, so the correct shape works for everyone: ESM module,
`createGuiSurface(C, opts)`, and the CJS lanes keep reaching it the way they
reach every other base module.

⚠ The hazard is not base's format — it is inheriting a CALLING CONVENTION from
the two reference implementations along with their contract. That is the same
copy mechanism that put four byte-identical unpinned Dockerfiles in four repos
from one upstream commit. *(Raised by fetlife-webctl before the code exists,
which is the only time it is cheap.)*

**base does NOT ship:**

* argument parsing or help *rendering* — those are the consumer's CLI, and
  `nho9` already governs dual-audience help. ⚠ base DOES ship the exit-code
  vocabulary and the alias descriptions as **data** (see below); it never calls
  `process.exit`;
* the act of spawning a viewer. base returns *what to run*; the consumer runs it.
  A library that execs a GUI client on the operator's desktop is not a library.

## ✅ RULED: a THIRD attach mode, `docker-gl` — and three things base will not do

Greg asked for `<tool> gui attach` with an **OpenGL xpra client in docker** to be a
family standard that base **enforces**, *"codif[ied] in repo, shared libraries, QA
checklists so other projects inherit standard and later verify when QA is done"*.
Raised by `grok` with a concrete proposal; working implementation exists in one lane
and is the fleet's ruled pattern for the remote case.

✅ **(1) ADOPTED — `attach` gains a third descriptor.** `attach: { native, html5,
dockerGl }`, returned **as data** exactly like the other two, and `gui-attach` gains
`mode: "native" | "html5" | "docker-gl"`. This is additive and fits the existing shape.

⛔ **(2) REFUSED — it must NOT become "the default where a GL client repo is
configured".** That makes the selected mode depend on **what was detected**, and this
document already exists partly because a *detected* answer hid which thing you got:
`running` and `html5Answering` are separate fields precisely so one `false` cannot be
read as the other. ⚠ A mode chosen by detection means an operator cannot tell, from the
command they typed, which client they are about to get — and the two have different
failure modes and different security surfaces.
⇒ **Base REPORTS availability; the caller STATES the mode.** Same rule `btg4` reached
for the browser engine: **declared, then verified** — never sniffed.

⛔ **(3) REFUSED — the shell implementation does not come into base as it stands.**
base is the family's only **PUBLIC** repo. The working script is parameterised on
specific **hosts** and names a specific **image repository**, and this repo's own
invariant is *provenance by role, never by hostname*. ⇒ **Base owns the CONTRACT and
the CHECK; the template or the lane owns the host-specific shell.** That split is not a
hedge — the shell is the part that legitimately differs per machine, and the contract
is the part that must not.

⭐ **(4) THE IMPORTANT ONE — A CHECKLIST CONSUMERS "CITE" IS NOT ENFORCEMENT.** The
proposal was that the GL check and the attach guards *"become a base QA checklist that
consumers' `test-against-base.sh` must cite"*. ⛔ **Citing is not checking.** A contract
that names a checklist passes whether or not the property holds, which is the exact
shape `test-checks-that-cannot-fail-k3wn` catalogues and the exact shape Greg's own
words rule out: *"later verify when QA is done"* requires something that **executes**.

⇒ And the good news is that it already executes. The existing `--glcheck` is a
**three-row pass**: host, container — which must **match** — and an **llvmpipe
control**. ⭐ **That control is a positive arm**: it proves the check can tell
hardware GL from software rasterisation, so a passing result is not merely "the probe
returned something". It is already the right shape, and it should ship **as a check
base can run**, not as prose a consumer promises to have read.

⚠ **What base must therefore ship, and in this order:**

1. the `dockerGl` **descriptor** in `inspect()`/`gui-attach`, as data (above);
2. an **executable** GL assertion with the llvmpipe control retained — a lane's QA
   either runs it or does not, and the gate can see which;
3. the attach **guards** as assertions, not bullet points: no published port, socket
   mode `0700`, a per-attach network, and a **relay that is read-only**.

### ⚠ The working kit cannot be COPIED into base — measured, and it is prose not logic

A lane offered its kit for base to lift, having already made `--glcheck` decide
**PASS/FAIL itself** (exit 0/1) rather than print rows for a human to compare, with an
offline test of **7 cases covering 2 fixes, with 2 negative controls** — corrected by
that lane after I first wrote *"7 fixes each carrying a negative control"*, which
overstated it on both counts. Verified here from the suite itself:

```
H1   --host-xpra exits after its client; no docker call follows        (fix a)
H1c  CONTROL: `exit $?` removed -> docker calls DO follow               (must be caught)
G1   glcheck PASS:  host == container, control shows llvmpipe           (fix b)
G2   glcheck FAIL:  container renders llvmpipe
G3   glcheck FAIL:  container renderer differs from host
G4   glcheck FAIL:  control does NOT show llvmpipe (runner ignored the env)
G4c  CONTROL: control-row branch removed -> G4's input passes           (must be caught)
```

⭐ **And the shape is better than the count I got wrong.** `G1`–`G4` are not one
assertion repeated: they separate a pass from **three distinct failure causes**, so a
FAIL says *which* way GL was wrong. ⚠ `G4` is the subtle one — *the control row itself
did not show llvmpipe*, meaning the runner ignored the forced-software env, so the
control was not controlling. ⇒ **A check whose own control can fail silently is the
thing this family keeps rediscovering**, and that case exists because someone went
looking for it.

⚠ **I restated their count without checking it**, into this document, which elsewhere
records that *a measurement attached to a claim suppresses the reader's verification*.
⇒ The rule applies to flattering numbers too: "7 fixes" was more impressive than "2
fixes, 7 cases", and that is exactly when it goes unchecked.

⛔ **But all 8 files of that kit carry host identifiers** — including both test scripts.
Measured: the references are in **comments, headers and usage examples**, not in the
executable logic (the offline test's single hit is a comment reading *"no ⟨host⟩, no
window"*). ⇒ So for a lane's own **private** repo nothing is wrong; the constraint is
purely base's **publication** one.

⇒ **Therefore what base lifts is the CHECK STRUCTURE, not the files:** the PASS/FAIL
exit, the three-row GL comparison with its forced-software control, and the
one-negative-control-per-guard pattern — re-expressed with role-based prose. ⚠ Anyone
doing this should expect a **re-write of the text and a port of the logic**, and should
not plan it as a copy: *"we will lift their tests"* under-estimates it, and a sed over
hostnames is the shape this repo already caught itself doing (a redaction that replaced
an alias with a name derived from the real hostname).

⚠ **And what remains genuinely a checklist**, because it cannot be executed from base:
whether a **human** could actually see and use the window. That one stays prose, and
should say so rather than hiding among the executable items — `gu1d`'s own point that a
CDP probe tells you nothing about whether a human can attach.

## ⚠ What this does not cover

* ⛔ **WIRING IS NOT THE CONSTRAINT — THE HARNESS IS.** This section previously
  said `fetlife-webctl` had no submodule mounted. Stale since `2c881e9`: it is
  wired, `tier: full`, and CAPABLE. **And it still cannot run `gui`.**

  Falsified by that lane against its own tree: it has `lib/client-config*.js` and
  nothing else — no `dockerfiles/`, no driver adoption, no `docker-ctl`, no
  `xpra-attach`; its CLI takes `--remote-debugging-port` as a REQUIRED option
  because **it never launches or manages a browser**, it attaches to one a human
  started. There is no container, so `running` / `html5Answering` / `attach`
  describe state the lane does not possess.

  ⇒ For the eight lanes with nothing, `gui` is **not additive** — it
  **presupposes the docker harness**, which is the other half of Greg's ask. The
  prior dependency is **harness → `gui`**, not wiring → `gui`. Two lanes are now
  wired and neither can attach to anything, which is the measurement that settles
  it.
* **It does not make the two existing lanes symmetric by itself.** They must each
  rewrite against this surface and diff before switching (`v0.9.0`'s half-lift is
  the standing warning).
* **It says nothing about which browser is running** — that is the browser axis,
  deliberately a separate release.

## Sequencing

**Two releases, not one**, and not merely because of size:

* `gui` is **additive** — a new surface over state base already computes, once
  the provenance is unblocked. No existing caller changes.
* The browser axis changes the driver's **identity**:
  `createChromiumDockerXpra()`, the mode keys `chromium-docker-xpra-{base}-latest`
  (`:58`), and the Chromium-specific error text at `:361`. That is a rename every
  consumer's mode string must follow.

⇒ Shipping them together would force a lane adopting `gui` to absorb a
driver-identity change at the same time, for no reason other than calendar.
