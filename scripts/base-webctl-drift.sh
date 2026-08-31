#!/usr/bin/env bash
# base-webctl-drift.sh — measure how far a *-webctl consumer has drifted from
# base-webctl, and say WHETHER THE DRIFT IS PACKAGING OR LOGIC.
#
# WHY THIS EXISTS: "byte-identical, never diverge" is an invariant that no one
# can check by reading. chatgpt-webctl's AGENTS.md asserted it for five modules;
# on 2026-08-31 all five were divergent and nobody had noticed. A claim that
# cannot be measured cheaply stops being true quietly.
#
# The line counts alone are alarming and MISLEADING: base-webctl was ported to
# ESM, so `require`->`import` and `module.exports`->`export` account for most of
# the delta. This script separates the two, because the remediation is entirely
# different: a packaging gap is a shim, a logic gap is a merge.
#
# This is the mechanical core of the fleet-wide convergence sweep — the part a
# manager's custom command would call per consumer.
#
# Usage:
#   scripts/base-webctl-drift.sh [--base <dir>] [--consumer <dir>] [--jsonl]
#
# Defaults: base = ~/github/CLIAI/base-webctl, consumer = this repo.
# Exit 0 always (it is a report, not a gate) unless --strict is given, which
# exits 1 when any module shows LOGIC drift.

set -uo pipefail

BASE="${HOME}/github/CLIAI/base-webctl"
CONSUMER="$(cd "$(dirname "$0")/.." && pwd)"
JSONL=0
STRICT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base)     BASE="$2"; shift 2 ;;
    --consumer) CONSUMER="$2"; shift 2 ;;
    --jsonl)    JSONL=1; shift ;;
    --strict)   STRICT=1; shift ;;
    -h|--help)  sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -d "$BASE/lib" ] || { echo "no base-webctl lib at $BASE/lib" >&2; exit 2; }

# LIFTED INTO BASE (2026-08-31): authored to run from inside ONE consumer, where
# --consumer defaulted to "the repo I live in". In base it serves five, so a
# bare NAME is resolved through consumers.jsonc — including `localDir`, because
# two consumers do not live at $WEBCTL_CONSUMERS_DIR/<name> and resolving them
# by name alone is precisely the bug that hid one from the release gate for six
# weeks (xrl4 "Gate validity"). A path is still accepted unchanged.
if [ ! -d "$CONSUMER" ]; then
  reg_row="$(node "$(dirname "$0")/read-consumers.mjs" | awk -F'\t' -v n="$CONSUMER" '$1==n {print; exit}')"
  if [ -n "$reg_row" ]; then
    reg_local="$(printf '%s' "$reg_row" | cut -f7)"
    if [ -n "$reg_local" ]; then
      case "$reg_local" in
        "~/"*) CONSUMER="$HOME/${reg_local#\~/}" ;;
        *)     CONSUMER="$reg_local" ;;
      esac
    else
      CONSUMER="${WEBCTL_CONSUMERS_DIR:-$HOME/github/CLIAI}/$CONSUMER"
    fi
  fi
fi
[ -d "$CONSUMER" ] || {
  echo "consumer not found: $CONSUMER" >&2
  echo "  pass a path, or a name registered in consumers.jsonc" >&2
  exit 2
}

NAME="$(basename "$CONSUMER")"
WIRED="unknown"
if [ -e "$CONSUMER/vendor/base-webctl" ]; then WIRED="yes"; else WIRED="no"; fi

# Normalise away the module-system port so PACKAGING drift cancels out and only
# LOGIC drift remains. Deliberately crude and deliberately CONSERVATIVE: it may
# leave some packaging noise in (reported as logic, a false alarm you can read)
# but it will not hide a real logic change (a false all-clear, which you cannot).
normalise() {
  # Drop a multi-line `module.exports = { ... };` block wholesale. The
  # single-line form is handled by sed below; the block form is not, and it is
  # the shape every CJS module with several exports actually uses.
  awk '
    /^module\.exports[[:space:]]*=[[:space:]]*\{/ { skip=1 }
    skip { if (/^\};?/) { skip=0 }; next }
    { print }
  ' "$1" | sed -E \
    -e 's/^[[:space:]]*\/\/.*$//' \
    -e 's/^[[:space:]]*\/\*+.*$//' \
    -e 's/^[[:space:]]*\*.*$//' \
    -e "s/^[[:space:]]*'use strict';?[[:space:]]*$//" \
    -e 's/\/\*+[^*]*\*+\///g' \
    -e "s/^import[[:space:]]+\{([^}]*)\}[[:space:]]+from[[:space:]]+['\"]([^'\"]*)['\"];?/CONST {\1} = REQUIRE(\2)/" \
    -e "s/^const[[:space:]]+\{([^}]*)\}[[:space:]]*=[[:space:]]*require\(['\"]([^'\"]*)['\"]\);?/CONST {\1} = REQUIRE(\2)/" \
    -e "s/^import[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*)[[:space:]]+from[[:space:]]+['\"]([^'\"]*)['\"];?/CONST \1 = REQUIRE(\2)/" \
    -e "s/^const[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*)[[:space:]]*=[[:space:]]*require\(['\"]([^'\"]*)['\"]\);?/CONST \1 = REQUIRE(\2)/" \
    -e 's/^export[[:space:]]+function/function/' \
    -e 's/^export[[:space:]]+const/const/' \
    -e 's/^module\.exports[[:space:]]*=.*$//' \
    -e 's/^export[[:space:]]*\{.*$//' \
    -e "s/node:([a-z_]+)/\1/g" \
    -e 's/[[:space:]]+//g' \
    | grep -v '^[[:space:]]*$'
}

emit_json() { [ "$JSONL" = 1 ] && echo "$1"; }

if [ "$JSONL" = 0 ]; then
  echo "base-webctl drift — consumer: $NAME"
  echo "  base:     $BASE"
  echo "  consumer: $CONSUMER"
  echo "  submodule mounted: $WIRED"
  echo ""
  printf "  %-26s %10s %10s  %s\n" MODULE RAW-DIFF LOGIC-DIFF VERDICT
fi
emit_json "{\"type\":\"drift-run\",\"consumer\":\"$NAME\",\"base\":\"$BASE\",\"wired\":\"$WIRED\"}"

LOGIC_DRIFT=0
SHARED=0
for f in "$BASE"/lib/*.js; do
  mod="$(basename "$f")"
  mine="$CONSUMER/lib/$mod"
  [ -f "$mine" ] || continue
  SHARED=$((SHARED+1))

  # A shim is not drift — it is adoption. Detect it BEFORE diffing, and suppress
  # the numbers entirely: diffing a 15-line shim against a 361-line module
  # yields a large count BY CONSTRUCTION, measuring the migration rather than
  # any drift. Printing it invites exactly the misreading webctl:linkedin caught
  # in my convergence table, where I reported their already-adopted modules as
  # heavily drifted and passed that on to base and mgr.
  if grep -qE "require\(.*vendor/base-webctl" "$mine" 2>/dev/null; then
    raw="n/a"; logic="n/a"
  else
    raw=$(diff "$mine" "$f" 2>/dev/null | grep -c '^[<>]' || true)
    ta=$(mktemp); tb=$(mktemp)
    normalise "$mine" > "$ta"; normalise "$f" > "$tb"
    logic=$(diff "$ta" "$tb" 2>/dev/null | grep -c '^[<>]' || true)
    rm -f "$ta" "$tb"
  fi

  if [ "$raw" = "n/a" ]; then
    verdict="ADOPTED (shim)"
  elif [ "$raw" -eq 0 ]; then
    verdict="IDENTICAL"
  elif [ "$logic" -eq 0 ]; then
    verdict="packaging only (ESM port) -> shim"
  else
    verdict="LOGIC DRIFT -> needs a merge"
    LOGIC_DRIFT=$((LOGIC_DRIFT+1))
  fi

  [ "$JSONL" = 0 ] && printf "  %-26s %10s %10s  %s\n" "$mod" "$raw" "$logic" "$verdict"
  emit_json "{\"type\":\"drift\",\"module\":\"$mod\",\"rawDiff\":$raw,\"logicDiff\":$logic,\"verdict\":\"$verdict\"}"
done

if [ "$JSONL" = 0 ]; then
  echo ""
  echo "  $SHARED shared module(s); $LOGIC_DRIFT with LOGIC drift."
  if [ "$WIRED" = "no" ]; then
    echo ""
    echo "  Not wired. Adoption path proven by linkedin-webctl — keep lib/<mod>.js"
    echo "  as a one-line re-export shim so no caller changes:"
    echo ""
    echo "      module.exports = require('../vendor/base-webctl/lib/<mod>.js');"
    echo ""
    echo "  That works because Node >=22.12 can require() ESM and base-webctl"
    echo "  guarantees no top-level await. Do ONE module at a time, cheapest"
    echo "  first, running the consumer's own suite between each."
  fi
fi
emit_json "{\"type\":\"drift-summary\",\"shared\":$SHARED,\"logicDrift\":$LOGIC_DRIFT,\"wired\":\"$WIRED\"}"

[ "$STRICT" = 1 ] && [ "$LOGIC_DRIFT" -gt 0 ] && exit 1
exit 0
