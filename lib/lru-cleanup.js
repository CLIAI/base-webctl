// lib/lru-cleanup.js — Pure decision logic for LRU tab cleanup.
//
// Extracted from the runner for testability. NO CDP, NO fs. All functions are
// deterministic given their inputs.
//
// See docs/lru-tab-cleanup.design.md (in the consuming tool) for the full
// design + rationale, including the "untracked tab" question and the #50
// retrospective.
//
// Scope: [WEBCTL]  (was byte-identical across linkedin-webctl ↔ chatgpt-webctl;
// now shared once here per sb7q.)
//
// base-webctl ESM port: zero-dep, JSDoc-typed, no top-level await.

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {string} [url]
 * @property {string} [lastUsed]
 * @property {?string} [activityKey]
 *
 * @typedef {Record<string, {lastUsed?: string, url?: string}>} ActivityMap
 */

/**
 * Parse a duration string like "10m", "1h", "30s", "2d", "1.5h" into seconds.
 * Returns null on any parse failure (including empty/null/negative).
 *
 * Accepted suffixes: s (seconds), m (minutes), h (hours), d (days).
 * Whitespace between the number and the suffix is allowed.
 *
 * @param {string|null|undefined} str
 * @returns {number|null}
 */
export function parseDuration(str) {
  if (str === null || str === undefined) return null;
  if (typeof str !== 'string') return null;
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (!isFinite(val) || val < 0) return null;
  switch (m[2].toLowerCase()) {
    case 's': return val;
    case 'm': return val * 60;
    case 'h': return val * 3600;
    case 'd': return val * 86400;
    default: return null;
  }
}

/**
 * Parse --lru-thresholds spec into a sorted array of {seconds, maxTabs, label}.
 *
 * Format: "10m:15,30m:10,1h:5,4h:3,8h:2".
 * Each pair is <duration>:<maxTabs>. Sorted ascending by seconds.
 *
 * Malformed pairs are skipped (with an optional onWarn callback called for
 * each). Returns null if no valid pairs.
 *
 * @param {string|null|undefined} spec
 * @param {{onWarn?: (msg: string) => void}} [opts]
 * @returns {Array<{seconds: number, maxTabs: number, label: string}>|null}
 */
export function parseLruThresholds(spec, opts = {}) {
  if (!spec) return null;
  if (typeof spec !== 'string') return null;
  const onWarn = opts.onWarn || (() => {});
  const thresholds = [];
  for (const pair of spec.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) { onWarn(`Invalid LRU threshold pair: "${pair}" (expected format: "10m:5")`); continue; }
    const durStr = trimmed.slice(0, idx).trim();
    const maxStr = trimmed.slice(idx + 1).trim();
    const seconds = parseDuration(durStr);
    const maxTabs = parseInt(maxStr, 10);
    if (seconds === null || isNaN(maxTabs) || maxTabs < 0) {
      onWarn(`Invalid LRU threshold pair: "${pair}" (expected format: "10m:5")`);
      continue;
    }
    thresholds.push({ seconds, maxTabs, label: durStr });
  }
  thresholds.sort((a, b) => a.seconds - b.seconds);
  return thresholds.length > 0 ? thresholds : null;
}

/**
 * Extract the LRU activity key from a URL, given the view-target config and
 * a urlMeta function. Returns null if no key can be derived (untracked).
 *
 * Pure: no I/O, no globals.
 *
 *   extractActivityKey(url, VIEW_TARGET_CONFIG, urlMeta, classifyLinkedInUrl) → "post:abc"|null
 *
 * @param {string} url
 * @param {Record<string, {urlMetaKey: string}>} viewTargetConfig
 * @param {(url: string, viewType: string) => (Record<string, any>|null)} urlMetaFn
 * @param {(url: string) => (string|null)} classifyFn
 * @returns {string|null}
 */
export function extractActivityKey(url, viewTargetConfig, urlMetaFn, classifyFn) {
  if (!url || typeof url !== 'string') return null;
  const viewType = classifyFn(url);
  if (!viewType) return null;
  const config = viewTargetConfig[viewType];
  if (!config) return null;
  const meta = urlMetaFn(url, viewType);
  const targetId = meta ? meta[config.urlMetaKey] : null;
  if (!targetId) return null;
  return `${viewType}:${targetId}`;
}

/**
 * Annotate tabs with lastUsed time and activity key.
 *
 * Precedence for lastUsed: tracked activity entry > firstSeen[id] > sentinel.
 *
 * `sentinelPolicy`: 'fresh' (default) = use `now` (#50-safe); 'epoch' =
 * 1970-01-01 (pre-#50, exposed for tests/debugging only). `firstSeen` ages an
 * untracked tab from when the janitor first OBSERVED it (fixes the "immortal
 * untracked tab" bug, 2026-05-31).
 *
 * @param {object} o
 * @param {Tab[]} o.linkedInTabs
 * @param {ActivityMap} o.activity
 * @param {string} o.now  ISO string of current time (injected for testability)
 * @param {(url?: string) => (string|null)} o.extractKey
 * @param {'fresh'|'epoch'} [o.sentinelPolicy]
 * @param {Record<string, string>} [o.firstSeen]
 * @returns {Array<Tab & {lastUsed: string, activityKey: string|null}>}
 */
export function annotateTabs({ linkedInTabs, activity, now, extractKey, sentinelPolicy = 'fresh', firstSeen = {} }) {
  const sentinel = sentinelPolicy === 'epoch' ? '1970-01-01T00:00:00.000Z' : now;
  const seen = firstSeen || {};
  return linkedInTabs.map(t => {
    const key = extractKey(t.url);
    let lastUsed;
    if (key && activity[key] && activity[key].lastUsed) {
      lastUsed = activity[key].lastUsed;          // tracked — true last-used
    } else if (seen[t.id]) {
      lastUsed = seen[t.id];                       // untracked but previously observed → age from first-seen
    } else {
      lastUsed = sentinel;                         // newly observed untracked → fresh (#50-safe)
    }
    return Object.assign({}, t, { lastUsed, activityKey: key });
  });
}

/**
 * Tab ids that have NO real tracked last-used time — i.e. no stamped activity
 * entry. These are the tabs that need a first-seen record so the time-based
 * janitor can eventually age them out.
 *
 * Covers BOTH keyless untracked tabs AND keyed tabs that were never
 * extraction-stamped (or whose entry was pruned). The latter was the gap that
 * left open pages immortal (reported 2026-05-31): a tab with a key but no
 * activity entry got neither a real timestamp nor a first-seen stamp, so it
 * fell to the `now` sentinel on every pass and could never be reaped by a
 * time threshold.
 *
 * @param {Array<{id: string, activityKey?: string|null}>} annotatedTabs
 * @param {ActivityMap} activity  the activity map ({ key: { lastUsed } })
 * @returns {string[]} ids lacking a real tracked timestamp
 */
export function untimedTabIds(annotatedTabs, activity) {
  const a = activity || {};
  return annotatedTabs
    .filter(t => !(t.activityKey && a[t.activityKey] && a[t.activityKey].lastUsed))
    .map(t => t.id);
}

/**
 * Decide which tab IDs to close. PURE.
 *
 * Returns { toClose: string[], reasons: Map<id, string> }.
 * `toClose` is ordered for stable test output (insertion order from sorted scan).
 *
 * @param {object} o
 * @param {Array<{id: string, lastUsed: string, activityKey?: string|null}>} o.annotatedTabs  output of annotateTabs
 * @param {number} o.maxTabs  count cap (0 = no count cap)
 * @param {Array<{seconds: number, maxTabs: number, label: string}>|null} o.thresholds  output of parseLruThresholds
 * @param {string} [o.currentTabId]  added to protectedTabIds union
 * @param {Iterable<string>} [o.protectedTabIds]  tab ids to never close
 * @param {string|number} o.now  ISO string OR ms-since-epoch (for threshold cutoffs)
 * @returns {{toClose: string[], reasons: Map<string, string>}}
 */
export function decideClosures({ annotatedTabs, maxTabs, thresholds, currentTabId, protectedTabIds, now }) {
  /** @type {{toClose: string[], reasons: Map<string, string>}} */
  const out = { toClose: [], reasons: new Map() };

  // Early return: nothing to do.
  if ((maxTabs == null || maxTabs <= 0) && (!thresholds || thresholds.length === 0)) {
    return out;
  }

  // Stable oldest-first sort. Secondary sort on id for full determinism.
  const annotated = annotatedTabs.slice().sort((a, b) => {
    const cmp = a.lastUsed.localeCompare(b.lastUsed);
    if (cmp !== 0) return cmp;
    return String(a.id).localeCompare(String(b.id));
  });

  const protectedSet = new Set();
  if (currentTabId) protectedSet.add(currentTabId);
  if (protectedTabIds) {
    for (const id of protectedTabIds) if (id) protectedSet.add(id);
  }

  const toCloseSet = new Set();

  // Phase 1: count-based.
  if (maxTabs > 0 && annotated.length > maxTabs) {
    const need = annotated.length - maxTabs;
    let closed = 0;
    for (const t of annotated) {
      if (closed >= need) break;
      if (protectedSet.has(t.id)) continue;
      toCloseSet.add(t.id);
      out.reasons.set(t.id, `count-based (${annotated.length} > max ${maxTabs})`);
      closed++;
    }
  }

  // Phase 2: time-based thresholds.
  if (thresholds && thresholds.length > 0) {
    const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
    for (const threshold of thresholds) {
      if (threshold.maxTabs === 0) continue; // 0 = no limit (#50 fix)
      const cutoff = nowMs - threshold.seconds * 1000;
      const oldTabs = annotated.filter(t =>
        !protectedSet.has(t.id) &&
        new Date(t.lastUsed).getTime() < cutoff
      );
      if (oldTabs.length > threshold.maxTabs) {
        const excess = oldTabs.length - threshold.maxTabs;
        for (let i = 0; i < excess; i++) {
          const id = oldTabs[i].id;
          toCloseSet.add(id);
          if (!out.reasons.has(id)) {
            out.reasons.set(id, `time-based (idle >${threshold.label}, limit ${threshold.maxTabs})`);
          }
        }
      }
    }
  }

  // Preserve sorted oldest-first ordering in the output list.
  for (const t of annotated) {
    if (toCloseSet.has(t.id)) out.toClose.push(t.id);
  }
  return out;
}

/**
 * Decide whether to collapse ALL app tabs to a single about:blank. PURE.
 *
 * The terminal LRU stage: after a deep-idle horizon (`blankAfterSeconds`),
 * an idle browser should drop even its last app tab and keep only a
 * near-zero-memory about:blank (the heavy SPA renderer is killed → max RAM
 * reclaim, browser/container/xpra stay warm). See
 * docs/lru-idle-to-blank-tab.design.md.
 *
 * Fires only when ALL of:
 *   - blankAfterSeconds is enabled (> 0), and
 *   - there is at least one app tab, and
 *   - NO tab is protected (--protect-tabs / current in-flight target), and
 *   - EVERY tab is idle strictly longer than blankAfterSeconds (i.e. the
 *     freshest tab's lastUsed is older than now − blankAfter). Requiring the
 *     freshest tab to be past the horizon means we never blank a browser that
 *     has seen recent use.
 *
 * @param {Array<{id: string, lastUsed: string}>} annotatedTabs  output of annotateTabs
 * @param {object} [opts]
 * @param {?number} [opts.blankAfterSeconds]  horizon in seconds (null/0 = disabled)
 * @param {string|number} [opts.now]          ISO string OR ms-since-epoch
 * @param {Iterable<string>} [opts.protectedTabIds]
 * @returns {{collapse: boolean, staleTabIds: string[]}}  staleTabIds oldest-first
 */
export function decideBlankCollapse(annotatedTabs, { blankAfterSeconds, now, protectedTabIds } = {}) {
  /** @type {{collapse: boolean, staleTabIds: string[]}} */
  const none = { collapse: false, staleTabIds: [] };
  if (!blankAfterSeconds || blankAfterSeconds <= 0) return none;
  if (!Array.isArray(annotatedTabs) || annotatedTabs.length === 0) return none;

  const protectedSet = new Set();
  if (protectedTabIds) for (const id of protectedTabIds) if (id) protectedSet.add(id);
  if (annotatedTabs.some(t => protectedSet.has(t.id))) return none;

  const nowMs = typeof now === 'number' ? now : new Date(/** @type {string} */ (now)).getTime();
  const cutoff = nowMs - blankAfterSeconds * 1000;
  // Collapse only if EVERY tab is idle strictly past the horizon.
  const allIdle = annotatedTabs.every(t => new Date(t.lastUsed).getTime() < cutoff);
  if (!allIdle) return none;

  const staleTabIds = annotatedTabs
    .slice()
    .sort((a, b) => {
      const cmp = a.lastUsed.localeCompare(b.lastUsed);
      if (cmp !== 0) return cmp;
      return String(a.id).localeCompare(String(b.id));
    })
    .map(t => t.id);
  return { collapse: true, staleTabIds };
}

/**
 * Reconcile the firstSeen ledger for one cleanup pass, with GRACE-PRUNE. PURE.
 *
 * The firstSeen ledger ages an untracked tab from when the janitor first
 * observed it. The naive prune (drop firstSeen the first pass a tab id is not
 * live) RESETS that age whenever a tab briefly leaves the app domain — e.g. a
 * cross-origin auth interstitial drops it from the app-tab set for one pass,
 * then it returns with the SAME target-id but a fresh firstSeen. Grace-prune
 * fixes this: an absent firstSeen id increments a per-id miss counter and is
 * only deleted after `graceMisses` CONSECUTIVE misses; the counter resets the
 * moment the tab reappears, preserving its original age.
 *
 * (Real idle tabs keep a stable target-id — navigation, incl. cross-origin
 * redirects, does NOT change a target; only create/close does. So id-keying is
 * correct, and url-keying is deliberately NOT used here — it would make two
 * same-url tabs share one age entry.)
 *
 * @param {object} o
 * @param {Record<string, string>} o.firstSeen     age anchor per untracked tab ({ [tabId]: ISO })
 * @param {Record<string, number>} o.missed        consecutive-absent pass counter ({ [tabId]: number })
 * @param {string[]} o.untimedTabIds               live tab ids lacking a real activity entry
 * @param {string[]} o.liveTabIds                  currently-open app tab ids
 * @param {string} o.now                           stamp for newly-observed tabs
 * @param {number} [o.graceMisses=3]               consecutive absences before pruning
 * @returns {{firstSeen: Record<string, string>, missed: Record<string, number>, dirty: boolean}}
 */
export function reconcileFirstSeen({ firstSeen, missed, untimedTabIds, liveTabIds, now, graceMisses = 3 }) {
  const fs = Object.assign({}, firstSeen || {});
  const ms = Object.assign({}, missed || {});
  const untimed = new Set(untimedTabIds || []);
  const live = new Set(liveTabIds || []);
  let dirty = false;

  // Live tabs: stamp newly-untimed ones; drop firstSeen for tabs that gained a
  // real activity entry (age now moot); reset any miss counter (it's present).
  for (const id of live) {
    if (untimed.has(id)) {
      if (fs[id] == null) { fs[id] = now; dirty = true; }
    } else if (fs[id] != null) {
      delete fs[id]; dirty = true;
    }
    if (ms[id] != null) { delete ms[id]; dirty = true; }
  }

  // Absent firstSeen ids: grace-prune — increment miss, delete only at the cap.
  for (const id of Object.keys(fs)) {
    if (!live.has(id)) {
      ms[id] = (ms[id] || 0) + 1;
      dirty = true;
      if (ms[id] >= graceMisses) { delete fs[id]; delete ms[id]; }
    }
  }

  return { firstSeen: fs, missed: ms, dirty };
}
