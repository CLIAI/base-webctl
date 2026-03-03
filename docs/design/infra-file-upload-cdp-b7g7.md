---
id: b7g7
title: "File Upload via CDP: Monkey-Patch File Dialog Interception"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [file-upload, cdp, monkey-patch, datatransfer, browser-automation, file-injection]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# File Upload via CDP: Monkey-Patch File Dialog Interception

## Problem Statement

Browser automation frameworks need to upload files into web applications. The
native CDP approach -- `Page.setInterceptFileChooserDialog` followed by
`Page.handleFileChooser` -- works only when the page uses a standard
`<input type="file">` element **and** the browser's native file-chooser dialog
is triggered. Many modern web applications bypass the native dialog entirely:

* Custom-styled upload buttons that delegate to a hidden `<input>` via
  JavaScript `.click()` calls.
* Drag-and-drop zones that expect `DataTransfer` objects on `drop` events.
* Clipboard-paste handlers that read from `ClipboardEvent.clipboardData`.
* Framework-level abstractions (React, Vue, Svelte) that wrap or virtualize the
  file input, sometimes never attaching it to the DOM at all.
* Upload buttons that open a custom modal picker instead of the OS file dialog.

In all these cases `Page.handleFileChooser` either never fires or fires too
late to be useful.

### Why `handleFileChooser` Falls Short

| Limitation | Impact |
|---|---|
| Requires a real `<input type="file">` in the DOM | Custom dropzones and paste handlers are invisible to CDP |
| Dialog must actually open | Programmatic `.click()` on a hidden input may not trigger the CDP event in headless mode |
| Race condition between enabling interception and the dialog appearing | Missed dialogs produce silent failures |
| No support for `DataTransfer`-based flows | Cannot inject files into drag-and-drop or paste handlers |
| Single-shot: must re-enable after each interception | Easy to miss successive uploads |

## Solution: Monkey-Patch Click Interception

The core idea is to **intercept the `.click()` method** on `HTMLInputElement`
instances (and the prototype) so that when the page's JavaScript calls
`inputElement.click()`, we suppress the native file dialog and instead inject a
programmatically constructed `File` object.

### Architecture Overview

```
                      ┌───────────────────────────┐
                      │   Automation Controller    │
                      │   (Node / Python / etc.)   │
                      └────────────┬──────────────┘
                                   │ CDP: Runtime.evaluate
                                   │ (base64 payload + metadata)
                                   ▼
                      ┌───────────────────────────┐
                      │   Browser Page Context     │
                      │                           │
                      │  1. Decode base64 → Blob  │
                      │  2. Construct File object  │
                      │  3. Set gate flag          │
                      │  4. Monkey-patch .click()  │
                      │  5. Trigger upload button  │
                      │  6. Patch intercepts call  │
                      │  7. Build DataTransfer     │
                      │  8. Dispatch 'change' evt  │
                      │  9. Restore originals      │
                      └───────────────────────────┘
```

## Implementation Detail

### Step 1: Base64 File Transfer over CDP

CDP `Runtime.evaluate` can execute arbitrary JavaScript in the page context,
but it cannot pass binary data directly. We encode the file as base64 and
decode it inside the page.

```javascript
// Executed via CDP Runtime.evaluate
(function(b64Data, fileName, mimeType) {
  const byteChars = atob(b64Data);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: mimeType });
  const file = new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });

  // Store on window for subsequent steps
  window.__pendingUploadFile = file;
})(BASE64_DATA, FILE_NAME, MIME_TYPE);
```

**Size considerations**: Base64 inflates data by ~33%. For files larger than
~5 MB, consider chunked transfer or the `IO.read` / `IO.write` CDP domain
with stream handles. For most upload scenarios (images, documents, small
media), single-shot base64 is sufficient.

### Step 2: One-Shot Gate Flag

The monkey-patch must fire exactly once -- for the upload we are controlling --
then restore normal behavior. A global flag serves as a gate.

```javascript
// Set the gate: next .click() on a file input will be intercepted
window.__uploadInterceptActive = true;
```

The flag is checked and immediately cleared inside the patched `.click()`:

```javascript
if (!window.__uploadInterceptActive) {
  return originalClick.call(this);
}
window.__uploadInterceptActive = false;
// ... proceed with file injection ...
```

This ensures:

* Only the intended upload is intercepted.
* Subsequent `.click()` calls (e.g., UI re-renders, unrelated buttons) pass
  through to native behavior.
* No persistent side effects remain after the upload completes.

### Step 3: Dual Monkey-Patch (Instance + Prototype)

Web applications may call `.click()` on a specific input element instance or
on any `HTMLInputElement` via prototype delegation. We must patch both.

```javascript
(function() {
  const file = window.__pendingUploadFile;
  if (!file) throw new Error('No pending upload file');

  const proto = HTMLInputElement.prototype;
  const originalProtoClick = proto.click;

  // Identify the target input (if known)
  const targetInput = document.querySelector('input[type="file"]');

  // Save instance-level original if it exists
  const originalInstanceClick = targetInput
    ? targetInput.click
    : null;

  function patchedClick() {
    // Gate check
    if (!window.__uploadInterceptActive) {
      return originalProtoClick.call(this);
    }

    // Only intercept file inputs
    if (this.type !== 'file') {
      return originalProtoClick.call(this);
    }

    // Clear the gate
    window.__uploadInterceptActive = false;

    // Inject the file via DataTransfer
    injectFile(this, file);

    // Restore originals
    proto.click = originalProtoClick;
    if (targetInput && originalInstanceClick) {
      targetInput.click = originalInstanceClick;
    }
    delete window.__pendingUploadFile;
    delete window.__uploadInterceptActive;
  }

  // Apply dual patch
  proto.click = patchedClick;
  if (targetInput) {
    targetInput.click = patchedClick;
  }
})();
```

### Step 4: DataTransfer + Object.defineProperty for File Injection

The `DataTransfer` API is the browser-native way to represent files in transit.
However, `DataTransfer.files` is normally read-only. We use
`Object.defineProperty` to override it.

```javascript
function injectFile(inputElement, file) {
  // Construct a DataTransfer and add the file
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  // Override the input's files property
  Object.defineProperty(inputElement, 'files', {
    value: dataTransfer.files,
    writable: true,
    configurable: true,
  });

  // Dispatch a 'change' event so the application reacts
  const changeEvent = new Event('change', { bubbles: true });
  inputElement.dispatchEvent(changeEvent);

  // Some frameworks also listen for 'input' events
  const inputEvent = new Event('input', { bubbles: true });
  inputElement.dispatchEvent(inputEvent);
}
```

**Why `Object.defineProperty`?** The `HTMLInputElement.files` setter is
restricted by the browser security model. Direct assignment
(`input.files = dt.files`) works in some browsers but fails silently in
others. `Object.defineProperty` with `configurable: true` ensures we can set
it reliably and clean it up afterward.

### Step 5: Full Mouse Event Sequence for Custom Buttons

Many applications do not expose a raw `<input type="file">`. Instead, a styled
button or div handles clicks and programmatically triggers the hidden input.
To activate these, we must simulate a realistic mouse event sequence on the
visible trigger element.

```javascript
function simulateClickSequence(element) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const commonInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + window.screenX,
    screenY: y + window.screenY,
    button: 0,
    buttons: 1,
  };

  const events = [
    new PointerEvent('pointerdown', { ...commonInit, pointerId: 1 }),
    new MouseEvent('mousedown', commonInit),
    new PointerEvent('pointerup', { ...commonInit, pointerId: 1 }),
    new MouseEvent('mouseup', commonInit),
    new MouseEvent('click', commonInit),
  ];

  for (const evt of events) {
    element.dispatchEvent(evt);
  }
}
```

**Event ordering matters.** Some UI frameworks (React's synthetic event system
in particular) check for the full pointer/mouse sequence. Dispatching only a
`click` event may be silently ignored. The sequence above mirrors what a real
user interaction produces.

### Step 6: Cleanup Safety

Robust cleanup is critical. If the monkey-patch remains installed after use
(or after an error), it can break normal page behavior.

```javascript
function cleanupUploadPatch() {
  // Restore prototype
  if (window.__originalProtoClick) {
    HTMLInputElement.prototype.click = window.__originalProtoClick;
    delete window.__originalProtoClick;
  }

  // Restore instance overrides
  if (window.__patchedInstances) {
    for (const [element, original] of window.__patchedInstances) {
      if (original) {
        element.click = original;
      } else {
        delete element.click;
      }
    }
    delete window.__patchedInstances;
  }

  // Clear gate and pending file
  delete window.__uploadInterceptActive;
  delete window.__pendingUploadFile;
}

// Safety: auto-cleanup after timeout
setTimeout(cleanupUploadPatch, 10000);
```

The 10-second timeout acts as a safety net. If the upload trigger never fires
(e.g., the button selector was wrong), the page returns to its normal state
automatically.

## Complete Orchestration Flow

The automation controller orchestrates these steps as a sequence of CDP calls:

```python
import base64
from pathlib import Path

async def upload_file_via_cdp(cdp_session, file_path: str,
                               trigger_selector: str,
                               input_selector: str = 'input[type="file"]'):
    """
    Upload a file by monkey-patching the file input's click handler.

    Args:
        cdp_session: CDP session (e.g., from pyppeteer, playwright, etc.)
        file_path: Local path to the file to upload.
        trigger_selector: CSS selector for the visible upload button/area.
        input_selector: CSS selector for the hidden file input (if known).
    """
    path = Path(file_path)
    b64_data = base64.b64encode(path.read_bytes()).decode('ascii')
    mime_type = _guess_mime(path.name)

    # Step 1: Transfer file data into page context
    await cdp_session.evaluate(f'''
        (function() {{
            const byteChars = atob("{b64_data}");
            const arr = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {{
                arr[i] = byteChars.charCodeAt(i);
            }}
            const blob = new Blob([arr], {{ type: "{mime_type}" }});
            window.__pendingUploadFile = new File(
                [blob], "{path.name}",
                {{ type: "{mime_type}", lastModified: Date.now() }}
            );
        }})();
    ''')

    # Step 2 & 3: Install gate + dual monkey-patch
    await cdp_session.evaluate(f'''
        (function() {{
            window.__uploadInterceptActive = true;
            const proto = HTMLInputElement.prototype;
            window.__originalProtoClick = proto.click;
            window.__patchedInstances = [];

            const target = document.querySelector('{input_selector}');

            function patched() {{
                if (!window.__uploadInterceptActive || this.type !== 'file') {{
                    return window.__originalProtoClick.call(this);
                }}
                window.__uploadInterceptActive = false;

                const dt = new DataTransfer();
                dt.items.add(window.__pendingUploadFile);
                Object.defineProperty(this, 'files', {{
                    value: dt.files, writable: true, configurable: true,
                }});

                this.dispatchEvent(new Event('change', {{ bubbles: true }}));
                this.dispatchEvent(new Event('input', {{ bubbles: true }}));

                // Restore
                proto.click = window.__originalProtoClick;
                for (const [el, orig] of window.__patchedInstances) {{
                    if (orig) el.click = orig; else delete el.click;
                }}
                delete window.__pendingUploadFile;
                delete window.__uploadInterceptActive;
                delete window.__originalProtoClick;
                delete window.__patchedInstances;
            }}

            proto.click = patched;
            if (target) {{
                window.__patchedInstances.push([target, target.click]);
                target.click = patched;
            }}

            // Safety timeout
            setTimeout(function() {{
                if (window.__originalProtoClick) {{
                    proto.click = window.__originalProtoClick;
                    delete window.__originalProtoClick;
                }}
                delete window.__uploadInterceptActive;
                delete window.__pendingUploadFile;
            }}, 10000);
        }})();
    ''')

    # Step 4: Trigger the visible upload button
    await cdp_session.evaluate(f'''
        (function() {{
            const trigger = document.querySelector('{trigger_selector}');
            if (!trigger) throw new Error('Upload trigger not found');

            const rect = trigger.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const init = {{
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y, button: 0, buttons: 1,
            }};

            trigger.dispatchEvent(new PointerEvent('pointerdown',
                {{ ...init, pointerId: 1 }}));
            trigger.dispatchEvent(new MouseEvent('mousedown', init));
            trigger.dispatchEvent(new PointerEvent('pointerup',
                {{ ...init, pointerId: 1 }}));
            trigger.dispatchEvent(new MouseEvent('mouseup', init));
            trigger.dispatchEvent(new MouseEvent('click', init));
        }})();
    ''')
```

## Edge Cases and Mitigations

| Scenario | Mitigation |
|---|---|
| Multiple `<input type="file">` on page | Pass explicit `input_selector` that uniquely identifies the target |
| Input created dynamically after patch | Use `MutationObserver` to detect new file inputs and patch them |
| Framework replaces input on re-render | Re-install patch after framework tick (`requestAnimationFrame`) |
| Shadow DOM encapsulation | Query inside shadow roots: `host.shadowRoot.querySelector(...)` |
| Cross-origin iframe | Use `CDP Target.attachToTarget` to get a session for the iframe's context |
| File size > ~10 MB | Use chunked base64 or CDP `IO` domain streams |
| `accept` attribute filtering | Set `file.type` to match the input's `accept` attribute |

## Security Considerations

* **Scope**: All monkey-patching is ephemeral (one-shot + timeout cleanup).
  No persistent page modifications remain.
* **Global namespace**: Uses `window.__` prefixed names to minimize collision
  risk with application code. Consider using a `Symbol()` for true isolation.
* **CSP**: `Runtime.evaluate` bypasses Content Security Policy by design (it
  runs in the page's "main world"). No CSP modifications are needed.
* **Same-origin**: The injected code runs in the page's origin context. For
  cross-origin uploads (iframes), a separate CDP session for the target frame
  is required.

## Alternatives Considered

| Approach | Why Not |
|---|---|
| `Page.handleFileChooser` | Does not cover custom dropzones, paste, or hidden inputs that never open a dialog |
| `DOM.setFileInputFiles` | CDP domain method; works only for `<input type="file">` directly, no DataTransfer support |
| Drag-and-drop simulation via `Input.dispatchDragEvent` | Limited browser support in CDP; many apps check `DataTransfer` contents which CDP cannot populate natively |
| Clipboard paste injection | Only works for apps that support paste-to-upload; not universal |

## Summary

The monkey-patch click interception pattern provides a universal file upload
mechanism for browser automation that works regardless of how the target
application implements its upload UI. The key components are:

1. **Base64 transfer** -- get file bytes into the page context via CDP eval.
2. **One-shot gate** -- ensure the patch fires exactly once.
3. **Dual monkey-patch** -- cover both instance and prototype `.click()`.
4. **DataTransfer injection** -- use `Object.defineProperty` to set `files`.
5. **Full event sequence** -- simulate realistic pointer/mouse events.
6. **Cleanup safety** -- auto-restore via timeout and post-upload teardown.
