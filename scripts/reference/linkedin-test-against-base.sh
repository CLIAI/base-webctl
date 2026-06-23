#!/usr/bin/env bash
# test-against-base.sh — linkedin-webctl's implementation of the xrl4 consumer
# contract (docs/design/test-cross-repo-consumer-loop-xrl4.md §"consumer contract").
#
# THIS IS A REFERENCE COPY held in base for the adoption proposal + the gate
# demonstration. After linkedin adopts it, the canonical home is linkedin-webctl's
# REPO ROOT as `./test-against-base.sh` (chmod +x). base's release gate
# (scripts/test-all-consumers.sh) loops every wired consumer's copy of this.
#
# base loops ONE contract; each tool maps it onto its own runners. For linkedin:
#   --offline (default; MUST be fully no-human) — every unit/mocked suite
#               (node test/*-test.js). These need no browser/login/network and
#               cover linkedin's consumption of every adopted base module
#               (client-config, chromium-prefs, profile-lock, docker-mode,
#               browser-location, lru-cleanup, systemd-timer, xpra-presence, ...).
#   --unit    — unit suites only (same set here; the *-test.js ARE the unit tier).
#   --stack   — headless xpra+chromium stack (test/docker-live-test.sh), gated
#               behind LINKEDIN_WEBCTL_DOCKER_TESTS=1 (docker-tier only).
#
# Exit codes (authoritative, xrl4 §"Exit codes"):
#   0  pass                                  -> base gate: PASS
#   1  fail                                  -> base gate: BLOCKS the release
#   2  blocked — needs human / not enabled   -> base gate: SKIP (never blocks)
#
# Output: lszd JSONL typed envelopes on STDOUT (one per suite):
#   {"type":"consumer-test","ts":..,"consumer":..,"suite":..,"result":"pass|fail|skip"}
# Human-readable log + each suite's own output go to STDERR, so STDOUT stays
# valid JSONL (data-jsonl-machine-interface-lszd).
#
# NOTE: smoke-test.sh --offline is intentionally NOT in the gate suite — it is a
# slower CLI-level smoke (help resolution over many subprocess spawns); the gate
# stays fast + deterministic on the *-test.js tier. linkedin may add it (with a
# timeout) if desired.

set -uo pipefail   # NO -e: we run every suite and aggregate, never short-circuit.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

CONSUMER="linkedin-webctl"
MODE="${1:---offline}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# emit one lszd envelope on stdout
envelope() {
  printf '{"type":"consumer-test","ts":"%s","consumer":"%s","suite":"%s","result":"%s"}\n' \
    "$(ts)" "$CONSUMER" "$1" "$2"
}

# Run every node test/*-test.js suite, one envelope each. Returns 1 if any failed.
run_unit_suites() {
  local rc=0 had=0
  for f in test/*-test.js; do
    [ -e "$f" ] || continue
    had=1
    local suite; suite="$(basename "$f" .js)"
    if node "$f" >&2; then
      envelope "$suite" "pass"
    else
      envelope "$suite" "fail"
      echo "FAIL suite: $suite" >&2
      rc=1
    fi
  done
  if [ "$had" = 0 ]; then
    echo "no test/*-test.js suites found" >&2
    return 1
  fi
  return $rc
}

case "$MODE" in
  --offline|--unit)
    if run_unit_suites; then
      echo "OK: $CONSUMER $MODE — all unit/mocked suites passed" >&2
      exit 0
    else
      echo "FAIL: $CONSUMER $MODE — at least one suite failed" >&2
      exit 1
    fi
    ;;
  --stack)
    if [ "${LINKEDIN_WEBCTL_DOCKER_TESTS:-0}" != "1" ]; then
      envelope "docker-live" "skip"
      echo "SKIP: $CONSUMER --stack needs LINKEDIN_WEBCTL_DOCKER_TESTS=1 (docker stack not enabled)" >&2
      exit 2   # blocked / not-enabled -> gate counts as SKIP
    fi
    if bash test/docker-live-test.sh >&2; then
      envelope "docker-live" "pass"
      echo "OK: $CONSUMER --stack — headless stack passed" >&2
      exit 0
    else
      envelope "docker-live" "fail"
      echo "FAIL: $CONSUMER --stack — docker-live-test failed" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: ./test-against-base.sh [--offline|--unit|--stack]" >&2
    exit 64
    ;;
esac
