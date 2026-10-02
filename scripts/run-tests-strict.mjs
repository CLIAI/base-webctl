#!/usr/bin/env node
// run-tests-strict.mjs — run `node --test` so a vanished test block FAILS.
//
// spec on stdout (--tap for TAP — REQUIRED in a gate contract); the strict reporter on stderr. Any arguments
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

// Our own flags; everything else passes through to `node --test`.
//   --serial               = --test-concurrency=1. node runs test FILES concurrently by
//                            default; suites that spawn processes, bind listeners or take
//                            lock dirs can collide (`linkedin`'s 34-file census).
//   --allow-plain-scripts  a file that registers NO node:test tests but exits 0 counts as
//                            one pass (node's own behaviour) instead of failing as EMPTY.
//                            For direct-script suites. ⚠ It gives up the empty-file guard
//                            for every file in the run, so split such runs from node:test ones.
// ⛔ Only the FLAG enables it: an inherited variable would switch the guard off unseen.
delete env.WEBCTL_STRICT_ALLOW_PLAIN_SCRIPTS;
const passthrough = [];
let human = 'spec';
for (const a of process.argv.slice(2)) {
  // ⛔ PASS --tap IN A CONTRACT. The release gate reads contract output line by line. On
  // `gemini`'s and `substack`'s suites THIS RUNNER printed 0 TAP lines to stdout (spec
  // default); both lanes measured it, kept TAP visible by passing the reporter through,
  // and reported it — hence --tap. The DEFAULT stays spec: flipping it to TAP broke a
  // lane that parses spec's "ℹ tests N" (`fetlife`, at the v0.28.0 gate) — a change to what
  // an existing caller already gets (sb7q). So visibility is a documented REQUIRED flag.
  if (a === '--tap') human = 'tap';
  else if (a === '--spec') human = 'spec';
  else if (a === '--serial') passthrough.push('--test-concurrency=1');
  else if (a === '--allow-plain-scripts') env.WEBCTL_STRICT_ALLOW_PLAIN_SCRIPTS = '1';
  else passthrough.push(a);
}

const r = spawnSync(process.execPath, [
  '--test',
  `--test-reporter=${human}`, '--test-reporter-destination=stdout',
  `--test-reporter=${reporter}`, '--test-reporter-destination=stderr',
  ...passthrough,
], { stdio: 'inherit', env });

if (r.error) { process.stderr.write(`run-tests-strict: ${r.error.message}\n`); process.exit(3); }
process.exit(r.status === null ? 1 : r.status);
