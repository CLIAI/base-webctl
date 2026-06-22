#!/usr/bin/env bash
# test-all-consumers.sh — the cross-repo release gate (xrl4 §"The gate").
#
# For the current base checkout, loop every registered consumer
# (consumers.jsonc), run its ./test-against-base.sh contract HEADLESSLY, and
# refuse the release if ANY consumer reports FAIL. `skip` (needs-human / not
# yet wired / repo absent) never blocks. Emits JSONL envelopes (lszd) and a
# human summary.
#
# This is a LOCAL-clone gate: it exercises consumer working copies found under
# $WEBCTL_CONSUMERS_DIR. (CI fresh-clone mode is FUTURE_WORK — see .DEV_NOTES.)
#
# Exit: 0 if no consumer FAILs (skips allowed); 1 if any consumer FAILs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_ROOT="$(cd "$HERE/.." && pwd)"
CONSUMERS_DIR="${WEBCTL_CONSUMERS_DIR:-$HOME/github/CLIAI}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# emit a JSONL envelope: type, ts, consumer, suite, result
envelope() {
  printf '{"type":"consumer-test","ts":"%s","consumer":"%s","suite":"%s","result":"%s"}\n' \
    "$(ts)" "$1" "$2" "$3"
}

pass=0 fail=0 skip=0
fails=()

while IFS=$'\t' read -r name submodulePath testCmd tier dockerOptIn wired; do
  [ -n "$name" ] || continue

  if [ "$wired" != "true" ]; then
    envelope "$name" "$tier" "skip"
    echo "SKIP  $name ($tier) — not yet wired to the submodule" >&2
    skip=$((skip + 1)); continue
  fi

  repo_dir="$CONSUMERS_DIR/$name"
  if [ ! -d "$repo_dir" ]; then
    envelope "$name" "$tier" "skip"
    echo "SKIP  $name ($tier) — repo not present at $repo_dir" >&2
    skip=$((skip + 1)); continue
  fi

  if [ ! -d "$repo_dir/$submodulePath" ]; then
    envelope "$name" "$tier" "skip"
    echo "SKIP  $name ($tier) — submodule '$submodulePath' missing in working copy" >&2
    skip=$((skip + 1)); continue
  fi

  # Run the consumer contract headlessly. The contract owns exit-code mapping:
  #   0 pass | 1 fail | 2 blocked-needs-human (-> skip).
  echo "RUN   $name ($tier): $testCmd" >&2
  rc=0
  ( cd "$repo_dir" && eval "$testCmd" ) || rc=$?
  case "$rc" in
    0) envelope "$name" "$tier" "pass"; echo "PASS  $name" >&2; pass=$((pass + 1)) ;;
    2) envelope "$name" "$tier" "skip"; echo "SKIP  $name — needs human (exit 2)" >&2; skip=$((skip + 1)) ;;
    *) envelope "$name" "$tier" "fail"; echo "FAIL  $name (exit $rc)" >&2; fail=$((fail + 1)); fails+=("$name") ;;
  esac
done < <(node "$HERE/read-consumers.mjs")

echo "----- gate summary: pass=$pass skip=$skip fail=$fail -----" >&2
if [ "$fail" -gt 0 ]; then
  echo "BLOCKED: ${fails[*]} failed against this base." >&2
  exit 1
fi
echo "OK: no consumer FAILed (skips do not block)." >&2
exit 0
