#!/usr/bin/env bash
# verify-no-byte-drift.sh — the re-vendoring canary (xrl4, sb7q §submodule).
#
# Once a consumer adopts a base module via the submodule, the consumer's own
# copy of that file (e.g. lib/browser-location/docker-ctl.js) MUST become a thin
# re-export shim pointing at vendor/base-webctl — NOT a byte-copy of the base
# source. A byte-identical copy means the consumer silently regressed to
# byte-duplication (the very thing sb7q replaces): a base fix would no longer
# reach it.
#
# This script compares each base lib file against the consumer's same-path file
# (for WIRED consumers only) and FAILs if any are byte-identical.
#
# Exit: 0 if no drift (or nothing wired yet); 1 if a byte-identical copy found.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_ROOT="$(cd "$HERE/.." && pwd)"
CONSUMERS_DIR="${WEBCTL_CONSUMERS_DIR:-$HOME/github/CLIAI}"

# Base lib files that, once shared, must NOT be byte-copied into a consumer.
mapfile -t base_files < <(cd "$BASE_ROOT" && find lib -type f -name '*.js' | sort)

drift=0
checked=0

while IFS=$'\t' read -r name submodulePath testCmd tier dockerOptIn wired; do
  [ -n "$name" ] || continue
  [ "$wired" = "true" ] || { echo "skip  $name — not yet wired" >&2; continue; }

  repo_dir="$CONSUMERS_DIR/$name"
  [ -d "$repo_dir" ] || { echo "skip  $name — repo not present at $repo_dir" >&2; continue; }

  for rel in "${base_files[@]}"; do
    consumer_file="$repo_dir/$rel"
    [ -f "$consumer_file" ] || continue
    checked=$((checked + 1))
    if cmp -s "$BASE_ROOT/$rel" "$consumer_file"; then
      echo "DRIFT $name: $rel is a byte-identical copy of base (re-vendored!)" >&2
      drift=$((drift + 1))
    fi
  done
done < <(node "$HERE/read-consumers.mjs")

echo "----- drift check: compared=$checked drift=$drift -----" >&2
if [ "$drift" -gt 0 ]; then
  echo "BLOCKED: $drift re-vendored file(s); consumers must import from the submodule." >&2
  exit 1
fi
echo "OK: no byte-duplication of base files detected." >&2
exit 0
