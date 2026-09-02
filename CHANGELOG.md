# Changelog — base-webctl

Consumers pin base by **tag**. This file is what you read when deciding whether
to move a pin, and it states the LIMITS of each release as prominently as its
contents — a release note that lists only what was fixed lets a reader conclude
they are safe on the strength of a headline.

> ⚠ **A checkout of an older tag does not contain this file's later entries.**
> Read it on `master` (or on GitHub), not from inside your pinned submodule.

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

## Unreleased (on `master`, not yet tagged)

*Nothing yet — v0.7.0 is current.*

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
