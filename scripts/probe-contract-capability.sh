#!/usr/bin/env bash
# probe-contract-capability.sh — can this consumer's contract FAIL at all?
#
# ⛔ THE DEFECT THIS EXISTS TO CATCH
#
# `test-all-consumers.sh --against-head` points every consumer at a release
# CANDIDATE and reports PASS/FAIL. Measured 2026-09-22 with `deriveXpraPorts`
# sabotaged to return `{xpraTcpPort: 99999, xpraHtml5Port: 1}` — a
# catastrophically broken base:
#
#     chatgpt-webctl    PASS      <- against the sabotaged candidate
#     substack-webctl   PASS      <- against the sabotaged candidate
#     fetlife-webctl    FAIL      <- the only contract that noticed
#
# The submodule SWAP landed in all three cases, so they genuinely ran the broken
# code. They passed because their contracts never exercise the behaviour that
# broke. ⇒ **The gate's green is only as strong as the weakest contract in it**,
# and it aggregates meaningless passes into "OK: no consumer FAILed".
#
# Before fetlife's fix that same day, NO consumer could detect a broken
# candidate — so the release gate was, in practice, incapable of failing on a
# code defect while looking exactly like validation from the outside.
#
# ⭐ A CONTRACT THAT CANNOT RETURN "FAIL" IS NOT A CONTRACT. Same rule this repo
# already applies to its own probes (`tags-since-pin --self-test`): an
# instrument that cannot produce both answers is a constant wearing an
# instrument's clothes.
#
# ── WHAT IT DOES ──────────────────────────────────────────────────────────────
# Builds a DELIBERATELY BROKEN copy of base in a temp dir, hands it to each
# wired consumer as `WEBCTL_BASE_DIR`, and requires a NON-ZERO exit.
#
#   non-zero -> CAPABLE    the contract honours the variable AND exercises base
#   zero     -> ⛔ INCAPABLE  its PASS in a real run establishes nothing
#
# ⚠ NO COMMITS, NO SUBMODULE SWAPS. The sabotage lives only in a temp directory,
# so an interrupt cannot leave a consumer pinned to broken code — which is a
# thing that has actually happened here.
#
# ⚠ WHAT A ZERO DOES NOT DISTINGUISH: "ignores WEBCTL_BASE_DIR entirely" from
# "honours it but never exercises the sabotaged function". Both mean the same
# thing for the gate — this contract cannot vouch for a candidate — so they are
# reported together rather than guessed apart.
#
# Exit: 0 every wired consumer is capable | 1 at least one is not | 2 bad usage.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE_ROOT="$(cd "$HERE/.." && pwd)"
CONSUMERS_DIR="${WEBCTL_CONSUMERS_DIR:-$HOME/github/CLIAI}"

STRICT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --report-only) STRICT=0; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/webctl-capability-XXXXXX")"
cleanup() { rm -rf "$WORK"; }
# INT/TERM/HUP as well as EXIT, and re-raised: bash skips EXIT traps on a signal,
# and a handler that exits 0 would convert "killed" into "succeeded".
trap cleanup EXIT
for sig in INT TERM HUP; do
  trap "cleanup; trap - $sig; kill -$sig \$\$" "$sig"
done

# ── build the broken candidate ────────────────────────────────────────────────
CAND="$WORK/candidate"
cp -a "$BASE_ROOT" "$CAND"
rm -rf "$CAND/.git" "$CAND/node_modules"

SABOTAGE_FILE="$CAND/lib/client-config.js"
python3 - "$SABOTAGE_FILE" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = "    return { xpraTcpPort: tcp, xpraHtml5Port: html5, sources: { tcp: tcpSource, html5: html5Source } };"
new = "    return { xpraTcpPort: 99999, xpraHtml5Port: 1, sources: { tcp: 'SABOTAGE', html5: 'SABOTAGE' } };"
if old not in s:
    sys.stderr.write(
        "PROBE CANNOT RUN: the sabotage target has moved in lib/client-config.js.\n"
        "Refusing rather than probing with an un-sabotaged candidate — that would\n"
        "report every consumer CAPABLE for the one reason that proves nothing.\n")
    sys.exit(3)
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY

# ⛔ PROVE THE SABOTAGE LANDED before trusting a single verdict. A probe whose
# mutation silently failed reports everything CAPABLE and is indistinguishable
# from a healthy fleet — the exact failure this script exists to catch, one
# level up. (This repo has shipped a control whose mutation never landed.)
probe_out="$(cd "$CAND" && node -e '
  import("./lib/client-config.js").then((m) => {
    const c = m.createClientConfig({
      PROJECT:"p", ARTIFACT_PREFIX:"p-", IMAGE_CHROMIUM_REPO:"r", IMAGE_XPRA:"x",
      DEFAULT_CDP_PORT:4427, CACHE_DIRNAME:"p", ZOOM_DEFAULT_HOST:"h",
      CONFIG_FILE_PROJECT:"c.jsonc", DOTENV_FILENAME:".env", DOTENV_TEMPLATE:".env.x",
      ENV_PREFIX:"P_", ENV_PREFIX_LEGACY:null, ENV_LEGACY_SUFFIXES:[],
    });
    console.log(c.deriveXpraPorts(4427).xpraTcpPort);
  }).catch((e) => { console.log("ERR:" + e.message); });
' 2>/dev/null || echo "ERR")"
if [ "$probe_out" != "99999" ]; then
  echo "⛔ PROBE ABORTED: the sabotaged candidate does NOT misbehave (got '$probe_out')." >&2
  echo "   Every verdict below would have been a false CAPABLE. Not proceeding." >&2
  exit 1
fi
echo "sabotage verified: candidate deriveXpraPorts(4427) -> $probe_out (healthy base gives 14427)" >&2
echo >&2

capable=0; incapable=0; skipped=0
incapables=()

while IFS=$'\t' read -r name submodulePath testCmd tier dockerOptIn wired localDir; do
  [ -n "$name" ] || continue
  [ "$wired" = "true" ] || { skipped=$((skipped + 1)); continue; }

  if [ -n "${localDir:-}" ]; then
    case "$localDir" in
      "~/"*)     repo_dir="$HOME/${localDir#\~/}" ;;
      '$HOME/'*) repo_dir="$HOME/${localDir#\$HOME/}" ;;
      *)         repo_dir="$localDir" ;;
    esac
  else
    repo_dir="$CONSUMERS_DIR/$name"
  fi
  [ -d "$repo_dir" ] || { echo "SKIP  $name — repo not present at $repo_dir" >&2; skipped=$((skipped + 1)); continue; }

  contract_script="${testCmd%% *}"
  [ -x "$repo_dir/$contract_script" ] || { echo "SKIP  $name — no contract script" >&2; skipped=$((skipped + 1)); continue; }

  set +e
  ( cd "$repo_dir" && WEBCTL_BASE_DIR="$CAND" eval "$testCmd" ) >/dev/null 2>&1
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    echo "CAPABLE    $name — rejected a broken candidate (exit $rc)" >&2
    capable=$((capable + 1))
  else
    echo "⛔ INCAPABLE $name — PASSED a candidate whose port derivation is destroyed." >&2
    echo "             Its PASS in --against-head establishes nothing about the candidate." >&2
    incapable=$((incapable + 1)); incapables+=("$name")
  fi
done < <(node "$HERE/read-consumers.mjs")

echo >&2
echo "----- capability: capable=$capable incapable=$incapable skipped=$skipped -----" >&2
if [ "$incapable" -gt 0 ]; then
  echo "⚠ A release validated only by these contracts is not validated: ${incapables[*]}" >&2
  [ "$STRICT" = "1" ] && exit 1
fi
exit 0
