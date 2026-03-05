---
id: v8m2
title: "Process Mutex: Filesystem-Based Serialization for Shared Resources"
category: safety
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [mutex, concurrency, flock, filesystem-lock, atomic-mkdir, pid-detection, shared-resource]
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

## Locking Strategy: `flock` Primary, `mkdir` Fallback

Several locking primitives exist. `flock` (advisory file locking) is the
preferred approach for CLI process-level mutual exclusion on Linux and macOS,
with `mkdir` as a fallback for environments where `flock` is unavailable.

### Comparison of Locking Strategies

| Strategy | Atomicity | Cross-Platform | Zero Deps | Stale Recovery | Notes |
|----------|-----------|----------------|-----------|----------------|-------|
| `flock` / advisory locks | Kernel-level | Linux, macOS, BSDs | Yes | **Auto on close/crash** | **Preferred** |
| `mkdir` | Atomic (EEXIST) | All POSIX + most OS | Yes | Via PID check | Fallback for NFS or unsupported OS |
| PID file (write) | NOT atomic | All | Yes | Via PID check | Race window between check-and-write |
| Named socket | Kernel-level | POSIX only | Yes | Auto on close | Requires socket API; overkill |
| External lock service | N/A | Any | No | Configurable | Heavy dependency; network required |

The key advantage of `flock` is **automatic cleanup**: when a process crashes,
is killed, or exits abnormally, the kernel releases the advisory lock
immediately. This eliminates the entire class of stale-lock problems that
plague PID-file and `mkdir`-based approaches. No signal handlers are needed
for lock cleanup, and no stale-lock detection logic is required.

`mkdir` remains available as a fallback for environments where `flock` is
unavailable (e.g., certain networked filesystems, exotic OS targets). When
`mkdir` is used, the stale-lock detection and signal-handler mechanisms
described in later sections apply.

## Architecture

### Lock File Layout

```
{cache_root}/locks/port-{PORT}.lock       # flock target file
{cache_root}/locks/port-{PORT}.meta.json  # optional: structured metadata
```

**Per-port isolation**: each controllable instance (identified by its
communication port) gets an independent lock file. This allows parallel
operation across distinct instances while serializing access within a single
instance.

### Lock Lifecycle (flock-based)

```
  ┌────────────┐
  │  Acquire   │
  │  open()    │
  │  flock()   │
  ├────────────┤
  │ WOULDBLOCK?│──yes──► Wait / Timeout (flock with timeout or poll)
  │            │
  │ success    │──► Write metadata ──► Execute command
  │            │
  └────────────┘
        │
        ▼ (on exit, signal, crash, or error)
  ┌────────────┐
  │  Release   │
  │  close(fd) │  ◄── automatic on process exit/crash
  └────────────┘
```

### Acquisition Algorithm (flock)

```
function acquireLock(lockFile, timeout):
    fd = open(lockFile, O_CREAT | O_RDWR, 0600)
    deadline = now() + timeout

    while now() < deadline:
        result = flock(fd, LOCK_EX | LOCK_NB)   # non-blocking exclusive lock
        if result == SUCCESS:
            writeFile(lockFile + ".meta.json", {
                pid: currentPID, command, target, startedAt
            })
            return fd                            # caller closes fd to release

        if waitElapsed % 5s == 0:
            meta = readMetadata(lockFile)
            log("Waiting for lock held by PID {meta.pid} ({elapsed}s)")
        if waitElapsed >= 600s:
            log("WARNING: lock held for over 10 minutes")

        sleep(retryInterval)

    close(fd)
    return LOCK_TIMEOUT                          # dedicated exit code
```

### Release

With `flock`, release is automatic: closing the file descriptor releases the
lock. This happens on:

* Normal command completion (fd closed explicitly or via scope exit)
* Uncaught exception / fatal error (process exits, kernel closes all fds)
* Signals: SIGINT, SIGTERM, SIGHUP, SIGKILL (kernel closes all fds)
* Process crash (kernel closes all fds)

No signal handlers are needed for lock cleanup. This eliminates the primary
source of stale locks.

### Fallback: mkdir-based Locking

When `flock` is unavailable (detected at startup), the implementation falls
back to `mkdir`-based locking with PID-file stale detection:

```
function acquireLockMkdir(lockDir, timeout):
    deadline = now() + timeout

    while now() < deadline:
        try:
            mkdir(lockDir)                   # atomic
            writeFile(lockDir/pid, currentPID)
            writeFile(lockDir/meta.json, {
                command, target, startedAt
            })
            registerSignalHandlers(releaseLockMkdir)
            return SUCCESS
        catch EEXIST:
            holderPID = readFile(lockDir/pid)

            if not processExists(holderPID):
                log("Stale lock from PID {holderPID}, reclaiming")
                removeLockDir(lockDir)        # rm contents + rmdir
                continue                      # retry immediately

            sleep(retryInterval)

    return LOCK_TIMEOUT
```

Signal handlers for `releaseLockMkdir` are only needed in this fallback path.

## Stale Lock Detection (mkdir fallback only)

With `flock`, stale locks cannot occur -- the kernel releases advisory locks
automatically. This section applies only to the `mkdir` fallback path.

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

Any command that interacts with the browser resource requires the exclusive
lock. Even read-only CDP operations (status checks, DOM queries) can interfere
with in-progress mutations by altering timing or triggering side effects.

| Classification | Requires Lock | Examples |
|----------------|---------------|----------|
| **Browser-interacting** | Yes | click, type, navigate, status, screenshot, health-check |
| **Local-only / offline** | No | help, version, config, set-option |
| **Cache-only** | No | Any command with `--cache-only` (reads cached data, no browser) |
| **Explicit opt-out** | No | Any command with `--no-lock` flag |

The `--no-lock` flag provides an escape hatch for advanced users who understand
the concurrency risks. The `--cache-only` flag is inherently lock-free since it
does not touch the browser resource.

## Configuration Parameters

| Parameter | Environment Variable | Default | Description |
|-----------|---------------------|---------|-------------|
| `lock_timeout` | `WEBCTL_LOCK_TIMEOUT` | 30s | Maximum wait before returning timeout exit code |
| `retry_interval` | `WEBCTL_LOCK_RETRY_INTERVAL` | 200ms | Polling interval when lock is held |
| `lock_base_dir` | `WEBCTL_LOCK_BASE_DIR` | `$XDG_CACHE_HOME/webctl/locks/` | Base directory for lock files |
| `lock_metadata` | `WEBCTL_LOCK_METADATA` | true | Whether to write `.meta.json` alongside lock |
| `progress_interval` | `WEBCTL_LOCK_PROGRESS_INTERVAL` | 5s | How often to log wait-progress messages |
| `long_wait_threshold` | `WEBCTL_LOCK_LONG_WAIT_THRESHOLD` | 600s | Elapsed time before emitting "possibly stuck" warning |

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

With `flock`, signal handlers are **not required for lock cleanup** -- the
kernel releases advisory locks when the process exits for any reason, including
signals. This is a major simplification over `mkdir`-based locking.

Signal handlers may still be registered for other purposes (e.g., graceful
shutdown of the browser session), but lock release is not among them.

### mkdir fallback only

When using the `mkdir` fallback, register handlers for lock cleanup:

```
SIGINT   (Ctrl+C)        -> releaseLockMkdir() then exit(130)
SIGTERM  (kill default)   -> releaseLockMkdir() then exit(143)
SIGHUP   (terminal close) -> releaseLockMkdir() then exit(129)
```

Handlers should:

1. Release the lock (idempotent -- safe to call even if not held)
2. Re-raise or exit with the conventional 128+signal code
3. Avoid complex logic that could itself fail or deadlock

## Implementation Checklist

* [ ] Define lock file path convention with per-port isolation
* [ ] Implement `flock`-based acquisition with non-blocking retry loop
* [ ] Detect `flock` availability at startup; fall back to `mkdir` if unavailable
* [ ] (mkdir fallback) Implement atomic `mkdir`-based acquisition with EEXIST handling
* [ ] (mkdir fallback) Write PID file immediately after successful `mkdir`
* [ ] (mkdir fallback) Implement stale lock detection via zero-signal (`kill(pid, 0)`)
* [ ] (mkdir fallback) Register SIGINT/SIGTERM/SIGHUP handlers for cleanup
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
