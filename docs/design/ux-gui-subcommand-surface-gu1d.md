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
             tcpReachable, html5Url, attach: {native, html5}}

gui-attach  {slug, mode: "native"|"html5", ok, exitCode|url|command, printCli?}
```

### ⛔ Three states, never two

`running` and `tcpReachable` are **separate fields and must stay separate**.

| `running` | `tcpReachable` | meaning |
|---|---|---|
| `false` | **`null`** | **stopped** — never probed, bring it up |
| `true` | `false` | **running but unreachable** — a real incident |
| `true` | `true` | reachable |

⛔ **`tcpReachable` IS NULLABLE, AND THAT IS THE WHOLE POINT.** A boolean `false`
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

Collapsing the middle row into either neighbour is the failure this family
already paid for once: a port that was published, reserved, advertised through
`inspect()`, and answered nothing (`f6rd`, and the v0.6.0 html5 collapse). A
boolean `up` reports that stack as healthy or as absent, and both readings send
the operator somewhere useless.

⇒ **`tcpReachable: false` with `running: true` is the single most valuable thing
this surface can say.** It is the state no other command in the family reports.

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
   `tcpReachable` above, in the same repo, found the same way.

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

**base does NOT ship:**

* argument parsing or help *rendering* — those are the consumer's CLI, and
  `nho9` already governs dual-audience help. ⚠ base DOES ship the exit-code
  vocabulary and the alias descriptions as **data** (see below); it never calls
  `process.exit`;
* the act of spawning a viewer. base returns *what to run*; the consumer runs it.
  A library that execs a GUI client on the operator's desktop is not a library.

## ⚠ What this does not cover

* **It does not help an unwired lane.** `fetlife-webctl` — the lane Greg named —
  has **no submodule mounted at all** (`wired:false`, tier `contracts`). Shipping
  this tag changes nothing for it until it is wired, and that wiring does not
  depend on this release.
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
