---
id: r7m2
title: "Write Operation Safety: CAS, Forbidden Actions & Mutation Guards"
category: safety
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [write-safety, cas, forbidden-actions, read-only, preconditions, mutation-guard]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Write Operation Safety: CAS, Forbidden Actions & Mutation Guards

## Problem

Web-control CLI tools interact with live systems where unintended mutations can
cause irreversible harm. A stale-state write can overwrite another actor's
changes. An accidental invocation of a destructive subcommand can delete content
permanently. Without a principled safety framework, every write operation is a
liability.

This document defines three layers of graduated mutation safety that apply
universally to any web-control CLI, regardless of the target platform.

## Principles

1. **Read-only by default.** The vast majority of subcommands should be
   read-only. Write operations are the exception, never the norm.
2. **Explicit is safer than implicit.** Every mutation must require an explicit
   target identifier. No command should mutate "whatever was last viewed."
3. **Graduated enforcement.** Safety mechanisms range from soft (dry-run
   previews) to hard (forbidden action registries that block compilation or
   startup).
4. **Auditability.** Every mutation must return enough state to reconstruct
   what changed, enabling undo or rollback.

## Layer 1: Three Safety Primitives for Write Commands

Every subcommand that performs a write operation should implement these three
primitives.

### 1.1 Identity Pinning

Mutations target a resource by its stable, unique identifier (not by display
name, position, or implicit context).

```
webctl update-item --item-id abc123 --title "New Title"
```

**Why:** Display names are ambiguous and positions shift. An ID-pinned command
is idempotent in its targeting -- it always refers to the same resource.

**Implementation notes:**

* Accept a `--<resource>-id` flag for every write subcommand.
* Validate the ID format before issuing any network request.
* If the resource is not found for the given ID, fail with a clear error rather
  than falling back to a search.

### 1.2 Old-State Return

Every mutation response must include the previous value of the changed fields.

```json
{
  "action": "update-title",
  "item_id": "abc123",
  "old": { "title": "Original Title" },
  "new": { "title": "New Title" },
  "timestamp": "2026-03-03T12:00:00Z"
}
```

**Why:** This enables three things:

* **Auditing** -- a log of what changed and when.
* **Undo** -- the old state is available to reverse the operation.
* **Conflict detection** -- if old state does not match expectations, something
  changed between read and write.

**Implementation notes:**

* The CLI should emit old-state data in structured output (JSON) even when
  human-readable output is the default.
* Store old-state returns in a local audit log file if `--audit-log` is
  configured.

### 1.3 Compare-and-Swap (CAS)

Before applying a mutation, assert that the current state matches the caller's
expectation.

```
webctl update-item --item-id abc123 \
  --title "New Title" \
  --expect-title "Original Title"
```

If the current title is not "Original Title", the command fails without making
any change.

**Why:** This prevents the classic time-of-check-to-time-of-use (TOCTOU)
problem. Between reading and writing, another actor (human or automated) may
have changed the resource.

**Implementation notes:**

* Provide `--expect-<field>` flags for every mutable field.
* CAS checks must happen server-side or immediately before the mutation API
  call (not minutes earlier in a cached read).
* On CAS failure, return the actual current value so the user can decide how
  to proceed.

## Layer 2: Subcommand Safety Classification

Every subcommand in a web-control CLI must be classified into one of three
safety tiers. This classification drives UI behavior, documentation, and
testing policy.

### Classification Tiers

| Tier | Label | Description | Requirements |
|------|-------|-------------|-------------|
| T0 | **Read-only** | No side effects. Pure data retrieval. | None beyond auth. |
| T1 | **Targeted mutation** | Modifies a specific, identified resource. | Explicit target ID required. CAS recommended. |
| T2 | **Broad / destructive** | Affects multiple resources or is irreversible. | Explicit target, CAS required, confirmation prompt, `--force` to bypass. |

### Classification Rules

* **Generic list/search commands** (e.g., `list-items`, `search`) are T0.
* **Single-resource read commands** (e.g., `get-item --id X`) are T0.
* **Single-resource write commands** (e.g., `update-item`, `send-message`) are
  T1.
* **Bulk operations and deletions** (e.g., `delete-items`, `bulk-update`) are
  T2.

### UI Behavior by Tier

* **T0:** Execute immediately. No confirmation.
* **T1:** Execute immediately by default. Support `--dry-run` to preview.
* **T2:** Require interactive confirmation unless `--force` or `--yes` is
  provided. Always support `--dry-run`.

## Layer 3: Forbidden Action Registry

Some operations are so dangerous or so far outside the intended use case that
they must never be implemented, even behind flags.

### Design

The forbidden action registry is a hard-coded, version-controlled list of
operations that the CLI will never perform. It serves as both documentation
and runtime enforcement.

```python
FORBIDDEN_ACTIONS = {
    "profile-state-change": {
        "description": "Modify profile visibility, headline, or photo",
        "reason": "Irreversible reputation impact; out of scope for automation",
    },
    "relationship-mutation": {
        "description": "Endorse, block, report, or modify social connections",
        "reason": "Social actions require human judgment and intent",
    },
    "content-destruction": {
        "description": "Permanently delete published content",
        "reason": "Irreversible data loss; prefer archive/hide patterns",
    },
    "credential-change": {
        "description": "Modify authentication credentials or account settings",
        "reason": "Security-critical; must be performed through official UI",
    },
    "application-state": {
        "description": "Submit, withdraw, or modify applications/proposals",
        "reason": "Legal and professional implications require human review",
    },
}
```

### Enforcement Mechanisms

1. **Startup validation.** On CLI initialization, verify that no registered
   subcommand name collides with a forbidden action pattern.
2. **Runtime guard.** Before dispatching any command, check the action against
   the registry. If matched, abort with an explicit error message explaining
   why the action is forbidden.
3. **Code review gate.** The registry file should be a CODEOWNERS-protected
   file requiring explicit approval to modify.

### Allowed Write Exceptions

The narrow set of permitted write operations must be explicitly enumerated.
Each exception requires:

* A documented justification for why the write is necessary.
* A `--required` or equivalent precondition flag pattern that forces the caller
  to acknowledge the mutation.
* Full CAS support (Layer 1.3).

Example of an allowed exception:

```
# Sending a message is an allowed write because it is the core use case.
# It requires explicit recipient targeting and message content.
webctl send-message --to-id user456 --body "Hello"
```

## Escape Hatches

Three standard flags provide graduated override capability:

| Flag | Purpose | Safety Tier Applicability |
|------|---------|--------------------------|
| `--dry-run` | Preview the mutation without executing it. Print what would happen. | T1, T2 |
| `--yes` / `-y` | Skip interactive confirmation prompts. | T2 |
| `--force` | Bypass CAS checks and confirmation prompts. Use when the caller has external knowledge that the operation is safe. | T1, T2 |

**`--force` must never bypass the forbidden action registry.** Forbidden
actions cannot be force-overridden. They require a code change to the registry
itself.

## Test Safety Classification

Automated tests must respect the safety tiers:

| Test Category | Allowed Tiers | Notes |
|---------------|--------------|-------|
| Unit tests | T0 only | Mock all external calls. |
| Integration tests (read) | T0 | Real network, read-only commands. |
| Integration tests (write) | T1 | Use dedicated test resources. CAS required. |
| Smoke tests | T0 | Verify CLI starts, help renders, read commands work. |
| Destructive tests | T2 | Isolated sandbox environments only. Never against live data. |

**Default test policy:** Tests must be classified with a safety annotation.
Unclassified tests are treated as T0 and must not perform any writes.

```python
@test_safety(tier="T1", resource="test-item-001")
def test_update_item_title():
    """Write test: requires dedicated test resource."""
    ...
```

## Implementation Checklist

For each new subcommand, verify:

* [ ] Safety tier assigned (T0 / T1 / T2).
* [ ] If T1+: `--<resource>-id` flag implemented.
* [ ] If T1+: old-state returned in structured output.
* [ ] If T1+: `--expect-<field>` CAS flags available.
* [ ] If T2: interactive confirmation implemented.
* [ ] `--dry-run` support for T1 and T2.
* [ ] `--force` and `--yes` flags for T2.
* [ ] Action checked against forbidden action registry.
* [ ] Test safety annotation applied.

## Summary

Mutation safety in a web-control CLI is not a single mechanism but a graduated
system of three layers:

* **Layer 1 (Primitives):** Identity pinning, old-state return, and
  compare-and-swap provide per-operation safety.
* **Layer 2 (Classification):** Every subcommand gets a safety tier that
  determines its UI behavior and testing policy.
* **Layer 3 (Registry):** A hard-coded forbidden action list prevents
  categories of dangerous operations from ever being implemented.

Together, these layers ensure that the CLI defaults to safety, requires
explicit intent for mutations, and makes catastrophic mistakes structurally
impossible.
