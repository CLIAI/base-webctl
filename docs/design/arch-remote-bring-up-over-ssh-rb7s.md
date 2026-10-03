---
id: rb7s
title: "Remote bring-up over ssh — the driver's work happens ON the target"
category: arch
created: "2026-10-03"
updated: "2026-10-03"
status: draft
tags: [remote, ssh, docker, transport, tunnel, profile, uid, bring-up]
tech:
  - name: "OpenSSH"
    version: ">=8"
  - name: "Docker CLI"
    version: ">=20.10"
relates_to: [btg4, rm7t, nl0c, ow9k, r7x2, lg1n, k3wn]
depends_on: [btg4, nl0c]
expands: [rm7t]
similar_to: []
---

# Remote bring-up over ssh — the driver's work happens ON the target

## 0. Why now

Greg, 2026-10-03: browsers run on a declared remote host by default, in chromium-in-
docker. The shared config now says WHERE (`nl0c` §1a); nothing yet says HOW. Two lanes
started that morning (`aliexpress`, `amazonde`) stopped before bring-up and listed what
is missing — the backlog `rm7t` §7 left open. This document is that HOW.

## 1. ⛔ The driver assumes it runs where the browser runs — six measured assumptions

`createChromiumDockerXpra` already accepts an injected `docker`. Injecting a remote one
is **not enough**, because the rest of the driver is local:

| # | where | local assumption | on a remote target it must be |
|---|---|---|---|
| 1 | `mounts.js` | profile/cache paths from the LOCAL home | the TARGET's home |
| 2 | bring-up | the profile dir is created locally (and docker would create a missing bind source as **root**) | created on the target, by the target user |
| 3 | `build` | `UID`/`GID` build args = the LOCAL process | the TARGET user's — a moved image ran as the wrong uid and chromium exited 133 (`rm7t` §3) |
| 4 | pre-flight | port free = a LOCAL socket probe | the target's listeners |
| 5 | `pollCdp` | dials `host:port` locally | through a tunnel to the target's loopback |
| 6 | profile lock, prefs | files written LOCALLY | next to the profile, on the target (`amazonde`) |

⇒ A remote bring-up is the driver's work done **on the target**, with every one of these
read from or performed on the target. Fixing one and not the others produces a browser
that half-exists in two places.

## 2. Two transports, each for what it is good at

* **Docker over `DOCKER_HOST=ssh://<alias>`** — docker's own ssh transport. Measured from
  the operator machine against the declared host: the remote server answered, and images
  built by base's driver were already there. It carries `run`, `exec`, `inspect` **and
  `build`** (the build context is streamed), so a remote build needs no file copying.
  `createDockerCtl({dockerHost})` returns the same interface as `docker-ctl.js`, bound to
  one target; the driver keeps taking it as `opts.docker`.
* **An ssh ARGV transport** for everything that is not docker: reading the target's
  facts, creating the profile dir, listing listeners, writing the lock.
  * Dedicated connection: `BatchMode=yes`, `ConnectTimeout`, `ControlMaster=no`,
    `ControlPath=none`, `ForwardAgent=no` (`btg4` §5, `rm7t` §1).
  * ⛔ **ssh joins its arguments into ONE remote shell string** (`r7x2` §1b) — an argv
    array does not survive the hop. Every element is therefore POSIX single-quoted before
    it is sent. A NUL byte is refused.
  * `ssh` comes from `PATH` and is **injectable**, so the `nl0c` §5.1 recording-stub
    control is base's, written once.

## 3. Target facts — read once, never assumed

`targetFacts(transport)` reads `$HOME`, `id -u`, `id -g` on the target in one call and
returns them, or an error naming which could not be read. Mounts, the profile dir and
the build's `UID`/`GID` come from these, never from the operator machine.

## 4. Reaching CDP and xpra — an owned, per-invocation tunnel

Ports are published on the **target's loopback** (they never leave it — `btg4` §5). The
operator reaches them through `ssh -N -L <local>:127.0.0.1:<remote>` with
`ExitOnForwardFailure=yes`, started and torn down by the invocation that needs it
(`tunnel = "per-invocation"`). The record's `local_cdp_port` is the LOCAL end; the
remote port is read live, never stored. ⚠ Who may tear a tunnel down is an `ow9k` question
(an unrecognised one is HELD); until Q8 is ruled, a tunnel is only ever closed by the
process that opened it.

## 5. Phases — each one testable before the next

1. **Transport + facts + remote docker-ctl** (no driver change). Tested with recording
   stubs, plus read-only probes of a real target.
2. **Driver on the target**: the driver takes `{docker, transport, facts}`; mounts,
   profile dir, uid/gid, the port pre-flight, prefs and the lock all go through them. A
   driver given a remote docker WITHOUT a transport is **refused**, never half-local.
3. **Tunnel** for CDP and xpra; xpra attach for login mode (`lg1n`).
4. **The lock on the target** — after `ow9k` Q8.

## 6. QA — every item executes, with its control

1. The ssh transport quotes every argv element: a value containing `'`, `;`, `$(…)` or a
   space reaches the target as ONE literal argument. *Control:* an unquoted join would
   split it — the test proves the quoting is what keeps it whole.
2. The transport's options include `BatchMode=yes`, `ControlMaster=no`, `ForwardAgent=no`.
   *Control:* a recording stub shows the exact argv.
3. A remote docker-ctl sets `DOCKER_HOST` for its child and ONLY for its child (the
   operator's environment is not mutated). *Control:* the default docker-ctl does not.
4. `targetFacts` refuses a malformed answer rather than defaulting a uid.

## 7. What this does NOT do

* It does not choose the target (that is `nl0c`), nor own the browser (`ow9k`).
* It does not copy profiles between machines. A browser moved to another host is a fresh
  login there — the person's decision.
