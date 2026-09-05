# `tags-since-pin.sh` — has base tagged past my pin?

Answers, from a consumer: **has base released anything newer than the commit I
have vendored, and does any of it touch a module I actually use?**

## Why it lives in base

A consumer that wants to know when an upstream blocker lifts naturally writes
the guard into its own repo — and naturally points it at `vendor/base-webctl`,
because that is the copy in front of them. That copy is **pinned**: it cannot
change until someone bumps it. So the guard can only fire at the moment of the
bump. It confirms a decision already taken instead of prompting it.

base `v0.8.0` sat unnoticed in a consumer for three days that way.

> **Watch where X happens (base's refs), not where X arrives (your snapshot).**

Shipping the probe here means nobody re-derives the blind spot along with the
check.

## Usage

```sh
# from a consumer repo, with base vendored at vendor/base-webctl
./vendor/base-webctl/scripts/tags-since-pin.sh --module lib/cdp-client.js
```

```
NEWER TAGS since 020f93a: v0.11.0
  v0.11.0 TOUCHES modules you watch:
    lib/cdp-client.js
```

| Option | Meaning |
|---|---|
| `--module PATH` | module to watch, repeatable. Default: everything under `lib/` |
| `--pin REF` | compare from this ref instead of the checkout's `HEAD` |
| `--until REF` | upper bound (used by the controls; usually omitted) |
| `--offline` | do not fetch — report from refs already present |
| `--exit-code` | exit 10 when there is news; default is always 0 |
| `--json` | also emit a JSONL envelope |
| `--self-test` | run the historical controls and exit |

**Exit:** `0` no news, or news without `--exit-code` · `10` news with
`--exit-code` · `1` the probe could not run · `2` bad usage.

## It is soft by default, deliberately

Exit 0 even when there is news. **A watch must not go red because someone else
did something correct** — upstream shipping a release is not your repo
breaking. Opt into `--exit-code` only for a job that should *act* on news.

## The control

```sh
./vendor/base-webctl/scripts/tags-since-pin.sh --self-test
```

Runs two queries over **immutable historical tags** and asserts it gets *both*
answers: `v0.7.0..v0.8.0` must report `lib/storage-paths.js` (added at v0.8.0)
and must **not** report `lib/xpra-presence.js` (untouched in that range).

A probe that cannot return both answers is a constant wearing a probe's
clothes. Because the refs are historical, this control asserts a property of
the probe permanently — it cannot start failing because base ships something
new, which is what makes it safe to attach to a soft watch without making that
watch brittle.

## Two limits, stated

* **An old pin ships an old script.** The probe runs from the vendored copy, so
  a consumer gets it only from the release that introduces it onward. It does
  not help retroactively. (`--remote-script` is deliberately absent: fetching
  and executing a script from a remote is a supply-chain hazard nobody asked
  for.)
* **It reports paths, not semantics.** "`v0.11.0` touched `lib/cdp-client.js`"
  is not "the thing you were waiting for landed." It tells you where to look.
  For "did base *assert* behaviour X", read base's test suite at that tag — a
  suite file named for a capability does not linger from before the capability
  existed, whereas a string in an implementation might.

See `.DEV_NOTES.md` for the failure this replaced.
