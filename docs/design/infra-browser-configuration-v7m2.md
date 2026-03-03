---
id: v7m2
title: "Browser Configuration: Launch Flags, Window Sizing & Platform Detection"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [browser-launch, chromium-flags, window-sizing, cdp-connection, anti-throttling, port-isolation]
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Browser Configuration: Launch Flags, Window Sizing & Platform Detection

## Motivation

Browser automation tools that rely on the Chrome DevTools Protocol (CDP) need a
carefully curated set of launch flags, window-sizing strategies, and
platform-detection logic. Getting these wrong leads to silent failures:
throttled timers break polling loops, leftover profiles cause port collisions,
and mismatched display servers crash the browser on launch.

This document catalogues the essential configuration surface, explains the
rationale behind each flag, and provides reusable patterns for window sizing and
platform detection.

## Core CDP Launch Flags

Every CDP-based tool must set at minimum two flags to guarantee a clean,
debuggable browser instance:

```
--remote-debugging-port=PORT
--user-data-dir=PATH
```

**`--remote-debugging-port=PORT`** opens the CDP WebSocket endpoint. Without it,
no programmatic control is possible. The port must be unique per running
instance to avoid collisions (see [Port Isolation](#port-isolation) below).

**`--user-data-dir=PATH`** forces a fresh profile directory. Without it,
Chromium may attach to an already-running instance that owns the default
profile, silently ignoring the requested debugging port. Always use a
tool-specific, ephemeral directory (e.g., `/tmp/tool-profile-<pid>/`).

## Anti-Throttling Flags

Modern Chromium aggressively throttles background tabs and occluded windows to
save resources. For automation this is destructive -- timers fire late,
animations pause, and network polling stalls.

The following flags, sourced from Google's official `chrome-flags-for-tools.md`
reference, disable these optimizations:

```
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-background-timer-throttling
--disable-background-media-suspend
```

### Flag Rationale

| Flag | What it prevents |
|------|-----------------|
| `--disable-backgrounding-occluded-windows` | Throttling when another window covers the browser |
| `--disable-renderer-backgrounding` | Deprioritizing renderer processes for non-focused tabs |
| `--disable-background-timer-throttling` | Reducing `setTimeout`/`setInterval` frequency in background |
| `--disable-background-media-suspend` | Pausing media playback in background tabs |

All four should be set together. Omitting any one can cause intermittent
failures that are difficult to diagnose because they depend on OS-level window
stacking and focus state.

## UX Noise Suppression

Automation sessions should not trigger interactive dialogs or first-run
workflows. These flags silence common interruptions:

```
--no-first-run
--no-default-browser-check
--disable-session-crashed-bubble
```

**`--no-first-run`** suppresses the welcome page and default-search prompts
that would otherwise steal navigation on the first launch with a new profile.

**`--no-default-browser-check`** prevents the "set as default browser" dialog.

**`--disable-session-crashed-bubble`** hides the "Chromium didn't shut down
correctly" bar that appears after an unclean exit -- common in automation where
processes are killed rather than gracefully closed.

## Window Sizing

### Resolution Catalog

A predefined catalog of standard resolutions allows tools to pick the largest
window that fits the current display. Both landscape and portrait orientations
should be supported:

**Landscape (width >= height):**

| Label | Dimensions |
|-------|-----------|
| Full HD | 1920 x 1080 |
| HD+ | 1600 x 900 |
| HD | 1366 x 768 |
| Medium | 1280 x 720 |
| Compact | 1024 x 768 |
| Small | 800 x 600 |

**Portrait (height > width):**

Swap width and height from the landscape catalog for mobile-emulation
workflows.

### Adaptive Sizing Algorithm

```
function findBestResolution(screenWidth, screenHeight):
    for each resolution in catalog (largest first):
        if resolution.width <= screenWidth
           and resolution.height <= screenHeight:
            return resolution
    return smallest resolution in catalog
```

Leave a margin (e.g., 50px) for OS window decorations and taskbars.

### CDP Two-Step Resize Pattern

Setting window size via CDP requires a specific sequence because maximized
windows ignore dimension requests:

1. **Unmaximize** the window using `Browser.setWindowBounds` with
   `windowState: "normal"`.
2. **Set exact dimensions** using `Browser.setWindowBounds` with the desired
   `width` and `height`.

This must use a **browser-level** WebSocket connection (the `/json/version`
endpoint), not a page-level target connection. Page-level connections do not
have access to the `Browser` domain methods required for window manipulation.

```
// Step 1: Unmaximize
Browser.setWindowBounds({
    windowId: id,
    bounds: { windowState: "normal" }
})

// Step 2: Set exact size
Browser.setWindowBounds({
    windowId: id,
    bounds: { width: 1920, height: 1080 }
})
```

## Platform Detection (Ozone)

On Linux, Chromium's Ozone abstraction layer must be told which display server
to use. Passing the wrong platform flag causes immediate crash-on-launch.

### Detection Logic

Read `XDG_SESSION_TYPE` and map accordingly:

| `XDG_SESSION_TYPE` | Flag |
|-------------------|------|
| `x11` | `--ozone-platform=x11` |
| `wayland` | `--ozone-platform=wayland` |
| unset / other | omit flag (let Chromium auto-detect) |

This detection should happen at launch time, not at build time or install time,
because users may switch between X11 and Wayland sessions on the same machine.

## Port Isolation

### Convention

Each tool instance uses a unique, non-standard port for its CDP debugging
endpoint. Standard ports like `9222` (Chromium default) or `8080` should be
avoided to prevent collisions with other tools or manual browser instances.

### Configuration Hierarchy

Ports should be configurable through multiple mechanisms, resolved in priority
order:

1. **Command-line flag** (`--port=PORT`) -- highest priority
2. **Environment variable** (`TOOLPREFIX_PORT`) -- medium priority
3. **Dotenv file** (`.env`) -- low priority
4. **Hardcoded default** -- fallback, must be a non-standard port

This layered approach lets users override in CI, development, or production
contexts without modifying code.

## Browser Focus Behavior

CDP's `Page.bringToFront` method steals OS-level focus to the browser window.
This is intentional -- some web applications behave differently when not
focused (e.g., pausing animations or reducing update frequency). Bringing the
window to front ensures the page sees itself as the active tab in the active
window.

### Workarounds for Focus Stealing

When focus stealing disrupts the user's workflow:

* **tmux / screen** -- run the automation tool in a terminal multiplexer so
  focus changes don't affect the controlling terminal
* **Virtual framebuffer (Xvfb)** -- run the browser in a headless X server
  where focus is irrelevant
* **Dedicated workspace** -- assign the browser to a separate virtual desktop
  in the window manager
* **`--no-focus` flag** -- if the tool provides one, skip `bringToFront` calls
  (at the cost of potential rendering differences)

## CDP Connection Troubleshooting

Common failure modes when establishing CDP connections:

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Connection refused on port | Browser not launched, wrong port, or firewall | Verify process is running; check port with `lsof -i :PORT` |
| WebSocket handshake fails | Connecting to wrong endpoint (page vs. browser) | Use `/json/version` for browser-level, `/json/list` for page targets |
| "Target closed" immediately | Profile directory locked by another instance | Use unique `--user-data-dir` per instance |
| Intermittent timeouts | Background throttling active | Apply all anti-throttling flags |
| Window resize has no effect | Window is maximized | Apply two-step resize pattern |

## Recommended Flag Set (Complete)

Combining all categories, a minimal recommended flag set for automation:

```
--remote-debugging-port=<UNIQUE_PORT>
--user-data-dir=<EPHEMERAL_PATH>
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-background-timer-throttling
--disable-background-media-suspend
--no-first-run
--no-default-browser-check
--disable-session-crashed-bubble
--ozone-platform=<DETECTED>       # Linux only
```

Order does not matter. All flags use the double-dash GNU-style format.
