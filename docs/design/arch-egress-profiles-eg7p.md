---
id: eg7p
title: "Egress profiles — declare which network a browser's traffic uses; never assume direct"
category: arch
created: "2026-10-10"
updated: "2026-10-10"
status: draft
tags: [egress, network, proxy, socks5, ssh-tunnel, wireguard, vpn, tor, xq, netvm, fail-closed, leaks]
tech:
  - name: "xq"
    version: "zone netvm property (none enforced; tor/vpn refused until built)"
  - name: "Docker networks"
    version: "internal bridge networks"
relates_to: [rx9q, nl0c, lg1n, ow9k, btg4]
depends_on: [rx9q, nl0c]
expands: [nl0c]
similar_to: [nl0c]
---

# Egress profiles — declare which network a browser's traffic uses; never assume direct

## 0. The ask

The human, 2026-10-10 (relayed by a consumer lane, request filed in that lane as
`docs/proposals/EGRESS-PROFILES-REQUEST.md`): every `*-webctl` browser profile DECLARES its
network egress — direct, an ssh tunnel, a SOCKS5/HTTP proxy, WireGuard, a VPN, Tor, … —
through one extensible list; several profiles may share one egress. Order of work: this
design FIRST, then initial support in base, inherited by every lane.

## 1. ✅ Ownership — the `rx9q` boundary, applied to the network

| xq owns (what RUNS) | base owns (what is DECLARED and JUDGED) | a lane owns |
|---|---|---|
| the egress container, the network joining browser containers to it, start/stop, health | the declaration (record keys, validation), resolution (flag > env > lane > shared), the verdict, the refusals | which egress each profile uses — nothing else |

⛔ **Build on xq's existing zone `netvm` property**, not a parallel mechanism. xq models a
network qube (Qubes vocabulary): `netvm none` is enforced today, and the tor/vpn kinds are
REFUSED rather than silently given NAT. An egress here IS an xq net zone; a browser zone's
`netvm` names it. Field names are xq's, unrenamed (`rx9q` §4).

## 2. Declaration — never assume direct

* A target or profile record carries **`egress = "<name>"`**. `<name>` resolves to a SHARED
  egress record under `~/.config/webctl/egress/<name>.toml` (mode 600, the same loader rules as
  shared targets: never written by base, a mode other than 600 refused).
* ⛔ **No key → REFUSED**, before any contact (the `nl0c` rule: a location assumed is a
  location wrong). Direct must be STATED: `egress = "direct"` is a reserved name meaning "no
  egress, deliberately".
* Resolution: `--egress` flag > `<TOOL>_EGRESS` env > the lane's config > the shared config;
  the source is reported like a target's (`nl0c` §1a).
* An egress record names its **`kind`** (`direct`, `ssh-dynamic`, `socks5`, `http-proxy`,
  `wireguard`, `vpn`, `tor`; the list is closed, an unknown kind refused) and the
  kind-specific, NON-secret parameters. Secrets live in files the record points to (§6).

## 3. ⛔ Fail closed — by topology, not by a check

The browser container's ONLY route is through the egress. The browser zone sits on an
**internal** network (no gateway to the host's uplink) whose sole exit is the egress
container. If the egress dies, traffic stops — nothing falls back to direct, at start or
mid-run. A start-time check is a second layer, never the only one.

`direct` gets an ordinary network; it is the only kind with a route of its own.

## 4. Leaks — each closed in the topology, each with an arm

* **DNS**: resolved through the egress (the browser zone's resolver is the egress), never the
  host resolver.
* **IPv6**: disabled on the internal network unless the egress carries it.
* **WebRTC/STUN**: Chromium policy (`WebRtcIPHandling: disable_non_proxied_udp`) plus the
  topology (no direct UDP path exists).
* **Background requests** (updates, safe-browsing): they leave only through the egress,
  because no other route exists; the browser's own update/safe-browsing are off by policy.

## 5. Proof, with a positive control — and nothing sensitive written down

A verdict "routed" that cannot say "not routed" is vacuous (`k3wn`). The check compares the
exit address seen THROUGH the egress with the one seen DIRECT, and refuses when they are
equal — against an endpoint the OPERATOR controls, or the egress's own report; never a
third-party "what is my IP" site chosen by base.

⛔ Exit addresses and endpoints are sensitive: never in repos, logs, JSONL or `where` output.
The verdict says `egress verified (exit differs from direct)` — not the addresses.

## 6. Secrets

WireGuard keys, VPN configs and proxy passwords are secret-class: in files mode 600 that the
egress record points to by path, read only by xq when it starts the egress; never in a target
record (records may be shared), never committed, never in logs or `where`.

## 7. Login mode (`lg1n`) uses the SAME egress

A site that sees one country at sign-in and another in use may lock the account. ⇒ The
login-mode browser uses the profile's declared egress, always; a login window whose egress
differs from the profile's is refused.

## 8. Privileged kinds are the human's call

`wireguard` and `vpn` need `NET_ADMIN` or a tun device in the egress container. Off by
default; enabling them is the human's security decision (like `rx9q` X8). Until then they are
REFUSED with that reason — never silently degraded.

## 9. Multi-tenant hosts

Egress containers and networks are `u<uid>`-scoped (the `ow9k` / `ib4k` §3a.5 rules), never
pruned, removed only by exact id or name; listen ports come from the family registry, never
standard ports.

## 10. What `where` reports

`egress <name> (kind <kind>, from <source>)` as machine fields. Never credentials, endpoints
or exit addresses.

## 11. Sharing and lifecycle — ⚠ OPEN (xq's lane to answer)

1. Who starts a shared egress (first user, or an explicit `xq` verb), and how users are
   counted (a LEASE, as the X-input lease in `ow9k`) so it is not stopped under another lane.
2. Restart: an egress restart must not reconnect a browser to a different exit silently —
   the verdict re-runs, and a changed exit is reported.
3. The capability base pins (`rx9q` §4): `xq capabilities` must list the egress verbs and
   kinds before base sends them.

## 12. QA — every item executes, with its control

1. A profile with no `egress` → refused before any contact. *Control:* `egress = "direct"` runs.
2. An unknown kind → refused. *Control:* a known kind is accepted.
3. Fail closed: stop the egress mid-run → the browser loses ALL connectivity (no direct
   fallback). *Control:* with the egress up, a request succeeds.
4. Proof: through a stub egress whose exit differs → verified; a stub "egress" that is in fact
   direct → refused as not routed.
5. DNS/IPv6/WebRTC leak arms against stubs, each with a control that shows the leak on a
   deliberately misconfigured topology.
6. `where` and every log line contain no endpoint, credential or address (a planted
   endpoint string is searched for and must be absent).
7. All tests under `isolated`, against stubs only; nothing reaches a real egress or the
   internet.

## 13. Order

1. This document; xq's lane answers §11 and the seam (verbs, fields, capabilities).
2. Base: declaration + resolution + refusals + `where` (no network needed; testable now).
3. xq: egress zones for the unprivileged kinds (`ssh-dynamic`, `socks5`, `http-proxy`, `tor`).
4. Base: the verdict and proof against xq's egress; then the privileged kinds once the human
   rules on §8.
