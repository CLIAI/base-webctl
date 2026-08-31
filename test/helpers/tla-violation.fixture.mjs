// NEGATIVE CONTROL for require-esm-from-cjs.test.cjs — DO NOT "fix" this file.
//
// This module deliberately VIOLATES base's no-top-level-await guarantee. It
// exists so the guard test can prove it is capable of FAILING: a guard that
// only ever sees compliant input is indistinguishable from a guard that is
// broken and passes everything. If Node ever stops throwing
// ERR_REQUIRE_ASYNC_MODULE for this file, the guard has gone vacuous and the
// test says so loudly rather than staying green.
//
// Not under tsconfig's `include` (lib/**/*.js only), so it never reaches tsc.

await Promise.resolve();

export const thisModuleIsIntentionallyAsync = true;
