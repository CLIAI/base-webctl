---
id: p06y
title: "Shared Process-Mutex Factory: createProcessMutex(C)"
category: safety
created: "2026-06-24"
updated: "2026-06-24"
status: review
tags: [mutex, concurrency, flock, atomic-mkdir, pid-detection, age-reclaim, constants-seam, consolidation]
tech:
  - name: "Node.js"
    version: ">=22.12"
relates_to: [sm2t, sb7q, xrl4]
depends_on: [v8m2, sm2t]
expands: [v8m2]
similar_to: []
---

# Shared Process-Mutex Factory: `createProcessMutex(C)`

> **Expands `v8m2`** (Process Mutex: Filesystem-Based Serialization). `v8m2`
> specifies the *mechanism* (flock-primary, mkdir-fallback, PID staleness,
> metadata, wait-progress, exit codes, security). THIS doc specifies the *shared
> base factory* that implements it once for the whole `*-webctl` family, plus the
> two features the live implementations evolved beyond `v8m2`. **No lib lands
> before review** (design-doc-first).

## 1. Why now — the port-mutex is the family's most fragmented surface

The step-3 standards survey (`FUTURE_WORK/migrate/260624-step3-shared-standards-survey.md`)
found the **port/process mutex implemented three incompatible ways, with nothing
in base**:

| Tool | Where | Size | Mechanism | Metadata | Signal cleanup | Age reclaim |
|------|-------|------|-----------|----------|----------------|-------------|
| chatgpt | `lib/mutex.js` | 230 L | mkdir-atomic | `lock.json` (rich) | module-level SIGINT/SIGTERM | no |
| telegram | `lib/mutex.js` | 61 L | mkdir-atomic | bare PID | none | no |
| linkedin | embedded in `linkedin-runner.js` (22.4k-line monolith) | ~180 L | **flock + mkdir fallback** | PID | implicit | **yes (`--lock-max-age`, 15 min)** |
| **base** | — | — | **none** | — | — | — |

Three divergent solutions to one concern is a stronger consolidation case than a
one-only file. The factory's job is to be the **union** of what these evolved,
gated by config so each adopter keeps its current behaviour — then a shim each.

## 2. Factory contract — `createProcessMutex(C, opts)`

sm2t-shaped (`createX(C)`), ESM, zero-dep. `C` injects the shared-identical bits;
`opts` injects test seams and per-call behaviour.

```js
/**
 * @param {ClientConfigConstants} C   // PROJECT, CACHE_DIRNAME, ENV_PREFIX, ...
 * @param {{
 *   assert?: boolean,
 *   lockBaseDir?: string,            // default: <cacheRoot>/locks  (C.CACHE_DIRNAME)
 *   flock?: 'auto'|'on'|'off',       // 'auto' = detect fs-ext/flock, else mkdir (default)
 *   signalCleanup?: boolean,         // register SIGINT/SIGTERM/SIGHUP (mkdir path only). default true
 *   staleByPid?: boolean,            // kill(pid,0) liveness reclaim. default true
 *   staleAgeSec?: number,            // wedged-holder reclaim by mtime. 0 = OFF (default)
 *   metadata?: boolean,              // write lock.json. default true
 *   timeoutMs?: number,              // acquire deadline. default 30_000
 *   retryMs?: number,                // poll interval. default 200
 *   timeoutExitCode?: number,        // dedicated exit code on timeout (C-defined)
 *   fs?, clock?, flockImpl?          // injected seams for hermetic tests
 * }} [opts]
 * @returns {{
 *   acquireLock(port, timeoutMs?, metadata?): Promise<{lockPath, fd?}>,
 *   releaseLock(handle): void,
 *   readLockInfo(port|lockPath): object|null,
 *   getLockPath(port): string,
 *   getLockAgeMs(port|lockPath): number,
 *   isStale(port|lockPath): boolean,    // pid-dead OR (staleAgeSec && age>that)
 *   registerLockCleanup(handle): void,  // no-op unless mkdir path + signalCleanup
 *   clearLockCleanup(): void
 * }}
 */
export function createProcessMutex(C, opts = {}) { /* ... */ }
```

### 2.1 Feature union → config knob mapping

| Feature | Source impl | Knob | Default |
|---------|-------------|------|---------|
| flock-primary + mkdir fallback | linkedin / `v8m2` | `flock:'auto'` | auto |
| mkdir-only (no flock) | chatgpt, telegram | `flock:'off'` | — |
| PID-liveness stale reclaim | all / `v8m2` | `staleByPid:true` | on |
| **age-based wedged reclaim** | linkedin | `staleAgeSec` | **off (0)** |
| rich `lock.json` metadata | chatgpt | `metadata:true` | on |
| signal-handler cleanup (mkdir path) | chatgpt | `signalCleanup:true` | on |
| minimal (no metadata, no signals) | telegram | `metadata:false, signalCleanup:false` | — |
| wait-progress logging | `v8m2` | (built-in, 5s / 600s) | on |
| dedicated timeout exit code | all | `timeoutExitCode` | C-defined |

## 3. The two deltas beyond `v8m2`

### 3.1 Age-based reclaim of a WEDGED-but-alive holder (new; from linkedin)

`v8m2` argues flock makes stale locks impossible because the kernel releases the
advisory lock when a process **crashes/exits**. True — but it does **not** cover a
holder that is **alive yet wedged** (hung on a network read, deadlocked, paused in
a debugger). There flock stays held and `kill(pid,0)` reports "alive", so neither
of `v8m2`'s reclaim paths fires and every waiter blocks to timeout.

linkedin's answer (`getLockAgeMs` + `--lock-max-age`, default 15 min): if the
lock's mtime exceeds `staleAgeSec`, reclaim **regardless of liveness**. This is a
**deliberate, opt-in** override (`staleAgeSec` defaults **0 = off**) because it
trades safety for liveness — only enable it where a single op can't legitimately
hold the lock longer than the threshold. Documented here so it is a first-class,
audited knob, not buried in one tool's monolith.

### 3.2 Unified metadata schema

`v8m2`'s `meta.json` and chatgpt's `lock.json` converge to one shape (superset),
written atomically alongside the lock; absent when `metadata:false` (telegram):

```json
{ "schemaVersion": 1, "pid": 48217, "tool": "<C.PROJECT>", "port": 9222,
  "command": "click", "subcommand": null, "client": null, "startedAt": "<iso>",
  "extra": {} }
```

## 4. Adoption / migration (test-before-bump, `xrl4`)

* **telegram** → re-export shim: `createProcessMutex(C, {flock:'off', metadata:false, signalCleanup:false})` — preserves its 61-line minimal behaviour.
* **chatgpt** → shim: `createProcessMutex(C, {flock:'off', metadata:true, signalCleanup:true})` — preserves its rich `lock.json` + signal handlers. (Gains flock by flipping `flock:'auto'` later, opt-in.)
* **linkedin** → replace the embedded block (`linkedin-runner.js:1309–1432`) with `createProcessMutex(C, {flock:'auto', staleAgeSec: <--lock-max-age>})` — preserves flock + age, and **chips ~180 lines off the 22.4k-line monolith** (a side-win toward de-monolithing the runner).
* Each adoption proven against the consumer's own suite under the real gate
  (`test-all-consumers.sh`) before its pin bumps.

### 4.1 Promote the concurrency harness

linkedin ships the only **real** concurrency proof — `test/concurrency-lock-test.js`
+ `test/lock-helper.js` spawn actual competing processes and synchronise on JSONL
events (mutual exclusion, stale reclaim, age takeover). Promote it to base as the
shared mutex proof so every adopter inherits the same regression coverage, and so
base's own `node --test` exercises the factory under real contention.

## 5. Storage + secret-free

* Lock dir: `<cacheRoot>/locks/port-<PORT>.lock` (mkdir path) /
  `…/port-<PORT>.lock` + `.meta.json` (flock path), under
  `~/.cache/CLIAI/<C.CACHE_DIRNAME>/locks` — local fs only (NFS atomicity caveat,
  `v8m2`). Mode `0700`. Ties into the cacheRoot consolidation (step-3 storage).
* Lock metadata is **diagnostic, not secret** (pid/command/port) — but the lock
  dir is per-user under `~/.cache` and never tracked. No secret-free exposure.
* Security carries over from `v8m2` §Security: verify real-dir (not symlink)
  before reclaim; validate PID file is numeric before any syscall.

## 6. Open questions for review

1. **flock dependency**: linkedin uses the optional `fs-ext` native addon for
   `flock`. base is **zero-runtime-dep** — so the factory's `flock:'auto'` must
   detect `fs-ext` *if the consumer already has it* and otherwise fall back to
   mkdir, **never adding `fs-ext` as a base dep**. Confirm: flock is a
   consumer-provided capability injected via `opts.flockImpl`, not a base import.
2. **Default `flock`**: `'auto'` (prefer flock when available) vs `'off'`
   (mkdir-everywhere, matches 2 of 3 current impls + needs no addon). Recommend
   `'auto'` with the injected-impl rule above; mkdir is the universal floor.
3. **Sequence vs the gateway**: manager set GATEWAY first, mutex second — this doc
   is the design half; lib waits behind the gateway's lib and behind review.
4. Should `staleAgeSec` ship a non-zero default for any tier, or always opt-in?
   (Recommend always opt-in / 0 — safety-first.)
