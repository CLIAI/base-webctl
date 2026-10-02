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
| **config** | a `default_target` the person wrote | the only place a default may live |
| *none* | — | ⛔ **refused**, with instructions, before any contact |

* The resolver reports **which layer won** and **which lower layers it shadowed**, so a
  surprising location is explainable (*"from the environment; the config's default was
  overridden"*).
* An empty or whitespace value is **unset**, not a location.
* ⛔ The refusal **names the three ways to fix it** and **never echoes a value**.
* The resolved value then goes through `validateTarget` — resolution decides *which*
  record; validation decides whether it is *acceptable*.

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
   ssh/docker.** *Control:* a target in config ⇒ it proceeds. Proven by a fake `ssh` and
   `docker` on `PATH` that record whether they were called.
2. **Precedence flag > env > config, proven with THREE DISTINCT hosts**, one per layer —
   with one host the test cannot tell which layer won.
3. **No host literal in code.** `findHostLiterals` scans the repo for the lane's known host
   names. ⚠ The names come from the **lane's own machine list** (e.g. the zone manager's
   `xq machine ls --json`), never from a list committed to a repository — base is public.
   *Control:* a planted literal is found. *Vacuity:* no names supplied, or no files
   examined, refuses rather than reporting clean.
4. **The target file is mode 600 and passes `validateTarget`.** *Control:* 644 is refused.

## 6. What base ships, and what the lanes do

| piece | owner |
|---|---|
| `resolveTarget` — precedence, shadowing, refusal with instructions | ✅ base, `lib/remotes.js` |
| `findHostLiterals` — the no-literal check, given names and files | ✅ base |
| `validateTarget`, `checkConfigMode` | ✅ base (v0.19.0+) |
| reading the flag/env/config layers; supplying host names | the lane |
| auditing every lane, dormant ones included | `webctl:mgr` |

## 7. What this does NOT do

* **It does not choose a location for anyone.** That is the point.
* **It does not migrate existing configs.** A lane whose users relied on an implicit
  default will start refusing; the refusal's instructions are the migration path, and the
  lane's release notes must say so.
* **A host literal in a comment is still found by the check.** Deliberately: in a public
  repo it is a leak whatever it does to behaviour.
