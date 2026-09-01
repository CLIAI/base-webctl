# Changelog — base-webctl

Consumers pin base by **tag**. This file is what you read when deciding whether
to move a pin, and it states the LIMITS of each release as prominently as its
contents — a release note that lists only what was fixed lets a reader conclude
they are safe on the strength of a headline.

> ⚠ **A checkout of an older tag does not contain this file's later entries.**
> Read it on `master` (or on GitHub), not from inside your pinned submodule.

## Unreleased (on `master`, not yet tagged)

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
  silently and with full confidence. Fixed separately; see *Unreleased* above,
  shipping in v0.7.0.

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

* `PORT_OFFSET_HTML5` — **removed at v0.7.0**.

### Docs

* `xrl4` gains "Gate validity: the green that means nothing".
* `sazn` gains the rotation constraint: rotation prunes only what it created.
* `f6rd` no longer contradicts itself between §2 and its P1 correction.

## v0.5.0 and earlier

Not retrospectively documented here; see the annotated tags and
`FUTURE_WORK/status/`.
