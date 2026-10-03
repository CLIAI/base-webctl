// test-cache-root.mjs — a throwaway cacheRoot for driver tests.
//
// The docker driver serializes bring-up per profile with a process mutex under
// `<mounts.cacheRoot()>/locks`. Driver tests stub cacheRoot; a FIXED stub
// (e.g. '/tmp/cache') would make every test process share one lock directory —
// writing outside the test's own scratch, and serializing unrelated test files
// that happen to use the same fictional profile path. One directory per test
// PROCESS, removed when it exits.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_CACHE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'webctl-test-cache-'));

process.on('exit', () => {
  try { fs.rmSync(TEST_CACHE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});
