---
id: nl0c
title: "Target resolution — never assume where the browser runs"
category: arch
created: "2026-10-02"
updated: "2026-10-02"
status: draft
tags: [targets, profiles, resolution, defaults, client, config, qa]
tech: []
relates_to: [btg4, lf4f, rm7t, lg1n, t2wf, k3wn]
depends_on: [btg4]
expands: [btg4]
similar_to: [lf4f]
---

# Target resolution — never assume where the browser runs

## 0. The rule

Greg, 2026-10-02: *"all webctl tools should not assume where containers [are] running
and require via flag clarity what to use or use config file"* — with named profiles
referenced by name, *"similarly like in ssh user can define server port key and so on
in .ssh/config and then refer to it by name"*.

> ⛔ **No location is ever implied by code.** A tool learns where its browser runs from
> exactly three places, in this order — **flag, environment, config** — and if none of
> them says, every browser-touching command is **refused with instructions, before any
> ssh or docker contact.**

✅ **A default is allowed — when a person DECLARED it.** Greg's own example: a remote
workstation over ssh *"defined in config as default"*. The line is between a default
someone **wrote down** (config) and a default the **code assumed** (a literal, a
fallback, `localhost`, `default`). The first is configuration; the second is the bug.

*(Reference implementation: `grok`, which resolves `--ssh <alias>` > env > its mode-600
config, and refuses with instructions at load when nothing is set.)*

## 1. Named targets — the `~/.ssh/config` model

A **target** is a named record holding everything needed to reach one browser: where
it is, how to reach it, which profile, who owns it. Defined once, referred to by name:

```
~/.config/webctl/targets/<name>.toml     mode 600       (btg4 §3)
<tool> --target <name> …                 refer by name
```

The record's keys and values are judged by `validateTarget` (closed key set, enums,
opaque `profile_id`, no leading-dash ssh alias). A file not mode 600 is refused
(`checkConfigMode`).

## 1a. ONE shared config, ONE loader — `loadSharedWebctlConfig()`

Greg, 2026-10-03: new lanes and existing ones *"all source from shared
`~/.config/webctl/`"*, with a declared default browser host and chromium-in-docker as
the default container. Every lane reading those files its own way would be the
duplication this family exists to stop, so base reads them:

```
~/.config/webctl/                    mode 700
~/.config/webctl/config.toml         mode 600   default_target = "<name>"
~/.config/webctl/targets/<name>.toml mode 600   one record per target (§1)
```

* **`loadSharedWebctlConfig({home})`** returns the default target's NAME as a
  **`shared`-layer** value for `resolveTarget` — below flag, env AND the lane's own config
  (§1b) — every record
  that validates, and an error per file that does not — naming the file and the key,
  never a value.
* ⛔ **A file not mode 600 is refused, not read** (`checkConfigMode`). A record that fails
  `validateTarget` is refused. A `default_target` naming no valid record is an error,
  never a silent fall-through to "no default".
* **TOML, a deliberate SUBSET** (zero dependencies): `key = "string" | integer | true |
  false | ["a", "b"]`, `#` comments. Anything else — tables, multi-line strings, dotted
  keys — is **refused with its line number**, never half-parsed.
* **No directory is an ordinary state**: `present: false`, no default, no error — and
  then `resolveTarget` refuses as it always has. The loader **never creates** the
  directory; base's tests prove it does not write.
* The DEFAULT is a person's declaration in their own home directory. The loader supplies
  no fallback of its own.

## 1b. ✅ RULED: the shared default is the LOWEST layer — a lane's own declaration outranks it

*Raised by `webctl:mgr` before any existing lane wired the loader.* Read literally,
"everyone sources from the shared default" would point lanes at the wrong browser:
lanes whose **signed-in** browsers live on one machine (profiles are never copied
between machines) would follow a shared default to another machine with no profile and
no login, and lanes running managed zones would read a `kind` that describes a different
driver. ⇒ **Composition:**

| rank | source | who declares it |
|---|---|---|
| 1 | **flag** | the person, on this command |
| 2 | **env** | the person, for this shell or unit |
| 3 | **config** | the LANE's own declaration (its config's default target) |
| 4 | **shared** | `~/.config/webctl/config.toml` — the family default |

* `loadSharedWebctlConfig().configLayer` is `{source: 'shared', …}`, never `config`. A
  lane with its own declared target therefore **ignores** the shared default (it is
  reported as `shadowed`); a lane that declares nothing **gets** it.
* ⛔ **A record is WHOLE, never merged.** Resolution yields a target NAME; that name's
  record comes from exactly one file. A lane's partial record does not inherit fields
  from the shared default, and the shared default does not fill in a lane's missing keys
  — two half-records combined is a location nobody wrote down.
* Moving a signed-in lane to another machine is a **re-login there**, which is the
  person's decision; changing the shared default never does it implicitly.

## 1c. ✅ RULED: the ENGINE vocabulary is base's — one resolver, one code set

Greg, 2026-10-03: the new lanes develop for chromium, opera and firefox, each in docker.
Two lanes built engine-aware layers the same day and **diverged** at once — different env
names, different refusal codes for the same rule, ~40 identical lines of glue each
(`webctl:mgr`). ⇒ Base defines it:

* **`firefox` is a valid `app`.** Validity is about the record; whether an engine can be
  DRIVEN is separate: **`ENGINES_PENDING`** (base-owned, `['firefox']` until base's WebDriver
  BiDi backend ships — Firefox removed CDP in v141, `rx9q` §2). A firefox record loads; a
  run that would drive it is refused `engine-pending`. No lane decides this alone.
* **`targetEnvKey(tool, 'engine')`** → `CLIAI_<TOOL>_BROWSER_ENGINE`.
* **`resolveEngine({flag, env, record})`** — a record that names an `app` describes what
  RUNS there: a flag or env asking for a different engine on that target is
  **`engine-conflict`**, refused, never overridden. A record without `app` lets flag > env
  decide. Fixed code set: **`no-engine` · `invalid-engine` · `engine-conflict` ·
  `engine-pending`**; a resolved engine reports its source like `resolveTarget` does.
* **`resolveSharedTarget({flag, env, laneConfig, hints})`** — the glue both lanes wrote:
  load the shared config, rank flag > env > laneConfig > shared, resolve, and return the
  record for the resolved NAME (whole, `§1b`) — or `record: null` with the reason when the
  name has no shared record.

## 2. ✅ RULED: `--target` is THE location flag; `--client` never chooses a location

`btg4` left the noun collision open. Settled here, once:

* **`--target <name>`** is the canonical flag that selects a **location** (a named target).
* **`--client`**, where a lane already ships it, may be kept **only as a synonym for
  `--target`** — both naming the *same* record. ⛔ It must **never** be a second,
  independent way to select a location: two flags that each choose where the browser is
  are two fields holding one value (`t2wf`), and they will disagree.
* A lane whose `--client` today selects a **persona or config layer** (and, by accident,
  part of a location — a measured case moves container identity but not the port) keeps
  that meaning for the persona, and takes the location from `--target`. The accidental
  coupling is what `btg4` already flagged; this is how it ends.
* `--ssh <alias>` stays a pass-through **shortcut for an unnamed target** reached over ssh
  (`btg4` §5) — it is a flag-layer value, not a fourth source.

## 3. Resolution — flag, environment, config; nothing implicit

| layer | example | note |
|---|---|---|
| **flag** | `--target workstation`, `--ssh workstation` | wins |
| **environment** | `<TOOL>_TARGET` | the tool's own prefix |
| **config** | the lane's own `default_target` | a default a person wrote for THIS lane |
| **shared** | `~/.config/webctl/config.toml` | the family default, for lanes that declare nothing (§1b) |
| *none* | — | ⛔ **refused**, with instructions, before any contact |

* The resolver reports **which layer won** and **which lower layers it shadowed**, so a
  surprising location is explainable (*"from the environment; the config's default was
  overridden"*).
* An empty or whitespace value is **unset**, not a location.
* ⛔ The refusal **names the three ways to fix it** and **never echoes a value**.
* The resolved value then goes through `validateTarget` — resolution decides *which*
  record; validation decides whether it is *acceptable*.
* ⛔ **Refuse only where the browser will actually be contacted.** A verb that never
  touches CDP — help, `--dry-run`, a worklist, config inspection — declares
  `needsTarget: false` and is **not** refused: refusing a run that had nothing to ask the
  browser is a vacuous red. *(From `substack`'s fix; adopted as the helper's contract.)*
* **Two locations in the same layer** (e.g. `--target` and `--ssh` on one command line)
  are **refused**, never raced.
* ⛔ **A refusal is a REASON OBJECT, never an exit code.** `resolveTarget` returns
  `{verdict: 'refused', code, reason, instructions}` with a machine `code` —
  `no-target` or `ambiguous` — and each lane maps the code onto **its own** exit table.
  Base choosing a number would collide with lanes whose tables already disagree.
* ⛔ **The helper documents ONLY the sources it implements** — flag, environment,
  config — **with a test per listed source.** A source named in a doc and absent from
  the code is a claim nothing checks; a lane reads the doc, not the function body.
* **The environment name is base's, not each lane's:** `targetEnvKey(tool, kind)` →
  `CLIAI_<TOOL>_BROWSER_TARGET` for a named target, `CLIAI_<TOOL>_BROWSER_SSH_TARGET` for
  an ssh alias — matching the variable the first implementing lane already uses, so no
  lane invents one and migrates later.

## 3a. ✅ RULED: an explicit `--port` is a DEFINED, attach-only target

*Raised by `cgwc` and `webctl:mgr`:* the family's unattended timers (an LRU janitor, a TTL
GC, a selector canary — in two lanes) locate the browser **only** by `--port N`, with no
target env. Read strictly, §3 would refuse them all; they would go FAILED and be visible
only to someone who pulls.

⇒ **`--port N` with no location flag is a flag-layer UNNAMED target, and its meaning is
DEFINED, not assumed:**

* **CDP at loopback `127.0.0.1:N` on the invoking machine**, source **`flag:port`**. The
  person wrote the port; the loopback host is the flag's documented meaning, not a
  fallback. Greg's rule forbids *inventing* a location — a port written in a unit file is a
  stated one.
* ⛔ **ATTACH-ONLY.** A port says where to **connect**, never where to **run**. A
  `flag:port` target never starts, builds, restarts or re-mints a browser or container; if
  nothing answers, the command fails. *This is the half of Greg's rule — "should not
  assume where containers [are] running" — that a port alone cannot answer, so it is not
  allowed to.*
* `--host`, if given, must be a **loopback literal** (`127.0.0.1`, `::1`; not `localhost`,
  which is a name and resolves). CDP never leaves loopback (`btg4` §5): a browser on another
  machine is `--ssh <alias>` or `--target <name>`. Refused with code `non-loopback-host`,
  the value not echoed.
* **Beside a location flag, `--port` qualifies that location** (e.g. the remote's CDP
  port) — it is not a second location and is not `ambiguous`.
* **Only the flag layer carries a port.** An env or config port **alone** is not a
  location and refuses as `no-target`; a declared location in config is a named target.
* No flags at all still refuses as `no-target`.

⚠ **Identity is NOT the listener's argv — measured while ruling this.** The QA rule in §5.5
(LISTEN form + the pid's argv) is for **signalling**. For **driving**, it cannot work: on a
docker-published port the listening socket belongs to a process the invoking user **cannot
read** (`ss -ltnp` shows the socket and no pid), so an argv check would refuse exactly these
timers. ⇒ Before a signal: listener + argv, and an unreadable pid means **no signal**. Before
driving: the ownership claim (`ow9k`) where the lane has one — not a process-table guess.

*Tested:* `--port` alone → resolved, `flag:port`, attach-only; no flags → `no-target`; env or
config port alone → `no-target`; out-of-range / non-numeric / two ports / non-loopback host
→ refused with their own codes; `--port` beside `--target` → qualifier.

## 3b. Refusal instructions name only the knobs a lane HAS; rulings from adoption

* **`hints.supports`** — the knobs this tool actually has (`target`, `ssh`, `port`, `env`,
  `config`). The `no-target` instructions then name **only those**. *(From `substack`: a
  lane relaying the generic text documented `--ssh` and `default_target`, which it has
  neither of.)* Without `supports` the generic text is kept; an unknown entry or an empty
  list **throws** — a typo must not silently drop a way to fix the refusal.
* ✅ **Ruled by `webctl:mgr` for `fetlife`, recorded here:** an **env port alone refuses**
  (strict §3a); a **named target's stated `local_cdp_port` counts** as a location for CDP
  commands, since the person declared it in the record. Full precedence:
  **`--target`/`--ssh` > bare `--port` > env > config.**
* *Noted, not ruled:* the closed target schema has **no runtime key** (docker mode, image
  base), so a lane may keep those as image-selection flags with defaults — a default for
  *which image*, not for *where*. If base adds a `runtime` key, lanes read it from the
  record instead.

## 4. `lf4f` is superseded in part

`infra-client-profile-registry-lf4f` (draft, earlier) is the `--client <profile>` registry
Greg remembers. Three of its rules contradict later decisions and are **superseded by
this document**:

| lf4f says | superseded by |
|---|---|
| an omitted `--client` silently means `default` | §3: nothing implied; unset → refused |
| a profile stores `user_data_dir` (a path) | `btg4` §2: an opaque `profile_id`, never a path (`FORBIDDEN_TARGET_KEYS`) |
| a profile stores `port` | `btg4` §4: ports are read live; a local tunnel port is `local_cdp_port` |

Its idea — named profiles referred to by name — is kept, and is this document.

## 5. QA — every item executes, each with its control

1. **No flag, env or config ⇒ every browser-touching command exits non-zero before any
   ssh/docker.** ⭐ **The QA shape:** *recording stubs* — a fake `ssh`, `docker` and
   browser launcher on `PATH` — prove **zero** calls on the refused run, **and a control
   on the same stubs shows they DO record when a target is stated.** Without that control
   a stub that never records (wrong `PATH`, a tool that resolves binaries absolutely)
   proves "zero calls" vacuously. *(Shape from `webctl:mgr`'s audit of the lanes'
   adoptions.)*
2. **Precedence flag > env > config, proven with THREE DISTINCT hosts**, one per layer —
   with one host the test cannot tell which layer won.
3. **No host literal in code.** `findHostLiterals` scans the repo for the lane's known host
   names. ⚠ The names come from the **lane's own machine list** (e.g. the zone manager's
   `xq machine ls --json`), never from a list committed to a repository — base is public.
   *Control:* a planted literal is found. *Vacuity:* no names supplied, or no files
   examined, refuses rather than reporting clean.
4. **The target file is mode 600 and passes `validateTarget`.** *Control:* 644 is refused.
5. ⛔ **"The browser on a port" is the port's LISTENER, and nothing is signalled on a port
   number alone.** `lsof -i :<port>` lists every *client* connected to the port as well; a
   lane took a pid from that output and SIGTERM'd its own test process. ⇒ Any helper that
   finds the browser by port uses the listener form (`lsof -nP -iTCP:<port> -sTCP:LISTEN`,
   or `-ti` for pids) **and checks the pid's argv** is the browser it expects before any
   signal. Base ships **no** kill-by-port helper; its port-conflict hint prints the
   listener form, tested in `test/port-conflict-hint.test.js` (with a sabotage run showing
   the old `-i :<port>` form fails it).

## 6. What base ships, and what the lanes do

| piece | owner |
|---|---|
| `resolveTarget` — precedence, shadowing, refusal with instructions, `needsTarget` scope | ✅ base, `lib/remotes.js` |
| `targetEnvKey` — the one env-name pattern | ✅ base |
| `findHostLiterals` — the no-literal check, given names and files | ✅ base |
| `validateTarget`, `checkConfigMode` | ✅ base (v0.19.0+) |
| reading the flag/env/config layers (incl. `--port` as `{source:'flag', port}`); supplying host names; honouring `attachOnly` | the lane |
| auditing every lane, dormant ones included | `webctl:mgr` |

## 7. ⛔ The FAMILY causes live in base — PLAN, not yet changed

`webctl:mgr` audited all 14 repos (read-only): **only one lane complies in code, and the
causes everyone else inherits are in base's own `lib/`.** Each is a location the code
assumes:

| # | where in base | the assumption |
|---|---|---|
| 1 | `client-config.js` `buildDriverCfg` | a missing port resolves to `DEFAULT_CDP_PORT` with source `default`, and `portOrigin` classifies `default` as legitimate |
| 2 | `client-config.js` | a `DEFAULT_HOST` fallback |
| 3 | `client-config.js`, `chromium-docker-xpra.js` | an xpra port *derived* from that defaulted CDP port |
| 4 | `client-config.js`, `mounts.js`, the driver | an implicit `default` client and profile slug |
| 5 | `browser-location/index.js` | `DEFAULT_MODE`: local docker unless told otherwise |
| 6 | `chromium-docker-xpra.js`, `xpra-attach.js` | literal port fallbacks (`cfg.port \|\| 4327`, `\|\| 14500`) — one lane's port living in the shared lib |
| 7 | `cdp-client.js` | `host = '127.0.0.1'` default, since copied into two lanes |

⇒ **The direction for each:** return *unstated* (`null`, source `unstated`) rather than a
fallback; keep `DEFAULT_CDP_PORT` as a **port reservation**, never a value a running
command uses; and let `resolveTarget` refuse at the top.

⛔ **Why this is a plan and not a commit:** every wired consumer calls `client-config`,
and several still carry **divergent copies** of `browser-location` from much older pins, so
a base fix reaches them only after they re-shim. Changing these returns is a breaking change
for each consumer that silently relied on the fallback. Per this repo's rule it is
**circulated before `lib/` changes**, then lands in one release whose notes lead with it as
breaking.

## 8. What this does NOT do

* **It does not choose a location for anyone.** That is the point.
* **It does not migrate existing configs.** A lane whose users relied on an implicit
  default will start refusing; the refusal's instructions are the migration path, and the
  lane's release notes must say so.
* **A host literal in a comment is still found by the check.** Deliberately: in a public
  repo it is a leak whatever it does to behaviour.
