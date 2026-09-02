// tests/url-marking.test.js — base-webctl
//
// These tests are written to FAIL on the specific regressions this module
// exists to prevent, not merely to exercise the happy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsUrls, extractUrls, scanForUrls, scanAllStringsUnsafe,
  buildUnverifiedUrlRecord, buildUnverifiedUrlMeta,
  unverifiedUrlHeader, noUnverifiedUrlsNote,
  classifyUnverifiedUrlRecord,
  UNVERIFIED_URL_SCHEMA_VERSION,
} from '../lib/url-marking.js';

test('containsUrls: flags every shape a reader could follow', () => {
  assert.equal(containsUrls('see https://example.com/x for detail'), true);
  assert.equal(containsUrls('http://example.com'), true);
  assert.equal(containsUrls('[click here](https://evil.example/accept?t=abc)'), true);
  assert.equal(containsUrls('```\ncurl https://example.com/a\n```'), true);
  assert.equal(containsUrls('visit www.example.com today'), true, 'bare www. is still clickable');
});

test('containsUrls: no false positives on prose or dotted identifiers', () => {
  assert.equal(containsUrls('no links here, just prose about B_i and S_i'), false);
  // A filename LOOKS like a host and is not one. Named because the obvious
  // "anything with a dot" heuristic would break exactly here.
  assert.equal(containsUrls('the file is notice_buffer_model.py'), false);
  assert.equal(containsUrls(''), false);
  assert.equal(containsUrls(null), false);
  assert.equal(containsUrls(undefined), false);
});

test('extractUrls: dedupes, preserves order, drops trailing sentence punctuation', () => {
  assert.deepEqual(
    extractUrls('a https://one.example/x then https://two.example/y then https://one.example/x'),
    ['https://one.example/x', 'https://two.example/y']);
  assert.deepEqual(extractUrls('go to https://example.com/page.'), ['https://example.com/page']);
  assert.deepEqual(extractUrls('[x](https://example.com/a)'), ['https://example.com/a']);
  assert.deepEqual(extractUrls('nothing'), []);
});

test('scanForUrls: walks nested shapes and survives cycles', () => {
  const turns = [{ role: 'user', text: 'hi' },
                 { role: 'assistant', text: 'try https://evil.example/accept?t=1' }];
  assert.deepEqual(scanForUrls(turns, { fields: ['text'] }), ['https://evil.example/accept?t=1']);
  const cyclic = { text: 'see www.example.com' };
  cyclic.self = cyclic;                       // would hang without the seen-set
  assert.deepEqual(scanForUrls(cyclic, { fields: ['text'] }), ['www.example.com']);
});

test('scanForUrls REFUSES to guess which fields are counterparty-authored', () => {
  // No default, because every plausible default is wrong for someone and wrong
  // SILENTLY. An earlier draft defaulted to a blind Object.values() walk.
  assert.throws(() => scanForUrls({ text: 'https://a.example' }), /fields.*required/i);
  assert.throws(() => scanForUrls({ text: 'x' }, {}), /fields.*required/i);
});

test('field selection: a first-party asset URL is NOT a counterparty URL', () => {
  // Reproduced live in chatgpt-webctl before this rewrite: an assistant turn
  // with no links in its prose was flagged, because output.js puts msg.images
  // (ChatGPT-hosted, first-party) on the line it scans.
  const turn = [{ role: 'assistant', text: 'hi no links',
                  images: [{ src: 'https://files.oaiusercontent.com/file-abc' }] }];
  assert.deepEqual(scanForUrls(turn, { fields: ['text'] }), [],
    'prose has no links; the tool\'s own asset URL must not be reported');
  // ...and the escape hatch still sees it, which is why it is named honestly.
  assert.deepEqual(scanAllStringsUnsafe(turn), ['https://files.oaiusercontent.com/file-abc']);
});

test('field selection accepts a predicate, and descends through unselected keys', () => {
  const doc = { meta: { canonicalUrl: 'https://firstparty.example/post/1' },
                body: { text: 'reply at https://evil.example/accept?t=1' } };
  // `meta`/`body` are not selected but must still be DESCENDED INTO, or nothing
  // nested would ever be found.
  assert.deepEqual(scanForUrls(doc, { fields: k => k === 'text' }),
    ['https://evil.example/accept?t=1']);
  assert.deepEqual(scanForUrls(doc, { fields: ['canonicalUrl'] }),
    ['https://firstparty.example/post/1']);
});

test('a glued URL is still detected — the false NEGATIVE direction is the fatal one', () => {
  // The leading \b used to kill this. DOM textContent concatenation runs
  // adjacent elements together with no separator, so this is the single most
  // likely way a URL actually reaches us. A false negative causes the accept;
  // a false positive only adds a header.
  assert.deepEqual(extractUrls('xhttps://a.com/p'), ['https://a.com/p']);
  assert.deepEqual(extractUrls('Reply now!https://evil.example/accept?t=1'),
    ['https://evil.example/accept?t=1']);
  // ...without opening a new false-positive class: bare `www.` still needs a
  // word boundary, or every "...www." inside a word would match.
  assert.deepEqual(extractUrls('shwww.example.com'), []);
});

test('record is emitted UNCONDITIONALLY with a constant shape', () => {
  const withUrls = buildUnverifiedUrlRecord('go to https://evil.example/x', { fields: [] });
  const without = buildUnverifiedUrlRecord('nothing to see', { fields: [] });
  assert.deepEqual(Object.keys(withUrls).sort(), Object.keys(without).sort(),
    'the empty case must not be a different shape — a consumer handles one shape');
  assert.equal(withUrls.containsUnverifiedUrls, true);
  assert.equal(without.containsUnverifiedUrls, false);
  assert.deepEqual(without.unverifiedUrls, []);
});

test('schemaVersion rides on BOTH projections', () => {
  // The regression being pinned: chatgpt-webctl's cache projection carried the
  // boolean and the array but NOT the version, so "presence proves the check
  // ran" held for exports and silently did not hold for caches.
  assert.equal(buildUnverifiedUrlRecord('x', { fields: [] }).schemaVersion, UNVERIFIED_URL_SCHEMA_VERSION);
  assert.equal(buildUnverifiedUrlMeta('x', { fields: [] }).unverified_urls_schema_version,
    UNVERIFIED_URL_SCHEMA_VERSION);
});

test('the two projections carry the SAME FIELD SET, modulo casing', () => {
  // The root-cause pin, not the instance fix. chatgpt's two records drifted
  // because they were two independent constructions of the same truth, and two
  // independent constructions of the same truth always drift. This asserts they
  // stay one source with two views, so the asymmetry cannot recur.
  const value = 'go to https://evil.example/x';
  const snake = k => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
  const wire = buildUnverifiedUrlRecord(value, { fields: ['x'] });
  const meta = buildUnverifiedUrlMeta(value, { fields: ['x'] });
  const wireFields = Object.keys(wire).filter(k => k !== 'type' && k !== 'note').sort();
  const expected = wireFields.map(k => k === 'schemaVersion'
    ? 'unverified_urls_schema_version'      // namespaced on disk, where keys are flat
    : snake(k)).sort();
  assert.deepEqual(Object.keys(meta).sort(), expected);
  assert.equal(meta.contains_unverified_urls, wire.containsUnverifiedUrls);
  assert.deepEqual(meta.unverified_urls, wire.unverifiedUrls);
  assert.equal(meta.unverified_urls_schema_version, wire.schemaVersion);
});

test('ABSENT schemaVersion reads as UNKNOWN, never as "no URLs"', () => {
  // The invariant the module exists for, asserted in base so no consumer can
  // implement the permissive reading by accident. The two are OPPOSITE
  // instructions: "checked, found none" permits acting; "written by a tool that
  // could not check" does not. Collapsing them fails OPEN. Every artifact
  // predating this module is in that state, so it is the common case.
  const legacy = { contains_unverified_urls: false, unverified_urls: [] };
  assert.equal(classifyUnverifiedUrlRecord(legacy).status, 'unknown');
  assert.equal(classifyUnverifiedUrlRecord({}).status, 'unknown');
  assert.equal(classifyUnverifiedUrlRecord(null).status, 'unknown');
  assert.equal(classifyUnverifiedUrlRecord(undefined).status, 'unknown');

  // ...and a record that DID carry the version is classified on its flag.
  assert.equal(classifyUnverifiedUrlRecord(buildUnverifiedUrlRecord('nothing', { fields: [] })).status,
    'checked-none');
  assert.equal(classifyUnverifiedUrlRecord(buildUnverifiedUrlRecord('https://x.example', { fields: [] })).status,
    'urls-present');
  assert.equal(classifyUnverifiedUrlRecord(buildUnverifiedUrlMeta('https://x.example', { fields: [] })).status,
    'urls-present', 'the on-disk projection must classify identically');

  // safeToFollow is never true — the artifact does not get to sanction the fetch.
  for (const r of [legacy, buildUnverifiedUrlRecord('nothing', { fields: [] }), buildUnverifiedUrlRecord('https://x.example', { fields: [] })]) {
    assert.equal(classifyUnverifiedUrlRecord(r).safeToFollow, false);
  }
});

test('the two casings stay distinct — a "tidy" into one is a cache migration', () => {
  // The failure message carries the REASON, not just a red, because whoever
  // trips this test is by definition someone who thought unifying was tidier.
  const WHY = [
    'DO NOT unify these casings. camelCase on the wire, snake_case on disk is',
    'deliberate. Renaming a persisted key is a CACHE MIGRATION, not a rename,',
    'and it FAILS OPEN: every artifact written before the change stops matching',
    'a reader looking for the new key and reads as "not marked" — which is',
    'indistinguishable from "checked, nothing found" and is the dangerous one.',
    'If you genuinely need symmetry, migrate the artifacts first.',
  ].join(' ');
  const meta = buildUnverifiedUrlMeta('go to https://evil.example/x', { fields: [] });
  assert.deepEqual(Object.keys(meta).sort(),
    ['contains_unverified_urls', 'unverified_urls', 'unverified_urls_schema_version'], WHY);
  assert.ok(!('containsUnverifiedUrls' in meta), WHY);
});

test('prose stays true in the empty case, and names the consumer noun', () => {
  const empty = buildUnverifiedUrlRecord('nothing', { fields: [], contentNoun: 'post body' });
  assert.equal(empty.note, noUnverifiedUrlsNote('post body'));
  assert.doesNotMatch(empty.note, /COUNTERPARTY/,
    'a no-URL artifact must not carry a warning about URLs it does not have');
  const full = buildUnverifiedUrlRecord('https://x.example', { fields: [], contentNoun: 'post body' });
  assert.equal(full.note, unverifiedUrlHeader('post body'));
});

test('the header states the rule and the reason, not just a caution', () => {
  const h = unverifiedUrlHeader();
  assert.match(h, /counterparty/i);
  assert.match(h, /do not fetch|never fetch/i);
  assert.match(h, /action, not a reference/i, 'the WHY is what makes an agent comply');
});

test('the motivating real-world case: an invite link inside captured content', () => {
  const body = 'Hi! Join here: https://app.example.com/invite/accept?token=abc123 — thanks!';
  assert.equal(containsUrls(body), true);
  assert.deepEqual(extractUrls(body), ['https://app.example.com/invite/accept?token=abc123']);
});
