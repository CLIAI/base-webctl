// shared-config.test.js — the ONE loader for ~/.config/webctl/ (nl0c §1a).
// Every test builds a throwaway HOME; none reads or writes the operator's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSharedWebctlConfig, parseTomlSubset } from '../lib/shared-config.js';
import { resolveTarget } from '../lib/remotes.js';
import * as index from '../lib/index.js';

const RECORD = 'control = "ssh"\nssh = "browserhost"\napp = "chromium"\nkind = "docker-xpra"\n';

/** @param {Record<string, [string, number]>} files relative path -> [text, mode] */
function home(files) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-cfg-'));
  for (const [rel, [text, mode]] of Object.entries(files)) {
    const f = path.join(h, '.config', 'webctl', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, text, { mode });
    fs.chmodSync(f, mode);
  }
  return h;
}

/** Snapshot every path + mtime under a directory, to PROVE the loader wrote nothing. */
function snapshot(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(`${p}:${fs.statSync(p).mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

test('a declared default resolves through resolveTarget as the CONFIG layer — flag and env still win', () => {
  const h = home({ 'config.toml': ['default_target = "workstation"\n', 0o600],
                   'targets/workstation.toml': [RECORD, 0o600] });
  try {
    const c = loadSharedWebctlConfig({ home: h });
    assert.deepEqual(c.errors, []);
    assert.equal(c.defaultTarget, 'workstation');
    assert.equal(c.targets.workstation.kind, 'docker-xpra');
    assert.equal(c.targets.workstation.ssh, 'browserhost');
    const r = /** @type {any} */ (resolveTarget([c.configLayer]));
    assert.equal(r.verdict, 'resolved');
    assert.equal(r.source, 'config');
    assert.equal(r.value, 'workstation');
    const flagged = /** @type {any} */ (resolveTarget([{ source: 'flag', value: 'other' }, c.configLayer]));
    assert.equal(flagged.value, 'other', 'a stated flag wins over the shared default');
    assert.deepEqual(flagged.shadowed, ['config']);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('no ~/.config/webctl is an ordinary state — no default, no error, and NOTHING is created', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-cfg-empty-'));
  try {
    const before = snapshot(h);
    const c = loadSharedWebctlConfig({ home: h });
    assert.equal(c.present, false);
    assert.equal(c.defaultTarget, null);
    assert.equal(c.configLayer, null);
    assert.deepEqual(c.errors, []);
    assert.equal(snapshot(h), before, 'the loader must not create the directory');
    assert.equal(/** @type {any} */ (resolveTarget([c.configLayer].filter(Boolean))).code, 'no-target',
      'and then resolveTarget refuses, as it always has');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('the loader writes nothing even when the directory exists', () => {
  const h = home({ 'config.toml': ['default_target = "workstation"\n', 0o600],
                   'targets/workstation.toml': [RECORD, 0o600] });
  try {
    const before = snapshot(h);
    loadSharedWebctlConfig({ home: h });
    assert.equal(snapshot(h), before);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('⛔ a file wider than 600 is REFUSED, not read — control: the same file at 600 loads', () => {
  const h = home({ 'config.toml': ['default_target = "workstation"\n', 0o600],
                   'targets/workstation.toml': [RECORD, 0o644] });
  try {
    const c = loadSharedWebctlConfig({ home: h });
    assert.equal(c.targets.workstation, undefined);
    assert.ok(c.errors.some((e) => /workstation\.toml: mode 644/.test(e)), c.errors.join('\n'));
    assert.equal(c.defaultTarget, null, 'a default naming a refused record is no default');
    assert.ok(c.errors.some((e) => /default_target names no valid record/.test(e)));
    fs.chmodSync(path.join(h, '.config', 'webctl', 'targets', 'workstation.toml'), 0o600);
    assert.equal(loadSharedWebctlConfig({ home: h }).defaultTarget, 'workstation', 'control');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('⛔ a record failing validateTarget is refused, naming the key — never the value', () => {
  const h = home({ 'targets/bad.toml': ['control = "ssh"\nssh = "browserhost"\nuser_data_dir = "/secret/path"\n', 0o600] });
  try {
    const c = loadSharedWebctlConfig({ home: h });
    assert.equal(c.targets.bad, undefined);
    assert.ok(c.errors.some((e) => /bad\.toml: .*user_data_dir/.test(e)), c.errors.join('\n'));
    assert.ok(!c.errors.join('\n').includes('/secret/path'), 'the value is not echoed');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('config.toml: an unknown key and a non-string default are errors, never ignored', () => {
  const h = home({ 'config.toml': ['default_target = 5\ndefault_host = "x"\n', 0o600] });
  try {
    const c = loadSharedWebctlConfig({ home: h });
    assert.ok(c.errors.some((e) => /unknown key\(s\) default_host/.test(e)), c.errors.join('\n'));
    assert.ok(c.errors.some((e) => /default_target must be a non-empty string/.test(e)));
    assert.equal(c.defaultTarget, null);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('parseTomlSubset: the subset parses; anything outside it is REFUSED with a line number', () => {
  const ok = parseTomlSubset('# c\nname = "a # not a comment"\nn = 3\nb = true\nv = ["ssh", "tailscale-relay",]\n');
  assert.equal(ok.ok, true);
  assert.deepEqual(/** @type {any} */ (ok).values, { name: 'a # not a comment', n: 3, b: true, v: ['ssh', 'tailscale-relay'] });
  for (const [text, line] of [['[table]\n', 1], ['a = "x"\nb.c = 1\n', 2], ['a = """multi\n', 1],
                              ['a = {x = 1}\n', 1], ['a = "x"\na = "y"\n', 2], ['v = ["a,b"]\n', 1], ['x = 1.5\n', 1]]) {
    const r = parseTomlSubset(/** @type {string} */ (text));
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.match(/** @type {any} */ (r).error, new RegExp(`^line ${line}:`), JSON.stringify(text));
  }
});

test('the loader is reachable from lib/index.js as sharedConfig', () => {
  assert.equal(typeof index.sharedConfig.loadSharedWebctlConfig, 'function');
});
