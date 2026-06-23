# Proposal (QUEUED, LOW PRIORITY) — linkedin-webctl gains the attach-upload feature

* **For:** `webctl:linkedin@knot` + Greg — **schedule if/when wanted.**
* **From:** `webctl:base@knot` (2026-06-23).
* **Status:** QUEUED, **no commitment** (Greg, 2026-06-23). NOT started, NOT a
  blocker for the v0.4.0 mounts extraction.
* **Refs:** `FUTURE_WORK/migrate/260623-linkedin-uploads-feature-queue.md`,
  `…/260623-mounts-reconcile-file-staging-finding.md`.

## What linkedin would gain

The attach-upload capability chatgpt-webctl already has: stage a file on the host,
mount it **read-only** into the chromium container at `/cliai-uploads`, and drive
`setFileInputFiles` over CDP so a page's `<input type=file>` is filled without a
GUI file picker (WAY 1 of the attach-upload fix).

## Why it's separate from the mounts extraction

base `createMounts(C)` (v0.4.0) is intentionally file-staging-agnostic: it adds
the upload mount only when `cfg.uploadHostPath` is set. linkedin gets that wiring
for free, but never sets `uploadHostPath` because it lacks the staging subsystem.
This proposal is the missing subsystem — a feature add, not a reconcile.

## Scope (to size when scheduled)

* Port `lib/browser-location/file-staging.js` (~12 KB) from chatgpt (assess: keep
  per-repo, or extract to base if service-agnostic enough to share).
* Wire the host-side caller(s): copy-stage the user's file into the per-slug host
  staging dir, set `cfg.uploadHostPath`, call CDP `setFileInputFiles`, clean up.
* Tests (unit for staging path logic + a mocked CDP upload).
* Confirm the data-safety gate (the mount is `ro`; staging/cleanup happen on the
  host, not through the mount).

## Decision needed (later)

Does linkedin want this feature, and at what priority? If yes, also decide whether
`file-staging.js` lands per-repo or is extracted to base for both tools. Until
then this stays queued; the mounts extraction proceeds without it.
