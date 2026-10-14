// gate-registry-stdin.test.js — a consumer that reads stdin cannot swallow the
// rest of the registry, and the gate refuses a summary short of the registry.
//
// Measured 2026-10-13: the gate fed its registry rows to the loop on stdin, and
// every consumer's test inherited that stdin. One that read it (a `cat`, a
// prompt, a `read`) ate the remaining rows; the gate then reported the lanes it
// had reached as if they were all of them. Runs against FAKE consumers through
// WEBCTL_CONSUMERS_FILE — never the fleet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'scripts', 'test-all-consumers.sh');

/**
 * One fake consumer repo with a mounted base gitlink and the given contract body.
 * @param {string} dir @param {string} name @param {string} body
 */
function fakeConsumer(dir, name, body) {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'test-against-base.sh'),
    `#!/usr/bin/env bash\n${body}\necho 'ok 1 - a'\necho '# tests 1'\necho '# pass 1'\necho '# fail 0'\nexit 0\n`,
    { mode: 0o755 });
  const g = (/** @type {string[]} */ a, cwd = repo) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  const sub = path.join(repo, 'vendor', 'base-webctl');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'README.md'), 'fake base\n');
  g(['init', '-q'], sub); g(['add', '.'], sub);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], sub);
  g(['init', '-q']); g(['add', '.']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fake']);
  return { name, submodulePath: 'vendor/base-webctl', testCmd: './test-against-base.sh',
    tier: 'full', wired: true, localDir: repo };
}

/** @param {string[]} bodies one contract body per consumer, in registry order */
function runGate(bodies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-stdin-'));
  try {
    const consumers = bodies.map((b, i) => fakeConsumer(dir, `fake${i}-webctl`, b));
    const reg = path.join(dir, 'consumers.jsonc');
    fs.writeFileSync(reg, JSON.stringify({ consumers }));
    const env = { ...process.env, WEBCTL_CONSUMERS_FILE: reg, WEBCTL_CONSUMERS_DIR: dir,
      WEBCTL_GATE_LOG_DIR: path.join(dir, 'gate-logs') };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync('bash', [GATE], { encoding: 'utf8', env, timeout: 120000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('CONTROL: three quiet consumers — all three reached and PASS', () => {
  const r = runGate([':', ':', ':']);
  assert.equal(r.status, 0, r.out);
  for (const n of ['fake0-webctl', 'fake1-webctl', 'fake2-webctl']) assert.match(r.out, new RegExp(`PASS {2}${n}`));
  assert.match(r.out, /lanes reached: 3 of 3 registered/);
});

test('⛔ a consumer that READS STDIN cannot swallow the lanes after it', () => {
  const r = runGate([':', 'cat > /dev/null', ':']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS {2}fake2-webctl/, 'the lane after the stdin reader must still run');
  assert.match(r.out, /lanes reached: 3 of 3 registered/);
});

test('⛔ a consumer that `read`s a line gets EOF, not a registry row', () => {
  const r = runGate(['if IFS= read -r l; then echo "GOT-STDIN:$l"; else echo NO-STDIN; fi', ':']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /NO-STDIN/);
  assert.doesNotMatch(r.out, /GOT-STDIN/);
  assert.match(r.out, /PASS {2}fake1-webctl/);
});
