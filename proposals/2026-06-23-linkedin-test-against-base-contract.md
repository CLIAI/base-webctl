# Proposal — linkedin-webctl: adopt the `./test-against-base.sh` xrl4 contract

* **For:** `webctl:linkedin@knot` + Greg — **one additive file, no code change.**
* **From:** `webctl:base@knot` (xrl4 gate-live step, 2026-06-23).
* **Status:** authored + PROVEN real-GREEN against linkedin in a worktree; **not
  committed to linkedin** (no-touch-consumer rule). This is the single step that
  turns the cross-consumer release gate from "all-SKIP / proves nothing" into a
  real guard.
* **Refs:** `test-cross-repo-consumer-loop-xrl4` (the contract spec),
  `arch-shared-base-as-submodule-sb7q`, `data-jsonl-machine-interface-lszd`.

## Why this matters (Greg's core requirement)

base's release gate (`scripts/test-all-consumers.sh`) is meant to make *"a base
change is provable not to break any consumer — before any consumer adopts it"*
true and programmatic. Today every consumer is `wired:false` and **neither adopter
ships `./test-against-base.sh`**, so a gate run = all-SKIP / exit 0, proving
nothing — a **false green**. linkedin is the live adopter (submodule pinned
v0.3.0, 9 base modules in use), so wiring linkedin's contract makes the gate
*actually* catch base→consumer breakage. **Do this before linkedin bumps to
v0.4.0/v0.5.0**, so the gate guards those bumps.

## What to add — ONE file at the repo root

`linkedin-webctl/test-against-base.sh` (chmod +x). The exact, proven script is in
base at `scripts/reference/linkedin-test-against-base.sh` — copy it verbatim. It
implements the xrl4 contract mapped onto linkedin's existing runners:

| mode | what it runs | notes |
|---|---|---|
| `--offline` (default; **no-human**) | `node test/*-test.js` (all 24 unit/mocked suites) | covers linkedin's consumption of every adopted base module (client-config, chromium-prefs, profile-lock, docker-mode, browser-location, lru-cleanup, systemd-timer, xpra-presence, …) |
| `--unit` | same 24 suites | the `*-test.js` ARE the unit tier |
| `--stack` | `test/docker-live-test.sh` | gated behind `LINKEDIN_WEBCTL_DOCKER_TESTS=1`; unset → exit 2 (skip) |

* **Exit codes** (xrl4): `0` pass · `1` fail (blocks base release) · `2`
  blocked/needs-human/not-enabled (gate SKIP).
* **Output:** lszd JSONL envelopes on **stdout** (one per suite,
  `{"type":"consumer-test",ts,consumer,suite,result}`); each suite's own output +
  a human summary on **stderr** (so stdout stays valid JSONL).
* `smoke-test.sh --offline` is intentionally **excluded** from the gate suite — it
  is a slower CLI smoke (it ran >30s in our probe). Add it later with a timeout if
  you want; the `*-test.js` tier already exercises all base consumption fast +
  deterministically.

## Proof (against your repo @ HEAD, submodule v0.3.0)

In a throwaway `git worktree` of linkedin with the script dropped in:

* `./test-against-base.sh --offline` → **24/24 suites pass**, clean JSONL, exit 0.
* `scripts/test-all-consumers.sh` (linkedin `wired:true`) → **`PASS
  linkedin-webctl`**, gate exit 0 — REAL green, not SKIP.
* **Teeth check:** injecting a `throw` into `vendor/base-webctl/lib/client-config.js`
  → 12 suites FAIL → `BLOCKED: linkedin-webctl failed` → gate exit 1. So the gate
  genuinely catches base breakage.
* Evidence: `/tmp/claude/260623-gate/PROOF.md`.

## base-side changes already landed (so adoption is the only remaining step)

* `consumers.jsonc`: linkedin `wired:true` (honest — your master mounts the
  submodule). Until this script lands, the gate reports linkedin as SKIP **"contract
  pending"** (NOT fail) — no false-red. It auto-flips to real PASS/FAIL the instant
  you commit the script.
* `scripts/test-all-consumers.sh`: hardened to distinguish "wired but contract not
  yet adopted" (SKIP) from a real failure.

## How to adopt

```bash
cd linkedin-webctl
cp vendor/base-webctl/scripts/reference/linkedin-test-against-base.sh ./test-against-base.sh
chmod +x ./test-against-base.sh
./test-against-base.sh --offline    # expect 24/24 pass, exit 0
git add test-against-base.sh && git commit -m "test: adopt xrl4 ./test-against-base.sh contract"
```

After this lands, `webctl:base`'s gate guards every base change against linkedin
automatically — and the v0.4.0 mounts + v0.5.0 chain bumps run under a real gate.

## Not in scope

No linkedin code changes. The uploads FEATURE stays queued. chatgpt/telegram/
fetlife get their own contract proposals when they wire the submodule.
