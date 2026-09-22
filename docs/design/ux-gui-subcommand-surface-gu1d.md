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

| container | socket | meaning |
|---|---|---|
| not running | — | **stopped** — bring it up |
| running | dead | **running but unreachable** — a real incident |
| running | answers | reachable |

Collapsing the middle row into either neighbour is the failure this family
already paid for once: a port that was published, reserved, advertised through
`inspect()`, and answered nothing (`f6rd`, and the v0.6.0 html5 collapse). A
boolean `up` reports that stack as healthy or as absent, and both readings send
the operator somewhere useless.

⇒ **`tcpReachable: false` with `running: true` is the single most valuable thing
this surface can say.** It is the state no other command in the family reports.

## Ruling — the `xpra` alias

The two lanes disagree: linkedin marks `xpra` **deprecated**, chatgpt does not.
Ruled, so neither inherits the other's accident:

* **base ships the `gui` verb only.** `xpra` is never introduced by base.
* **A lane that already ships `xpra` keeps it, as a deprecated alias**, declared
  by that lane. Removing it breaks muscle memory and scripts for no gain.
* **The other eight lanes do not get it.** Introducing `xpra` there would be new
  debt on day one, and it names an **implementation** (the viewer) rather than a
  **capability** (the GUI).

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

* argument parsing, help text, or exit codes — those are the consumer's CLI,
  and `nho9` already governs dual-audience help;
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
