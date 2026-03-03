---
id: 87dl
title: "Structural Information Preservation: ETL Fidelity for Web Content"
category: data
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [structural-preservation, html-to-markdown, information-fidelity, dual-channel, etl, qa-scorecard]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Structural Information Preservation: ETL Fidelity for Web Content

## Motivation

Web pages carry meaning not only in their text but in their **structure**:
headings establish hierarchy, tables encode relational data, lists communicate
ordering or grouping, and nested containers express parent-child relationships.
When a CLI tool extracts content from a page, every structural signal that is
dropped is information permanently lost. Downstream consumers (LLMs, search
indexes, archival stores) receive a degraded representation and make worse
decisions as a result.

This document defines the **Structural Isomorphism Principle**, classifies
acceptable versus unacceptable information losses, specifies a dual-channel
extraction architecture, outlines a zero-dependency browser-side
HTML-to-Markdown converter, and provides a QA scorecard for measuring fidelity.

## 1. Structural Isomorphism Principle

**Definition.** An extraction pipeline satisfies _structural isomorphism_ when
the output representation preserves a one-to-one mapping for every
semantically meaningful structural element in the source HTML.

More precisely, given:

* `S` = the set of structural elements in the source DOM (headings, lists,
  tables, blockquotes, code blocks, links, emphasis, images)
* `T` = the set of structural elements in the output representation

the extraction is **isomorphic** when there exists a bijection `f: S -> T` such
that for every element `s` in `S`:

1. `f(s)` preserves the **type** (heading remains heading, table remains table)
2. `f(s)` preserves the **content** (text is neither truncated nor altered)
3. `f(s)` preserves **nesting depth** (an `<li>` inside an `<ol>` inside a
   `<blockquote>` retains three levels)
4. `f(s)` preserves **sibling order** (elements appear in document order)

Perfect isomorphism is an ideal. The practical goal is to maximize it while
acknowledging that some decorative or layout-only structures may be
intentionally discarded.

## 2. Acceptable vs. Unacceptable Information Losses

Not all losses are equal. The following taxonomy classifies structural losses
into three tiers.

### 2.1 Tier 1 — Unacceptable Losses (must never occur)

These losses destroy semantics that cannot be recovered:

| Loss | Why it matters |
|------|----------------|
| Table flattened to plain text | Row/column relationships lost; data becomes ambiguous |
| Heading hierarchy removed | Document outline destroyed; section boundaries invisible |
| Ordered list converted to unordered | Sequence semantics lost (steps, rankings) |
| Link URLs dropped | Navigation and reference graph severed |
| Code block merged into paragraph | Syntax boundaries lost; code becomes unreadable |
| Nested list collapsed to flat | Hierarchical grouping destroyed |
| Image alt-text discarded | Accessibility and content description lost |

### 2.2 Tier 2 — Tolerable Losses (acceptable with justification)

| Loss | When acceptable |
|------|-----------------|
| Decorative `<div>` wrappers removed | When they carry no semantic class or ARIA role |
| Inline style attributes stripped | When visual styling is not content-bearing |
| `<span>` tags removed | When they serve only as styling hooks |
| Comment nodes dropped | When they contain no user-visible content |
| SVG icons omitted | When alt-text or adjacent label captures the meaning |

### 2.3 Tier 3 — Intentional Omissions (by design)

| Omission | Rationale |
|----------|-----------|
| `<script>` and `<style>` blocks | Not content; execution/presentation layer |
| Tracking pixels and beacons | No semantic value |
| Hidden elements (`display:none`) | Not visible to users; often boilerplate |
| Navigation chrome (menus, footers) | Configurable; often noise for content extraction |
| Cookie consent banners | Ephemeral UI, not page content |

## 3. Dual-Channel Extraction Architecture

A single extraction format cannot serve all downstream needs. The architecture
provides **two complementary channels** for every extraction operation.

### 3.1 Channel Overview

```
┌─────────────┐
│  Live DOM    │
│  (browser)   │
└──────┬───────┘
       │
       ├──────────────────────────────────────┐
       │                                      │
       ▼                                      ▼
┌──────────────┐                    ┌──────────────────┐
│ Channel A:   │                    │ Channel B:        │
│ Markdown     │                    │ Sanitized HTML    │
│ (human/LLM)  │                    │ (machine/archive) │
└──────────────┘                    └──────────────────┘
```

### 3.2 Channel A — Markdown

**Purpose:** Human-readable, LLM-friendly representation.

**Properties:**

* Compact token footprint (typically 40-60% smaller than HTML)
* Preserves headings, lists, tables, code blocks, links, emphasis
* Strips all decorative markup
* Suitable for direct insertion into LLM context windows
* Round-trippable to HTML for common elements

**Format:** CommonMark-compliant Markdown with GFM table extensions.

### 3.3 Channel B — Sanitized HTML

**Purpose:** Machine-parseable, lossless structural archive.

**Properties:**

* Retains full DOM structure for elements within the extraction scope
* Strips `<script>`, `<style>`, event handlers, and tracking attributes
* Preserves `class` and `id` attributes (useful for CSS-selector-based
  re-extraction)
* Preserves `data-*` attributes when they carry content metadata
* Keeps `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<td>`, `<th>` intact
* Retains ARIA roles and labels

**Use cases:**

* Re-extraction with different rules without re-fetching
* Structural diffing between page versions
* Forensic analysis of page layout changes
* Feeding into specialized parsers (table extractors, form analyzers)

### 3.4 Extraction Payload Structure

Every extraction operation produces a structured payload:

```yaml
extraction:
  url: "https://example.com/page"
  timestamp: "2026-03-03T14:22:00Z"
  selector: "main.content"          # CSS selector used for scoping
  channels:
    markdown:
      content: |
        # Page Title
        Some paragraph text...
      byte_size: 4821
      structural_elements:
        headings: 3
        tables: 1
        code_blocks: 2
        lists: 4
        links: 12
        images: 2
    html:
      content: "<main class=\"content\">..."
      byte_size: 11204
  metadata:
    page_title: "Page Title"
    page_lang: "en"
    extraction_duration_ms: 45
```

### 3.5 YAML Front Matter for Machine-Readable Metadata

Extracted content files stored on disk use YAML front matter to encode
provenance and structural metadata:

```yaml
---
source_url: "https://example.com/page"
extracted_at: "2026-03-03T14:22:00Z"
extractor_version: "0.1.0"
selector: "main.content"
channel: markdown
structural_score: 94
element_counts:
  headings: 3
  tables: 1
  code_blocks: 2
  lists: 4
  links: 12
  images: 2
---
```

This front matter enables:

* Programmatic filtering and indexing of extracted content
* Provenance tracking (when, from where, which version)
* Quality assessment without re-parsing the content body
* Batch QA reporting across extraction runs

## 4. Zero-Dependency Browser-Side HTML-to-Markdown Converter

### 4.1 Design Constraints

The converter must:

1. **Run inside the browser context** (injected via CDP `Runtime.evaluate`)
2. **Have zero external dependencies** (no npm packages, no CDN loads)
3. **Be a single self-contained function** (< 500 lines, serializable)
4. **Handle real-world HTML** (malformed nesting, missing closing tags,
   browser-quirks-mode corrections)
5. **Complete in < 100ms** for typical page content

### 4.2 Conversion Strategy

The converter operates on the live DOM (post-browser-parse), not raw HTML
strings. This is deliberate: the browser has already performed error recovery,
computed styles, and resolved relative URLs.

```
Input: DOM Element (e.g., document.querySelector('main'))
  │
  ├─ Phase 1: Tree walk (recursive depth-first)
  │   ├─ Map each node type to a Markdown emitter
  │   ├─ Track nesting context (list depth, blockquote depth)
  │   └─ Collect link references for bottom-of-section placement
  │
  ├─ Phase 2: Table detection and formatting
  │   ├─ Measure column widths
  │   ├─ Emit GFM pipe-table syntax
  │   └─ Fall back to HTML passthrough for complex tables (colspan/rowspan)
  │
  └─ Phase 3: Post-processing
      ├─ Collapse excessive blank lines (max 2 consecutive)
      ├─ Trim trailing whitespace per line
      └─ Normalize Unicode whitespace characters
```

### 4.3 Node-Type Mapping

| HTML Element | Markdown Output | Notes |
|-------------|-----------------|-------|
| `<h1>`..`<h6>` | `#`..`######` prefix | Capped at 6 levels |
| `<p>` | Double newline separated | Inline formatting preserved |
| `<strong>`, `<b>` | `**text**` | |
| `<em>`, `<i>` | `*text*` | |
| `<code>` (inline) | `` `text` `` | Backtick escaping for content with backticks |
| `<pre><code>` | Fenced code block | Language hint from `class="language-*"` |
| `<a href>` | `[text](url)` | Absolute URL resolution |
| `<img>` | `![alt](src)` | Falls back to `src` basename if no alt |
| `<ul>/<li>` | `* item` | Nested with 2-space indent per level |
| `<ol>/<li>` | `1. item` | Renumbered sequentially |
| `<blockquote>` | `> text` | Nested `>>` for inner quotes |
| `<table>` | GFM pipe table | See section 4.2 |
| `<hr>` | `---` | |
| `<br>` | Two trailing spaces + newline | CommonMark hard break |
| `<details>` | Preserved as HTML passthrough | No Markdown equivalent |
| `<del>`, `<s>` | `~~text~~` | GFM strikethrough |

### 4.4 Edge Cases and Fallbacks

**Complex tables** (colspan, rowspan): When a table uses `colspan` or `rowspan`
attributes, the GFM pipe-table format cannot represent the merged cells. The
converter falls back to emitting the sanitized HTML `<table>` block directly.
Most Markdown renderers will pass through raw HTML.

**Deeply nested lists** (> 4 levels): Markdown renderers vary in their support
for deep nesting. The converter caps indent depth at 4 levels and flattens
deeper items with a `>` prefix to indicate overflow.

**Empty elements**: Nodes with no text content and no meaningful attributes are
silently omitted to avoid empty Markdown constructs.

**Mixed content in table cells**: Cells containing block-level elements
(paragraphs, lists) trigger the HTML-passthrough fallback for the entire table.

## 5. QA Scorecard

### 5.1 Purpose

The QA scorecard provides a **quantitative measure** of extraction fidelity.
Every extraction can be scored, enabling:

* Automated regression detection when the converter changes
* Per-page-type quality benchmarking
* Threshold-based alerts (extraction below target triggers review)

### 5.2 Scoring Methodology

The score is computed by comparing structural elements between the source DOM
and the extracted output.

```
Score = (Preserved Elements / Total Source Elements) * 100
```

Where each element category is weighted:

| Category | Weight | Rationale |
|----------|--------|-----------|
| Headings | 1.5 | Outline structure is high-value |
| Tables | 2.0 | Relational data is hard to recover |
| Ordered lists | 1.5 | Sequence semantics matter |
| Unordered lists | 1.0 | Grouping semantics |
| Code blocks | 1.5 | Exact content preservation critical |
| Links | 1.0 | Reference connectivity |
| Images | 1.0 | Alt-text and visual reference |
| Blockquotes | 1.0 | Attribution and citation |
| Emphasis/strong | 0.5 | Lower priority; decorative overlap |

**Weighted score formula:**

```
Score = Σ(weight_i * preserved_i) / Σ(weight_i * total_i) * 100
```

### 5.3 Target Threshold

**Target: >= 90% weighted structural score.**

Scores below 90% indicate a structural fidelity problem that requires
investigation. Common causes:

* Page uses non-standard markup that the converter does not handle
* Content is dynamically loaded after the extraction snapshot
* Page relies heavily on CSS/JS for visual structure (accordions, tabs)
* Custom web components with shadow DOM content

### 5.4 Scorecard Report Format

The report is a table showing each element category with source count,
extracted count, weight, and weighted contribution. The final line shows the
aggregate weighted score as a percentage. Reports are emitted to stderr when
`--verbose` is active, and always attached to the extraction payload metadata.

### 5.5 Automated QA Integration

When the score falls below threshold, the extraction payload includes the full
scorecard as metadata so downstream consumers can decide whether to accept,
retry with different parameters, or escalate.

## 6. Implementation Priorities

### Phase 1 — Foundation

* Implement the zero-dep DOM-to-Markdown converter
* Cover Tier 1 elements (headings, tables, lists, code blocks, links)
* Basic element counting for scorecard

### Phase 2 — Dual Channel

* Add sanitized HTML channel alongside Markdown
* YAML front matter generation for stored extractions
* Structured payload format

### Phase 3 — QA Automation

* Weighted scoring implementation
* Threshold-based warnings in CLI output
* Regression test suite with known-good page snapshots

### Phase 4 — Hardening

* Complex table fallback (colspan/rowspan detection)
* Shadow DOM traversal for web components
* Dynamic content detection (intersection observer, lazy-load triggers)

## 7. Open Questions

* **Shadow DOM access:** CDP can pierce shadow boundaries, but the converter
  needs explicit support. Scope and priority to be determined.
* **Math notation:** Pages with MathML or LaTeX-in-HTML may need a specialized
  handler. Evaluate frequency before investing.
* **Right-to-left text:** Markdown has no native bidi support. Investigate
  whether Unicode bidi markers are sufficient or if HTML passthrough is needed.
* **Incremental extraction:** For long-lived pages that update in place,
  should the pipeline support structural diffs? This intersects with the
  archival use case.
