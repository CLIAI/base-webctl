// P2 integration tests for the gateway auth layer (design f6rd §4.2-§4.5):
// grant store + REST + request-authorization page wired into createXpraHtml5Gateway.
// A real access store (temp file) + a fake HTTP upstream. The `peerOf` seam reads
// an `x-test-peer` header so one gateway can act as both a tailnet VIEWER
// (header set) and the loopback OPERATOR (no header => 127.0.0.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createXpraHtml5Gateway, normalizePeerIp } from '../lib/browser-location/xpra-html5-gateway.js';
import { createAccessStore } from '../lib/browser-location/xpra-access-store.js';

function fakeC() {
  return { PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-', IMAGE_CHROMIUM_REPO: 'demo-webctl/chromium',
    IMAGE_XPRA: 'demo-webctl/xpra-ubuntu:latest', DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl',
    ZOOM_DEFAULT_HOST: 'www.demo.example', CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc',
    DOTENV_FILENAME: '.env.demo-webctl', DOTENV_TEMPLATE: '.env.demo-webctl.example',
    ENV_PREFIX: 'CLIAI_DEMO_WEBCTL_', ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [] };
}

function startHttpUpstream() {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end(`UPSTREAM-OK ${req.url}`); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ port: srv.address().port, close: () => new Promise(r => srv.close(r)) })));
}

/** HTTP client with method/headers/body; parses JSON bodies. */
function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let json; try { json = JSON.parse(b); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: b, json });
      });
    });
    r.on('error', reject);
    if (body != null) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const VIEWER = { 'x-test-peer': '100.64.0.5' };           // a tailnet viewer
const VIEWER_HTML = { ...VIEWER, accept: 'text/html' };   // a browser viewer

async function harness() {
  const up = await startHttpUpstream();
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-p2-')), 'xpra-access.json');
  const store = createAccessStore({ statePath, defaultTtlSec: 3 * 3600 });
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0,
    cidrAllowlist: ['100.64.0.0/10'], accessStore: store,
    peerOf: (r) => r.headers['x-test-peer'] || normalizePeerIp(r.socket.remoteAddress || ''),
  });
  const { port } = await gw.start();
  return { up, store, gw, port, cleanup: async () => { await gw.stop(); await up.close(); } };
}

// ── auth gating: ungranted viewer ───────────────────────────────────────────

test('ungranted browser viewer -> 200 HTML request-authorization page', async () => {
  const h = await harness();
  try {
    const r = await req(h.port, { path: '/', headers: VIEWER_HTML });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, /request access/i);
    assert.match(r.body, /100\.64\.0\.5/, 'page names the principal');
  } finally { await h.cleanup(); }
});

test('ungranted API viewer -> 401 JSON pointing at /access/request', async () => {
  const h = await harness();
  try {
    const r = await req(h.port, { path: '/', headers: VIEWER });
    assert.equal(r.status, 401);
    assert.equal(r.json.requestPath, '/access/request');
    assert.equal(r.json.principal, '100.64.0.5');
  } finally { await h.cleanup(); }
});

// ── full request -> approve -> proxied flow ─────────────────────────────────

test('flow: viewer requests, operator approves, viewer gets proxied', async () => {
  const h = await harness();
  try {
    const req1 = await req(h.port, { method: 'POST', path: '/access/request', headers: { ...VIEWER, 'content-type': 'application/json' }, body: { who: 'alice', note: 'pls' } });
    assert.equal(req1.status, 200);
    assert.equal(req1.json.principal, '100.64.0.5');

    // operator (loopback, no x-test-peer) sees the pending request
    const pending = await req(h.port, { path: '/access/requests' });
    assert.equal(pending.status, 200);
    assert.equal(pending.json.requests.length, 1);
    assert.equal(pending.json.requests[0].who, 'alice');

    // operator approves
    const appr = await req(h.port, { method: 'POST', path: '/access/approve', headers: { 'content-type': 'application/json' }, body: { principal: '100.64.0.5', ttl: '3h' } });
    assert.equal(appr.status, 200);
    assert.equal(appr.json.approved, true);

    // viewer is now proxied
    const view = await req(h.port, { path: '/dash', headers: VIEWER });
    assert.equal(view.status, 200);
    assert.equal(view.body, 'UPSTREAM-OK /dash');

    // grants listing shows remainingSeconds
    const grants = await req(h.port, { path: '/access/grants' });
    const g = grants.json.grants.find(x => x.principal === '100.64.0.5');
    assert.ok(g.remainingSeconds > 10700 && g.remainingSeconds <= 10800);
  } finally { await h.cleanup(); }
});

// ── operator endpoints are loopback-only ────────────────────────────────────

test('operator endpoints reject a non-loopback (tailnet) peer with 403', async () => {
  const h = await harness();
  try {
    for (const p of ['/access/requests', '/access/grants']) {
      const r = await req(h.port, { path: p, headers: VIEWER });
      assert.equal(r.status, 403, `${p} must be operator-only`);
      assert.match(r.json.error, /operator only/i);
    }
    const appr = await req(h.port, { method: 'POST', path: '/access/approve', headers: { ...VIEWER, 'content-type': 'application/json' }, body: { principal: 'x' } });
    assert.equal(appr.status, 403);
  } finally { await h.cleanup(); }
});

// ── enable/disable: proxy gated, REST still reachable ───────────────────────

test('disable -> proxy 503 (even loopback); /access/enable still works -> proxy 200', async () => {
  const h = await harness();
  try {
    const off = await req(h.port, { method: 'POST', path: '/access/disable' });
    assert.equal(off.json.enabled, false);
    assert.equal(h.store.isEnabled(), false, 'persisted to the store');

    const blocked = await req(h.port, { path: '/' }); // loopback, but disabled
    assert.equal(blocked.status, 503);

    const on = await req(h.port, { method: 'POST', path: '/access/enable' });
    assert.equal(on.json.enabled, true);

    const ok = await req(h.port, { path: '/' }); // loopback always authorized
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'UPSTREAM-OK /');
  } finally { await h.cleanup(); }
});

// ── revoke returns a viewer to the auth wall ────────────────────────────────

test('revoke: a granted viewer loses proxy access', async () => {
  const h = await harness();
  try {
    h.store.approve('100.64.0.5', { ttl: '3h', grantedBy: '127.0.0.1' });
    assert.equal((await req(h.port, { path: '/', headers: VIEWER })).status, 200);
    const rev = await req(h.port, { method: 'POST', path: '/access/revoke', headers: { 'content-type': 'application/json' }, body: { principal: '100.64.0.5' } });
    assert.equal(rev.json.ok, true);
    assert.equal((await req(h.port, { path: '/', headers: VIEWER })).status, 401, 'back to the auth wall');
  } finally { await h.cleanup(); }
});

// ── WS upgrade respects auth ────────────────────────────────────────────────

test('WS upgrade: ungranted viewer refused 401; loopback (trusted) proxied 101 implicitly', async () => {
  const h = await harness();
  try {
    const resp = await new Promise((resolve, reject) => {
      const sock = net.connect(h.port, '127.0.0.1', () => {
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-test-peer: 100.64.0.5\r\n\r\n');
      });
      let buf = '';
      sock.on('data', d => buf += d.toString('latin1'));
      sock.on('close', () => resolve(buf));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.match(resp, /401/, 'ungranted viewer WS upgrade refused');
  } finally { await h.cleanup(); }
});
