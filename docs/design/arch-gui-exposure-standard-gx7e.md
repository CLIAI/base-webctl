---
id: gx7e
title: "GUI exposure over the tailnet — one verb family, enforced by xq"
category: arch
created: "2026-10-03"
updated: "2026-10-03"
status: draft
tags: [gui, xpra, html5, tailnet, allowlist, exposure, xq, safety]
tech:
  - name: "Tailscale"
    version: "tailnet node identity"
  - name: "xpra"
    version: "html5 client"
relates_to: [rx9q, gu1d, f6rd, nl0c, ow9k, lg1n]
depends_on: [rx9q]
expands: [gu1d]
similar_to: [f6rd]
---

# GUI exposure over the tailnet — one verb family, enforced by xq

## 0. The ask

Greg, 2026-10-03 (verbatim, typed in a lane session): *"webctl base should provide ways
so I can in consisten way ask any webctl agent to run (probably under hood using xq) to
start/stop/list if runnig etc this access form xpra-html via tailscale whiltelisted ips
and ranges and so on, like some agents already implemented so webctl manager should
figoure out, point to "webctl base agent" to make it part of starnd, and order resto to
implement/import/upgrate as neeeded."*

**Survey (`webctl:mgr`, 12 repos):** no lane has lifecycle verbs for exposure; one lane
allowlists by tailnet DEVICE NAME (re-resolved every 60 s, with audit); xq exposes a zone
on the tailnet behind a one-time code bound to a single device, with no allowlist; base's
own `xpra-html5-gateway` is used by NO lane — and its defaults are unsafe (§5).

## 1. ✅ The boundary — the same rule as `rx9q` §1

| xq owns (the EXPOSURE — enforced where the socket is) | base owns (the VERBS every lane imports) |
|---|---|
| the listener, the allowlist enforced at the socket, grants, a durable mode-600 audit, a long-running relay so `unexpose` / `ls` need no Ctrl-C or restart | `gui expose …`, `gui unexpose`, `gui list`, `gui status`, plus the existing `gui attach` |
| THE record: `xq zone expose` writes the zone's `[access]`; hand edits stop being the interface | translating the verbs into xq calls; refusing early with good messages |
| refusals at the owner, whatever the caller | the same refusals, earlier |

⛔ **One record, not two.** The exposure record is xq's `[access]`. Base keeps **no** second
access file — two registries drift (`rm7t` §2). *(An earlier proposal had base own an
operator file; superseded here by xq's "one record".)*

⛔ **Every verb requires a target** (`nl0c`): exposing "the default browser" is a location
assumed, and exposure is the last place to assume one.

## 2. Allow rules — by identity, never by a name its owner sets

* **Allow by tailnet node identity**: the stable node ID, or (owner login AND device name).
  ⛔ A device NAME alone is not an allow rule — **each device's owner sets it**, so another
  tailnet member can rename a device to match `.*phone` *(xq's lane)*. Names are display
  labels.
* IPs and CIDRs are allowed rules too.
* ⛔ **Refused, in both places:** an empty allowlist; the whole-tailnet range; a bind while
  Tailscale is down. Refusing only at the caller would leave the owner open to any other
  caller.

## 3. TTLs — name which one

Three different clocks exist; a flag must say which: **`--expose-ttl`** (auto-unexpose the
whole exposure) is distinct from xq's **grant TTL** (the codeless-reconnect window) and
**code TTL** (how long a one-time code is valid). A bare `--ttl` is refused as ambiguous.

## 4. ⚠ OPEN — who sees the client's IP (xq's lane is measuring)

xq's single-device lock and same-IP codeless reconnect read the **peer IP**. A relay in
front makes every client look like the relay (loopback), and both second-factor checks then
**silently pass for everyone or fail for everyone**. Two shapes, to be decided by
measurement, not preference: (a) the relay owns the whole gate (allowlist + device lock +
grants) and xpra keeps only the code check; (b) xpra keeps the bind and its authenticator
gains the allowlist, with unexpose through xpra's control channel *if* that needs no
restart. ⛔ **Whichever ships, a test must prove the second factor distinguishes two
clients** — a check that passes for everyone is the failure this family keeps meeting.

## 5. ⛔ base's `xpra-html5-gateway` and access store — DEPRECATED

Used by no lane, and their defaults would be unsafe to inherit (verified by `webctl:mgr`):
the default CIDR allowlist is the whole tailnet; the gateway is enabled by default; loopback
is always trusted; the bind address is not checked to be a tailnet address; an empty
allowlist is never refused; audit goes to stderr.

✅ **Ruled:** deprecated now (documented, and the defaults are made **fail-closed** in the
next release — no lane is affected, none uses it); **removed** once X19 has shipped, since
exposure is xq's side of the boundary. `f6rd` is marked superseded by this document.

## 6. QA — every item executes, with its control

1. Exposing with an empty allowlist, or the whole-tailnet range → refused by base AND by xq
   (called directly). *Control:* a single node ID is accepted.
2. A device-name-only rule → refused as an allow rule. *Control:* node ID accepted.
3. The second factor distinguishes two clients behind whatever shape §4 picks.
   *Control:* the same client reconnecting within the grant TTL is allowed.
4. `--ttl` alone → refused as ambiguous; `--expose-ttl` auto-unexposes.
5. Every verb without a target → refused before any contact.

## 7. Order

After v0.31.0, the harness network isolation, and the browser host's xq update (Greg's
call). xq: X19 (`zone expose / unexpose / ls / status`). Base: the verb family once X19's
contract exists. Lanes: `webctl:mgr` orders the rollout.
