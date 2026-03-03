---
id: 7ako
title: "Provenance Tracking: Append-Only Audit Trail for Shared Resources"
category: ops
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [provenance, audit-trail, jsonl, append-only, multi-agent, bulk-safety]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Provenance Tracking: Append-Only Audit Trail for Shared Resources

## Problem Statement

When multiple agents (or multiple runs of a single agent) operate on shared
resources -- contacts, conversations, files, group memberships -- there is no
reliable way to answer fundamental questions:

* "Which agent created this resource?"
* "Is it safe to bulk-delete everything agent X touched?"
* "What did agent Y do between 14:00 and 15:00 yesterday?"

Without provenance, bulk operations are dangerous -- an agent that "touched"
a pre-existing resource might mark it for deletion, destroying data others
depend on. Debugging multi-agent conflicts becomes nearly impossible.

## Design Principles

### 1. Append-Only JSONL

All provenance records are written as newline-delimited JSON (JSONL) to a
single file per instance. Records are never modified or deleted during normal
operation.

**Why JSONL:**

* Each line is a self-contained JSON object -- partial writes from crashes
  leave at most one corrupted trailing line, never damaging prior records.
* Trivially parseable with `jq`, `grep`, `awk`, or any streaming JSON parser.
* No schema migrations -- new fields are simply added to new records.
* Natural chronological ordering by file position.

**Crash safety:** A process dying mid-write produces at most one incomplete
trailing line. The reader detects and skips it. No WAL or fsync required for
correctness (though `fsync` is recommended for durability).

```
# Anatomy of the provenance file
~/.config/webctl/instances/<instance-id>/provenance.jsonl
```

### 2. Fail-Open Principle

Provenance tracking must **never** block the primary operation. If the
provenance file cannot be written (permissions, disk full, locked), the
operation proceeds and a warning is emitted to stderr.

Provenance is an observability layer, not a correctness requirement. The
fail-closed alternative would make provenance a reliability bottleneck.

```
# Pseudocode
try:
    append_provenance(record)
except IOError as e:
    log.warning(f"provenance write failed: {e}")
    # operation continues regardless
```

### 3. Three-Tier Provenance Categories

Every provenance record classifies the agent's relationship to the resource
using one of three tiers:

| Tier          | Meaning                                      | Bulk-delete safe? |
|---------------|----------------------------------------------|-------------------|
| `created`     | Agent created this resource from scratch      | Yes               |
| `contributed` | Agent added meaningful content to a resource  | Needs review      |
| `touched`     | Agent read, listed, or made trivial changes   | No                |

**Tier definitions in detail:**

* **`created`** -- Resource did not exist before this action (sending a message,
  creating a contact, uploading a file). Safe to bulk-delete: agent is sole origin.
* **`contributed`** -- Resource existed; agent added substantive content (replying,
  adding a group member, editing a document). Bulk-delete risky: others may depend on it.
* **`touched`** -- Agent interacted without substantial modification (reading,
  listing, checking metadata). Never safe to bulk-delete based on touch alone.

### 4. Cascading Categories

When an agent performs multiple operations on the same resource, the effective
tier is the **highest** (most impactful) tier recorded:

```
touched < contributed < created
```

A resource that was first `touched` and later `contributed` to has an effective
tier of `contributed`. This cascading is computed at query time, not at write
time -- the raw log always contains every individual event.

## Record Schema

Each JSONL line contains one provenance record:

```json
{
  "ts": "2026-03-03T14:22:07.123Z",
  "agent_id": "conv-monitor-01",
  "instance_id": "prod-main",
  "action": "send_message",
  "tier": "created",
  "resource_type": "message",
  "resource_id": "msg-a8f3c2",
  "parent_resource": "conversation-7x9k",
  "context": {
    "run_id": "run-20260303-142200",
    "command": "webctl msg send --to group-alpha",
    "trigger": "scheduled"
  },
  "meta": {}
}
```

### Field Reference

| Field             | Type   | Required | Description                                    |
|-------------------|--------|----------|------------------------------------------------|
| `ts`              | string | yes      | ISO 8601 timestamp with milliseconds           |
| `agent_id`        | string | yes      | Identifier of the agent performing the action   |
| `instance_id`     | string | yes      | Scoping identifier for the service instance     |
| `action`          | string | yes      | Machine-readable action name                    |
| `tier`            | string | yes      | One of: `created`, `contributed`, `touched`     |
| `resource_type`   | string | yes      | Type of resource (message, contact, file, etc.) |
| `resource_id`     | string | yes      | Unique identifier of the affected resource      |
| `parent_resource` | string | no       | ID of containing resource (e.g., conversation)  |
| `context`         | object | no       | Execution context (run ID, command, trigger)    |
| `meta`            | object | no       | Arbitrary key-value pairs for extension         |

### Action Naming Convention

Actions follow the pattern `{verb}_{noun}`:

```
send_message    -> created      create_contact  -> created
reply_message   -> contributed  update_contact  -> contributed
read_message    -> touched      list_contacts   -> touched
upload_file     -> created      download_file   -> touched
join_group      -> contributed
```

Tier is determined by action, not by caller. A config mapping defines
tier assignments.

## Per-Instance Scoping

Provenance files are scoped per service instance:

```
~/.config/webctl/instances/
  prod-main/
    provenance.jsonl
    config.yml
  staging-test/
    provenance.jsonl
    config.yml
```

This ensures that:

* Agents operating on different instances never conflict on provenance writes.
* Bulk operations can be scoped to a single instance.
* Instance deletion cleanly removes all associated provenance.

## Query Patterns

All examples use `jq` against the JSONL provenance file.

### Basic Queries

**All actions by a specific agent:**

```bash
jq -s 'map(select(.agent_id == "conv-monitor-01"))' \
  provenance.jsonl
```

**All resources created by any agent:**

```bash
jq -s 'map(select(.tier == "created"))' \
  provenance.jsonl
```

**Actions within a time window:**

```bash
jq -s 'map(select(.ts >= "2026-03-03T14:00:00" and .ts < "2026-03-03T15:00:00"))' \
  provenance.jsonl
```

### Safe Bulk Delete Identification

**Find resources safe to delete (created by agent X, never contributed to or
touched by others):**

```bash
jq -s '
  # Step 1: all resources created by target agent
  [ .[] | select(.agent_id == "cleanup-agent" and .tier == "created") ]
    | map(.resource_id) | unique as $created
  |
  # Step 2: subtract resources any other agent contributed to or touched
  [ .[] | select(.agent_id != "cleanup-agent" and .resource_id as $rid
    | $created | index($rid)) ]
    | map(.resource_id) | unique as $shared
  |
  # Step 3: safe to delete = created minus shared
  $created - $shared
' provenance.jsonl
```

**Effective tier per resource (cascading):**

```bash
jq -s '
  group_by(.resource_id) | map({
    resource_id: .[0].resource_id,
    effective_tier: (
      if any(.tier == "created") then "created"
      elif any(.tier == "contributed") then "contributed"
      else "touched"
      end
    ),
    agents: [.[].agent_id] | unique,
    action_count: length
  })
' provenance.jsonl
```

### Activity Timelines

**Timeline for a specific resource:**

```bash
jq -s '
  map(select(.resource_id == "msg-a8f3c2"))
  | sort_by(.ts)
  | .[]
  | "\(.ts) [\(.tier)] \(.agent_id): \(.action)"
' provenance.jsonl
```

**Agent activity summary (actions per hour):**

```bash
jq -s '
  group_by(.agent_id) | map({
    agent: .[0].agent_id,
    total: length,
    by_tier: (group_by(.tier) | map({
      tier: .[0].tier,
      count: length
    })),
    first_seen: (sort_by(.ts) | first.ts),
    last_seen: (sort_by(.ts) | last.ts)
  })
' provenance.jsonl
```

### Inter-Agent Coordination

**Resources shared between two agents:**

```bash
jq -s '
  group_by(.resource_id)
  | map(select(
      any(.agent_id == "agent-alpha") and
      any(.agent_id == "agent-beta")
    ))
  | map({
      resource_id: .[0].resource_id,
      resource_type: .[0].resource_type,
      interactions: [.[] | {ts, agent_id, action, tier}]
    })
' provenance.jsonl
```

**Detect conflicting writes (multiple agents contributing to the same
resource within a time window):**

```bash
jq -s '
  map(select(.tier == "contributed" or .tier == "created"))
  | group_by(.resource_id)
  | map(select(
      [.[].agent_id] | unique | length > 1
    ))
  | map({
      resource_id: .[0].resource_id,
      conflicting_agents: ([.[].agent_id] | unique),
      events: [.[] | {ts, agent_id, action}]
    })
' provenance.jsonl
```

### Run-Scoped Queries

**All actions from a specific run:**

```bash
jq -s '
  map(select(.context.run_id == "run-20260303-142200"))
  | sort_by(.ts)
' provenance.jsonl
```

**Runs that created the most resources:**

```bash
jq -s '
  map(select(.tier == "created" and .context.run_id != null))
  | group_by(.context.run_id)
  | map({run_id: .[0].context.run_id, created_count: length})
  | sort_by(-.created_count)
  | .[:10]
' provenance.jsonl
```

## Rotation and Retention

* **Rotation:** Periodically rotate to `provenance-YYYYMMDD.jsonl.gz`.
* **Retention:** Compressed archives retained per policy (default: 90 days).
* **Compaction:** Optional summary file with per-resource effective tiers.

```bash
# Rotate current provenance file
mv provenance.jsonl "provenance-$(date +%Y%m%d).jsonl"
gzip "provenance-$(date +%Y%m%d).jsonl"
touch provenance.jsonl

# Query across rotated files
zcat provenance-*.jsonl.gz | cat - provenance.jsonl \
  | jq -s 'map(select(.agent_id == "target-agent"))'
```

## Integration

Every command that modifies or reads a resource appends a provenance record.
The writer constructs a JSON object from the action parameters, serializes it
as a single compact line, and appends with `open(path, "a")`. On `IOError`,
a warning is logged and the operation proceeds (fail-open).

The reader streams the file line-by-line, skipping empty or malformed lines,
optionally filtering by `agent_id`, `tier`, or timestamp. For ad-hoc queries,
`jq` against the raw file is the primary interface.

## Use Cases Enabled

### 1. Safe Bulk Delete

Query `tier == "created"` for the target agent, subtract resources any other
agent has `contributed` to or `created`. The remainder is safe to delete.

### 2. Activity Timelines

Filter by timestamp to reconstruct a chronological narrative of all agent
actions across all resource types during an incident window.

### 3. Inter-Agent Coordination

* **Conflict detection** -- two agents writing to the same resource.
* **Dependency tracking** -- agent B operates on resources created by agent A.
* **Ownership transfer** -- reassign based on who created vs. last contributed.

### 4. Compliance and Auditability

Append-only log serves as immutable audit trail for regulated environments.

## Limitations

* **Storage growth:** Mitigated by rotation/compaction, not eliminated.
* **No real-time indexing:** Full file scans; consider index generation at scale.
* **Single-writer assumption:** Concurrent appends need file locking or rely
  on POSIX atomic append guarantees (writes under `PIPE_BUF`, typically 4096 bytes).
* **Fail-open gap:** Missing records possible under failure; best-effort, not guaranteed.

## Summary

Append-only JSONL provenance provides a lightweight, crash-safe, queryable
audit trail for multi-agent systems. Three-tier classification (`created`,
`contributed`, `touched`) enables safe bulk operations by distinguishing
ownership from interaction. Fail-open design prevents reliability bottlenecks.
Per-instance scoping and standard tooling (`jq`, `grep`) keep operations
straightforward.
