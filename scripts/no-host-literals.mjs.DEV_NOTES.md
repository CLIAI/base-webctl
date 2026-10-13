# `no-host-literals.mjs` — dev notes

## Why base owns it (ruling, 2026-10-13)

Lanes ran `xq machine ls --json` INSIDE `isolated` to get their machine names. With the home
hidden, that broke (`contract-harness.mjs.DEV_NOTES.md`, "xq could not run inside"). Under the
docker backend it cannot work at all, because the image has no xq. The ruling: **pass the data
in, not the tool.** `isolated` asks xq on the host and passes the names as a read-only file. This
script is the one check every lane runs on it.

## Decisions

* **Tracked files only.** Untracked files are not what gets published, and `git ls-files -z`
  is NUL-separated, so any filename is safe.
* **Index, not name.** The hit says which line of the passed file matched. Whoever has that
  file can look it up; a log reader cannot.
* **Empty file → REFUSED.** An xq with no machines configured gives an empty list. A scan for
  nothing would say clean, so the refusal names the empty list instead.
* **Binary files are skipped** (a NUL byte means not source). A name inside an image is out of
  scope.

## Arms

`test/no-host-literals.test.js`: a planted name is found and printed by index only; the unset
variable, an unreadable file, an empty file and an untracked-only tree are each a named
refusal; a CONTROL tree with no literal is clean.
