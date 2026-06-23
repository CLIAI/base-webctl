# Step-3 groundwork survey — shared-standards: locking + storage layout

* **Category:** migrate (step-3 shared-standards groundwork; manager-directed)
* **Created:** 2026-06-24
* **By:** `webctl:base` (2 parallel read-only surveys + targeted verification)
* **Status:** SURVEY ONLY — no extraction. Feeds a base-standards decision +
  the future new-tool scaffold. Design-doc-first still applies before any lib lands.
* **Scope verified present:** base, chatgpt, linkedin, telegram. **fetlife-webctl
  is registered in `consumers.jsonc` but NOT checked out locally** — the gate
  already SKIPs it "repo not present"; its surface is unsurveyed.
* **Refs:** `safety-process-mutex-v8m2` (draft), `safety-blocked-state-handling-k7m2`
  (draft), `infra-directory-structure-f868` (draft), `infra-client-profile-registry-lf4f`
  (draft), `arch-constants-injection-seam-sm2t`.

---

## A. Locking / critical-section surface

### Taxonomy — FOUR distinct locking concerns

| # | Concern | Resource | Base today | Spread | Verdict |
|---|---------|----------|-----------|--------|---------|
| 1 | **Profile-dir lock** | one Chromium profile dir, cross-mode | ✅ `createProfileLock(C)` shipped | linkedin adopts (shim); chatgpt/telegram don't use it | **DONE** — keep |
| 2 | **Port/process mutex** | a CDP port (one browser instance) per CLI invocation | ❌ **none in base** | **3-way FRAGMENTED** | **TOP consolidation candidate** |
| 3 | **Blocked-state lock** | global "automation is blocked" flag | ❌ none in base | chatgpt-only | **2nd candidate (one-only)** |
| 4 | **Age-based stale reclaim** | wedged port-mutex by mtime | ❌ none | linkedin-only | folds into #2 |

### #2 Port-mutex — the fragmentation (verified)

* **chatgpt** `lib/mutex.js` — **230 lines**. mkdir-atomic; `lock.json` metadata
  {pid,command,subcommand,chatId,model,port,client,startedAt}; module-level
  SIGINT/SIGTERM cleanup handlers; old-`pid`-file back-compat.
* **telegram** `lib/mutex.js` — **61 lines**. mkdir-atomic, bare PID file, no
  signal handlers, `process.exit(3)` on timeout. The minimal sibling.
* **linkedin** — **embedded in `linkedin-runner.js` (22,400-line monolith)**,
  lock fns at `:1309 tryFlockAcquire`, `:1348 getLockAgeMs`, `:1357 acquireLock`,
  `:1419 releaseLock`. The most-evolved: **flock-primary (`fs-ext`) + mkdir
  fallback + age-based stale reclaim** (`--lock-max-age`, default 15 min).
* **base** — nothing. Design doc `v8m2` already specs flock-primary + mkdir-fallback
  + PID staleness (no age threshold).

→ Not "one-only" (the manager's note said mutex.js was a one-only candidate — it is
actually **three divergent implementations of the same concern**, which *strengthens*
the consolidation case). The **union of features** is the target API: flock+mkdir
(linkedin) ∪ metadata+signal-cleanup (chatgpt) ∪ age-reclaim (linkedin), minimal
mode (telegram).

**Candidate base module:** `createProcessMutex(C, opts)` (sm2t factory, ESM, zero-dep).
```
opts: { lockBaseDir?, flockFallback=true, signalCleanup=true,
        staleByPid=true, staleAgeSec=0 /*0=off*/, metadataFields? }
returns: { acquireLock(port, timeoutMs, metadata?), releaseLock(lockPath),
           readLockInfo, getLockPath, getLockAgeMs, isStale,
           registerLockCleanup, clearLockCleanup }
```
Adoption: telegram → shim (signalCleanup:false); chatgpt → shim (metadata on);
linkedin → replace the embedded block (also chips at the 22.4k monolith). Promote
linkedin's **real concurrency harness** (`test/concurrency-lock-test.js` +
`test/lock-helper.js` — spawns real processes, syncs on JSONL) into base as the
shared proof.

### #3 Blocked-state lock — genuinely one-only (chatgpt)

* `chatgpt/lib/blocked-lock.js` + `tests/unit/blocked-lock.test.js`. JSON lock at
  `~/.cache/CLIAI/.../blocked.lock.json`; fail-fast `checkBlockedLockAndExit()`
  (exit 2); human-in-the-loop release (`--verify`). Matches design doc `k7m2`.
* linkedin has **inline** blocked-state checks in its runner but **no persistent
  lock**; telegram none. → Candidate `createBlockedStateLock(C, opts)`; lower
  priority than #2 (coupling to each tool's view/detection pipeline needs a seam).

---

## B. Storage-layout conventions

Mostly **solid + secret-safe**; the gaps are unspecced-de-facto or aspirational-spec.

| Concern | Convention | Reference impl | Uniform? | Divergence |
|---|---|---|---|---|
| Cache root | `~/.cache/CLIAI/<CACHE_DIRNAME>/` | base `mounts.cacheRoot()` | pattern ✅, computation fragmented | consumers reimplement; chatgpt uses a `default/webctl` segment variant |
| Profile dir | `<cacheRoot>/profiles/<slug>/chromium` + userDataDir override | base `mounts.resolveChromiumProfile()` | ✅ | — |
| Upload staging | `<cacheRoot>/uploads/<slug>` + `/cliai-uploads` | chatgpt `file-staging.js` | chatgpt-only | base now gates the mount on `uploadHostPath` (v0.5.0); host-side staging stays consumer-owned |
| Logs | `<cacheRoot>/logs/{iso-ts}-{pid}.jsonl` (rotated) | each `logging.js` | ✅ | — |
| Port locks | `<cacheRoot>/locks/port-<PORT>.lock/` | the fragmented mutexes (§A#2) | mostly | ties to the mutex consolidation |
| Profile lock | `.<PROJECT>.lock.json` in profile | base `profile-lock.js` | ✅ | — |
| Config merge | `~/.config/CLIAI/<client>/webctl/<tool>.config.jsonc`, 4-layer | base `client-config.js` (lf4f) | ✅ | — |
| Dotenv | `.env.<tool>` + `.example` | per-repo constants | ✅ naming | **location**: spec `f868` says `~/.config/CLIAI/...`, actual is project-root (low risk) |
| Env prefix | `CLIAI_<TOOL>_` | per-repo constants | ✅ | linkedin keeps a legacy `LINKEDIN_WEBCTL_` (intended) |
| XDG overrides | `XDG_CACHE_HOME`/`XDG_CONFIG_HOME` | **speced in f868, implemented NOWHERE** | ❌ | all hardcode `$HOME` |

### Secret-safety (verified)

* Secrets live ONLY outside git: profiles under `~/.cache/CLIAI/.../profiles/...`
  or user `~/priv/...`; `.env.<tool>`; config under `~/.config/CLIAI/...`. **No
  secrets in any tracked tree.** All example configs use `~/priv/` user-owned paths;
  base's "never default a profile into a publishable location" rule is honored.
* Minor: chatgpt `.gitignore` lacks an explicit `credentials*/cookies*` pattern
  (LOW risk — `.env.*` + profile isolation already cover it). Worth folding into the
  shared `.gitignore` template (f868) for the scaffold.

---

## C. Candidate base standards for the new-tool scaffold

**Already solid (scaffold stamps these, all base-owned via sm2t):** cache-root +
profile-dir (`mounts`), profile-lock (`createProfileLock`), config 4-layer merge
(`createClientConfig`), JSONL logging convention, dotenv/env-prefix naming,
`.gitignore` template (f868), browser-location chain (v0.4/v0.5).

**Gaps to close before the scaffold is "stamp and go":**
1. **`createProcessMutex(C)`** — the missing base primitive; 3 fragmented impls to
   converge. *Highest value.*
2. **`.gitignore` template hardening** — add explicit `credentials*/cookies*`; make
   f868 the single source the scaffold copies.
3. **(optional) `createBlockedStateLock(C)`** — promote chatgpt's, seam linkedin's
   inline checks. Lower priority.
4. **XDG resolution layer** — `f868` specs it, nothing implements it. Decide:
   implement in base path-resolution, or downgrade the spec to "future."
5. **Dotenv location** — reconcile spec (`~/.config/...`) vs de-facto (project-root).

---

## D. Open questions for manager / Greg (no extraction started)

1. **Sequence:** do `createProcessMutex` first (clear win, 3-way converge, chips the
   linkedin monolith), or hold all of step-3 until the **new-tool scaffold** shape is
   decided so standards are designed against it?
2. **Blocked-state lock:** base primitive now, or leave chatgpt-owned until a 2nd
   tool needs it (telegram/fetlife are cdp-client/contracts tier — may never)?
3. **XDG + dotenv-location spec drift:** implement, or downgrade `f868` to match
   reality? (Affects what the scaffold promises.)
4. **fetlife-webctl** is registered but absent locally — pull it for a complete
   survey, or treat as out-of-scope until it wires the submodule?
5. Design-doc-first: each "candidate" above wants a short design doc before lib —
   confirm that gate before I draft any.
