# `no-host-literals.mjs` — no machine name in tracked code

The "no host literal in code" check (`arch-target-resolution-no-implicit-location-nl0c` §3),
owned by base, so lanes stop copying their own script (`test-isolation-backends-ib4k` §3b,
"Machine names").

## Usage

Run it from a consumer's root, inside its contract, under `isolated`:

```bash
node vendor/base-webctl/scripts/no-host-literals.mjs
```

* It reads `$WEBCTL_MACHINE_NAMES_FILE`: one machine name per line. `isolated` sets that
  variable when it passes the names in. It asks the host's `xq machine ls --json` before
  entering any backend.
* It scans the files git **tracks** in the cwd (`git ls-files`). Untracked and binary files are
  not source.
* ⛔ A hit prints `path:line` and the name's **index** in the passed file, never the name.
  The names are private data, and a contract's output can reach a gate log.

| exit | meaning |
|---|---|
| 0 | clean: no tracked file names a machine |
| 1 | FOUND: each hit on stderr as `path:line: machine name #k` |
| 2 | REFUSED, by name: the variable is unset, the file is unreadable or empty, or nothing is tracked |

⚠ **A refusal is not a pass.** A scan for nothing reports clean, which is the false-zero
shape (`test-checks-that-cannot-fail-k3wn`). When `isolated` could not pass names, its verdict
says `; machine-names: none (<why>)`, and this check refuses.

## Library form

`checkNoHostLiterals(io)` is the same check, with its reads injected (the test arms use it).
The scan itself is `findHostLiterals(files, names)` from `lib/remotes.js`.
