# FUTURE_WORK — xpra-html5 served on the TCP port; XPRA_HTML5_BIND (+1) is dead config

* **Category:** migrate (driver port-model reconcile)
* **Created:** 2026-06-24
* **By:** `webctl:base` (surfaced during gateway P1 live proof; manager-confirmed)
* **Concerns:** `lib/browser-location/chromium-docker-xpra.js` (xpra port wiring +
  `inspect()`), the xpra-html5 gateway P5 wiring (`infra-xpra-remote-access-gateway-f6rd`).
* **Status:** LOGGED — do NOT fix now (stay on the gateway). **Reconcile at gateway P5.**

## The finding (grounded against live containers)

The docker+xpra driver configures the container with **two** xpra binds:

```
XPRA_TCP_BIND:   0.0.0.0:${xpraTcpPort}      # e.g. 14327
XPRA_HTML5_BIND: 0.0.0.0:${xpraHtml5Port}    # = xpraTcpPort + 1, e.g. 14328
```

and publishes both to the host loopback. But against **running** sessions
(`linkedin-webctl-xpra-default`, `chatgpt-webctl-xpra-default`, 2026-06-24):

* `127.0.0.1:14327` (the **TCP** port) serves the html5 client —
  `GET /` ⇒ `200`, `<title>xpra websockets client</title>` (~57 KB), and the WS.
* `127.0.0.1:14328` (the **+1** / `XPRA_HTML5_BIND` port) **does not answer HTTP**
  (`curl` ⇒ `000`).

i.e. modern xpra serves the html5 client over its **TCP listener** (via
`--html=on` semantics), so the separate `XPRA_HTML5_BIND=+1` appears to be **dead
config** — a published-but-non-serving port. The real html5 endpoint is
`<xpraTcpPort>`, not `<xpraHtml5Port>`.

## Why it matters

* The gateway's `upstreamPort` must point at the port that **actually serves**
  html5. P1 takes `upstreamPort` explicitly, so it is unblocked — but the P5
  wiring (driver `inspect()` → gateway `slug→port`) must expose the **serving**
  port, not the `+1` bind. Today `inspect()` exposes `xpraHtml5Port` (=+1), which
  would point the gateway at the dead port.

## Reconcile at P5 (not now)

1. Confirm whether `XPRA_HTML5_BIND` / the `+1` port is ever live (some xpra
   versions / `--bind-tcp` vs `--html` combos). If genuinely dead:
2. Drop the dead `+1` publish/bind from the driver (one fewer published loopback
   port), OR keep it but stop treating it as the html5 endpoint.
3. Make `inspect()` expose the **actual serving html5 port** (`= xpraTcpPort` in
   the current image) as the gateway's single source of truth for `slug → port`.
4. Update `f6rd §2` (already carries the P1 grounding-correction note) once the
   driver port model is reconciled.

Cross-ref: `infra-xpra-remote-access-gateway-f6rd` §2 grounding correction.
