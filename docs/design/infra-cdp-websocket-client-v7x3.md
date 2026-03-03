---
id: v7x3
title: "WebSocket CDP Client: Zero-Dependency Browser Automation RPC"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
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

## Security Considerations

* **Local-only binding** -- The browser's debugging port should bind to
  `127.0.0.1` exclusively; never expose to network interfaces.
* **No eval of untrusted input** -- `eval()` and `evalAsync()` execute
  arbitrary JavaScript in the browser context. Callers must sanitize any
  user-provided values before interpolating into expressions.
* **Masking compliance** -- Client frames are always masked per RFC 6455.
  Servers must reject unmasked client frames; this implementation ensures
  compliance.
