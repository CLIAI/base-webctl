// base-webctl — public API surface (sb7q §"API surface & semver").
//
// This is the ONLY public entry point. Consumers import from here (or, for a
// drop-in submodule shim during migration, from the specific module path);
// everything else under lib/ is internal and may change without a major bump.
//
// Tag: [WEBCTL::CDP]

// Thin, zero-dep docker-CLI wrapper (the multi-tenant `^name$`-anchored verbs).
// Exposed as a namespace so callers write `dockerCtl.containerExists(name)`.
// See ./browser-location/docker-ctl.js.
import * as dockerCtl from './browser-location/docker-ctl.js';

export { dockerCtl };
