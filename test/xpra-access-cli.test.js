// P3 tests for createXpraAccessCli(C, opts) — the operator CLI over the loopback
// gateway REST. Run against a REAL in-process gateway+store so CLI -> REST ->
// store is proven end-to-end. Output captured via injected out/err.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createXpraAccessCli } from '../lib/browser-location/xpra-access-cli.js';
import { createXpraHtml5Gateway } from '../lib/browser-location/xpra-html5-gateway.js';
import { createAccessStore } from '../lib/browser-location/xpra-access-store.js';

function fakeC() {
  return { PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-', IMAGE_CHROMIUM_REPO: 'demo-webctl/chromium',
    IMAGE_XPRA: 'demo-webctl/xpra-ubuntu:latest', DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'www.demo.example', CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc',
    DOTENV_FILENAME: '.env.demo-webctl', DOTENV_TEMPLATE: '.env.demo-webctl.example',
    ENV_PREFIX: 'CLIAI_DEMO_WEBCTL_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [] };
}

async function harness() {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-p3-')), 'xpra-access.json');
  const store = createAccessStore({ statePath, defaultTtlSec: 3 * 3600 });
  // upstreamPort can be a dead port — P3 tests never hit the proxy path, only /access/*.
  const gw = createXpraHtml5Gateway(fakeC(), { upstreamPort: 1, bindAddress: '127.0.0.1', listenPort: 0, accessStore: store });
  const { port } = await gw.start();
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const cli = createXpraAccessCli(fakeC(), {
    endpoint: { host: '127.0.0.1', port }, out: (s) => out.push(s), err: (s) => err.push(s),
  });
  return { store, gw, port, out, err, cli, cleanup: () => gw.stop() };
}

const jsonOf = (lines) => JSON.parse(lines[lines.length - 1]);

test('verb defaults to xpra-access; status reflects the live gateway', async () => {
  const h = await harness();
  try {
    assert.equal(h.cli.verb, 'xpra-access');
    const rc = await h.cli.run(['status', '--json']);
    assert.equal(rc, 0);
    const j = jsonOf(h.out);
    assert.equal(j.type, 'xpra-access-cli');
    assert.equal(j.command, 'status');
    assert.equal(j.enabled, true);
    assert.deepEqual(j.grants, []);
    assert.deepEqual(j.requests, []);
  } finally { await h.cleanup(); }
});

test('grant: approves a principal via REST; store reflects it', async () => {
  const h = await harness();
  try {
    const rc = await h.cli.run(['grant', '--who', '100.64.0.5', '--ttl', '3h', '--json']);
    assert.equal(rc, 0);
    const j = jsonOf(h.out);
    assert.equal(j.command, 'grant');
    assert.equal(j.principal, '100.64.0.5');
    assert.equal(j.grant.ttl, '3h');
    assert.equal(h.store.isGranted('100.64.0.5'), true, 'store updated through the loopback REST');
  } finally { await h.cleanup(); }
});

test('grant default ttl 3h when --ttl omitted', async () => {
  const h = await harness();
  try {
    await h.cli.run(['grant', '--who', '100.64.0.9', '--json']);
    assert.equal(jsonOf(h.out).grant.ttl, '3h');
  } finally { await h.cleanup(); }
});

test('requests: lists pending; revoke ends a grant', async () => {
  const h = await harness();
  try {
    h.store.addRequest('100.64.0.7', { who: 'bob', note: 'hi' });
    await h.cli.run(['requests', '--json']);
    const reqs = jsonOf(h.out).requests;
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].who, 'bob');

    h.store.approve('100.64.0.7', { ttl: '3h', grantedBy: '127.0.0.1' });
    assert.equal(h.store.isGranted('100.64.0.7'), true);
    const rc = await h.cli.run(['revoke', '--who', '100.64.0.7', '--json']);
    assert.equal(rc, 0);
    assert.equal(h.store.isGranted('100.64.0.7'), false);
  } finally { await h.cleanup(); }
});

test('enable/disable toggle persists in the store', async () => {
  const h = await harness();
  try {
    await h.cli.run(['disable', '--json']);
    assert.equal(jsonOf(h.out).enabled, false);
    assert.equal(h.store.isEnabled(), false);
    await h.cli.run(['enable', '--json']);
    assert.equal(jsonOf(h.out).enabled, true);
    assert.equal(h.store.isEnabled(), true);
  } finally { await h.cleanup(); }
});

test('human (non-json) output is readable', async () => {
  const h = await harness();
  try {
    await h.cli.run(['grant', '--who', '100.64.0.5', '--ttl', '1h']);
    assert.match(h.out.join(''), /granted 100\.64\.0\.5/);
    h.out.length = 0;
    await h.cli.run(['status']);
    assert.match(h.out.join(''), /enabled=true/);
    assert.match(h.out.join(''), /100\.64\.0\.5/);
  } finally { await h.cleanup(); }
});

// ── error paths ─────────────────────────────────────────────────────────────

test('usage errors: unknown subcommand + missing --who -> exit 64', async () => {
  const h = await harness();
  try {
    assert.equal(await h.cli.run(['bogus']), 64);
    assert.equal(await h.cli.run(['grant']), 64, 'grant without --who');
    assert.equal(await h.cli.run([]), 64, 'no subcommand');
    assert.match(h.err.join(''), /usage:/);
  } finally { await h.cleanup(); }
});

test('gateway unreachable -> exit 3', async () => {
  // point the CLI at a port with nothing listening
  const cli = createXpraAccessCli(fakeC(), { endpoint: { host: '127.0.0.1', port: 1 }, out: () => {}, err: () => {} });
  const rc = await cli.run(['status', '--json']);
  assert.equal(rc, 3);
});
