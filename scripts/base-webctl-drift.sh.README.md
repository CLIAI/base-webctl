# base-webctl-drift.sh

Measures how far a `*-webctl` consumer has drifted from `base-webctl`, and
reports **whether that drift is packaging or logic** — because the remediation
differs completely: a packaging gap is a shim, a logic gap is a merge.

## Usage

```bash
scripts/base-webctl-drift.sh                        # this repo vs ~/github/CLIAI/base-webctl
scripts/base-webctl-drift.sh --consumer ../foo-webctl
scripts/base-webctl-drift.sh --base /path/to/base --jsonl
scripts/base-webctl-drift.sh --strict               # exit 1 when any module shows LOGIC drift
```

## Output

Per shared module: `RAW-DIFF`, `LOGIC-DIFF`, and a verdict —

| verdict | meaning | action |
|---|---|---|
| `ADOPTED (shim)` | already re-exports from `vendor/base-webctl` | none |
| `IDENTICAL` | byte-identical copy | shim it (base's `verify-no-byte-drift.sh` treats this as a regression in a wired consumer) |
| `packaging only (ESM port) -> shim` | differs only by module system / comments | safe to adopt |
| `LOGIC DRIFT -> needs a merge` | real behavioural difference | human merge before adopting |

`--jsonl` emits `drift-run`, one `drift` per module, and `drift-summary`.

## Where it fits

Complements base's own `verify-no-byte-drift.sh`, which answers the **opposite**
question at the **opposite phase**: that one FAILS when an already-wired
consumer's copy is byte-identical to base (catching regression to duplication
*after* adoption). This one classifies drift *before* adoption, to decide what
adoption will even cost.

It is the mechanical core of a fleet-wide convergence sweep: run it per consumer
from `consumers.jsonc`, group by verdict, and you have the adoption order.

## Exit codes

`0` always (it is a report), except `2` on bad arguments, and `1` with
`--strict` when any module shows logic drift.
