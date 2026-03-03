---
id: 1p0c
title: "Phenomena Capture Protocol: Documenting Ephemeral UI States"
category: ops
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [phenomena, ephemeral-state, investigation, raw-capture, debugging, ui-state]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Phenomena Capture Protocol: Documenting Ephemeral UI States

## Problem Statement

Web UIs present ephemeral states: transient modals, dynamic overlays, loading
skeletons, error banners, toast notifications, rate-limit walls, and consent
gates. These states disappear within seconds or upon interaction. When
investigating unexpected behavior, operators frequently lose critical evidence
because they attempt to analyze _during_ the event rather than preserving the
raw state first.

**Core principle: capture raw data FIRST, analyze later.** The window for
collecting evidence is brief and non-renewable. Analysis can happen at any time
afterward.

## Directory Naming Convention

Every phenomena capture session produces a directory of artifacts. Use the
following naming scheme:

```
phenomena/{YYYY-MM-DD}T{HHmm}--{slug}/
```

* **Date-time prefix** -- ISO-8601 date with hours and minutes, no colons
  (filesystem-safe). Use UTC or local with consistent convention per project.
* **Slug** -- 2-5 word lowercase hyphenated description of the observed event.

Examples:

```
phenomena/2026-03-03T1422--modal-blocks-input/
phenomena/2026-03-03T1507--rate-limit-banner-unexpected/
phenomena/2026-03-03T0900--consent-gate-loop/
```

### Checklist: Directory Setup

- [ ] Create the timestamped directory immediately upon observing the phenomenon
- [ ] Use UTC timestamps if the project operates across time zones
- [ ] Keep the slug descriptive but short (no brand names, no service names)
- [ ] Never reuse a directory -- each observation gets its own capture

## Required Artifacts

Every capture directory must contain the following files. Collect them in the
order listed -- priority descends from top to bottom.

### 1. Screenshot(s)

- [ ] Capture a full-page screenshot of the current viewport state
- [ ] Name: `01-screenshot-{description}.png`
- [ ] If the phenomenon involves a sequence, capture multiple numbered screenshots
- [ ] Use non-interactive screenshot tools (no tools requiring manual selection)
- [ ] Capture the browser chrome / URL bar when relevant to the investigation

```
01-screenshot-initial-state.png
02-screenshot-after-click.png
03-screenshot-error-visible.png
```

### 2. Raw HTML Snapshot

- [ ] Save the full `document.documentElement.outerHTML` at time of capture
- [ ] Name: `dom-snapshot.html`
- [ ] Capture via CDP `Runtime.evaluate` or equivalent before any interaction
- [ ] Do NOT prettify or reformat -- preserve the exact DOM as rendered
- [ ] If the phenomenon involves dynamic content, capture multiple snapshots
  with sequential numbering: `dom-snapshot-01.html`, `dom-snapshot-02.html`

### 3. Metadata File

- [ ] Name: `metadata.json`
- [ ] Include the following fields:

```json
{
  "captured_at": "2026-03-03T14:22:37Z",
  "url": "https://example.com/path",
  "viewport": { "width": 1280, "height": 720 },
  "user_agent": "...",
  "page_title": "...",
  "trigger": "description of what caused the state",
  "operator_notes": "free-form initial observation"
}
```

- [ ] Populate `captured_at` programmatically -- do not estimate
- [ ] The `trigger` field describes what action preceded the phenomenon
- [ ] The `operator_notes` field captures the operator's first impression

### 4. Extracted Structured Data

- [ ] Name: `extracted.json` or `extracted.jsonl`
- [ ] Extract any structured data visible in the UI (tables, lists, counters)
- [ ] Include CSS selectors or XPaths used for extraction
- [ ] Preserve original data types (numbers as numbers, not strings)

### 5. Network / Console Logs (when available)

- [ ] Name: `network-log.json`, `console-log.json`
- [ ] Capture via CDP `Network.requestWillBeSent`, `Log.entryAdded` events
- [ ] Filter to the time window surrounding the phenomenon
- [ ] Redact authentication tokens and cookies before committing

### Artifact Checklist Summary

| # | File                     | Required | Format  | Priority |
|---|--------------------------|----------|---------|----------|
| 1 | `01-screenshot-*.png`    | Yes      | PNG     | Critical |
| 2 | `dom-snapshot.html`      | Yes      | HTML    | Critical |
| 3 | `metadata.json`          | Yes      | JSON    | Critical |
| 4 | `extracted.json`         | No       | JSON(L) | High     |
| 5 | `network-log.json`       | No       | JSON    | Medium   |
| 6 | `console-log.json`       | No       | JSON    | Medium   |

## Before/After Interaction Documentation

When investigating a phenomenon that requires interaction (clicking a button,
submitting a form, scrolling), document the state transition explicitly.

### Checklist: Before Interaction

- [ ] Capture all required artifacts (screenshot, DOM, metadata) BEFORE touching
  anything
- [ ] Record the exact interaction you plan to perform in `metadata.json`
  under a `planned_interaction` field
- [ ] Note any dynamic elements (timers, animations, countdowns) and their
  current values
- [ ] If the phenomenon may be time-sensitive, record elapsed time since page
  load

### Checklist: After Interaction

- [ ] Capture all required artifacts again with `after-` prefix or incremented
  numbering
- [ ] Record the actual interaction performed (may differ from planned)
- [ ] Note any new elements that appeared or disappeared
- [ ] Compare DOM snapshots to identify what changed:

```bash
diff <(xmllint --format dom-snapshot-before.html 2>/dev/null || cat dom-snapshot-before.html) \
     <(xmllint --format dom-snapshot-after.html 2>/dev/null || cat dom-snapshot-after.html) \
     > dom-diff.txt
```

- [ ] Save the diff as `dom-diff.txt` in the capture directory
- [ ] If the phenomenon disappeared after interaction, note this explicitly --
  that is itself valuable data

### State Transition Record

Add a `transitions` array to `metadata.json`:

```json
{
  "transitions": [
    {
      "step": 1,
      "action": "none (initial observation)",
      "timestamp": "2026-03-03T14:22:37Z",
      "artifacts": ["01-screenshot-initial.png", "dom-snapshot-01.html"]
    },
    {
      "step": 2,
      "action": "clicked dismiss button at selector .modal-close",
      "timestamp": "2026-03-03T14:22:45Z",
      "artifacts": ["02-screenshot-after-dismiss.png", "dom-snapshot-02.html"]
    }
  ]
}
```

## Investigation Methodology

Follow these steps in strict order. Do not skip ahead to analysis.

### Phase 1: Immediate Capture (0-30 seconds)

- [ ] Stop all other automation or interaction with the page
- [ ] Create the phenomena directory
- [ ] Take a screenshot
- [ ] Dump the DOM
- [ ] Write initial `metadata.json` with timestamp, URL, and trigger
- [ ] If network/console logging is active, mark the current timestamp

**Rule: No analysis, no theorizing, no clicking. Only capture.**

### Phase 2: Contextual Capture (30-120 seconds)

- [ ] Capture any additional screenshots showing surrounding UI context
- [ ] Extract visible structured data (counters, status text, error codes)
- [ ] Record any visible timers, countdowns, or auto-refresh indicators
- [ ] Check if the phenomenon reproduces on page reload (capture that too)
- [ ] Note the browser/tool version in metadata

### Phase 3: Controlled Interaction (if needed)

- [ ] Document the planned interaction before performing it
- [ ] Perform ONE interaction at a time
- [ ] Capture after-state for each interaction
- [ ] Generate diffs between before and after DOM snapshots
- [ ] If the phenomenon disappears, stop interacting and document the loss

### Phase 4: Evidence Organization

- [ ] Verify all required artifacts are present in the directory
- [ ] Ensure all files are named according to convention
- [ ] Validate `metadata.json` parses as valid JSON
- [ ] Add a `summary.md` with a 2-3 sentence description of the phenomenon
- [ ] Cross-reference with any existing phenomena captures if the behavior
  has been seen before

### Phase 5: Analysis (separate session)

- [ ] Review the captured artifacts with fresh eyes
- [ ] Formulate hypotheses based on the DOM content and screenshots
- [ ] Test hypotheses against the structured data
- [ ] Document findings in `analysis.md` within the phenomena directory
- [ ] Link to related phenomena captures if patterns emerge
- [ ] Determine if the phenomenon requires a code change, configuration
  change, or is expected platform behavior

## Anti-Patterns

The following behaviors destroy evidence and must be avoided:

* **Clicking first, capturing later** -- The most common mistake. Once you
  interact, the original state is gone forever.
* **Analyzing during capture** -- Slows down evidence collection and risks
  missing the window.
* **Overwriting captures** -- Each observation is unique. Never reuse a
  directory or overwrite a previous snapshot.
* **Omitting metadata** -- A screenshot without URL, timestamp, and trigger
  context is nearly useless for later analysis.
* **Redacting too early** -- Capture everything first, redact sensitive data
  before sharing or committing. Do not let redaction concerns slow down the
  initial capture.
* **Naming with brand/service names** -- Keep directory slugs and file names
  generic and descriptive of the UI behavior, not the platform.

## Automation Integration

CLI tools implementing this protocol should provide:

- [ ] A `capture` subcommand that creates the directory, takes a screenshot,
  dumps the DOM, and writes initial metadata in one atomic operation
- [ ] Configurable output root directory (default: `./phenomena/`)
- [ ] Configurable screenshot format (PNG preferred, JPEG acceptable)
- [ ] Option to attach to an existing browser session via CDP
- [ ] Structured exit codes indicating capture success or partial failure
- [ ] JSONL output mode for machine consumption of capture results

## File Retention and Cleanup

- [ ] Phenomena directories should be excluded from version control by default
  (add `phenomena/` to `.gitignore`)
- [ ] Archive captures older than 30 days to compressed storage
- [ ] Never delete captures that are referenced by open investigations
- [ ] Use `tar` with `xz` compression for archival:

```bash
tar -cJf phenomena-archive-2026-03.tar.xz phenomena/2026-03-*/
```
