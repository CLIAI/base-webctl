---
id: iqrg
title: "UI State Hygiene: Clean-Slate Initialization & Popup Handling"
category: ux
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [ui-hygiene, popup-handling, clean-slate, dialog-detection, pre-command, modal]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# UI State Hygiene: Clean-Slate Initialization & Popup Handling

## Problem Statement

Web applications frequently present unsolicited UI elements -- cookie consent
banners, notification permission prompts, onboarding tours, newsletter modals,
download dialogs, and session-expiry overlays -- that obstruct automated
interactions. A CLI tool issuing commands against a browser session must handle
these elements deterministically, or risk clicking hidden elements, timing out
on obscured selectors, or accidentally confirming destructive actions.

This document defines a **three-layer popup detection architecture**, a
classification system for safe vs. dangerous dismissals, configurable action
modes, and post-action assertions to guarantee the page is in a known-good
state before command execution proceeds.

## Design Principles

* **Clean-slate guarantee** -- every command begins with a page free of
  obstructing overlays.
* **Safety by default** -- unknown dialogs are never auto-dismissed; they cause
  failure with a descriptive report.
* **Determinism** -- identical page states produce identical handling outcomes.
* **Composability** -- popup handling is a pre-command middleware, independent
  of the command itself.

## Three-Layer Popup Detection Architecture

Detection operates as a pipeline. Each layer runs in sequence; if a layer
detects and resolves an obstruction, subsequent layers still run to catch
stacked popups.

```
 Layer 1              Layer 2              Layer 3
 CDP Dialog       ->  DOM Overlay      ->  Interaction-Readiness
 Events               Scanner              Probe

 (native dialogs)     (injected modals)    (click-intercept test)
```

### Layer 1: CDP Native Dialog Interception

The Chrome DevTools Protocol emits `Page.javascriptDialogOpening` events for
`alert()`, `confirm()`, `prompt()`, and `beforeunload` dialogs. These are
intercepted at the protocol level before they reach the DOM.

```python
import json
import asyncio

async def attach_dialog_handler(ws, popup_action="dismiss"):
    """Register CDP handler for native JS dialogs."""
    await ws.send(json.dumps({
        "id": 1,
        "method": "Page.enable"
    }))

    async for message in ws:
        event = json.loads(message)
        if event.get("method") == "Page.javascriptDialogOpening":
            params = event["params"]
            dialog_type = params["type"]       # alert, confirm, prompt, beforeunload
            dialog_msg = params.get("message", "")

            classification = classify_dialog(dialog_type, dialog_msg)

            if popup_action == "dismiss" and classification == "safe":
                await ws.send(json.dumps({
                    "id": 2,
                    "method": "Page.handleJavaScriptDialog",
                    "params": {"accept": False}
                }))
            elif popup_action == "report":
                report_dialog(dialog_type, dialog_msg, classification)
            else:
                raise PopupBlockError(
                    f"Blocked by {dialog_type} dialog: {dialog_msg[:120]}"
                )
```

### Layer 2: DOM Overlay Scanner

Most modern popups are not native dialogs but DOM-injected overlays. This layer
scans for common structural patterns using CSS and ARIA attributes.

```python
DOM_OVERLAY_SELECTORS = [
    # High-confidence: known modal/dialog roles
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    'dialog[open]',

    # Medium-confidence: positional/visual heuristics
    '[class*="modal"][class*="overlay"]',
    '[class*="popup"][class*="visible"]',
    '[class*="cookie"][class*="banner"]',
    '[class*="consent"]',
    '[id*="onetrust"]',          # generic consent framework markers

    # Low-confidence: full-viewport overlays
    'div[style*="position: fixed"][style*="z-index"]',
]

DISMISS_BUTTON_SELECTORS = [
    # Ordered by specificity -- first match wins
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
    '[aria-label*="reject" i]',
    '[aria-label*="decline" i]',
    'button[class*="close"]',
    'button[class*="dismiss"]',
    '[data-action="close"]',
    '[data-dismiss]',
]

async def scan_dom_overlays(cdp_session):
    """Detect and optionally dismiss DOM-injected overlays."""
    overlays = []

    for selector in DOM_OVERLAY_SELECTORS:
        result = await cdp_session.execute(
            "Runtime.evaluate",
            expression=f"""
                (() => {{
                    const els = document.querySelectorAll('{selector}');
                    return Array.from(els)
                        .filter(el => {{
                            const style = getComputedStyle(el);
                            return style.display !== 'none'
                                && style.visibility !== 'hidden'
                                && el.offsetHeight > 50;
                        }})
                        .map(el => ({{
                            selector: '{selector}',
                            tagName: el.tagName,
                            text: el.textContent.slice(0, 200),
                            zIndex: parseInt(getComputedStyle(el).zIndex) || 0,
                            rect: el.getBoundingClientRect().toJSON(),
                        }}));
                }})()
            """,
            returnByValue=True,
        )
        found = result.get("result", {}).get("value", [])
        overlays.extend(found)

    # Sort by z-index descending -- topmost first
    overlays.sort(key=lambda o: o.get("zIndex", 0), reverse=True)
    return overlays
```

### Layer 3: Interaction-Readiness Probe

Even after dismissing detected overlays, invisible interceptors (transparent
divs, loading spinners with pointer-events) can block clicks. This layer
verifies that a click at a target coordinate actually reaches the expected
element.

```python
async def probe_interaction_readiness(cdp_session, target_selector, timeout_ms=5000):
    """Verify that the target element is actually clickable."""
    probe_js = f"""
        (() => {{
            const target = document.querySelector('{target_selector}');
            if (!target) return {{ ready: false, reason: 'selector_not_found' }};

            const rect = target.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            const topEl = document.elementFromPoint(cx, cy);
            if (!topEl) return {{ ready: false, reason: 'no_element_at_point' }};

            const isTarget = target === topEl || target.contains(topEl);
            if (!isTarget) {{
                return {{
                    ready: false,
                    reason: 'intercepted',
                    interceptor: {{
                        tagName: topEl.tagName,
                        id: topEl.id,
                        className: topEl.className,
                        zIndex: getComputedStyle(topEl).zIndex,
                    }}
                }};
            }}

            return {{ ready: true }};
        }})()
    """

    deadline = asyncio.get_event_loop().time() + (timeout_ms / 1000)
    while asyncio.get_event_loop().time() < deadline:
        result = await cdp_session.evaluate(probe_js, returnByValue=True)
        probe = result.get("result", {}).get("value", {})

        if probe.get("ready"):
            return True

        if probe.get("reason") == "intercepted":
            interceptor = probe.get("interceptor", {})
            raise InteractionBlockedError(
                f"Target '{target_selector}' intercepted by "
                f"<{interceptor.get('tagName')} id='{interceptor.get('id')}' "
                f"class='{interceptor.get('className')}'>"
            )

        await asyncio.sleep(0.2)

    raise TimeoutError(
        f"Target '{target_selector}' not interaction-ready within {timeout_ms}ms"
    )
```

## Popup Classification: Safe vs. Dangerous

Not all dialogs should be auto-dismissed. The classification function maps
dialog characteristics to a safety verdict.

### Classification Rules

| Signal                          | Classification    | Rationale                        |
|---------------------------------|-------------------|----------------------------------|
| `alert()` dialog                | `safe`            | Informational, no side effects   |
| `confirm()` with delete/remove  | `dangerous`       | May trigger data loss            |
| `beforeunload` dialog           | `dangerous`       | Unsaved changes at risk          |
| Cookie/consent overlay          | `safe`            | Cosmetic, blocks interaction     |
| Notification permission prompt  | `safe`            | Browser-level, not destructive   |
| Payment/checkout modal          | `dangerous`       | Financial action                 |
| Login/auth dialog               | `dangerous`       | State-changing                   |
| Generic `[role="dialog"]`       | `unknown`         | Needs text analysis              |

```python
import re

DANGEROUS_PATTERNS = re.compile(
    r'\b(delet|remov|unsav|discard|cancel|sign.?out|log.?out|'
    r'payment|checkout|purchas|subscrib|unsubscrib|'
    r'irreversibl|permanent)\b',
    re.IGNORECASE,
)

SAFE_PATTERNS = re.compile(
    r'\b(cookie|consent|notification|newsletter|'
    r'update.?available|new.?feature|onboard|welcome|'
    r'accept.?terms|privacy.?policy)\b',
    re.IGNORECASE,
)

def classify_dialog(dialog_type, message_text):
    """Classify a dialog as safe, dangerous, or unknown."""
    if dialog_type == "beforeunload":
        return "dangerous"

    if dialog_type == "alert":
        if DANGEROUS_PATTERNS.search(message_text):
            return "dangerous"
        return "safe"

    if DANGEROUS_PATTERNS.search(message_text):
        return "dangerous"

    if SAFE_PATTERNS.search(message_text):
        return "safe"

    return "unknown"
```

## CLI Flag: `--popup-action`

The `--popup-action` flag controls how detected popups are handled. It applies
uniformly across all three detection layers.

```
webctl --popup-action=dismiss  navigate "https://example.com/dashboard"
webctl --popup-action=report   click "#submit-btn"
webctl --popup-action=fail     fill "#search" "query text"
```

### Mode Semantics

| Mode      | Safe Popup        | Unknown Popup     | Dangerous Popup   |
|-----------|-------------------|-------------------|-------------------|
| `dismiss` | Auto-dismiss      | Report + dismiss  | Report + **fail** |
| `report`  | Report only       | Report only       | Report only       |
| `fail`    | **Fail**          | **Fail**          | **Fail**          |

* **dismiss** (default) -- maximally automated. Safe popups vanish silently.
  Unknown popups are dismissed but logged. Dangerous popups always halt
  execution.
* **report** -- detection-only mode for diagnostics. No popups are dismissed.
  All detections are written to stderr as structured JSON.
* **fail** -- strictest mode. Any popup causes immediate exit with a non-zero
  code. Useful in CI pipelines where the page state must be pristine.

```python
def handle_popup(overlay, classification, popup_action):
    """Apply popup-action policy to a detected overlay."""
    if popup_action == "fail":
        raise PopupDetectedError(overlay, classification)

    if popup_action == "report":
        emit_report(overlay, classification)
        return

    # popup_action == "dismiss"
    if classification == "dangerous":
        emit_report(overlay, classification)
        raise DangerousPopupError(overlay)

    if classification == "unknown":
        emit_report(overlay, classification)

    dismiss_overlay(overlay)
```

## Download Dialog Suppression via CDP

Browser-initiated download dialogs are a common source of automation hangs.
CDP provides `Browser.setDownloadBehavior` to suppress or redirect them.

```python
async def suppress_download_dialogs(cdp_session, download_path="/dev/null"):
    """Prevent download dialogs from blocking automation.

    In production, downloads are either:
      - Silently redirected to a temp directory for later inspection
      - Denied entirely to prevent unexpected file writes
    """
    await cdp_session.send({
        "method": "Browser.setDownloadBehavior",
        "params": {
            "behavior": "deny",           # or "allowAndName" with downloadPath
            "eventsEnabled": True,         # emit download progress events
        }
    })

    # Optional: redirect instead of deny
    # await cdp_session.send({
    #     "method": "Browser.setDownloadBehavior",
    #     "params": {
    #         "behavior": "allowAndName",
    #         "downloadPath": download_path,
    #         "eventsEnabled": True,
    #     }
    # })
```

When downloads must be permitted (e.g., an `export` command), the command
itself temporarily overrides the behavior:

```python
async def with_download_allowed(cdp_session, download_dir, coro):
    """Context manager: enable downloads for a single operation."""
    await cdp_session.send({
        "method": "Browser.setDownloadBehavior",
        "params": {
            "behavior": "allowAndName",
            "downloadPath": str(download_dir),
            "eventsEnabled": True,
        }
    })
    try:
        return await coro
    finally:
        await suppress_download_dialogs(cdp_session)
```

## Post-Action URL Assertions

After dismissing popups and executing a command, the page URL must match
expectations. Unexpected redirects (to login pages, error screens, or
third-party sites) indicate that the action failed or the session is invalid.

```python
from urllib.parse import urlparse

def assert_url_post_action(current_url, expected_pattern):
    """Verify the page URL after an action completes.

    expected_pattern can be:
      - exact URL string
      - glob pattern ("https://app.example.com/dashboard/*")
      - regex pattern (compiled re.Pattern)
    """
    parsed = urlparse(current_url)

    if isinstance(expected_pattern, re.Pattern):
        if not expected_pattern.match(current_url):
            raise UnexpectedNavigationError(current_url, expected_pattern.pattern)
    elif '*' in expected_pattern:
        import fnmatch
        if not fnmatch.fnmatch(current_url, expected_pattern):
            raise UnexpectedNavigationError(current_url, expected_pattern)
    else:
        if current_url.rstrip('/') != expected_pattern.rstrip('/'):
            raise UnexpectedNavigationError(current_url, expected_pattern)
```

Commands can declare expected post-action URLs:

```
webctl navigate "https://app.example.com/settings" \
       --expect-url "https://app.example.com/settings*"
```

If the page redirects to a login screen (`/auth/login?redirect=...`), the
assertion fails immediately with a clear diagnostic.

## Modal Detection with Interaction-Readiness Polling

Some modals animate into view or load content asynchronously. The readiness
probe must account for CSS transitions and lazy-loaded modal bodies.

### Polling Strategy

```python
async def wait_for_modal_stable(cdp_session, timeout_ms=3000, poll_interval_ms=150):
    """Wait until no new modals appear and existing ones are fully rendered.

    Stability = two consecutive polls return identical overlay count and
    dimensions. This catches modals mid-animation or content still loading.
    """
    prev_snapshot = None
    stable_count = 0
    required_stable = 2

    deadline = asyncio.get_event_loop().time() + (timeout_ms / 1000)
    while asyncio.get_event_loop().time() < deadline:
        overlays = await scan_dom_overlays(cdp_session)
        snapshot = _fingerprint(overlays)

        if snapshot == prev_snapshot:
            stable_count += 1
            if stable_count >= required_stable:
                return overlays
        else:
            stable_count = 0

        prev_snapshot = snapshot
        await asyncio.sleep(poll_interval_ms / 1000)

    raise ModalInstabilityError(
        f"Modal state did not stabilize within {timeout_ms}ms"
    )


def _fingerprint(overlays):
    """Create a hashable snapshot of overlay state for stability comparison."""
    return tuple(
        (o.get("selector"), o.get("tagName"), o.get("zIndex"),
         round(o.get("rect", {}).get("width", 0)),
         round(o.get("rect", {}).get("height", 0)))
        for o in overlays
    )
```

### Full Pre-Command Pipeline

All three layers compose into a single pre-command middleware:

```python
async def ensure_clean_slate(cdp_session, popup_action="dismiss"):
    """Pre-command middleware: guarantee the page is interaction-ready.

    Execution order:
      1. Suppress download dialogs (CDP-level, always active)
      2. Drain any pending native JS dialogs (Layer 1)
      3. Wait for modal stability, then scan DOM overlays (Layer 2)
      4. Classify and handle each overlay per popup_action policy
      5. Re-scan to confirm all overlays resolved (max 3 iterations)
    """
    await suppress_download_dialogs(cdp_session)

    # Layer 2+3: DOM overlay resolution loop
    max_iterations = 3
    for iteration in range(max_iterations):
        overlays = await wait_for_modal_stable(cdp_session)

        if not overlays:
            return  # clean slate achieved

        for overlay in overlays:
            classification = classify_overlay(overlay)
            handle_popup(overlay, classification, popup_action)

    # If we still have overlays after max_iterations, report
    remaining = await scan_dom_overlays(cdp_session)
    if remaining:
        raise PersistentOverlayError(
            f"{len(remaining)} overlay(s) remain after {max_iterations} "
            f"dismiss cycles"
        )
```

## Structured Reporting Format

When `--popup-action=report` is active (or when unknown/dangerous popups are
logged in dismiss mode), detections are emitted as newline-delimited JSON to
stderr:

```json
{
  "event": "popup_detected",
  "timestamp": "2026-03-03T14:22:07.123Z",
  "layer": "dom_overlay",
  "classification": "safe",
  "action_taken": "dismissed",
  "details": {
    "selector": "[role=\"dialog\"]",
    "tagName": "DIV",
    "text_preview": "We use cookies to improve your experience...",
    "z_index": 10000,
    "rect": {"x": 0, "y": 600, "width": 1920, "height": 200}
  }
}
```

This format is machine-parseable and integrates with the tool's broader
structured output conventions.

## Edge Cases and Mitigations

* **Stacked modals** -- the resolution loop (max 3 iterations) handles popups
  that trigger secondary popups on dismissal.
* **Shadow DOM modals** -- Layer 2 selectors must pierce shadow roots via
  `element.shadowRoot.querySelectorAll()` when supported.
* **iframes with overlays** -- the scanner must enumerate all frames via
  `Page.getFrameTree` and check each frame independently.
* **Animated transitions** -- the stability polling in `wait_for_modal_stable`
  avoids acting on partially-rendered modals.
* **Rate-limited consent APIs** -- some consent frameworks throttle dismiss
  API calls; exponential backoff on `dismiss_overlay()` failures mitigates
  this.

## Summary

The three-layer detection pipeline (CDP native dialogs, DOM overlay scanning,
interaction-readiness probing) combined with the classify-then-act pattern
ensures that automated commands execute against a clean, predictable page
state. The `--popup-action` flag gives operators control over the
aggressiveness of automatic handling, from full auto-dismiss to strict
fail-fast modes suitable for CI environments.
