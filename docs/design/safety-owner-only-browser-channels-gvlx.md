---
id: gvlx
title: "Owner-only browser channels — xpra and CDP reachable by the owning account alone"
category: safety
created: "2026-10-13"
updated: "2026-10-13"
status: draft
tags: [docker-xpra, cdp, xpra, authentication, unix-socket, peercred, multi-user, threat-model, exposure, secrets, migration, fail-closed]
tech:
  - name: "xpra"
    version: "6.4.4 server (xpra-html5 19); 6.5 beta client"
  - name: "Chromium"
    version: "148.0.7778.178"
  - name: "socat"
    version: "1.8.0.3"
  - name: "Docker Engine"
    version: "29.7.2"
  - name: "Node.js"
    version: ">=22.12 (measured 22.23)"
relates_to: [gx7e, f6rd, v7x3, v59v, ow9k, gu1d, k3wn, rx9q, btg4, t2wf, f868]
depends_on: [ow9k, v59v]
expands: []
similar_to: [gx7e]
---

# Owner-only browser channels — xpra and CDP reachable by the owning account alone

> Raised as queue item **B2** (xpra auth) by a consumer lane and by the host admin;
> **B4** (refuse a non-loopback publish host) and **B5** (a per-user CDP channel) are
> folded in because they are the same property seen from three sides.
> **Design only — nothing in `lib/` has changed.** Every claim marked *measured* below
> was measured on throwaway containers built from a consumer's own driver images,
> never on a running browser (§9 lists each measurement).

## 0. The property, in one sentence

⭐ **Only the account that owns a browser can view it, type into it, or drive it.**

Today nothing enforces that. The docker-xpra driver gives each browser two channels,
and neither has authentication:

| channel | what it grants | today's shape |
|---|---|---|
| **CDP** | drive the browser: read cookies, run script, navigate — everything | `socat TCP-LISTEN:<port>,bind=0.0.0.0` in the chromium container, published on host `127.0.0.1:<port>` |
| **xpra** (native + html5) | see the screen, type, click — a signed-in session | `xpra --bind-tcp=0.0.0.0:<xpraTcpPort>`, no `auth=`, published on host `127.0.0.1:<xpraTcpPort>` |

## 1. ⛔ The finding that changes the design: loopback was never the boundary

The premise of B2/B4 was *"the ports are published on 127.0.0.1, so only local users
can reach them"*. **That is half the exposure.**

*Measured:* a container with **no published port at all**, running today's CDP relay
shape (`socat TCP-LISTEN:<p>,bind=0.0.0.0`), answered `GET /json/version` with the
browser's websocket URL:

* from **another uid** in the host network namespace, addressed to the container's
  **bridge address** — no publish involved;
* from **another container** on docker's default bridge.

The driver's pairs run on the **default bridge** (read-only `docker inspect` of
running pairs: `HostConfig.NetworkMode = bridge`). ⇒ Every in-container listener bound
to `0.0.0.0` is reachable by every local user and every default-bridge container,
**whatever the publish address is.**

⇒ Consequences:

* **B4 alone closes nothing locally.** It stops a LAN publish (worth doing, §5), but
  the local exposure survives it.
* "Remove the publish" is **not** a fix either — the measurement above had none.
* The fix must remove **every non-loopback TCP listener inside the pair's network
  namespace**, or put authentication on the ones that remain.

⚠ *Also measured:* behind a docker publish, xpra logs the peer of a host-originated
connection as the **docker bridge gateway**, not the client. ⇒ Any IP-based check
inside the container is meaningless for local connections (the same trap as `gx7e`
§4, arrived at from the other direction).

## 2. Threat model — who, and what each option does and does NOT stop

| actor | today (measured) | B4 only | xpra unix socket + peercred | html5 TCP + `auth=file` | CDP unix socket | host firewall by socket owner (admin) |
|---|---|---|---|---|---|---|
| **other local user, no docker** | full control of both channels, via `127.0.0.1` AND the bridge address | no change | ✅ stopped (dir 0700 **and** peercred, two layers measured) | session refused without the password (page and ws upgrade still answer) | ✅ stopped | stopped for host-originated traffic (unmeasured) |
| **local process of another uid** (daemon, CI runner, sandboxed tool) | same as above | no change | ✅ stopped | as above | ✅ stopped | as above |
| **another container on the default bridge** | full control via bridge address (measured) | no change | ✅ stopped (no `0.0.0.0` listener left) | session needs the password | ✅ stopped | ❌ forwarded traffic has no socket owner |
| **process of the SAME uid** (another lane, another tool) | full | full | full | full (can read the secret) | full | n/a |
| **docker-group co-user** (root-equivalent) | full | full | full via `docker exec`, mount, or `inspect` | full (reads the secret through a mount) | full | full |
| **another machine on the LAN** | blocked unless the publish host is widened | ✅ refused | — | — | — | — |
| **a tailnet viewer** | `gx7e`: xq's exposure, allowlist at the socket | — | — | the password becomes a factor that does **not** depend on peer IP (§4.3) | — | — |

⇒ Read the table as **the uid is the boundary**:

* Below the uid (two lanes of one account): **not a security boundary**, and this
  design does not pretend otherwise. Same-uid separation is `ow9k`'s job (ownership
  claims and locks) — it is about *intent*, not *access*.
* Above the uid (docker group): **root-equivalent by docker's design.** For them this
  design is **defence in depth only**. It raises the bar from *connect to a port* to
  *`docker exec` / mount*. That bar is visible in `docker events`, and connecting to a
  port is not.
* **For every other local user and process, this design is the whole defence** — and
  today there is none.

## 3. Recommendation, in one table

| channel | recommended | refused alternatives (why) |
|---|---|---|
| **xpra, native attach + presence** | **unix socket** in a host directory mode **0700**, bound with **`auth=peercred`** | password-over-TCP for local use (a secret to manage where none is needed) |
| **xpra html5** | **off by default** (no TCP published, TCP bound to the netns loopback). When on: TCP with **`auth=file`**, a per-target mode-600 secret in a **directory** mounted read-only | `auth=password,value=…` (the secret lands in argv); a relay onto the unix socket (peercred then sees the relay, and every local user passes) |
| **CDP** | **unix socket** via the in-container `socat` relay, in the same 0700 directory, socket mode 0600 | host firewall (outside base, root, per-port drift, blind to containers); an authenticating TCP relay (secret in URLs, needs rewriting, still on the bridge); `--remote-debugging-pipe` (only the parent process can use it) |
| **publish host (B4)** | **refuse** anything but loopback, at the driver **and** at `docker-ctl` | — |

## 4. The xpra channel

### 4.1 Mechanisms the image's xpra actually supports — measured

The image's xpra is **6.4.4**, and its `auth/` package ships `allow, capability, env,
exec, fail, file, gss, hosts, http_header, kerberos_*, keycloak, ldap, ldap3,
multifile, mysql, none, otp, otpscreen, pam, password, peercred, reject, sql, sqlite,
u2f`.

| test | result |
|---|---|
| unix socket in a bind-mounted host dir (0700), owner `xpra info socket://…` | ✅ session (`clients=0`) |
| same, **another uid** (dir 0700) | `Permission denied` at the directory |
| same, another uid, dir **and** socket opened to the world | `peercred access denied` — **the second layer holds alone** |
| `--bind-tcp=…,auth=file,filename=…`, right password (6.4.4 and 6.5 clients) | ✅ session |
| same, wrong password | `authentication failed` |
| same, no password, stdin closed | **no session** in 25 s — the client blocks on a prompt |
| same over `ws://` (the html5 transport): no / wrong / right password | no session / `authentication failed` / ✅ session |
| html5 static page `GET /` with `auth=file` | **200** — the page, and the websocket upgrade (**101**), are served unauthenticated; only the xpra session is gated |
| baseline: **no `auth=`** (today's shape), another uid via host loopback | ✅ **session** — the exposure, reproduced |

⛔ **A SYNTAX TRAP THAT FAILS CLOSED BY ACCIDENT.** The form
`auth=file:filename=/path` (colon — the older `--tcp-auth` spelling) is **accepted at
startup** and then **refuses every password, including the right one**. xpra 6 wants
`auth=file,filename=/path` (comma). It fails closed, so it is not a hole — but an arm
that only tests *"a wrong password is refused"* passes against it. ⇒ **Arm A2 tests
the right password too.**

### 4.2 Recommended shape

```
xpra container
  XPRA_BIND      = /run/webctl/xpra.sock,auth=peercred        # host: <channelDir>/xpra.sock
  XPRA_TCP_BIND  = 127.0.0.1:<xpraTcpPort>                     # html5 OFF: netns loopback only
                 | 0.0.0.0:<xpraTcpPort>,auth=file,filename=/run/webctl-secret/xpra.pass   # html5 ON
  mounts         = <channelDir>        → /run/webctl          (rw)
                   <secretDir>         → /run/webctl-secret   (ro, html5 ON only, xpra container ONLY)
  publish        = none | 127.0.0.1:<xpraTcpPort>  (html5 ON only)
```

✅ **No entrypoint change is needed on the xpra side** — *measured with the stock
consumer entrypoint*, unmodified. It passes `XPRA_BIND` straight to `--bind=` (its own
`mkdir -p "$(dirname "$XPRA_BIND")"` copes with the `,auth=` suffix), and
`XPRA_TCP_BIND` to `--bind-tcp=`. With `XPRA_TCP_BIND=127.0.0.1:<p>` the TCP listener
is **refused from the host netns at the bridge address** (*measured*). The netns
loopback is shared only by the pair itself.

⚠ **Why `127.0.0.1:<p>` and not "unset" when html5 is off.** The entrypoint declares
`: "${XPRA_TCP_BIND:=0.0.0.0:14500}"`. `:=` substitutes on **unset OR empty**, so
base cannot switch TCP off by omission. Omitting it re-arms the masked default the
driver already warns about, on `0.0.0.0` — the bridge exposure again. ⇒ Base must
**set** it to the netns loopback.

### 4.3 How attach keeps working

* **`xpra-attach.js`** — `attachArgs()` gains `socketPath`. In owner-only mode it emits
  `xpra attach socket://<channelDir>/xpra.sock`, never `tcp://`. *Measured:* the host's
  6.5 client against the 6.4.4 server over the socket.
* **`xpra-presence.js`** — `xpra info socket://<path>` instead of `tcp://127.0.0.1:<p>/`.
  Same `clients=` parse, which is unchanged.
* **html5 (`gui attach --html5`)** — the URL stays `http://127.0.0.1:<xpraTcpPort>/`.
  The human types the password into the client's own connect form (`connect.html` has
  the field; `index.html` reads `password` from the query string **or
  sessionStorage**).
  * ⛔ **Base never puts the password in the URL it opens.** `xdg-open <url>` places
    the URL in a browser process's argv, which **every local user can read** in
    `/proc/<pid>/cmdline`. That is the disclosure this design exists to stop.
  * ⇒ Base prints the URL **and the path** of the mode-600 secret, never the secret.
* **`gx7e` tailnet exposure** — with `auth=file` the remote viewer needs the password
  too. ⭐ It is a second factor **that does not depend on peer IP**. That is exactly the
  property `gx7e` §4 found missing behind a relay, so it informs that open question
  (option (b)).
* **The gui verbs (`gu1d`)** — `gui status` gains `exposure` (§7.2). `html5Answering`
  keeps its meaning, a 2xx from `GET html5Url`: the page still answers under
  `auth=file`, so the field stays honest. It means *the page answers*, **not** *a
  session is open*.

## 5. The CDP channel

### 5.1 Recommended: unix socket via the in-container relay — measured

```
chromium container (shares the xpra netns)
  chromium --remote-debugging-port=9222        # netns loopback only (Chromium ≥111 binds 127.0.0.1)
  socat UNIX-LISTEN:/run/webctl/cdp.sock,fork,mode=0600,unlink-early  TCP:127.0.0.1:9222
  env   LWC_CDP_UNIX=/run/webctl/cdp.sock      # NEW; LWC_CDP_PORT is NOT set in owner-only mode
  mount <channelDir> → /run/webctl  (rw)       # the same dir as xpra's socket
```

*Measured* (Chromium 148, headless, `--network none`, so the socket was the **only**
path in):

* the owner: `curl --unix-socket … /json/version` → the browser's version JSON;
* **another uid** with the dir mounted → refused at the 0700 directory;
* **zero-dep Node 22**:
  * `http.get({socketPath})` → `/json/version`;
  * `http.request({socketPath})` + an RFC 6455 upgrade → **101**, then
    `Browser.getVersion` round-tripped over the socket.
* ⚠ Node's **built-in `WebSocket` refuses a unix socket** (`Expected a ws: or wss:
  protocol, got ws+unix:`), and undici's `Agent` is not reachable without a
  dependency. ⇒ base's client needs its own transport (§5.2). This is not optional.

⚠ **The image entrypoint must change on this side**, and it is consumer-owned (base
ships no dockerfiles):

* Today `LWC_CDP_PORT` both enables `--remote-debugging-port` **and** starts
  `socat TCP-LISTEN:…,bind=0.0.0.0`, which is the bridge exposure.
* The new contract: `LWC_CDP_UNIX` set ⇒ enable CDP and relay to `UNIX-LISTEN` only.
* An **old entrypoint ignores the new variable**. Chromium then runs portless, so it
  **fails closed**: no socket ever appears. The driver must name that cause rather
  than time out (arm A11).

### 5.2 How base's CDP client connects (`v7x3`)

* `getVersion` / `connectBrowser` / `listTargets*` accept **`socketPath`** as an
  alternative to `host`+`port` (mutually exclusive — both given is refused, per
  `v7x3`'s refuse-unknown-options rule).
* HTTP goes through `node:http` with `socketPath`. The websocket goes through a small
  RFC 6455 client over `http.request({socketPath})`, injected through the
  **existing `WebSocketImpl` seam** of `CdpSession`. The session code itself does not
  change.
* The `webSocketDebuggerUrl` Chromium returns names `localhost` with no port. Over a
  socket the client uses **its path only** — the host part is meaningless there, so
  `cdp-rewrite` is bypassed rather than taught a fake host.

### 5.3 How `driver.inspect()` reports it

```js
inspect().channels = {
  dir:   '<channelDir>',                                   // 0700, owner = this uid
  cdp:   { transport: 'unix', socketPath: '<channelDir>/cdp.sock' }
       | { transport: 'tcp', host, port },                 // legacy only
  xpra:  { transport: 'unix', socketPath: '<channelDir>/xpra.sock', auth: 'peercred' },
  html5: null | { transport: 'tcp', host: '127.0.0.1', port, auth: 'file', secretPath },
}
inspect().exposure = { level: 'owner-only' | 'local-users', reasons: [ … ] }   // from cfg
```

* ⛔ **In owner-only mode `cdpHttpUrl` and `cdpWsBase` are `null`, not a fabricated
  URL.** `ports.cdp.value` stays the configured number (it still keys the port mutex),
  but **`ports.cdp` is no longer a way in**. Per `t2wf`, a field that keeps its old
  value while its meaning has changed reads as a measurement. ⇒ A consumer that builds
  a URL from `cdpHttpUrl` must **fail loudly** on `null` rather than connect to
  nothing.
* `inspect()` stays pure — it reports what this cfg **would** create. What a **running**
  pair actually exposes is `exposure()` (§7.2).

### 5.4 Alternatives, and why not

* **Keep loopback TCP, restrict by socket owner with a host firewall** — e.g. an
  `output` rule rejecting `meta skuid != <owner>` to the CDP port and the bridge
  subnet. It is **outside base** (root, the host admin's), drifts per port, and is
  **blind to other containers** (forwarded traffic has no socket owner). ⇒ A valid
  admin defence in depth, **not measured here**, never base's mechanism.
* **An authenticating TCP relay** (token in the URL path). The token ends up in URLs,
  logs and argv. Chromium's JSON would need rewriting to carry it, and the listener is
  still on the bridge. Strictly weaker than a socket.
* **`--remote-debugging-pipe`** — only the process that spawned Chromium can use it,
  which is the in-container entrypoint, not the host client.

## 6. B4 — refuse a non-loopback publish host

**Accepted:** `127.0.0.0/8`, `::1`. **Refused:** `0.0.0.0`, `::`, empty, `localhost`
(docker needs an address, and a name is a location assumed — `nl0c`), and every other
address, e.g. `192.0.2.10`.

**Where — refused in both places**, as `gx7e` §2 rules for exposure:

1. **The driver, in `ensureRunning()` before any docker call** — not in `createDriver()`.
   A read-only caller (`gui status`) must still be able to construct a driver and
   **report** the bad host through `exposure.reasons`.
2. **`docker-ctl.runDetached()`** refuses any `publish` tuple whose host is not
   loopback. That is the layer every caller passes through, including one that never
   built a driver.

`buildDriverCfg()` may refuse earlier, naming the source. It is not the guard, because
a hand-built cfg skips it (`inspect().portSourcesUnavailable` is the measured
precedent).

**Refusal text** (exit 4, CONFIG_ERROR):

```
refusing to publish <role> on <host>:<port> — not a loopback address.

The docker-xpra browser has no authentication on CDP, and a port published on a
non-loopback address is reachable from every machine that can route to this host.
<host> came from <source>.

Use 127.0.0.1 (the default), or remove the setting. To reach this browser from
another machine use `gui expose` (gx7e), which enforces an allowlist at the socket;
never widen the publish address.
```

## 7. Secrets, the channel directory, ownership and naming

### 7.1 Where things live

```
<stateRoot> = <XDG_STATE_HOME or ~/.local/state>/CLIAI/<CACHE_DIRNAME>      (v59v)
<key>       = first 12 hex of sha256(realpath(profilePath))                (ow9k §3: key on the TARGET)

<stateRoot>/run/<key>/            0700   channel dir: xpra.sock, cdp.sock (0600, created in-container)
<stateRoot>/auth/<key>/           0700   secret dir (html5 ON only)
<stateRoot>/auth/<key>/xpra.pass  0600   ≥32 random bytes, base64url
```

* **Why the state root, not `$XDG_RUNTIME_DIR`.** systemd-logind removes the runtime
  dir at the account's last logout. A container still running then holds a bind mount
  of a **deleted** directory, its sockets unreachable from the host until a restart.
  *(Known logind behaviour; not measured here — §10 Q8.)*
* **Why not inside the profile.** The profile is bind-mounted into the **chromium**
  container, where web content runs, and profiles get copied and exported. The secret
  must be visible to the **xpra container only** (arm A3).
* **Never in git, never in an exportable location.** Both roots are outside every
  repository. `f868`'s `.gitignore` template is the second line, not the first.
* **sun_path is 108 bytes.** The socket path is checked **before** start and refused
  with its length. A deep `XDG_STATE_HOME` makes the limit reachable (arm A7).

**Creation rules (each is an arm):**

* Base **pre-creates** the dirs at 0700. Docker would otherwise create a missing bind
  source **root-owned**.
* An existing dir with **group/other bits, or another owner, is REFUSED, not chmodded**.
  Silently tightening would hide whoever loosened it.
* The secret is created `O_CREAT|O_EXCL`, mode 0600 **at creation**, never chmodded
  after a write. A symlink or an existing file at the path is refused, not followed.

### 7.2 Rotation — measured, and the trap it avoids

* **Rotate = write a temp file in the same dir (0600, `O_EXCL`), fsync, `rename()`.**
  *Measured:* with the **directory** mounted read-only, the new password opened a
  session and the old one was refused — **no restart**. xpra re-reads the file per
  connection.
* ⛔ ***Measured trap:* with the secret mounted as a SINGLE FILE, the same rotation
  "succeeded" on the host, while the container kept the OLD inode.** The new password
  was refused; the old one still opened a session. A rotation that reports success
  and changes nothing is a `k3wn` check that cannot fail. ⇒ **Mount the directory,
  never the file** (arm A3, proven by I5's control).
* Rotation happens on every `gui html5 on`, and on demand (`gui html5 rotate`).
  Sessions already open are not cut. *(Expected from auth-at-connect; not measured.)*

### 7.3 Ownership and naming (`ow9k`)

* The **owner-only socket is identity by construction for the uid axis** (`ow9k`
  §4(ii)). Nothing but the owner can reach it, so *"is this browser mine?"* has no
  stale endpoint to answer wrongly.
  ⚠ It says nothing about **which lane** of that uid — the claim and the lock remain
  `ow9k`'s.
* Before declaring the channel up, the driver checks that **`stat(socket).uid ===
  process uid`**. This catches an image built for another account. *Measured:* an
  image whose baked uid differed from the dir owner's could **not create** its socket
  (`bind(…): Permission denied`) — it fails closed, and the driver must say why (arm
  A11).
* The key is the **target** (profile realpath), not the tool. A second tool of the
  same uid attaching the same profile learns the paths from a label on the xpra
  container (`<LABEL_NS>.channel-dir`), read with `docker inspect`. The directory
  is not secret; the label is only a path.
* The image records its build uid as a label (`<LABEL_NS>.image-uid`, set by
  `buildImage`, which already passes the `UID` build-arg). The driver checks it
  **before** `docker run` and refuses a mismatch. Absent ⇒ the post-start socket owner
  check decides.

## 8. Migration — what a lane must do

⛔ **Taking the fix means restarting the lane's browser container. That is the lane's
and its owner's call, never base's.** Base never stops, restarts or recreates a running
pair to apply this.

**Phase 0 — see the exposure, change nothing (next base release).**

* `driver.exposure()` — new, async, read-only. It reads the running pair with
  `docker inspect` only: `HostConfig.PortBindings`, the xpra container's
  `XPRA_TCP_BIND`/`XPRA_BIND` env, the chromium container's `LWC_CDP_PORT`/
  `LWC_CDP_UNIX` env, and its mounts. It returns
  `{level: 'owner-only'|'local-users'|'unknown', reasons[]}`.
* ⛔ It **must** report `local-users` for an in-container `0.0.0.0` listener **even
  with no publish** (§1). That is the fallacy this whole design exists to correct.
  Unknown is reported as unknown, never as safe.
* **The doctor / `gui status` line:**

  ```
  exposure  LOCAL-USERS  cdp: tcp 0.0.0.0 in netns, published 127.0.0.1:<p>; xpra: tcp, no auth
            → any local user can drive this browser. Fix needs a container restart (your call): gvlx §8
  exposure  owner-only   cdp: unix 0600 in 0700; xpra: unix peercred; html5: off
  ```

**Phase 1 — opt in (same release).** `cfg.channels = 'owner-only'`:

* consumer images need the chromium entrypoint's `LWC_CDP_UNIX` support, plus the two
  image labels;
* the xpra side needs nothing (§4.2);
* the default stays `'tcp-legacy'`, reported as `local-users` on every bring-up (a
  WARN, not a refusal).

**Phase 2 — the default flips (the release after).**

* `'tcp-legacy'` stays available as an explicit opt-in, still reported as exposed.
* ⭐ **The backward-compatible window:** `ensureRunning()` that finds a **running legacy
  pair** reuses it with a loud WARN and `exposure: local-users` — it does **not**
  refuse, and does not restart it. Bumping base never takes a lane's browser down.
* It **refuses** only when the cfg **explicitly** says `'owner-only'` and the running
  pair is not. A lane that asked for the property must not be told it has it.

**A lane's checklist.**

1. Bump base. Read `exposure` in `gui status` or the doctor.
2. Add `LWC_CDP_UNIX` to the chromium entrypoint, plus the labels.
3. Rebuild the images under the owning uid.
4. Move CDP callers to base's client with `socketPath`, or to `inspect().channels.cdp`.
   Third-party CDP clients: §10 Q1.
5. **The owner restarts the pair** at a time they choose.
6. Confirm `exposure owner-only`.

## 9. Arms — every one can fail, none touches a real browser

**Unit arms** — fake docker capturing `runDetached` args, as `chromium-docker-xpra.test.js`
already does. A temp `HOME` with `XDG_*` stripped (`v59v`), and each arm **proves it
wrote nothing outside its temp root**.

| # | property | fails when | control (must pass) |
|---|---|---|---|
| A1 | owner-only publishes nothing | any `publish` tuple captured | html5 on ⇒ exactly one, `127.0.0.1:<xpraTcpPort>` |
| A2 | xpra binds | `XPRA_TCP_BIND` not `127.0.0.1:` (html5 off); html5 on lacks `,auth=file,filename=`; the colon form appears; `XPRA_BIND` lacks `,auth=peercred` | legacy keeps `0.0.0.0` **and** reports `local-users` |
| A3 | mounts | channel dir missing on either container; the secret dir on **chromium**; the secret mounted as a **file** | secret dir ro on xpra only |
| A4 | CDP env | `LWC_CDP_PORT` set, or `LWC_CDP_UNIX` absent, in owner-only | legacy: `LWC_CDP_PORT` set |
| A5 | B4 | `0.0.0.0`, `::`, `''`, `localhost`, `192.0.2.10` reach any docker call, at the driver **or** at `docker-ctl` | `127.0.0.1`, `127.0.0.2`, `::1` accepted |
| A6 | dir mode | a pre-existing 0755 or foreign-owner dir is accepted, or silently chmodded | absent ⇒ created 0700; own 0700 ⇒ accepted |
| A7 | sun_path | a 108-byte socket path reaches `docker run` | 107 bytes accepted |
| A8 | secret creation | mode ≠ 0600 at creation; a planted symlink is followed; <32 bytes | fresh path ⇒ 0600, 0700 dir |
| A9 | secret never disclosed | the secret's bytes appear in any captured spawn argv, opened URL, or log line | **self-test:** planting it in a fake log line makes the arm fail |
| A10 | `exposure()` | a fake legacy pair with **no publish** but `XPRA_TCP_BIND=0.0.0.0:…` reads `owner-only` | a fake owner-only pair reads `owner-only` |
| A11 | capability + uid gates | owner-only with an image lacking the cdp-unix label, or with `image-uid ≠ getuid`, reaches `docker run`; a missing socket times out without naming the entrypoint | matching labels proceed |
| A12 | CDP over a socket | the client accepts a bad `Sec-WebSocket-Accept`; `socketPath`+`port` together accepted | in-process fake (unix-socket HTTP + RFC 6455) answers `Browser.getVersion` |
| A13 | attach / presence | `tcp://` emitted in owner-only | `socket://<channelDir>/xpra.sock` |

**Integration arms** — opt-in, throwaway containers from the consumer's own images.
These are §4.1/§5.1's measurements made executable. Containers are named
`<prefix>-design-u<uid>-<pid>-*` and removed by exact name. They publish nothing, or
only ports verified free on `127.0.0.1`.

| # | arm | control |
|---|---|---|
| I1 | another uid via the mounted dir ⇒ `Permission denied` | owner ⇒ session |
| I2 | dir **and** socket opened ⇒ still `peercred access denied` | — (proves layer two alone) |
| I3 | html5 TCP: no password ⇒ no session; wrong ⇒ refused (tcp and ws) | right ⇒ session |
| I4 | another uid → `<bridge-ip>:<xpraTcpPort>` ⇒ refused (netns-loopback bind) | the legacy shape **answers** — the arm can tell them apart |
| I5 | rotation via rename, dir mount ⇒ new accepted, old refused | single-file mount ⇒ **old** still accepted (the trap, detected) |
| I6 | CDP: owner `Browser.getVersion` over the socket | another uid ⇒ refused |
| I7 | an image with a mismatched baked uid ⇒ socket creation fails, with the driver's named refusal | matching uid ⇒ socket owned by the owner |

**Measured, 2026-10-13:**

* **Versions.** xpra server 6.4.4-r0 (xpra-html5 19); host xpra client 6.5 beta;
  Chromium 148.0.7778.178 (Debian 13); socat 1.8.0.3; Docker Engine 29.7.2; Node
  22.23.
* **Probes.** All containers were throwaway. No running browser was connected to,
  inspected beyond `docker ps`/`inspect`, or signalled.

## 10. Open — needs a ruling

* **Q1 — third-party CDP clients.** A client that only speaks `ws://` TCP (e.g.
  `connectOverCDP`-style APIs) cannot use a socket. Options:
  * a per-invocation loopback forwarder, owned by the calling process and exposed for
    its lifetime, reported in `exposure`;
  * or `'tcp-legacy'` kept permanently as the escape hatch.
* **Q2 — html5 default.** Off is recommended (no TCP at all). On-with-password is the
  alternative for lanes whose humans live in the html5 client.
* **Q3 — the chromium entrypoint contract.** Should base ship a
  `CHROMIUM_CONTAINER_ENV_CONTRACT` (mirroring `XPRA_CONTAINER_ENV_CONTRACT`) and a
  reference entrypoint snippet for `LWC_CDP_UNIX`? Dockerfiles stay consumer-owned
  either way.
* **Q4 — the phase-2 flip and the explicit-cfg refusal (§8).** Confirm the timing, and
  confirm *"refuse only when owner-only was explicitly requested"*.
* **Q5 — same-uid lanes.** Accepted as one trust domain (recommended). Per-lane uids
  are the only real separation and are out of base's scope.
* **Q6 — docker-group co-users.** Documented as root-equivalent. Rootless or per-user
  docker daemons are the host admin's call, not base's.
* **Q7 — the host firewall by socket owner** — the host admin's option for
  `'tcp-legacy'` stacks. Unmeasured here (root).
* **Q8 — state root vs runtime dir for sockets.** The logout-removal reasoning in §7.1
  is known behaviour, not a measurement here. A ruling, or a measurement on a lingering
  account.
