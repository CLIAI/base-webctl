# FUTURE_WORK — mounts reconcile surfaced a bigger scope (file-staging missing)

* **Category:** migrate
* **Created:** 2026-06-23
* **Concerns:** v0.4.0 step 1 (mounts reconcile-then-extract);
  `chromium-docker-xpra` driver chain; consumers linkedin-webctl + chatgpt-webctl.
* **Status:** BLOCKER-SURFACED — needs a manager/Greg scope decision before the
  mounts reconcile proceeds. (Manager asked to be pinged "sooner if mounts
  surfaces anything unexpected" — this is that.)

## The finding

The manager's v0.4.0 step 1 = "reconcile mounts.js (canonical=chatgpt, it carries
the WAY-1 attachment-upload fix; linkedin lacks it); port the fix so both match;
deliver to linkedin as a proposal; then factory-extract via createMounts(C)."

The actual `mounts.js` delta (chatgpt − linkedin) is SMALL:

```diff
+ const fileStaging = require('./file-staging');
  ...
+ // cfg.uploadHostPath -> a DEDICATED read-only upload mount at
+ //   fileStaging.CONTAINER_UPLOAD_DIR  (WAY 1 of the attach-upload fix)
+ if (cfg.uploadHostPath) {
+   m.push([cfg.uploadHostPath, fileStaging.CONTAINER_UPLOAD_DIR, 'ro']);
+ }
```

BUT the fix `require()`s **`./file-staging`**, and:

* **linkedin LACKS `file-staging.js` entirely** (chatgpt has it: ~12 KB).
* So porting the mounts.js delta verbatim into linkedin gives it an unresolvable
  `require('./file-staging')`. "Port the fix so both match" is therefore NOT a
  localized mounts edit — it pulls in a whole upload-staging subsystem
  (`file-staging.js` + whatever host-side code copy-stages + calls
  `setFileInputFiles` + sets `cfg.uploadHostPath`) that linkedin does not have.

## Why this matters

The mounts.js change is the visible *tip*; the *feature* behind it
(attach-upload staging) is a multi-file subsystem. Two very different scopes hide
under "port the fix":

* **(small)** the mount-wiring: 6 lines in mounts.js + a `CONTAINER_UPLOAD_DIR`
  constant.
* **(large)** the upload FEATURE linkedin would actually gain: `file-staging.js`
  + its callers + tests. A real feature addition, not a reconcile.

## Recommended path (decouple at base; keep v0.4.0 mounts extraction unblocked)

1. **base `createMounts(C)` does NOT depend on `file-staging`.** The mount-builder
   only needs the container upload path STRING. Make base take it as
   `cfg.uploadHostPath` + a `CONTAINER_UPLOAD_DIR` that is either a base-owned
   shared constant (it is a fixed container path `/cliai-uploads`, identical
   across tools — a good base-owned value) or injected. Then base mounts is
   file-staging-agnostic and BOTH consumers get a byte-identical base mounts.
2. **Extract mounts via `createMounts(C)`** as planned — proven in scratch
   against BOTH consumers (chatgpt already drives uploadHostPath; linkedin simply
   never sets it, so its behaviour is unchanged → safe).
3. **Split the "linkedin gains uploads" into its own proposal**, honestly scoped:
   it requires porting `file-staging.js` + wiring its callers in linkedin — a
   feature addition, separate from the mounts extraction. Deliver as
   `proposals/…-linkedin-attach-upload-feature.md` (bigger; linkedin owner +
   Greg decide if/when linkedin wants the feature).

Net: the mounts EXTRACTION proceeds now (both repos consume base mounts; no
behaviour change for either); the upload FEATURE port to linkedin is decoupled
and correctly sized.

## Question for the manager / Greg

Confirm the decouple-at-base path (mounts extraction now, feature-port to linkedin
as a separate larger proposal), vs. front-loading the full file-staging feature
port into linkedin before extracting mounts. The former keeps v0.4.0 moving and
is honest about scope; the latter is a bigger reconcile that blocks the driver
chain longer.

## CONTAINER_UPLOAD_DIR

`/cliai-uploads` (read from chatgpt `file-staging.js`). Fixed container-side path,
identical across tools → candidate base-owned shared constant (not per-repo seam).
Verify the exact value when implementing.
