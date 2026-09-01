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
# TWO MODES:
#   (default)      each consumer runs against ITS OWN PIN. This answers "do the
#                  consumers still work?" — it does NOT answer "is this base
#                  releasable?", because the contract resolves the consumer's
#                  vendor/base-webctl, not base's tree. For months BASE_ROOT was
#                  computed here and never used, so a green gate said nothing
#                  about the commit being released (xrl4 "Gate validity").
#   --against-head each WIRED consumer is temporarily pointed at BASE'S CURRENT
#                  HEAD and its contract re-run. THIS is the pre-release arm: it
#                  is the only mode whose green means "this base does not break
#                  its consumers". Run it before cutting a tag.
#
# --against-head TEMPORARILY MUTATES consumer working copies (it checks their
# submodule out at base HEAD, then restores it). It therefore REFUSES to touch a
# consumer whose repo or submodule is dirty — another agent may be mid-edit —
# and reports SKIP naming why. Restore runs from an EXIT trap, so an interrupt
# still puts the submodule back.
#
# Exit: 0 if no consumer FAILs (skips allowed); 1 if any consumer FAILs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_ROOT="$(cd "$HERE/.." && pwd)"
CONSUMERS_DIR="${WEBCTL_CONSUMERS_DIR:-$HOME/github/CLIAI}"

AGAINST_HEAD=0
for arg in "$@"; do
  case "$arg" in
    --against-head) AGAINST_HEAD=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# What this run VALIDATED AGAINST — stated up front, because "PASS" alone was
# routinely read as "base is releasable" when it meant "the consumer still works
# against the version it pinned last month" (xrl4).
BASE_HEAD="$(git -C "$BASE_ROOT" rev-parse HEAD)"
BASE_DESC="$(git -C "$BASE_ROOT" describe --tags --always 2>/dev/null || echo unknown)"
if [ "$AGAINST_HEAD" = "1" ]; then
  VALIDATED_AGAINST="base HEAD $BASE_DESC ($BASE_HEAD)"
  if [ -n "$(git -C "$BASE_ROOT" status --porcelain)" ]; then
    echo "REFUSING --against-head: base working tree is dirty." >&2
    echo "  Consumers would be tested against a commit that does not exist," >&2
    echo "  so a green result would not be reproducible. Commit first." >&2
    exit 2
  fi
else
  VALIDATED_AGAINST="each consumer's OWN PIN (NOT base HEAD — see --against-head)"
fi
echo "----- validating against: $VALIDATED_AGAINST -----" >&2

# Point a consumer's submodule at base HEAD, run $2, restore. Never leaves the
# submodule moved: restore is registered as a trap before the checkout.
swap_to_base_head() {
  sub_abs="$1"
  orig_sha="$(git -C "$sub_abs" rev-parse HEAD)"
  # Trap INT/TERM/HUP as well as EXIT. An EXIT trap alone is NOT enough: bash
  # does not run it when the shell is killed by a signal, so a `timeout`, a
  # Ctrl-C, or a terminal closing leaves the consumer's submodule moved. That is
  # not hypothetical — it happened here on 2026-09-01, when a 2-minute timeout
  # killed this script mid-run and left a peer's repo pinned at base master.
  # Re-raise after restoring so the caller still sees a signal death.
  # shellcheck disable=SC2064
  trap "git -C '$sub_abs' checkout --quiet --detach '$orig_sha' 2>/dev/null || true" EXIT
  # shellcheck disable=SC2064
  trap "git -C '$sub_abs' checkout --quiet --detach '$orig_sha' 2>/dev/null || true; trap - INT TERM HUP; kill -\$\$ 2>/dev/null" INT TERM HUP
  git -C "$sub_abs" fetch --quiet --no-tags "$BASE_ROOT" HEAD
  git -C "$sub_abs" checkout --quiet --detach FETCH_HEAD
}
restore_submodule() {
  trap - EXIT INT TERM HUP
  git -C "$1" checkout --quiet --detach "$2" 2>/dev/null || true
}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# emit a JSONL envelope: type, ts, consumer, suite, result
envelope() {
  printf '{"type":"consumer-test","ts":"%s","consumer":"%s","suite":"%s","result":"%s"}\n' \
    "$(ts)" "$1" "$2" "$3"
}

pass=0 fail=0 skip=0
fails=()

while IFS=$'\t' read -r name submodulePath testCmd tier dockerOptIn wired localDir; do
  [ -n "$name" ] || continue

  if [ "$wired" != "true" ]; then
    envelope "$name" "$tier" "skip"
    echo "SKIP  $name ($tier) — not yet wired to the submodule" >&2
    skip=$((skip + 1)); continue
  fi

  # Resolve the consumer's working copy. Default is $CONSUMERS_DIR/<name>, but
  # a consumer whose local directory name differs from its registry name sets
  # `localDir` (may use ~ or $HOME). Without this the gate cannot find such a
  # repo and reports SKIP indefinitely while looking green.
  if [ -n "${localDir:-}" ]; then
    # Expand a leading ~ or $HOME ONLY. Deliberately not `eval`: the registry is
    # repo-controlled today, but a path is data and should never be executed,
    # and this also keeps paths containing spaces intact.
    case "$localDir" in
      "~/"*)     repo_dir="$HOME/${localDir#\~/}" ;;
      '$HOME/'*) repo_dir="$HOME/${localDir#\$HOME/}" ;;
      *)         repo_dir="$localDir" ;;
    esac
  else
    repo_dir="$CONSUMERS_DIR/$name"
  fi
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

  # A wired consumer may not have adopted the xrl4 `./test-against-base.sh`
  # contract script yet. Absent script => SKIP "contract pending", NOT a FAIL:
  # otherwise `wired:true` (honest — the submodule IS mounted) would false-RED
  # the gate with exit 127. The instant the consumer commits the contract, this
  # auto-flips to a real PASS/FAIL. (testCmd's first token is the script path.)
  contract_script="${testCmd%% *}"
  if [ ! -x "$repo_dir/$contract_script" ]; then
    envelope "$name" "$tier" "skip"
    echo "SKIP  $name ($tier) — contract '$contract_script' not present (xrl4 adoption pending)" >&2
    skip=$((skip + 1)); continue
  fi

  # Run the consumer contract headlessly. The contract owns exit-code mapping:
  #   0 pass | 1 fail | 2 blocked-needs-human (-> skip).
  sub_abs="$repo_dir/$submodulePath"
  orig_sha=""
  if [ "$AGAINST_HEAD" = "1" ]; then
    # Never mutate a repo someone may be working in. A dirty consumer is a SKIP
    # with a named cause, not a silent swap.
    if [ -n "$(git -C "$repo_dir" status --porcelain 2>/dev/null)" ]; then
      envelope "$name" "$tier" "skip"
      echo "SKIP  $name ($tier) — working copy at $repo_dir is DIRTY; refusing to move its submodule" >&2
      skip=$((skip + 1)); continue
    fi
    orig_sha="$(git -C "$sub_abs" rev-parse HEAD)"
    if [ "$orig_sha" = "$BASE_HEAD" ]; then
      echo "NOTE  $name already pinned at base HEAD — no swap needed" >&2
    else
      echo "SWAP  $name: $submodulePath ${orig_sha:0:7} -> ${BASE_HEAD:0:7} (base HEAD)" >&2
      swap_to_base_head "$sub_abs"
    fi
  fi

  echo "RUN   $name ($tier): $testCmd" >&2
  rc=0
  # WEBCTL_BASE_DIR — the candidate base this run is validating (agreed with
  # cgwc:main and webctl:mgr). A consumer that honours it resolves base from
  # here INSTEAD of its own vendor/base-webctl, which is what lets the gate
  # point a consumer at a candidate without moving anything in its repo.
  # Host-side and project-prefixed on purpose: a bare BASE_DIR is far too
  # generic for a variable crossing a repo boundary. This is NOT a container:
  # value and has nothing to do with the LWC_ wire contract.
  #
  # Exported in BOTH modes so the value is always truthful about what is being
  # validated. The submodule swap above stays as the fallback for consumers
  # that do not honour it yet; once they all do, the swap can go.
  ( cd "$repo_dir" && WEBCTL_BASE_DIR="$BASE_ROOT" eval "$testCmd" ) || rc=$?

  if [ "$AGAINST_HEAD" = "1" ] && [ -n "$orig_sha" ]; then
    restore_submodule "$sub_abs" "$orig_sha"
  fi
  case "$rc" in
    0) envelope "$name" "$tier" "pass"; echo "PASS  $name" >&2; pass=$((pass + 1)) ;;
    2) envelope "$name" "$tier" "skip"; echo "SKIP  $name — needs human (exit 2)" >&2; skip=$((skip + 1)) ;;
    *) envelope "$name" "$tier" "fail"; echo "FAIL  $name (exit $rc)" >&2; fail=$((fail + 1)); fails+=("$name") ;;
  esac
done < <(node "$HERE/read-consumers.mjs")

echo "----- gate summary: pass=$pass skip=$skip fail=$fail -----" >&2
echo "----- validated against: $VALIDATED_AGAINST -----" >&2
if [ "$AGAINST_HEAD" != "1" ]; then
  echo "NOTE: this run says NOTHING about releasing base HEAD. Use --against-head before tagging." >&2
fi
if [ "$fail" -gt 0 ]; then
  echo "BLOCKED: ${fails[*]} failed against this base." >&2
  exit 1
fi
echo "OK: no consumer FAILed (skips do not block)." >&2
exit 0
