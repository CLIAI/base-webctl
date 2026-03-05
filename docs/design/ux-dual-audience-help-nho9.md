---
id: nho9
title: "Dual-Audience Help: Human-Readable & Agent-Optimized Output"
category: ux
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [help-system, dual-audience, ai-agents, documentation, information-density, reference]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Dual-Audience Help: Human-Readable & Agent-Optimized Output

## Problem Statement

CLI tools today serve two fundamentally different consumers:

* **Humans** who scan visually, prefer concise summaries, and rely on formatting
  cues (bold, indentation, color) to parse structure.
* **AI agents** that parse text programmatically, benefit from exhaustive
  machine-readable detail, and need semantic hints about capabilities they
  cannot infer from flag names alone.

A single `--help` output cannot serve both audiences well. Human-optimized help
omits details agents need (semantic field types, expected value patterns,
inter-flag constraints). Agent-optimized help overwhelms humans with density.

The solution is **different content for different audiences**, not merely
different formatting of the same content.

## Design Principles

1. **Single source of truth** — All help data lives in one `HELP_DATA` structure
   per command. Human and agent renderers draw from the same source, eliminating
   drift between the two views.

2. **Additive, not divergent** — Agent output is a strict superset of human
   output in information content (though not in presentation). Everything a
   human sees, an agent also sees, plus additional fields.

3. **Zero-cost for humans** — The default `--help` experience is uncluttered.
   Agent-specific metadata never leaks into the human view.

4. **Self-describing** — Agent output includes enough metadata for an agent to
   construct valid invocations without external documentation.

5. **Aggregation-friendly** — Each binary can emit a one-line self-description
   for use in multi-tool indexes and capability discovery.

## The `HELP_DATA` Structure

Every subcommand defines a `HELP_DATA` constant (or equivalent registration)
containing both shared and audience-specific fields.

### Shared Fields

These fields are consumed by both human and agent renderers:

```
HELP_DATA = {
    "name":        "upload",
    "summary":     "Upload a file to the current conversation",
    "usage":       "webctl upload [FLAGS] <file-path>",
    "flags": [
        {
            "short":       "-t",
            "long":        "--title",
            "type":        "string",
            "default":     null,
            "required":    false,
            "description": "Display title for the uploaded file",
        },
        {
            "short":       "-w",
            "long":        "--wait",
            "type":        "duration",
            "default":     "30s",
            "required":    false,
            "description": "Max time to wait for upload confirmation",
        },
    ],
    "positional_args": [
        {
            "name":     "file-path",
            "required": true,
            "description": "Path to the file to upload",
        },
    ],
    "examples": [
        'webctl upload ./report.pdf',
        'webctl upload --title "Q3 Results" ./report.pdf',
    ],
}
```

### Agent-Only Fields

These fields exist in `HELP_DATA` but are **only rendered** by the agent
renderer. They carry semantic information that agents need but humans find
noisy.

```
HELP_DATA["agent"] = {
    "capability_tags": ["file-upload", "binary-payload", "async-confirm"],

    "input_constraints": {
        "file-path": {
            "mime_types":    ["*/*"],
            "max_size_mb":   100,
            "pattern":       null,
        },
        "--title": {
            "max_length":    255,
            "pattern":       "^[\\w\\s\\-\\.]+$",
        },
        "--wait": {
            "min": "1s",
            "max": "300s",
        },
    },

    "output_schema": {
        "stdout": "confirmation-line",
        "exit_codes": {
            "0": "upload succeeded",
            "1": "generic failure",
            "2": "timeout waiting for confirmation",
            "3": "file too large or unsupported type",
        },
    },

    "preconditions": [
        "Active browser session (webctl session must be running)",
        "Conversation page loaded with file-upload capability",
    ],

    "side_effects": [
        "File appears in remote conversation as attachment",
        "Conversation state changes (new message injected)",
    ],

    "related_commands": ["send", "session", "status"],

    "idempotent": false,
    "safe":       false,
    "reversible": false,
}
```

#### Key Agent-Only Field Definitions

| Field                | Purpose                                                    |
|----------------------|------------------------------------------------------------|
| `capability_tags`    | Semantic labels for capability matching and tool selection  |
| `input_constraints`  | Value boundaries, patterns, MIME types for each parameter   |
| `output_schema`      | What stdout contains, plus all exit codes with meanings     |
| `preconditions`      | Conditions that must hold before invocation succeeds        |
| `side_effects`       | Observable state changes caused by the command              |
| `related_commands`   | Commands often used in conjunction                          |
| `idempotent`         | Whether repeated calls with same args produce same result   |
| `safe`               | Whether the command is read-only (no state mutation)        |
| `reversible`         | Whether effects can be undone                               |

## Renderers

### `--help` (Human Renderer)

The default help flag produces formatted, scannable output:

```
webctl upload - Upload a file to the current conversation

USAGE
  webctl upload [FLAGS] <file-path>

FLAGS
  -t, --title <string>     Display title for the uploaded file
  -w, --wait <duration>    Max time to wait for upload confirmation [default: 30s]

ARGS
  <file-path>  Path to the file to upload (required)

EXAMPLES
  webctl upload ./report.pdf
  webctl upload --title "Q3 Results" ./report.pdf
```

Design rules for the human renderer:

* Maximum 80 columns, no horizontal scrolling.
* Color and bold via ANSI when stdout is a TTY; plain text otherwise.
* Group flags by relevance, not alphabetically.
* Show defaults inline with `[default: ...]`.
* Omit agent-only metadata entirely.

### `--help-for-agents` (Agent Renderer)

Produces a structured, information-dense block optimized for LLM consumption.
Output format is valid YAML (chosen over JSON for readability in LLM context
windows; parseable by both humans and machines).

```
command: upload
summary: Upload a file to the current conversation
usage: "webctl upload [FLAGS] <file-path>"
flags:
  - name: --title
    short: -t
    type: string
    required: false
    default: null
    max_length: 255
    pattern: "^[\\w\\s\\-\\.]+$"
    description: Display title for the uploaded file
  - name: --wait
    short: -w
    type: duration
    required: false
    default: "30s"
    min: "1s"
    max: "300s"
    description: Max time to wait for upload confirmation
positional_args:
  - name: file-path
    required: true
    mime_types: ["*/*"]
    max_size_mb: 100
    description: Path to the file to upload
exit_codes:
  0: upload succeeded
  1: generic failure
  2: timeout waiting for confirmation
  3: file too large or unsupported type
preconditions:
  - Active browser session
  - Conversation page loaded with file-upload capability
side_effects:
  - File appears in remote conversation as attachment
  - Conversation state changes
capability_tags: [file-upload, binary-payload, async-confirm]
idempotent: false
safe: false
reversible: false
related_commands: [send, session, status]
```

Design rules for the agent renderer:

* Flat structure: constraint fields merged directly into flag entries (no
  nesting into a separate `input_constraints` block). This reduces token count
  and parse complexity for agents.
* YAML output, valid and parseable.
* No ANSI colors or formatting.
* Always written to stdout regardless of TTY detection.
* Include every field, even when value is null/false (explicit > implicit).

### Why Different Content, Not Just Different Format

Consider the `--wait` flag. The human view shows `[default: 30s]`. The agent
view additionally shows `min: "1s"` and `max: "300s"`. These bounds are
critical for an agent constructing valid invocations but would clutter the
human view.

Similarly, `preconditions` and `side_effects` are essential for an agent to
reason about command sequencing. Humans infer these from context and
experience. Printing "Active browser session required" in `--help` is
redundant for a human who just ran `webctl session start`, but an agent
planning a multi-step workflow needs this explicitly.

## `--help-reference-md`: Recursive CLI Reference Dump

The `--help-reference-md` flag produces a Markdown document containing structured
agent metadata, recursively aggregated from the current scope downward.

### Recursive Concatenation Behavior

The flag operates at whatever level it is invoked and concatenates downward:

* **On a subcommand** (e.g., `webctl upload --help-reference-md`): Emits the
  `--help-for-agents` output for that subcommand, including metadata for each of
  its flags.
* **On a command** (e.g., `webctl session --help-reference-md`): Emits the
  command's own reference, then recursively appends the `--help-reference-md`
  output of each of its subcommands.
* **On the binary itself** (e.g., `webctl --help-reference-md`): Emits the
  binary-level metadata, then recursively appends the `--help-reference-md`
  output of every command (which in turn includes their subcommands).

This recursive design means a single invocation at any level produces a
complete view of everything below it — no separate aggregation step needed.

### Output Structure

```markdown
# webctl CLI Reference

Generated: 2026-03-03T14:22:00Z
Version: 0.4.1

## upload

\```yaml
command: upload
summary: Upload a file to the current conversation
... (full --help-for-agents output)
\```

## send

\```yaml
command: send
summary: Send a text message in the current conversation
...
\```
```

The output is designed to be:

* Committed to a repository as `docs/cli-reference.md` for version-controlled
  documentation.
* Fed wholesale into an agent's context window as a complete capability map.
* Diffed between versions to detect CLI surface changes.

### Usage Patterns

* **CI/CD**: Generate on every release, commit to docs, detect breaking changes
  via diff.
* **Agent bootstrapping**: Agent reads the full reference once at session start,
  gaining complete knowledge of the CLI surface.
* **Documentation sites**: Convert to HTML/PDF with standard Markdown tooling.
* **Scoped exploration**: An agent can request `--help-reference-md` on a specific
  command subtree rather than ingesting the entire binary surface.

## Self-Advertising to AI Agents

When an agent encounters a `webctl` binary for the first time, it needs to
quickly determine what the tool does and whether it is relevant. The tool
should actively help with this discovery.

### The `--help-oneliner` Flag

Every binary supports a `--help-oneliner` flag that outputs a single line:

```
webctl --help-oneliner
```

Output:

```
webctl: Browser-automation CLI for web platform interactions (send, upload, extract, monitor). Use --help-for-agents for structured capability metadata.
```

Properties of the oneliner:

* Exactly one line, no trailing newline, no ANSI.
* Format: `<binary-name>: <description>. Use --help-for-agents for structured capability metadata.`
* The trailing sentence is the **self-advertisement**: it tells the agent that
  richer metadata is available and how to get it.
* Maximum 200 characters for the description portion.

### Multi-Binary Aggregation

In a toolchain with multiple binaries (e.g., `webctl`, `monitor-webctl`,
`extract-webctl`), an agent can quickly survey available capabilities:

```bash
for bin in webctl monitor-webctl extract-webctl; do
    $bin --help-oneliner 2>/dev/null
done
```

Output:

```
webctl: Browser-automation CLI for web platform interactions. Use --help-for-agents for structured capability metadata.
monitor-webctl: Long-running watcher for conversation events. Use --help-for-agents for structured capability metadata.
extract-webctl: Content extraction and data export from web pages. Use --help-for-agents for structured capability metadata.
```

An agent can parse these lines to decide which binaries to query further with
`--help-for-agents`, minimizing unnecessary context window usage.

### Discovery Protocol

The recommended agent discovery flow:

1. **Scan**: Run `--help-oneliner` on all binaries in PATH matching a known
   prefix pattern. Cost: 1 line per binary.
2. **Select**: Identify relevant binaries based on oneliner descriptions.
3. **Detail**: Run `--help-for-agents` on selected binaries only. Cost: ~50-100
   lines per subcommand.
4. **Full reference**: Optionally run `--help-reference-md` if the agent needs the
   complete surface for planning multi-step workflows.

This graduated approach keeps context window usage proportional to actual need.

## Implementation Notes

### Flag Conflicts and Precedence

* `--help` and `--help-for-agents` are mutually exclusive. If both are passed,
  `--help-for-agents` wins (the more specific request takes precedence).
* `--help-oneliner` suppresses all other output, including `--help`.
* `--help-for-agents` on a parent command (e.g., `webctl --help-for-agents`) emits a
  summary of all subcommands with their capability tags, not the full detail
  of each. Use `webctl <subcommand> --help-for-agents` for per-command detail, or
  `webctl --help-reference-md` for a recursive dump of everything.

### Keeping `HELP_DATA` Honest

Agent-only fields (preconditions, side effects, constraints) are promises to
the agent. Stale or incorrect metadata leads to failed invocations and wasted
agent compute. Mitigation strategies:

* **Tests**: For each command, a test asserts that `HELP_DATA` exit codes match
  actual exit code paths in the implementation.
* **Linting**: A CI check verifies that every flag in the argument parser has a
  corresponding entry in `HELP_DATA`, and vice versa.
* **Generated where possible**: Derive `type`, `required`, and `default` from
  the argument parser at build time rather than duplicating manually.

### Output Format Stability

The `--help-for-agents` YAML schema is versioned. A top-level `schema_version` field
(e.g., `schema_version: 1`) allows agents to detect and adapt to format
changes. Breaking changes increment the major version.

## Summary of Flags

| Flag              | Audience | Output               | Scope                          |
|-------------------|----------|----------------------|--------------------------------|
| `--help`          | Human    | Formatted text       | Current command                |
| `--help-for-agents`    | Agent    | YAML with full metadata | Current command             |
| `--help-oneliner` | Agent    | Single description line | Binary-level                |
| `--help-reference-md`  | Both     | Markdown with YAML blocks | Recursive from current scope |
