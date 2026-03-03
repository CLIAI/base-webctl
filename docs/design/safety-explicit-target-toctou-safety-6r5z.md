---
id: 6r5z
title: "Explicit Target Identification & TOCTOU Prevention"
category: safety
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [toctou, race-condition, explicit-target, identity-pinning, multi-user, concurrency]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Explicit Target Identification & TOCTOU Prevention

## 1. Problem Statement

Web-control CLI tools operate on views (pages, tabs, panels) that can change
between the moment a user inspects state and the moment they issue a command.
This is the classic **Time-of-Check to Time-of-Use (TOCTOU)** problem, applied
to browser automation.

Consider:

```
# User sees "Inbox" in tab 1, decides to archive a message
$ webctl list-views
  [0] Inbox - messaging platform
  [1] Dashboard - analytics

# Another process or the user themselves navigates tab 0 away
# ...time passes...

$ webctl archive --view 0 --message-id 42
# Tab 0 is now "Settings" -- command silently targets the wrong view
```

The root cause: **implicit "current state" targeting assumes stability in an
inherently unstable environment**. Index-based or "active tab" targeting is
fragile because:

* Other automation agents may navigate views concurrently
* Background scripts, redirects, or user actions change view state
* Multi-user shared browser sessions (e.g., remote debugging) have no coordination
* Pipelines with multiple steps have unavoidable time gaps between steps

### Why This Matters Beyond Safety

Explicit targeting is not merely a guard -- it is an **enabler**. When a command
declares exactly what it expects to find, the framework can:

* **Auto-route** to the correct view even if indices have shifted
* **Retry intelligently** by searching for the expected context
* **Parallelize** safely because commands are self-describing
* **Audit** every action with full provenance (what was targeted, what was found)

## 2. Design Principles

1. **Explicit over implicit** -- Commands that mutate state must declare what
   they expect to find, not just where to find it.
2. **Asymmetric enforcement** -- Writes are strict (fail if mismatch), reads
   are lenient (warn but proceed).
3. **Escape hatches exist** -- `--force` overrides for human convenience, but
   is never the default and is logged.
4. **Machine-friendly consolidation** -- Agent pipelines pass all requirements
   in a single structured payload, not scattered flags.
5. **Optimistic concurrency** -- Compare-and-swap semantics for state that
   changes between check and use.

## 3. VIEW_TARGET_CONFIG: Cross-View Assertion Map

### 3.1 Concept

A `VIEW_TARGET_CONFIG` is a declarative map that describes **what a view must
look like** for a command to proceed. Each view type (page, dialog, panel,
embedded frame) registers its own identity properties.

```python
# Conceptual schema -- actual implementation may be YAML, JSON, or code
VIEW_TARGET_CONFIG = {
    "page": {
        "identity_fields": ["url_pattern", "title_pattern", "dom_marker"],
        "required_for_write": ["url_pattern"],  # at least one must match
        "required_for_read": [],                 # advisory only
    },
    "dialog": {
        "identity_fields": ["dialog_type", "title_pattern"],
        "required_for_write": ["dialog_type"],
        "required_for_read": [],
    },
    "panel": {
        "identity_fields": ["panel_id", "panel_label"],
        "required_for_write": ["panel_id"],
        "required_for_read": [],
    },
}
```

### 3.2 How It Works

When a command executes:

1. **Resolve target** -- Look up the view by index, ID, or selector.
2. **Snapshot identity** -- Capture the view's current identity fields.
3. **Assert match** -- Compare the snapshot against the caller's declared
   expectations.
4. **Proceed or abort** -- On mismatch, fail for writes, warn for reads.

```python
def assert_view_target(view, expectations: dict, is_write: bool) -> None:
    """
    Validate that `view` matches `expectations` before proceeding.

    Raises ViewTargetMismatch for writes, logs warning for reads.
    """
    config = VIEW_TARGET_CONFIG[view.type]
    required = config["required_for_write"] if is_write else config["required_for_read"]

    mismatches = []
    for field in config["identity_fields"]:
        expected = expectations.get(field)
        if expected is None:
            if field in required:
                mismatches.append(f"missing required field: {field}")
            continue

        actual = getattr(view, field, None)
        if not matches(actual, expected):
            mismatches.append(
                f"{field}: expected {expected!r}, got {actual!r}"
            )

    if mismatches:
        msg = f"View target mismatch: {'; '.join(mismatches)}"
        if is_write:
            raise ViewTargetMismatch(msg)
        else:
            logger.warning(msg)
```

### 3.3 Pattern Matching for Identity Fields

Identity fields support three matching modes:

| Mode     | Syntax             | Example                          |
|----------|--------------------|----------------------------------|
| Exact    | `"string"`         | `"url_pattern": "/inbox"`        |
| Glob     | `"glob:pattern"`   | `"title_pattern": "glob:*Mail*"` |
| Regex    | `"re:pattern"`     | `"dom_marker": "re:#app-root"`   |

```bash
# CLI usage: target a view whose URL contains /inbox
$ webctl archive --view 0 \
    --expect-url "/inbox" \
    --message-id 42

# If view 0 has navigated away from /inbox, command fails before acting
```

## 4. Asymmetric Enforcement

### 4.1 Rationale

Not all operations carry equal risk. Reading the title of a wrong tab is
annoying; clicking "delete" in a wrong tab is destructive. The enforcement
model reflects this asymmetry.

### 4.2 Enforcement Matrix

| Operation Type | Mismatch Behavior         | Override         |
|----------------|---------------------------|------------------|
| **Write**      | Hard fail, no action      | `--force`        |
| **Read**       | Warn, proceed             | `--strict`       |
| **Navigate**   | Warn, proceed             | `--strict`       |
| **Destructive**| Hard fail, no `--force`   | `--force --force` |

"Destructive" operations (delete, bulk modify, send) require double-force
(`--force --force`) to acknowledge elevated risk. This is intentionally
inconvenient.

### 4.3 Implementation Pattern

```python
class EnforcementLevel:
    NONE = 0       # no checking
    WARN = 1       # log warning, proceed
    FAIL = 2       # raise error, abort
    FAIL_HARD = 3  # raise error, require --force --force

def enforcement_for(operation_type: str, force_count: int) -> EnforcementLevel:
    """Determine enforcement level based on operation type and --force flags."""
    base = {
        "read":        EnforcementLevel.WARN,
        "navigate":    EnforcementLevel.WARN,
        "write":       EnforcementLevel.FAIL,
        "destructive": EnforcementLevel.FAIL_HARD,
    }[operation_type]

    # Each --force downgrades enforcement by one level
    return max(EnforcementLevel.NONE, base - force_count)
```

## 5. The `--force` Escape Hatch

### 5.1 Design Intent

`--force` exists because humans working interactively can see the screen. They
know the tab is correct even if the URL changed due to a redirect. Forcing
them to supply exact expectations every time would make the tool unusable.

However:

* `--force` is **never the default**
* `--force` is **always logged** with full context (what was expected, what was found)
* `--force` in agent/pipeline mode triggers a **mandatory warning** in output
* Double `--force` (`--force --force`) is required for destructive operations

### 5.2 Logging Contract

Every `--force` override produces a structured log entry:

```json
{
    "event": "force_override",
    "timestamp": "2026-03-03T14:22:01Z",
    "command": "archive",
    "view_index": 0,
    "expected": {"url_pattern": "/inbox"},
    "actual": {"url": "/settings/privacy", "title": "Privacy Settings"},
    "force_level": 1,
    "user": "human",
    "session_id": "abc123"
}
```

## 6. Consolidated Requirements for Agent Pipelines

### 6.1 Problem with Flag Proliferation

Agent pipelines constructing commands programmatically face ergonomic issues
with per-field flags:

```bash
# Unwieldy for agents
$ webctl send-message --view 0 \
    --expect-url "/conversations/42" \
    --expect-title "glob:*Chat*" \
    --expect-dom "#message-input" \
    --body "Hello"
```

### 6.2 The `--requirements` Flag

A single `--requirements` (alias: `--required`) flag accepts a JSON object
containing all assertions:

```bash
# Agent-friendly: single structured payload
$ webctl send-message --view 0 \
    --requirements '{"url_pattern": "/conversations/42", "title_pattern": "glob:*Chat*", "dom_marker": "#message-input"}' \
    --body "Hello"
```

Or via file/stdin for complex requirements:

```bash
# From file
$ webctl send-message --view 0 \
    --requirements @requirements.json \
    --body "Hello"

# From stdin (pipe from previous command)
$ webctl inspect-view 0 --output-requirements | \
    webctl send-message --view 0 --requirements @- --body "Hello"
```

### 6.3 Requirements Schema

```json
{
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "url_pattern":   { "type": "string", "description": "URL match (exact, glob:, or re:)" },
        "title_pattern": { "type": "string", "description": "Page title match" },
        "dom_marker":    { "type": "string", "description": "CSS selector that must exist" },
        "dialog_type":   { "type": "string", "description": "Expected dialog type" },
        "panel_id":      { "type": "string", "description": "Panel identifier" },
        "panel_label":   { "type": "string", "description": "Panel label match" },
        "view_state":    { "type": "string", "description": "Expected state hash (for CAS)" },
        "content_hash":  { "type": "string", "description": "Hash of specific content region" }
    },
    "additionalProperties": false
}
```

### 6.4 Precedence Rules

When both `--expect-*` flags and `--requirements` are provided:

1. Individual `--expect-*` flags **override** corresponding fields in `--requirements`
2. Non-overlapping fields are merged
3. This allows agents to supply a base requirements file while humans override
   specific fields on the command line

## 7. Compare-and-Swap for Optimistic Concurrency

### 7.1 Concept

For operations where the view content (not just identity) matters, the framework
supports compare-and-swap (CAS) semantics via `--expect-state` and
`--expect-content-hash`.

This prevents a class of bugs where:

1. Agent reads a list of items (e.g., 5 messages in inbox)
2. New items arrive between read and action
3. Agent acts on shifted indices, targeting wrong items

### 7.2 State Hashing

The framework computes deterministic state hashes over configurable content
regions:

```python
import hashlib

def compute_view_state(view, regions: list[str] | None = None) -> str:
    """
    Compute a deterministic hash of the view's observable state.

    If regions is None, hashes the full DOM. Otherwise hashes only
    the content within the specified CSS selectors.
    """
    parts = []
    if regions:
        for selector in regions:
            elements = view.query_selector_all(selector)
            for el in elements:
                parts.append(el.outer_html)
    else:
        parts.append(view.document.outer_html)

    content = "\n".join(parts)
    return hashlib.sha256(content.encode()).hexdigest()[:16]
```

### 7.3 CAS Workflow

```bash
# Step 1: Read state, capture hash
$ webctl list-items --view 0 --output-state
# Output includes: "view_state": "a3f7b2c91e4d8012"

# Step 2: Act with CAS guard
$ webctl delete-item --view 0 \
    --expect-state a3f7b2c91e4d8012 \
    --item-index 2

# If the view state changed (new items arrived, reorder, etc.),
# the command fails with:
#   Error: View state mismatch
#     expected: a3f7b2c91e4d8012
#     actual:   7c2e9f01b4a38856
#     Hint: re-read the view and retry with updated state
```

### 7.4 Scoped CAS with Content Regions

Full-DOM hashing is too sensitive (unrelated UI changes trigger false
mismatches). Scoped CAS hashes only the relevant content region:

```bash
# Hash only the message list, not the sidebar or header
$ webctl list-items --view 0 \
    --state-region "#message-list" \
    --output-state

# Use scoped hash for targeted CAS
$ webctl delete-item --view 0 \
    --expect-state a3f7b2c91e4d8012 \
    --state-region "#message-list" \
    --item-index 2
```

## 8. Auto-Routing: Explicit Targets as Enablers

### 8.1 Beyond Safety

When commands declare their target expectations, the framework gains the ability
to **find** the right view instead of blindly trusting an index:

```python
def resolve_view(views: list[View], expectations: dict) -> View | None:
    """
    Find the best-matching view for the given expectations.

    Returns None if no view matches. If multiple match, returns
    the highest-scoring match.
    """
    candidates = []
    for view in views:
        score = compute_match_score(view, expectations)
        if score > 0:
            candidates.append((score, view))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]
```

### 8.2 CLI Integration

```bash
# Traditional: fragile index-based
$ webctl send-message --view 0 --body "Hello"

# Explicit target: framework finds the right view
$ webctl send-message \
    --expect-url "/conversations/42" \
    --body "Hello"
# Framework searches all views, finds the one matching /conversations/42
# No --view index needed at all
```

When `--view` is omitted but `--expect-*` or `--requirements` are provided,
the framework enters auto-route mode:

1. Scan all open views
2. Score each against expectations
3. Use the best match (if score exceeds threshold)
4. Fail if zero matches or ambiguous matches (multiple high-scoring candidates)

## 9. Error Reporting and Recovery

### 9.1 Structured Error Output

All target mismatches produce machine-readable error output:

```json
{
    "error": "view_target_mismatch",
    "code": "ETARGET",
    "expected": {
        "url_pattern": "/inbox"
    },
    "actual": {
        "url": "/settings/privacy",
        "title": "Privacy Settings",
        "view_index": 0
    },
    "available_views": [
        {"index": 0, "url": "/settings/privacy", "title": "Privacy Settings"},
        {"index": 1, "url": "/inbox", "title": "Inbox (3)"},
        {"index": 2, "url": "/dashboard", "title": "Dashboard"}
    ],
    "suggestion": "Did you mean --view 1? It matches url_pattern '/inbox'",
    "recovery": "Re-run with --view 1, or use --force to proceed with view 0"
}
```

### 9.2 Agent Recovery Protocol

Agents receiving a `ETARGET` error can:

1. Parse `available_views` to find the correct view
2. Re-issue the command with the corrected `--view` index
3. Or re-issue with only `--requirements` (auto-route mode)

## 10. Implementation Checklist

* [ ] Define `VIEW_TARGET_CONFIG` registry with extension points
* [ ] Implement `assert_view_target()` with asymmetric enforcement
* [ ] Add `--expect-url`, `--expect-title`, `--expect-dom` flags to all commands
* [ ] Add `--requirements` / `--required` consolidated JSON flag
* [ ] Implement `--force` with logging contract and double-force for destructive ops
* [ ] Implement state hashing with configurable regions
* [ ] Add `--expect-state`, `--state-region`, `--output-state` flags
* [ ] Implement auto-routing when `--view` is omitted with expectations present
* [ ] Structured error output with `available_views` and suggestions
* [ ] Integration tests: concurrent view changes during command execution
* [ ] Documentation: flag reference, examples, agent pipeline cookbook

## 11. Threat Model Summary

| Threat                        | Mitigation                              |
|-------------------------------|-----------------------------------------|
| View navigated away           | `--expect-url` assertion                |
| Dialog dismissed/changed      | `--expect-dialog-type` assertion        |
| Content reordered             | `--expect-state` CAS guard              |
| Index shifted (tab opened)    | Auto-routing via expectations           |
| Agent acts on stale snapshot  | Scoped CAS with `--state-region`        |
| Human overrides incorrectly   | `--force` logged, double-force for destructive |
| Pipeline flag construction    | `--requirements` JSON consolidation     |
