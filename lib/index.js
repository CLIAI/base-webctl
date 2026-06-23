// base-webctl — public API surface (sb7q §"API surface & semver").
//
// This is the ONLY public entry point. Consumers import from here (or, for a
// drop-in submodule shim during migration, from the specific module path);
// everything else under lib/ is internal and may change without a major bump.
//
// Tag: [WEBCTL::CDP]

// Thin, zero-dep docker-CLI wrapper (the multi-tenant `^name$`-anchored verbs).
// See ./browser-location/docker-ctl.js.
import * as dockerCtl from './browser-location/docker-ctl.js';

// CDP WebSocket URL host:port rewriting (container loopback -> host loopback).
import * as cdpRewrite from './browser-location/cdp-rewrite.js';

// The localhost-direct browser-location driver (legacy on-host Chromium path).
import * as localhostDirect from './browser-location/localhost-direct.js';

// "Is a human watching?" — xpra client-attachment presence signal.
import * as xpraPresence from './xpra-presence.js';

// Pure LRU tab-cleanup decision logic (no CDP, no fs).
import * as lruCleanup from './lru-cleanup.js';

// systemd --user timer generation + management for periodic maintenance.
import * as systemdTimer from './systemd-timer.js';

// ── Per-repo constants seam (sm2t) — factories that take an injected `C` ──
// The constants shape/template + validator (base ships these; never values).
import * as clientConfigConstantsTemplate from './client-config.constants.template.js';
// The shared client/config resolver: createClientConfig(C).
import * as clientConfig from './client-config.js';
// Chromium Preferences scrub helpers: createChromiumPrefs(C).
import * as chromiumPrefs from './chromium-prefs.js';
// Cross-mode profile-directory lock: createProfileLock(C).
import * as profileLock from './browser-location/profile-lock.js';
// Docker-xpra path + mount layout: createMounts(C). File-staging-agnostic; base
// owns CONTAINER_UPLOAD_DIR, upload mount gated on cfg.uploadHostPath (sm2t).
import * as mounts from './browser-location/mounts.js';
// docker-xpra browser driver: createChromiumDockerXpra(C, opts). file-staging
// seam injected via opts.fileStaging (no-op default → byte-unchanged) (sm2t).
import * as chromiumDockerXpra from './browser-location/chromium-docker-xpra.js';
// Browser-location driver registry: createRegistry(C, opts) (sm2t).
import * as registry from './browser-location/registry.js';
// Host-side xpra attach helpers: createXpraAttach(C) (sm2t; linkedin-canonical).
import * as xpraAttach from './browser-location/xpra-attach.js';
// Browser-location resolver entry point (chain aggregator): createBrowserLocation(C, opts).
import * as browserLocation from './browser-location/index.js';
// xpra-html5 tailnet remote-access gateway (P1): createXpraHtml5Gateway(C, opts).
import * as xpraHtml5Gateway from './browser-location/xpra-html5-gateway.js';
// xpra-access grant/request store (gateway P2): createAccessStore(opts).
import * as xpraAccessStore from './browser-location/xpra-access-store.js';

export {
  dockerCtl,
  cdpRewrite,
  localhostDirect,
  xpraPresence,
  lruCleanup,
  systemdTimer,
  // seam (sm2t)
  clientConfigConstantsTemplate,
  clientConfig,
  chromiumPrefs,
  profileLock,
  mounts,
  chromiumDockerXpra,
  registry,
  xpraAttach,
  browserLocation,
  xpraHtml5Gateway,
  xpraAccessStore,
};
