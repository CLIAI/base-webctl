// Unit/integration tests for createXpraHtml5Gateway(C, opts) — GATEWAY P1
// (design: infra-xpra-remote-access-gateway-f6rd). P1 is the WS-aware reverse
// proxy + tailnet-iface bind + CIDR allowlist + enabled toggle. Hermetic: real
// fake upstreams (an HTTP server + a raw net server that completes a WS upgrade)
// stand in for the loopback xpra-html5, so the proxy path is proven end-to-end
// without docker/xpra/tailscale. No grant store / auth / CLI yet (P2-P4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { createXpraHtml5Gateway } from '../lib/browser-location/xpra-html5-gateway.js';

function fakeC(overrides = {}) {
  return {
    PROJECT: 'demo-webctl', ARTIFACT_PREFIX: 'demo-webctl-',
    IMAGE_CHROMIUM_REPO: 'demo-webctl/chromium', IMAGE_XPRA: 'demo-webctl/xpra-ubuntu:latest',
    DEFAULT_CDP_PORT: 4999, CACHE_DIRNAME: 'demo-webctl', ZOOM_DEFAULT_HOST: 'www.demo.example',
    CONFIG_FILE_PROJECT: 'demo-webctl.config.jsonc', DOTENV_FILENAME: '.env.demo-webctl',
    DOTENV_TEMPLATE: '.env.demo-webctl.example', ENV_PREFIX: 'CLIAI_DEMO_WEBCTL_',
    ENV_PREFIX_LEGACY: null, ENV_LEGACY_SUFFIXES: [], ...overrides,
  };
}

/** Spin a fake "xpra-html5" HTTP upstream on loopback; returns {port, close, hits}. */
function startHttpUpstream() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`UPSTREAM-OK ${req.url}`);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port, hits,
      close: () => new Promise(r => srv.close(r)),
      server: srv,
    }));
  });
}

/** Fake upstream that completes a WS-style upgrade + echoes one frame. */
function startWsUpstream() {
  let upgrades = 0;
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n') && /upgrade/i.test(buf) && upgrades === 0) {
        upgrades++;
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        sock.write('HELLO-FROM-UPSTREAM');
      } else if (buf.includes('PING')) {
        sock.write('PONG');
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port, get upgrades() { return upgrades; },
      close: () => new Promise(r => srv.close(r)), server: srv,
    }));
  });
}

function httpGet(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

// ── factory contract ───────────────────────────────────────────────────────

test('createXpraHtml5Gateway: validates C; surfaces the controller API', () => {
  assert.throws(() => createXpraHtml5Gateway(/** @type {any} */ ({}), { upstreamPort: 1, bindAddress: '127.0.0.1' }),
    /Invalid client-config constants/);
  const gw = createXpraHtml5Gateway(fakeC(), { upstreamPort: 1, bindAddress: '127.0.0.1' });
  for (const k of ['start', 'stop', 'setEnabled', 'isEnabled', 'isPeerAllowed', 'port']) {
    assert.equal(typeof gw[k], 'function', `expected ${k}`);
  }
  assert.equal(gw.isEnabled(), true, 'enabled by default once constructed');
});

// ── CIDR allowlist (pure) ───────────────────────────────────────────────────

test('isPeerAllowed: default tailscale CGNAT 100.64.0.0/10', () => {
  const gw = createXpraHtml5Gateway(fakeC(), { upstreamPort: 1, bindAddress: '127.0.0.1' });
  assert.equal(gw.isPeerAllowed('100.64.0.1'), true);
  assert.equal(gw.isPeerAllowed('100.100.50.4'), true);
  assert.equal(gw.isPeerAllowed('100.127.255.255'), true);
  assert.equal(gw.isPeerAllowed('100.128.0.1'), false, 'just outside /10');
  assert.equal(gw.isPeerAllowed('10.0.0.1'), false);
  assert.equal(gw.isPeerAllowed('192.168.1.5'), false);
  assert.equal(gw.isPeerAllowed('::ffff:100.64.1.2'), true, 'IPv6-mapped IPv4 normalized');
  assert.equal(gw.isPeerAllowed('fd7a:115c:a1e0::1'), false, 'IPv6 tailnet not matched by v4 CIDR (P1)');
});

test('isPeerAllowed: custom allowlist', () => {
  const gw = createXpraHtml5Gateway(fakeC(), { upstreamPort: 1, bindAddress: '127.0.0.1', cidrAllowlist: ['127.0.0.0/8', '10.1.0.0/16'] });
  assert.equal(gw.isPeerAllowed('127.0.0.1'), true);
  assert.equal(gw.isPeerAllowed('10.1.2.3'), true);
  assert.equal(gw.isPeerAllowed('10.2.0.1'), false);
  assert.equal(gw.isPeerAllowed('100.64.0.1'), false, 'default range not present in custom allowlist');
});

// ── HTTP reverse proxy ──────────────────────────────────────────────────────

test('HTTP proxy: forwards an allowed peer to the loopback upstream', async () => {
  const up = await startHttpUpstream();
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0,
    cidrAllowlist: ['127.0.0.0/8'],
  });
  const { port } = await gw.start();
  try {
    const r = await httpGet(port, '/index.html');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'UPSTREAM-OK /index.html');
    assert.deepEqual(up.hits.at(-1), { method: 'GET', url: '/index.html' });
  } finally {
    await gw.stop();
    await up.close();
  }
});

test('HTTP proxy: 403 for an off-tailnet peer (CIDR pre-check before proxy)', async () => {
  const up = await startHttpUpstream();
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0,
    cidrAllowlist: ['100.64.0.0/10'],
    peerOf: () => '8.8.8.8', // simulate a genuinely off-tailnet peer (test seam)
  });
  const { port } = await gw.start();
  try {
    const r = await httpGet(port, '/');
    assert.equal(r.status, 403);
    assert.match(r.body, /network not allowed/i);
    assert.equal(up.hits.length, 0, 'upstream never touched for a denied peer');
  } finally {
    await gw.stop();
    await up.close();
  }
});

test('localhost is always trusted (operator/CLI path) even when not in the CIDR allowlist', async () => {
  const up = await startHttpUpstream();
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0,
    cidrAllowlist: ['100.64.0.0/10'], // loopback NOT in here, but loopback is always trusted
  });
  const { port } = await gw.start();
  try {
    const r = await httpGet(port, '/');
    assert.equal(r.status, 200, 'loopback proxied (localhost-always-trusted)');
    assert.equal(r.body, 'UPSTREAM-OK /');
  } finally {
    await gw.stop();
    await up.close();
  }
});

test('HTTP proxy: 503 when disabled; session/upstream untouched; re-enable works', async () => {
  const up = await startHttpUpstream();
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0, cidrAllowlist: ['127.0.0.0/8'],
  });
  const { port } = await gw.start();
  try {
    gw.setEnabled(false);
    assert.equal(gw.isEnabled(), false);
    const r1 = await httpGet(port, '/');
    assert.equal(r1.status, 503);
    assert.match(r1.body, /disabled/i);
    assert.equal(up.hits.length, 0, 'disabled gateway never dials upstream');
    gw.setEnabled(true);
    const r2 = await httpGet(port, '/');
    assert.equal(r2.status, 200);
    assert.equal(up.hits.length, 1);
  } finally {
    await gw.stop();
    await up.close();
  }
});

// ── WS upgrade proxy + attach-without-restart ───────────────────────────────

test('WS upgrade: proxies the upgrade + bidirectional frames to upstream', async () => {
  const up = await startWsUpstream();
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0, cidrAllowlist: ['127.0.0.0/8'],
  });
  const { port } = await gw.start();
  try {
    const got = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('HELLO-FROM-UPSTREAM')) { sock.write('PING'); }
        if (buf.includes('PONG')) { sock.end(); resolve(buf); }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('ws timeout')), 3000);
    });
    assert.match(got, /101 Switching Protocols/);
    assert.match(got, /HELLO-FROM-UPSTREAM/);
    assert.match(got, /PONG/, 'bidirectional: our PING reached upstream, PONG came back');
    assert.equal(up.upgrades, 1);
  } finally {
    await gw.stop();
    await up.close();
  }
});

test('WS upgrade: denied peer / disabled gateway refuse without touching upstream', async () => {
  const up = await startWsUpstream();
  // disabled gateway
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0, cidrAllowlist: ['127.0.0.0/8'],
  });
  const { port } = await gw.start();
  try {
    gw.setEnabled(false);
    const resp = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => buf += d.toString('latin1'));
      sock.on('close', () => resolve(buf));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.match(resp, /503/, 'disabled -> 503 on upgrade');
    assert.equal(up.upgrades, 0, 'upstream never upgraded while disabled');
  } finally {
    await gw.stop();
    await up.close();
  }
});

test('attach-without-restart: toggling the gateway never restarts the upstream', async () => {
  const up = await startHttpUpstream();
  const gw1 = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0, cidrAllowlist: ['127.0.0.0/8'],
  });
  try {
    const { port: p1 } = await gw1.start();
    assert.equal((await httpGet(p1, '/a')).body, 'UPSTREAM-OK /a');
    await gw1.stop();                 // "disable hard" — drop the gateway listener
    assert.ok(up.server.listening, 'upstream session still alive after gateway stop');
    // bring a fresh gateway back up against the SAME untouched upstream
    const gw2 = createXpraHtml5Gateway(fakeC(), {
      upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0, cidrAllowlist: ['127.0.0.0/8'],
    });
    const { port: p2 } = await gw2.start();
    assert.equal((await httpGet(p2, '/b')).body, 'UPSTREAM-OK /b');
    await gw2.stop();
    assert.deepEqual(up.hits.map(h => h.url), ['/a', '/b'], 'same upstream served both eras; never restarted');
  } finally {
    await up.close();
  }
});

// ── bind address ────────────────────────────────────────────────────────────

test('start: binds the configured (tailnet) interface address', async () => {
  const up = await startHttpUpstream();
  const gw = createXpraHtml5Gateway(fakeC(), {
    upstreamPort: up.port, bindAddress: '127.0.0.1', listenPort: 0, cidrAllowlist: ['127.0.0.0/8'],
  });
  const info = await gw.start();
  try {
    assert.equal(info.host, '127.0.0.1');
    assert.equal(typeof info.port, 'number');
    assert.equal(gw.port(), info.port);
  } finally {
    await gw.stop();
    await up.close();
  }
});
