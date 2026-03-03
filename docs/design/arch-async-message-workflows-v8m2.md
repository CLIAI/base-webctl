---
id: v8m2
title: "Async Workflows: Message Identity, Streaming & Multi-User Safety"
category: arch
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [async-workflows, message-identity, heartbeat, streaming, multi-user, graceful-detach]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Async Workflows: Message Identity, Streaming & Multi-User Safety

## Problem Statement

When a CLI tool sends a message to an asynchronous request/response interface,
the caller must reliably retrieve **its own** response. Naive approaches that
extract "the last response on the page" break silently when multiple agents or
users are active in the same conversation, when network latency causes
out-of-order delivery, or when long-running responses need incremental
visibility.

This document defines four workflow modes, an identity-tracking scheme, a
heartbeat protocol, multi-user safety guards, and graceful detach behaviour.
Together they form a reusable architecture for any tool that interacts with
async messaging interfaces.

## Design Principles

1. **Identity over position** -- Never rely on DOM order or "last element"
   heuristics. Track every message by a unique identifier.
2. **Caller chooses latency model** -- Provide blocking, return-immediately,
   streaming, and fire-and-forget modes so callers pick the trade-off between
   simplicity and responsiveness.
3. **Liveness visibility** -- Long waits must emit heartbeats so upstream
   orchestrators can distinguish "still working" from "hung".
4. **Multi-user correctness** -- Concurrent agents sharing a conversation must
   never silently receive each other's responses.
5. **Graceful interruption** -- A user pressing Ctrl+C during a wait must not
   lose the in-flight request; the CLI must detach cleanly and provide a
   retrieval path.

## Four Workflow Modes

### 1. Blocking (default)

Send a message, wait for the assistant response to complete, return both the
user message ID and the full response content.

```
CLI --> [send message] --> wait --> [response complete] --> return {
  user_message_id,
  assistant_message_id,
  content
}
```

**When to use:** Simple scripting, sequential pipelines, one-shot queries.

### 2. Return-Immediately

Send a message, return the user message ID as soon as the message is confirmed
sent. The caller polls or retrieves the response later using the message ID.

```
CLI --> [send message] --> return { user_message_id }
       ... later ...
CLI --> [fetch by parent_message_id] --> return { content }
```

**When to use:** Parallel fan-out patterns where multiple messages are sent
before any responses are collected.

**Flag:** `--return-immediately`

### 3. Streaming

Send a message, emit JSONL chunks to stdout as the response generates
token-by-token. Each chunk includes a sequence number and the incremental text
delta.

```jsonl
{"seq":0,"type":"delta","text":"The "}
{"seq":1,"type":"delta","text":"answer "}
{"seq":2,"type":"delta","text":"is 42."}
{"seq":3,"type":"done","assistant_message_id":"msg_abc123"}
```

**When to use:** Interactive UIs, progress display, piping into downstream
processors that benefit from incremental input.

**Flag:** `--stream`

### 4. Fire-and-Forget

Send a message, confirm delivery, exit immediately without waiting for any
response.

```
CLI --> [send message] --> [delivery confirmed] --> exit 0
```

**When to use:** Triggering side-effects (e.g., "clear context" commands) where
the response content is irrelevant.

**Flag:** `--no-wait`

## Message Identity Tracking

### The Problem with Position-Based Retrieval

If two agents send messages to the same conversation:

```
Agent A sends: "What is X?"
Agent B sends: "What is Y?"
Assistant responds to A: "X is ..."
Assistant responds to B: "Y is ..."
```

An agent that grabs "the last response" will get the wrong answer 50% of the
time.

### Identity via DOM Data Attributes

Every message element carries a `data-message-id` attribute:

```html
<div data-message-id="msg_user_001" class="user-message">What is X?</div>
<div data-message-id="msg_asst_002" class="assistant-message"
     data-parent-message-id="msg_user_001">X is ...</div>
```

The send flow:

1. **Before send:** snapshot existing message IDs.
2. **After send:** detect the new element whose `data-message-id` was not in the
   snapshot. This is the user message.
3. **Wait for response:** poll for an assistant message whose
   `data-parent-message-id` equals the user message ID.
4. **Extract content** from the identified assistant message element.

### Stale Response Guard

During polling, if the detected `assistant_message_id` reverts to a value that
existed before the send (e.g., due to DOM re-render), the poller must reset to
the waiting state rather than returning stale content.

## Heartbeat Protocol

### Purpose

In blocking mode, the CLI may wait minutes for a response. Without heartbeats,
an upstream orchestrator cannot distinguish a live wait from a crashed process.

### Schedule (Exponential Backoff)

| Heartbeat # | Delay since last | Cumulative time |
|-------------|-----------------|-----------------|
| 1           | 8 s             | 8 s             |
| 2           | 16 s            | 24 s            |
| 3           | 32 s            | 56 s            |
| 4           | 64 s            | 120 s           |
| 5           | 128 s           | 248 s           |
| 6+          | 128 s (cap)     | 248 + 128*n s   |

### Heartbeat Payload

Each heartbeat is a JSONL line on stderr:

```jsonl
{"type":"heartbeat","seq":3,"phase":"thinking","elapsed_s":56,"partial_len":0}
```

Fields:

* **`phase`** -- one of `waiting` (no response element yet), `thinking`
  (response element exists but still generating), `streaming` (actively
  receiving tokens).
* **`partial_len`** -- character count of partial response so far. Useful for
  detecting stuck generation (length unchanged across heartbeats).
* **`elapsed_s`** -- wall-clock seconds since send.

### Stuck Detection

If `partial_len` remains unchanged across 3 consecutive heartbeats while
`phase` is `thinking` or `streaming`, the response is likely stuck. The CLI
should:

1. Log a warning.
2. Optionally retry (if `--retry-on-stuck` is set).
3. Return a structured error with the partial content collected so far.

## Multi-User Safety

### Parent Message ID Filtering

```
--parent-message-id <id>
```

When fetching a response, filter by the parent message ID rather than assuming
the latest assistant message is the target. This is the primary mechanism for
correctness in shared conversations.

### Interleave Detection

```
--assert-last-user-message-id <id>
```

Before extracting a response, assert that the most recent user message in the
conversation matches the expected ID. If it does not, another agent has
interleaved a message. The CLI should:

1. Return a structured error indicating interleave detected.
2. Include both the expected and actual last user message IDs.
3. Let the caller decide whether to proceed, retry, or abort.

### Race Condition Mitigation

Even with identity tracking, there is a TOCTOU window between checking the last
message ID and extracting the response. Mitigations:

* **Re-verify after extraction:** After reading the response content, re-check
  that `data-parent-message-id` still matches.
* **Atomic snapshot:** Read both the parent ID and the content in a single DOM
  query to minimise the window.

## Graceful SIGINT Detach

### Behaviour

When the user sends SIGINT (Ctrl+C) during a blocking or streaming wait:

1. **Do not abort the browser session.** The in-flight request continues
   server-side regardless.
2. **Emit a detach message** to stderr:

   ```jsonl
   {"type":"detached","user_message_id":"msg_user_001","elapsed_s":42}
   ```

3. **Print a retrieval command** so the user can fetch the response later:

   ```
   To retrieve the response later, run:
     webctl fetch-response --parent-message-id msg_user_001
   ```

4. **Exit with code 130** (standard SIGINT exit code).

### Implementation Notes

* Register the SIGINT handler before entering the polling loop.
* The handler must be async-signal-safe: write a pre-formatted message, set a
  flag, let the main loop exit cleanly.
* Do not attempt cleanup that involves browser interaction in the signal
  handler itself.

## Response Extraction Pipeline

The full pipeline from send to return:

```
1. Snapshot current message IDs
2. Inject user message into input field
3. Trigger send action
4. Detect new user message element (ID not in snapshot)
5. Record user_message_id
6. Enter polling loop:
   a. Query for assistant message with matching parent ID
   b. If not found: emit heartbeat, continue
   c. If found but still generating: emit heartbeat with partial_len, continue
   d. If found and complete: extract content, proceed
7. Verify: re-check parent-message-id matches
8. Return structured result
```

## Error Taxonomy

| Error Code | Meaning | Recovery |
|-----------|---------|----------|
| `SEND_FAILED` | Message injection or send trigger failed | Retry send |
| `USER_MSG_NOT_DETECTED` | No new user message appeared after send | Check DOM selectors |
| `RESPONSE_TIMEOUT` | Polling exceeded max wait time | Return partial or retry |
| `RESPONSE_STUCK` | `partial_len` unchanged across 3+ heartbeats | Retry or return partial |
| `INTERLEAVE_DETECTED` | Another user's message appeared during wait | Re-send in fresh context |
| `STALE_RESPONSE` | Message ID reverted to pre-send value | Reset polling |
| `DETACHED` | User pressed Ctrl+C during wait | Fetch later by ID |

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--timeout` | 300 s | Maximum wall-clock wait in blocking mode |
| `--heartbeat-interval` | exponential | Override heartbeat schedule (fixed interval) |
| `--retry-on-stuck` | false | Auto-retry when stuck detection triggers |
| `--max-retries` | 2 | Maximum retry attempts for stuck/timeout |
| `--parent-message-id` | (none) | Fetch response to a specific prior message |
| `--assert-last-user-message-id` | (none) | Guard against interleaved messages |
| `--return-immediately` | false | Return after send without waiting |
| `--stream` | false | Emit JSONL chunks during generation |
| `--no-wait` | false | Fire-and-forget mode |

## Summary

This architecture ensures that async message workflows are correct under
concurrency, observable during long waits, and resilient to interruption. The
four workflow modes cover the full spectrum of caller needs from simple
sequential scripts to parallel fan-out orchestration. Message identity tracking
via DOM data attributes eliminates position-based extraction bugs, and the
heartbeat protocol gives upstream systems continuous liveness signals.
