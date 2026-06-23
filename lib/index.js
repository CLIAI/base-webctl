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
};
