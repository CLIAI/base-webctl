---
id: v8m2
title: "Structured Exit Code Convention"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [exit-codes, error-handling, shell-scripting, process-status, automation]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Structured Exit Code Convention

## Motivation

CLI tools that return only 0 (success) or 1 (failure) force callers into
fragile string-parsing to distinguish failure modes. A structured exit code
convention lets shell scripts and automation pipelines branch on numeric codes
without parsing stderr:

```bash
tool action "$target"
case $? in
  0) echo "OK" ;;
  2) echo "Blocked state, retrying..." ;;
  3) echo "Connection lost, reconnecting..." ;;
  4) echo "Lock held, waiting..." ;;
  *) echo "Unexpected failure" ;;
esac
```

When every tool in a project shares the same exit code table, callers can
reuse a single error-handling wrapper across all tools.

## Design Principles

1. **Deterministic** -- The same failure condition always produces the same
   exit code, regardless of which subcommand triggered it.

2. **Shell-friendly** -- Codes stay in the POSIX-safe range 0-125. Values
   126+ are reserved by shells (126 = command not executable, 127 = command
   not found, 128+N = killed by signal N).

3. **Sparse by default** -- Start with a small, well-defined set. Tools may
   extend with higher codes but must never reassign the base range.

4. **Documented inline** -- Every tool must expose its exit codes via a
   `--help` flag or a dedicated `exit-codes` subcommand.

## Standard Exit Code Registry

| Code | Meaning                  | When to Use                                                        |
|------|--------------------------|--------------------------------------------------------------------|
| 0    | Success                  | Operation completed as requested                                   |
| 1    | General error            | Catch-all for unclassified failures                                |
| 2    | Blocked state            | Assertion failure, precondition not met, unexpected UI state        |
| 3    | Connection / auth failure| Target unreachable, session expired, credentials rejected           |
| 4    | Mutex timeout            | Lock file held by another process, could not acquire within limit   |
| 5    | Target mismatch          | Located element does not match expected identity or content         |
| 6    | Configuration error      | Missing or invalid config file, environment variable, or parameter  |

### Reserved Ranges

| Range   | Owner            |
|---------|------------------|
| 0-6     | This convention  |
| 7-63    | Project-specific extensions (document per-project) |
| 64-78   | BSD sysexits.h (EX_USAGE, EX_NOINPUT, etc.) -- avoid reassigning |
| 79-125  | Available for future convention expansion |
| 126-255 | Shell / OS reserved -- never use |

## Implementation Pattern

Define exit codes as named constants at the top of every script or module.
Never use bare numeric literals for exits beyond 0 and 1.

### Shell (Bash / POSIX sh)

```bash
readonly EXIT_SUCCESS=0
readonly EXIT_GENERAL=1
readonly EXIT_BLOCKED=2
readonly EXIT_CONN_FAIL=3
readonly EXIT_MUTEX_TIMEOUT=4
readonly EXIT_TARGET_MISMATCH=5
readonly EXIT_CONFIG_ERROR=6

cleanup() {
  # ...
}
trap cleanup EXIT

main() {
  check_config || exit $EXIT_CONFIG_ERROR
  acquire_lock || exit $EXIT_MUTEX_TIMEOUT
  connect      || exit $EXIT_CONN_FAIL
  verify_state || exit $EXIT_BLOCKED
  run_action   || exit $EXIT_GENERAL
}
```

### Python

```python
import enum
import sys

class ExitCode(enum.IntEnum):
    SUCCESS         = 0
    GENERAL         = 1
    BLOCKED         = 2
    CONN_FAIL       = 3
    MUTEX_TIMEOUT   = 4
    TARGET_MISMATCH = 5
    CONFIG_ERROR    = 6

def main() -> int:
    try:
        run()
        return ExitCode.SUCCESS
    except ConnectionError:
        return ExitCode.CONN_FAIL
    except TimeoutError:
        return ExitCode.MUTEX_TIMEOUT

if __name__ == "__main__":
    sys.exit(main())
```

## Caller-Side Patterns

### Simple Boolean Check

```bash
if tool action "$target"; then
  echo "Success"
else
  echo "Failed with code $?"
fi
```

### Exhaustive Case

```bash
tool action "$target"
rc=$?
case $rc in
  0) : ;;  # success, continue
  2) retry_after_unblock ;;
  3) reconnect_and_retry ;;
  4) wait_for_lock ;;
  *) die "Unexpected exit code $rc" ;;
esac
```

### Retry Wrapper with Code-Aware Backoff

```bash
run_with_retry() {
  local cmd=("$@")
  local max_attempts=3
  local attempt=0

  while (( attempt < max_attempts )); do
    "${cmd[@]}"
    rc=$?
    case $rc in
      0) return 0 ;;
      3|4) ((attempt++)); sleep "$((attempt * 2))" ;;  # retriable
      *)   return $rc ;;                                # non-retriable
    esac
  done
  return $rc
}
```

## Documentation Requirements

Every tool that adopts this convention must:

1. **List exit codes in `--help` output** under a dedicated "Exit Codes"
   section.

2. **Include a machine-readable listing** via a subcommand or flag
   (e.g., `tool exit-codes --json`) that emits:

   ```json
   [
     {"code": 0, "name": "SUCCESS", "description": "Operation completed"},
     {"code": 2, "name": "BLOCKED", "description": "Precondition not met"}
   ]
   ```

3. **Log the exit code** to stderr on non-zero exit so humans can diagnose
   without checking `$?`:

   ```
   error: blocked state detected (exit 2)
   ```

## Extending the Registry

When a project needs additional codes:

1. Choose a code in the 7-63 range.
2. Document the new code in the project's own design docs or `AGENTS.md`.
3. Never reassign codes 0-6 to different meanings.
4. If the new code proves universally useful across projects, propose adding
   it to the base registry (codes 0-6) via a pull request to this document.

## Anti-Patterns

* **Overloading code 1** for every failure -- defeats the purpose of
  structured codes. Reserve code 1 only for truly unclassifiable errors.

* **Using codes above 125** -- these collide with shell signal reporting
  (128 + signal number) and command-not-found conventions.

* **Returning different codes for the same condition** depending on
  subcommand or flag -- breaks caller expectations.

* **Silent non-zero exit** -- always emit a diagnostic message to stderr
  before exiting with a non-zero code.
