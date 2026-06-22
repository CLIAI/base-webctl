---
id: 8hw5
title: "Automatic Browser Lifecycle: Zero-Friction Launch, Connect & Cleanup"
category: arch
created: "2026-03-28"
updated: "2026-03-28"
status: draft
tags: [browser-lifecycle, auto-launch, auto-close, zero-friction, user-experience, shared-browser]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: [lf4f, v8m2, 1wsg, v7m2]
depends_on: [lf4f, v8m2]
expands: []
similar_to: []
---

# Automatic Browser Lifecycle: Zero-Friction Launch, Connect & Cleanup

## Principle

**Tools manage the browser; users manage their intent.** A user who runs
`my-webctl send --message "hello"` should never need to manually start a
browser first, pick a port, or remember to close it afterwards. The tool
handles the full lifecycle transparently.

This is the overarching design contract for every `*-webctl` tool:

```
user invokes tool → tool ensures browser exists → tool does work → tool decides if browser should stay
```

No pre-flight manual steps. No post-flight cleanup commands.

## Automatic Launch (Connect-or-Start)

Every browser-interacting command follows a single entry path:

```
function ensureBrowser(client):
    port = resolvePort(client)          # precedence chain (→ 2fc5)
    lock = checkLock(port)              # filesystem lock (→ v8m2)

    if lock.exists AND lock.pidAlive:
        return connectCDP(port)         # reuse running instance

    acquireLock(port)                   # serialize launch
    config = mergeClientConfig(client)  # 4-layer merge (→ lf4f)
    flags  = buildFlags(config)         # launch flags (→ v7m2)
    spawn(config.browser_type, flags)
    waitForCDP(port, timeout=10s)
    return connectCDP(port)
```

### Key Behaviors

* **Idempotent**: calling `ensureBrowser` when browser already runs is a
  no-op connect — no restart, no flag diff check, no user prompt.
* **Lock-serialized**: two tools racing to launch for the same client
  serialize via port lock (→ v8m2). Second caller waits and connects.
* **Client-scoped**: `--client work` and `--client personal` launch
  independent browsers with independent profiles and ports (→ lf4f).
* **Config-driven**: port, profile dir, window size, ozone platform, and
  extra flags all resolve from the merged config — zero hardcoded values
  in the launch path.

## Automatic Cleanup (Close-When-Idle)

The inverse principle: if the ecosystem started the browser, the ecosystem
is responsible for closing it when no tool needs it.

### Reference Counting via Lock Presence

Each connected tool holds a port lock fd (flock) or directory (mkdir
fallback) for the duration of its operation. When the last tool exits:

```
flock holders on port-{PORT}.lock == 0  →  browser is idle
```

**Two strategies, tool-configurable:**

| Strategy | When Browser Closes | Use Case |
|----------|-------------------|----------|
| **eager-close** | Last lock released → close browser | CI, stateless automation, ephemeral profiles |
| **keep-alive** | Browser stays until explicit `base-webctl stop` or system reboot | Interactive use, persistent profiles, shared sessions |

Default: **keep-alive** for persistent profiles, **eager-close** for
ephemeral profiles. Overridable via `--close-on-exit` / `--keep-alive`
flags or `close_policy` in client config.

### Eager-Close Sequence

```
function onToolExit(port, profile):
    releaseLock(port)                     # flock: automatic on fd close
    if closePolicy == "eager":
        if noOtherLockHolders(port):
            sendCDP("Browser.close", port)
            if profile.isEphemeral:
                rmdir(profile.path)       # clean temp profile
```

### Keep-Alive with Garbage Collection

For keep-alive mode, a lightweight reaper prevents browser zombies:

* **Idle timeout**: if no CDP command received for `idle_timeout` (default
  30min, configurable), browser self-closes. Implemented via CDP
  `Browser.close` from a periodic health-check, not via browser flag.
* **Stale lock sweep**: `base-webctl gc` command scans all port locks,
  removes stale entries, and closes browsers with no active consumers.
* **System integration**: optional systemd user timer or cron entry to run
  `base-webctl gc` periodically.

## User Never Sees Infrastructure

### What the User Experiences

```bash
$ my-webctl send --message "hello"
✓ Sent message                          # browser launched silently if needed

$ other-webctl read --thread abc
✓ Thread content: ...                   # connected to same browser (same client)

$ my-webctl send --client work --message "report"
✓ Sent message                          # separate browser for "work" client
```

No `start-browser` step. No `--port` guess. No `stop-browser` cleanup.

### What Happens Underneath

```
my-webctl send                          other-webctl read
     │                                       │
     ▼                                       ▼
 ensureBrowser("default")               ensureBrowser("default")
     │                                       │
     ├── lock port 4327 ◄────────────────────┤ (reuse, already running)
     ├── launch chromium (first time only)    │
     ├── connect CDP :4327                   ├── connect CDP :4327
     ▼                                       ▼
 [do work]                               [do work]
     │                                       │
     ▼                                       ▼
 release lock                            release lock
 (keep-alive: browser stays)             (eager: close if last holder)
```

## Error Recovery

| Failure | Automatic Response |
|---------|-------------------|
| Browser crashed mid-operation | Detect via CDP disconnect → relaunch → retry once |
| Port in use by non-webctl process | Log conflict, try next port in range, warn user |
| Profile directory locked | Wait with progress (→ v8m2), timeout with actionable message |
| Launch timeout (no CDP in 10s) | Kill spawned process, clean lock, report with diagnostic hints |
| Browser binary not found | Exit with clear message: "chromium not found in PATH" |

Single retry on crash. No infinite retry loops. User sees error after
second failure.

## Configuration Surface

All settings resolve via the standard precedence chain (→ 2fc5):

| Setting | Config Key | Env Var | CLI Flag | Default |
|---------|-----------|---------|----------|---------|
| Close policy | `close_policy` | `{ORG}_{TOOL}_CLOSE_POLICY` | `--close-on-exit` / `--keep-alive` | profile-dependent |
| Launch timeout | `launch_timeout` | `{ORG}_{TOOL}_LAUNCH_TIMEOUT` | `--launch-timeout` | 10s |
| Idle timeout | `idle_timeout` | `{ORG}_{TOOL}_IDLE_TIMEOUT` | `--idle-timeout` | 30min |
| Auto-retry on crash | `auto_retry` | `{ORG}_{TOOL}_AUTO_RETRY` | `--no-retry` | true |

## Global Introspection

`base-webctl` as the ecosystem orchestrator provides discovery commands:

| Command | Output |
|---------|--------|
| `base-webctl status` | All clients: name, port, PID, profile path, connected tools, uptime |
| `base-webctl stop [client]` | Graceful close of specific or all client browsers |
| `base-webctl gc` | Sweep stale locks, close idle browsers, remove orphan ephemeral profiles |

These operate across all tools — any `*-webctl` tool's browser is visible
because they share the lock and cache namespace (→ f868).

## Implementation Checklist

* [ ] Implement `ensureBrowser()` connect-or-start flow in base-webctl lib
* [ ] Wire close-policy logic (eager vs keep-alive) with profile-type default
* [ ] Implement single-retry on CDP disconnect (crash recovery)
* [ ] Add `base-webctl status` cross-tool introspection command
* [ ] Add `base-webctl stop` graceful browser shutdown
* [ ] Add `base-webctl gc` stale-lock and idle-browser garbage collection
* [ ] Add `launch_timeout`, `idle_timeout`, `close_policy` to config schema
* [ ] Document zero-friction launch in tool README / `--help` output
