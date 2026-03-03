---
id: ny8o
title: "WebSocket CDP Client: Zero-Dependency Browser Automation RPC"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [websocket, cdp, chrome-devtools-protocol, rfc-6455, zero-dep, rpc]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# WebSocket CDP Client: Zero-Dependency Browser Automation RPC

## 1. Motivation

Browser automation tools commonly depend on heavyweight libraries for WebSocket
communication and CDP interaction. These dependencies introduce version
conflicts, increase binary/bundle size, and obscure the protocol mechanics.

A zero-dependency WebSocket client that speaks CDP natively provides:

* Full control over frame parsing, masking, and fragmentation
* Deterministic timeout behavior per RPC call
* Transparent performance instrumentation without middleware
* Minimal attack surface and audit scope

This document specifies the internal architecture for such a client, covering
RFC 6455 frame handling, CDP RPC dispatch, convenience automation methods, and
operational monitoring hooks.

## 2. RFC 6455 Frame Parsing

### 2.1 Frame Layout

The WebSocket wire format (RFC 6455 Section 5.2) uses a variable-length header:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
|N|V|V|V|       |S|             |   (if payload len==126/127)   |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+-------------------------------+
|                     Masking-key (if MASK set)                  |
+-------------------------------+-------------------------------+
|                         Payload Data                          |
+---------------------------------------------------------------+
```

### 2.2 Implementation: Frame Reader

The frame reader operates as a state machine consuming bytes from a TCP stream.
All client-to-server frames must be masked (RFC 6455 Section 5.3).

```python
import struct
import os
from enum import IntEnum
from dataclasses import dataclass
from typing import Optional


class Opcode(IntEnum):
    CONTINUATION = 0x0
    TEXT = 0x1
    BINARY = 0x2
    CLOSE = 0x8
    PING = 0x9
    PONG = 0xA


@dataclass
class Frame:
    fin: bool
    opcode: Opcode
    payload: bytes
    mask_key: Optional[bytes] = None


def parse_frame(stream: bytes, offset: int = 0) -> tuple[Frame, int]:
    """Parse a single WebSocket frame from raw bytes.

    Returns (Frame, bytes_consumed). Raises ValueError if
    the buffer is incomplete.
    """
    pos = offset
    if len(stream) - pos < 2:
        raise ValueError("incomplete header")

    b0, b1 = stream[pos], stream[pos + 1]
    pos += 2

    fin = bool(b0 & 0x80)
    opcode = Opcode(b0 & 0x0F)
    masked = bool(b1 & 0x80)
    payload_len = b1 & 0x7F

    if payload_len == 126:
        if len(stream) - pos < 2:
            raise ValueError("incomplete extended length (16-bit)")
        payload_len = struct.unpack("!H", stream[pos:pos + 2])[0]
        pos += 2
    elif payload_len == 127:
        if len(stream) - pos < 8:
            raise ValueError("incomplete extended length (64-bit)")
        payload_len = struct.unpack("!Q", stream[pos:pos + 8])[0]
        pos += 8

    mask_key = None
    if masked:
        if len(stream) - pos < 4:
            raise ValueError("incomplete mask key")
        mask_key = stream[pos:pos + 4]
        pos += 4

    if len(stream) - pos < payload_len:
        raise ValueError("incomplete payload")

    payload = stream[pos:pos + payload_len]
    pos += payload_len

    if mask_key:
        payload = _apply_mask(payload, mask_key)

    return Frame(fin=fin, opcode=opcode, payload=payload, mask_key=mask_key), pos


def _apply_mask(data: bytes, mask: bytes) -> bytes:
    """XOR-mask payload data per RFC 6455 Section 5.3."""
    return bytes(b ^ mask[i % 4] for i, b in enumerate(data))


def build_frame(opcode: Opcode, payload: bytes, mask: bool = True) -> bytes:
    """Construct a masked WebSocket frame for client-to-server transmission."""
    header = bytearray()
    header.append(0x80 | opcode)  # FIN + opcode

    length = len(payload)
    mask_bit = 0x80 if mask else 0x00

    if length < 126:
        header.append(mask_bit | length)
    elif length < 65536:
        header.append(mask_bit | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(mask_bit | 127)
        header.extend(struct.pack("!Q", length))

    if mask:
        mask_key = os.urandom(4)
        header.extend(mask_key)
        payload = _apply_mask(payload, mask_key)

    return bytes(header) + payload
```

### 2.3 Control Frame Handling

Control frames (PING, PONG, CLOSE) must be handled inline during message
reassembly. The reader must respond to PING with a PONG containing the same
payload, and process CLOSE frames by echoing the close code and tearing down
the connection.

## 3. CDP RPC Dispatch

### 3.1 Message ID Management

Every CDP request carries an integer `id`. The client maintains a monotonically
increasing counter and maps each outstanding `id` to a pending future/callback.

```python
import json
import asyncio
from collections import defaultdict
from typing import Any, Callable


class CdpRpcClient:
    """CDP JSON-RPC dispatcher over a WebSocket connection.

    Features:
      - Auto-incrementing message IDs
      - Per-call timeout with configurable default
      - Event subscription via method-name patterns
    """

    def __init__(self, ws_send: Callable[[bytes], Any],
                 default_timeout: float = 30.0):
        self._ws_send = ws_send
        self._next_id: int = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._event_handlers: dict[str, list[Callable]] = defaultdict(list)
        self._default_timeout = default_timeout

    async def send(self, method: str, params: dict | None = None,
                   timeout: float | None = None) -> dict:
        """Send a CDP command and await its response.

        Args:
            method:  CDP method name, e.g. "Runtime.evaluate"
            params:  Optional parameter dict
            timeout: Per-call timeout in seconds (overrides default)

        Returns:
            The 'result' dict from the CDP response.

        Raises:
            asyncio.TimeoutError: If no response within timeout.
            CdpError: If the response contains an 'error' field.
        """
        msg_id = self._next_id
        self._next_id += 1

        message = {"id": msg_id, "method": method}
        if params:
            message["params"] = params

        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = future

        payload = json.dumps(message).encode("utf-8")
        frame = build_frame(Opcode.TEXT, payload)
        await self._ws_send(frame)

        effective_timeout = timeout if timeout is not None else self._default_timeout
        try:
            result = await asyncio.wait_for(future, timeout=effective_timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise
        return result

    def handle_message(self, raw: bytes) -> None:
        """Route an incoming CDP message to its pending future or event handler."""
        data = json.loads(raw)

        # Response to a request
        if "id" in data:
            msg_id = data["id"]
            future = self._pending.pop(msg_id, None)
            if future and not future.done():
                if "error" in data:
                    future.set_exception(CdpError(data["error"]))
                else:
                    future.set_result(data.get("result", {}))
            return

        # Event notification (no id field)
        method = data.get("method", "")
        for handler in self._event_handlers.get(method, []):
            handler(data.get("params", {}))


class CdpError(Exception):
    """Raised when CDP returns an error response."""
    def __init__(self, error: dict):
        self.code = error.get("code", -1)
        self.message = error.get("message", "unknown")
        super().__init__(f"CDP error {self.code}: {self.message}")
```

### 3.2 Per-Call Timeout Rationale

A global timeout is insufficient because CDP operations vary wildly in expected
duration:

| Operation                 | Typical Latency | Recommended Timeout |
|---------------------------|-----------------|---------------------|
| `Runtime.evaluate`        | 5-50ms          | 5s                  |
| `Page.captureScreenshot`  | 50-500ms        | 15s                 |
| `Page.navigate`           | 200ms-10s       | 30s                 |
| `Page.printToPDF`         | 500ms-30s       | 60s                 |

Per-call timeouts prevent fast operations from being blocked by a generous
global timeout, while allowing slow operations adequate time.

## 4. Event Subscription Pattern

CDP emits events (e.g. `Network.requestWillBeSent`, `Page.loadEventFired`)
as JSON messages without an `id` field. The client routes these by method name
to registered handlers.

```python
    # --- Event subscription API (part of CdpRpcClient) ---

    def on(self, method: str, handler: Callable) -> Callable:
        """Subscribe to a CDP event by method name.

        Returns the handler for use as a decorator or for later removal.
        """
        self._event_handlers[method].append(handler)
        return handler

    def off(self, method: str, handler: Callable) -> None:
        """Unsubscribe a previously registered event handler."""
        handlers = self._event_handlers.get(method, [])
        if handler in handlers:
            handlers.remove(handler)

    def once(self, method: str, timeout: float = 30.0) -> asyncio.Future:
        """Wait for a single occurrence of a CDP event.

        Returns a Future that resolves with the event params.
        """
        future: asyncio.Future = asyncio.get_event_loop().create_future()

        def _handler(params: dict):
            if not future.done():
                future.set_result(params)
                self.off(method, _handler)

        self.on(method, _handler)
        return asyncio.ensure_future(
            asyncio.wait_for(future, timeout=timeout)
        )
```

Usage pattern:

```python
# Wait for navigation to complete
load_future = cdp.once("Page.loadEventFired", timeout=30.0)
await cdp.send("Page.navigate", {"url": "https://example.com"})
await load_future

# Continuous event monitoring
@cdp.on("Network.responseReceived")
def on_response(params):
    url = params["response"]["url"]
    status = params["response"]["status"]
    logger.debug(f"HTTP {status} {url}")
```

## 5. Convenience Methods

High-level methods wrap common CDP patterns to reduce boilerplate and enforce
consistent error handling.

```python
class CdpAutomation:
    """High-level browser automation built on CdpRpcClient."""

    def __init__(self, rpc: CdpRpcClient):
        self._rpc = rpc

    async def eval(self, expression: str, await_promise: bool = True,
                   timeout: float = 5.0) -> Any:
        """Evaluate a JavaScript expression and return the result value."""
        result = await self._rpc.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        }, timeout=timeout)

        if "exceptionDetails" in result:
            exc = result["exceptionDetails"]
            raise RuntimeError(
                f"JS exception: {exc.get('text', 'unknown')}"
            )
        return result.get("result", {}).get("value")

    async def click(self, selector: str, timeout: float = 5.0) -> None:
        """Click an element identified by CSS selector.

        Uses JavaScript-level click to avoid coordinate calculation
        and viewport scrolling issues.
        """
        clicked = await self.eval(
            f"""(() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return false;
                el.click();
                return true;
            }})()""",
            timeout=timeout,
        )
        if not clicked:
            raise ElementNotFoundError(f"no element matches: {selector}")

    async def insert_text(self, text: str, timeout: float = 5.0) -> None:
        """Insert text at the current focus point using CDP Input domain.

        Preferred over synthetic keypress events for multi-byte and
        composed character support.
        """
        await self._rpc.send("Input.insertText", {
            "text": text,
        }, timeout=timeout)

    async def press_key(self, key: str, timeout: float = 2.0) -> None:
        """Dispatch a single key press (keyDown + keyUp).

        Args:
            key: Key identifier, e.g. "Escape", "Enter", "Tab"
        """
        for event_type in ("keyDown", "keyUp"):
            await self._rpc.send("Input.dispatchKeyEvent", {
                "type": event_type,
                "key": key,
            }, timeout=timeout)

    async def escape(self, timeout: float = 2.0) -> None:
        """Press the Escape key. Commonly used to dismiss overlays."""
        await self.press_key("Escape", timeout=timeout)

    async def screenshot(self, format: str = "png",
                         quality: int = 80,
                         timeout: float = 15.0) -> bytes:
        """Capture a screenshot of the current viewport.

        Args:
            format:  "png" or "jpeg"
            quality: JPEG quality (1-100), ignored for PNG

        Returns:
            Raw image bytes (base64-decoded).
        """
        import base64
        params: dict[str, Any] = {"format": format}
        if format == "jpeg":
            params["quality"] = quality

        result = await self._rpc.send(
            "Page.captureScreenshot", params, timeout=timeout
        )
        return base64.b64decode(result["data"])


class ElementNotFoundError(Exception):
    pass
```

## 6. HTTP CDP Helper

Before establishing a WebSocket connection, the client must discover available
debug targets via the browser's HTTP endpoints.

```python
import http.client
import json
from urllib.parse import urlparse


def cdp_http_get(endpoint: str, host: str = "127.0.0.1",
                 port: int = 9222) -> Any:
    """Query a CDP HTTP endpoint (e.g. /json, /json/version).

    Uses only stdlib http.client -- no external dependencies.
    """
    conn = http.client.HTTPConnection(host, port, timeout=5)
    try:
        conn.request("GET", endpoint)
        resp = conn.getresponse()
        if resp.status != 200:
            raise ConnectionError(
                f"CDP HTTP {resp.status} on {endpoint}"
            )
        return json.loads(resp.read())
    finally:
        conn.close()


def discover_ws_url(host: str = "127.0.0.1", port: int = 9222,
                    target_type: str = "page",
                    target_index: int = 0) -> str:
    """Discover the WebSocket debugger URL for a browser target.

    Args:
        host:         CDP host
        port:         CDP port
        target_type:  Filter by target type ("page", "background_page", etc.)
        target_index: Index within filtered targets (0 = first)

    Returns:
        WebSocket URL, e.g. "ws://127.0.0.1:9222/devtools/page/ABC123"
    """
    targets = cdp_http_get("/json", host, port)
    filtered = [t for t in targets if t.get("type") == target_type]

    if not filtered:
        raise RuntimeError(
            f"no CDP targets of type '{target_type}' found "
            f"among {len(targets)} target(s)"
        )
    if target_index >= len(filtered):
        raise IndexError(
            f"target_index {target_index} out of range "
            f"(only {len(filtered)} '{target_type}' target(s))"
        )

    ws_url = filtered[target_index].get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError("target has no webSocketDebuggerUrl")
    return ws_url


def get_browser_version(host: str = "127.0.0.1",
                        port: int = 9222) -> dict:
    """Retrieve browser version metadata from /json/version."""
    return cdp_http_get("/json/version", host, port)
```

## 7. Performance Monitoring Hook

### 7.1 Sliding Window Latency Tracker

A lightweight latency tracker that maintains a fixed-size sliding window of
recent RPC call durations. No external dependencies; uses only `collections.deque`
and `time.monotonic`.

```python
import time
from collections import deque
from dataclasses import dataclass, field


@dataclass
class LatencyStats:
    count: int
    mean_ms: float
    p50_ms: float
    p95_ms: float
    p99_ms: float
    max_ms: float


class PerformanceMonitor:
    """Sliding-window latency tracker for CDP RPC calls.

    Records call durations and computes percentile statistics
    over the most recent `window_size` samples.
    """

    def __init__(self, window_size: int = 200):
        self._window: deque[float] = deque(maxlen=window_size)
        self._method_windows: dict[str, deque[float]] = {}
        self._window_size = window_size

    def record(self, method: str, duration_s: float) -> None:
        """Record a single RPC call duration."""
        ms = duration_s * 1000.0
        self._window.append(ms)
        if method not in self._method_windows:
            self._method_windows[method] = deque(maxlen=self._window_size)
        self._method_windows[method].append(ms)

    def stats(self, method: str | None = None) -> LatencyStats:
        """Compute latency statistics over the sliding window.

        Args:
            method: If provided, compute stats for this method only.
                    Otherwise, compute aggregate stats.
        """
        window = self._method_windows.get(method, deque()) if method else self._window
        if not window:
            return LatencyStats(0, 0.0, 0.0, 0.0, 0.0, 0.0)

        samples = sorted(window)
        n = len(samples)
        return LatencyStats(
            count=n,
            mean_ms=sum(samples) / n,
            p50_ms=samples[int(n * 0.50)],
            p95_ms=samples[int(n * 0.95)] if n >= 20 else samples[-1],
            p99_ms=samples[int(n * 0.99)] if n >= 100 else samples[-1],
            max_ms=samples[-1],
        )
```

### 7.2 Integration with RPC Client

The monitor hooks into `CdpRpcClient.send` via a timing wrapper:

```python
class InstrumentedCdpClient(CdpRpcClient):
    """CdpRpcClient with automatic latency recording."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.monitor = PerformanceMonitor()

    async def send(self, method: str, params: dict | None = None,
                   timeout: float | None = None) -> dict:
        t0 = time.monotonic()
        try:
            result = await super().send(method, params, timeout)
            return result
        finally:
            self.monitor.record(method, time.monotonic() - t0)
```

Diagnostic output example:

```
CDP Latency (last 200 calls):
  aggregate        : p50=12ms  p95=89ms  p99=340ms  max=1204ms
  Runtime.evaluate : p50=8ms   p95=34ms  p99=120ms  (n=87)
  Page.navigate    : p50=450ms p95=2100ms             (n=12)
```

## 8. Connection Lifecycle

The full connection lifecycle ties together discovery, handshake, and teardown:

1. **Discover** -- HTTP GET `/json` to find target WebSocket URL
2. **Handshake** -- TCP connect, send HTTP Upgrade request with `Sec-WebSocket-Key`
3. **Enable domains** -- `Page.enable`, `Network.enable`, `Runtime.enable`
4. **Operate** -- Send commands, receive events, run automation
5. **Teardown** -- Send WebSocket CLOSE frame, await echo, close TCP socket

```python
async def connect_and_automate(port: int = 9222):
    """Example: full lifecycle from discovery to teardown."""
    ws_url = discover_ws_url(port=port)

    async with websocket_connect(ws_url) as ws:
        cdp = InstrumentedCdpClient(ws.send)

        # Enable required CDP domains
        await cdp.send("Page.enable")
        await cdp.send("Runtime.enable")

        # Perform automation
        await cdp.send("Page.navigate", {"url": "https://example.com"})
        await cdp.once("Page.loadEventFired", timeout=30.0)

        title = await CdpAutomation(cdp).eval("document.title")
        screenshot = await CdpAutomation(cdp).screenshot()

        # Print latency stats
        stats = cdp.monitor.stats()
        print(f"p50={stats.p50_ms:.0f}ms p95={stats.p95_ms:.0f}ms")

        return title, screenshot
```

## 9. Design Decisions

**Why zero-dependency?** The WebSocket protocol is simple enough that a correct
implementation fits in under 100 lines. External WebSocket libraries add
transitive dependencies, complicate vendoring, and may not expose the low-level
frame access needed for precise control-frame handling during long-running
automation sessions.

**Why per-method timeouts?** CDP operations span four orders of magnitude in
latency. A single timeout value either causes false timeouts on slow operations
or masks hangs on fast operations.

**Why sliding-window stats?** Fixed-size windows (a) bound memory usage, (b)
reflect recent performance rather than lifetime averages, and (c) are trivially
implemented with `collections.deque(maxlen=N)`.

**Why `Input.insertText` over synthetic keypresses?** `insertText` handles
Unicode, composed characters, and IME input correctly. Synthetic `keyDown`/`keyUp`
events bypass the browser's text input pipeline and fail on non-ASCII text or
contentEditable elements with custom handlers.
