---
id: 1wsg
title: "Tab Lifecycle Management: Discovery, Deduplication, LRU Cleanup & Safe Close"
category: ux
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [tab-management, lru, cleanup, deduplication, safe-close, resource-management]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Tab Lifecycle Management: Discovery, Deduplication, LRU Cleanup & Safe Close

## Motivation

Browser-automation CLI tools that operate across multiple resources accumulate
tabs over time. Without lifecycle management, the browser becomes an unbounded
resource sink: memory climbs, CDP target lists grow unwieldy, and the user's
manual tabs get buried under automation debris.

This document defines a unified tab lifecycle covering four concerns:

* **Discovery** -- finding an existing tab that matches the target resource
* **Deduplication** -- eliminating redundant tabs for the same resource
* **LRU cleanup** -- reclaiming stale tabs using least-recently-used eviction
* **Safe close** -- ensuring the browser is never left in an unusable state

All patterns are service-agnostic. "Resource" means any URL-addressable page
the CLI tool might open or interact with.

---

## 1. The `ensureCorrectTab()` 4-Path Flow

Every command that needs a browser tab begins by calling `ensureCorrectTab()`.
This function resolves the target tab through exactly four paths, tried in
order:

```
┌──────────────────────────────────────────────┐
│            ensureCorrectTab(url)              │
├──────────────────────────────────────────────┤
│                                              │
│  Path 1: Exact match                         │
│    CDP.Target.list() → match by canonical ID │
│    ✓ activate & return                       │
│                                              │
│  Path 2: Prefix / partial match              │
│    Match by origin + path prefix             │
│    ✓ navigate to exact URL, return           │
│                                              │
│  Path 3: Duplicate consolidation             │
│    Multiple tabs match → dedup (see §2)      │
│    ✓ keep best, close rest, return           │
│                                              │
│  Path 4: No match — open fresh               │
│    CDP.Target.createTarget(url)              │
│    ✓ register in activity ledger, return     │
│                                              │
└──────────────────────────────────────────────┘
```

### Implementation sketch

```python
async def ensure_correct_tab(
    cdp: CDPSession,
    target_url: str,
    canonical_fn: Callable[[str], str],
) -> TargetInfo:
    """Resolve a tab for target_url through the 4-path flow.

    Args:
        cdp: Active CDP session.
        target_url: The URL the command needs.
        canonical_fn: Extracts the canonical identifier from a URL.

    Returns:
        TargetInfo for the activated (or newly created) tab.
    """
    targets = await cdp.send("Target.getTargets")
    target_id = canonical_fn(target_url)
    matches = []

    for t in targets["targetInfos"]:
        if t["type"] != "page":
            continue
        if canonical_fn(t["url"]) == target_id:
            matches.append(t)

    # Path 1: Single exact match
    if len(matches) == 1:
        await activate_tab(cdp, matches[0]["targetId"])
        touch_activity(matches[0]["targetId"])
        return matches[0]

    # Path 3: Multiple matches — deduplicate
    if len(matches) > 1:
        keeper = pick_best_tab(matches)
        await close_duplicates(cdp, matches, keep=keeper)
        await activate_tab(cdp, keeper["targetId"])
        touch_activity(keeper["targetId"])
        return keeper

    # Path 2: Partial / prefix match
    partial = find_partial_match(targets["targetInfos"], target_url)
    if partial:
        await cdp.send("Page.navigate", {"url": target_url},
                        sessionId=partial["sessionId"])
        touch_activity(partial["targetId"])
        return partial

    # Path 4: No match — open fresh
    result = await cdp.send("Target.createTarget", {"url": target_url})
    new_id = result["targetId"]
    touch_activity(new_id)
    return await get_target_info(cdp, new_id)
```

The function is **idempotent**: calling it twice with the same URL returns the
same tab (barring external interference).

---

## 2. Deduplication Strategy

### Philosophy: Close All, Open Fresh

When multiple tabs correspond to the same canonical resource, the safest
strategy is:

1. Open **one** fresh tab at the canonical URL.
2. Close **all** previously matching tabs.

The fresh tab is opened **before** closing duplicates to guarantee at least one
tab remains open at all times (see §7 Safe Close Invariant). This avoids the
complexity of choosing which duplicate has the "best" state (some may have
stale DOM, pending navigations, or detached frames).

```python
async def deduplicate_tabs(
    cdp: CDPSession,
    matches: list[TargetInfo],
    canonical_url: str,
) -> TargetInfo:
    """Close all duplicates and open a single fresh tab.

    Opens the fresh tab BEFORE closing duplicates to guarantee at least
    one tab remains open at all times (see §7 Safe Close Invariant).
    """
    # Open fresh tab first — ensures we never hit the last-tab invariant
    result = await cdp.send("Target.createTarget", {"url": canonical_url})
    new_target = await get_target_info(cdp, result["targetId"])
    touch_activity(result["targetId"])

    # Now safe to close all duplicates
    for m in matches:
        await safe_close_tab(cdp, m["targetId"])

    return new_target
```

### When "pick best" is acceptable

For resource types where page state is expensive to rebuild (e.g., a page with
a long-running form fill), the CLI may instead keep the most recently active
tab and close the rest. The `pick_best_tab()` helper selects by last-activity
timestamp from the ledger:

```python
def pick_best_tab(matches: list[TargetInfo]) -> TargetInfo:
    """Return the match with the most recent activity timestamp."""
    ledger = load_activity_ledger()
    return max(
        matches,
        key=lambda t: ledger.get(t["targetId"], {}).get("last_active", 0),
    )
```

---

## 3. Canonical Identifier per Resource Type

A canonical identifier is a stable, normalized string that uniquely identifies
a resource regardless of URL variations (query params, fragments, trailing
slashes, session tokens).

### Design principles

* Derived **solely from URL structure** -- no DOM inspection needed.
* Stable across sessions -- same resource always produces the same ID.
* Configured per resource type via a mapping table.

### Canonical ID table (example schema)

```python
CANONICAL_RULES: dict[str, Callable[[ParseResult], str]] = {
    # Social feed: origin is sufficient
    "feed": lambda u: u.netloc,

    # Messaging thread: origin + path segment identifies the conversation
    "conversation": lambda u: f"{u.netloc}{u.path.rstrip('/')}",

    # Document editor: origin + doc-id query param
    "document": lambda u: f"{u.netloc}?id={parse_qs(u.query).get('id', [''])[0]}",

    # Dashboard: origin + first two path segments
    "dashboard": lambda u: f"{u.netloc}/{'/'.join(u.path.strip('/').split('/')[:2])}",
}

def canonical_id(url: str, resource_type: str) -> str:
    """Normalize a URL to its canonical identifier."""
    parsed = urlparse(url)
    rule = CANONICAL_RULES.get(resource_type)
    if rule is None:
        # Default: origin + full path, no query/fragment
        return f"{parsed.netloc}{parsed.path.rstrip('/')}"
    return rule(parsed)
```

### Extending canonical rules

New resource types add a single entry to `CANONICAL_RULES`. The CLI
configuration file exposes this as:

```toml
[resource_types.my_app]
canonical = "origin_path"   # built-in strategy
url_pattern = "example.com/app/*"
```

---

## 4. Activity Tracking with Atomic JSON Writes

Every tab interaction updates an **activity ledger** -- a JSON file that
records when each tab was last used. This ledger drives LRU eviction.

### Ledger format

```json
{
  "version": 1,
  "tabs": {
    "TARGET_ID_A": {
      "url": "https://example.com/page-a",
      "canonical_id": "example.com/page-a",
      "last_active": 1709420400,
      "created": 1709416800,
      "command": "read",
      "protected": false
    },
    "TARGET_ID_B": {
      "url": "https://example.com/page-b",
      "canonical_id": "example.com/page-b",
      "last_active": 1709410000,
      "created": 1709400000,
      "command": "send",
      "protected": true
    }
  }
}
```

### Atomic write pattern

Writes must be atomic to prevent corruption if the CLI is interrupted
mid-write (e.g., `SIGTERM` during cleanup). The standard approach:

```python
import json
import os
import tempfile
from pathlib import Path

LEDGER_PATH = Path.home() / ".config" / "webctl" / "tab_activity.json"

def save_ledger(data: dict) -> None:
    """Atomically write the activity ledger."""
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=LEDGER_PATH.parent,
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, LEDGER_PATH)  # atomic on POSIX
    except BaseException:
        os.unlink(tmp_path)
        raise

def touch_activity(target_id: str, **kwargs) -> None:
    """Update last_active timestamp for a tab."""
    import time
    ledger = load_activity_ledger()
    entry = ledger.setdefault("tabs", {}).setdefault(target_id, {})
    entry["last_active"] = int(time.time())
    entry.update(kwargs)
    save_ledger(ledger)
```

Key properties:

* `tempfile.mkstemp` + `os.replace` guarantees atomicity on POSIX.
* `os.fsync` ensures data reaches disk before the rename.
* On write failure, the temporary file is cleaned up; the old ledger survives.

---

## 5. Tiered LRU Cleanup

Cleanup runs automatically after each command unless suppressed by `--force`
(see section 7). Eviction uses a **tiered age-count policy**: a list of
`(max_age, max_count)` pairs that form a decay curve. More tabs are allowed
if they are fresh; fewer are tolerated as they age.

### Tiered policy

The policy is a list of `(age_threshold, max_tabs)` pairs, sorted by age
ascending. Each tier says: "tabs older than `age_threshold` seconds are
allowed up to `max_tabs` count." Tabs exceeding any tier's limit are evicted
oldest-first.

Default tiers:

| Age threshold | Max tabs | Meaning                              |
|---------------|----------|--------------------------------------|
| 10 min        | 15       | Up to 15 tabs younger than 10 min    |
| 30 min        | 10       | Up to 10 tabs younger than 30 min    |
| 2 hours       | 5        | Up to 5 tabs younger than 2 hours    |
| 8 hours       | 2        | Up to 2 tabs younger than 8 hours    |
| ∞ (fallback)  | 0        | Everything older than 8h is evicted  |

This means a burst of 15 fresh tabs is fine, but they must decay to 10 within
30 minutes, 5 within 2 hours, etc.

### Algorithm

```python
import time

DEFAULT_TIERS = [
    (10 * 60,    15),   # 10 min → max 15
    (30 * 60,    10),   # 30 min → max 10
    (2 * 3600,    5),   # 2h     → max 5
    (8 * 3600,    2),   # 8h     → max 2
]

async def lru_cleanup(
    cdp: CDPSession,
    tiers: list[tuple[int, int]] = DEFAULT_TIERS,
) -> int:
    """Evict tabs using tiered age-count policy. Returns count closed."""
    ledger = load_activity_ledger()
    now = int(time.time())
    tabs = ledger.get("tabs", {})

    # Separate protected from evictable
    evictable = []
    for tid, info in tabs.items():
        if is_protected(tid, info):
            continue
        age = now - info.get("last_active", 0)
        evictable.append((tid, info, age))

    # Sort by age descending (oldest first = evict first)
    evictable.sort(key=lambda x: x[2], reverse=True)

    to_close = set()

    # Apply each tier: count tabs within that age band
    for max_age, max_count in sorted(tiers, key=lambda t: t[0]):
        within_tier = [
            (tid, info, age) for tid, info, age in evictable
            if age <= max_age and tid not in to_close
        ]
        # All tabs older than this tier's threshold that haven't been
        # claimed by a tighter tier are candidates for eviction
        older_than_tier = [
            (tid, info, age) for tid, info, age in evictable
            if age > max_age and tid not in to_close
        ]
        for tid, info, age in older_than_tier:
            to_close.add(tid)

    # Fallback: evict anything not covered by any tier
    max_tier_age = max(t[0] for t in tiers) if tiers else 0
    for tid, info, age in evictable:
        if age > max_tier_age:
            to_close.add(tid)

    # Within each tier, if count exceeds max, evict oldest
    for max_age, max_count in sorted(tiers, key=lambda t: t[0]):
        within = [
            (tid, info, age) for tid, info, age in evictable
            if age <= max_age and tid not in to_close
        ]
        if len(within) > max_count:
            # Sort oldest first within this tier
            within.sort(key=lambda x: x[2], reverse=True)
            for tid, info, age in within[: len(within) - max_count]:
                to_close.add(tid)

    closed = 0
    for tid in to_close:
        await safe_close_tab(cdp, tid)
        tabs.pop(tid, None)
        closed += 1

    save_ledger(ledger)
    return closed
```

### Configuration

Tiers are configurable via environment variable (JSON) or CLI flag:

```bash
# Environment variable — JSON array of [age_seconds, max_count] pairs
export WEBCTL_LRU_TIERS='[[600,15],[1800,10],[7200,5],[28800,2]]'

# CLI flag (per-invocation override)
webctl read --lru-tiers '[[300,20],[3600,10]]' "https://example.com/page"

# Or use simple max-tabs / max-age for single-tier behavior
export WEBCTL_MAX_TABS=10
export WEBCTL_MAX_AGE=7200
```

---

## 6. Protected Tabs

Certain tabs must never be evicted by LRU cleanup. A tab is protected if any
of the following hold:

| Protection rule        | Description                                          |
|------------------------|------------------------------------------------------|
| **Current tab**        | The tab actively used by the running command          |
| **Explicit flag**      | `"protected": true` set in the activity ledger       |
| **Permission dialog**  | Tab showing a permission prompt (camera, location)   |
| **User-owned**         | Tab not created by the CLI (not in ledger at all)    |

```python
def is_protected(target_id: str, info: dict) -> bool:
    """Determine whether a tab is exempt from LRU eviction."""
    # Explicit protection flag
    if info.get("protected", False):
        return True

    # Current command's active tab (set by ensureCorrectTab)
    if target_id == os.environ.get("WEBCTL_ACTIVE_TAB"):
        return True

    # Tabs with pending permission dialogs
    if info.get("has_dialog", False):
        return True

    return False
```

Tabs not present in the ledger are assumed user-owned and are **never touched**
by any cleanup or deduplication logic.

**Important**: This protection extends to `ensureCorrectTab()` deduplication.
When the 4-path flow discovers multiple tabs matching a canonical ID, it must
filter out tabs absent from the activity ledger before closing duplicates.
A user who manually opened a matching URL must not have their tab closed by
automation. The dedup logic should only close tabs it owns (i.e., those
present in the ledger).

---

## 7. Safe Close Invariant

**The CLI must never close the last remaining tab in the browser.**

Closing the last tab in most browsers triggers the browser process to exit,
destroying the CDP connection and any unsaved state in other windows. The safe
close function enforces this invariant:

```python
class LastTabError(RuntimeError):
    """Raised when attempting to close the browser's only remaining tab."""
    pass

async def safe_close_tab(cdp: CDPSession, target_id: str) -> bool:
    """Close a tab, but refuse if it is the last one.

    Returns:
        True if the tab was closed, False if it was already gone.

    Raises:
        LastTabError: If closing this tab would leave zero tabs.
    """
    targets = await cdp.send("Target.getTargets")
    page_targets = [t for t in targets["targetInfos"] if t["type"] == "page"]

    if len(page_targets) <= 1:
        raise LastTabError(
            f"Refusing to close tab {target_id}: it is the last remaining tab. "
            "Closing it would terminate the browser process."
        )

    # Verify the target still exists (may have been closed externally)
    if not any(t["targetId"] == target_id for t in page_targets):
        return False  # Already gone

    await cdp.send("Target.closeTarget", {"targetId": target_id})
    return True
```

### Edge cases

* **Race condition**: Between the count check and the close call, another
  process might close a tab. The invariant is best-effort; the CDP close call
  itself will fail gracefully if the target no longer exists.
* **Multiple windows**: The count considers all tabs across all windows. Even
  if a window has one tab, closing it is safe if other windows have tabs.

---

## 8. `--force` Flag: Suppressing Cleanup

When `--force` is passed, the CLI skips the post-command LRU cleanup phase
entirely. This is useful for batch operations where the user wants maximum
speed and will clean up manually afterward.

```python
async def run_command(args: Namespace) -> int:
    """Main command entry point."""
    tab = await ensure_correct_tab(cdp, args.url, get_canonical_fn(args))

    result = await execute_action(cdp, tab, args)

    if not args.force:
        closed = await lru_cleanup(cdp)
        if closed > 0:
            log.info(f"LRU cleanup: closed {closed} stale tab(s)")

    return result
```

What `--force` does **not** suppress:

* Deduplication during `ensureCorrectTab()` (duplicates cause correctness
  issues, not just resource waste).
* The safe-close invariant (this is a safety property, not a performance
  optimization).

---

## 9. Lifecycle Summary

```
  Command invocation
         │
         ▼
  ┌─────────────────┐
  │ ensureCorrectTab │─── Path 1-4: discover / dedup / open
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ Execute action   │─── touch_activity() on each interaction
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐     ┌─────────────┐
  │ --force set?     │──Y──│ Skip cleanup │
  └────────┬────────┘     └─────────────┘
           │ N
           ▼
  ┌─────────────────┐
  │ LRU cleanup      │─── time-based + count-based eviction
  │  (safe close)    │─── never close last tab
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ Save ledger      │─── atomic JSON write
  └─────────────────┘
```

---

## 10. Design Decisions and Rationale

**Why "close all, open fresh" for dedup?**
Stale DOM state in duplicate tabs can cause subtle command failures.
Navigating an existing tab risks hitting cached service-worker responses. A
fresh tab guarantees a clean starting point.

**Why a file-based ledger instead of in-memory state?**
CLI invocations are short-lived processes. State must persist across
invocations. A JSON file is inspectable, debuggable, and trivially portable.

**Why atomic writes?**
The CLI may be killed at any time (user Ctrl-C, OOM killer, system shutdown).
A corrupted ledger would break all subsequent invocations. The
write-to-temp + rename pattern eliminates this risk at near-zero cost.

**Why a tiered age-count policy instead of a single threshold?**
A single `MAX_TABS` allows ancient tabs to persist if the count is low. A
single `MAX_AGE` allows unbounded accumulation during a burst. Tiered policies
`[(age, count), ...]` form a decay curve: fresh bursts are tolerated (15 tabs
under 10 min), but must decay over time (5 tabs after 2 hours). This matches
real usage patterns where active sessions produce many tabs briefly, while
long-idle tabs are safe to reclaim.

**Why never close user-owned tabs?**
The CLI operates as a guest in the user's browser. Closing tabs the user
opened manually would violate the principle of least surprise and erode trust
in the tool.
