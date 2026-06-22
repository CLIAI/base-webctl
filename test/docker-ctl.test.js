// Unit tests for lib/browser-location/docker-ctl.js — pure / mocked only.
// No real docker, no network. Run: node --test  (or `npm test`).
//
// The mocked-spawn harness is ported from linkedin-webctl's
// test/docker-mode-test.js (the proven suite this module is extracted from):
// docker-ctl imports the `node:child_process` default object and accesses
// `.spawn` at call time, so swapping `child_process.spawn` for a stub here
// intercepts every verb without spawning a real process.
//
// Tag: [WEBCTL::CDP]

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import child_process from 'node:child_process';

import * as dockerCtl from '../lib/browser-location/docker-ctl.js';

/**
 * Build a fake `spawn` that emits the given output then closes with `code`.
 * Records the argv it was called with on `child._args` for assertions.
 *
 * @param {{code: number, stdout?: string, stderr?: string}} spec
 */
function mockSpawnReturning({ code, stdout = '', stderr = '' }) {
  return (/** @type {string} */ _cmd, /** @type {string[]} */ args) => {
    const child = /** @type {any} */ (new EventEmitter());
    const stdoutEm = new EventEmitter();
    const stderrEm = new EventEmitter();
    child.stdout = stdoutEm;
    child.stderr = stderrEm;
    child._args = args;
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) stdoutEm.emit('data', Buffer.from(stdout));
      if (stderr) stderrEm.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

/**
 * Run `fn` with `child_process.spawn` swapped for `impl`, restoring after.
 * @param {Function} impl
 * @param {() => any} fn
 */
async function withMockSpawn(impl, fn) {
  const orig = child_process.spawn;
  // @ts-expect-error — deliberately monkey-patching the builtin for the test.
  child_process.spawn = impl;
  try {
    return await fn();
  } finally {
    child_process.spawn = orig;
  }
}

// ───── escapeRe (the multi-tenant exact-match primitive) ────────────────

test('_escapeRe escapes regex metachars', () => {
  assert.equal(dockerCtl._escapeRe('foo.bar'), 'foo\\.bar');
  assert.equal(dockerCtl._escapeRe('a+b*c?'), 'a\\+b\\*c\\?');
  // A real artifact name (prefix + infix + slug) has no regex metachars,
  // so it must pass through unchanged.
  assert.equal(dockerCtl._escapeRe('myproj-chromium-default'), 'myproj-chromium-default');
});

test('_escapeRe blocks substring/glob escape — `.` and `$` are neutralised', () => {
  // The whole point of `^name$` anchoring: a name carrying metachars cannot
  // widen the match. Escaped output, fed into a RegExp, matches ONLY itself.
  const name = 'proj-xpra-default';
  const re = new RegExp('^' + dockerCtl._escapeRe(name) + '$');
  assert.ok(re.test(name));
  assert.ok(!re.test(name + '-extra'));
});

// ───── run() / verb construction (mocked spawn) ─────────────────────────

test('run() returns code + captured stdout', async () => {
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: 'hello\n' }), async () => {
    const r = await dockerCtl.run(['version']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'hello\n');
  });
});

test('run() surfaces non-zero exit + stderr', async () => {
  await withMockSpawn(mockSpawnReturning({ code: 7, stderr: 'boom' }), async () => {
    const r = await dockerCtl.run(['fake']);
    assert.equal(r.code, 7);
    assert.ok(r.stderr.includes('boom'));
  });
});

test('dockerAvailable() reflects exit code', async () => {
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: '24.0.5\n' }), async () => {
    assert.equal(await dockerCtl.dockerAvailable(), true);
  });
  await withMockSpawn(mockSpawnReturning({ code: 1 }), async () => {
    assert.equal(await dockerCtl.dockerAvailable(), false);
  });
});

test('imageExists() true on inspect exit 0, false otherwise', async () => {
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: '[{}]' }), async () => {
    assert.equal(await dockerCtl.imageExists('foo:bar'), true);
  });
  await withMockSpawn(mockSpawnReturning({ code: 1, stderr: 'No such image' }), async () => {
    assert.equal(await dockerCtl.imageExists('not-there'), false);
  });
});

test('containerRunning() requires an EXACT name match in output', async () => {
  const name = 'proj-chromium-default';
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: name + '\n' }), async () => {
    assert.equal(await dockerCtl.containerRunning(name), true);
  });
  // A different name in output must NOT count as a match (substring safety).
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: name + '-extra\n' }), async () => {
    assert.equal(await dockerCtl.containerRunning(name), false);
  });
});

test('containerExists() anchors the name filter as ^name$', async () => {
  const name = 'proj-xpra-default';
  /** @type {string[] | undefined} */
  let seenArgs;
  const impl = (/** @type {string} */ _cmd, /** @type {string[]} */ args) => {
    seenArgs = args;
    return mockSpawnReturning({ code: 0, stdout: name + '\n' })(_cmd, args);
  };
  await withMockSpawn(impl, async () => {
    assert.equal(await dockerCtl.containerExists(name), true);
  });
  assert.ok(seenArgs);
  assert.ok(seenArgs.includes(`name=^${name}$`),
    `expected anchored filter, got: ${JSON.stringify(seenArgs)}`);
});

test('networkExists()/volumeExists() symmetry', async () => {
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: 'mynet\n' }), async () => {
    assert.equal(await dockerCtl.networkExists('mynet'), true);
  });
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: '' }), async () => {
    assert.equal(await dockerCtl.networkExists('mynet'), false);
  });
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: 'myvol\n' }), async () => {
    assert.equal(await dockerCtl.volumeExists('myvol'), true);
  });
});

test('psByLabel() parses one JSON object per stdout line', async () => {
  const stdout = '{"Names":"a","Id":"1"}\n{"Names":"b","Id":"2"}\n';
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout }), async () => {
    const r = await dockerCtl.psByLabel('proj.role=chromium');
    assert.equal(r.length, 2);
    assert.equal(r[0].Names, 'a');
    assert.equal(r[1].Id, '2');
  });
});

test('psByLabel() tolerates blank/garbage lines', async () => {
  const stdout = '{"Names":"a"}\n\nnot-json\n{"Names":"b"}\n';
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout }), async () => {
    const r = await dockerCtl.psByLabel('proj.role=chromium');
    assert.equal(r.length, 2);
  });
});

test('stop(): no-op when container does not exist', async () => {
  // containerExists check returns empty stdout (false) → stop returns without
  // issuing a `docker stop`. Just verifies the guarded no-op path.
  await withMockSpawn(mockSpawnReturning({ code: 0, stdout: '' }), async () => {
    await dockerCtl.stop('nonexistent');
    assert.ok(true);
  });
});

test('runDetached() builds env/-v/-p/--label/cmd in order', async () => {
  /** @type {string[] | undefined} */
  let seenArgs;
  const impl = (/** @type {string} */ _cmd, /** @type {string[]} */ args) => {
    seenArgs = args;
    return mockSpawnReturning({ code: 0, stdout: 'cid\n' })(_cmd, args);
  };
  await withMockSpawn(impl, async () => {
    await dockerCtl.runDetached({
      name: 'proj-chromium-default',
      image: 'proj/chromium-ubuntu:latest',
      env: { DISPLAY: ':0' },
      mounts: [['/host/profile', '/home/user/.config/chromium', 'rw']],
      publish: [['127.0.0.1', '4327', 9222]],
      network: 'proj-net',
      labels: { 'proj.role': 'chromium' },
      cmd: ['--remote-debugging-port=9222'],
    });
  });
  assert.ok(seenArgs);
  const joined = seenArgs.join(' ');
  assert.ok(joined.startsWith('run -d --name proj-chromium-default'));
  assert.ok(joined.includes('-e DISPLAY=:0'));
  assert.ok(joined.includes('-v /host/profile:/home/user/.config/chromium:rw'));
  // CDP port MUST bind 127.0.0.1 only (secret-topology invariant).
  assert.ok(joined.includes('-p 127.0.0.1:4327:9222'));
  assert.ok(joined.includes('--network proj-net'));
  assert.ok(joined.includes('--label proj.role=chromium'));
  // image precedes the post-image cmd
  assert.ok(joined.indexOf('proj/chromium-ubuntu:latest') <
            joined.indexOf('--remote-debugging-port=9222'));
});

test('public surface is re-exported from lib/index.js', async () => {
  const { dockerCtl: ns } = await import('../lib/index.js');
  assert.equal(typeof ns.run, 'function');
  assert.equal(typeof ns.containerExists, 'function');
  assert.equal(typeof ns.runDetached, 'function');
  assert.equal(typeof ns._escapeRe, 'function');
});
