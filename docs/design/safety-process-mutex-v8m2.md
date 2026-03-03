---
id: v8m2
title: "Process Mutex: Filesystem-Based Serialization for Shared Resources"
category: safety
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [mutex, concurrency, filesystem-lock, atomic-mkdir, pid-detection, shared-resource]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Process Mutex: Filesystem-Based Serialization for Shared Resources

## Problem Statement

A CLI tool that controls a shared external process (e.g., a headless browser) must
guarantee that only one invocation mutates that process at a time. Without
serialization, concurrent commands can corrupt session state, trigger race
conditions, or produce undefined behavior when two writers act on the same
resource simultaneously.

The lock mechanism must satisfy these constraints:

* **Zero external dependencies** -- no daemon, no database, no language runtime
  beyond the CLI itself.
* **Cross-platform atomicity** -- works on every POSIX filesystem and common
  operating systems without special privileges.
* **Stale-lock recovery** -- automatically reclaims locks left behind by crashed
  or killed processes.
* **Observability** -- operators can determine who holds a lock, for how long,
  and on what resource.

## Why `mkdir` Over Alternatives

Several locking primitives exist. `mkdir` (directory creation) is the preferred
approach for CLI process-level mutual exclusion.

### Comparison of Locking Strategies

| Strategy | Atomicity | Cross-Platform | Zero Deps | Stale Recovery | Notes |
|----------|-----------|----------------|-----------|----------------|-------|
| `mkdir` | Atomic (EEXIST) | All POSIX + most OS | Yes | Via PID check | Preferred |
| `flock` / advisory locks | Kernel-level | POSIX only | Yes | Auto on close | Not portable to all OS; NFS-unsafe |
| PID file (write) | NOT atomic | All | Yes | Via PID check | Race window between check-and-write |
| Named socket | Kernel-level | POSIX only | Yes | Auto on close | Requires socket API; overkill |
| External lock service | N/A | Any | No | Configurable | Heavy dependency; network required |

The key advantage of `mkdir` is that the operating system kernel guarantees
exactly one caller succeeds when two processes race to create the same directory
path. The loser receives `EEXIST` (or equivalent) without any partial state.
This is simpler, more portable, and lower-overhead than any alternative.

## Architecture

### Lock Directory Layout

```
{cache_root}/locks/port-{PORT}.lock/
  pid          # text file: PID of the lock holder
  meta.json    # optional: structured metadata for debugging
```

**Per-port isolation**: each controllable instance (identified by its
communication port) gets an independent lock directory. This allows parallel
operation across distinct instances while serializing access within a single
instance.

### Lock Lifecycle

```
  ┌────────────┐
  │  Acquire   │
  │  mkdir()   │
  ├────────────┤
  │ EEXIST?    │──yes──► Read PID ──► Process alive? ──yes──► Wait / Timeout
  │            │                                       │
  │            │                                       no
  │            │                                       │
  │            │                      ┌────────────────▼───────────┐
  │            │                      │  Stale lock detected       │
  │            │                      │  rmdir + retry mkdir       │
  │            │                      └────────────────────────────┘
  │            │
  │ success    │──► Write PID file ──► Write metadata ──► Execute command
  │            │
  └────────────┘
        │
        ▼ (on exit, signal, or error)
  ┌────────────┐
  │  Release   │
  │  rm pid    │
  │  rmdir()   │
  └────────────┘
```

### Acquisition Algorithm

```
function acquireLock(lockDir, timeout):
    deadline = now() + timeout

    while now() < deadline:
        try:
            mkdir(lockDir)                   # atomic
            writeFile(lockDir/pid, currentPID)
            writeFile(lockDir/meta.json, {
                command, target, startedAt
            })
            registerSignalHandlers(releaseLock)
            return SUCCESS
        catch EEXIST:
            holderPID = readFile(lockDir/pid)

            if not processExists(holderPID):
                log("Stale lock from PID {holderPID}, reclaiming")
                removeLockDir(lockDir)        # rm contents + rmdir
                continue                      # retry immediately

            if waitElapsed % 5s == 0:
                log("Waiting for lock held by PID {holderPID} ({elapsed}s)")
            if waitElapsed >= 600s:
                log("WARNING: lock held for over 10 minutes")

            sleep(retryInterval)

    return LOCK_TIMEOUT                       # dedicated exit code
```

### Release Algorithm

```
function releaseLock(lockDir):
    try:
        removeFile(lockDir/pid)
        removeFile(lockDir/meta.json)         # if present
        rmdir(lockDir)
    catch:
        log("Warning: lock cleanup failed for {lockDir}")
```

Release must be registered for all exit paths:

* Normal command completion
* Uncaught exception / fatal error
* Signal handlers: SIGINT, SIGTERM, SIGHUP

## Stale Lock Detection

A lock is **stale** when the PID recorded in the lock directory no longer
corresponds to a running process. Detection uses the zero-signal technique:

```
processExists(pid):
    try:
        kill(pid, 0)       # signal 0 = existence check, no actual signal sent
        return true
    catch ESRCH:
        return false        # No Such Process -- lock is stale
    catch EPERM:
        return true         # Process exists but owned by another user
```

### Edge Cases

* **PID recycling**: On long-running systems, a PID may be reassigned to an
  unrelated process. The risk is low (PID spaces are typically 32768+) and the
  consequence is a delayed timeout rather than corruption. For extra safety,
  metadata can record the process start time and cross-check against
  `/proc/{pid}/stat` on systems that support it.

* **Networked filesystems**: `mkdir` atomicity is guaranteed on local
  filesystems. On network-mounted filesystems (NFS, SMB), atomicity guarantees
  vary. Lock directories should reside on local storage. Use `$XDG_CACHE_HOME`
  or `$TMPDIR` as the base path.

* **Permissions**: The lock directory must be writable by all users who may run
  the CLI. Using a per-user cache directory (e.g., `~/.cache/`) avoids
  cross-user permission issues.

## Lock Metadata

The optional `meta.json` provides diagnostic context when a lock is held:

```json
{
  "pid": 48217,
  "command": "click",
  "target": "#submit-button",
  "startedAt": "2026-03-03T14:22:07.123Z",
  "port": 9222
}
```

This enables operators and wait-progress messages to report **what** is holding
the lock and **how long** it has been held, without requiring external tooling.

## Wait Progress Reporting

When a command is waiting on a held lock, the CLI should provide feedback:

| Elapsed | Action |
|---------|--------|
| 0-5s | Silent wait (normal contention) |
| Every 5s | Log: "Waiting for lock held by PID {pid} ({elapsed}s)..." |
| 600s (10 min) | Warning: "Lock held for over 10 minutes -- possible stuck process" |
| Timeout | Exit with dedicated exit code and actionable error message |

Progress messages should include holder metadata when available (command name,
start time) so the operator can decide whether to wait or intervene.

## Operation Classification

Not all commands require exclusive access. Commands should be classified:

| Classification | Requires Lock | Examples |
|----------------|---------------|----------|
| **Mutating** | Yes | click, type, navigate, upload, execute-script |
| **Read-only introspection** | No | status, health-check, version |
| **Configuration** | No | config, set-option, help |
| **Explicit opt-out** | No | Any command with `--no-lock` flag |

The `--no-lock` flag provides an escape hatch for advanced users who understand
the concurrency risks (e.g., running a read-only screenshot while another
command is executing).

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `lock_timeout` | 30s | Maximum wait before returning timeout exit code |
| `retry_interval` | 200ms | Polling interval when lock is held |
| `lock_base_dir` | `$XDG_CACHE_HOME/{tool}/locks/` | Base directory for lock files |
| `lock_metadata` | true | Whether to write `meta.json` in lock dir |
| `progress_interval` | 5s | How often to log wait-progress messages |
| `stale_warning_threshold` | 600s | Elapsed time before emitting "possibly stuck" warning |

All parameters should be overridable via environment variables with a
project-specific prefix (e.g., `WEBCTL_LOCK_TIMEOUT=60`).

## Exit Codes

A dedicated exit code for lock timeout allows callers (scripts, CI pipelines) to
distinguish "lock contention" from "command failure":

| Exit Code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | General command error |
| N (project-defined) | Lock acquisition timeout |

The specific numeric value is project-defined but must be documented and
consistent. It should not collide with standard shell exit codes (1-2) or
signal-based exits (128+N).

## Signal Handler Registration

Lock cleanup on process termination is critical to avoid stale locks. Register
handlers for:

```
SIGINT   (Ctrl+C)        -> releaseLock() then exit(130)
SIGTERM  (kill default)   -> releaseLock() then exit(143)
SIGHUP   (terminal close) -> releaseLock() then exit(129)
```

Handlers should:

1. Release the lock (idempotent -- safe to call even if not held)
2. Re-raise or exit with the conventional 128+signal code
3. Avoid complex logic that could itself fail or deadlock

## Implementation Checklist

* [ ] Define lock directory path convention with per-port isolation
* [ ] Implement atomic `mkdir`-based acquisition with EEXIST handling
* [ ] Write PID file immediately after successful `mkdir`
* [ ] Implement stale lock detection via zero-signal (`kill(pid, 0)`)
* [ ] Register SIGINT/SIGTERM/SIGHUP handlers for cleanup
* [ ] Add configurable timeout with dedicated exit code
* [ ] Implement wait-progress logging (every 5s, 10-min warning)
* [ ] Classify commands into lock-required vs lock-free categories
* [ ] Support `--no-lock` flag for explicit opt-out
* [ ] Write optional metadata file for diagnostics
* [ ] Ensure lock base directory uses local filesystem (not NFS)
* [ ] Add integration tests for concurrent access scenarios

## Security Considerations

* **Lock directory permissions**: Create with mode 0700 to prevent other users
  from reading metadata or tampering with PID files.
* **Symlink attacks**: Before reclaiming a stale lock, verify that the lock path
  is a real directory (not a symlink) to prevent symlink-based attacks.
* **PID file integrity**: Validate that the PID file contains only a numeric
  value before using it in any system call.
