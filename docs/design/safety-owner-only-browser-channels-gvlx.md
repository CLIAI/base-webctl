---
id: gvlx
title: "Owner-only browser channels — xpra and CDP reachable by the owning account alone"
category: safety
created: "2026-10-13"
updated: "2026-10-13"
status: draft
tags: [docker-xpra, cdp, xpra, authentication, unix-socket, peercred, multi-user, threat-model, exposure, bridge-network, file-modes, x11, pulse, secrets, migration, fail-closed]
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
relates_to: [gx7e, f6rd, v7x3, v59v, ow9k, gu1d, k3wn, rx9q, btg4, t2wf, f868, rb7s, 6gi0]
depends_on: [ow9k, v59v]
expands: []
similar_to: [gx7e]
---

# Owner-only browser channels — xpra and CDP reachable by the owning account alone

> Raised as queue item **B2** (xpra auth) by a consumer lane and by the host admin.
> **B4** (refuse a non-loopback publish host) and **B5** (a per-user CDP channel) are
> folded in, because they are the same property seen from three sides.
> **Design only — nothing in `lib/` has changed.**
>
> Every claim marked *measured* was measured on throwaway containers built from a
> consumer's own driver images. No running browser was connected to, exec'd into or
> signalled; running pairs were read with `docker ps` / `docker inspect` and `stat`
> only. The runtime layer (xq) measured the same exposure independently on its own
> template. Its findings are cited as **xq's** and the divergences are named (§10).

## 0. The property, in one sentence

⭐ **Only the account that owns a browser can view it, type into it, or drive it.**

Today nothing enforces that. The docker-xpra driver gives each browser two network
channels, and neither has authentication:

| channel | what it grants | today's shape |
|---|---|---|
| **CDP** | drive the browser: read cookies, run script, navigate — everything | `socat TCP-LISTEN:<port>,bind=0.0.0.0` in the chromium container, published on host `127.0.0.1:<port>` |
| **xpra** (native + html5) | see the screen, type, click — a signed-in session | `xpra --bind-tcp=0.0.0.0:<xpraTcpPort>`, no `auth=`, published on host `127.0.0.1:<xpraTcpPort>` |

…and file surfaces (X11, pulse, the profile) whose protection is a host directory
mode (§3).

## 1. ⛔ Loopback was never the boundary — the bridge address

The premise of B2/B4 was *"the ports are published on 127.0.0.1, so only local users
can reach them"*. **That is half the exposure.**

*Measured (and independently by xq, HTTP 200 from its own throwaway):* a container with
**no published port at all**, running today's CDP relay shape, answered
`GET /json/version` with the browser's websocket URL. It answered:

* **another uid** in the host network namespace, addressed to the container's **bridge
  address** (read from that container's own `docker inspect`);
* **another container** on docker's default bridge.

The driver's pairs run on the **default bridge** (read-only `docker inspect` of running
pairs: `HostConfig.NetworkMode = bridge`).

⇒ **Every in-container listener bound to `0.0.0.0` is reachable by every local user and
every default-bridge container, whatever the publish address.** Only authentication, or
file permissions, is a boundary.

* **B4 alone closes nothing locally.** It stops a LAN publish (§7), but not the local
  exposure.
* **Removing the publish is not a fix** — the measurement above had none.
* The fix: **no non-loopback TCP listener without authentication**, anywhere in the
  pair's network namespace.

⚠ *Also measured:* behind a docker publish, xpra logs the peer of a host-originated
connection as the **docker bridge gateway**, not the client. ⇒ An IP-based check
inside the container means nothing for local connections. That is `gx7e` §4's trap,
reached from the other direction.

## 2. Threat model — network channels

| actor | today (measured) | B4 only | xpra unix socket + peercred | xpra TCP + `auth=file` | CDP unix socket |
|---|---|---|---|---|---|
| **other local user, no docker** | full control of both channels, via `127.0.0.1` AND the bridge address | no change | ✅ stopped (dir 0700 **and** peercred — two layers, measured) | no session without the password, published port and bridge address both (measured) | ✅ stopped |
| **local process of another uid** (daemon, CI runner, sandboxed tool) | same | no change | ✅ | as above | ✅ |
| **another container on the default bridge** | full control via the bridge address (measured) | no change | ✅ (no listener left) | needs the password | ✅ |
| **process of the SAME uid** (another lane or tool) | full | full | full | full (can read the secret) | full |
| **docker-group co-user** (root-equivalent) | full | full | full, via `docker exec` / mount / `inspect` | full (mounts the secret) | full |
| **another machine on the LAN** | blocked unless the publish host is widened | ✅ refused | — | — | — |
| **a tailnet viewer** | `gx7e`: xq's exposure with its allowlist | — | — | the password is a factor that does **not** depend on peer IP (§5.3) | — |

A host firewall that matches on socket owner (`meta skuid`) is the host admin's option,
outside base and unmeasured here. It cannot see forwarded container traffic (`6gi0` §3).

⇒ **The uid is the boundary.**

* **Below it** (two lanes of one account) is **not a security boundary**, and this
  design does not pretend otherwise. Same-uid separation is `ow9k`'s job, and it is
  about *intent*, not *access*.
* **Above it** (the docker group) is **root-equivalent by docker's design**, so this
  design is **defence in depth only** there. It raises the bar from *connect to a port*
  to *`docker exec` or mount*, which `docker events` shows and a port connection does
  not.
* **For every other local user and process this is the whole defence**, and today
  there is none.

## 3. Threat model — file surfaces (X11, pulse, xpra socket, profile) — measured for base's driver

xq measured its own template: each zone's X11 and pulse sockets were **mode 0777 in a
host path every local user can traverse**. With `Xvfb -ac` and anonymous pulse, that
means anyone can screenshot and type with no network at all. Base's driver was measured
separately, because its topology differs:

| surface | where it lives in base's driver | mode (measured) | auth (measured) | reachable by a non-docker local user? |
|---|---|---|---|---|
| **X11 socket** `X99` | a docker **named volume** (`/tmp/.X11-unix`), shared by the pair — **no host bind** | socket 0777, dir 1777 | Xvfb runs **without `-ac` but also without `-auth`**. A client of **another uid** that reached the socket was admitted (`xdpyinfo` answered). ⇒ effectively no X access control | **No.** The volume sits under docker's data root, which is **0710 root:root**; `stat` of the volume path as the host user → `Permission denied` |
| **X11 abstract socket** | the pair's network namespace | — | as above | **No.** Abstract sockets are per network namespace |
| **pulse** `/run/pulse/native` | **inside the xpra container only** — no host bind, and chromium has no pulse mount | 0777 | `auth-anonymous=1` | **No** host path. Reaching it via `/proc/<pid>/root` needs ptrace rights over the container's processes, i.e. the **same uid** |
| **xpra's own unix socket** (today `/run/xpra/socket`) | inside the container — no host bind | — | default | **No** |
| **profile dir** (bind into chromium) | `<cacheRoot>/profiles/<slug>/chromium` or a configured `userDataDir` | **0755** on every running pair inspected — `mkdirSync` with no mode under umask 022 | n/a | **Only by accident.** On the measured host an ancestor (`~/.cache`) happened to be 0700. A `userDataDir` under a 0755 home has no such ancestor |
| **upload staging** (ro into chromium) | per-slug host dir | 0700 (pre-created by the driver) | n/a | No |

⇒ **For base, X11 and pulse are docker-group exposure, not local-user exposure.** The
named volume is what xq's 0700-parent mitigation gives its zones. It holds only while the
volume stays a named volume: ⛔ **a change that bind-mounts the X11 directory from a
host path inherits xq's finding exactly** (arm A15).

⇒ **The profile is base's real file-surface gap.**

* **Rule:** every directory base creates is created **0700** — the profile leaf, the
  tool's cache root, the channel dir and the secret dir.
* Base **reports** traversability for paths it did not create (`userDataDir`). It never
  chmods a lane's own path on its own initiative.
* *Measured:* tightening the profile dir and the channel dir from 0755 to 0700 **under a
  running pair** left everything working — the container still wrote to its profile, CDP
  still opened a tab over the socket, and xpra still answered. This matches xq's
  measurement on its zones. ⇒ **This mitigation needs no restart.**

## 4. Recommendation, in one table

| channel | recommended | xq (runtime layer) | refused alternatives |
|---|---|---|---|
| **xpra, native attach + presence** | **unix socket** in the 0700 channel dir, `auth=peercred` | TCP + `--password-file` | — (D1, §10) |
| **xpra TCP** (html5) | **auth ON always** — `auth=file`, per-target 0600 secret in a 0700 dir. html5 off ⇒ bound to the **netns loopback**, unpublished; html5 on ⇒ `0.0.0.0` + `127.0.0.1` publish | auth ON always, `--tcp-auth`/`--ws-auth file:filename=…` | `auth=password,value=…` (secret in argv); a relay onto the unix socket (peercred then sees the relay) |
| **CDP** | **unix socket** relay in the 0700 channel dir; **no TCP listener outside the netns** | the same | host firewall; an authenticating TCP relay; `--remote-debugging-pipe` (§6.4) |
| **publish host (B4)** | **refuse** non-loopback at the driver **and** at `docker-ctl` | — | — |
| **dirs base creates** | **0700** at creation; refuse a loosened channel/secret dir | parent data dir 0700 | — |

## 5. The xpra channel

### 5.1 Mechanisms the image's xpra supports — measured

The image's xpra is **6.4.4**. Its `auth/` package ships `allow, capability, env, exec,
fail, file, gss, hosts, http_header, kerberos_*, keycloak, ldap, ldap3, multifile,
mysql, none, otp, otpscreen, pam, password, peercred, reject, sql, sqlite, u2f`.

| test | result |
|---|---|
| unix socket in a bind-mounted host dir (0700): the owner runs `xpra info socket://…` | ✅ session |
| the same, **another uid** (dir 0700) | `Permission denied` at the directory |
| the same, another uid, with the dir **and** the socket opened to the world | `peercred access denied` — **layer two holds alone** |
| `--bind-tcp=…,auth=file,filename=…`: right password (6.4.4 and 6.5 clients) | ✅ session |
| the same, wrong password / no password | `authentication failed` / **no session** (the client blocks on a prompt, or fails to open one) |
| the same over `ws://` (the html5 transport) | gated identically — the bind's auth covers both protocols on that socket |
| the same **via the bridge address**, as another uid: none / wrong / right password | no session / `authentication failed` / ✅ (right password, as the owner) |
| xq's spelling, `--tcp-auth=file:filename=… --ws-auth=file:filename=…` | ✅ right password admitted, wrong refused, tcp and ws |
| `GET /` on an `auth=file` socket | **200**, and the websocket upgrade returns **101**. The html5 page is served unauthenticated; only the xpra session is gated |
| **baseline**: today's shape, no `auth=`, another uid over host loopback | ✅ **session** — the exposure, reproduced |

⛔ **A SYNTAX TRAP THAT FAILS CLOSED BY ACCIDENT.** The colon form **inside the bind
option string**, `--bind-tcp=…,auth=file:filename=/path`, is accepted at startup and
then **refuses every password, the right one included**.

* The two valid spellings are `--bind-tcp=…,auth=file,filename=…` (comma) and
  `--tcp-auth=file:filename=…` (a separate flag, colon).
* Mixing them is the trap. Because it fails closed it is not a hole, but an arm that
  only checks *"a wrong password is refused"* passes against it.
* ⇒ **Arm A2 checks the right password too.**

### 5.2 Recommended shape — on the stock image, env only

```
xpra container (stock entrypoint)
  XPRA_BIND      = /run/webctl/xpra.sock,auth=peercred
  XPRA_TCP_BIND  = 127.0.0.1:<xpraTcpPort>,auth=file,filename=/run/webctl-secret/xpra.pass   # html5 OFF
                 | 0.0.0.0:<xpraTcpPort>,auth=file,filename=/run/webctl-secret/xpra.pass     # html5 ON
  mounts         = <channelDir> → /run/webctl          (rw)
                   <secretDir>  → /run/webctl-secret   (ro — a DIRECTORY; xpra container ONLY)
  publish        = none | 127.0.0.1:<xpraTcpPort>   (html5 ON only)
```

✅ ***Measured:* the stock entrypoint needs no change and no rebuild.**

* It passes `XPRA_BIND` straight to `--bind=`. Its `mkdir -p "$(dirname "$XPRA_BIND")"`
  copes with the `,auth=` suffix.
* It passes `XPRA_TCP_BIND` to `--bind-tcp=`.
* ⇒ Applying the fix is **a restart, not a rebuild** — as xq found for its images.

*Measured:* the full owner-only shape was run on stock images, and its listener
inventory read from the pair's own `/proc/net/tcp{,6}`. The only TCP listeners were
**`127.0.0.1:9222`** (Chromium's own debug port, on the netns loopback) and the xpra
port. With html5 off, the xpra port is `127.0.0.1` too, and *measured:* it is refused
from the host at the bridge address.

⚠ **Why the netns loopback, and not "unset", when html5 is off.** The entrypoint
declares `: "${XPRA_TCP_BIND:=0.0.0.0:14500}"`, and `:=` substitutes on **unset OR
empty**. ⇒ Base cannot turn TCP off by omitting the variable: omitting it re-arms a
masked default on `0.0.0.0`, which is the bridge exposure again.

### 5.3 How attach keeps working

* **`xpra-attach.js`:** `attachArgs()` gains `socketPath`. Owner-only mode emits
  `xpra attach socket://<channelDir>/xpra.sock`, never `tcp://`. *Measured* with the
  host's 6.5 client against the 6.4.4 server. TCP attach (remote, or a fallback) passes
  `--password-file=<secretDir>/xpra.pass`, as xq does.
* **`xpra-presence.js`:** `xpra info socket://<path>`. The `clients=` parse is unchanged.
* **html5 (`gui attach --html5`):** the URL stays `http://127.0.0.1:<xpraTcpPort>/`.
  The human types the password into the client's own connect form (`connect.html` has
  the field; `index.html` also reads `password` from the query string or
  sessionStorage).
  * ⛔ **Base never puts the password in a URL it opens.** `xdg-open <url>` places the
    URL in a browser process's argv, which **every local user can read** from
    `/proc/<pid>/cmdline`.
  * ⇒ Base prints the URL and the **path** of the mode-600 secret, never the secret.
* **`gx7e` tailnet exposure:** the remote viewer needs the password too. ⭐ It is a
  second factor **that does not depend on peer IP**, the property `gx7e` §4 found
  missing behind a relay.
* **The gui verbs (`gu1d`):** `gui status` gains `exposure` (§9). `html5Answering`
  keeps its meaning, *the page answers* (a 2xx) — still true under `auth=file`. It
  never meant *a session is open*.

## 6. The CDP channel

### 6.1 Recommended: a unix-socket relay; nothing on TCP outside the netns — measured, stock images

```
chromium container (stock entrypoint, shares the xpra netns)
  LWC_CDP_PORT     NOT set                         # ⇒ the entrypoint starts NO TCP relay
  cmd              --remote-debugging-port=9222 --remote-allow-origins=*
                                                   # appended by the entrypoint (argv[1:])
cdp-relay sidecar (chromium image, --entrypoint socat, --network container:<xpra>)
  socat UNIX-LISTEN:/run/webctl/cdp.sock,fork,mode=0600,unlink-early  TCP:127.0.0.1:9222
  mount <channelDir> → /run/webctl
```

*Measured — the whole stack on unmodified images:*

* **owner:** `curl --unix-socket <channelDir>/cdp.sock /json/version` → Chromium 148,
  and `PUT /json/new` opened a tab;
* **another uid** at the **bridge address**, port 9222 → **connection refused**;
* **another uid** through the 0700 dir → refused;
* **zero-dep Node 22:** `http.get({socketPath})` → `/json/version`; then
  `http.request({socketPath})` + an RFC 6455 upgrade → **101**, and
  `Browser.getVersion` round-tripped over the socket.

Why a **sidecar**, not an entrypoint change: today `LWC_CDP_PORT` both enables
`--remote-debugging-port` **and** starts `socat TCP-LISTEN:…,bind=0.0.0.0`, which is the
bridge exposure. Passing the flag as container args, with no `LWC_CDP_PORT`, gets
Chromium's debug port **without** the TCP relay. `docker-ctl.runDetached` already
supports `cmd`.

* ⇒ **A restart, not a rebuild.**
* A later `LWC_CDP_UNIX` entrypoint contract can absorb the sidecar (Q3).
* The sidecar is the pair's third container: owner-labelled and named like its
  siblings (`ow9k`), started after chromium and stopped with the pair.

⚠ **"Nothing on TCP" — stated exactly.** Chromium's own `127.0.0.1:9222` stays, on the
pair's **network-namespace loopback**. That loopback is shared only by the pair's own
processes; it is unreachable from the host, from the bridge, and from other containers
(*measured*, bridge address refused). ⇒ The claim base makes is **"no TCP listener
reachable from outside the pair"**. `--remote-debugging-pipe` would remove even this one,
but only the process that spawns Chromium can use the pipe (`6gi0` §3).

### 6.2 The endpoint, the client transport and the forward → `infra-unix-control-endpoint-6gi0`

The CDP socket is consumed and produced in **xq's shipped endpoint shape**: schema 1,
`transport:"unix"`, `path`, `host_header`. Base's client gains a zero-dep unix transport
(`http` + its own RFC 6455 framing). Remote targets use an **owned unix → unix forward**,
whose contract is written there for xq's half to match.

Two consequences matter here:

* **Base's driver reports the same shape** in `inspect().ports.cdp.endpoint`, with
  `path = <channelDir>/cdp.sock` and `host_header = "127.0.0.1:9222"`. `exposure()`
  derives the path from the relay's real mount.
* **Consumers check a sealed ancestor**, not the socket's mode, because xq's socket is
  0666 (D7).

⛔ In owner-only mode `cdpHttpUrl` and `cdpWsBase` are `null`, never fabricated (`t2wf`).
xpra is not a control endpoint: it is reported beside the endpoint, as
`inspect().xpra = {socket, auth:'peercred', tcp:{host, port, auth:'file', published}}`.

## 7. B4 — refuse a non-loopback publish host

| | addresses |
|---|---|
| **Accepted** | `127.0.0.0/8`, `::1` |
| **Refused** | `0.0.0.0`, `::`, empty, `localhost`, and every other address (e.g. `192.0.2.10`) |

`localhost` is refused because docker needs an address, and a name is a location assumed
(`nl0c`).

**Refused in both places**, as `gx7e` §2 rules for exposure:

1. **The driver, in `ensureRunning()`**, before any docker call — not in
   `createDriver()`, so that a read-only caller (`gui status`) can still construct a
   driver and **report** the bad host in `exposure.reasons`.
2. **`docker-ctl.runDetached()`** refuses any `publish` tuple whose host is not
   loopback. That covers callers that never built a driver.

`buildDriverCfg()` may refuse earlier and name the source. It is not the guard, because a
hand-built cfg skips it (`portSourcesUnavailable` is the measured precedent).

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

## 8. Secrets, directories, ownership and naming

### 8.1 Where things live

```
<stateRoot> = <XDG_STATE_HOME or ~/.local/state>/CLIAI/<CACHE_DIRNAME>       (v59v)
<key>       = first 12 hex of sha256(realpath(profilePath))                 (ow9k §3: key on the TARGET)

<stateRoot>/run/<key>/            0700   channel dir: xpra.sock, cdp.sock (0600)
<stateRoot>/auth/<key>/           0700   secret dir — always minted (auth is always on)
<stateRoot>/auth/<key>/xpra.pass  0600   ≥32 random bytes, base64url
```

* **Why the state root, not `$XDG_RUNTIME_DIR`.** logind removes the runtime dir at the
  account's last logout. A pair still running would then hold a bind mount of a
  **deleted** directory, and its sockets would be unreachable until a restart.
  *(Known logind behaviour, not measured here — Q8.)*
* **Why not inside the profile.** The profile is bind-mounted into the **chromium**
  container, where web content runs, and profiles get copied and exported. The secret is
  mounted into the **xpra container only** (arm A3).
* **Never in git, and never in an exportable location.** Both roots are outside every
  repository; `f868`'s `.gitignore` is the second line of defence, not the first.
* **sun_path is 108 bytes.** The socket path is checked before start and refused with its
  length (arm A7).

**Creation rules (each one is an arm):**

* Every directory base creates gets **0700 at creation**, never a later chmod. Docker
  would otherwise create a missing bind source **root-owned**.
* An existing channel or secret dir with group/other bits, or another owner, is
  **REFUSED, not chmodded**. Silently tightening would hide whoever loosened it.
* Profile dirs are the exception (§3): base-created ones are made 0700, and a lane's
  `userDataDir` is reported, never changed.
* The secret is created `O_CREAT|O_EXCL`, 0600 at creation. A symlink or an existing file
  at the path is refused, never followed.

### 8.2 Rotation — measured, and the trap it avoids

* **Rotate** = write a temp file in the same dir (0600, `O_EXCL`), `fsync`, then
  `rename()`. *Measured:* with the **directory** mounted, the new password was admitted
  and the old one refused, **with no restart** — xpra re-reads the file on every
  connection.
* ⛔ ***Measured trap:* when the secret is mounted as a SINGLE FILE, the same rotation
  "succeeds" on the host while the container keeps the OLD inode.** The new password is
  refused and the old one still opens a session. A rotation that reports success and
  changes nothing is a `k3wn` check that cannot fail.
  ⇒ **Mount the directory, never the file** (arm A3, with I5's control).
* Rotation runs on every `gui html5 on`, and on demand with `gui html5 rotate`. Sessions
  already open are not cut. *(Expected from auth-at-connect; not measured.)*

### 8.3 Ownership and naming (`ow9k`)

* **The owner-only socket is identity by construction on the uid axis** (`ow9k` §4(ii)):
  only the owner can reach it. ⚠ It says nothing about **which lane** of that uid; the
  claim and the lock stay with `ow9k`.
* **`stat(socket).uid === process uid` is checked before the channel is declared up.**
  *Measured:* an image whose baked uid differed from the dir owner's could **not create**
  its socket (`bind(…): Permission denied`). That fails closed, and the driver must name
  the cause (A11).
* **The key is the target, not the tool.** A second same-uid tool attaching the same
  profile reads the paths from a label on the xpra container (`<LABEL_NS>.channel-dir`,
  via `docker inspect`). The directory path is not secret.
* **`buildImage` labels the image with its build uid** (`<LABEL_NS>.image-uid`; it
  already passes `UID` as a build-arg). The driver refuses a mismatch before
  `docker run`. If the label is absent, the post-start socket-owner check decides.

## 9. Migration — what a lane must do

⛔ **Taking the fix means restarting the lane's browser pair. That is the lane's and its
owner's call, never base's.** Base never stops, restarts or recreates a running pair to
apply it.

**Phase 0 — see the exposure; change nothing (next release).**

* `driver.exposure()`: new, async, read-only.
  * It reads the running pair with `docker inspect` only: `PortBindings`, the xpra env
    (`XPRA_TCP_BIND`, `XPRA_BIND`), the chromium env (`LWC_CDP_PORT`), whether a relay
    sidecar exists, the mounts, and `stat` modes of the host bind sources and their
    parents.
  * It returns `{level: 'owner-only'|'local-users'|'unknown', reasons[]}`.
  * ⛔ An in-container `0.0.0.0` listener without auth is `local-users` **even with no
    publish**. Unknown is never reported as safe.
* **The doctor / `gui status` line:**

  ```
  exposure  LOCAL-USERS  cdp: tcp 0.0.0.0 in netns (+ published 127.0.0.1:<p>); xpra: tcp, no auth;
                         profile dir 0755 (ancestor 0700: yes)
            → any local user can drive this browser. Fix: restart, your call — gvlx §9
  exposure  owner-only   cdp: unix 0600 in 0700; xpra: unix peercred + tcp auth=file; html5: off
  ```

**Phase 1 — opt in (the same release).**

* `cfg.channels = 'owner-only'`. **Stock images work** (§5.2, §6.1): bump base, then
  restart.
* No-restart mitigations base applies at once: 0700 on dirs it creates, and a doctor
  hint for a `userDataDir`.
* The default stays `'tcp-legacy'`, which warns `local-users` on every bring-up.

**Phase 2 — flip the default (the release after).**

* `'tcp-legacy'` stays available as an explicit opt-in, and is reported as exposed.
* ⭐ **The backward-compatible window:** `ensureRunning()` that finds a **running legacy
  pair** reuses it with a loud WARN and does **not** restart it. Bumping base never takes
  a lane's browser down.
* It **refuses** only if the cfg **explicitly** says `'owner-only'` and the running pair
  is not, because a lane that asked for the property must not be told it has it.

**A lane's checklist:**

1. Bump base, and read `exposure`.
2. Move CDP callers to base's client with an endpoint, or to `inspect().ports.cdp.endpoint`.
   Third-party clients: Q1.
3. **The owner restarts the pair** at a time they choose.
4. Confirm `exposure owner-only`.

A rebuild is needed only for the image-uid label, and that is optional.

## 10. Divergences from xq, named

| # | base | xq | why |
|---|---|---|---|
| **D1** | native attach and presence over the **unix socket + peercred** | TCP + `--password-file` | no secret on the local hot path; file permissions are the auth, as both chose for CDP. TCP + `--password-file` stays available, and is used for remote attach |
| **D2** | auth via the **bind option string**, `XPRA_TCP_BIND=…,auth=file,filename=…` | `--tcp-auth=/--ws-auth=file:filename=…` flags | base passes it through the **stock entrypoint's env** with no rebuild. Both spellings are measured to work; mixing them is the trap in §5.1 |
| **D3** | secret mounted as a **directory** | "a per-zone 0600 secret file … mounted read-only" | if that is a single-file mount, **rotation silently does nothing** (measured, §8.2). Raised to xq to check |
| **D4** | with html5 off, the xpra TCP bind is on the **netns loopback** | auth-on TCP | the listener leaves the bridge entirely, so there is nothing to brute-force |
| **D5** | CDP relay as a **sidecar** + Chromium args | built into xq's entrypoint (`XQ_CONTROL_CDP_SOCKET`, a path confined to `/run/xq-control/`, fail-closed exit 78) | base cannot rebuild consumer images; the sidecar gets the same socket on stock images. xq's entrypoint is the reference for a later consumer-side contract (Q3) |
| ~~D6~~ | "nothing on TCP" means **nothing reachable outside the pair**; Chromium's netns-loopback 9222 remains | the same | ✅ **not a divergence.** xq's unix relay also targets `TCP:127.0.0.1:9222` (read from its entrypoint at `0a4fab6`); its "no TCP listener at all" means no relay listener. Same property, same words now |
| **D7** | socket **0600**, plus a check that `stat(socket).uid` is the owner | socket **0666**; the sealed zone dir is the only boundary | base's container uid is the owner (baked uid, or a future `--user`), so 0600 costs nothing and keeps a second layer if a dir is ever loosened. **Consumers do not rely on either**: they run the sealed-ancestor check (`6gi0` §2), which passes on both |
| **D8** | in-container dir `/run/webctl` (`cdp.sock`, `xpra.sock`) | `/run/xq-control` (`<control>.sock`) | a base pair is not an xq zone, and nothing reads the in-container path across the boundary. Only the host `path` in the endpoint crosses it, and that is identical in shape |

## 11. Arms — every one can fail, none touches a real browser

**Unit arms.** These use a fake docker capturing `runDetached` args, as
`chromium-docker-xpra.test.js` already does, and a temp `HOME` with `XDG_*` stripped
(`v59v`). Each one **proves it wrote nothing outside its temp root**.

| # | property | fails when | control (must pass) |
|---|---|---|---|
| A1 | owner-only publishes nothing | any `publish` tuple captured | html5 on ⇒ exactly one, `127.0.0.1:<xpraTcpPort>` |
| A2 | xpra binds | `XPRA_TCP_BIND` lacks `,auth=file,filename=`; html5 off is not `127.0.0.1:`; the colon-in-bind form appears; `XPRA_BIND` lacks `,auth=peercred` | legacy keeps `0.0.0.0` **and** reports `local-users` |
| A3 | mounts | channel dir missing on xpra or the relay; the secret dir on **chromium**; the secret mounted as a **file** | secret **dir** ro, on xpra only |
| A4 | CDP shape | `LWC_CDP_PORT` set, no relay sidecar, or chromium `cmd` lacking `--remote-debugging-port` in owner-only | legacy: `LWC_CDP_PORT` set, no sidecar |
| A5 | B4 | `0.0.0.0`, `::`, `''`, `localhost` or `192.0.2.10` reach any docker call, whether at the driver **or** at `docker-ctl` | `127.0.0.1`, `127.0.0.2`, `::1` accepted |
| A6 | channel/secret dir mode | a pre-existing 0755 or foreign-owner dir is accepted, or silently chmodded | absent ⇒ created 0700; own 0700 ⇒ accepted |
| A7 | sun_path | a 108-byte socket path reaches `docker run` | 107 bytes accepted |
| A8 | secret creation | mode ≠ 0600 at creation; a planted symlink is followed; fewer than 32 bytes | fresh path ⇒ 0600 in a 0700 dir |
| A9 | the secret is never disclosed | its bytes appear in any captured spawn argv, opened URL or log line | **self-test:** planting it in a fake log line makes the arm fail |
| A10 | `exposure()` | a fake legacy pair with **no publish** but `XPRA_TCP_BIND=0.0.0.0:…` without auth reads `owner-only` | a fake owner-only pair reads `owner-only` |
| A11 | uid gates | `image-uid ≠ getuid` reaches `docker run`; a socket owned by another uid is declared up | matching uid proceeds |
| A13 | attach / presence | `tcp://` is emitted in owner-only | `socket://<channelDir>/xpra.sock`; TCP attach carries `--password-file` |
| A14 | dirs base creates | profile leaf, cache tool root, channel or secret dir created with any group/other bit (asserted with `stat`, under umask 022 **and** 0000) | 0700 under both umasks |
| A15 | X11 stays off host paths | any mount of `/tmp/.X11-unix` (or of a pulse path) whose source is a **host path** rather than the named volume | the named volume |

**Integration arms.** These are opt-in and use throwaway containers from the consumer's
own images; they are this document's measurements made executable.

* Containers are named `<prefix>-design-u<uid>-<pid>-*` and removed by exact name.
* They publish nothing, or only ports verified free on `127.0.0.1`.
* The bridge address is read **from the throwaway's own `docker inspect`**, never
  guessed.

| # | arm | control |
|---|---|---|
| I1 | another uid via the mounted channel dir ⇒ `Permission denied` | the owner ⇒ session |
| I2 | dir **and** socket opened ⇒ still `peercred access denied` | — (proves layer two alone) |
| I3 | xpra TCP: no password ⇒ no session; wrong ⇒ refused — **on the published port AND the bridge address**, tcp and ws | right ⇒ session |
| I4 | **another uid → `<bridge-ip>`: CDP 9222 refused; xpra port refused (html5 off)** | the legacy shape **answers** at the bridge address, so the arm can tell the two apart |
| I5 | rotation by rename with a dir mount ⇒ new password admitted, old refused, no restart | a single-file mount ⇒ the **old** password is still admitted (the trap, detected) |
| I6 | CDP: the owner's `Browser.getVersion` over the socket | another uid ⇒ refused |
| I7 | an image with a mismatched baked uid ⇒ socket creation fails, and the driver names it | a matching uid ⇒ the socket is owned by the owner |
| I8 | the listener inventory from the throwaway's `/proc/net/tcp{,6}` contains **no `0.0.0.0`/`::` listener without auth** | the legacy shape lists `0.0.0.0:<cdp>`, so the arm can fail |
| I9 | `stat` of the X11 volume path as the host user ⇒ denied (0710 data root). An X client of another uid **with** the volume ⇒ admitted — documents the docker-group reach, so nobody mistakes X for an auth layer | — |
| I10 | tighten the channel and profile dirs 0755 → 0700 under a running throwaway pair ⇒ profile writes, CDP and xpra all keep working | — |

**Measured 2026-10-13:**

* **Versions:** xpra server 6.4.4-r0 (xpra-html5 19); host xpra client 6.5 beta; Chromium
  148.0.7778.178 (Debian 13); socat 1.8.0.3; Docker Engine 29.7.2; Node 22.23.
* All probes ran in throwaway containers.

## 12. Open — needs a ruling

* **Q1 — third-party CDP clients that only speak `ws://` over TCP.** Either a
  per-invocation `tcp-forward` (exposed for its lifetime, as `6gi0` §3–§4), or keep
  `'tcp-legacy'` as the permanent escape hatch.
* **Q2 — html5 default.** Off is recommended. On means the password flow of §5.3.
* **Q3 — an `LWC_CONTROL_CDP_SOCKET` entrypoint contract,** ported from xq's
  `XQ_CONTROL_CDP_SOCKET` (path confined to the dir, fail-closed exit 78). Should one, plus a
  `CHROMIUM_CONTAINER_ENV_CONTRACT`, eventually replace the sidecar? Dockerfiles stay
  consumer-owned either way.
* **Q4 — the phase-2 flip.** Confirm the timing, and confirm "refuse only when
  owner-only was explicitly requested".
* **Q5 — same-uid lanes** as one trust domain. Recommended; per-lane uids are out of
  base's scope.
* **Q6 — docker-group co-users.** They are root-equivalent. Rootless or per-user
  daemons are the host admin's call.
* **Q7 — the host firewall by socket owner.** The admin's option; unmeasured.
* **Q8 — state root vs runtime dir for sockets.** The logout reasoning is not measured
  here.
* ~~**Q9 — the endpoint field name.**~~ ✅ **Resolved by xq's shipped shape:** `kind`
  stays the image-declared inside, and `transport` is how this host reaches it (`6gi0` §2).
* **Q10 — D3.** Does xq mount its secret as a file? If so, its rotation is the measured
  trap.
