---
id: 6gi0
title: "Unix control endpoints — xq's shape, a zero-dep client transport, and the owned unix-to-unix forward"
category: infra
created: "2026-10-13"
updated: "2026-10-13"
status: draft
tags: [cdp, bidi, unix-socket, endpoint-schema, host-header, websocket, rfc6455, ssh-forward, owned-forward, xq, zero-dep]
tech:
  - name: "Node.js"
    version: ">=22.12 (measured 22.23)"
  - name: "OpenSSH"
    version: "streamlocal forwarding (-L path:path)"
  - name: "xq"
    version: "main 0a4fab6 (wait-ready --json schema 1)"
relates_to: [gvlx, rx9q, v7x3, bd1x, btg4, rb7s, ow9k, t2wf, nl0c]
depends_on: [rx9q, gvlx]
expands: [rx9q]
similar_to: []
---

# Unix control endpoints — xq's shape, a zero-dep client transport, and the owned unix-to-unix forward

> **Why unix at all:** `safety-owner-only-browser-channels-gvlx` §1. A TCP listener in a
> container is reachable by every local user through the bridge address, published or
> not, and CDP has no authentication. A socket in a sealed directory has the owner as
> its only peer.
>
> This document is the **wire contract**: what an endpoint looks like, how base's client
> speaks over one, and how a remote one is brought to this host. xq shipped its side at
> `0a4fab6`, which base read but did not run. Base's side is **design only**.

## 1. A zero-dep UNIX transport for base's CDP client (`v7x3`)

Today `lib/cdp-client.js` is TCP-only by construction. It uses Node's built-in `fetch`,
from four call sites (`/json/version`, `/json`, `PUT /json/new`, `/json/close/<id>`),
and the built-in `WebSocket`. *Measured:* the built-in `WebSocket` **refuses a unix
socket** (`Expected a ws: or wss: protocol, got ws+unix:`), and undici's `Agent` cannot
be reached without a dependency.

* **Every public entry point takes an `endpoint`** — the §2 shape, as it comes from
  xq's `wait-ready --json` or from base's own `inspect()`.
  * `host`/`port` stay as shorthand for `{transport:'tcp'}`.
  * Passing both an endpoint and `host`/`port` is refused, per `v7x3`'s
    refuse-unknown-options rule.
* **HTTP** goes through one internal `httpJson(endpoint, path, method)`.
  * TCP keeps `fetch`.
  * Unix uses `http.request({socketPath: endpoint.path, path, method, headers:{Host:
    endpoint.host_header}})`.
  * All four call sites go through it.
* **WebSocket** goes through a `UnixWebSocket` class (~150 lines).
  * It implements exactly the surface `CdpSession` uses: the constructor,
    `addEventListener('open'|'message'|'error'|'close')`, `send(string)`, `close()`
    and `readyState`.
  * It is injected through the **existing `WebSocketImpl` seam**, so the session code
    does not change.
  * The upgrade is `http.request({socketPath, headers:{Host: host_header, Upgrade:
    'websocket', …}})`, and `Sec-WebSocket-Accept` is **verified**.
  * Framing is base's own:
    * client frames are masked;
    * 7-, 16- and 64-bit lengths are handled;
    * continuation frames are reassembled;
    * ping is answered with pong;
    * the close handshake is completed;
    * text only, with no extensions offered.
  * `xpra-html5-gateway.js` is the precedent for raw upgrades. It pumps bytes and never
    frames, so the framing is new code and gets its own arms.
* **The websocket URL.** Chromium builds `webSocketDebuggerUrl` from the Host it
  received, so over xq's socket it says `ws://127.0.0.1:9222/devtools/…`. ⛔ When
  `transport` is `unix`, **only the URL's path is used**. Its host and port are never
  dialled: they name the container's netns loopback, not anything on this host.
  `cdp-rewrite` is bypassed rather than taught a fake host.
* The same transport serves **BiDi** (`bd1x`). Its constraint *"Firefox answers 400 to
  any Host but its own port"* is met by sending `host_header`. That is xq's measurement,
  and it matches `bd1x`'s Host-header finding through a tunnel.

## 2. ⭐ The endpoint shape — xq's, consumed exactly, and produced by base's driver

**As xq ships it** (`wait-ready --json`, schema 1, additive; xq main `0a4fab6`):

```json
{"name":"cdp","kind":"tcp","adapter":"cdp","transport":"unix",
 "host":null,"port":null,
 "path":"<host path>/zones/<z>/control/<container>/cdp.sock",
 "host_header":"127.0.0.1:9222"}
{"name":"cdp","kind":"tcp","adapter":"cdp","transport":"tcp","host":"127.0.0.1","port":47010}
```

**Field meanings, as xq defines them.** Base adopts them and does not reinterpret them:

| field | meaning |
|---|---|
| `kind` | the **image-declared** control kind: what the app listens on *inside*. Chromium's debug port is TCP, so `kind` stays `"tcp"` even when the host reaches it over a socket |
| `adapter` | the protocol: `cdp`, `bidi`, `raw` |
| `transport` | **how THIS host reaches it**: `"tcp"` or `"unix"` |
| `path` | the socket on this host. xq derives it from the container's **real mount**, never from a label |
| `host_header` | the `Host` a client must send through the socket — the app's own `127.0.0.1:<internal port>` |

⇒ ✅ **This supersedes `gvlx`'s first draft, which proposed `{kind:'unix'}`.** xq kept `kind` for
the inside and added `transport` for the outside, which answers the naming question
(`gvlx` Q9) better than either name proposed in the queue.

**Base consumes it exactly** — a pure `parseControlEndpoint(obj)` validates and returns
it unchanged. Each line below is an arm (A16):

* `transport` must be `"tcp"` or `"unix"`. Anything else is **refused**, never treated
  as tcp.
* `unix`:
  * `path` must be absolute, ≤ 107 bytes (sun_path), and `host`/`port` must both be
    `null`;
  * a non-null host or port beside a path is **refused** — two fields that say how to
    connect are the `t2wf` failure;
  * `host_header` is **required** and is never defaulted. Guessing the Host gets a 400
    from BiDi and is a location assumed (`nl0c`).
* `tcp`: `host` must be loopback (`gvlx` §7's rule) and `port` an integer.
  * `host_header` is optional; absent means `host:port`, which is what xq's own probe
    does.
* Unknown **additional** fields are ignored, because schema 1 is additive. An unknown
  **value** of a known field is refused.

**Base's own driver produces the same shape** — `inspect().ports.cdp.endpoint`:

```js
// owner-only (`gvlx` §6.1): the relay sidecar mounts <channelDir> at /run/webctl
{ name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'unix',
  host: null, port: null, path: '<channelDir>/cdp.sock', host_header: '127.0.0.1:9222' }
// tcp-legacy
{ name: 'cdp', kind: 'tcp', adapter: 'cdp', transport: 'tcp', host: '127.0.0.1', port: <port> }
```

* **`inspect()` is pure.** It reports the shape this cfg **would** produce.
* **`exposure()` and any attaching tool derive `path` from the running relay
  container's REAL mount** (`Mounts[].Source` where `Destination` is `/run/webctl`), as
  xq does. A configured path and a mounted one that disagree are an **error**, not a
  guess.
* **xpra is NOT a control endpoint** — it is not in `rx9q`'s control vocabulary — so it
  is reported beside it, not in this shape:
  `inspect().xpra = {socket: '<channelDir>/xpra.sock', auth: 'peercred', tcp: {host,
  port, auth: 'file', published}}`.
* ⛔ In owner-only mode `cdpHttpUrl` and `cdpWsBase` are **`null`**, never fabricated
  (`t2wf`). A consumer that builds a URL from them must fail on `null`.

**The sealed-ancestor check — for consumers, and for both producers.** xq's socket is
**mode 666**, because its sealed zone dir is the boundary (`gvlx` §10 D7). So the socket's own
mode tells a consumer nothing, and the consumer checks the **path** before connecting:

* there must be an ancestor directory **owned by the caller's uid with no group or other
  bits**;
* every path component below it must be owned by the caller's uid, so nobody else can
  swap one.

Otherwise the consumer **refuses**: a socket another user can reach is TCP with extra
steps. The ancestor it found is reported as `exposure.sealedBy`. *(Arm A17. It passes
on xq's layout, where the zone dir is sealed 0700, and on base's 0700 channel dir.)*

## 3. Alternatives refused

* **A host firewall by socket owner** (an `output` rule on `meta skuid`). It is outside
  base: it needs root, it drifts port by port, and it is **blind to other containers**,
  because forwarded traffic has no socket owner. It is the admin's defence in depth
  for `'tcp-legacy'` stacks. *Unmeasured.*
* **An authenticating TCP relay** (a token in the URL path). The token leaks into URLs,
  logs and argv; Chromium's JSON would need rewriting; and the listener stays on the
  bridge.
* **`--remote-debugging-pipe`**. Only the process that spawns Chromium can use it, and
  that is the in-container entrypoint, not a host client.
* ⛔ **A forward to a LOCAL TCP port.** It reopens the hole on a multi-user caller host.
  It is kept only as the explicitly named fallback `tcp-forward` (§4), reported as
  `exposure: local-users` for its lifetime.

## 4. ⭐ The owned unix → unix forward — the contract for xq's half

Remote targets (`btg4`, `rb7s`) need the remote socket on the caller's host. xq today
**refuses** a unix endpoint in `xq forward` and prints the `ssh -L sock:sock` line; this
section is the shape it builds. It extends xq's existing owned forward (`forwards.py`)
**without changing its rules**:

* the key is the target;
* a record is a claim, not proof;
* the ssh connection is dedicated.

**Invocation** (unchanged surface, new transport):

```
xq forward <u>@<h>/<zone>/<app> --control cdp --detach [--json]   # remote endpoint transport=unix ⇒ unix forward
xq forward <u>@<h>/<zone>/<app> --control cdp --stop   [--json]
xq forward <u>@<h>/<zone>/<app> --control cdp --detach --local-transport tcp   # the NAMED fallback only
```

**The local socket.**

```
<state_dir>/<key>/<control>.sock       state_dir = $XDG_RUNTIME_DIR/xq/forwards (0700)
                                       <key>/ = 0700, per target (machine, zone, app, control)
```

* The full path is checked against **≤ 107 bytes** before ssh runs, and **refused**
  with its length rather than truncated.
* ⛔ **`state_dir()` must verify, not merely create.** xq's fallback when there is no
  `$XDG_RUNTIME_DIR` is `/tmp/xq-<uid>`, made with `mkdir(exist_ok=True, mode=0o700)`.
  That **accepts an existing directory owned by another user**, and the mode argument
  is ignored when the directory already exists. *(Read from xq `0a4fab6`, not
  measured.)*
  * Another user can pre-create that predictable path and then read or swap the socket
    that holds a signed-in browser.
  * ⇒ Owner = uid and mode & 0o077 == 0 must be **asserted**, else refuse. This is the
    sealed-ancestor rule of §2, applied to the producer.

**The ssh argv.** The rules of xq's TCP argv are kept, and only the `-L` changes:

```
ssh -N -T -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=10 -o BatchMode=yes
    -o StreamLocalBindMask=0177 -o StreamLocalBindUnlink=no
    -L <abs local sock>:<abs remote path>  -- <machine>
```

* **`StreamLocalBindMask=0177`, given on the command line.** That makes the local socket
  0600 even if a user's ssh_config widens it; the command line wins over config. The
  0700 dir is the boundary, and 0600 is the second layer base keeps (`gvlx` §10 D7).
* **`StreamLocalBindUnlink=no`.**
  * A stale socket left by a killed ssh is removed **by xq**, inside its own 0700 dir,
    and only **after** the record check has proved no live owner.
  * ⛔ Letting ssh unlink unconditionally would let a racing second start delete a live
    forward's socket. With `ExitOnForwardFailure`, a lost race fails loudly instead.
* **`<abs remote path>`** is the **remote's** endpoint `path`, read from the remote's own
  `wait-ready --json` (a real-mount path, §2). It is never composed locally.
* **The remote side needs nothing new.**
  * sshd's `AllowStreamLocalForwarding` defaults to yes.
  * sshd connects as the ssh user, and that user must be the zone owner: the remote
    zone dir is 0700. A mismatch fails closed with `Permission denied`, and the error
    should name it.
* `--` ends option parsing before `<machine>`, as in xq's TCP argv.

**Readiness — never a bare connect.** ssh accepts a local connection **before** it has
connected the remote end. That is the same trap xq documented for socat in front of
Firefox. ⇒ Readiness is the **adapter's** probe through the local socket, sending
`host_header`:

* `cdp`: `GET /json/version` returns JSON;
* `bidi`: an upgrade on `/session` returns 101.

**Stop.**

1. Kill the recorded pid only when `/proc/<pid>/cmdline` is **exactly** the launched
   argv and the process is ours (the existing rule).
2. Then unlink the local socket, and the `<key>/` dir if it is empty.
3. Stop is idempotent and always drops the record.

**The record and the JSON it prints** — the §2 shape, so a consumer cannot tell a
forwarded endpoint from a local one, plus the provenance:

```json
{"name":"cdp","kind":"tcp","adapter":"cdp","transport":"unix",
 "host":null,"port":null,"path":"<state_dir>/<key>/cdp.sock",
 "host_header":"127.0.0.1:9222",
 "forward":{"schema":1,"pid":<n>,"reused":false,
            "remote":{"machine":"<u>@<h>","transport":"unix","path":"<remote path>"}}}
```

* ⛔ **`host_header` passes through UNCHANGED** from the remote endpoint. It names the
  app's own port *inside* the remote container, and the tunnel does not change what the
  app expects. Rewriting it breaks BiDi with a 400.
* `--local-transport tcp`, the named fallback, emits `transport:"tcp"` with a loopback
  host and port, the remote's `host_header`, and `"exposure":"local-users"`. A consumer
  surfaces that, rather than treating it as equivalent.

**Base's half.** It holds no ssh code (`rx9q`: the tunnel is xq's).

* It calls `xq forward … --detach --json`.
* It runs the result through `parseControlEndpoint`, then the sealed-ancestor check.
* It connects, and calls `--stop` when done (`ow9k`: the forward belongs to the call
  that opened it).

## 5. Arms — every one can fail

| # | property | fails when | control (must pass) |
|---|---|---|---|
| A12 | the CDP transport over a socket | against a **fake CDP server on a unix socket the test creates** (`http` + RFC 6455): `Browser.getVersion` fails; a bad `Sec-WebSocket-Accept` is accepted; an unmasked client frame is sent; a 64-bit length or a continuation frame is mis-assembled; ⛔ **any TCP connect or listen happens** (a `net` spy) | the same calls over `{transport:'tcp'}` against a TCP fake succeed |
| A16 | `parseControlEndpoint` consumes xq's shape exactly | any of these is accepted: unknown `transport`; unix with a non-null host or port; unix without `host_header`; a relative or 108-byte path; a non-loopback tcp host | **xq's literal schema-1 JSON** (both transports, recorded as fixtures from `wait-ready_json_test.py`) parses unchanged; an unknown EXTRA field is ignored |
| A17 | sealed-ancestor check | it passes for a socket whose every ancestor is 0755, or whose sealed ancestor is foreign-owned, or which has a foreign-owned component below the seal | an xq-like layout (0700 zone dir above a 0755 control dir, socket 0666) passes; base's 0700 channel dir passes |
| A18 | unix transport sends `host_header` | the Host on `/json/version` or on the upgrade is anything but `host_header`; a dial to the host or port inside `webSocketDebuggerUrl` | a fake that answers **400 to any other Host** (as Firefox does) succeeds |
| A19 | the forward contract — **xq-side arms, specified here so the halves match** | the argv lacks any of `ControlMaster=no`, `ControlPath=none`, `ExitOnForwardFailure=yes`, `BatchMode=yes`, `StreamLocalBindMask=0177`, `--`; the `-L` has a TCP form while transport is unix; the local path is > 107 bytes or outside a verified 0700 dir; readiness by bare connect; `host_header` rewritten; stop kills a pid whose cmdline differs | a pre-created foreign `state_dir` ⇒ refused; a fake remote (a unix socket behind a socat "ssh") ⇒ ready only after the adapter probe |

**Integration (opt-in, throwaway containers, never `~/.ssh`):**

| # | arm | control |
|---|---|---|
| I11 | an owned unix → unix forward to a **throwaway sshd container** (its own key pair, made in a temp dir, never `~/.ssh`): `/json/version` through the local socket with `host_header`; another uid cannot reach the local socket | `--local-transport tcp` ⇒ reachable by another uid, and reported `local-users` |

## 6. Divergence from xq, named

| # | base | xq | why |
|---|---|---|---|
| **D9** | the forward's local `state_dir` is **verified** (owner, mode) | `mkdir(exist_ok=True, mode=0o700)`, with a `/tmp/xq-<uid>` fallback | an existing dir keeps its owner and mode; a pre-created `/tmp/xq-<uid>` would hold the socket. Requested of xq (§6.5, Q11) |

## 7. Open — needs a ruling

* **Q11 — xq's forward `state_dir`** (§6 D9): verify owner and mode of an existing dir, and
  drop or verify the `/tmp/xq-<uid>` fallback. This is xq's call, but base's consumer
  check (A17) refuses the result if it is not sealed.
* **Q12 — the forward's local path.** `<state_dir>/<key>/<control>.sock` under
  `$XDG_RUNTIME_DIR` is short enough for typical keys, but `<key>` grows with machine
  and zone names. Should xq hash the key when the 107-byte check would fail, or refuse?
  Refusing is the safe default; hashing loses readability.
