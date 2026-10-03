# Changelog — base-webctl

Consumers pin base by **tag**. This file is what you read when deciding whether
to move a pin, and it states the LIMITS of each release as prominently as its
contents — a release note that lists only what was fixed lets a reader conclude
they are safe on the strength of a headline.

> ⚠ **A checkout of an older tag does not contain this file's later entries.**
> Read it on `master` (or on GitHub), not from inside your pinned submodule.

## ⛔ Before tagging: write down what the headline does NOT cover

An accurate headline is not a sufficient one, and this has now happened **three
times running** — each caught by a reader rather than by the author:

* **v0.6.0** — "the html5 port collapse". True, and it fixed **1 of 101**
  affected CDP ports; the other 100 needed v0.7.0.
* **v0.9.0** — "the CDP command client". True, and it was the **enumeration
  half only** — unable to replace the hand-rolled clients it was cut to retire.
* the `LWC_CHROMIUM_PROFILE` hazard table — accurate per consumer and **carrying
  no revision**, so it could not be checked and could not be wrong detectably.
  It shipped ranking the most-exposed lane as safe.

The pattern is not carelessness: a true headline reads as complete, so nobody —
including its author — looks for the part it omits.

⇒ **So the release step is: state the limit in the entry, before cutting.** What
is in, what is deliberately NOT in, and what a consumer therefore still cannot do
on this version. If a table describes other repos, **stamp each row with the
commit it was observed at** — in a fleet where lanes are actively fixing, an
unstamped observation is presented as a standing fact and rots within hours.

## v0.7.0 — 2026-09-02

⭐ **THIS IS THE RELEASE WHERE THE TCP PORT OVERFLOW IS FIXED.** The v0.6.0 entry
below says the html5 collapse addressed **one** of the 101 affected CDP ports; the
other **100** (`65436..65535`) are fixed *here*. Until this tag there was no
tagged release containing that fix, so a consumer at or above `65436` had the
caveat and no remedy.

### Fixed

* **An out-of-range derived xpra-tcp port is refused, not returned.** The defect
  was never the arithmetic — it was that the resolver returned impossible ports
  with `sources:{tcp:'derived'}`, indistinguishable from a valid answer, so the
  failure surfaced later as an unrelated bind error. Now throws, naming the
  affected window and both remedies. An explicit `xpraTcpPort` still bypasses
  derivation, so a high CDP port stays usable.

### Added

* **`lib/url-marking.js`** — counterparty-URL detectors and the two record
  projections, contributed by the chatgpt lane. Field selection is an explicit
  **required** argument; the scan-everything mode is named
  `scanAllStringsUnsafe` so choosing it is a decision rather than an omission.
  Two consumers were carrying local copies and can now shim it.
* `scripts/assert-pin-compat.mjs` — refuses a base pin that cannot serve the
  consumer's configured port. Probes capability, not version.

### Deprecated

* `PORT_OFFSET_HTML5` — ⚠ **removal RETARGETED from v0.7.0 to v0.8.0.** The note
  in v0.6.0 said it would go here. It has not, deliberately: v0.7.0 landed one
  day later and **no consumer had adopted v0.6.0**, so removing now would honour
  the letter of the deprecation while giving an effective window of zero
  adopted releases. Verified before deciding that no consumer reads the value
  (three comments, one QA name-list), so the removal stays cheap whenever it
  happens. It is still **DO NOT USE**.

### Gate (affects consumers only via base's release process)

* A dirty submodule pointer is a **FAIL** — a consumer whose checkout disagrees
  with its index produces a result about a base it does not declare.
* A dirty working tree is a **SKIP** with a named reason, in every mode.
* `--against-head` announces swaps with a PID marker, so an in-flight swap reads
  as busy and an abandoned one reads as the incident it is.

## v0.8.0 — 2026-09-02

**No migration required.** v0.6.0's `--html=on` entrypoint migration still
applies if you are coming from v0.5.0.

### Added

* **`cfg.containerEnv` — caller-controlled container env** on the docker-xpra
  driver, as `{KEY: string|null}`. Absent means byte-unchanged. A string sets or
  overrides; **`null` REMOVES** a key the driver would otherwise set.
  * Deletion is in the contract for a reason: the container entrypoint adds
    `--remote-debugging-port` only when `LWC_CDP_PORT` is **set**, so "no CDP" is
    expressed by *absence*. An additive-only seam could never say it.
  * `DISPLAY` and `LWC_CHROMIUM_PROFILE` are **refused** at construction. They
    are correspondences with the netns/Xvfb wiring and the profile bind-mount
    computed in the same function — overriding either does not error, it gives a
    black screen or a browser writing where nothing is mounted.
  * Scope is the **chromium** container only.
* ⭐ **Portless mode** — a browser with no CDP, via
  `containerEnv: { LWC_CDP_PORT: null }`. The image always supported it; the
  driver set the variable unconditionally, so the branch had never been taken.
  * Five places treated CDP-unreachable as a fault, which made "no CDP was
    requested" and "CDP is down" the same observation. Bring-up, reuse and
    `healthCheck()` now use chromium liveness when no port was requested.
  * The CDP port is **not published and not pre-flight reserved**, and
    `cdpHttpUrl` is `null` rather than an address for a port nobody opened.
  * `inspect().cdpEnabled` states the mode explicitly.
  * A portless stack whose chromium **exits still fails**, with a message saying
    the failure is real rather than an unreachable port.

### Fixed

* `PORT_OFFSET_HTML5` is still deprecated and still **DO NOT USE**; removal
  remains targeted at a future release (see v0.7.0 for why it moved).

## v0.9.0 — 2026-09-02

> ⚠ **The copy of this file inside the `v0.9.0` TAG carries a WRONG version of
> the hazard table below** — it swapped two consumers and marked the most-exposed
> one as safe. Corrected here on `master`; the tag was not re-cut, because moving
> a published tag trades a documentation error for two people holding the same
> tag name with different content. **Read this table from `master`.**

**No migration required.** v0.6.0's `--html=on` entrypoint migration still
applies if you are coming from v0.5.0.

### Added

* ⭐ **`lib/cdp-client.js` — the CDP command client.**
  ⚠ **SCOPE CORRECTION: v0.9.0 shipped only the ENUMERATION half.** The entry
  below said "the CDP command client", which reads as the whole thing. It is
  accurate and partial: `openPage`, `closePage` and `navigate` are **NOT in
  v0.9.0** — 68 of the 237 lines it was extracted from, including the
  `/json/new` PUT-then-GET fallback, which appears four times in the original
  and zero times here. ⇒ **A consumer on v0.9.0 cannot use this to replace a
  hand-rolled client**; it must keep its own lifecycle code. Fixed in v0.10.0 —
  take that instead. If you are already on v0.9.0, keep your local lifecycle
  half and mark it NOT-YET-EXTRACTED rather than as a fork, so the next reader
  does not "reconcile" it against base by deleting behaviour base never had.
  * The session/transport half is substack-webctl's, carried over rather than
    rewritten — it runs in production. The target-discovery half is the
    claude-chrome-extension lane's rewrite of it.
  * `listPageTargets()` **preserves the existing per-site behaviour by name**,
    so adopting consumers change nothing at their call sites. ⚠ The
    implementation UNDER it was widened — if you rely on the page-only filter
    anywhere other than through that wrapper, check those places.
  * ⭐ `listTargetsViaBrowser()` is **authoritative**; `GET /json` is not. The
    HTTP list's membership has varied across Chromium versions and it does not
    reliably enumerate `service_worker` targets, so **asserting an absence on it
    yields a result indistinguishable from "not running"**. Use the browser
    endpoint whenever an absence would be read as a finding.
  * `listTargetsCorroborated()` reads both and **warns by default** when they
    disagree; silence requires explicitly passing `onDisagree: null`. An
    unreadable HTTP list is reported as *disagreement*, never as agreement.
  * **Deliberately NOT included:** an observer-only guard, per-axis target
    vocabulary, and a credential-method deny-list. The last is scoped to one
    repo's threat model and would break a wired consumer that legitimately reads
    cookies. A test asserts all three are absent from the public surface.

### ⚠ Consumer-side hazard worth acting on (base cannot fix this for you)

**`LWC_CHROMIUM_PROFILE` is BASE-OWNED. Do not default it downstream.**

base sets it on every run, so a downstream default is a **masked default** — a
code path that has never executed, which arms the moment base stops setting the
variable or changes its value. That is precisely how `XPRA_HTML5_BIND` behaved
before v0.6.0.

The failure mode is a **silently discarded login**: the browser writes its
profile to a path nothing is mounted at, so the session looks fresh and the real
one is still on disk, unreferenced. Nothing errors.

⚠ **Status below is a TIMESTAMPED OBSERVATION AT A NAMED COMMIT, not a standing
fact.** Three of the four consumers fixed this within hours of it being
reported — one of them *while this table was being written* — so an unstamped
version of it would already be wrong. Re-check at your own HEAD before acting.

Measured against each consumer's **HEAD**, 2026-09-02:

| consumer | at commit | bakes it as `ENV` | entrypoint read | status |
|---|---|---|---|---|
| claude-chrome-extension-webctl | `f38be2a` | **yes — 2 Dockerfiles** | `os.environ.get(…, default)` — **silent** | ⚠ **EXPOSED, both layers** |
| linkedin-webctl | `febba4b` | no | `require_env` ×2 (loud) | fixed |
| chatgpt-webctl | `686007a` | no | `require_env` (loud) | fixed |
| substack-webctl | `940fd6d` | no | `require_base_owned` ×2 (loud) | fixed |

Two independent layers can mask this — a baked `ENV` and a silent
`environ.get` fallback — and **neither is visible from the other**. Auditing only
Dockerfiles, or only entrypoints, gives a clean bill either way. Check both.

Three worked fixes now exist in the family; copy any of them. `require_base_owned`
is the strongest form: it names the ownership in the function that reads it.

## v0.10.0 — 2026-09-02

### Added

* ⭐ **The CDP client's PAGE-LIFECYCLE half** — `openPage`, `closePage`,
  `navigate`. **v0.9.0 shipped only the enumeration half** (see its entry), which
  meant the extraction could not actually replace a hand-rolled client. It can
  now; the surface is a superset of the client it was extracted from.
* Three behaviours in it are **environment knowledge, not style**, and a
  reimplementation gets all three wrong by default:
  * **reuse before minting** — an existing page target is reused; minting per
    operation leaks a tab per page (measured over a 220-page run);
  * **`/json/new` is a FALLBACK, tried PUT then GET** — ⭐ that endpoint is
    **restricted or disabled in some chromium builds**, so a client that mints
    first works on its author's machine and fails on someone else's;
  * ⛔ **only close the tab you minted** — a reused tab is the browser's own,
    frequently its only page, so closing it tears down the session the caller is
    standing on. `close()` encodes this.

## v0.32.0 — (unreleased)

**Headline: base drives only a tab base opened — `openPage()` / `navigate()` MINT a
background tab by default and never drive the human's tab unless told whose it is**
(`v7x3` §"base drives only a tab base opened"). Plus: an option a CDP factory does not
honour is REFUSED, naming it, never silently dropped.

### ⛔ BREAKING — `openPage()` no longer reuses the first page target

*Incident, 2026-10-03:* `openPage()` took `listPageTargets()[0]` → `reused: true`, and a
consumer's mutation arm navigated the human's ONLY tab in a signed-in browser. The tab a
person is reading is, by construction, the first page target. The old decision 1, "reuse
before minting", was right for an unattended browser and is superseded.

| caller passes | `openPage` does | `reused` | `close()` closes the tab |
|---|---|---|---|
| nothing (the default) | **mints a new target, in the background** | `false` | yes, unless `keep: true` |
| `{targetId, owner: 'minted'}` | drives it only if `ownedTargets.has(targetId)`; else refused | `true` | no, unless `close: true` |
| `{targetId, owner: 'adopted'}` | drives a tab base did NOT mint, for this call only | `true` | **never** |
| `{targetId}` with no `owner`, or any other value | **refused**, naming both choices | — | — |

* **Mint:** `Target.createTarget({url, background: true, newWindow: false})` over the
  browser endpoint — no `browserContextId` (a fresh context lacks the sign-in). Fallback:
  `/json/new` PUT, then GET. Both dial the caller's **rewritten** authority, never the raw
  one `/json/version` prints from behind an ssh forward.
* **If both mint paths fail, `openPage` REFUSES** with the opt-in hint
  (`{targetId, owner: 'adopted'}`). It never falls back to an existing tab.
* **`ownedTargets`** (any object with `has(id)`; a `Set` works) defaults to the ids THIS
  process minted. A lane with a durable ledger passes its own. Adopting never adds to it.
  ⛔ Only a literal `true` from `has()` vouches; a `has()` that returns a Promise (an async,
  db- or file-backed ledger) is REFUSED — a Promise is truthy and would vouch for any id.
  Resolve the ledger first (e.g. into a `Set`).
* A reused target must exist and be a `page` (checked on `Target.getTargets`); otherwise
  refused, naming the id.
* **`onMinted(id)`** is awaited after the mint and BEFORE the first attach. If it throws,
  the tab is closed (or blanked, if it is the last page) and `openPage` refuses, carrying
  the hook's error (`cause`).
* **`close()` is now on `openPage()`'s result too**, and returns `{closed: true}` or
  `{closed: false, reason}` with reason `'keep' | 'owned-reuse' | 'adopted' | 'last-page' |
  'close-failed'`. ⛔ **The LAST page target is never closed** — closing it exits Chromium;
  it is navigated to `about:blank` instead (`reason: 'last-page'`). "Last" is read from the
  browser endpoint at close time.
* `navigate(base, url, opts)` passes `targetId` / `owner` / `ownedTargets` / `keep` /
  `close` / `onMinted` (and now `defaultTimeout`) through, returns `openPage()`'s result,
  and closes a minted tab if the navigation itself fails.
* No "this tab is blank, so it is free" heuristic, anywhere.

**Migration.** A caller that uses `openPage()` only to get a session for BROWSER-level
calls (e.g. `Storage.getCookies`) must switch to `connectBrowser()`. Under mint-by-default,
every such call would otherwise open, and possibly leave, a blank tab.

Where reuse was meant, say whose tab it is: record the id from a `keep: true` mint (in
`onMinted`), pass your ledger as `ownedTargets`, and reuse with `{targetId, owner:
'minted'}`. Lanes adopt this deliberately: it changes what a signed-in browser shows.

### ⛔ BREAKING — unknown options are refused

`openPage`, `navigate`, `connectBrowser` and `listTargetsCorroborated` throw a
`TypeError` naming any option key they do not honour. Measured by `ccew`:
`connectBrowser({readOnly: true})` returned an ordinary session that still sent
`Storage.getCookies` — a guard that looked applied. A stale `openPage({reuse: true})` is
now told so. Contradictory combinations are refused too: `keep` + `close`, `close: true`
on an adopted tab, `onMinted` or `owner` without a mint/`targetId` respectively.

* ⛔ **BREAKING: the `CdpSession` CONSTRUCTOR refuses unknown option keys too** (honours
  only `defaultTimeout`, `WebSocketImpl`): `new CdpSession(url, {readOnly: true})` returned
  an unguarded session that looked guarded. A subclass must strip its own keys before
  `super()` *(raised by `webctl:mgr`)*.

### Tests

* `test/cdp-open-page-own-tab.test.js`: the nine `v7x3` QA arms, each with its control,
  against a recording fake CDP browser (`test/helpers/fake-cdp-browser.mjs`, ephemeral
  ports, a trap that records any dial of the raw authority).
* `test/cdp-client-lifecycle.test.js`: arm 1 ("an existing page is REUSED") and the
  reuse half of arm 3 asserted the old default; both now assert the new one.

### Fixed/Docs since v0.31.0

* the home-under-/run-or-/tmp refusal applies on the host path too, not only under an
  outer `unshare -r` (a CI image whose passwd home is under /tmp is refused)

### ⛔ What this does NOT cover

* The per-method **policy hook** (`v7x3` §"An option the library does not honour is
  REFUSED") is not implemented — only the refusal of unknown keys is.
* `closePage(base, id)` is unchanged: a low-level primitive with no ownership check and no
  last-page rule. Use the `close()` that `openPage()` / `navigate()` return.
* Unknown-key refusal covers the four factories above, not `getVersion`, `listTargets`,
  `listPageTargets` or `listTargetsViaBrowser`.
* Nothing here was run against a real browser; the arms use a fake that implements only
  the CDP surface listed in its header.

## v0.31.0 — 2026-10-03

**Headline: the docker driver never touches, reuses or restarts a container that is not
proven ours — and upgrading base never restarts a running signed-in browser.** Plus **the
harness no longer lets a consumer's tests reach the host** (mutation arms and the release
gate run with no host network and no host unix sockets), the engine vocabulary, base's
reader of xq's capabilities, and the design that makes **xq the runtime layer** (`rx9q`).

### ⛔ BREAKING — container names carry the owner

The driver named containers `<prefix>chromium-<slug>` / `<prefix>xpra-<slug>` with no owner,
and force-removed and stopped them by that name. On a shared docker daemon, two accounts
running the same tool with the same slug (the default is `default`) would remove or DRIVE
each other's signed-in browser. Inherited from the early xq the driver was adapted from
(xq's lane traced it, reading xq as it stood at the fork commit).

| old | new |
|---|---|
| `<prefix>chromium-<slug>` | `<prefix>u<uid>-chromium-<slug>` |
| `<prefix>xpra-<slug>` | `<prefix>u<uid>-xpra-<slug>` |
| `<prefix>x11-<slug>` (volume) | `<prefix>u<uid>-x11-<slug>` |
| `<prefix>net-<slug>` | `<prefix>u<uid>-net-<slug>` |

* **Proof of "ours" is what a container MOUNTS**: a chromium is ours only if a bind-mount
  Source is our resolved profile path; an xpra only if its same-slug chromium is ours. The
  new owner label is a FILTER (another uid → not ours), never proof alone.
* Every rm / stop / **reuse** goes through that proof; a container not proven ours is
  refused (exit 4) — never removed, never stopped, never driven.
* **What happens after a lane bumps:** on the first **`ensureRunning()`** (never on a read
  — `healthCheck`, `describe`, `inspect` never mutate), a running browser in a
  pre-owner-named container is **renamed in place** (`docker rename`) — it keeps running,
  same container, same CDP URL, NOT restarted — and its profile lock is rewritten to the new
  name. One info line says so. `shutdown()` stops a pre-owner pair under its old names
  (renaming it first when it can), never removes it. A partial pre-owner pair, or a migrated pair whose CDP does
  not answer, is REFUSED with instructions, never repaired by a restart.
* Bring-up and shutdown are serialised per PROFILE (process mutex), so two commands at once
  cannot both migrate one profile.
* New consumer-facing API: `mounts.names(slug, base, uid)` (uid defaults to the process),
  `names().owner`, `mounts.legacyNames(slug)`, `docker-ctl.rename`, the driver's `opts.uid`
  and **`opts.attachOnly`** (ensureRunning/shutdown refuse before any docker call — lanes pass
  it from resolveTarget's `attachOnly`), `inspect().names` reports the new names.

### Added

* **Engine vocabulary** (`nl0c` §1c): `firefox` is a valid `app`; `ENGINES`,
  `ENGINES_PENDING = ['firefox']` (base's WebDriver BiDi backend has not shipped — Firefox
  removed CDP in v141), `resolveEngine` with the fixed codes `no-engine`, `invalid-engine`,
  `engine-conflict`, `engine-pending`; `targetEnvKey(tool, 'engine')`;
  `resolveSharedTarget(...)` — the shared-config glue two lanes had each hand-written.
  No message prints the user's home path (`SHARED_CONFIG_DISPLAY`). ⚠ `resolveTarget`'s human
  `reason` for the shared layer now reads "from the shared config (~/.config/webctl)" (it was
  the fragment "from the shared"). Match on the machine field `source` (still `'shared'`),
  never on the reason text.
* **`runtimeXq`** — base's reader of `xq capabilities --json` (`rx9q` §4): fail-closed on the
  schema and malformed known fields, tolerant of additive fields; `hasVerb`, `controlFor`
  (`null` = UNKNOWN, `[]` = NONE), and **`hasFlag`** — never send a flag the target xq does
  not list (an older xq passes unknown flags to the APP with exit 0; an xq without a `flags`
  field is too old to vouch → refused). Pin capabilities, never `xq --version`.
* `docker-ctl.createDockerCtl({dockerHost})` — the same interface bound to a remote daemon.
* **The driver REFUSES a remote docker-ctl** (one carrying `dockerHost`) at construction,
  exit 4, with zero docker calls: its paths, uid, port check, prefs and lock are local, so a
  remote bring-up would run half-local (measured by `webctl:mgr`). Remote browsers run
  through xq (`rx9q`).

### Added — the harness and the gate (`xrl4`)

* **`contract-harness.mjs isolated [--keep <dir>]… -- <cmd…>`** runs `<cmd>` in private
  user, network, mount and PID namespaces:
  * The only network interface is its own `lo`, which is brought up.
  * There is a fresh tmpfs over `/run` and `/tmp`. The cwd, a `$HOME` under /tmp and
    `--keep <dir>` are bound back WRITABLE. Base's repo, node and the command are visible
    READ-ONLY when they live under /tmp or the home (as in the gate), so a mutant cannot
    change the base that the next consumer is judged against. Elsewhere they keep their
    normal permissions, and base's repo is writable when it is the cwd.
  * Host path sockets that are still reachable are masked.
  * The user's home directory is READ-ONLY, except the kept paths.
  * The command runs as the REAL uid and gid (a real uid of 0 is refused), in a child user
    namespace that has
    no mount namespace of its own. So it holds NO capabilities over the masks and cannot
    unmount or remount them. Inherited mounts are locked even in a namespace it nests
    itself. The no-new-privs bit is set, which blocks setuid binaries. A probe run through
    the same prefix before the command starts must read back zero capabilities, the real ids
    and exact single-line uid/gid maps, or the run is refused.
    ⇒ **Nested namespaces still work**: a lane that self-isolates with its own `unshare -rn`
    can bring its own `lo` up, and Chromium's sandbox starts. An earlier design that dropped
    every capability from a namespace root broke both (measured on the first real gate run:
    since Linux 5.12, mapping the parent's uid 0 needs CAP_SETFCAP).
  * It has its own PID namespace, so host processes cannot be signalled, and anything it
    leaves running dies with it. A signal forwarded to it is re-raised, so the caller sees
    the command die BY that signal (a Ctrl-C is never an ordinary exit 130).
  * Called inside a lane's own `unshare -r`, it resolves the REAL uid and home from the
    kernel's uid/gid maps and the passwd database (`getent` by absolute path, cross-checked
    against `/etc/passwd`), accepting a home only if the kernel shows it owned by us. It
    refuses when it cannot resolve them, when there is no passwd entry, when the two sources
    disagree, or when the home lies under /run or /tmp (it would protect nothing).
  * A tool that writes under the home (e.g. npm's `~/.npm/_logs`) gets EROFS. npm itself
    carries on with one warning line; point `npm_config_cache` under `/tmp` to keep its logs.
  * DISPLAY, WAYLAND_DISPLAY, SSH_AUTH_SOCK, DBUS_SESSION_BUS_ADDRESS, DOCKER_HOST and
    XDG_RUNTIME_DIR are unset, and TMPDIR=/tmp.

  **Fails closed**: there is never a fallback to the host. "Already inside" is proven from
  the kernel (namespace ids, uid_map, interfaces, mounts); an env marker alone is refused.
  Why: twice on 2026-10-03 a consumer's mutation control reached a live signed-in browser.
  Separately, `unshare -rn` alone was measured still reaching the docker socket. And the
  final review measured that a command left as namespace root could unmount every mask.
  Companions: `isolation-check <port>…` (a precondition run inside: the real port must give
  exactly ECONNREFUSED, and a self-made fake must answer); `sandbox-port`; `guard-live-port`.
* **Harness generation 5**: the `no-revendor` check counts a same-named file as a shim only if
  it actually imports THAT base module (a lexer, not a regex: comments, strings, templates,
  regex literals including after `break`/`continue`/`debugger`, Unicode identifiers).
  Contracts that `require-generation 4` keep working; `require-generation 5` gets the fix.
* **Gate `--against-head --scratch`** — the recommended pre-release arm. Each wired consumer
  is cloned at its committed HEAD, OUTSIDE /tmp (`WEBCTL_GATE_SCRATCH_DIR`, default
  `${XDG_CACHE_HOME:-~/.cache}/webctl-base/gate-scratch`, because lanes mask /tmp in their
  own sandboxes), with the live tree's INSTALLED `node_modules` copied in (not a fresh
  `npm ci`; an `npm link` symlink inside still points at its live target, which is read-only
  under the home and masked under /tmp), and base's
  candidate is placed in the clone's submodule.
  The contract runs there under `isolated`, with a throwaway HOME. **A change to the live
  tree BLOCKS:** its git-visible state (HEAD, submodule HEAD, `git status`) is fingerprinted
  before and after. Gitignored files (`.env`, profile or state dirs) are NOT covered. A live
  tree under the home dir is read-only from inside, so it cannot be written; a live tree
  elsewhere can be, and an ignored-file write there goes unseen. A live tree with
  uncommitted tracked changes → SKIP, because the commit is not what runs. Isolation
  unavailable → a GATE-ENVIRONMENT fault, never a lane FAIL. Why: some live trees are what
  unattended timers run from, so the in-place swap could run an untested candidate.
* **The gate keeps every run's logs** in its own never-reused directory
  (`WEBCTL_GATE_LOG_DIR`, default `${XDG_STATE_HOME:-~/.local/state}/webctl-base/gate-logs`,
  mode 700): one log per consumer plus the whole run.

### Docs

* `rx9q` — **the runtime layer is xq**: xq runs the app up to a declared control port; base
  speaks CDP/BiDi above it. Capability-pinned, fleet-required via a run-time check. Asks
  X1–X17 to xq; most have landed.
* `rb7s` — remote bring-up over ssh: phases 2–3 SUPERSEDED by `rx9q` (§1's survey of the
  driver's ten local assumptions stays valid).
* `bd1x` — the WebDriver BiDi client spec, with four constraints measured on Firefox 156.
* `v7x3` + `k3wn` — an option a library does not honour is refused, never ignored (to be
  implemented in cdp-client next).

### ⛔ Lanes: anything that looks a container up by its OLD name now finds it ABSENT

A guard keyed on a container name (e.g. "the protected browser is unchanged") then passes
**vacuously** — it reads "not running" before and after. Get names from `describe().names`.
Measured exposure (`webctl:mgr`, git grep at each lane's HEAD): **ccew** HIGH (tool scripts
hard-code `ccew-xpra-$SLUG` / `ccew-chromium-$SLUG`); **linkedin** (a test asserts the old
names; a QA guard is keyed on the old name — vacuous after the rename); **chatgpt** (a test,
README commands); **substack** (AGENTS.md commands). xq-zone lanes and the new lanes: none.
⚠ Read paths do not yet report a pre-owner pair (`describe().names` shows the new names
while the live pair has the old ones) — `inspect().legacy` comes in the next release.

### ⛔ What this does NOT cover

* A runner still on an OLDER base takes no mutex; a few milliseconds of race remain against it.
* A pair that was NEVER migrated is still recreated when its CDP is unreachable or only one of
  its containers runs (pre-existing behaviour).
* The process mutex treats a holder with pid 1, or one in another pid namespace, as dead; its
  10-minute timeout message assumes the dead holder's pid is not reused.
* A uid in the name identifies the owner on ONE docker daemon; two machines whose users share a
  uid are not distinguished (remote containers move to xq per `rx9q`).
* Firefox is still `ENGINES_PENDING`: the BiDi client is specified (`bd1x`), not built.
* cdp-client still ignores unknown options (the rule is written; the code is next).
* `isolated` covers what a lane RUNS UNDER IT. A lane's arm that is not wrapped is not
  isolated; adopting it is each lane's change. It needs unprivileged user namespaces, and
  where they are off it refuses rather than bypassing. **Host unix sockets it does NOT
  mask:**
  * sockets created on the host after the arm starts;
  * sockets bound in another network namespace (e.g. a rootless container's volume), which
    are absent from the host's `/proc/net/unix`;
  * sockets bound by a RELATIVE path, whose location cannot be known;
  * a masked socket the host unlinks and re-creates while the arm runs.
  * sockets under an explicit `--keep` path: those paths are exempt from the check, by
    design (the gate keeps only its own throwaway HOME).

  Paths under `/run` and `/tmp` are covered whatever their kind, because those trees are
  replaced, not checked. ⚠ Outside the home dir, `/run` and `/tmp`, the rest of the
  filesystem keeps its normal permissions (e.g. `/var/tmp`, `/dev/shm`).
* The read-only "home" is the passwd home of the real uid. Two or more stacked
  `unshare -r` levels cannot be resolved from inside, so that case is refused, as is an
  account with no passwd entry (a CI container running an arbitrary uid must add one).
  Browser profiles kept outside the home dir are not covered,
  unless reached through a dot-dir (`~/.cache`, `~/.config`, …) that is ITSELF a symlink out
  of it. A deeper symlink (`~/.cache/<tool>` pointing elsewhere) is not covered.
* A command under `isolated` cannot bind ports below 1024 on the isolated namespace's own `lo`
  (a network namespace it nests itself is its own, as intended).
* The gate's default and plain `--against-head` modes are NOT isolated and still swap in
  place; only `--scratch` gives both guarantees.
* **openPage() currently drives the first existing tab; v0.32.0 changes the default to a new
  target.** Callers that rely on reuse will have to ask for it by target id. Grep your
  `openPage` callers now.

## v0.30.0 — 2026-10-03

### ⛔ BREAKING (for v0.29.0 adopters) — the shared default is the LOWEST layer

* `loadSharedWebctlConfig().configLayer` is now **`{source: 'shared', …}`** (was
  `'config'`), and `resolveTarget` ranks **flag > env > config (the lane's own) > shared**
  (nl0c §1b). In v0.29.0 the shared default sat AT the lane-config rank. A lane wiring it
  beside its own configured target would have raced them, and a signed-in lane would have
  followed the family default to a machine with no profile and no login (raised by
  `webctl:mgr` before any existing lane wired it).
* **A record is whole, never merged.** The resolved name selects one file's record; a
  lane's partial record never inherits from the shared default.
* ⇒ **The two lanes started this morning on v0.29.0** should take v0.30.0 before wiring:
  their code should not compare `source` against `'config'` for the shared layer.

### Added

* `TARGET_KNOBS` gains `shared`: a lane can name `~/.config/webctl/config.toml` in its
  no-target refusal. The generic text is unchanged.

## v0.29.0 — 2026-10-03

**Headline: one loader for the shared `~/.config/webctl/` (nl0c §1a).** Greg: every
lane "sources from shared ~/.config/webctl/", with a declared default browser host.

### Added

* `sharedConfig.loadSharedWebctlConfig({home})`. It reads `config.toml`
  (`default_target`) and `targets/<name>.toml`, and returns the default as a **config
  layer** for `resolveTarget`, so a stated flag or env still wins, plus every valid record
  and an error per bad file.
  * A file wider than mode 600 is refused, not read.
  * A record failing `validateTarget` is refused, naming the key, never the value.
  * A `default_target` naming no valid record, and an unknown key in `config.toml`, are
    errors.
  * No directory is an ordinary state: no default, and the loader **never creates** it
    (tests prove no write).
* `sharedConfig.parseTomlSubset` — `key = "string" | integer | bool | ["str"]` and
  comments; anything else is refused with its line number. Zero dependencies.

### ⛔ What this does NOT cover

* **It does not make a lane use it.** Each lane must call it and feed `configLayer` to
  `resolveTarget`. Lanes that today read a per-tool config only are not switched over by
  this release.
* The record says WHERE (`ssh`, `kind`); reaching it — the ssh transport and running the
  driver remotely — is still per lane (btg4 §5, rm7t §7 "remote build for base-driver
  lanes" is open).

### Also in this release (from v0.28.0 adopters)

* `run-tests-strict`: a caller's own stdout reporter is kept and the runner adds none, so
  TAP streams once; `--tap`/`--spec` beside one is refused (exit 3, "replace, don't add").
  Each stdout reporter repeated every test, which double-counted in the gate's scan
  (`substack`). README: a visibility guard measures the contract's STDOUT, not its log
  (`grok`).

## v0.28.0 — 2026-10-02

### Added — `run-tests-strict` compatibility (from `linkedin` and `gemini`)

* **`--serial`** = `--test-concurrency=1`, and it wins over an earlier concurrency flag.
  node runs test files concurrently; suites that spawn processes or take lock dirs collide.
* **`--allow-plain-scripts`** for direct-script suites (asserts, no node:test). v0.27.0
  failed every such file as EMPTY, because it is indistinguishable from a file that
  registered nothing, and linkedin has 32. The flag accepts them at the cost of the
  empty-file guard for that run. A non-zero exit and a vanished `describe()` still fail;
  an inherited env var cannot enable it.

* ⛔ **`--tap` — REQUIRED in a gate contract.** On `gemini`'s and `substack`'s suites,
  v0.27.0's runner printed **zero TAP lines** to stdout (spec default), which would leave a
  contract green locally and dark to the gate's line scan. Both lanes measured it, kept TAP
  visible by passing the reporter through, and reported it. ⚠ The default stays **spec**. A candidate of this release
  flipped it to TAP, and the gate went red on `fetlife`, whose contract parses spec's
  `ℹ tests N`. That broke the rule this repo wrote the same day: a change must not alter
  what an existing caller already gets. Visibility is therefore a documented required flag,
  and a contract should FAIL if no TAP line streamed.
* A run of **only** `skip`/`todo` tests fails as "ZERO tests ran"; a placeholder-only
  file run alone goes red on adoption (`chatgpt`, `substack`). Documented.
* A file pattern that matches **nothing** fails with a message naming the pattern (plain
  node exits 0). Base's `*.test.*` glob is base's: lanes pass their own (`gemini` names
  files `*-test.js`).

### Fixed

* **Gate false red (v0.27.0):** spec lists failing **TODO** tests under `✖ failing tests:`
  even at `fail 0`, and the gate matched the header alone. Every lane with deliberate
  failing TODOs read FAIL at exit 0 (`ccew`, whose prompt-injection todos fail by
  design). ⚠ The first fix (exempt entries ending `# TODO`) was itself wrong, and the next
  gate run showed it: **a TODO with a reason prints `# <reason>` INSTEAD of `# TODO` in
  spec** (TAP keeps `# TODO <reason>`), so spec text cannot identify a TODO at all. Now:
  the strict reporter's own verdict, when present, is authoritative (it reads events);
  a strict failure verdict in a run that exited 0 is a FAIL (the contract swallowed it);
  and without it, more `✖` entries than the summary's `ℹ todo N` is a FAIL.
* The strict reporter printed its "a describe() threw while registering" hint on every
  failure; the first gate run that exercised it showed it misdirecting on an ordinary
  failing test. It now appears only when a suite failed.

### ⛔ What this does NOT cover

* ⚠ **v0.27.0's runner fails direct-script suites.** A lane with them must use v0.28.0's
  flag (or keep its own runner) before switching.
* Tested on a box reporting `availableParallelism() = 1`; the tests force concurrency so
  both arms are falsifiable here, but multi-core behaviour was not run.

## v0.27.0 — 2026-10-02

**Headline: a green exit is not a green run.** node:test lets a `describe()` that throws
while registering vanish: `not ok`, `# fail 0`, exit 0 (node v22, reproduced; found by
`chatgpt`). Zero-test guards miss it, because the tests that did register still count.

### Added

* `scripts/strict-reporter.mjs` + `scripts/run-tests-strict.mjs`. They fail on any
  failure EVENT (TODO/SKIP excepted), including a vanished suite. They fail a test file
  that registers zero tests (node counts it as a pass), and they strip `NODE_TEST_CONTEXT`
  for nested runs. One implementation for the family; lanes with their own runners
  (`grok`, `chatgpt`, `fetlife`, `gemini`) can fold into it.
* **Release gate:** a contract that exits 0 while printing a TAP `not ok` (TODO/SKIP
  excepted) or spec's `✖ failing tests:` is a **FAIL**, named. `WEBCTL_CONSUMERS_FILE`
  overrides the registry, for the gate's own tests against fake consumers.

### Fixed — in base itself

* Base's own `npm test` was bare `node --test`. Behind the strict runner it failed at
  once: default discovery ran **three helper scripts as tests**. They registered nothing
  and each counted as a pass. One (`mutex-worker.mjs`, given no arguments) took a lock in
  the real `~/.cache/CLIAI/demo-webctl/locks` on every run. Now `npm test` passes an
  explicit `test/**/*.test.{js,mjs,cjs}` glob through the strict runner. The real test
  count is 416, not the 419 reported before.

### ⛔ What this does NOT cover

* **A `"test"` script that never runs node** (`echo "No tests yet" && exit 0` over a
  114-test suite, measured by `fetlife`). No reporter or scan sees it; only reading the
  script does.
* ⚠ **The gate's scan only sees contracts that STREAM their test output — measured at
  the tag: 2 of 7.** gemini (50 TAP lines) and substack (27) stream. linkedin, chatgpt,
  fetlife, perplexity and grok log their suite and print a **summary**, so the scan read
  no result lines for them and their clean result there is **vacuous**. For those lanes
  the protection must be inside the contract (`run-tests-strict` or an equivalent), and
  the gate cannot tell whether it is. *(Stated in the tag message; this line corrected
  on master after tagging.)*

## v0.26.0 — 2026-10-02

### ⛔ BREAKING — reading a config key off `loadJsoncConfig()`'s wrapper now THROWS

* `loadJsoncConfig()` returns `{merged, layers}`. `chatgpt` passed that **wrapper** to
  resolvers that read top-level keys, so every config value read as `undefined`, i.e.
  "unset", silently. Hiding the wrapper's fields would not have helped: an absent key is
  `undefined` either way. ⇒ Now reading any other string key off the wrapper, or `'k' in
  wrapper`, **throws** *"read 'k' from .merged"*. `merged`, `layers`, destructuring, `await`,
  `JSON.stringify`, spread and inspection keep working (tested).
* Breaking only for code that already had the bug: it now crashes where it was silently
  unset. ⇒ **Lanes:** grep for `loadJsoncConfig(` and check every consumer reads `.merged`.

### Added

* `resolveTarget` `hints.configKey`: the refusal names the config key the lane actually
  reads (`chatgpt`: `browser_location`), validated on every call.
* `sb7q`: "additive" is judged from the caller's side, so a new base option must not change
  what an existing caller already gets (the v0.25.0 `scaling` red).

## v0.25.0 — 2026-10-02

### ⛔ BREAKING — harness generation 4: drift under the gate now FAILS

* **v0.24.0's `pin` passed real drift under the gate.** It decided "swapped" from
  `WEBCTL_DECLARED_PIN ≠ worktree`, and since v0.24 the gate sets the declared pin on
  **every** run, so a gate run that had NOT swapped (`WEBCTL_GATE_SWAPPED=0`) still read as
  *"the release gate has swapped this submodule"*. The verdict was NO VERDICT, under a false
  sentence. This voided generation 3's drift FAIL for every lane delegating to `pin`.
  Found in hand-written contracts by `fetlife`, then in base's harness by `gemini` and
  `chatgpt`; base measured it in its own gen 3 before fixing. **Now the only swap signal is
  `WEBCTL_GATE_SWAPPED=1`.** Lanes that scrubbed `DECLARED_PIN` as an interim workaround can
  drop the scrub at generation 4.
* **`require-generation <N>`** — a version floor that fails CLOSED, including on harnesses that
  predate it. The harness lives inside the submodule, so drifting to an older base also
  downgrades the checker (`substack`). A **flag** (`generation --min N`) was measured to
  fail OPEN: generation 2 ignores it and exits 0. An unknown **verb** exits 3 everywhere.
  `generation` now refuses arguments. ⇒ **Contracts: put `require-generation 4` first, and
  treat ANY non-zero as FAIL.** The test runs base's real generation-2 harness from v0.22.0.

### Fixed

* `xpra-attach`: `html5Port` defaulted to `port + 1`, the dead derivation the family
  removed in v0.6/v0.7 (html5 rides the same bind-tcp socket). Now it defaults to `port`.
  A base test had **enshrined** the +1. *(From `chatgpt`'s re-shim.)*

### Added

* `xpra-attach` **`desktopScaling`** → `--desktop-scaling`, accepting every form `xpra
  attach` takes: decimal `1.5`, fraction `3/2`, pixels `1024x768`, per-axis `2x1.5`,
  `on|off|auto` (forms as measured by `chatgpt`). Junk throws. Lanes drop their local
  mapping by renaming their field to `desktopScaling`.
  ⚠ **It is NOT named `scaling`, and the release gate is why.** The first candidate
  (`095c13b`) took `scaling`. Lanes already pass their own `scaling` through and append the
  flag, so chatgpt's suite went red: the flag was emitted twice, and base threw on `3/2`.
  A new base option must not change what an existing caller already gets.
* `resolveTarget` `hints.portFlag`: the refusal spells the port flag the way the tool does
  (`fetlife`: `--remote-debugging-port`). Hints are validated on **every** call, so a typo
  in `supports` surfaces on a run that resolves, not only on a refusal.

### ⛔ What this does NOT cover

* **Base cannot make a lane call `require-generation`.** Only the lane's contract survives a
  downgrade. A gate-side downgrade probe is described in the harness DEV_NOTES; it is not
  built.
* `xpra-attach` still falls back to port `14500` when `port` is unstated. That is nl0c §7 #6,
  which is circulated before it changes.

## v0.24.0 — 2026-10-02

### ⛔ BREAKING — three things that used to pass silently now refuse

* **`createMounts` requires `dockerfilesDir`** (path, thunk, or `null` = "builds no
  images"). Omitting it **throws at construction**, and that reaches every factory that
  builds mounts: `createChromiumDockerXpra(C, opts)` and `createRegistry(C, opts)`. There was
  a fallback to `../../dockerfiles`, and **base ships no dockerfiles**, so it named a
  directory that exists in no layout. A shim that forgot the option ran **stale images
  silently** whenever the image already existed (measured by `linkedin`: a lost
  browser-version assert, caught only by its docker-mode test). ⇒ **Every shim:** pass
  `dockerfilesDir` (or `null` if the tool never builds).
* **Docker up's profile lock is no longer forced, and a failed acquire stops the start**
  (`ow9k`). Force only when the lock already names this container. A live foreign holder,
  or a lock that cannot be written, ⇒ the containers this call started are removed and
  `ensureRunning` throws. ⚠ A consumer test whose fake `profileLock.acquire` returns
  something without `ok: true` now fails that start.
* **Harness generation 3 — `pin` FAILS on drift** (no gate signal, worktree ≠ gitlink) and
  on an **undeclared** submodule (a checkout with no gitlink); a plain vendored directory is
  no longer read as a gitlink. The gate's swap is still NO VERDICT. *(Measured by
  `substack`.)* ⇒ A lane mid-bump with an uncommitted pointer now sees red outside the gate.

### Added

* `resolveTarget` `hints.supports` — the refusal names only the knobs a lane has
  (`TARGET_KNOBS`); unknown or empty `supports` throws. *(From `substack`.)*
* nl0c §3b records `webctl:mgr`'s rulings for `fetlife`: an env port alone refuses; a named
  target's `local_cdp_port` counts; precedence `--target`/`--ssh` > bare `--port` > env >
  config.

### ⛔ What this does NOT cover

* **Lock-before-start is not done.** Step 9 now fails closed, but a container is still
  started before the lock is taken; moving the acquire earlier needs every later failure
  path to release it.
* `null` for `dockerfilesDir` is a declaration the lane makes; base cannot check a lane
  that declares it builds nothing and then calls `docker build` itself.

## v0.23.0 — 2026-10-02

**Headline: an explicit `--port` is a stated location (`nl0c` §3a), so the family's
unattended timers keep running.** Ruled at `webctl:mgr`'s request before a lane adopted
`resolveTarget`.

### ⛔ What this headline does NOT cover

* **`attachOnly` is a field, not an enforcement.** Base returns `attachOnly: true` for a
  `flag:port` target; the lane must refuse to start, build or restart anything for it.
* **No identity check ships here.** §3a says driving identity is the `ow9k` claim, which is
  still blocked on its open question (guest liveness).

### Added

* `resolveTarget` accepts `{source: 'flag', port, host?}`: alone it resolves as loopback,
  source `flag:port`, `attachOnly: true`; beside a location flag it qualifies it (`port`).
  New refusal codes `invalid-port`, `non-loopback-host`; two ports are `ambiguous`. An env
  or config port alone is still `no-target`.
* `LOOPBACK_HOSTS` — the literals a `--port` target may name (`localhost` is not one).

## v0.22.0 — 2026-10-02

**Headline: never assume where the browser runs (`nl0c`), and never restart a browser a
human is using (`lg1n`).** Both from Greg's rulings today; the second after an incident.

### ⛔ What this headline does NOT cover

* **Base does not migrate anyone.** A lane whose users relied on an implicit location will
  start refusing once it adopts `resolveTarget`; the refusal's instructions are the
  migration path, and that lane's own release notes must say so.
* **`findHostLiterals` needs the lane's host names** (from its own machine list). Base ships
  no list — it is public, and a list of hosts to forbid would publish them.
* **`lifecycleGuard` needs a READ viewer count.** Base does not read the display server;
  the lane does, and an unread count refuses.
* ⚠ **lg1n §0 is revised:** a second sign-in with CDP measured OFF was still blocked, so
  CDP is now unlikely to be the cause. Per-device protection and the missing WebGL remain
  candidates; neither is proven.
* Unchanged: no live login-mode reader for base's own driver; hardware acceleration in
  login mode not achieved.

### Added

* `resolveTarget(layers, hints)` — flag > env > config, reporting the winning layer and
  what it shadowed; nothing set ⇒ **refused with instructions naming all three fixes**,
  never echoing a value. A default is allowed only where a person declared it in config.
* `resolveTarget` scope: a caller that will not contact the browser passes `needsTarget:
  false` and gets `not-needed`, never a refusal; two locations in one layer are refused.
* `resolveTarget` refusals are a **reason object** — `{verdict:'refused', code, reason,
  instructions}`, `code` ∈ `no-target` | `ambiguous` — never an exit code: each lane maps
  the code to its own exit table. Only flag, env and config are sources; a layer named
  anything else (`default`, `local`) is ignored, so it refuses as `no-target` (tested per
  source).
* `targetEnvKey(tool, kind)` — the family's one env-name pattern
  (`CLIAI_<TOOL>_BROWSER_TARGET` / `_SSH_TARGET`).
* `findHostLiterals(files, names)` — the "no host literal in code" check; refuses with no
  names or no files rather than reporting clean.
* `lifecycleGuard({mode, viewerCount, humanOverride})` — a restart, stop or re-mint is
  **refused in login mode or with any viewer attached**; an unknown count refuses; only an
  explicit boolean human override proceeds. Its refusal **says a human is signing in**:
  in the incident the reason was misread, and sabotage showed a verdict-only test could
  not catch a generic reason.

### Fixed

* The docker-up **port-conflict hint** printed `lsof -i :<port>`, which also lists every
  process *connected* to the port; a lane acting on that form SIGTERM'd its own test
  process. It now prints the listener form, `lsof -nP -iTCP:<port> -sTCP:LISTEN`. This path
  had no test; `test/port-conflict-hint.test.js` now holds two real ports to reach it, and
  a sabotage run with the old form fails it.

### Docs

* New: `arch-target-resolution-no-implicit-location-nl0c` — named targets on the
  `~/.ssh/config` model; **`--target` is THE location flag, `--client` survives only as
  a synonym** (closing `btg4`'s open question); executable QA with controls.
* `lf4f` marked **superseded in part**: its implicit `default`, its `user_data_dir` path and
  its stored `port` contradict later rules.

## v0.21.0 — 2026-10-02

### ⛔ BREAKING — `parseAppVersion`'s `version` field

* **`version` was the binary's raw line; it is now the NORMALISED dotted version. The raw
  line moved to a new `raw` field.** `"Opera 120.0.1.2"` is now `version: "120.0.1.2"`,
  `raw: "Opera 120.0.1.2"`. Anything asserting or displaying the raw line must read `.raw`.
* Why break it rather than add a field: `version` is the field everyone already compares,
  and it was producing a **false outdated** (the raw line read *differs* against a declared
  dotted version). Leaving it raw would have left that bug in place for every reader that
  did not adopt a new field. Ruled by `webctl:mgr`.
* 0.x, so a minor bump — but stated as breaking, because it is: the release gate caught a
  consumer test pinning the old raw value.

**Headline: versions are normalised in ONE place, and the inventory never reads a
login-mode browser.** Both from lanes' v0.20.0 rollouts.

### ⛔ What this headline does NOT cover

* ⚠ **`parseAppVersion`'s `version` field CHANGES:** it is now the normalised dotted
  version (`152.0.7977.82`), with the binary's raw line moved to a new `raw` field. A
  lane that normalised the raw line itself should find its normaliser idempotent on the
  clean value — but check, and then delete it, which is the point.
* `normalizeVersion` returns **null** (UNKNOWN) when a line has no dotted version or more
  than one outside its *"built on"* part. It never guesses; a browser whose line has an
  unusual shape reads UNKNOWN until someone adds a fixture from its real text.
* Unchanged: no live login-mode reader for base's own driver; hardware acceleration in
  login mode not achieved.

### Added

* `normalizeVersion(raw)` — cut at *"built on"* (the distro part can carry a dotted
  number, e.g. Ubuntu `24.04`), then exactly one dotted token. Fixtures are REAL lines read
  from the local images' binaries (Chromium, Opera) plus the zone-manager lane's measured
  Firefox line.
* `inventoryRows(targets, readings, { loginMode })` — a target in login mode gets an
  UNKNOWN row saying why, never a reading: the `running` reading is taken by `exec` into
  the container, and login mode's window belongs to the human signing in.
* `parseAppVersion` names an **xq too old** for `app version` (its argparse *"invalid
  choice: 'version'"*) instead of blaming a swallowed argument.

### Fixed

* A false **outdated**: the raw line (*"Chromium 152.0.7977.82 built on Debian…"*)
  compared as-is against `152.0.7977.82` read *differs*.

## v0.20.0 — 2026-10-02

**Headline: `parseAppVersion` — base reads the zone manager's `xq app version --json`,
which reports the image that WOULD run and the container that IS running, separately.**
Built by the zone-manager lane in answer to rm7t's distinction.

### ⛔ What this headline does NOT cover

* ⛔ **`versionVerdict` alone does NOT verify a refresh.** It compares version strings;
  staleness is an **identity** question (image IDs), because two builds can print the
  same version and differ. A refresh needs both: `versionVerdict` on `next`, and
  `stale` from `parseAppVersion`.
* A version whose source is an image **label** is a build-time claim; `parseAppVersion`
  reports it as `measured: false` rather than treating it as a reading.
* Base does not run `xq`; lanes do. Unchanged: no live login-mode reader for base's own
  driver; hardware acceleration in login mode not achieved.

### Added

* `parseAppVersion(text)` and `APP_VERSION_SCHEMA` — `next` / `running` / `stale`, each
  version with `measured`; unknown schema or non-JSON → UNKNOWN (the zone manager's
  documented bug class is an argument swallowed and the HUMAN table printed with exit 0);
  no container → `stale: null`, never `false`.

## v0.19.0 — 2026-10-02

### ⛔ SECURITY — read this first

* **An ssh alias beginning with `-` was ACCEPTED by `validateTarget` (v0.18.0), and is
  now refused.** An alias is passed *through* to ssh, and ssh reads a leading-dash
  argument as an **option**: `-oProxyCommand=…` there is **command execution on the
  operator's machine**. A lane's own config already refused it; base did not. The same
  rule now applies to `machine`. If you validated a target with v0.18.0 and then passed
  its `ssh` value to ssh, re-validate it on this release.
* **Refusals never echo the value.** Every message names the key and the rule, never
  the offending value — a config value can be a host, and an error message is the
  most-copied text a tool prints. Tested by planting a distinctive value and asserting
  it appears in no error.

**Headline: `validateTarget` is now CLOSED, and the zone manager's host list has a
reader.** v0.18.0's validator accepted any key and checked only the fields it looked at
— so `{role:'prod', placement:'cloud', zone:'..', bogus_key:1}` read "valid" (found by
gemini, reproduced by webctl:mgr). Closing it is what exposed the alias hole above.

### ⛔ What this headline does NOT cover

* ⚠ **This TIGHTENS validation.** A config that v0.18.0 called valid may now be
  refused: an unknown key, an out-of-range enum, a zone like `..`, an ssh alias starting
  with `-`. That is the point, and it is why this is a minor release, not a patch.
* The enums are the **superset of what lanes run on today**. A lane may narrow them (the
  template's v0.1 does); a value no lane uses yet — e.g. a Firefox app, a persistent
  tunnel — is refused until someone adds it deliberately.
* `parseMachineList` judges the output of `xq machine ls --json`; **base does not run the
  command**. Lanes do.
* Base's own driver still has no live login-mode reader; hardware acceleration in login
  mode is still not achieved (unchanged).

### Changed

* `validateTarget`: **closed key set** (`TARGET_KEYS`), with **forbidden keys refused
  with their reason** (`FORBIDDEN_TARGET_KEYS`, incl. `owner` — ownership is state, not
  config); enums for control, view, app, lifecycle, role, placement, tunnel, kind, base
  (`TARGET_ENUMS`); rules for name, ssh, machine, zone, slug, profile_id, local_cdp_port.
  `name` is now OPTIONAL in the record (lanes key targets by map key) and checked via
  `opts.name`. **Messages name keys, never values.** Vocabulary taken from two lanes'
  real code and btg4, and three real shapes are fixtures that must stay valid.
* ⛔ **`ssh` / `machine` may not start with `-`.**

### Added

* `parseMachineList(text)` and `MACHINE_LIST_SCHEMA` — the reader for the zone
  manager's `xq machine ls --json` (rm7t §2, **resolved** with that lane). Unknown
  `schema` → UNKNOWN and refused; a malformed entry makes the list UNKNOWN rather than
  silently dropping a host; an **absent `reachable` means NOT CHECKED, never
  unreachable**; `present: false` is a valid state.

### Docs

* `rm7t` §2 resolved; §3 corrects my premise that images are per-host because of a baked
  uid — true for base's own driver, **no longer true for zone-manager lanes**, whose
  images are per-host only because each daemon holds its own, and which drift by build
  time. Refresh is `xq build app … --pull --no-cache`; a refresh verifies the image that
  would run, the inventory reports the container that is running — two readings.

## v0.18.0 — 2026-10-02

**Headline: remote-target validators (`rm7t`), usable on their own.** `lib/remotes.js`:
`validateTarget` (with its own refusal for `control = "tailscale"`), `checkConfigMode`,
`versionVerdict`, `inventoryRows`. Tagged now at `webctl:mgr`'s ruling, because lanes can
only consume base through a tag.

### ⛔ What this headline does NOT cover

* **§2's host source of truth is PROPOSED, pending the zone-manager lane (xq:dev).
  NO host-registry reader ships**, and no host-file schema. The open interface question
  is whether webctl reads xq's machine list through a command (`xq machines ls --json`,
  preferred: a command is an interface) or its file. ⇒ **Lanes must not build on the
  registry-reading part** — it waits for that answer and a later tag.
* **Nothing here builds, refreshes or reads anything remote.** These are validators for
  what a lane reads; the transports and the `targets` / `gui build|refresh` verbs are
  lane work.
* `versionVerdict` compares dotted numeric versions; anything else is only checked for
  equality (`differs`), never ordered.
* Base's own driver still has no live login-mode reader, and hardware acceleration in
  login mode is still not achieved (unchanged from v0.17.x).

### Added

* `lib/remotes.js`, exported as `remotes`:
  * `validateTarget` — control `ssh | local`; `control = "tailscale"` refused **with its
    own message** telling the operator to use `--tailscale` to reach ssh; view `ssh |
    tailscale-relay`; `kind`; an opaque `profile_id` (a path is refused, `btg4` §2).
  * `checkConfigMode` — refuses group/other access; an unreadable mode is refused, not
    assumed to be 600.
  * `versionVerdict` — current | outdated | ahead | differs | unknown, naming both the
    reading and the declared target; **a reading without its instrument is UNKNOWN** (a
    claim, not a measurement). Built because a rebuild was measured reproducing a stale
    browser from a cached package layer: exit 0 is not a refresh.
  * `inventoryRows` — every target gets a row; unreachable is UNKNOWN, never omitted.

### Docs

* New: `arch-remote-targets-build-inventory-rm7t`.
* `btg4`: its example no longer shows the target path §3 had refused.

## v0.17.1 — 2026-10-02

**Headline: two traps that lanes hit in LIVE login-mode readings, now handled in base,
plus a value/reason mismatch of my own.** The first two consumers of `loginMode`
(grok, gemini) read real browsers within hours of v0.17.0 and found what fixtures
built from expectations had not.

### ⛔ What this headline does NOT cover

* **Base's own driver still has no live reader** — unchanged from v0.17.0. Lanes on
  base's driver still cannot prove login mode.
* **Hardware acceleration in login mode is still NOT achieved** — unchanged.
* **`joined: true` means reduced fidelity:** a setproctitle-joined argv is split on
  whitespace, so a switch value containing spaces is not reproduced exactly. Switch
  *presence* is reliable; such *values* are not.
* `pickBrowserRoot` identifies Chromium by executable basename. A browser renamed to
  something else is not found — it reads as UNKNOWN, not as clean.

### Added

* `pickBrowserRoot(procs)` — the browser by **parentage** (`{pid, ppid, argv}`):
  exactly one Chromium root, else UNKNOWN. *(gemini: setproctitle-joined children made
  `--type` unusable — ~10 "browsers".)*
* `normalizeArgv` — undoes a setproctitle join and reports `joined`.
* `classifySockets(ssOutput, cdpPort)` and `DOCKER_EMBEDDED_DNS` — keyed on address +
  port, naming `127.0.0.11` as `docker-dns`. *(grok: Docker's resolver listens inside
  the container.)* `parseListeningPorts` now also returns `listeners` with addresses.

### Fixed

* **Advisories are value-conditional.** An empty `--load-extension=` (loads nothing)
  was reported as extension code running; `--disable-blink-features` was flagged for
  *any* feature while its own reason said *AutomationControlled*. A reason that
  disagrees with its code is a claim nobody checked.
* `pickBrowserProcess` normalises setproctitle-joined argvs before checking `--type`.

### Registry

* `grok-webctl` flipped to `wired: true` — verified: gitlink is exactly v0.17.0, tree
  clean, contract present, and its own code imports base.

## v0.17.0 — 2026-10-02

**Headline: login mode (`lg1n`) — a clean, exclusive, non-retrying window for a
human sign-in, with its verdict functions in `lib/login-mode.js`.** Base owns the
VERDICT; each lane owns the READING, because base does not own any lane's browser
launch line and so cannot assume "clean" from the flags it asked for.

### ⛔ What this headline does NOT cover

* **The live reader for base's OWN driver is NOT implemented.** Base's driver can
  *launch* without CDP (portless mode, `containerEnv: { LWC_CDP_PORT: null }`) but
  cannot yet *read back* the running browser's argv and sockets to prove it. Lanes that
  can already read their own browsers (zone-manager lanes) can use the verdicts now;
  lanes on base's driver must wait for the reader.
* ⛔ **Hardware acceleration in login mode is NOT currently achieved.** On the
  family's xpra setup the browser renders on a virtual X server on a host with **no
  GPU** (measured: WebGL1 blocklisted during a real sign-in). The viewer has GL; the
  browser does not. Absent `--disable-gpu` is necessary, not sufficient, and the
  viewer's GL check says nothing about what the page sees. Browser-side GPU is not yet
  checked by anything.
* **It does not prove CDP causes login failures.** The one measured incident was
  confounded, and the site's rate limit appeared with CDP already off.
* **It narrows D8 during sign-in only.** Control mode and the xpra port are untouched.
* **The sign-in predicate is lane-owned** — base ships no "is signed in" check, by
  design, since what signed-in looks like is per site.
* **Ownership re-mint is specified, not implemented** — it depends on `ow9k`, which
  remains a design.

### ✅ RELEASE-GATE EXCEPTION — RULED, THEN NOT NEEDED

**This release is VALIDATED, not excepted.** Recorded anyway, because the gate caught
a real gate-validity defect and it was fixed rather than waived.

* The first `--against-head` run BLOCKED on `perplexity-webctl`: 4 of 602 unit tests
  (#112, #307, #308, #309) derived "the pin" from the **submodule worktree**, so they
  failed against **any** untagged candidate. Their contract layer had handled the swap
  correctly; the defect was one layer down. Not a base regression — 602/602 at their
  real pin, separated only by a real git checkout at the pin vs at the candidate (a
  `git archive` reproduction had first suggested, wrongly, that they failed at the pin
  too).
* `webctl:mgr` ruled a scoped exception on the premise that the lane was paused.
  **The premise was stale:** the lane was live and committed the fix before the tag —
  the pin now read from `WEBCTL_DECLARED_PIN` or the committed gitlink, never the
  worktree, with a sabotage control that turns red if it regresses.
* ⚠ A second gate run came back green **only because perplexity was SKIPPED**: its
  working tree was dirty, because the lane had checked out this base's untagged master
  in its real submodule to reproduce the gate, alongside uncommitted edits. A skip is
  untested, not passed, so that run was not used. ⚠ *Corrected after tagging:* I first
  attributed the dirty tree to the lane's sabotage runner patching files. It does not —
  it works in a temp copy and never touches the live tree (verified by `webctl:mgr`).
  An inference, stated as a cause, about another lane's tooling.
* The **final** run, at this release's commit: `pass=5 skip=5 fail=0`, perplexity
  **PASS**.

### Added

* **Gate: `WEBCTL_GATE_SWAPPED` is now passed to contracts** (`"1"` swapped, `"0"` no
  swap, unset = not under the gate), beside `WEBCTL_DECLARED_PIN`. A lane's unit tests
  can now learn they are under a swap from the gate itself rather than re-deriving it
  from the comparison they are testing — the change that would have prevented the
  block above.
* `lib/login-mode.js`, exported as `loginMode`: `classifyLoginArgv` (CLEAN | VIOLATIONS
  | UNKNOWN, advisories separate), `classifyControlArgv` (the control arm, which must
  FIND CDP), `pickBrowserProcess`, `parseListeningPorts` (`ss -ltn` WITH its header),
  `sameProfile`. Handles Chromium's single-dash switch prefix, the `--` terminator, and
  an argv without a program name — each proven by sabotage.
* ⚠ **`CdpSession` fix — NEW in this release, not v0.16.0:** pending command and
  `waitForEvent` timers are now cleared on socket close (a rejected call previously
  held the process alive for the full command timeout), and the socket is injectable
  via `WebSocketImpl`. A consumer on v0.16.0 still has the leak.
* `contract-harness.mjs gate-probe` and `no-revendor` generation 2 shipped in v0.16.0;
  unchanged here.

### Docs

* New: `arch-login-mode-clean-signin-lg1n`.
* `ow9k`, `btg4`, `gu1d` (`docker-gl` attach mode ruled) and `k3wn` revised under
  review since v0.16.0.

## v0.16.0 — 2026-09-27

**Headline: `HARNESS_GENERATION` is 2, because `no-revendor` could not see the case
it exists for.** Cut immediately and deliberately: consumers run the harness **from
their pinned vendor copy**, so generation 2 reaches nobody without a tag — and a
bare-commit pin stays forbidden. ⇒ **Bump to v0.16.0 before writing a new contract.**

### ⛔ What this headline does NOT cover

* **An EDITED AND RENAMED copy still escapes `no-revendor`.** Whole-file
  normalised hashing catches a copy that was reformatted or re-commented; it does not
  catch one that was edited *and* renamed. That needs content shingles. ⇒ The PASS
  reason **says so on every run**, because a green that implies coverage it does not
  have is how this check spent generation 1.
* **Generation 2 does not audit your existing copies.** It tells a sweep *"who is
  below 2?"*. A contract recording 1 is not broken — it was written against a check
  that could not see a subdirectory copy, and it answers honestly.
* **§6(b)'s LEASE IS STILL BROKEN**, exactly as in v0.15.0. `LOCK_FILENAME` is built
  from `C.PROJECT`, so two tools sharing a profile never contend. Recorded, not fixed.
  ⚠ Anyone building on §6(b) is building on a guard that cannot fire.
* **Ownership is still unverifiable at the point of use.** btg4 now records the
  candidate answers — an ownership token, and one lane's stronger per-invocation form
  — but neither is implemented.
* **btg4 remains `status: draft`** with no `lib/` implementation. Nothing here points
  a tool at a remote browser.

### Fixed

* **`no-revendor` walks both trees RECURSIVELY and matches by NORMALISED CONTENT.**
  Generation 1 read only the top level and matched only identical filenames — while
  **half of base's own lib is nested**, so `profile-lock.js`, `mounts.js` and
  `chromium-docker-xpra.js` were never in the comparison set. Measured: three planted
  re-vendors (nested→flat, subdirectory + rename, rename in place) **all reported
  `pass`**. Now all three are caught, each naming the base module it copies and how.
  ⭐ A legitimate **re-export shim is still not flagged** — the control that matters,
  because flagging the pattern consumers are meant to use would get the check
  overridden. And the normaliser must **discriminate**: distinct base modules
  collapsing to fewer than two hashes is a broken detector, reported as such.

### Docs

* **btg4**: the guest test is **whose sessions are in the profile**, not who called
  `start` — so *"one owner split across two processes"* is a real third category and
  not a guest. `kind` was **two fields wearing one name** (transport/lifecycle vs
  browser ENGINE), with a third value `managed-zone` proposed; and an engine
  **cannot be sniffed** — Opera's `/json/version` reports `Browser: Chrome/151`, the
  one place §4's *"store how to FIND, never what you would MEASURE"* inverts because
  the measurement lies.

## v0.15.0 — 2026-09-27

**Headline: three consumer lanes reviewed `arch-browser-targets-btg4` and two of
them FALSIFIED parts of it against base's own code.** The review found more than
the design did. `inspect()` gained a diagnostic; everything else in this release is
specification and verification.

### ⛔ What this headline does NOT cover

* **§6(b)'s LEASE IS STILL BROKEN — this release records it, it does not fix it.**
  `profile-lock.js:36` builds `LOCK_FILENAME` from `C.PROJECT`, so two tools sharing
  one profile take two DIFFERENT lock files and never contend. Reproduced:
  `.alpha-webctl.lock.json` vs `.beta-webctl.lock.json`, *SAME FILE? false*. ⇒ The
  X-input lease **cannot arbitrate between the two parties it exists for.** Fixing it
  means deciding where lock identity lives (target + `profile_id`, or an explicit
  lease path), which is a design decision and deliberately not rushed into a patch.
  ⚠ **If you are building on §6(b), you are building on a guard that cannot fire.**
* **Nothing ESTABLISHES ownership at the point of use either.** A tool cannot tell
  whether it is an owner or a guest; `--cdp <url>` is free-form and a typo'd port
  reaches another lane's authenticated browser. Same missing identity as the lease,
  one level up. Open.
* **`portSourcesUnavailable` explains an absence; it does not create provenance.**
  If your cfg does not come from `buildDriverCfg()`, the sources are still `null` —
  you now get told why instead of guessing. Two causes remain indistinguishable from
  inside base (stale pin vs hand-built cfg) and the field says so.
* **`gate-probe` is for the GATE, not for your contract.** A lane never calls it. It
  returns no-verdict by hand, every time.
* **`HARNESS_GENERATION` is still 1.** An additive verb creates no stale copies, so
  contracts written against generation 1 are current. Not a bug.
* **btg4 is still `status: draft`,** with two open items above and no `lib/`
  implementation. Nothing here lets you point a tool at a remote browser yet.

### Added

* `contract-harness.mjs gate-probe` — asserts, **inside the gate's real swap
  window**, that `pin` declines a verdict and that its reason names both SHAs. The
  gate runs it per swapped consumer, counts it separately, and **blocks the release
  on a defect, attributed to base rather than to the consumer**. Zero exercises
  reports *"UNTESTED, not passed"*. Previously this arm was proven only against a
  forged fixture.
* `inspect().portSourcesUnavailable` — present **only** when `cfg.portSources` is
  missing, naming both causes and both remedies, so the healthy case stays silent
  and the field cannot become wallpaper.

### Fixed

* `judgePin()` split from `checkPin()` so `gate-probe` asserts on **the same
  verdict** the `pin` verb produces rather than a re-derivation.

### Docs

* **btg4** gained: the two-half guest gap (rendered-text semantics, which fails
  *silently plausible* rather than silently empty, and can invert a safety gate);
  `kind` and `base` in the schema, both found independently by two lanes; ownership
  as a **(tool, target)** property; §8 retitled to carry *"one tool, ONE target that
  is not local"*; and that a remote target implies **that host built its own images**,
  because UID/GID are build args and the failure surfaces as a browser crash.
* **r7x2** — new: argv arrays, file payloads, and §1b, **the remote shell an argv
  array does not cross.** `execFile('ssh', [host, '--', ...argv])` satisfies the
  array rule exactly and is still an injection. ⭐ Records that the stdin form is not
  merely an alternative to per-element `%q`: it is **the only one that stays correct
  when someone later adds an argument.**
* **k3wn** gained three shapes: `git log -S` measures **transitions, not states**,
  and its wrong answer has the right shape; **a guard and a claim that read the same
  input cannot disagree** — detected because *a whole test became unwritable*; and
  **a refusal test needs a positive control on the same fixture**, reached
  independently by two lanes the same day.
* **AGENTS.md**: base is the one **PUBLIC** repo — provenance by ROLE, and our own
  agent handles carry machine names, so cite the LANE.

### Registry

* `claude-chrome-extension-webctl` corrected to `wired:true` (the gate caught the
  registry under-reporting a real consumer), and `perplexity-webctl` registered at
  `tier: contracts`.

## v0.14.0 — 2026-09-27

**Headline: the contract harness.** The checks every consumer contract was
copying are now a library a contract **calls** — `scripts/contract-harness.mjs`,
verbs `generation` / `pin` / `no-revendor`. The harness **owns the exit code**
(0 pass / 1 fail / 2 no-verdict / 3 usage) so no contract re-implements the
`[ "$rc" = "2" ]` handling that already turned one lane's green suite into
exit 1. Cut because three defects were found in three lanes' copies at three
different ages, and **a defective contract reports green** — the one duplication
in this family that fails by reassuring us.

### ⛔ What this headline does NOT cover

* **The harness is three checks, not the contract.** A lane still writes its own
  suite invocation, teardown enumeration and version marker. Adopting the harness
  does not make a contract complete; it removes the three that were provably
  rotting.
* **The gate-swap arm is proven by a FORGED fixture only.** `pin` returns
  no-verdict when `WEBCTL_DECLARED_PIN` disagrees with the worktree, and that
  state is reproduced in tests by constructing it by hand. It is **not yet
  exercisable during a real `--against-head` gate run**, which is the only place
  the state occurs on demand. Until that lands, the arm is tested against a model
  of the gate rather than the gate.
* **It fixes FUTURE duplication, not the copies already out there.** Lanes
  carrying older copies keep their rot, and you cannot find them by diffing —
  rot and legitimate per-lane customisation look identical in a diff.
  `HARNESS_GENERATION = 1` makes "who is below N?" answerable, but **nothing
  sweeps automatically**; someone has to ask.
* **`verify_yaml_frontmatter.py`'s duplicate-ID repair is forward-looking.**
  master's corpus is clean and now provably so, but the four colliding IDs that
  exposed the defect live on **unmerged `design/*` branches**. Any lane that
  merged those locally has collisions that resolved silently until this release.
* **`base-surface.mjs` proves purity for the surface it walks**, not for every
  factory base will add. Enumerating by calling is not free — `resolveChromiumProfile()`
  mkdirs — so the tool constructs against a throwaway `HOME` and asserts it did
  not write. A future factory that writes somewhere else is not covered by that
  guard.
* **No runtime behaviour changed.** `lib/` gained data on an existing frozen
  contract and comments; a consumer bumping to v0.14.0 gets tooling, contract
  data and docs, **not** new browser capability. If you are waiting on the CDP
  client extraction, this is not it.

### Added

* `scripts/contract-harness.mjs` + `.README.md` + `.DEV_NOTES.md`, with
  `HARNESS_GENERATION` exported so a sweep can ask who is behind.
* `scripts/base-surface.mjs` + docs — enumerate base **by constructing**, because
  `grep 'export function'` is structurally blind to the ~46% of the callable
  surface that is only reachable through a factory. The tool carries a vacuity
  guard on itself: zero factory returns exits 1 rather than becoming the grep it
  replaces.
* `CONTAINER_LIFECYCLE_CONTRACT` gains `pairOrder`, `recovery` and
  `recoveryNote` — additive fields on a frozen contract, naming the pair ORDER
  rather than only the absence of a restart policy.

### Fixed

* **`verify_yaml_frontmatter.py`: the duplicate-ID check could not fail.** The
  index was `dict[str, Path]`, so a colliding ID overwrote its predecessor and
  the check downstream regrouped an already-unique mapping — `len(paths) > 1` was
  unreachable while the docstring advertised the check. Measured over master plus
  the unmerged design branches: **47 docs scanned, 40 indexed, "All files passed
  validation", rc 0**, with eleven docs colliding across four IDs. Cross-references
  resolve through these IDs, so `relates_to: [v7m2]` had been resolving to
  whichever doc won the overwrite. The verifier now also runs under `npm test`;
  it previously ran only when an agent remembered the command.
* The release gate exports `WEBCTL_DECLARED_PIN` before each swap, because the
  swap is exactly what makes a contract unable to know its own declared pin.

### Docs

* New: `arch-browser-targets-btg4` — a target says WHERE a browser is and how to
  reach it; a profile is the Chromium user-data directory. Includes the
  per-surface transport split (`control` never leaves ssh/local; `view` may use a
  tailscale relay), and a correction: `ssh host -- <argv>` is **not**
  injection-safe, because ssh joins the remote argv with spaces and the remote
  shell re-parses it.
* New: `test-checks-that-cannot-fail-k3wn` — verification discipline, led
  deliberately by base's **own** shipped defects rather than other lanes'.
* `xrl4` gains the harness's version-marker requirement.
* `AGENTS.md` records that roughly half of base's callable surface is not a
  module export, with the measurement.

### Registry

* `perplexity-webctl` registered, `wired:true`, `tier: contracts`. Tier is the
  honest value rather than the proposed one: the submodule is mounted but no file
  outside `vendor/` imports it yet, so any browser tier would be a statement
  about future code. Flip to `cdp-client` when an import exists.
* **`claude-chrome-extension-webctl` flipped `wired:false` → `true` — the gate
  caught this registry lying.** The stale-entry detector reported "wired:false but
  submodule mounted", and the mount is real: pinned at tag **v0.7.0**, submodule
  checked out, ten-plus non-vendor files importing it. This was not an aspiration
  registered early; it was a real consumer the registry under-reported, counted as
  a skip on every run. ⚠ v0.7.0 is **7 minor releases / 11 tags / 71 commits**
  behind, so making it visible starts a conversation about a very old pin rather
  than closing one. (The v0.14.0 tag's own copy of this entry says "six releases
  behind" — wrong, corrected here on master. A published tag does not get moved.)

### Docs (index)

* `AGENTS.md`'s corpus list was missing **7 of 26** design docs, including two
  written that week. `test/agents-md-indexes-the-corpus.test.js` now fails on an
  uncited doc or a citation resolving to no file — the list is checked rather than
  maintained by memory.

## v0.13.1 — 2026-09-23

⛔ **v0.13.0's `portOrigin()` could not classify TWO OF THE THREE PORTS
`inspect()` carries.** Adopt v0.13.1 if you adopted v0.13.0.

There are **two producers** of port sources and v0.13.0 handled one:

```
resolvePort()      'default' | 'cli' | 'env:FOO' | 'jsonc:port'      classified
deriveXpraPorts()  'derived' | 'derived (== tcp; …)'
                   'jsonc.ports["xpra-tcp"]' | 'jsonc.xpraTcpPort'   -> null
```

⇒ So a **fail-closed consumer — the shape base itself recommends — would have
refused every ordinary bring-up**, because the default `xpra-tcp` source
(`'derived'`) returned `null`.

* `portOrigin()` classifies both producers. `jsonc.` joins `jsonc:`; anything
  base COMPUTED (`derived…`, `default`) is `derived-from-constants`.
* ⚠ **`portOrigin` and `PORT_ORIGINS` are re-exported on the FACTORY surface.**
  They were module-level only, and consumers' shims expose what
  `createClientConfig()` returns — so the lane that needed them could not reach
  them. **A published API a consumer cannot reach is not published.**

⭐ **Why the test missed it.** v0.13.0's coverage test listed `resolvePort`'s
channels BY HAND while the commit described it as walking *"the resolver's real
output"*. It walked ONE resolver's. It now enumerates `cfg.portSources` — the
object that actually reaches `inspect()` — so a producer added later cannot be
missed by a hand-maintained list, and it counts the assertions it ran.

⇒ *Fixing an omission at one call site says nothing about the others* — a rule
this repo recorded the previous day, applied to a single producer.

*(Both gaps reported by cgwc:main within the hour of the tag, from adoption.)*

### ⛔ What this release does NOT cover

* **It does not make the vocabulary load-bearing.** A consumer can still
  reimplement the classification with a local regex and pass every check —
  nothing in a test can observe a vocabulary that is not used. Publishing data
  is not adoption; the shared harness reading it is what would make it binding.
* **Two values only.** `derived-from-constants` covers anything base computed,
  including a port derived from another already-resolved value plus an offset.
  A third value would be a breaking change for every fail-closed consumer.

## v0.13.0 — 2026-09-23

⭐ **Port provenance, end to end — the first `gui` prerequisite, and useful on
its own to every lane whether or not it ever ships `gui`.**

* **`buildDriverCfg()` keeps `portSources`; `inspect()` reports
  `ports: {<key>: {value, source}}`.** These were computed with care by
  `deriveXpraPorts()` and `resolvePort()` and then dropped on the next line —
  nothing in `lib/` consumed them, so the provenance existed for one statement
  and died at the seam. ⇒ A caller could not tell a DERIVED port from a
  CONFIGURED one, which is the distinction this family paid weeks for when a
  derived html5 port was published, reserved and advertised while answering
  nothing.
* **`PORT_ORIGINS` + `portOrigin(source)`** make the family rule *"a CDP port
  must be STATED, never GUESSED"* shareable. ⛔ Deriving from a project constant
  is **not** guessing — `C.DEFAULT_CDP_PORT` is a decision someone wrote down —
  and `'default'` is the word that invites the opposite reading:

```
stated                  a human wrote this value for THIS run
derived-from-constants  computed from C, deterministic and auditable
```

⚠ `portOrigin()` returns **`null`** for anything unrecognised, never a default.
Fail-closed by asymmetry: a wrongly-refused run prints what to do; a
wrongly-accepted one is the bare-default ship the rule forbids.

### ⛔ What this release does NOT cover

* **It does not ship `gui`.** This is one of its prerequisites. The design is
  `ux-gui-subcommand-surface-gu1d`; the two probes it needs (`guiReachable`,
  `html5Answering`) are not implemented.
* **It does not enforce the port rule.** base classifies; the consumer decides
  whether a `derived-from-constants` origin is acceptable for a given verb —
  and for `docker up` it must be, since requiring the port before you may start
  the thing providing it is backwards.
* **A single `PORT_ORIGINS.includes()` check is not sufficient.** Publishing a
  vocabulary closes *drift* and opens *coverage*: an origin base adds and emits
  passes that check and falls through an unchanged branch. Check against the
  list AND against your own handling, and put the second in a suite.
* **`source` is absent, not guessed, for a cfg predating `portSources`** — an
  older consumer passing its own object gets `null`.

## v0.12.0 — 2026-09-22

⭐ **`describeProfileResolution().warning` gains `severity`, and base publishes
the complete vocabulary** as `PROFILE_WARNING_SEVERITIES`.

`kind` says **what** it is. Nothing said **how bad**. ⇒ So every consumer had to
independently decide which kinds are refusals, and they would drift — the
copy-rot mechanism this family has now hit five times.

⛔ **The specific failure it prevents:** a consumer branching on a single kind
string **silently allows a third dangerous kind added later**. That is the
skipping form, and the vocabulary is base's to grow, so the classification is
base's to own.

```
danger  ⛔ refuse — a slug claiming isolation resolving to the DEFAULT profile
notice  proceed; fine, but not what the caller may have assumed
```

⚠ A consumer should still **refuse an unknown severity** rather than assume it
is benign. The asymmetry is the argument, not taste: a new benign value blocking
a bring-up prints what to do; a new dangerous value silently allowed is a
throwaway-named container mounting an authenticated profile.

*(The gap was reported by fetlife-webctl, which had already implemented
fail-closed-on-unknown-kind and asked for the classification to live with the
kind rather than in eleven lanes' hardcoded sets.)*

### ⛔ What this release does NOT cover

* **base still does not refuse.** It classifies. A lane deliberately sharing one
  profile is entitled to, so the policy stays with the consumer.
* **It does not make a single-value check safe.** Branch on `severity` and
  assert against `PROFILE_WARNING_SEVERITIES`; a consumer that hardcodes
  `severity === 'danger'` and nothing else is back in the skipping form the day
  a third severity ships.
* **Nothing else moves.** No driver, teardown or contract-data behaviour change.

## v0.11.2 — 2026-09-22

⛔ **`describeProfileResolution().warning` is now `{kind, text}`**, not a bare
string. ⚠ A shape change, and the third in a day for the one lane consuming this.

It fires for two materially different situations and `warning !== null` is
**true for both**:

```
default-profile-under-throwaway-slug   ⛔ the incident
isolated-but-not-by-slug               a fine bring-up, just not isolated BY the slug
```

⇒ A consumer branching on *"is there a warning?"* would refuse a perfectly safe
configuration, and the only alternative was matching the prose — which silently
weakens the moment the wording changes.

⭐ **Found by applying v0.11.1's own lesson rather than waiting for it to be
reported.** `TEARDOWN_CONTRACT.keeps` was changed from prose to `{key, text}` in
v0.11.1 for exactly this reason; `warning` had the same defect one field over
and shipped in the same release.

### ⛔ What this release does NOT cover

* **It does not decide the refusal policy.** `isDefaultProfile` is `true` for an
  ordinary `--slug default` bring-up too, which must be allowed — the dangerous
  combination is *a slug claiming isolation that resolves to the default
  profile*. base reports the fact and the `kind`; the consumer owns the policy,
  because a lane deliberately sharing one profile is entitled to.
* **Nothing else changed.** No driver, contract-data or teardown behaviour moves
  in this release.

## v0.11.1 — 2026-09-22

⛔ **`describeProfileResolution()` could not tell SAFE from DANGEROUS.** Shipped
in v0.11.0 with `isolatedBySlug` as its only boolean, and it is `false` for both
of these:

```
slug 'qa' + userDataDir '/tmp/isolated'        -> a fine isolated bring-up
slug 'qa' + userDataDir <the DEFAULT profile>  -> a throwaway-named container
                                                  mounting the authenticated one
```

Byte-identical output. A consumer branching on that boolean — the obvious use —
got the same answer for a benign config and for the incident the function exists
because of. ⇒ `isolatedBySlug` answers *"did the SLUG do the isolating?"*; a
bring-up guard asks *"will this touch the DEFAULT profile?"*, and they diverge
exactly where it matters.

* **new `isDefaultProfile`** — the safety question, as its own field.
* the two cases now produce **different warnings**, the dangerous one naming the
  resolved path.
* `isolatedBySlug` stays narrow deliberately, and a test pins that too, so it is
  not later "fixed" into a safety flag and the conflation reintroduced from the
  other side.

**`TEARDOWN_CONTRACT.keeps` entries are now `{key, text}`.** ⚠ A shape change
for anyone already consuming it. The consumer asserting that every kept artifact
is named in its user-facing message was substring-matching prose, so rewording
an entry would silently WEAKEN that check without failing anything. The key is
the contract; the text is for humans.

### ⛔ What this release does NOT cover

* **It does not make `createDriver()`'s purity remove a consumer's scratch
  `userDataDir`.** That was overstated in v0.11.0's notes. A test that CAPTURES
  driver behaviour drives `ensureRunning()`, which still creates the directory —
  so the workaround stays for capture tests. The fix buys the read-only case: a
  `gui status` constructing a driver to read `inspect()`.
* **It does not refuse anything.** `isDefaultProfile` is reported; the policy
  stays with the consumer, because two containers on one profile is legitimate.

## v0.11.0 — 2026-09-22

⭐ **THE RELEASE THAT MAKES BASE'S CONTAINER CONTRACTS CHECKABLE.** Three facts
consumers were re-deriving from base's COMMENTS now ship as frozen data, each
compared against what the driver actually does:

* `XPRA_CONTAINER_ENV_CONTRACT` — `required` / `forbidden` / `htmlFlag` /
  `since`. ⛔ `forbidden` is a **real list**, never the complement of `required`:
  only "must not be set" catches an entrypoint still consuming a variable base
  STOPPED setting, which is the live failure (an entrypoint requiring
  `XPRA_HTML5_BIND` hard-fails against any base at or after v0.6.0).
* `TEARDOWN_CONTRACT` — `removes` is **empty**. `shutdown()` stops; containers,
  volumes, network and profile dir all survive, and **stopped containers still
  hold the volume**, so a later `docker volume rm` refuses.
* `CONTAINER_LIFECYCLE_CONTRACT` — ⛔ **no `--restart`, deliberately**, so
  nothing survives a reboot. Recorded as a DECISION rather than a gap: lanes
  hold sessions authenticated as a real person, a container revived by dockerd
  has no runner while the profile lock records one, and making 14 lanes'
  browsers into boot services is not a change base makes silently. *(An
  undocumented absence cost one lane two weeks: it reported "containers up ~33h"
  to three audiences with both containers EXITED since a reboot.)*

**fix(profile): `createDriver()` no longer creates a profile directory.** It
called the eager resolver, so merely BUILDING a driver made a directory — before
any bring-up, and whether or not one ever happened. Every consumer constructing
a driver to read `inspect()` (what a `gui status` does) littered one per slug.
The `mkdir` moved to `ensureRunning()`.

* `mounts.profilePathFor()` — pure path resolution, creates nothing.
* `mounts.describeProfileResolution()` — names the slug/profile footgun BEFORE
  docker is touched: when `userDataDir` is set the slug is ignored, so a
  "throwaway" slug renames the containers and still mounts the configured,
  often authenticated, profile.
* `scripts/probe-contract-capability.sh` — asks whether each consumer's contract
  can FAIL at all.

### ⛔ What this release does NOT cover

* **It does not change what `shutdown()` does.** It documents it. Volumes and
  stopped containers still need removing by name.
* **It does not add a restart policy.** After a reboot your containers are gone;
  the contract now says so, and a reachability probe is the only thing that
  notices.
* **It does not ship `gui`.** The design is in `ux-gui-subcommand-surface-gu1d`;
  the surface is not implemented, and for the lanes with no driver it
  presupposes a docker harness this release does not provide either.
* **The contract data is not the ground truth** — the driver is. A consumer
  asserts against captured `runDetached` args and uses the data for the message
  and the forbidden set. Grepping base's source returns the NEGATION: a grep for
  `XPRA_HTML5_BIND` matches the comments saying it is deliberately not set.
* **`describeProfileResolution()` reports; it does not refuse.** Two containers
  on one profile is legitimate, so the policy is the consumer's.

## v0.10.1 — 2026-09-05

⭐ **fix(cdp): `listTargetsCorroborated` compared two key spaces**, so
`sourcesAgree` was **false on a healthy stack** and the loud-by-default warning
fired on every call. `Target.getTargets` returns rows keyed `targetId`;
`GET /json` returns rows keyed `id`; `listTargetsViaBrowser` passed its rows
through unnormalised, so browser rows fell back to the url while HTTP rows used
the id. Now normalised (`targetId` -> `id`, `targetId` preserved) at the source,
so no downstream comparison can inherit it. A row carrying neither id nor url is
reported with its own reason rather than collapsing every such row onto the key
`worker:`. *(Measured on a live stack by substack-webctl at v0.10.0; mechanism
confirmed by webctl:mgr.)*

  ⇒ **The rule, which is the durable half:** a known-positive proves an
  instrument can say FOUND; an **ALARM additionally needs a known-NEGATIVE** —
  proof it can say NOT FOUND — because a thing that always fires and a thing
  that correctly fired are indistinguishable from outside.

* **fix(release): the version string agrees with the tag, and is now asserted.**
  Six tags shipped disagreeing with the tree inside them (`v0.4.0`/`v0.5.0` said
  `0.3.0`; `v0.7.0`..`v0.10.0` said `0.6.0`). A one-off correction was
  deliberately NOT the fix: a field wrong for five releases is inert, while a
  field silently corrected once is one people start trusting again.
* **gate: exit 2 is "no verdict", not "needs human"** — the gate was asserting a
  cause it was never told. It now quotes the consumer's own last line and
  carries it in the JSONL envelope.
* **xrl4: a contract must not assert properties of its own pin** when
  `WEBCTL_BASE_DIR` is set. A vacuous RED is not the safe direction.
* **`scripts/tags-since-pin.sh`** — watch base's refs, not your vendored
  snapshot. Soft by default; `--self-test` controls on immutable refs.
* registry comments no longer carry pin VALUES, only the property.
* **gate: the whole reason is quoted, not its last line.** A contract wrapping
  its reason over two lines was being quoted from the tail alone, so the summary
  showed a sentence FRAGMENT — the gate truncating the very words it had just
  been changed to relay faithfully.
* **`tags-since-pin --self-test`: the negative arm now asserts its own subject.**
  "rc=0 and no TOUCHES" is also what an EMPTY RANGE produces, so the arm proving
  the probe can say NOT FOUND would have gone green while measuring nothing.
  ⇒ *A control that replays only part of the condition it claims to replay fails
  toward green.* (cgwc:main, who hit the same shape replaying a log pattern
  without its coupled sort.)

### ⚠ Migration note — crossing v0.5.0 -> v0.6.0 with docker+xpra

Once `xpraHtml5Port == xpraTcpPort`, a consumer whose publish list still carries
a SEPARATE html5 entry emits **two identical `-p` flags**. Docker fails with
**exit 125, "failed to set up container networking"** — an error naming nothing
about duplicate ports, so it presents as a mysterious networking failure on the
first `docker up` after the bump. base itself publishes one entry and is not
affected; this is for consumers carrying their own publish list. Four such sites
were still assuming `tcp+1` in one lane at the time of writing.
*(Measured with a control by the linkedin-webctl lane, 2026-09-05.)*

### ⛔ What this release does NOT cover

* **It does not make `sourcesAgree` mean more than it says.** It compares
  sorted identity key SETS from both sources. It does **not** verify that a
  target is *functional*, and it is still not a basis for concluding a
  service_worker is ABSENT — the browser endpoint remains authoritative and
  `GET /json` is still not reliable for that, exactly as in v0.9.0.
* **It does not fix the six already-published tags.** They are immutable and
  still contain wrong version strings. `git describe` remains the only truthful
  answer to "which base am I on" for anything at or below v0.10.0.
* **`tags-since-pin.sh` does not help retroactively.** It ships inside the thing
  it watches, so a consumer pinned before this tag does not have it.
* **It reports paths, not semantics.** "v0.11.0 touched cdp-client.js" is not
  "the thing you were waiting for landed."
* **No lifecycle or enumeration behaviour changed.** A consumer already on
  v0.10.0 that never called `listTargetsCorroborated` gains nothing here.
* ⚠ **A suite file's NAME is now load-bearing for at least one consumer**
  (`test/portless-mode.test.js`). Renaming or moving a test file is release-note
  material, not housekeeping.

<!-- released in v0.7.0:
* **fix(ports): an out-of-range derived xpra-tcp port is refused, not returned.**
  `xpraTcpPort = port < 55535 ? port + 10000 : port + 100` runs off the end of
  the port space: CDP `65436` derives `65536`, which is not a port. **100 CDP
  ports (`65436..65535`) are affected.** The defect was not the arithmetic but
  the confidence — the resolver returned those values with
  `sources:{tcp:'derived'}`, indistinguishable from a valid derivation, so the
  caller could not tell an impossible port from a good one and the failure
  surfaced later as an unrelated bind error. Now throws, naming the window and
  both remedies. An explicit `xpraTcpPort` still bypasses derivation, so a high
  CDP port remains usable — you just have to say which xpra port you want.
  *(Found and bounded by the chatgpt-webctl lane; reproduced independently
  here.)*
* `PORT_OFFSET_HTML5` note strengthened to **DO NOT USE — RETAINED FOR IMPORT
  COMPATIBILITY ONLY**. Its value is still literally `1` while its meaning is
  now "there is no offset", so anyone who greps, finds it and applies it
  reproduces the defect v0.6.0 removed.
* `WEBCTL_BASE_DIR` exported by the release gate to the consumer contract.
* Gate rollback now traps `INT`/`TERM`/`HUP`, not only `EXIT`.
-->

## v0.6.0 — 2026-09-01

⚠ **MIGRATION REQUIRED. base cannot make this edit for you.** Container
entrypoints must pass `--html=on`, **not** `--html=host:port`. xpra ≥6 rejects
the host:port form. A consumer taking v0.6.0 without this edit gets a correct
base and a broken stack.

⚠ **READ THIS BEFORE CONCLUDING THE PORT FAMILY IS FIXED.** The headline is "the
html5 port collapse", and that is accurate but **partial**. Two separate
overflow paths existed:

* the **html5** `+1` derivation — addressed here, and it accounted for
  **exactly 1** of the 101 affected CDP ports (`65435`);
* the **tcp** derivation itself — **NOT fixed in v0.6.0**. The other **100**
  ports (`65436..65535`) still derive an out-of-range value in this release,
  silently and with full confidence. **Fixed in v0.7.0** — see that entry above.

So: if you pin v0.6.0 and your CDP port is below `65436`, you are unaffected by
either. If it is at or above `65436`, v0.6.0 does **not** help you and you want
v0.7.0. The collapse fixing one boundary case is easy to mistake for the port
family being sound.

### Fixed

* **xpra html5 port collapses onto the tcp socket.** base derived, published,
  bound (`XPRA_HTML5_BIND`), pre-flight-checked and advertised
  `xpraTcpPort + 1` — a port xpra never listens on, because it multiplexes the
  html5 client and its websocket onto the bind-tcp listener. Every docker+xpra
  consumer inherited a reserved, advertised, dead port. Measured on two
  independent live stacks before the fix: `14527`/`14877` served the client;
  `14528`/`14878` answered nothing.
  * `xpraHtml5Port` is **kept and made equal to** `xpraTcpPort`, so cross-repo
    readers of `inspect()` or `deriveXpraPorts()` become correct with no change.
  * `inspect()` additionally advertises `xpraHtml5Url`.
  * An explicitly-configured html5 port that **differs** from tcp is now
    refused rather than silently ignored.
  * **Observationally**, html5 access is unchanged for anyone whose `+1` was
    already dead (probably everyone). Not a no-op overall: one less port
    reserved per stack, and one less spurious "port in use" pre-flight conflict.
* Consumers resolve by optional `localDir`. Three consumers do not live at
  `$WEBCTL_CONSUMERS_DIR/<name>`; one had been invisible to the release gate for
  six weeks while the summary read `OK`.

### Added

* `scripts/test-all-consumers.sh --against-head` — the **pre-release arm**.
  Previously the gate resolved each consumer's *own pin* and never used
  `BASE_ROOT`, so a green result said nothing about the commit being released.
  Both modes now print what they validated against.
* `createProcessMutex(C, opts)` becomes **reachable**: it landed after v0.5.0,
  so the mutex adoption proposals were un-actionable from any consumer's pin
  until this tag.
* `scripts/base-webctl-drift.sh` (lifted from chatgpt-webctl), separating
  packaging drift from logic drift.
* A test enforcing base's **no-top-level-await** guarantee — the property every
  consumer's one-line CJS shim depends on, previously asserted only in comments.

### Deprecated

* `PORT_OFFSET_HTML5` — deprecated. (This entry said "removed at v0.7.0"; that
  was retargeted to v0.8.0 when v0.7.0 was cut — see the v0.7.0 entry for why.)

### Docs

* `xrl4` gains "Gate validity: the green that means nothing".
* `sazn` gains the rotation constraint: rotation prunes only what it created.
* `f6rd` no longer contradicts itself between §2 and its P1 correction.

## v0.5.0 and earlier

Not retrospectively documented here; see the annotated tags and
`FUTURE_WORK/status/`.
