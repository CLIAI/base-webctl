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
