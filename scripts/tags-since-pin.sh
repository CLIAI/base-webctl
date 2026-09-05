#!/usr/bin/env bash
# tags-since-pin.sh — "has base tagged past my pin, and does any tag since
# touch a module I consume?"
#
# ⛔ THE DEFECT THIS EXISTS TO PREVENT
#
# A consumer that wants to know when an upstream blocker lifts writes a guard.
# The guard reads vendor/base-webctl — the PINNED copy — which cannot change
# until someone bumps the pin. So it can only fire at the moment of the bump:
# it confirms a decision already taken instead of prompting it. base v0.8.0 sat
# unnoticed in a consumer for three days that way.
#
#   ⇒ Watch WHERE X HAPPENS (base's refs), not where X ARRIVES (your snapshot).
#
# This ships in base rather than in each consumer for one reason: a consumer
# writing it locally reaches for the submodule, because that is what is in front
# of them — they re-derive the blind spot along with the check. (linkedin's
# argument; webctl:mgr and this lane concur.)
#
# ⚠ IT STILL RUNS FROM A VENDORED COPY. An old pin ships an old script. That is
# tolerable — the logic below is about refs, not about base's contents, so it
# ages slowly — but it is a real limit, not an oversight. `--remote-script` is
# deliberately NOT provided: fetching and executing a script from a remote is a
# supply-chain hazard nobody asked for.
#
# ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────
# It does not grep base's source for a marker string. A regex over someone
# else's implementation re-derives their semantics from the text they happened
# to write: the watch that prompted this tested for two strings that BOTH
# survive the commit that was supposed to clear them, so it was decorative from
# the day it was written. Path-level change detection is structural — it asks
# git what moved, not what the source looks like.
#
# ── SOFT BY DEFAULT ────────────────────────────────────────────────────────────
# Exit 0 even when there is news. A watch must not go red because someone else
# did something correct; upstream shipping a release is not your repo breaking.
# Pass --exit-code to opt into 10-on-news for a job that should act.
#
# Exit: 0 nothing to report (or news, without --exit-code) | 10 news, with
#       --exit-code | 1 the probe itself could not run | 2 bad usage.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="${WEBCTL_BASE_DIR:-$(cd "$HERE/.." && pwd)}"

PIN=""; UNTIL=""; OFFLINE=0; EXIT_CODE=0; SELF_TEST=0; JSON=0
MODULES=()

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'USAGE'

Usage: tags-since-pin.sh [options]

  --module PATH     module to watch, repeated (e.g. --module lib/cdp-client.js)
                    default: every path under lib/
  --pin REF         pin to compare from (default: base checkout's HEAD)
  --until REF       upper bound; without it, every tag newer than the pin
  --offline         do not fetch — report from refs already present
  --exit-code       exit 10 when there is news (default: always 0)
  --json            emit a JSONL envelope as well as the human report
  --self-test       run the immutable historical controls and exit
  -h, --help        this text
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --module) MODULES+=("${2:?--module needs a path}"); shift 2 ;;
    --pin) PIN="${2:?--pin needs a ref}"; shift 2 ;;
    --until) UNTIL="${2:?--until needs a ref}"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    --exit-code) EXIT_CODE=1; shift ;;
    --json) JSON=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ ${#MODULES[@]} -gt 0 ] || MODULES=("lib/")

git_base() { git -C "$BASE_DIR" "$@"; }

[ -d "$BASE_DIR/.git" ] || [ -f "$BASE_DIR/.git" ] || {
  echo "FAIL: $BASE_DIR is not a git checkout of base — the probe cannot run." >&2
  echo "      (A probe that cannot reach its subject must say so, not report 'no news'.)" >&2
  exit 1
}

# ── the report ────────────────────────────────────────────────────────────────
# $1 pin  $2 until-or-empty ; prints newer tags and which modules they touch.
# Returns 0 = no news, 10 = news. Never fetches; callers decide that.
report() {
  local pin="$1" upto="${2:-}" newer=() t news=0
  local pin_sha; pin_sha="$(git_base rev-parse "$pin^{commit}")"

  # A tag is NEWER when the pin is its ancestor and it is not the pin itself.
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    local tsha; tsha="$(git_base rev-parse "$t^{commit}")"
    [ "$tsha" = "$pin_sha" ] && continue
    git_base merge-base --is-ancestor "$pin_sha" "$tsha" 2>/dev/null || continue
    if [ -n "$upto" ]; then
      local usha; usha="$(git_base rev-parse "$upto^{commit}")"
      git_base merge-base --is-ancestor "$tsha" "$usha" 2>/dev/null || continue
    fi
    newer+=("$t")
  done < <(git_base tag -l 'v*' | sort -V)

  if [ ${#newer[@]} -eq 0 ]; then
    echo "up to date: no tag newer than $pin${upto:+ (up to $upto)}"
    return 0
  fi

  echo "NEWER TAGS since $pin${upto:+ (up to $upto)}: ${newer[*]}"
  for t in "${newer[@]}"; do
    local touched
    touched="$(git_base diff --name-only "$pin_sha" "$t^{commit}" -- "${MODULES[@]}" 2>/dev/null || true)"
    if [ -n "$touched" ]; then
      news=1
      echo "  $t TOUCHES modules you watch:"
      printf '    %s\n' $touched
    else
      echo "  $t — none of your watched modules changed"
    fi
  done
  [ "$news" = "1" ] && return 10 || return 0
}

# ── the control ───────────────────────────────────────────────────────────────
# ⛔ A probe that cannot return BOTH answers is not a probe — it is a constant
# wearing a probe's clothes. These two run against IMMUTABLE historical tags, so
# they assert a property of THIS script permanently: they cannot start failing
# because base ships something new, which is what makes a control safe to add to
# a soft watch without making the watch brittle.
if [ "$SELF_TEST" = "1" ]; then
  fails=0
  echo "== control A: v0.7.0..v0.8.0 SHOULD report lib/storage-paths.js (it was added at v0.8.0)"
  MODULES=("lib/storage-paths.js")
  set +e
  outA="$(report v0.7.0 v0.8.0)"; rcA=$?
  set -e
  printf '%s\n' "$outA" | sed 's/^/    /'
  if [ "$rcA" = "10" ] && printf '%s' "$outA" | grep -q 'storage-paths.js'; then
    echo "  OK (answer: NEWS)"
  else
    echo "  ⛔ FAILED — expected news, got rc=$rcA"; fails=$((fails + 1))
  fi

  echo "== control B: v0.7.0..v0.8.0 SHOULD NOT report lib/xpra-presence.js (untouched in that range)"
  MODULES=("lib/xpra-presence.js")
  set +e
  outB="$(report v0.7.0 v0.8.0)"; rcB=$?
  set -e
  printf '%s\n' "$outB" | sed 's/^/    /'
  # ⛔ ASSERT THE CONTROL'S OWN SUBJECT. "rc=0 and no TOUCHES" is also what you
  # get when the probe found NO NEWER TAG AT ALL — so without this the negative
  # arm passes while measuring nothing, and it fails toward GREEN. A control
  # that replays only part of the condition it claims to replay is the shape
  # cgwc:main hit tonight replaying a pattern without its coupled sort.
  if [ "$rcB" = "0" ] \
     && printf '%s' "$outB" | grep -q 'NEWER TAGS' \
     && printf '%s' "$outB" | grep -q 'v0\.8\.0' \
     && ! printf '%s' "$outB" | grep -q 'TOUCHES'; then
    echo "  OK (answer: NO NEWS, and it verifiably compared the range)"
  else
    echo "  ⛔ FAILED — expected no-news OVER A RANGE IT ACTUALLY SAW, got rc=$rcB"
    fails=$((fails + 1))
  fi

  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST FAILED ($fails/2) — this probe cannot be trusted to distinguish its two answers." >&2
    exit 1
  fi
  echo "SELF-TEST PASSED 2/2 — the probe returns both answers."
  exit 0
fi

# ── live run ──────────────────────────────────────────────────────────────────
if [ "$OFFLINE" != "1" ]; then
  # THE POINT OF THE WHOLE SCRIPT: read base's refs as they are NOW, not as the
  # vendored snapshot remembers them.
  if ! git_base fetch --tags --quiet origin 2>/dev/null; then
    echo "WARN: could not fetch base's tags; reporting from refs already present." >&2
    echo "      This report may be STALE — it is exactly the blind spot the probe exists to close." >&2
  fi
fi

[ -n "$PIN" ] || PIN="$(git_base rev-parse HEAD)"

set +e
out="$(report "$PIN" "$UNTIL")"; rc=$?
set -e
printf '%s\n' "$out"

if [ "$JSON" = "1" ]; then
  printf '{"type":"tags-since-pin","ts":"%s","pin":"%s","news":%s,"modules":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PIN" "$([ "$rc" = "10" ] && echo true || echo false)" "${MODULES[*]}"
fi

if [ "$EXIT_CODE" = "1" ]; then exit "$rc"; fi
exit 0
