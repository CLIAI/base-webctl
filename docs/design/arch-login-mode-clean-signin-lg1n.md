---
id: lg1n
title: "Login mode — a clean, exclusive, non-retrying window for a human sign-in"
category: arch
created: "2026-10-02"
updated: "2026-10-02"
status: draft
tags: [login, sign-in, cdp, bidi, lifecycle, ownership, qa, clean-browser]
tech:
  - name: "Chromium"
    version: ">=111"
relates_to: [btg4, ow9k, gu1d, 8hw5, k3wn]
depends_on: [ow9k]
expands: []
similar_to: []
---

# Login mode — a clean, exclusive, non-retrying window for a human sign-in

## 0. The ask, and what the evidence does and does not show

Greg, 2026-10-02: some sites misbehave on their login screen when CDP or BiDi is
on, so every `*-webctl` tool should have a **login mode** — the browser started
*"with disabled those browser developer control features so there is as clean
browser as possible with hardware acceleration etc just for the login flow"*, the
human signs in by hand, and after a **confirmed** sign-in the browser is turned off
and on again in control mode. Base implements as much as possible; the lanes
implement the rest consistently, and common parts come back into base.

⚠ **The evidence does NOT isolate CDP as the cause, and this document must not
claim it does.** The one measured incident (`grok`, Chromium 154 in a container,
CDP on): the sign-in's buttons did nothing — but during the same minutes automated
attach tests were repeatedly attaching to the same display session, which can knock
the human's viewer off. After a restart **without** CDP the site answered *"we
temporarily limited your login"*. ⇒ The rate limit appeared with CDP already off:
either it was earned earlier, or it is not CDP-related.

⇒ **So login mode is justified by what it guarantees, not by what it is proven to
fix:**

* the sign-in happens with the browser's **control surface absent** — measured, not
  assumed (§3);
* it is **exclusive**: no tool attaches, types or retries while a human signs in —
  which removes the confounder above whatever its cause;
* it is **non-retrying**: nothing automated presses anything twice, because a
  sign-in is the one place a retry earns a rate limit or a lock.

⛔ **And it shrinks a real exposure during the most sensitive window, without fixing
it.** `webctl:mgr`'s template spec records it as **D8**: CDP and xpra published on
`127.0.0.1` are reachable by **every local account on that host**, and **CDP has no
authentication**. Measured on two of the family's hosts, each had local accounts
**without** container rights that could therefore reach a signed-in browser. ⇒ Login
mode removes the CDP listener **during sign-in**. It does **not** touch control mode,
and it does **not** touch the xpra port — so D8 is narrowed for one window, not closed.

## 1. The state machine — every transition is a human's

```
STOPPED ──login──▶ LOGIN ──(human: "done")──▶ STOPPED ──control──▶ CONTROL
                     │                                              │
                     └──── nothing automated in here ───────────────┘ (control
                                                                       mode as today)
```

* ⛔ **Login mode never advances itself.** No timer, no "looks signed in, restarting"
  heuristic. The human says **done**; until then the browser stays as it is.
* ⛔ **No agent X-input in login mode.** Greg's hands only. A tool must refuse
  `type`/`click`/`key` verbs, and `gui attach` by anything but the human's viewer,
  while the target is in login mode.
* ⛔ **No automated retry of anything** while in login mode.
* ⚠ **The browser can EXIT during login mode** — measured: exit 0 mid-attempt, most
  likely the human closing its window. ⇒ That is an **observed state**,
  `EXITED_DURING_LOGIN`, reported as such — not left for a status command to infer, and
  never treated as "done". *(`grok`.)*
* The profile is **kept** across both restarts (§4). Login mode is not a fresh
  profile; it is the same profile with the control surface absent.

## 2. What "clean" means — and why base cannot assume it

⛔ **Base does not own the browser's launch line.** Each consumer injects its own
container build (`dockerfilesDir`), and some lanes run browsers from a separate zone
manager whose entrypoint base has never seen. ⇒ Base cannot know the flags a
browser was started with by looking at what base asked for. **The verdict must come
from the running browser's own argv**, read live — `btg4` §4's *"read live from the
running containers, never from image labels"*, applied to switches.

**VIOLATIONS** — login mode is *defined* by their absence:

| switch | why |
|---|---|
| `--remote-debugging-port` | CDP over TCP |
| `--remote-debugging-pipe` | CDP over a pipe — no port, still full control |
| `--remote-debugging-address` | only meaningful with CDP |
| `--remote-allow-origins` | only meaningful with CDP |
| `--enable-automation` | automation-revealing |
| `--headless` (any form) | not a human-usable browser |
| `--disable-gpu` | contradicts "with hardware acceleration" |

**ADVISORIES** — reduce cleanliness, may be required by a lane's container; reported,
never silently passed:

| switch | why |
|---|---|
| `--no-sandbox` | often needed in containers; a weaker browser |
| `--load-extension`, `--disable-extensions-except` | extension code running during sign-in |
| `--disable-blink-features=AutomationControlled` | an anti-detection flag — not "clean", it is disguise |

### ⛔ "With hardware acceleration" — WHICH SIDE has the GPU? Currently: not the browser

*(`grok`, measured read-only during a real sign-in.)* The browser's own log, repeated
throughout the attempt: `ContextResult::kFatalFailure: WebGL1 blocklisted`. The
browser renders on **xpra's virtual X server on the browser host, which has no GPU**.
Only the **viewer** — the machine the human looks from — has OpenGL.

⇒ **Absent `--disable-gpu` is NOT the same as having a GPU.** The table above makes
`--disable-gpu` a violation, which is right, but its absence is **necessary, not
sufficient**, and I first wrote it as though it delivered hardware acceleration.

⇒ **Two different GL questions that must not be conflated:**

| side | what has GL | how it is checked |
|---|---|---|
| **viewer** (where the human looks) | the GL xpra client | `gu1d`'s `docker-gl` three-row pass |
| **browser** (where the page runs) | the browser host's X server | ⚠ **not checked by anything yet** |

⚠ A page that fingerprints WebGL sees **the browser's** side. So the viewer's
glcheck passing says **nothing** about what a sign-in page sees.

⇒ **Ruled:** the verdict reports the browser's GPU/WebGL state as an **advisory, read
from the browser host** — never inferred from the viewer's glcheck. And Greg's
*"with hardware acceleration"* is, on the family's current setup, **NOT MET** in login
mode: say so rather than imply it. ⚠ A WebGL-less browser is a **plausible** cause of
a sign-in that "does nothing" — it is **not proven**, exactly as CDP is not.

⚠ **BiDi has no switch of its own in Chromium.** It runs over the CDP transport via a
mapper. ⇒ "no BiDi" is established by the CDP absence above **plus** the absence of a
WebDriver process — not by looking for a BiDi flag that does not exist.

⚠ **Two parsing traps the verdict must handle**, because Chromium handles them:

* on POSIX Chromium accepts **both `--` and `-`** as switch prefixes, so
  `-remote-debugging-port=9222` enables CDP and evades a `grep -- '--remote'`;
* a bare **`--`** ends switch parsing; anything after it is a URL/argument, not a
  switch, and must not be reported as one.

⚠ **Which process.** A browser runs many processes; renderers and helpers carry
`--type=…`. The verdict is about the **browser process** — the one without `--type`.
Zero or more than one such process is **UNKNOWN**, not clean.

## 3. ⛔ Prove the absence as a MEASUREMENT, with a control

*(`webctl:mgr`'s constraint, adopted as stated.)* Login mode is verified by **two
independent readings**, each paired with a **control** that must read the opposite
in control mode:

| reading | login mode must show | control mode must show |
|---|---|---|
| browser-process argv | no violation switches | a CDP switch present |
| listening sockets in the browser's network namespace | nothing on the CDP port | the CDP port listening |

⭐ **The control arm is what makes the login arm mean something.** A reader that
cannot see `--remote-debugging-port` reports "clean" for every browser — which is
`k3wn`'s *"a refusal test needs a positive control on the same fixture"*. Running the
same reader against control mode and requiring it to **find** CDP proves the reader
can see.

⇒ Verdicts are tri-state: **CLEAN · VIOLATIONS · UNKNOWN**. UNKNOWN (no browser
process, several, an unreadable argv) never collapses into CLEAN.

## 4. Same profile across both restarts — by path identity

The `--user-data-dir` read from the login-mode argv and from the control-mode argv
must be **the same path**. ⇒ Asserted from the same readings §3 already takes, so
it costs nothing extra. A missing `--user-data-dir` in either is UNKNOWN: Chromium
would then use its default profile, which is not the profile the human signed into.

## 5. ✅ RULED: ownership is RE-MINTED after the restart, and that is the rule

`grok`'s interim implementation re-mints ownership when restarting into control mode
and recorded it as a deviation from *"mint only in the creating run"*. ⇒ **It is not a
deviation.** *(`webctl:mgr`'s constraint, adopted.)*

* The token is bound to the **browser instance** (its browser id), not to the
  container or the profile.
* A restart creates a **new browser instance**, so the old token is, correctly,
  **invalid** — and verify must **refuse** a token minted before the restart.
* ⇒ *"Mint only in the creating run"* reads as **"mint only in the run that started
  THIS browser instance."** The run that performs the restart into control mode is
  that run. A different run attaching later verifies; it never mints.

⚠ This depends on `ow9k` (ownership and lock identity), whose open question #8 — how
a **guest** establishes liveness — is unaffected: here the owner restarts its own
browser, which is the case `ow9k` already covers.

## 6. Confirming the sign-in without touching it

⛔ **Never read cookie, token or storage VALUES** to decide "signed in". The sign-in
is the human's; the tool observes its effect.

* The predicate is **lane-owned** — what "signed in" looks like is per site, and base is
  service-agnostic. It reads a **rendered-page indicator** in control mode.
* It returns **SIGNED_IN · SIGNED_OUT · UNKNOWN**, and UNKNOWN never collapses into
  either.
* ⭐ **Witness sequence** *(`webctl:mgr`)*: read **SIGNED_OUT** on the profile *before*
  entering login mode, then **SIGNED_IN** after the restart into control mode. The
  known-negative is the predicate's **positive control**: a predicate that can only say
  SIGNED_IN is vacuous, and the only proof it can say otherwise is watching it say so.
* ⚠ When there is no known-negative — re-entering login mode on a profile that already
  reads SIGNED_IN — the witness is **weaker**, and the result must say so rather than
  report the same confidence.

## 7. Screenshots and `xdotool` in login mode

* ⛔ **No agent input** (§1). The container's `xdotool` is not used to type, click or
  navigate during login mode.
* ✅ **X-level screenshots are allowed** — they are taken from the display, outside the
  browser, and are not observable by page script. They are how a tool can show the
  human what is on screen when there is no CDP to capture with.
* ⛔ **But a screenshot of a sign-in screen is SECRET-CLASS.** It can capture a password
  field, a one-time code or an account identifier. ⇒ Never committed, never written to a
  publishable or exportable location, mode `600`, deleted when login mode ends.

## 8. What base ships, and what the lanes do

| piece | owner |
|---|---|
| the verdict functions (§2–§4): argv → CLEAN/VIOLATIONS/UNKNOWN, socket listing → listening ports, same-profile check | ✅ **base**, `lib/login-mode.js`, pure and zero-dependency |
| starting a browser with no CDP | ✅ **base driver already**: `containerEnv: { LWC_CDP_PORT: null }` (portless mode) |
| reading the live argv and sockets from base's own driver | base — **next**, after this circulates |
| reading them from a lane's own containers or zone manager | the lane, feeding base's verdict functions |
| the sign-in predicate (§6) | the lane |
| the `login` / `done` / `control` verbs | the lane, consistently; the template carries the shape |

⇒ **The seam is deliberate:** base owns the *verdict*, the lane owns the *reading*,
because base does not own the lanes' containers. Every lane then produces the same
verdict from the same rules, which is what makes the check comparable across the
family.

## 9. QA — every item EXECUTES, and one item honestly does not

Each item is an assertion with a control. *(`gu1d`'s ruling: a checklist a contract
"cites" is not enforcement.)*

1. **Login mode, argv:** browser-process argv has no violation switch. *Control:* the
   same reader on control mode finds a CDP switch.
2. **Login mode, sockets:** nothing listens on the CDP port in the browser's network
   namespace. *Control:* control mode shows it listening.
3. **Same profile:** `--user-data-dir` identical across the two readings.
4. **Ownership:** after the restart, verify **accepts** the freshly minted token and
   **refuses** the pre-restart one.
5. **Sign-in witness:** SIGNED_OUT before, SIGNED_IN after; a weaker witness is
   reported as weaker.
6. **Exclusivity:** an agent input verb issued during login mode is **refused**.
7. **Advisories are reported**, never silently passed.

⚠ **The one item that stays prose:** *whether the site accepted the human's sign-in
without trouble.* That is a human judgement about a third party's behaviour, and it is
labelled as such rather than hidden among the assertions.

## 10. What this does NOT do, and what is open

* **It does not prove CDP causes login failures** (§0). If a site still misbehaves in a
  measured-clean login mode, that is evidence about the site, and worth recording.
* **It does not make the browser undetectable.** "Clean" means the control surface is
  absent, not that the browser is disguised — which is why the anti-detection switch is
  an *advisory*, not a recommendation.
* **Open — the live reader for base's own driver** (§8): reading the browser-process
  argv and listening sockets from inside the container, to feed §3.
* **Open — whether `--no-sandbox` can be dropped in login mode** for any lane. Measure
  per lane; do not assume.
