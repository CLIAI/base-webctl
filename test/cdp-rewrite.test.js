// Unit tests for lib/browser-location/cdp-rewrite.js — pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdp from '../lib/browser-location/cdp-rewrite.js';

test('rewriteWsUrl: replaces authority, preserves path', () => {
  assert.equal(
    cdp.rewriteWsUrl('ws://127.0.0.1:9222/devtools/browser/abc', '127.0.0.1', 4327),
    'ws://127.0.0.1:4327/devtools/browser/abc');
  assert.equal(
    cdp.rewriteWsUrl('wss://container:9222/x', 'host', '5000'),
    'wss://host:5000/x');
});

test('rewriteWsUrl: passes through non-ws and non-string', () => {
  assert.equal(cdp.rewriteWsUrl('http://x/y', 'h', 1), 'http://x/y');
  // @ts-expect-error — exercising the non-string guard
  assert.equal(cdp.rewriteWsUrl(null, 'h', 1), null);
});

test('rewriteVersionResponse: rewrites webSocketDebuggerUrl, no mutation', () => {
  const inp = { Browser: 'x', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/d/b' };
  const out = cdp.rewriteVersionResponse(inp, '127.0.0.1', 4327);
  assert.equal(out.webSocketDebuggerUrl, 'ws://127.0.0.1:4327/d/b');
  assert.equal(inp.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/d/b'); // unchanged
  assert.notEqual(out, inp);
});

test('rewriteTargetList: rewrites ws url + embedded ws= in frontend url', () => {
  const targets = [{
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/d/page/1',
    devtoolsFrontendUrl: '/devtools/inspector.html?ws=127.0.0.1:9222/d/page/1',
  }];
  const out = cdp.rewriteTargetList(targets, '10.0.0.5', 4327);
  assert.equal(out[0].webSocketDebuggerUrl, 'ws://10.0.0.5:4327/d/page/1');
  assert.ok(out[0].devtoolsFrontendUrl.includes('ws=10.0.0.5:4327'));
});

test('rewriteTargetList: passes through non-array', () => {
  // @ts-expect-error — exercising the non-array guard
  assert.equal(cdp.rewriteTargetList(null, 'h', 1), null);
});
