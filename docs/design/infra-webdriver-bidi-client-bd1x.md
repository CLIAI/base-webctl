---
id: bd1x
title: "WebDriver BiDi client — driving firefox, with the four measured constraints"
category: infra
created: "2026-10-03"
updated: "2026-10-03"
status: draft
tags: [bidi, webdriver, firefox, protocol, websocket, control]
tech:
  - name: "Firefox"
    version: ">=141 (no CDP); measured on 156"
  - name: "WebDriver BiDi"
    version: "W3C working draft"
relates_to: [v7x3, rx9q, nl0c, lg1n, k3wn]
depends_on: [rx9q]
expands: [v7x3]
similar_to: [v7x3]
---

# WebDriver BiDi client — driving firefox, with the four measured constraints

## 0. Why

Firefox **removed its CDP implementation in v141** (140 ESR is the last with it); its
automation protocol is **WebDriver BiDi**. Base's `cdp-client` (`v7x3`) therefore drives
chromium and opera but cannot drive firefox, which is why `ENGINES_PENDING` holds
`firefox` (`nl0c` §1c). xq now publishes a firefox control surface with **adapter `bidi`**
(`rx9q` X6): `xq wait-ready <zone>/firefox --control bidi --json` returns
`{name:"bidi", kind:"tcp", adapter:"bidi", host, port}`, and the session URL is
`ws://<host>:<port>/session`.

This client is the BiDi backend behind base's control protocol layer: the layer picks the
backend from xq's **`adapter`** (`rx9q` §4), never from the engine name.

## 1. ⛔ Four constraints, MEASURED on Firefox 156 (by xq's lane, through xq)

1. **The `Host` header must name the port firefox listens on.** Firefox rejects a WebSocket
   upgrade whose `Host` names any other port (HTTP 400), and `--remote-allow-hosts` does not
   change that. xq makes firefox listen on the PUBLISHED port, so a local connection just
   works; **through a tunnel the client sends `Host: 127.0.0.1:<remote.port>`** whenever the
   local port differs from the remote one (`xq forward --detach` uses local = remote when it
   is free, so usually they match — but the client must not rely on it).
2. **`about:home` is privileged.** `browsingContext.navigate` to a `data:` URL and
   `script.evaluate` both fail there ("System access is required"). ⇒ The client works in a
   tab it creates (`browsingContext.create {type: "tab"}`). ⛔ It **never** requests
   `-remote-allow-system-access`, which would give the client chrome privileges; xq will not
   add it either.
3. **One session at a time.** A client that dies without `session.end` leaves the browser
   reporting `ready: false` ("Session already started") until firefox restarts. ⇒ Every
   session is ended in a `finally`; a session the client cannot end is reported, and the
   next caller's `session.new` failure says *why* (the browser holds a stale session), not
   a generic connection error.
4. **Readiness is a real upgrade, not a TCP connect.** xq's `wait-ready` for `bidi` performs
   a 101 upgrade and never sends `session.new`, so it does not consume the single session.
   The client trusts that readiness and does not add a probe that would.

## 2. Shape

* **Zero dependencies**, Node's built-in `WebSocket` (as `v7x3`). One `BidiSession` with
  `send(method, params, {timeout})` correlating `id`s, `on(event)` for `session.subscribe`d
  events, `end()`.
* **The same operation surface as the CDP backend** where the layer needs it: navigate,
  evaluate, screenshot, tabs (create / close / list) — each mapped to BiDi commands
  (`browsingContext.*`, `script.*`). Where an operation has no BiDi equivalent, the
  backend **refuses** it by name — never a silent no-op (`v7x3`: an option or operation the
  library does not honour is refused).
* **Unknown options refused** and the **per-method policy hook** apply here exactly as in
  `v7x3`, so a lane's policy works the same for both backends.
* **Timers cleared on close**, as `v7x3` learned the hard way (`k3wn`).

## 3. QA — every item executes, with its control

1. Tunnel `Host`: against a fake BiDi server that returns 400 unless `Host` names its own
   port, the client connects when local ≠ remote port. *Control:* a client sending the
   local port is refused by the same fake.
2. A session is ended on every exit path (success, thrown error, timeout) — a fake server
   records `session.end`. *Control:* removing the `finally` fails the test.
3. Work happens in a created tab: `browsingContext.create {type:"tab"}` precedes the first
   navigate. *Control:* the fake refuses `script.evaluate` in its "about:home" context.
4. An operation without a BiDi mapping is refused by name.
5. **Live, opt-in** (like `v7x3`'s live tests): against a real xq firefox zone — session,
   tab, navigate, evaluate `document.title`, close, end. Skipped, never silently passed,
   when no zone is declared.

## 4. What this does NOT do

* It does not start firefox (xq does — `rx9q`), nor choose where it runs (`nl0c`).
* It does not remove `firefox` from `ENGINES_PENDING` until §3's QA passes, including the
  live arm against a real zone.
