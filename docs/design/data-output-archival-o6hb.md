---
id: o6hb
title: "Output Archival: Multi-Format Export & Conversation Caching"
category: data
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [archival, export, multi-format, yaml-front-matter, media-download, caching]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Output Archival: Multi-Format Export & Conversation Caching

## Motivation

Web-control CLI tools extract structured and unstructured content from web
pages — conversations, threads, posts, media, tables, and more. This data
must be persisted in a portable, inspectable, and mergeable format so that
downstream workflows (search, analysis, backup, migration) can consume it
without re-fetching from the source.

This document defines:

* A canonical `--output-dir` convention and file naming scheme.
* A YAML front matter metadata envelope for every exported artifact.
* Filename normalization rules for cross-platform safety.
* A Markdown-to-HTML rendering pipeline for human-readable archives.
* SHA-256-based conversation caching and incremental update strategy.
* Atomic write semantics and merge rules for concurrent or repeated exports.
* Context fence verification to ensure export integrity.
* Branch-aware export for version-controlled output trees.

---

## 1. `--output-dir` Convention

### 1.1 Flag Semantics

Every export subcommand accepts `--output-dir <path>` (short: `-o`). The
directory is created recursively if it does not exist. Defaults to
`./webctl-export/` (or overridden via `WEBCTL_OUTPUT_DIR` env var).

```
webctl export conversation --output-dir ~/archives/2026-03
```

### 1.2 Directory Layout

```
<output-dir>/
  metadata.json            # index of all exported items (append-only)
  conversations/
    <normalized-name>/
      content.md           # primary markdown export
      content.html         # rendered HTML (optional, via --html)
      front-matter.yaml    # standalone metadata copy
      media/
        <hash>-<orig>.png  # downloaded media assets
        <hash>-<orig>.mp4
      cache/
        .content.sha256    # SHA-256 of last exported content.md
  pages/
    <normalized-name>/
      ...
  tables/
    <normalized-name>/
      data.csv
      data.json
      ...
```

### 1.3 Consistent File Naming

Every exported item is placed inside a directory named per the normalization
rules in Section 3. Primary content files use predictable names (`content.md`,
`content.html`, `data.csv`) so tooling can glob across exports.

---

## 2. YAML Front Matter Metadata Schema

Every `content.md` file begins with YAML front matter describing the export:

```yaml
---
source_url: "https://example.com/conversation/abc123"
source_type: conversation
export_timestamp: "2026-03-03T14:22:07Z"
export_tool: "webctl v0.4.0"
export_format: markdown
content_hash: "sha256:a1b2c3d4e5f6..."
title: "Discussion about data pipelines"
participant_count: 3
message_count: 47
media_count: 5
date_range:
  first: "2026-02-28T09:00:00Z"
  last: "2026-03-03T12:15:00Z"
tags: []
custom: {}
---
```

### 2.1 Required Fields

| Field               | Type     | Description                                    |
|---------------------|----------|------------------------------------------------|
| `source_url`        | string   | Canonical URL of the source artifact           |
| `source_type`       | string   | One of: `conversation`, `page`, `table`, `feed`|
| `export_timestamp`  | ISO 8601 | When the export was generated                  |
| `export_tool`       | string   | Tool name and version                          |
| `export_format`     | string   | Primary format: `markdown`, `csv`, `json`      |
| `content_hash`      | string   | `sha256:<hex>` of content body (post-frontmatter)|

### 2.2 Optional Fields

| Field               | Type     | Description                                    |
|---------------------|----------|------------------------------------------------|
| `title`             | string   | Human-readable title extracted from source     |
| `participant_count` | integer  | Number of unique participants                  |
| `message_count`     | integer  | Number of messages/entries                     |
| `media_count`       | integer  | Number of media assets downloaded              |
| `date_range`        | object   | `{first, last}` ISO timestamps                |
| `tags`              | list     | User-supplied or auto-extracted tags           |
| `custom`            | object   | Arbitrary key-value pairs for extensibility    |

### 2.3 Content Hash Computation

The `content_hash` is the SHA-256 digest of the content body (everything
after the closing `---` of the front matter), prefixed with `sha256:`. This
enables downstream tools to detect changes without parsing the full document.

---

## 3. Filename Normalization

Exported directory and file names must be safe across operating systems and
filesystems. The normalization pipeline applies the following transformations
in order:

### 3.1 Normalization Steps

1. **Unicode NFC normalization** — Compose combining characters.
2. **Transliteration** — Convert non-ASCII to closest ASCII equivalent
   (e.g., `u` for `u`, `ss` for `ss`, `n` for `n`). Use `unidecode` or
   equivalent library.
3. **Lowercase** — Convert to lowercase.
4. **Whitespace to hyphens** — Replace contiguous whitespace with a single `-`.
5. **Strip unsafe characters** — Remove anything not in `[a-z0-9._-]`.
6. **Collapse hyphens** — Replace multiple consecutive hyphens with one.
7. **Trim** — Remove leading/trailing hyphens and dots.
8. **Truncate** — Limit to 200 characters (preserving word boundaries when
   possible).
9. **Append hash suffix** — If truncation occurred, append `-<first 6 chars
   of SHA-256 of original>` to preserve uniqueness.

### 3.2 Collision Handling

If two source artifacts normalize to the same directory name, append an
incrementing numeric suffix: `my-conversation`, `my-conversation-2`, etc.
The `metadata.json` index at the output root tracks the mapping from source
URL to normalized path, preventing silent overwrites.

---

## 4. Markdown to HTML Pipeline

### 4.1 Trigger

HTML rendering is opt-in via `--html` flag or `WEBCTL_EXPORT_HTML=1`. When
enabled, every `content.md` is rendered to a sibling `content.html`.

### 4.2 Pipeline Stages

```
content.md
  --> parse YAML front matter (extract metadata)
  --> render Markdown body to HTML fragment
  --> inject into HTML template (with metadata sidebar)
  --> inline media references (relative paths to media/)
  --> write content.html
```

### 4.3 Template Requirements

* Self-contained single-file HTML (inline CSS, no external dependencies).
* Responsive layout suitable for print and screen.
* Metadata sidebar showing front matter fields.
* Media assets referenced via relative `./media/` paths.
* Table of contents generated from Markdown headings.
* Syntax highlighting for code blocks (inline CSS classes).

### 4.4 Tooling

The pipeline should support pluggable renderers. Default implementation
uses a lightweight Markdown library (language-appropriate for the CLI tool's
runtime). Custom templates can be supplied via `--html-template <path>`.

---

## 5. Conversation Caching with SHA-256 Change Detection

### 5.1 Problem

Re-exporting a conversation that has not changed wastes time and bandwidth.
Conversations that have grown (new messages appended) should be updated
incrementally when possible.

### 5.2 Cache Structure

Each exported conversation directory contains a `cache/` subdirectory:

```
cache/
  .content.sha256        # SHA-256 of last exported content body
  .source-state.json     # opaque state from the source (pagination tokens, etc.)
  .export-log.jsonl      # append-only log of export events
```

### 5.3 Change Detection Flow

On export, the tool reads `.content.sha256` from cache (if present), fetches
current state, and computes a new SHA-256. Matching hashes cause a skip;
differing hashes trigger a re-export and cache update; absent cache triggers
a full export.

### 5.4 Incremental Updates

For append-only sources (conversation threads), the tool may:

* Store the last-seen message ID or timestamp in `.source-state.json`.
* Fetch only messages after that checkpoint.
* Append new content to the existing `content.md`.
* Recompute and update the `content_hash` in front matter.
* Update `.content.sha256` in cache.

The `--force` flag bypasses all caching and performs a full re-export.

---

## 6. Atomic Writes and Merge Semantics

### 6.1 Atomic Write Protocol

Exports must not leave partially written files on disk. The write protocol:

1. Write to a temporary file in the same directory (`.<name>.tmp.<pid>`).
2. Flush and fsync the temporary file.
3. Atomically rename (via `os.rename` / `mv`) to the final path.
4. Update the `metadata.json` index.

This ensures that readers never observe a half-written export file, even if
the process is interrupted.

### 6.2 Merge Semantics for Repeated Exports

When exporting to a directory that already contains a previous export of the
same source:

| Scenario                    | Behavior                                     |
|-----------------------------|----------------------------------------------|
| Content unchanged           | Skip (no write)                              |
| Content updated (appended)  | Merge: append new entries, update metadata   |
| Content updated (edited)    | Replace: full overwrite, log previous hash   |
| Source deleted               | Mark as `status: archived` in metadata       |
| Conflict (concurrent write) | Second writer detects `.tmp` file, retries   |

The `--merge-strategy` flag accepts: `skip`, `append`, `replace` (default:
auto-detect based on content diff).

---

## 7. Context Fence Verification

### 7.1 Purpose

Context fences validate that an export captures a complete, coherent snapshot
of the source. Without verification, an export might capture a conversation
mid-update, producing inconsistent output.

### 7.2 Fence Checks

Before finalizing an export, the tool verifies:

* **Boundary completeness** — First and last messages are structurally
  complete (not truncated by pagination).
* **Sequence continuity** — Message IDs or timestamps form a monotonically
  increasing sequence with no gaps.
* **Participant consistency** — All referenced participants appear in the
  participant list.
* **Media reference integrity** — Every media reference in the content has a
  corresponding file in `media/`.
* **Hash consistency** — The `content_hash` in front matter matches the
  actual SHA-256 of the body.

### 7.3 Verification Outcome

Each check produces a pass/fail result plus optional warnings. If any check
fails, the export is rolled back (temporary files removed) and the user
receives actionable error messages. The `--no-verify` flag skips fence checks
(for debugging only).

---

## 8. Branch-Aware Export

### 8.1 Use Case

When the output directory is inside a Git repository (common for archival
workflows), the export tool can optionally create or update a dedicated
branch for each export session.

### 8.2 Workflow

```
1. Detect if output-dir is inside a git worktree
2. If --branch is specified:
   a. Create or checkout the named branch
   b. Perform export
   c. Stage all new/modified files in output-dir
   d. Commit with standardized message
   e. Return to original branch (if switched)
3. If --branch is not specified:
   a. Export to working directory as normal (no git operations)
```

### 8.3 Commit Message Format

```
webctl: export <source-type> <normalized-name>

Exported <N> items from <source-url>
Content hash: sha256:<hex>
Export timestamp: <ISO 8601>
```

### 8.4 Branch Naming Convention

When `--branch auto` is used, the tool generates a branch name:

```
webctl/export/<source-type>/<normalized-name>/<YYYY-MM-DD>
```

This allows multiple export sessions to coexist as separate branches,
facilitating review via standard Git diff and merge workflows.

### 8.5 Merge into Main Archive

Users merge export branches into their main archive branch via standard Git
merge. The `metadata.json` index uses append-only JSONL format for
merge-friendliness.

---

## 9. Media Asset Handling

Media assets referenced in exported content are downloaded to the local
`media/` subdirectory, named with a content-hash prefix (first 6 chars of
SHA-256): `a1b2c3-profile-photo.jpg`. Duplicate detection skips already-
downloaded files. After download, URL references in `content.md` are rewritten
to relative `./media/` paths, making exports self-contained and offline-viewable.

---

## 10. Error Handling

### Exit Codes

| Code | Meaning                                |
|------|----------------------------------------|
| 0    | Success (all items exported or cached) |
| 1    | Partial success (some items failed)    |
| 2    | Configuration or argument error        |
| 3    | Authentication or access error         |
| 4    | Context fence verification failure     |

Interrupted exports are detected on next run via stale `.tmp` files, missing
cache entries, or `metadata.json` / filesystem mismatches. Recovery cleans up
temporaries and resumes from the last known good state.

---

## Summary

This design provides a complete archival pipeline from web content extraction
to persistent, portable, verifiable local storage. The key principles are:

* **Deterministic naming** via normalization ensures cross-platform safety.
* **YAML front matter** on every artifact enables rich metadata queries.
* **SHA-256 caching** avoids redundant work on unchanged content.
* **Atomic writes** guarantee filesystem consistency.
* **Context fences** verify export completeness and correctness.
* **Branch-aware export** integrates naturally with Git-based archival flows.
* **Self-contained output** with local media makes exports fully offline-capable.
