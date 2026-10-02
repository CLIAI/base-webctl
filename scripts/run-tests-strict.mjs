#!/usr/bin/env node
// run-tests-strict.mjs — run `node --test` so a vanished test block FAILS.
//
// Human output (spec) on stdout; the strict reporter on stderr. Any arguments
// are passed through to `node --test` (files, globs, --test-name-pattern, …).
//
// ⛔ NODE_TEST_CONTEXT is REMOVED from the child's environment. When a runner is
// started from inside another node:test process, that variable switches the
// child into the parent-protocol mode and the reporters given here are not the
// ones that decide the outcome. (Prior art: `chatgpt`'s run-unit-tests.cjs.)
//
// Exit: the child's code — 1 when the strict reporter saw any failure event.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const reporter = path.join(import.meta.dirname, 'strict-reporter.mjs');
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const r = spawnSync(process.execPath, [
  '--test',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  `--test-reporter=${reporter}`, '--test-reporter-destination=stderr',
  ...process.argv.slice(2),
], { stdio: 'inherit', env });

if (r.error) { process.stderr.write(`run-tests-strict: ${r.error.message}\n`); process.exit(3); }
process.exit(r.status === null ? 1 : r.status);
