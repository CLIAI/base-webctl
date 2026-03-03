---
id: f0qu
title: "DOM Content Extraction: Selectors, Rich Parsing & Virtual Scroll"
category: data
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [dom-extraction, content-parsing, selectors, virtual-scroll, lazy-rendering, structural-preservation]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# DOM Content Extraction: Selectors, Rich Parsing & Virtual Scroll

## Motivation

Modern web applications render content through layers of virtual scrolling,
lazy hydration, and shadow DOM encapsulation. A generic web-control CLI must
extract structured content reliably regardless of how the host application
manages its DOM. This document defines the selector priority hierarchy, rich
content parsing strategy, and scroll-back pagination model used across all
extraction operations.

## 1. Selector Priority Hierarchy

Selectors degrade in reliability as they move away from intentional developer
annotations toward incidental DOM structure. The framework enforces a strict
priority order when locating elements:

| Priority | Strategy          | Rationale                                       |
|----------|-------------------|-------------------------------------------------|
| 1        | `data-testid`     | Explicitly stable; intended for automation      |
| 2        | ARIA attributes   | Semantic, accessibility-mandated, rarely renamed |
| 3        | Semantic HTML     | `<article>`, `<nav>`, `<main>` — structural     |
| 4        | CSS class/ID      | Fragile; minified builds randomize these         |

### 1.1 Resolution Logic

The resolver walks the priority list top-down and returns the first match.
Callers may pin a specific strategy via a `selector_mode` parameter to skip
fallback when determinism matters more than resilience.

```python
SELECTOR_STRATEGIES = [
    ("data-testid", lambda el, hint: f'[data-testid="{hint}"]'),
    ("aria",        lambda el, hint: f'[aria-label="{hint}"]'),
    ("semantic",    lambda el, hint: hint),   # e.g. "article > section"
    ("css",         lambda el, hint: hint),   # raw CSS selector
]

def resolve_selector(page, hint: str, mode: str | None = None):
    """Return first matching element using priority cascade."""
    strategies = (
        [(mode, dict(SELECTOR_STRATEGIES)[mode])]
        if mode else SELECTOR_STRATEGIES
    )
    for name, build in strategies:
        selector = build(None, hint)
        node = cdp_query_selector(page, selector)
        if node is not None:
            return node, name
    return None, None
```

### 1.2 Scoped Selectors

Many applications reuse the same component class at multiple nesting levels.
Scoped selectors anchor the search to a known container, eliminating ambiguity.

```python
def scoped_query(page, container_sel: str, child_sel: str):
    """Query child_sel only within container_sel subtree."""
    container = cdp_query_selector(page, container_sel)
    if container is None:
        raise SelectorScopeError(f"container not found: {container_sel}")
    return cdp_query_selector_within(container, child_sel)
```

The CDP calls translate to:

```json
{"method": "DOM.querySelectorAll", "params": {"nodeId": 42, "selector": "[data-testid='msg']"}}
```

Where `nodeId` is the previously resolved container.

## 2. textContent vs innerText for Lazy-Rendered Content

### 2.1 The Problem

`innerText` triggers a layout reflow and returns only *visible* text. Content
hidden behind virtual scroll containers, collapsed sections, or CSS
`visibility: hidden` is silently omitted. In contrast, `textContent` returns
the raw text of all descendant nodes regardless of rendering state.

| Property      | Layout reflow | Includes hidden | Preserves whitespace |
|---------------|---------------|-----------------|----------------------|
| `textContent` | No            | Yes             | Raw (all whitespace) |
| `innerText`   | Yes           | No              | Rendered             |

### 2.2 Framework Default

The framework defaults to `textContent` for extraction, with post-processing
to normalize whitespace. This avoids missing lazily-rendered or off-screen
content that has been loaded into the DOM but not yet painted.

```python
def extract_text(node_id: int, session) -> str:
    """Extract text content with whitespace normalization."""
    result = session.send(
        "Runtime.callFunctionOn",
        objectId=resolve_object(node_id),
        functionDeclaration="function() { return this.textContent; }",
        returnByValue=True,
    )
    raw = result["result"]["value"] or ""
    # Collapse runs of whitespace, preserve paragraph breaks
    lines = raw.split("\n")
    return "\n".join(
        " ".join(line.split()) for line in lines
    ).strip()
```

When the caller explicitly needs *rendered-only* text (e.g., to match what a
user sees on screen), pass `visible_only=True` to switch to `innerText`.

## 3. Rich Content Types

Extracted content is classified into typed blocks. Each block carries its
content plus structural metadata needed for faithful downstream reproduction.

### 3.1 Block Schema

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

class BlockType(Enum):
    TEXT     = "text"
    TABLE   = "table"
    CODE    = "code"
    MATH    = "math"
    MEDIA   = "media"
    META    = "metadata"

@dataclass
class ContentBlock:
    type: BlockType
    content: str
    attrs: dict[str, Any] = field(default_factory=dict)
    # attrs examples:
    #   CODE:  {"language": "python", "line_start": 1}
    #   TABLE: {"headers": ["Name", "Value"], "row_count": 12}
    #   MATH:  {"notation": "latex"}
    #   MEDIA: {"src": "https://...", "alt": "diagram", "mime": "image/png"}
    #   META:  {"author": "...", "timestamp": "2026-03-03T10:00:00Z"}
```

### 3.2 Type Detection Heuristics

```python
TAG_TYPE_MAP = {
    "pre":         BlockType.CODE,
    "code":        BlockType.CODE,
    "table":       BlockType.TABLE,
    "math":        BlockType.MATH,
    "img":         BlockType.MEDIA,
    "video":       BlockType.MEDIA,
    "audio":       BlockType.MEDIA,
    "time":        BlockType.META,
}

ARIA_ROLE_MAP = {
    "math":        BlockType.MATH,
    "table":       BlockType.TABLE,
    "img":         BlockType.MEDIA,
    "code":        BlockType.CODE,
}

def classify_node(tag: str, attrs: dict) -> BlockType:
    """Determine block type from tag name and ARIA role."""
    role = attrs.get("role", "")
    if role in ARIA_ROLE_MAP:
        return ARIA_ROLE_MAP[role]
    if tag in TAG_TYPE_MAP:
        return TAG_TYPE_MAP[tag]
    return BlockType.TEXT
```

### 3.3 Table Extraction

Tables require special handling to preserve row/column structure.

```python
def extract_table(node_id: int, session) -> ContentBlock:
    """Extract HTML table into structured ContentBlock."""
    js = """
    function() {
        const rows = Array.from(this.querySelectorAll('tr'));
        return rows.map(r =>
            Array.from(r.querySelectorAll('th, td')).map(c => c.textContent.trim())
        );
    }
    """
    result = session.send(
        "Runtime.callFunctionOn",
        objectId=resolve_object(node_id),
        functionDeclaration=js,
        returnByValue=True,
    )
    grid = result["result"]["value"]
    headers = grid[0] if grid else []
    return ContentBlock(
        type=BlockType.TABLE,
        content=format_table_text(grid),
        attrs={"headers": headers, "row_count": len(grid)},
    )
```

### 3.4 Code Block Extraction

```python
def extract_code(node_id: int, session) -> ContentBlock:
    """Extract code block preserving language annotation."""
    js = """
    function() {
        const code = this.querySelector('code') || this;
        const classes = Array.from(code.classList);
        const lang = classes.find(c => c.startsWith('language-'));
        return {
            text: code.textContent,
            language: lang ? lang.replace('language-', '') : null,
        };
    }
    """
    result = session.send(
        "Runtime.callFunctionOn",
        objectId=resolve_object(node_id),
        functionDeclaration=js,
        returnByValue=True,
    )
    data = result["result"]["value"]
    return ContentBlock(
        type=BlockType.CODE,
        content=data["text"],
        attrs={"language": data.get("language")},
    )
```

## 4. Scroll-Back Pagination with Deduplication

### 4.1 Problem

Virtual-scroll containers recycle DOM nodes. Content that was visible moments
ago is removed from the DOM when the user scrolls forward. To extract an
entire conversation or feed, the framework must scroll backward, capture newly
materialized nodes, and merge them with previously captured content while
avoiding duplicates.

### 4.2 Algorithm

```
1. Record current scroll position as anchor.
2. Snapshot visible content blocks, compute fingerprints.
3. Scroll up by one viewport height.
4. Wait for DOM mutations to settle (MutationObserver or CDP DOM events).
5. Snapshot new content blocks.
6. Deduplicate against fingerprint set.
7. Prepend unique blocks to accumulator.
8. If new unique blocks == 0 for N consecutive iterations, stop.
9. Restore original scroll position.
```

### 4.3 Fingerprinting

Content fingerprints use a truncated hash of normalized text to keep the
dedup set small.

```python
import hashlib

def fingerprint(block: ContentBlock) -> str:
    """Produce a short fingerprint for deduplication."""
    normalized = " ".join(block.content.split()).lower()
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]
```

### 4.4 Scroll-Back Implementation

```python
async def scroll_back_extract(
    session,
    container_sel: str,
    max_iterations: int = 200,
    settle_ms: int = 300,
    stale_limit: int = 3,
) -> list[ContentBlock]:
    """Paginate backward through a virtual-scroll container."""
    seen: set[str] = set()
    all_blocks: list[ContentBlock] = []
    stale_count = 0

    # Save original scroll position
    original_top = await get_scroll_top(session, container_sel)

    for _ in range(max_iterations):
        blocks = await extract_visible_blocks(session, container_sel)
        new_blocks = []
        for b in blocks:
            fp = fingerprint(b)
            if fp not in seen:
                seen.add(fp)
                new_blocks.append(b)

        if not new_blocks:
            stale_count += 1
            if stale_count >= stale_limit:
                break
        else:
            stale_count = 0
            all_blocks = new_blocks + all_blocks  # prepend

        await scroll_up_one_viewport(session, container_sel)
        await wait_for_mutations(session, timeout_ms=settle_ms)

    # Restore scroll position
    await set_scroll_top(session, container_sel, original_top)
    return all_blocks
```

## 5. Batched Extraction for Large DOM

When the DOM contains thousands of nodes (e.g., long feeds, log viewers),
extracting everything in a single `Runtime.evaluate` call risks CDP message
size limits and browser-process memory pressure.

### 5.1 Chunked Node Collection

```python
async def batched_extract(
    session,
    container_sel: str,
    batch_size: int = 50,
) -> list[ContentBlock]:
    """Extract content in batches to avoid CDP message size limits."""
    total = await count_children(session, container_sel)
    all_blocks: list[ContentBlock] = []

    for offset in range(0, total, batch_size):
        js = f"""
        function() {{
            const children = Array.from(this.children);
            return children.slice({offset}, {offset + batch_size}).map(el => ({{
                tag: el.tagName.toLowerCase(),
                text: el.textContent,
                attrs: Object.fromEntries(
                    Array.from(el.attributes).map(a => [a.name, a.value])
                ),
            }}));
        }}
        """
        result = await session.send_async(
            "Runtime.callFunctionOn",
            objectId=await resolve_object_async(
                await cdp_query_selector(session, container_sel)
            ),
            functionDeclaration=js,
            returnByValue=True,
        )
        raw_nodes = result["result"]["value"]
        for node in raw_nodes:
            block_type = classify_node(node["tag"], node["attrs"])
            all_blocks.append(ContentBlock(
                type=block_type,
                content=node["text"].strip(),
                attrs=node["attrs"],
            ))

    return all_blocks
```

### 5.2 Backpressure

If extraction produces blocks faster than the caller consumes them, an async
generator pattern applies backpressure naturally:

```python
async def stream_extract(session, container_sel, batch_size=50):
    """Yield content blocks incrementally."""
    total = await count_children(session, container_sel)
    for offset in range(0, total, batch_size):
        batch = await extract_batch(session, container_sel, offset, batch_size)
        for block in batch:
            yield block
```

## 6. Nested iframe Dual-WS Coordination

### 6.1 Problem

Some applications embed rich content editors, media players, or sandboxed
widgets inside `<iframe>` elements. Each cross-origin iframe runs in a
separate renderer process and requires its own CDP `Target` session. The
framework must coordinate two WebSocket connections: one for the parent frame
and one for the child.

### 6.2 Discovery

```python
async def discover_iframes(session) -> list[dict]:
    """List all iframe targets accessible from current page."""
    targets = await session.send_async("Target.getTargets")
    return [
        t for t in targets["targetInfos"]
        if t["type"] == "iframe"
    ]
```

### 6.3 Dual-Session Coordination

```python
async def extract_with_iframes(parent_session, container_sel: str):
    """Extract from parent and all nested iframes."""
    # Parent content
    parent_blocks = await batched_extract(parent_session, container_sel)

    # Discover and attach to iframes
    iframes = await discover_iframes(parent_session)
    for iframe_info in iframes:
        child_session = await attach_to_target(
            parent_session, iframe_info["targetId"]
        )
        try:
            iframe_blocks = await batched_extract(child_session, "body")
            for b in iframe_blocks:
                b.attrs["iframe_origin"] = iframe_info.get("url", "unknown")
            parent_blocks.extend(iframe_blocks)
        finally:
            await detach_from_target(parent_session, child_session)

    return parent_blocks
```

### 6.4 CDP Target Attachment

```json
{"method": "Target.attachToTarget", "params": {"targetId": "...", "flatten": true}}
```

The `flatten: true` parameter enables multiplexed messaging over the parent
WebSocket, avoiding the need for a second raw WSocket connection in most cases.
When `flatten` is not supported (older browser versions), the framework falls
back to opening a dedicated WebSocket to the iframe target's
`webSocketDebuggerUrl`.

## 7. Error Handling and Resilience

### 7.1 Stale Node References

Virtual-scroll recycling can invalidate `nodeId` or `objectId` references
between the time a selector resolves and the time extraction runs. All
extraction functions must handle `DOM.NodeNotFound` or
`Runtime.ObjectNotFound` by re-resolving the selector.

```python
MAX_RETRIES = 3

async def safe_extract(session, selector, extract_fn, retries=MAX_RETRIES):
    """Re-resolve selector on stale node errors."""
    for attempt in range(retries):
        node, strategy = resolve_selector(session, selector)
        if node is None:
            raise ExtractionError(f"selector not found: {selector}")
        try:
            return await extract_fn(node, session)
        except CDPError as e:
            if "not found" in str(e).lower() and attempt < retries - 1:
                await asyncio.sleep(0.1 * (attempt + 1))
                continue
            raise
```

### 7.2 Mutation Settling

After any scroll or interaction, wait for DOM mutations to quiesce before
extracting:

```python
async def wait_for_mutations(session, timeout_ms: int = 500):
    """Wait until DOM mutations settle or timeout expires."""
    js = """
    new Promise(resolve => {
        let timer;
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { observer.disconnect(); resolve(true); }, 150);
        });
        observer.observe(document.body, {childList: true, subtree: true});
        timer = setTimeout(() => { observer.disconnect(); resolve(false); }, %d);
    })
    """ % timeout_ms
    await session.send_async(
        "Runtime.evaluate",
        expression=js,
        awaitPromise=True,
    )
```

## Design Decisions

* **textContent over innerText** — correctness over presentation fidelity;
  downstream formatters can re-apply layout rules.
* **Fingerprint-based dedup** — avoids reliance on application-specific IDs
  that may not exist; tolerant of minor whitespace variance.
* **Batched extraction** — CDP message payloads are bounded; chunking keeps
  memory predictable and enables streaming to disk for very large documents.
* **Flatten-first iframe attachment** — reduces connection management overhead;
  dedicated WS fallback ensures compatibility with older browsers.
* **Scoped selectors** — prevents cross-component false matches in deeply
  nested component trees common in modern single-page applications.
