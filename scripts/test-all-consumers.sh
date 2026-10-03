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
# --against-head --scratch   ⭐ THE RECOMMENDED PRE-RELEASE ARM. Each wired
#                  consumer is CLONED at its committed HEAD into a throwaway dir,
#                  base's candidate is cloned into the submodule path THERE, and
#                  the contract runs in the clone with a throwaway HOME. The live
#                  working tree is NEVER written. Uncommitted edits are NOT tested
#                  — the gate says so per consumer — and a dirty tree no longer
#                  forces a SKIP. Why: some live trees are what UNATTENDED TIMERS
#                  run from, so an in-place swap let a timer firing inside the gate
#                  window run an untested candidate.
#
# Exit: 0 if no consumer FAILs (skips allowed); 1 if any consumer FAILs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_ROOT="$(cd "$HERE/.." && pwd)"
CONSUMERS_DIR="${WEBCTL_CONSUMERS_DIR:-$HOME/github/CLIAI}"
# WEBCTL_CONSUMERS_FILE overrides the registry (default: base's consumers.jsonc) —
# for the gate's own tests, which must run against fake consumers, never the fleet.

AGAINST_HEAD=0
SCRATCH=0
for arg in "$@"; do
  case "$arg" in
    --against-head) AGAINST_HEAD=1 ;;
    --scratch) SCRATCH=1 ;;
    -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if [ "$SCRATCH" = "1" ] && [ "$AGAINST_HEAD" != "1" ]; then
  # Own-pin mode reads each consumer's mounted vendor/; a scratch clone has none
  # to read without fetching it from the network. Refuse rather than guess.
  echo "--scratch requires --against-head (it builds a clone with base's candidate placed in it)." >&2
  exit 2
fi

# What this run VALIDATED AGAINST — stated up front, because "PASS" alone was
# routinely read as "base is releasable" when it meant "the consumer still works
# against the version it pinned last month" (xrl4).
BASE_HEAD="$(git -C "$BASE_ROOT" rev-parse HEAD)"
BASE_DESC="$(git -C "$BASE_ROOT" describe --tags --always 2>/dev/null || echo unknown)"
if [ "$AGAINST_HEAD" = "1" ]; then
  VALIDATED_AGAINST="base HEAD $BASE_DESC ($BASE_HEAD)"
  [ "$SCRATCH" = "1" ] && VALIDATED_AGAINST="$VALIDATED_AGAINST, in SCRATCH clones of each consumer's committed HEAD"
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

# ── swap-in-flight markers ───────────────────────────────────────────────────
# The --against-head arm deliberately CREATES the dirty-pointer state the
# assertion below treats as a failure. A single sample cannot tell "dirty
# because a swap is in flight" from "dirty and abandoned" — so the arm announces
# itself, and the assertion asks.
#
# The marker carries the swapping process's PID, so liveness answers the
# question deterministically rather than by re-sampling and hoping:
#   marker + live pid  -> a swap is in progress  -> SKIP (busy, not broken)
#   marker + dead pid  -> a swap was ABANDONED   -> FAIL (that IS the incident)
#   no marker          -> dirty from elsewhere   -> FAIL
SWAP_MARKER_DIR="$BASE_ROOT/tmp/swap-in-flight"
swap_marker() { printf '%s/%s' "$SWAP_MARKER_DIR" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_')"; }

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
  mkdir -p "$SWAP_MARKER_DIR"
  marker="$(swap_marker "$2")"
  printf '%s\n' "$$" > "$marker"
  # shellcheck disable=SC2064
  trap "git -C '$sub_abs' checkout --quiet --detach '$orig_sha' 2>/dev/null || true; rm -f '$marker'" EXIT
  # shellcheck disable=SC2064
  trap "git -C '$sub_abs' checkout --quiet --detach '$orig_sha' 2>/dev/null || true; rm -f '$marker'; trap - INT TERM HUP; kill -\$\$ 2>/dev/null" INT TERM HUP
  git -C "$sub_abs" fetch --quiet --no-tags "$BASE_ROOT" HEAD
  git -C "$sub_abs" checkout --quiet --detach FETCH_HEAD
}
restore_submodule() {
  trap - EXIT INT TERM HUP
  git -C "$1" checkout --quiet --detach "$2" 2>/dev/null || true
  [ -n "${3:-}" ] && rm -f "$(swap_marker "$3")"
  return 0
}

# ── scratch mode (--scratch) ─────────────────────────────────────────────────
# ⛔ NEVER SWAP INSIDE A LIVE TREE. Some consumers' live working copies are what
# UNATTENDED TIMERS run from (a janitor every 30 min), so the in-place swap let a
# timer firing inside the gate window run an UNTESTED candidate. Scratch mode
# builds the state the gate needs somewhere nobody else runs from:
#
#   <tmp>/repo        git clone of the live repo, checked out at its HEAD COMMIT
#   <tmp>/repo/<sub>  a clone of BASE_ROOT checked out at BASE_HEAD — a real repo,
#                     NEVER a symlink (symlinked vendors produced false failures here)
#   <tmp>/repo-home   the contract's throwaway HOME
#
# Reads of the live repo run with GIT_OPTIONAL_LOCKS=0: a plain `git status`
# opportunistically REWRITES .git/index to refresh stat data, which is a write.
# The clone uses --no-hardlinks so not even inode link counts change, and both
# clones get an unusable PUSH url so a contract that pushes cannot reach the live
# repo (fetching from it is a read, and stays allowed).
SCRATCH_TMP=""
SCRATCH_ERR=""
scratch_end() {
  trap - EXIT INT TERM HUP
  if [ -n "$SCRATCH_TMP" ]; then
    # a contract may leave read-only dirs (module caches); rm -rf cannot enter them
    chmod -R u+w "${SCRATCH_TMP:?}" 2>/dev/null || true
    rm -rf "${SCRATCH_TMP:?}"
  fi
  SCRATCH_TMP=""
  return 0
}
# $1 live repo dir, $2 the live HEAD commit, $3 submodule path.
# On success: sets SCRATCH_TMP and returns 0 (scratch_end MUST follow).
# On failure: sets SCRATCH_ERR to the step and git's own words; returns 1 with
# nothing left on disk.
scratch_begin() {
  local live="$1" head="$2" sub="$3" dst got log
  SCRATCH_ERR=""
  SCRATCH_TMP="$(mktemp -d "${TMPDIR:-/tmp}/webctl-gate-scratch-XXXXXX")"
  # Registered BEFORE anything is written into it, for the same reason the swap's
  # restore is: an EXIT trap alone does not run when the shell dies by a signal.
  trap 'scratch_end' EXIT
  trap 'scratch_end; trap - INT; kill -INT $$' INT
  trap 'scratch_end; trap - TERM; kill -TERM $$' TERM
  trap 'scratch_end; trap - HUP; kill -HUP $$' HUP
  dst="$SCRATCH_TMP/repo"
  log="$SCRATCH_TMP/setup.log"
  mkdir -p "$SCRATCH_TMP/repo-home"
  if ! git clone -q --no-hardlinks --no-checkout -- "$live" "$dst" >"$log" 2>&1; then
    SCRATCH_ERR="git clone of the live repo failed: $(tail -n 2 "$log" | tr '\n' ' ')"
  elif ! git -C "$dst" cat-file -e "$head^{commit}" 2>/dev/null \
       && ! git -C "$dst" fetch -q --no-tags -- "$live" "$head" >"$log" 2>&1; then
    SCRATCH_ERR="live HEAD ${head:0:7} is not in the clone and could not be fetched: $(tail -n 2 "$log" | tr '\n' ' ')"
  elif ! git -C "$dst" checkout -q --detach "$head" >"$log" 2>&1; then
    SCRATCH_ERR="checkout of ${head:0:7} in the clone failed: $(tail -n 2 "$log" | tr '\n' ' ')"
  else
    git -C "$dst" remote set-url --push origin "no-push://scratch-clone-of-a-live-tree" 2>/dev/null || true
    # The gitlink checks out as an empty dir; replace it with base's candidate.
    rm -rf "${dst:?}/${sub:?}"
    mkdir -p "$(dirname "$dst/$sub")"
    if ! git clone -q --no-hardlinks --no-checkout -- "$BASE_ROOT" "$dst/$sub" >"$log" 2>&1; then
      SCRATCH_ERR="git clone of base into '$sub' failed: $(tail -n 2 "$log" | tr '\n' ' ')"
    elif ! git -C "$dst/$sub" cat-file -e "$BASE_HEAD^{commit}" 2>/dev/null \
         && ! git -C "$dst/$sub" fetch -q --no-tags -- "$BASE_ROOT" HEAD >"$log" 2>&1; then
      SCRATCH_ERR="base HEAD ${BASE_HEAD:0:7} could not be fetched into '$sub': $(tail -n 2 "$log" | tr '\n' ' ')"
    elif ! git -C "$dst/$sub" checkout -q --detach "$BASE_HEAD" >"$log" 2>&1; then
      SCRATCH_ERR="checkout of base ${BASE_HEAD:0:7} in '$sub' failed: $(tail -n 2 "$log" | tr '\n' ' ')"
    else
      git -C "$dst/$sub" remote set-url --push origin "no-push://scratch-clone-of-base" 2>/dev/null || true
    fi
  fi
  rm -f "$log"
  if [ -z "$SCRATCH_ERR" ]; then
    # ⛔ Assert the VALUES, not that the commands exited 0.
    got="$(git -C "$dst" rev-parse HEAD 2>/dev/null || echo none)"
    [ "$got" = "$head" ] || SCRATCH_ERR="the clone is at $got, not the live HEAD $head"
    got="$(git -C "$dst/$sub" rev-parse HEAD 2>/dev/null || echo none)"
    [ -z "$SCRATCH_ERR" ] && [ "$got" != "$BASE_HEAD" ] \
      && SCRATCH_ERR="'$sub' in the clone is at $got, not base HEAD $BASE_HEAD"
  fi
  if [ -n "$SCRATCH_ERR" ]; then
    scratch_end
    return 1
  fi
  return 0
}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# emit a JSONL envelope: type, ts, consumer, suite, result
# Minimal JSON string escaping for a reason carried into the envelope.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\t' ' ' | tr -d '\000-\037'
}

# $4 = OPTIONAL reason. Emitted only when non-empty, so the envelope never
# carries an empty string that reads like "no reason was given" when in fact
# none was asked for.
envelope() {
  if [ -n "${4:-}" ]; then
    printf '{"type":"consumer-test","ts":"%s","consumer":"%s","suite":"%s","result":"%s","reason":"%s"}\n' \
      "$(ts)" "$1" "$2" "$3" "$(json_escape "$4")"
  else
    printf '{"type":"consumer-test","ts":"%s","consumer":"%s","suite":"%s","result":"%s"}\n' \
      "$(ts)" "$1" "$2" "$3"
  fi
}

pass=0 fail=0 skip=0 stale=0
probe_ok=0 probe_bad=0 probe_none=0
declare -a probe_fails=()
fails=()
scratch_n=0
declare -a untested_live=()

while IFS=$'\t' read -r name submodulePath testCmd tier dockerOptIn wired localDir; do
  [ -n "$name" ] || continue

  if [ "$wired" != "true" ]; then
    # ⛔ IS THAT `wired:false` STILL TRUE? Nobody re-examines it.
    #
    # A `wired:true` is EARNED — this lane verifies the mount, the tag and the
    # shim before flipping one. A `wired:false` is never re-checked, so the
    # registry is audited in ONE DIRECTION ONLY: its optimistic claims are
    # tested and its pessimistic ones rot silently.
    #
    # Measured 2026-09-23: claude-chrome-extension-webctl was marked unwired
    # while its submodule was mounted and pinned to a real tag. The gate printed
    # "not yet wired to the submodule" — a FALSE STATEMENT — and that line is
    # indistinguishable in the summary from a genuine placeholder. So the one
    # wired lane the pre-release arm could not see looked exactly like the five
    # lanes it is not supposed to see.
    if [ -n "${localDir:-}" ]; then
      case "$localDir" in
        "~/"*)     stale_dir="$HOME/${localDir#\~/}" ;;
        '$HOME/'*) stale_dir="$HOME/${localDir#\$HOME/}" ;;
        *)         stale_dir="$localDir" ;;
      esac
    else
      stale_dir="$CONSUMERS_DIR/$name"
    fi
    if [ -d "$stale_dir/${submodulePath:-vendor/base-webctl}" ]; then
      pinned="$(git -C "$stale_dir/${submodulePath}" describe --tags --always 2>/dev/null || echo unknown)"
      echo "⚠ STALE REGISTRY  $name — marked wired:false, but $submodulePath IS mounted (at $pinned)." >&2
      echo "                  The gate is reporting a lane it could be validating as absent." >&2
      envelope "$name" "$tier" "skip" "STALE registry entry: wired:false but submodule mounted at $pinned"
      stale=$((stale + 1)); skip=$((skip + 1)); continue
    fi
    envelope "$name" "$tier" "skip" "not yet wired to the submodule"
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
    envelope "$name" "$tier" "skip" "repo not present at $repo_dir"
    echo "SKIP  $name ($tier) — repo not present at $repo_dir" >&2
    skip=$((skip + 1)); continue
  fi

  # ── SCRATCH MODE: judge the COMMITTED state; read the live tree, never write it ──
  # What survives of the in-place checks when what runs is the HEAD commit:
  #   * "submodule missing in working copy" -> is a gitlink DECLARED at HEAD?
  #   * "dirty submodule pointer -> FAIL"   -> the live checkout no longer decides
  #     what runs (the candidate replaces it), so a mispinned live tree is REPORTED,
  #     loudly, but it cannot make this result describe an undeclared base. What
  #     stays meaningful is the committed entry itself: it must be a gitlink. A
  #     path committed as a plain directory declares no pin at all -> FAIL.
  #   * "dirty tree -> SKIP"                -> committed state cannot be dirty; the
  #     uncommitted changes are counted and named as NOT tested instead.
  live_head="" tested_note="" live_dirty=0
  if [ "$SCRATCH" = "1" ]; then
    live_head="$(GIT_OPTIONAL_LOCKS=0 git -C "$repo_dir" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null || true)"
    if [ -z "$live_head" ]; then
      envelope "$name" "$tier" "skip" "no HEAD commit at $repo_dir — nothing committed to test"
      echo "SKIP  $name ($tier) — no HEAD commit at $repo_dir; scratch mode tests committed state only" >&2
      skip=$((skip + 1)); continue
    fi
    gl_entry="$(GIT_OPTIONAL_LOCKS=0 git -C "$repo_dir" ls-tree "$live_head" -- "$submodulePath" 2>/dev/null || true)"
    gl_mode="$(printf '%s' "$gl_entry" | awk '{print $1}')"
    gl_type="$(printf '%s' "$gl_entry" | awk '{print $2}')"
    if [ -z "$gl_entry" ]; then
      envelope "$name" "$tier" "skip" "submodule '$submodulePath' not declared in committed HEAD ${live_head:0:7} at $repo_dir"
      echo "SKIP  $name ($tier) — submodule '$submodulePath' not declared in committed HEAD ${live_head:0:7} at $repo_dir" >&2
      skip=$((skip + 1)); continue
    fi
    if [ "$gl_mode" != "160000" ]; then
      envelope "$name" "$tier" "fail" "UNDECLARED: '$submodulePath' is committed at ${live_head:0:7} as a $gl_type (mode $gl_mode), not a gitlink"
      {
        echo "FAIL  $name ($tier) — UNDECLARED: '$submodulePath' is committed at ${live_head:0:7} as a $gl_type (mode $gl_mode), not a gitlink."
        echo "        A sibling cloning this commit gets no declared pin; the gate has nothing to swap."
      } >&2
      fail=$((fail + 1)); fails+=("$name"); continue
    fi
    live_dirty="$(GIT_OPTIONAL_LOCKS=0 git -C "$repo_dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    live_ptr="$(GIT_OPTIONAL_LOCKS=0 git -C "$repo_dir" submodule status 2>/dev/null | grep -E '^[+U]' || true)"
    if [ "${live_dirty:-0}" -gt 0 ]; then
      tested_note="tested ${live_head:0:7} (live tree has $live_dirty uncommitted change(s) — NOT tested)"
    else
      tested_note="tested ${live_head:0:7} (live tree clean)"
    fi
    if [ -n "$live_ptr" ]; then
      {
        echo "NOTE  $name — the LIVE tree's submodule pointer is DIRTY (checkout != index):"
        echo "        raw: $live_ptr"
        echo "        Not what this run tests (the committed gitlink is), but whatever runs FROM"
        echo "        that live tree runs an undeclared base. Fix: git -C $repo_dir submodule update --init --recursive"
      } >&2
    fi
  fi

  if [ "$SCRATCH" = "0" ] && [ ! -d "$repo_dir/$submodulePath" ]; then
    envelope "$name" "$tier" "skip" "submodule '$submodulePath' missing in working copy"
    echo "SKIP  $name ($tier) — submodule '$submodulePath' missing in working copy" >&2
    skip=$((skip + 1)); continue
  fi

  # ⚠ ORDER IS LOAD-BEARING — POINTER CHECK MUST COME FIRST.
  # A dirty submodule pointer ALSO shows up in `git status --porcelain`, so the
  # dirty-TREE skip below would swallow every mispin and report it as "busy".
  # That silently downgrades a FAIL to a SKIP: the one finding this gate exists
  # to surface, hidden by the check meant to reduce noise. Caught by a control
  # on 2026-09-02, which is the only reason it is not still that way.
  # ⛔ DIRTY SUBMODULE POINTER -> FAIL, never SKIP.
  #
  # `git submodule status` prefixes a line with `+` when the CHECKED-OUT commit
  # differs from the one the repo's INDEX declares, and `U` on a conflict. Such
  # a consumer is not "not ready to test": it is a consumer whose test result
  # MEANS SOMETHING OTHER THAN WHAT IT SAYS — it exercised a base the repo does
  # not declare. That is the one category this gate exists to distinguish, so it
  # is red, not a skip.
  #
  # It is invisible without this check: top-level `git status` stays clean, the
  # tests pass, the counts match. Three lanes have each had to remember it
  # separately, which is the condition where a mechanism beats a discipline.
  # Two real instances in two days — one from a killed shell skipping its EXIT
  # trap, one from ordinary branch-switching without `git submodule update` and
  # no crash at all. A signal trap catches the first and cannot catch the
  # second; this catches the state however it arose.
  #
  # `-` (uninitialised) is deliberately NOT matched — that is the SKIP path
  # handled above. Pattern positive-controlled against synthetic `+`/`U` lines
  # before being trusted, because a zero from a broken pattern is
  # indistinguishable from a zero from a clean tree.
  dirty_ptr=""
  [ "$SCRATCH" = "0" ] && dirty_ptr="$(git -C "$repo_dir" submodule status 2>/dev/null | grep -E '^[+U]' || true)"
  if [ -n "$dirty_ptr" ]; then
    # Is this OUR OWN arm mid-swap? A live pid in the marker says a swap is in
    # progress; a dead one says it was abandoned, which is the actual incident.
    mk="$(swap_marker "$name")"
    if [ -f "$mk" ] && kill -0 "$(cat "$mk" 2>/dev/null)" 2>/dev/null; then
      envelope "$name" "$tier" "skip" "swap in flight by pid $(cat "$mk"); pointer dirty BY DESIGN"
      echo "SKIP  $name ($tier) — swap in flight by pid $(cat "$mk"); pointer is dirty BY DESIGN, not abandoned" >&2
      skip=$((skip + 1)); continue
    fi
    declared="$(git -C "$repo_dir" ls-files -s "$submodulePath" 2>/dev/null | awk '{print $2}')"
    actual="$(git -C "$repo_dir/$submodulePath" rev-parse HEAD 2>/dev/null || echo unknown)"
    envelope "$name" "$tier" "fail" "DIRTY SUBMODULE POINTER: index ${declared:-unknown} != checkout ${actual}"
    {
      echo "FAIL  $name ($tier) — DIRTY SUBMODULE POINTER: checkout disagrees with the index."
      echo "        declared (index): ${declared:-unknown}"
      echo "        actual (HEAD):    ${actual}"
      echo "        raw: $dirty_ptr"
      echo "        Any result from this checkout would describe a base the repo does not declare."
      [ -f "$mk" ] && echo "        NOTE: a stale swap marker exists (pid $(cat "$mk" 2>/dev/null) is gone) — an ABANDONED pre-release swap."
      echo "        Fix: git -C $repo_dir submodule update --init --recursive"
    } >&2
    fail=$((fail + 1)); fails+=("$name"); continue
  fi

  # ── DIRTY WORKING TREE -> SKIP, IN EVERY MODE ──────────────────────────────
  # A gate reading a tree that is CHANGING UNDERNEATH IT produces a result about
  # no particular state: clean on one run, exit 1 on the next, describing
  # neither. Observed on an actively-edited consumer 2026-09-02.
  #
  # SKIP and not FAIL, because the consumer is not broken — it is BUSY, and
  # those are different findings. But never SILENTLY: the reason names the file
  # count, so the owning lane can see why it vanished from the gate rather than
  # discovering it as an absence. (This also subsumes the --against-head-only
  # refusal to move someone's submodule while they edit.)
  dirty_files=0
  [ "$SCRATCH" = "0" ] && dirty_files="$(git -C "$repo_dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${dirty_files:-0}" -gt 0 ]; then
    envelope "$name" "$tier" "skip" "working tree DIRTY ($dirty_files files) — consumer is mid-edit"
    echo "SKIP  $name ($tier) — working tree DIRTY ($dirty_files files) at $repo_dir;" >&2
    echo "        a result would describe no particular state, and --against-head will not move a submodule someone is editing" >&2
    skip=$((skip + 1)); continue
  fi

  # A wired consumer may not have adopted the xrl4 `./test-against-base.sh`
  # contract script yet. Absent script => SKIP "contract pending", NOT a FAIL:
  # otherwise `wired:true` (honest — the submodule IS mounted) would false-RED
  # the gate with exit 127. The instant the consumer commits the contract, this
  # auto-flips to a real PASS/FAIL. (testCmd's first token is the script path.)
  #
  # In scratch mode the clone is built FIRST, so this check — like everything
  # after it — reads the COMMITTED contract: one that exists only as an
  # uncommitted file in the live tree is not what a sibling's clone would run.
  run_dir="$repo_dir"
  run_home=""
  if [ "$SCRATCH" = "1" ]; then
    if ! scratch_begin "$repo_dir" "$live_head" "$submodulePath"; then
      # ⇒ FAIL, not SKIP: a wired consumer the gate could not build is a consumer
      # it did not validate, and a skip never blocks.
      envelope "$name" "$tier" "fail" "SCRATCH SETUP FAILED: $SCRATCH_ERR"
      echo "FAIL  $name ($tier) — SCRATCH SETUP FAILED: $SCRATCH_ERR" >&2
      fail=$((fail + 1)); fails+=("$name"); continue
    fi
    run_dir="$SCRATCH_TMP/repo"
    run_home="$SCRATCH_TMP/repo-home"
    echo "SCRATCH $name: clone of $repo_dir at ${live_head:0:7}; $submodulePath = base ${BASE_HEAD:0:7}; live tree untouched" >&2
    echo "        $tested_note" >&2
  fi
  contract_script="${testCmd%% *}"
  if [ ! -x "$run_dir/$contract_script" ]; then
    if [ "$SCRATCH" = "1" ]; then scratch_end; fi
    envelope "$name" "$tier" "skip" "contract '$contract_script' not present (xrl4 adoption pending)"
    echo "SKIP  $name ($tier) — contract '$contract_script' not present${live_head:+ in committed HEAD ${live_head:0:7}} (xrl4 adoption pending)" >&2
    skip=$((skip + 1)); continue
  fi

  # Run the consumer contract headlessly. The contract owns exit-code mapping:
  #   0 pass | 1 fail | 2 blocked-needs-human (-> skip).
  sub_abs="$repo_dir/$submodulePath"
  orig_sha=""
  swapped_now=0
  if [ "$SCRATCH" = "1" ]; then
    # Nothing is swapped in place; the candidate already sits in the clone. It
    # still IS a swap from the contract's point of view whenever the committed
    # gitlink names another commit — so WEBCTL_GATE_SWAPPED says exactly that.
    declared_at_swap="$(git -C "$run_dir" ls-tree HEAD "$submodulePath" 2>/dev/null | awk '{print $3}')"
    if [ "$declared_at_swap" = "$BASE_HEAD" ]; then
      echo "NOTE  $name already declares base HEAD — no swap in the clone" >&2
    else
      echo "SWAP  $name (in the scratch clone): $submodulePath declared ${declared_at_swap:0:7} -> ${BASE_HEAD:0:7} (base HEAD)" >&2
      swapped_now=1
    fi
  elif [ "$AGAINST_HEAD" = "1" ]; then
    orig_sha="$(git -C "$sub_abs" rev-parse HEAD)"
    if [ "$orig_sha" = "$BASE_HEAD" ]; then
      echo "NOTE  $name already pinned at base HEAD — no swap needed" >&2
    else
      declared_at_swap="$(git -C "$repo_dir" ls-tree HEAD "$submodulePath" 2>/dev/null | awk '{print $3}')"
      echo "SWAP  $name: $submodulePath ${orig_sha:0:7} -> ${BASE_HEAD:0:7} (base HEAD)" >&2
      echo "      declares ${declared_at_swap:0:7} — a contract naming its pin from the WORKTREE" >&2
      echo "      will report the candidate as its pin while swapped. WEBCTL_DECLARED_PIN carries the truth." >&2
      swap_to_base_head "$sub_abs" "$name"
      swapped_now=1
    fi
  fi

  # ⭐ GATE-EXERCISE THE HARNESS'S NO-VERDICT ARM, IN THE ONLY PLACE THE STATE
  # EXISTS ON DEMAND. `contract-harness.mjs pin` must DECLINE a verdict while a
  # candidate is checked out, because a candidate is not tagged. That arm was
  # previously proven only against a FORGED fixture — a hand-built
  # disagreement — which shows the arm CAN fire, not that it fires here.
  #
  # ⛔ WEBCTL_GATE_SWAPPED IS THE POINT. The probe must not decide for itself
  # whether a swap happened by re-computing `declared != worktree`, because that
  # is the same comparison it is testing — a precondition and an assertion
  # reading one input cannot disagree. The gate KNOWS it swapped, so the gate
  # says so, and the probe's claim becomes falsifiable.
  #
  # ⚠ A probe failure is BASE's defect, not the consumer's. Counted separately
  # and attributed to the harness, because folding it into the consumer's column
  # would blame a lane for a candidate's bug.
  if [ "${swapped_now:-0}" = "1" ]; then
    # In scratch mode the probe runs IN THE CLONE — the swap state exists there,
    # and nowhere in the live tree.
    probe_declared="$(git -C "$run_dir" ls-tree HEAD "$submodulePath" 2>/dev/null | awk '{print $3}')"
    probe_out=""
    set +e
    probe_out="$(cd "$run_dir" \
      && { [ -z "$run_home" ] || export HOME="$run_home"; } \
      && WEBCTL_GATE_SWAPPED=1 WEBCTL_DECLARED_PIN="${probe_declared:-}" \
         node "$BASE_ROOT/scripts/contract-harness.mjs" gate-probe \
           --repo "$run_dir" --sub "$submodulePath" 2>&1)"
    probe_rc=$?
    set -e
    case "$probe_rc" in
      0) probe_ok=$((probe_ok + 1))
         echo "PROBE $name — harness declined a verdict in the real swap window ✓" >&2 ;;
      2) probe_none=$((probe_none + 1))
         echo "PROBE $name — NO VERDICT from the probe itself; it could not be exercised:" >&2
         echo "      $(printf '%s' "$probe_out" | tail -n 1)" >&2 ;;
      *) probe_bad=$((probe_bad + 1)); probe_fails+=("$name")
         echo "PROBE $name — ⛔ HARNESS DEFECT (exit $probe_rc). This is BASE's bug, not $name's:" >&2
         printf '      %s\n' "$probe_out" >&2 ;;
    esac
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
  # The contract's output is captured as well as shown, so that on a no-verdict
  # exit the gate can quote the consumer's OWN stated reason instead of naming a
  # cause it was never told (see the exit-2 note below).
  #
  # ⛔ PIPE-STATUS TRAP: in `cmd | tee`, `$?` is TEE's status, which is almost
  # always 0 — that would report every consumer, including a failing one, as
  # PASS. ${PIPESTATUS[0]} is the contract's own. `set +e` because a failing
  # contract is an expected outcome here, not a reason to abort the gate.
  #
  # Consumer output is merged onto STDERR. That is a DELIBERATE change, not a
  # side effect: gate chatter already lives on stderr, and this leaves stdout as
  # pure JSONL for the lszd machine interface, which consumer stdout used to
  # interleave with.
  run_log="$(mktemp "${TMPDIR:-/tmp}/webctl-gate-XXXXXX")"
  set +e
  # ⭐ WEBCTL_DECLARED_PIN — what the consumer DECLARES, from its committed
  # gitlink, handed over because the swap makes it unknowable from inside.
  #
  # ⛔ THE DEFECT THIS CLOSES, AND IT IS WORST HERE. --against-head checks the
  # submodule WORKTREE out at the candidate. A contract that names its pin with
  # `git -C vendor/base-webctl describe` is then reading the worktree, so it
  # prints "green against v0.13.1" FROM A REPO THAT DECLARES v0.5.0 — a true
  # sentence about the wrong subject. Measured across the fleet: 4 of 5
  # contracts name their pin from the worktree.
  #
  # ⇒ A checked-out submodule is an INTENTION; a committed gitlink is a PIN.
  # Only the second is what a sibling cloning the repo gets. The gate creates
  # the window in which they differ, so the gate is what should supply the
  # declaration rather than leaving each contract to compute it — during the
  # one moment it cannot.
  declared_pin="$(git -C "$run_dir" ls-tree HEAD "$submodulePath" 2>/dev/null | awk '{print $3}')"
  # In scratch mode the base under test is the clone AT the submodule path (a
  # fixed commit, BASE_HEAD), and HOME is the throwaway one.
  run_base_dir="$BASE_ROOT"
  [ "$SCRATCH" = "1" ] && run_base_dir="$run_dir/$submodulePath"
  # ⭐ WEBCTL_GATE_SWAPPED — the gate's OWN knowledge of whether it swapped this
  # consumer, handed to the contract and everything it runs (unit suites included):
  #   "1" the gate swapped the submodule to the candidate · "0" the gate ran, no
  #   swap · unset: not running under the gate at all.
  # ⛔ Added after a lane's UNIT tests derived "the pin" from the submodule worktree
  # and so failed against EVERY release candidate — blocking v0.17.0. Their contract
  # layer handled the swap correctly; the unit suite had no way to know. ⇒ A test
  # should not have to re-derive "am I under a swap?" from the very comparison it is
  # testing; the gate knows, so the gate says. Same reason gate-probe needed it.
  ( cd "$run_dir" \
      && { [ -z "$run_home" ] || export HOME="$run_home"; } \
      && WEBCTL_BASE_DIR="$run_base_dir" \
         WEBCTL_DECLARED_PIN="${declared_pin:-}" \
         WEBCTL_GATE_SWAPPED="${swapped_now:-0}" \
         eval "$testCmd" ) 2>&1 | tee "$run_log" >&2
  rc=${PIPESTATUS[0]}
  set -e

  # The consumer's last word, used as the reason it declined a verdict.
  #
  # ⛔ The TRAILING BLOCK, not the last line. A contract that wraps its reason
  # over two lines ("...but there is no / unit suite yet.") was being quoted
  # from its tail alone, which produced a sentence FRAGMENT presented as the
  # whole reason — the gate mangling the very words it exists to relay
  # faithfully. Takes the last contiguous run of non-blank lines, capped, so a
  # failing contract's stack trace cannot flood the summary either.
  reason="$(awk 'BEGIN{n=0} {if ($0 ~ /^[[:space:]]*$/) {n=0; next} lines[n++]=$0; if (n>3) {for(i=0;i<n-1;i++) lines[i]=lines[i+1]; n=3}}
                 END{for(i=0;i<n;i++) printf "%s ", lines[i]}' "$run_log" \
             | sed -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//' | cut -c1-300)"

  # ⛔ A GREEN EXIT IS NOT A GREEN RUN. node:test lets a describe() that throws while
  # REGISTERING vanish: it prints `not ok N - <suite>` (spec: "✖ failing tests:"), then
  # "# fail 0", and EXITS 0 (node v22, reproduced; found by `chatgpt` — a fresh clone
  # ran 6 fewer tests than the live tree, both "green"). The gate cannot make a contract
  # use base's strict reporter, but it reads every contract's output: a failure line in
  # a run that exited 0 is a FAIL, named. TODO/SKIP lines are not failures.
  if [ "$rc" = "0" ]; then
    # 1. The strict reporter's OWN verdict, when the contract used it, is authoritative: it
    #    reads node's events, where TODO status is exact. A failure verdict in a run that
    #    exited 0 means the contract swallowed it.
    strict_bad="$(grep -E '^STRICT: ([1-9][0-9]* failure event|ZERO tests ran|[1-9][0-9]* test file\(s\) registered ZERO)' "$run_log" | head -1 || true)"
    strict_ok="$(grep -cE '^STRICT: 0 failure events' "$run_log" || true)"
    hidden="$(grep -E '^[[:space:]]*not ok [0-9]+ ' "$run_log" | grep -viE '#[[:space:]]*(TODO|SKIP)' || true)"
    spec_fail=""
    if [ -z "$strict_bad" ] && [ "${strict_ok:-0}" = "0" ]; then
      # 2. Spec without the strict reporter. ⚠ Spec CANNOT mark a TODO reliably: a todo with
      #    a reason prints "# <reason>" INSTEAD of "# TODO" (measured on ccew's by-design
      #    todos — a second false red). So compare COUNTS: more "✖" entries under "failing
      #    tests:" than the summary's "ℹ todo N" means at least one is a real failure or a
      #    vanished suite.
      entries="$(awk '/^✖ failing tests:/{f=1; next} f && /^✖ /{n++} END{print n+0}' "$run_log")"
      todos="$(awk '/^ℹ todo [0-9]+/{t+=$3} END{print t+0}' "$run_log")"
      [ "$entries" -gt "$todos" ] && spec_fail="$entries failing-tests entries, $todos todo"
    fi
    if [ -n "$strict_bad" ] || [ -n "$hidden" ] || [ -n "$spec_fail" ]; then
      n="$(printf '%s\n' "$hidden" | grep -c 'not ok' || true)"
      first="$(printf '%s\n' "${strict_bad:-$hidden}" | head -2 | sed -e 's/^[[:space:]]*//' | tr '\n' ';' | cut -c1-160)"
      rc=1
      reason="exit 0, but the run REPORTED FAILURES (${n} TAP 'not ok'${spec_fail:+; spec: $spec_fail}${strict_bad:+; strict reporter}): ${first:-see log}. A describe() that throws while registering vanishes from the counts — use base's scripts/run-tests-strict.mjs"
    fi
  fi
  rm -f "$run_log"

  if [ "$SCRATCH" = "1" ]; then
    scratch_end
    scratch_n=$((scratch_n + 1))
    if [ "${live_dirty:-0}" -gt 0 ]; then untested_live+=("$name ($live_dirty)"); fi
  elif [ "$AGAINST_HEAD" = "1" ] && [ -n "$orig_sha" ]; then
    restore_submodule "$sub_abs" "$orig_sha" "$name"
  fi
  case "$rc" in
    0) envelope "$name" "$tier" "pass"; echo "PASS  $name${tested_note:+ — $tested_note}" >&2; pass=$((pass + 1)) ;;
    # ⛔ exit 2 is NO VERDICT, not "needs human". The gate used to assert the
    # latter, which is a cause it was never told: the consumer returns a NUMBER,
    # and the reason is the consumer's to state. Two states were wearing one
    # label (t2wf) — and a single consumer legitimately holds both: gemini's
    # contract exits 2 for "no unit suite yet" (nobody is blocked) AND for
    # "needs docker plus a human sign-in" (somebody is). A third exit code
    # cannot separate those, because they come from the same script; only the
    # consumer's own words can. So the gate quotes it rather than guessing.
    2) envelope "$name" "$tier" "skip" "${reason:-}"
       echo "SKIP  $name — no verdict (exit 2): ${reason:-consumer stated no reason}" >&2
       if [ -n "$tested_note" ]; then echo "        $tested_note" >&2; fi
       skip=$((skip + 1)) ;;
    *) envelope "$name" "$tier" "fail" "${reason:-}"
       echo "FAIL  $name (exit $rc): ${reason:-no reason stated}" >&2
       if [ -n "$tested_note" ]; then echo "        $tested_note" >&2; fi
       fail=$((fail + 1)); fails+=("$name") ;;
  esac
done < <(node "$HERE/read-consumers.mjs" ${WEBCTL_CONSUMERS_FILE:+"$WEBCTL_CONSUMERS_FILE"})

echo "----- gate summary: pass=$pass skip=$skip fail=$fail -----" >&2
if [ "$SCRATCH" = "1" ]; then
  echo "----- scratch: $scratch_n consumer(s) run from a clone of their committed HEAD; no live tree was written -----" >&2
  if [ "${#untested_live[@]}" -gt 0 ]; then
    # Named, because "tested" is about a commit and these lanes have work past it.
    echo "⚠ uncommitted live changes NOT tested: ${untested_live[*]}" >&2
  fi
fi
if [ "$stale" -gt 0 ]; then
  # Counted SEPARATELY. Folded into `skip` it is invisible, which is the whole
  # defect: a lane the gate could validate, reported as one it cannot.
  echo "⚠ $stale STALE REGISTRY ENTRIES — lanes marked unwired whose submodule is mounted." >&2
  echo "  These are NOT covered by --against-head, and the summary above counts them as skips." >&2
fi
if [ "$AGAINST_HEAD" = "1" ]; then
  echo "----- harness gate-probe: ok=$probe_ok defect=$probe_bad no-verdict=$probe_none -----" >&2
  if [ "$probe_ok" -eq 0 ] && [ "$probe_bad" -eq 0 ]; then
    # ⚠ NOT silence. Zero exercises means the arm went UNTESTED this run — every
    # consumer was already at base HEAD, or none was wired — and "no defect
    # found" over zero attempts is the shape this whole harness exists to stop.
    echo "⚠ the no-verdict arm was NOT EXERCISED this run (no consumer was swapped)." >&2
    echo "  That is UNTESTED, not passed." >&2
  fi
fi
echo "----- validated against: $VALIDATED_AGAINST -----" >&2
if [ "$AGAINST_HEAD" != "1" ]; then
  echo "NOTE: this run says NOTHING about releasing base HEAD. Use --against-head before tagging." >&2
fi
if [ "$probe_bad" -gt 0 ]; then
  # ⇒ Blocks the release. A harness that answers wrongly under the gate makes
  # every contract's pin verdict untrustworthy at exactly the moment it matters.
  echo "BLOCKED: the harness gate-probe found a DEFECT IN BASE while validating ${probe_fails[*]}." >&2
  echo "  This is not a consumer failure. Fix the harness before tagging." >&2
  exit 1
fi
if [ "$fail" -gt 0 ]; then
  echo "BLOCKED: ${fails[*]} failed against this base." >&2
  exit 1
fi
echo "OK: no consumer FAILed (skips do not block)." >&2
exit 0
