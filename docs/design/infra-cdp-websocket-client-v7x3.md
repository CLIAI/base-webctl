---
id: v7x3
title: "WebSocket CDP Client: Zero-Dependency Browser Automation RPC"
category: infra
created: "2026-03-03"
updated: "2026-10-03"
status: draft
tags: [websocket, cdp, chrome-devtools-protocol, rfc-6455, zero-dep, rpc]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
  - name: "Node.js"
    version: ">=18"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# WebSocket CDP Client: Zero-Dependency Browser Automation RPC

## Motivation

Browser automation tooling commonly depends on heavyweight libraries for
WebSocket communication and Chrome DevTools Protocol (CDP) interaction. These
dependencies introduce supply-chain risk, version churn, and bloated
`node_modules` trees. Since the WebSocket wire protocol (RFC 6455) and CDP's
JSON-RPC convention are both well-specified, a compact custom implementation
using only Node.js built-ins (`http`, `crypto`) delivers the same
functionality with zero external dependencies, smaller attack surface, and
full control over timeout and error semantics.

This document captures the reusable design of that client, distilled from
multiple independent implementations across the codebase.

## Design Principles

1. **Zero external dependencies** -- rely exclusively on Node.js standard
   library (`http`, `crypto`, `net`).
2. **Minimal surface area** -- expose only the methods automation scripts
   actually need; keep internal frame parsing private.
3. **Deterministic cleanup** -- every pending RPC must resolve or reject
   within a bounded timeout; no leaked timers or dangling handlers.
4. **Composable extensions** -- repo-specific conveniences (screenshots,
   performance hooks, async evaluation) layer on top of a shared core without
   modifying it.

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                   Automation Script                   │
├──────────────────────────────────────────────────────┤
│              Convenience Methods Layer                │
│  eval() | click() | escape() | screenshot() | ...    │
├──────────────────────────────────────────────────────┤
│                  CDP RPC Layer                        │
│  cdp(method, params, timeout) → Promise<result>      │
│  onEvent(method, handler)                             │
├──────────────────────────────────────────────────────┤
│              WebSocket Transport Layer                │
│  connect() | send() | processFrames() | close()      │
│  RFC 6455 framing, client-side masking                │
├──────────────────────────────────────────────────────┤
│           Node.js built-ins: http, crypto             │
└──────────────────────────────────────────────────────┘

         ┌─────────────────────────────┐
         │   HTTP CDP Helper (sidecar) │
         │  httpGetJson() for /json    │
         │  httpPutJson() for tab mgmt │
         └─────────────────────────────┘
```

## WebSocket Transport Layer

### Connection Handshake

The `connect()` method performs an HTTP/1.1 Upgrade request per RFC 6455
Section 4:

* Generate a 16-byte random `Sec-WebSocket-Key` via `crypto.randomBytes`.
* Send `GET` with `Connection: Upgrade`, `Upgrade: websocket`, and the key.
* Validate the server's `101 Switching Protocols` response.
* Transition the raw TCP socket to frame-based communication.
* Enforce a **5-second connection timeout** -- reject if the handshake does
  not complete.

### Frame Parsing (`processFrames`)

Implements RFC 6455 Section 5 data framing:

* Read the first two bytes to extract FIN bit, opcode, mask flag, and initial
  payload length indicator.
* Handle the three payload length encodings:

  * **7-bit** (0--125): length is the value itself.
  * **16-bit** (126): next 2 bytes as `UInt16BE`.
  * **64-bit** (127): next 8 bytes as `BigUInt64BE`.

* Buffer incomplete frames and re-enter when more data arrives.
* Dispatch complete text frames (opcode `0x1`) to the message handler
  registry.

### Client-Side Masking

Per RFC 6455 Section 5.3, all client-to-server frames **must** be masked:

* Generate a 4-byte mask key via `crypto.randomBytes(4)`.
* XOR each payload byte with `maskKey[i % 4]`.
* Set the mask bit in the frame header.

### Sending Data (`send`)

Construct a properly framed WebSocket message:

1. Encode payload as UTF-8 `Buffer`.
2. Build header: FIN=1, opcode=text, mask=1, payload length.
3. Append mask key and masked payload.
4. Write to socket.

### Graceful Close

`close()` ends the underlying TCP socket. Any pending CDP calls receive a
rejection so callers are never left waiting indefinitely.

## CDP RPC Layer

### Message Correlation

Each CDP call is assigned a **monotonically incrementing integer ID**. The
client maintains a map of `id -> { resolve, reject, timer }` to correlate
incoming responses:

```
outgoing:  { id: 42, method: "Runtime.evaluate", params: { ... } }
incoming:  { id: 42, result: { ... } }
                 ^--- matched by id, resolves the pending promise
```

### Per-Call Timeout

Every `cdp()` invocation accepts a timeout parameter (default varies by
use-case, commonly 10--30 seconds):

* On timeout expiry: reject the promise, remove the handler from the pending
  map, and clear the timer.
* On successful response: clear the timer, remove the handler, resolve with
  `result`.
* This guarantees **no leaked timers** regardless of outcome.

### Event Subscription

CDP pushes unsolicited events (e.g., `Page.loadEventFired`,
`Network.responseReceived`). The client provides:

* `onMessage(handler)` -- register a raw message handler.
* `offMessage(handler)` -- unregister.
* `onEvent(method, handler)` -- higher-level: invoke `handler` only when
  `message.method === method`.

Events are identified by the absence of an `id` field in the incoming JSON.

## Convenience Methods

These methods compose `cdp()` calls into higher-level automation primitives:

### `eval(expr, timeout)`

Wraps `Runtime.evaluate` with `returnByValue: true`. Returns the
deserialized result value directly, hiding the CDP response envelope.

### `evalAsync(expr, timeout)`

Like `eval()` but additionally sets `awaitPromise: true`, allowing
evaluation of expressions that return Promises.

### `click(x, y)`

Dispatches a sequence of pointer and mouse input events via
`Input.dispatchMouseEvent`:

1. `mouseMoved` to `(x, y)`
2. `mousePressed` at `(x, y)` with `button: "left"`, `clickCount: 1`
3. `mouseReleased` at `(x, y)`

An advanced variant uses `elementsFromPoint()` with interactive-element
piercing to find the actual clickable target beneath overlays.

### `escape()`

Dispatches `Input.dispatchKeyEvent` for the Escape key (keyDown + keyUp),
useful for dismissing modals, dropdowns, and autocomplete popups.

### `screenshot()`

Calls `Page.captureScreenshot` with format `"png"` and returns the
base64-encoded image data.

### `insertText(text)`

Uses `Input.insertText` to type text into the currently focused element,
bypassing keyboard event simulation for reliable text entry.

## HTTP CDP Helper

A companion utility for interacting with the browser's HTTP endpoints before
establishing a WebSocket connection:

### `httpGetJson(path)`

* Sends `GET` to `http://127.0.0.1:{port}{path}` (typically `/json` or
  `/json/version`).
* Parses the JSON response.
* Enforces a **5-second timeout**.
* On `ECONNREFUSED`, provides an **actionable error message** including the
  expected browser launch command with required flags
  (`--remote-debugging-port`, `--headless`, etc.).

### `httpPutJson(path, body)` / `httpRequestJson(method, path, body)`

* For newer browser APIs (120+) that require `PUT` for tab creation.
* Same timeout and error handling as `httpGetJson`.

## Performance Monitoring Hook

An optional callback hook enables latency tracking for CDP calls:

```
onCdpComplete(method, durationMs, status)
```

* **method** -- the CDP method name (e.g., `"Runtime.evaluate"`).
* **durationMs** -- wall-clock time from send to response.
* **status** -- `"ok"` or `"error"`.

This feeds into a sliding-window latency monitor for detecting browser
performance degradation during long automation runs.

## Error Handling Strategy

| Failure Mode             | Handling                                        |
|--------------------------|-------------------------------------------------|
| Connection refused       | Actionable error with browser launch hint       |
| Handshake timeout (5s)   | Reject connect promise, close socket            |
| CDP call timeout         | Reject call promise, cleanup handler and timer  |
| Malformed frame          | Log warning, skip frame, continue parsing       |
| Socket unexpected close  | Reject all pending CDP calls                    |
| CDP error response       | Reject with CDP error object (code + message)   |

## Implementation Checklist

* [ ] RFC 6455 WebSocket client with all three payload length encodings
* [ ] Client-side frame masking with `crypto.randomBytes`
* [ ] CDP JSON-RPC with monotonic ID correlation
* [ ] Per-call timeout with deterministic cleanup
* [ ] Message handler registry (add/remove)
* [ ] CDP event subscription (`onEvent`)
* [ ] Convenience methods: `eval`, `click`, `escape`
* [ ] Optional: `evalAsync`, `screenshot`, `insertText`
* [ ] HTTP helper for `/json` discovery endpoints
* [ ] Actionable `ECONNREFUSED` error messages
* [ ] Optional: performance monitoring hook

## ⛔ An option the library does not honour is REFUSED, never ignored

*Measured by `ccew` (via `webctl:mgr`), 2026-10-03:* `connectBrowser({readOnly: true})`
returned an ordinary session that still sent `Storage.getCookies`. The factories
(`connectBrowser`, `openPage`, `navigate`, `listTargetsCorroborated`) destructure the
options they know and silently drop the rest — so a caller passing a GUARD got an
unguarded session that looked guarded. The worst silent default there is.

⇒ **Rule:** every factory validates its options object against the keys it honours and
**throws on an unknown key, naming it**. This is also why the earlier exclusion of the
observer-only posture (header of `lib/cdp-client.js`) is now VISIBLE rather than silent:
asking for `readOnly` fails loudly instead of being dropped.

### The per-method policy HOOK — a mechanism, not a posture

Base still imposes no capability posture (the exclusion stands: most consumers drive by
design). It offers a **hook**: an optional `policy(method, params) → true | false | string`
threaded through every factory to the session, consulted before each CDP call; `false` or a
string refuses the call with that reason. A lane that needs an observer-only or
credential-deny posture supplies its own policy — `ccew`'s subclass and wrappers collapse
into one option — and no lane inherits a default it did not choose.

## ⛔ base drives only a tab base opened — never the human's tab by default (v0.32.0)

*Incident, 2026-10-03:* a mutation arm in a consumer lane navigated the human's ONLY tab in
a signed-in browser. The mechanism is `openPage()`'s default: `existing = listPageTargets();
target = existing[0]` → `reused: true`. The tab the human is reading is, by construction,
the first page target. A lane reported it on 09-27; another lane already WITHHOLDS
`openPage`/`navigate` from its own code for exactly this reason. So "reuse before minting"
was a hard-won rule for an unattended browser, and it was carried over as the default for a
browser a person is using.

⇒ **Rule.** `openPage()` drives a tab that base did not open ONLY when the caller names it
AND says how it knows the tab is its own. ⛔ An id alone is not enough. Base cannot tell "an
id I minted" from "the human's tab id copied out of `listPageTargets()`". Ownership by
inference would leave the hijack one copy-paste away *(`perplexity`'s review)*.

| caller passes | `openPage` does | `reused` | `close()` closes the tab |
|---|---|---|---|
| nothing (the default) | **mints a new target, in the background** | `false` | yes, unless `keep: true` |
| `{targetId, owner: 'minted'}` | drives it only if the id is in `ownedTargets` (below); else refused | `true` | no, unless `close: true` |
| `{targetId, owner: 'adopted'}` | drives a tab base did NOT mint: an explicit per-call adoption | `true` | **never** |
| `{targetId}` with no `owner`, or any other value | **refused**, naming the two choices | — | — |

* **`ownedTargets`**: an object with `has(id)` (a `Set` works). It defaults to the ids THIS
  process minted. A lane with a durable ledger (one own tab per browser, reused across
  invocations) passes its ledger here. Base offers the mechanism and imposes no store. The
  `1wsg` activity ledger is the natural one once it is in `lib/`. ⛔ Adopting a tab never
  adds it to `ownedTargets`. An adoption lasts for that call only.
* Whatever the owner, the target must exist and be a `page`; otherwise it is refused, naming
  the id.
* **Mint in the background:** `Target.createTarget({url, background: true, newWindow:
  false})`. A foreground mint steals focus in the human's xpra window. Measured hidden on
  Opera by `perplexity`.
* **Minting order.** Primary: `Target.createTarget` over the browser endpoint. Fallback:
  `/json/new` with PUT, then GET. Old decision 2 stands: `/json/new` is restricted in some
  builds.
* ⛔ **Mint through the tunnel.** `/json/version`'s `webSocketDebuggerUrl` names the REMOTE
  host:port behind an ssh forward. Both minting paths use `getVersion()`'s REWRITTEN
  authority (`rewriteWsUrl`), never the raw one.
* ⛔ **Fall back to `/json/new` only when nothing can have been minted**: the browser
  endpoint was unreachable before `createTarget` was sent, or the browser ANSWERED it with
  a CDP error. A LOST reply (timeout, dropped socket) may follow a tab the browser already
  made; a fallback would add a second tab and leave the first an orphan `onMinted` never
  saw. ⇒ Refuse, and say a tab may have been created *(measured by the review)*.
* ⛔ **If minting fails, REFUSE.** Never fall back to an existing tab. The error names the
  opt-in: `{targetId, owner: 'adopted'}`. A fallback to `existing[0]` would rebuild the
  incident on exactly the builds where minting is broken.
* ⛔ **Mint in the DEFAULT browser context.** The `createTarget` request carries no
  `browserContextId`. A fresh context lacks the human's sign-in, so every page would come
  back walled. A caller then "recovers nothing", silently *(`substack`'s review)*.
* ⛔ **Never close the LAST page target.** If ours is the only page left, closing it exits
  Chromium. That is how the linkedin browser was lost. `close()` instead navigates it to
  `about:blank` and leaves it open, and says so in its return value (`{closed: false,
  reason: 'last-page'}`). "Last" is read from the browser endpoint at close time, never
  remembered. Within one process, closes of base's own tabs are SERIALISED per browser
  authority: two concurrent closes each read "2 pages" and both closed, so Chromium exited
  *(measured by the review)*. ⚠ **Residual, which base cannot close:** a PERSON, or another
  process, closing a tab in the same instant. Reading the count and closing are two calls,
  and no CDP primitive makes them atomic.
* ⛔ **No "is this tab blank, so reusable?" heuristic, ever.** Blankness is not ownership.
  Opera's new-tab page is `chrome://startpage`, not `chrome://newtab`, so a human's start
  page would read as free. A URL describes what a tab shows, not whose it is.
* **Lifetime.** `keep: true` on a mint leaves the tab open at `close()`. That is how a lane
  creates its persistent own tab, records the id in its ledger, and reuses it later as
  `{owner: 'minted'}` with no reload churn. Old decision 1, the tab-leak fix, survives this
  way. `close: true` on an owned reuse closes it. An adopted tab is never closed by base.
* ⛔ **Record before attach: `onMinted`.** `openPage()` attaches before it returns the id.
  A process that dies between `createTarget` and its own ledger write (SIGKILL, OOM, a lost
  tunnel) leaves a `keep: true` tab ORPHANED in the human's browser, and nothing will ever
  close it, because nothing knows it is ours. ⇒ An optional awaited hook, `onMinted(id)`,
  runs after `createTarget` returns and BEFORE the first attach. If it throws, the
  just-minted tab is closed (under the last-page rule above) and `openPage` refuses,
  carrying the hook's error. It works with or without `keep` *(`perplexity`, which records
  before attach for this reason)*.
* `navigate(base, url, opts)` passes `targetId` / `owner` / `ownedTargets` / `keep` / `close` /
  `onMinted` through. Unknown option keys are refused (the rule above), so a stale `reuse: true` is told
  so, never silently given a new tab.

**BREAKING.** A caller that relied on the default reusing the first tab now gets a new tab.
Where reuse was meant, it must say whose tab it is. Lanes adopt this deliberately: it
changes what a signed-in browser shows.

**Migration.** A caller that uses `openPage()` only to get a session for BROWSER-level
calls (e.g. `Storage.getCookies`) must switch to `connectBrowser()`. Under mint-by-default,
every such call would otherwise open, and possibly leave, a blank tab.

**QA, each with its control:**

1. A browser with one pre-existing (human) tab: `openPage()` creates a new target with
   `background: true`. The human tab's URL is unchanged after a `navigate()` through it.
   *Control:* `{targetId: <human tab>, owner: 'adopted'}` drives that tab, and `close()`
   leaves it open.
2. ⛔ A `listPageTargets()` id passed as `{owner: 'minted'}`, or with no `owner`: refused,
   and the tab's URL is unchanged. *Control:* the id this process minted, as `'minted'`, is
   driven. So is an id that a caller-supplied `ownedTargets` contains.
3. Minting unavailable (both paths fail): refused with the opt-in hint. *Control:* the human
   tab's URL is unchanged, and no target was attached to.
4. Through a forward whose `/json/version` names a different (remote) authority: the mint
   connects to the local forward. *Control:* the raw authority is never dialled; the fake
   records every connection.
5. `keep: true` → the minted tab survives `close()`. *Control:* without it, it is closed.
6. The mint request carries no `browserContextId`. *Control:* a fake that records the
   request sees exactly `{url, background: true, newWindow: false}`.
7. ⛔ One page target, ours: `close()` leaves the browser with that page, at `about:blank`,
   and returns `reason: 'last-page'`. *Control:* with a second page present, ours is closed.
8. `onMinted` throws: no attach, the minted target is closed, and foreign tabs are
   unchanged. *Control:* `onMinted` resolves, and the recording fake shows the record
   strictly BEFORE the first attach to that target.
9. `{targetId}` naming an absent id, or a non-page target: refused, naming it.
   `openPage(base, {reuse: true})`: refused as an unknown option.

## Security Considerations

* **Local-only binding** -- The browser's debugging port should bind to
  `127.0.0.1` exclusively; never expose to network interfaces.
* **No eval of untrusted input** -- `eval()` and `evalAsync()` execute
  arbitrary JavaScript in the browser context. Callers must sanitize any
  user-provided values before interpolating into expressions.
* **Masking compliance** -- Client frames are always masked per RFC 6455.
  Servers must reject unmasked client frames; this implementation ensures
  compliance.
