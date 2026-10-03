// Unit tests for lib/target-transport.js (rb7s §6.1, §6.2, §6.4).
//
// ssh is NEVER real here: every call goes to a stub shell script written into a temp
// dir and passed as `sshBin`. The "remote" stub runs its LAST argument — the one string
// ssh would hand the remote login shell — through a local `sh -c`, which is exactly the
// re-parse a real target performs (r7x2 §1b). No host is contacted.
//
// The stubs are POSIX sh, never node, so NODE_TEST_CONTEXT cannot reach a node child
// through them; every spawn this file makes DIRECTLY passes an env without it.
//
// Tag: [WEBCTL::CDP]

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  shQuote, SSH_BASE_OPTS, createSshTransport, targetFacts,
} from '../lib/target-transport.js';
import { targetTransport } from '../lib/index.js';

const ALIAS = 'browserhost';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-transport-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

/**
 * Write an executable stub script and return its path.
 * @param {string} name
 * @param {string} body  sh source after the shebang
 */
function stub(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

// Runs its LAST argument through `sh -c` — a fake ssh whose "target" is this machine.
const REMOTE = stub('fake-ssh-remote', 'for last; do :; done\nexec sh -c "$last"');

// The argv whose elements must each arrive as ONE literal argument.
/** @param {string} marker */
const hostileValues = (marker) => ["it's", 'a;b', `$(touch ${marker})`, 'two words', 'line\nbreak'];
/** printf '[%s]\n' brackets every argument, so a split or a merge is visible. */
/** @param {string[]} vals */
const bracketed = (vals) => vals.map((v) => `[${v}]\n`).join('');

test('exported from lib/index.js as targetTransport', () => {
  assert.equal(targetTransport.createSshTransport, createSshTransport);
  assert.equal(targetTransport.targetFacts, targetFacts);
});

test('shQuote: always single-quoted, quote written as \'\\\'\'', () => {
  assert.equal(shQuote('plain'), "'plain'");
  assert.equal(shQuote(''), "''");
  assert.equal(shQuote("it's"), "'it'\\''s'");
  assert.equal(shQuote(42), "'42'");
  assert.throws(() => shQuote('a\0b'), /NUL/);
});

test('§6.1 QUOTING: each hostile value reaches the target as ONE literal argument, nothing runs', async () => {
  const marker = path.join(dir, 'pwned-quoted');
  const vals = hostileValues(marker);
  const t = createSshTransport({ ssh: ALIAS, sshBin: REMOTE });
  const r = await t.run(['printf', '[%s]\n', ...vals]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, bracketed(vals));
  assert.equal(fs.existsSync(marker), false, '$(…) must stay literal, never execute');
});

test('§6.1 CONTROL: the same values joined WITHOUT quoting do not survive the remote shell', () => {
  const marker = path.join(dir, 'pwned-naive');
  const vals = hostileValues(marker);
  const argv = ['printf', '[%s]\n', ...vals];
  // Same stub, same options — the ONLY difference is the missing shQuote.
  const naive = spawnSync(REMOTE, [...SSH_BASE_OPTS, '--', ALIAS, argv.join(' ')],
    { env: childEnv, encoding: 'utf8' });
  assert.notEqual(naive.stdout, bracketed(vals), 'an unquoted join must not reproduce the argv');

  // Without the unbalanced quote the line parses — and then `;` splits and $(…) RUNS.
  const parseable = vals.filter((v) => !v.includes("'"));
  const naive2 = spawnSync(REMOTE,
    [...SSH_BASE_OPTS, '--', ALIAS, ['printf', '[%s]\n', ...parseable].join(' ')],
    { env: childEnv, encoding: 'utf8' });
  assert.notEqual(naive2.stdout, bracketed(parseable));
  assert.equal(fs.existsSync(marker), true, 'control: unquoted $(…) executes on the target');
});

test('§6.2 OPTIONS: recording stub shows the exact argv — no agent, no sharing, never prompts', async () => {
  const rec = path.join(dir, 'argv.rec');
  const recorder = stub('fake-ssh-record', `printf '%s\\0' "$@" > '${rec}'`);
  const t = createSshTransport({ ssh: ALIAS, sshBin: recorder });
  const r = await t.run(['true']);
  assert.equal(r.code, 0, r.stderr);
  const got = fs.readFileSync(rec, 'utf8').split('\0').slice(0, -1);
  assert.deepEqual(got, t.argvFor(['true']));
  assert.deepEqual(got, [...SSH_BASE_OPTS, '--', ALIAS, "'true'"]);
  for (const opt of ['BatchMode=yes', 'ControlMaster=no', 'ForwardAgent=no']) {
    const i = got.indexOf(opt);
    assert.ok(i > 0 && got[i - 1] === '-o', `${opt} passed as -o ${opt}`);
  }
  assert.equal(got[got.indexOf(ALIAS) - 1], '--', '`--` immediately precedes the alias');
  assert.ok(Object.isFrozen(SSH_BASE_OPTS));
});

test('refusals: dash-led alias, NUL in argv, empty or non-string argv', () => {
  assert.throws(() => createSshTransport({ ssh: '-oProxyCommand=x' }), (e) => {
    assert.match(String(e), /never starting with "-"/);
    assert.doesNotMatch(String(e), /ProxyCommand/, 'the rejected value is never echoed');
    return true;
  });
  assert.throws(() => createSshTransport({ ssh: /** @type {any} */ (undefined) }), /ssh alias/);
  const t = createSshTransport({ ssh: ALIAS, sshBin: REMOTE });
  assert.throws(() => t.argvFor(['echo', 'a\0b']), /NUL/);
  assert.throws(() => t.argvFor([]), /non-empty array/);
  assert.throws(() => t.argvFor(/** @type {any} */ (['echo', 3])), /non-empty array/);
  assert.throws(() => t.argvFor(/** @type {any} */ ('echo hi')), /non-empty array/);
  // Control: a well-formed alias and argv are accepted.
  assert.equal(t.argvFor(['echo']).at(-1), "'echo'");
});

test('input reaches the remote command on stdin; without input stdin is closed', async () => {
  const t = createSshTransport({ ssh: ALIAS, sshBin: REMOTE });
  const payload = "a;b $(nope) 'q'\n";
  const r = await t.run(['cat'], { input: payload });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, payload);
  // Control: no input → cat sees EOF at once (it would hang on an open stdin).
  const r2 = await t.run(['cat'], { timeoutMs: 5000 });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.stdout, '');
});

test('TIMEOUT: a hung ssh resolves non-zero, promptly, with the timeout note', async () => {
  const sleeper = stub('fake-ssh-sleep', 'exec sleep 30');
  const t = createSshTransport({ ssh: ALIAS, sshBin: sleeper });
  const t0 = Date.now();
  const r = await t.run(['true'], { timeoutMs: 300 });
  const ms = Date.now() - t0;
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /timed out after 300 ms/);
  assert.ok(ms < 3000, `resolved in ${ms} ms`);
  // Control: a quick command under the same timeout is NOT reported as timed out.
  const ok = await createSshTransport({ ssh: ALIAS, sshBin: REMOTE }).run(['true'], { timeoutMs: 5000 });
  assert.equal(ok.code, 0);
  assert.doesNotMatch(ok.stderr, /timed out/);
});

test('spawn error → code 127', async () => {
  const t = createSshTransport({ ssh: ALIAS, sshBin: path.join(dir, 'no-such-ssh') });
  const r = await t.run(['true']);
  assert.equal(r.code, 127);
});

/**
 * A fake transport answering with a fixed result; records each call's argv.
 * @param {{code: number, stdout: string, stderr?: string}} res
 */
function fakeTransport(res) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    /** @param {string[]} argv */
    run: async (argv) => { calls.push(argv); return { stderr: '', ...res }; },
  };
}

test('§6.4 targetFacts: a good answer → numbers, in ONE call (control)', async () => {
  const f = fakeTransport({ code: 0, stdout: '/srv/browser\n1000\n1001\n' });
  assert.deepEqual(await targetFacts(f), { ok: true, home: '/srv/browser', uid: 1000, gid: 1001 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'sh');
});

test('§6.4 targetFacts: end to end through the stub — $HOME and id expand on the TARGET side', async () => {
  const facts = await targetFacts(createSshTransport({ ssh: ALIAS, sshBin: REMOTE }));
  assert.equal(facts.ok, true, JSON.stringify(facts));
  if (!facts.ok) return;
  assert.equal(facts.home, process.env.HOME);
  assert.equal(facts.uid, process.getuid?.());
  assert.equal(facts.gid, process.getgid?.());
});

test('§6.4 targetFacts refuses a malformed answer, naming the field — never defaults', async () => {
  /** @type {Array<[string, {code: number, stdout: string}, RegExp]>} */
  const cases = [
    ['relative home', { code: 0, stdout: 'srv/browser\n1000\n1000\n' }, /home/],
    ['empty home', { code: 0, stdout: '\n1000\n1000\n' }, /home/],
    ['non-numeric uid', { code: 0, stdout: '/srv/browser\nroot\n1000\n' }, /uid/],
    ['negative uid', { code: 0, stdout: '/srv/browser\n-1\n1000\n' }, /uid/],
    ['non-numeric gid', { code: 0, stdout: '/srv/browser\n1000\n10a\n' }, /gid/],
    ['missing gid line', { code: 0, stdout: '/srv/browser\n1000\n' }, /gid/],
    ['missing uid+gid', { code: 0, stdout: '/srv/browser\n' }, /uid/],
    ['no output', { code: 0, stdout: '' }, /home/],
    ['extra output', { code: 0, stdout: '/srv/browser\n1000\n1000\nmotd\n' }, /unexpected output/],
    ['non-zero exit', { code: 255, stdout: '/srv/browser\n1000\n1000\n' }, /code 255/],
  ];
  for (const [label, res, re] of cases) {
    const got = await targetFacts(fakeTransport(res));
    assert.equal(got.ok, false, label);
    if (got.ok) continue;
    assert.match(got.error, re, label);
    assert.equal(/** @type {any} */ (got).uid, undefined, `${label}: no defaulted uid`);
  }
});
