# `probe-contract-capability.sh` — can a consumer's contract fail at all?

Hands every wired consumer a **deliberately broken** copy of base as
`WEBCTL_BASE_DIR` and requires a **non-zero** exit.

```sh
./scripts/probe-contract-capability.sh            # exit 1 if any consumer is incapable
./scripts/probe-contract-capability.sh --report-only
```

```
sabotage verified: candidate deriveXpraPorts(4427) -> 99999 (healthy base gives 14427)
CAPABLE    fetlife-webctl — rejected a broken candidate (exit 1)
⛔ INCAPABLE chatgpt-webctl — PASSED a candidate whose port derivation is destroyed.
```

## Why it exists

`test-all-consumers.sh --against-head` reports PASS/FAIL against a release
candidate. Measured 2026-09-22 with `deriveXpraPorts` returning
`{xpraTcpPort: 99999, xpraHtml5Port: 1}`:

| consumer | verdict against a destroyed base |
|---|---|
| chatgpt-webctl | **PASS** |
| substack-webctl | **PASS** |
| fetlife-webctl | FAIL — the only one that noticed |

The submodule swap landed in every case, so all three genuinely ran the broken
code. They passed because their contracts never exercise the behaviour that
broke.

> **The gate's green is only as strong as the weakest contract in it** — and it
> aggregates meaningless passes into "OK: no consumer FAILed".

⭐ **A contract that cannot return FAIL is not a contract.** Same rule this repo
applies to its own probes: an instrument that cannot produce both answers is a
constant wearing an instrument's clothes.

## What a verdict means

* **CAPABLE** — the contract honours `WEBCTL_BASE_DIR` *and* exercises base.
  Control-verified to be more than "always red": a capable contract returns 0
  against a **healthy** candidate and non-zero against the sabotaged one.
* **⛔ INCAPABLE** — either it ignores the variable, or it honours it and never
  touches the sabotaged function. ⚠ These are **not distinguished**, deliberately:
  both mean *this contract cannot vouch for a candidate*, so they are reported
  together rather than guessed apart.

## Safety

**No commits and no submodule swaps.** The sabotage lives only in a temp dir, so
an interrupt cannot leave a consumer pinned to broken code. `INT`/`TERM`/`HUP`
are trapped and re-raised alongside `EXIT`.

⚠ The probe **aborts** if its own mutation did not land, rather than reporting
every consumer CAPABLE for the one reason that proves nothing.

See `.DEV_NOTES.md`.
