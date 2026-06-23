# FUTURE_WORK — QUEUE: linkedin gains the attach-upload feature (LOW PRIORITY)

* **Category:** migrate
* **Created:** 2026-06-23
* **Priority:** LOW — Greg: **queue, no commitment now.** linkedin-owner + Greg
  schedule if/when linkedin wants it.
* **Concerns:** linkedin-webctl; chatgpt-webctl `lib/browser-location/file-staging.js`;
  the mounts decouple (`260623-mounts-reconcile-file-staging-finding.md`).

## Why this exists (decoupled from mounts extraction)

The v0.4.0 mounts extraction is file-staging-AGNOSTIC by design (Greg Option A):
base `createMounts(C)` adds the upload mount when `cfg.uploadHostPath` is set,
using base-owned `CONTAINER_UPLOAD_DIR='/cliai-uploads'`. That gives linkedin the
*capability* to mount an upload dir — but linkedin never SETS `uploadHostPath`
because it lacks the subsystem that stages files and drives `setFileInputFiles`.

So "linkedin gains uploads" = a real FEATURE port, separate from mounts:

* port `file-staging.js` (~12 KB) from chatgpt into linkedin,
* wire its host-side callers (whatever copy-stages files + sets `cfg.uploadHostPath`
  + calls CDP `setFileInputFiles`),
* add linkedin tests.

## Status

QUEUED. Not started. Proposal stub: `proposals/2026-06-23-linkedin-uploads-feature.md`.
The mounts extraction does NOT block on this and must not include it.

## Note

This is also a candidate to extract `file-staging.js` into base later (if it is
service-agnostic enough) so both tools share it — assess at scheduling time.
