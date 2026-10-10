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
relates_to: [rx9q, nl0c, lg1n, ow9k, btg4, ib4k]
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
* **WebRTC/STUN and QUIC**: explicitly DISABLED in the browser (policy/flags), not merely left
  to fail for lack of a UDP route — a half-blocked WebRTC can still leak LOCAL addresses via
  mDNS/host candidates (`webctl:mgr`). The topology (no UDP route) is the second layer.
  *Arm:* an `RTCPeerConnection` gathers NO host and NO srflx candidates; QUIC is off.
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

Egress containers and networks are owner-scoped (§11.1; the `ow9k` / `ib4k` §3a.5 rules),
never pruned, removed only by exact id or name. The egress proxy is never host-published, so
no host port is used (§11.0).

## 10. What `where` reports

`egress <name> (kind <kind>, from <source>)` as machine fields. Never credentials, endpoints
or exit addresses.

## 11. Sharing, lifecycle and the seam — answered by xq's lane (2026-10-10)

### 11.0 ⛔ The browser sees ONE explicit proxy — never a shared netns, never a gateway

* **Rejected, MEASURED by xq's lane:** `--network container:<egress>` (sharing the egress's
  netns). While the egress ran, an app in that netns reached a public site DIRECTLY, around the
  tunnel; it "failed closed" only when the egress died. Anything not forced through the tunnel
  (DNS, WebRTC, a background request) leaks.
* An internal network has NO default route (Docker's documented behaviour; xq's lane measures
  it in its own code path before claiming it). So the browser reaches the egress only as an
  EXPLICIT PROXY on that network — `socks5h://<egress>:1080` — never as a transparent gateway
  (that would need NET_ADMIN in the BROWSER, never).
* ⇒ **Every kind looks the same to the browser**: one SOCKS5 endpoint on the zone's internal
  network. Kinds differ only in how the egress container reaches out (direct NAT, `ssh -D`, an
  upstream socks/http proxy, a tor SocksPort, wireguard/vpn with NET_ADMIN/tun in the EGRESS
  only, §8).
* Consequences: DNS resolves remotely (`socks5h`), and Docker's embedded DNS on an internal
  network answers container names only, so a direct DNS lookup has nowhere to go; UDP/WebRTC
  has no route at all (browser policy stays as a second layer); nothing is host-published, so
  §9's port registry is not needed for egress.

### 11.1 Who starts it; who is using it

* Both: an explicit **`xq egress up <name>`** (idempotent, ensure-semantics), AND a browser
  zone whose `netvm` names an egress ensures it up first.
* ⛔ **The lease is DERIVED, not counted**: an egress's users are the running containers
  attached to its internal network, as Docker reports them. A counter or lease file drifts (a
  crashed lane never decrements it); the attachment list cannot.
* `xq egress down <name>` REFUSES while any non-egress container is attached, listing the
  zones, with its own exit code. No `--force` that stops it under others: those zones stop
  first. No auto-stop at zero users; `status` reports `users: 0`.
* Scope: per owner — `xq-egress.<owner>-<name>`, network `xq-egress.<owner>-<name>-net`,
  owner labels. Sharing is across ONE user's lanes, never across uids.

### 11.2 Restart and proof

* A restart drops in-flight proxy connections — that IS fail closed. The browser zone is not
  restarted; the egress keeps its name on the internal network.
* `status` carries **`generation`** (from the container's start time); base re-verifies
  whenever it changes.
* **`xq egress verify`** fetches the operator's OWN check endpoint (a field of the egress
  record; never a third-party default) twice — through the egress and direct — and returns
  `{routed, exit_fp, direct_fp}`, where `*_fp` is a SALTED HASH, never the address (§5). After
  a restart, `exit_changed` compares with the previous `exit_fp`. For kind `tor` the exit is
  per-circuit by design: `exit_changed` is expected and is not a fault.

### 11.3 Capabilities base pins (`rx9q` §4)

Verbs `egress up / down / ls / status / verify`, each `json_schema 1` with per-verb flags; a
new field **`egress_kinds: [{kind, privileged, enabled}]`** (xq's implemented kinds plus the
human's privileged-kinds setting). Base pins verb AND kind before sending; an xq without the
field is too old → fail closed.

`netvm`: `default | none | <egress-name>`. xq's old provider words (tor, mullvad, wireguard)
stay refused unless an egress of that name exists, so a zone file never silently changes
meaning.

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

1. This document. §11 answered by xq's lane (2026-10-10); it measures the internal-network
   topology in its own code path first.
2. Base: declaration + resolution + refusals + `where` (no network needed; testable now).
3. xq: egress zones for the unprivileged kinds (`ssh-dynamic`, `socks5`, `http-proxy`, `tor`).
4. Base: the verdict and proof against xq's egress; then the privileged kinds once the human
   rules on §8.
