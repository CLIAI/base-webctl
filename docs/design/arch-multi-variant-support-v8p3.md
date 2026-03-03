---
id: v8p3
title: "Multi-Variant Support: Selector Registries & Framework-Specific Patterns"
category: arch
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [multi-variant, selector-registry, framework-specific, auto-detection, cross-platform]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Multi-Variant Support: Selector Registries & Framework-Specific Patterns

## Problem Statement

Web platforms frequently maintain multiple frontend implementations of the same
interface. These variants may use entirely different frameworks (React, Ember,
vanilla TypeScript), different DOM structures, different CSS class naming
conventions, and different event-handling paradigms. A web-control CLI that
hardcodes selectors and interaction patterns for a single variant breaks
silently when the platform switches frontends, or fails entirely for users who
encounter the alternate variant.

A robust tool must detect which variant it is operating against, select the
correct set of selectors and interaction strategies, and degrade gracefully when
an unknown variant is encountered.

## Principles

### 1. Detect Before Acting

Variant detection must occur **before** any selectors are evaluated or
interactions attempted. Acting with the wrong selector set produces:

* False negatives (elements not found, tool reports "empty page").
* False positives (wrong elements matched, garbage data extracted).
* Side effects (clicking the wrong element triggers unintended navigation).

Detection should run once at page load and cache the result for the session.

### 2. Centralized Selector Registry

All selectors must live in a single, structured registry keyed by variant.
Scattering selectors across command handlers produces:

* Duplication and drift between commands.
* Inconsistent variant coverage.
* Difficult auditing of which selectors belong to which variant.

The registry is the **single source of truth** for all DOM queries.

### 3. Framework-Aware Interaction

Different frameworks demand different interaction strategies. A click that works
in vanilla JavaScript may be ignored by a React component that listens for
pointer events, or an Ember component that relies on Ember's event dispatcher.
The tool must pair each variant with its correct interaction protocol.

### 4. Graceful Degradation

When the detected variant does not match any known entry in the registry, the
tool must:

* Log a clear warning identifying the unrecognized variant signals.
* Attempt a fallback strategy (e.g., a "generic" selector set).
* Fail with a descriptive error if the fallback also fails, rather than
  producing corrupt output.

## Variant Detection

### Detection Sources

Variant detection should evaluate multiple signals, in order from most reliable
to least:

| Signal             | Reliability | Example                                       |
|--------------------|-------------|-----------------------------------------------|
| URL path pattern   | High        | `/v2/` prefix vs `/classic/` prefix           |
| Meta tag           | High        | `<meta name="app-version" content="2.0">`     |
| Root element attrs | Medium      | `data-framework="ember"`, `id="__next"`       |
| Script bundles     | Medium      | Presence of `ember.js` vs `react.dom.js`      |
| CSS class patterns | Low         | BEM naming vs CSS modules hash suffixes       |
| DOM structure      | Low         | Specific nesting patterns unique to a variant |

### Detection Function Pattern

```
function detect_variant(page):
    if url_matches_pattern(page.url, VARIANT_B_URL_PATTERN):
        return "variant_b"
    if page.query_selector(VARIANT_B_ROOT_SELECTOR):
        return "variant_b"
    if page.query_selector(VARIANT_A_ROOT_SELECTOR):
        return "variant_a"
    return "unknown"
```

Detection should be deterministic: given the same page state, it always returns
the same variant. Avoid timing-dependent checks (e.g., "wait 2 seconds and see
if a React root mounts") — instead, wait for a known stable DOM landmark before
running detection.

### Caching Detection Results

Once detected, the variant should be stored in the session context and reused
for all subsequent operations. Re-detecting on every command invocation wastes
time and risks inconsistency if the page is mid-transition during detection.

## Selector Registry

### Structure

The registry maps variant identifiers to named selector groups:

```
SELECTORS = {
    "variant_a": {
        "item_list":       "div.feed > div.item",
        "item_title":      "h3.item-title",
        "composer_input":  "textarea[data-testid='compose']",
        "submit_button":   "button[type='submit']",
        "header":          "header.main-header",
        "nav_link":        "a.nav-link",
    },
    "variant_b": {
        "item_list":       "ul.stream li.stream-item",
        "item_title":      "span.item-heading",
        "composer_input":  "div[contenteditable='true']",
        "submit_button":   "div[role='button'][data-action='send']",
        "header":          "div.top-bar",
        "nav_link":        "div.sidebar a",
    },
}
```

### Accessor Function

All code retrieves selectors through a single accessor:

```
function get_selector(name, variant):
    registry = SELECTORS[variant] || SELECTORS["default"]
    selector = registry[name]
    if not selector:
        raise UnknownSelectorError(name, variant)
    return selector
```

This accessor:

* Enforces registry usage (no inline selector strings).
* Provides a single point for logging which selectors are used.
* Enables runtime override via configuration files or environment variables.

### Fallback Selectors

For elements that share the same selector across variants, use comma-separated
CSS selectors to avoid duplicating logic:

```
"item_title": "h3.item-title, span.item-heading"
```

This works well for read-only queries (extraction). Avoid it for interaction
targets (clicks, input) where the wrong match could trigger unintended actions.

## Framework-Specific Interaction Patterns

### React / Radix UI

React components manage their own state and event handling. Direct DOM
manipulation bypasses React's synthetic event system:

* **Clicking buttons**: Use CDP mouse events (`Input.dispatchMouseEvent` with
  `mousePressed` and `mouseReleased`) rather than `element.click()`. Radix UI
  components listen for pointer events which `click()` does not trigger.
* **Menu items**: Standard `.click()` typically works because most menu
  implementations use native `onClick` handlers.
* **Text input**: Use `Input.insertText` via CDP to trigger React's `onChange`
  handler. Setting `element.value` directly does not update React state.
* **Closing popovers**: Dispatch `Escape` key event. Clicking `document.body`
  does not reliably dismiss Radix popovers because they use focus-trap patterns.

### Ember.js

Ember applications have unique interaction requirements driven by their
rendering model:

* **Virtual scrolling (occlusion)**: Items scrolled outside the viewport have
  empty `innerHTML`. They exist in the DOM but contain no content. Extracting
  text from occluded items yields empty strings.
* **De-occlusion strategy**: Trigger keyboard events or window resize events to
  force Ember to render occluded items. `scrollTop` and `scrollBy` do **not**
  trigger de-occlusion because Ember's occlusion controller listens for
  different events.
* **Column-reverse layout**: Some Ember interfaces use CSS `column-reverse`,
  where `scrollTop = 0` represents the **bottom** of the content, not the top.
  Scroll direction logic must be inverted.
* **Timeouts**: Ember rendering is slower than vanilla DOM updates. Use 20-second
  timeouts for element appearance, retry with exponential backoff, and extract
  content in batches to avoid overwhelming the renderer.

### Vanilla TypeScript / Custom Frameworks

Simpler frontends typically respond to standard DOM APIs:

* `element.click()` works for most interactive elements.
* `element.value = "text"` followed by dispatching an `input` event updates
  state correctly.
* Standard scroll APIs (`scrollTo`, `scrollBy`) work as expected.

### Interaction Strategy Map

```
INTERACTIONS = {
    "variant_a": {
        "click":       cdp_mouse_click,      // mousedown + mouseup + click
        "type_text":   cdp_insert_text,       // Input.insertText
        "close_popup": send_escape_key,
        "scroll":      standard_scroll,
    },
    "variant_b": {
        "click":       dom_click,             // element.click()
        "type_text":   set_value_and_dispatch, // .value = x; dispatchEvent
        "close_popup": click_backdrop,
        "scroll":      inverted_scroll,        // column-reverse aware
    },
}
```

This map parallels the selector registry and is keyed by the same variant
identifiers.

## Dual-Path Extraction

Some platforms render the same data differently depending on the page context
(e.g., a summary view vs. a detail view). Each extraction function must handle
both paths:

```
function extract_item_data(page, variant):
    if is_detail_page(page):
        return extract_from_detail(page, variant)
    else:
        return extract_from_list(page, variant)
```

### Design Rules for Dual-Path Extractors

* Each path should be a separate function — not an `if/else` branch inside a
  monolithic extractor.
* Both paths must return the same data schema so callers do not need to know
  which path was used.
* Detection of which path applies should use URL patterns or page-level DOM
  landmarks, not element-level selectors (which may differ between variants).

## Adding a New Variant

When a platform introduces a new frontend variant, the following steps add
support:

1. **Identify detection signals** — Find URL patterns, meta tags, or root
   element attributes unique to the new variant.
2. **Add detection logic** — Extend the detection function with a new branch.
3. **Map selectors** — Add a new key to the selector registry with all required
   selectors for the new variant.
4. **Map interactions** — Add a new key to the interaction strategy map with the
   correct functions for the new variant's framework.
5. **Test extraction** — Verify all extraction commands produce correct output
   against the new variant.
6. **Test interactions** — Verify all write operations (compose, click, navigate)
   work with the new variant's event model.

This process is additive: existing variant support is untouched. The registry
pattern ensures no existing code paths are modified.

## Testing Strategy

### Development Workflow

* **Primary development** against one variant (typically the more stable or more
  widely deployed one).
* **Verification** against all known variants before release.
* **Regression detection** via CI that runs the test suite against each variant
  independently.

### Test Organization

```
tests/
    variant_a/
        test_extraction.py
        test_interaction.py
    variant_b/
        test_extraction.py
        test_interaction.py
    cross_variant/
        test_detection.py
        test_registry_completeness.py
```

### Registry Completeness Test

An automated test should verify that every variant in the registry defines all
required selector keys:

```
function test_registry_completeness():
    required_keys = ["item_list", "item_title", "composer_input", ...]
    for variant in SELECTORS:
        for key in required_keys:
            assert key in SELECTORS[variant],
                f"Variant {variant} missing selector: {key}"
```

This catches the common error of adding a new selector to one variant but
forgetting another.

### Interaction Compatibility Test

Each interaction function in the strategy map should have a corresponding test
that verifies the expected DOM side effect occurs (element receives focus, value
changes, popup closes, etc.).

## Anti-Patterns

### Inline Variant Branching

```
// BAD: variant logic scattered through command handlers
if variant == "a":
    page.click("button.submit-a")
else:
    page.click("div[role='button'].submit-b")
```

This scatters variant knowledge across the codebase. Use the registry instead.

### Shared Selectors Without Verification

```
// BAD: assuming a selector works for all variants without testing
page.query_selector("div.message")  // works for variant_a, empty for variant_b
```

Every selector must be verified against every supported variant.

### Retry-Based Variant Detection

```
// BAD: try variant_a selectors, if they fail, try variant_b
try:
    result = extract_with_variant_a(page)
except:
    result = extract_with_variant_b(page)
```

This is slow, error-prone (variant_a might partially succeed with wrong data),
and does not scale beyond two variants. Detect the variant once, then use the
correct selectors throughout.

## Implementation Checklist

* [ ] Implement variant detection function with URL and DOM signal checks.
* [ ] Create centralized selector registry with entries for each known variant.
* [ ] Create interaction strategy map paralleling the selector registry.
* [ ] Implement single accessor function for selector lookups with error on
  missing keys.
* [ ] Add variant caching to session context after detection.
* [ ] Implement graceful degradation for unknown variants (warning + fallback).
* [ ] Add dual-path extraction support for summary vs. detail page layouts.
* [ ] Write registry completeness test covering all selector keys across all
  variants.
* [ ] Write interaction compatibility tests for each variant's event model.
* [ ] Document the process for adding new variants.
* [ ] Add variant identifier to CLI output and log messages for debugging.
* [ ] Support variant override via CLI flag (`--variant=X`) for development and
  testing.
