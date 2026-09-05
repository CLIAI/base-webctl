# `tags-since-pin.sh` — dev notes

## The failure this replaced

A consumer wrote `test/portless-blocker-watch.test.js` to announce when base's
portless blocker lifted — a faithful implementation of the rule that *a guard
carrying REMOVE-THIS-WHEN-X should be the thing that tells you X happened*.

It was green, and it reported "blocker still present". That report was **true**:
it read the driver at `vendor/base-webctl`, the pinned copy, which cannot change
until someone bumps the pin.

base shipped `f84d7f5` and tagged `v0.8.0` on 2026-09-02 at 03:52. That repo
said nothing for three days.

### The second, worse defect underneath it

When the lane went to fix the blind spot, it found the watch **could never have
fired at all** — pin or no pin, bump or no bump. Its predicates tested for two
literal strings, `LWC_CDP_PORT: String(port),` and `CDP not reachable at`. Both
**survive the commit by design**: the assignment stayed (a `cfg.containerEnv`
merge now sits over it, so `null` deletes the key), and the unreachable-CDP
error stayed because the CDP-*enabled* path must still fail that way — it moved
behind a mode gate.

The watch was decorative from the day it was written. The blind spot only
decided *which* three days it was silent.

> It had written down **the text base happened to have** instead of **the
> property that blocked it**. A regex over someone else's implementation
> re-derives their semantics from their source text.

Hence: this probe asks **git** what moved between two refs. Path-level change
detection is structural. It cannot be fooled by a string that outlived its
meaning, because it never reads the strings.

## Why the control is two-sided and historical

`--self-test` asserts the probe returns *both* answers over `v0.7.0..v0.8.0`:
`lib/storage-paths.js` present (added at v0.8.0), `lib/xpra-presence.js` absent
(untouched in that range). Verified before the control was written:

```
$ git diff --name-only v0.7.0 v0.8.0 -- lib/
lib/browser-location/chromium-docker-xpra.js
lib/browser-location/mounts.js
lib/index.js
lib/process-mutex.js
lib/storage-paths.js
```

Two dead predicates reported confidently for three days precisely because
nothing ever asked them to produce the other answer.

The refs are **immutable**, which is what reconciles "give the probe a control"
with "a watch must not go red when someone else does something correct". The
control asserts a property of *this script*, permanently; it fails rather than
diagnoses, and it cannot break because base ships something new. Without that
distinction, "add a control" reads as "make your watch brittle" and gets
declined — correctly.

## Design choices worth not re-litigating

* **Soft by default (exit 0 on news).** Upstream releasing is not your repo
  breaking. `--exit-code` is opt-in.
* **Fetch failure WARNs loudly and continues.** A stale report is the exact
  blind spot the probe exists to close, so it must never look like a clean one.
  It still reports, because a consumer offline on a plane is better served by
  "here is what I know, it may be stale" than by nothing.
* **A non-git `BASE_DIR` is exit 1, not "no news".** A probe that cannot reach
  its subject must say so. "Could not check" rendering as "nothing to report"
  is the same two-absences failure (`arch-coincident-fields-t2wf`) the rest of
  this repo keeps finding.
* **`${MODULES[@]}` defaults to `lib/`,** so a consumer that names nothing gets
  a broad, noisy, *correct* answer rather than a narrow silent one.

## Known limit — not a bug, but do not forget it

The probe ships **inside** the thing it watches. A consumer pinned before the
release that adds it does not have it; demonstrated live at the time of writing,
where `gemini-webctl` (pinned `v0.10.0`) had no such file. The probe therefore
helps from its introducing tag onward and never retroactively.

Fixing that properly would mean executing a script fetched from a remote, which
is a supply-chain hazard well out of proportion to the problem. Left as is,
deliberately.
