// runtime-xq.js — base's side of the xq runtime seam (rx9q §4), step 1: read and
// judge `xq capabilities --json`, fail-closed.
//
// Tag: [WEBCTL::RUNTIME]

/**
 * @file The boundary (rx9q §1): **xq owns everything up to "a running GUI app in a
 * container, with a reachable, DECLARED control port"; base owns everything above
 * it.** xq never learns CDP; base never builds an image. This module is where base
 * ASKS xq what it can serve — which verbs exist, which carry versioned JSON, and
 * which control surfaces each app's built image declares — and refuses (UNKNOWN)
 * whenever the answer is missing, older, or not the shape it knows. A container-mode
 * run with no usable xq is refused with instructions; this module produces the
 * verdict, the caller produces the refusal.
 *
 * ⛔ **Pin capabilities, never `xq --version`.** That string did not change in 166
 * xq commits (rx9q §2): pinning it pins nothing. What a caller needs is read from
 * the capabilities list, verb by verb and image by image.
 *
 * ⛔ **Never probe a verb by its exit code.** xq lists only the verbs its parser
 * IMPLEMENTS; a DEFERRED verb is absent from the list and exits 0 with "not yet
 * implemented". A verb that "ran fine" proves nothing — read the list (`hasVerb`).
 *
 * ⛔ **xq's field names, unrenamed** (rx9q §4): in xq `kind` is the TRANSPORT
 * (`tcp`) and `adapter` is the PROTOCOL (`cdp`, later `bidi`). Base picks its CDP or
 * BiDi backend by `adapter`. A field renamed to base's vocabulary is a copy that
 * drifts.
 *
 * ⛔ **`control: null` is UNKNOWN, `[]` is NONE** — never conflated. Labels exist
 * only on a BUILT image, so an unbuilt image (or `docker: false`) says nothing about
 * what the app would declare.
 */

// Indirect import + call-time property access, so tests (and consumer suites) can
// monkey-patch child_process.spawn — the same seam docker-ctl.js keeps.
import child_process from 'node:child_process';

/** The `xq capabilities --json` schema this reader understands. */
export const CAPABILITIES_SCHEMA = 1;

/**
 * @typedef {{name: string, kind: string, adapter: string}} XqControl
 *   One declared control surface, in xq's own vocabulary: `kind` = transport, `adapter` = protocol.
 * @typedef {{distro: string, scope: string, image: string, built: boolean | null,
 *   control: XqControl[] | null}} XqImage
 * @typedef {{app: string, images: XqImage[]}} XqApp
 * @typedef {{verdict: 'ok', schema: number, docker: boolean,
 *   verbs: Map<string, number | null>, flags: Map<string, string[] | null>,
 *   apps: XqApp[], reason: string}} CapabilitiesOk
 *   `flags`: each verb's flags as xq's parser lists them, or null when this xq predates
 *   the field (TOO OLD to vouch for any flag — see hasFlag).
 * @typedef {{verdict: 'unknown', reason: string, code?: string}} CapabilitiesUnknown
 * @typedef {CapabilitiesOk | CapabilitiesUnknown} Capabilities
 */

/** @param {unknown} v */
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Parse `xq capabilities --json` (pure).
 *
 * ⛔ Fail-closed, as base's other xq readers (`remotes.parseMachineList`): an unknown
 * `schema` is UNKNOWN and refused rather than guessed at, and ONE malformed entry
 * makes the WHOLE answer UNKNOWN — a capability list with a silently dropped verb or
 * image is a smaller xq reported as complete. Every refusal names the field.
 *
 * ⚠ Verbs are returned as a `Map`, not an object: a verb lookup on a plain object
 * would find `constructor` and `toString` on every xq.
 *
 * @param {string} text the command's stdout
 * @returns {Capabilities}
 */
export function parseCapabilities(text) {
  /** @param {string} reason @returns {CapabilitiesUnknown} */
  const unknown = (reason) => ({ verdict: 'unknown', reason });
  /** @type {any} */
  let j;
  try { j = JSON.parse(String(text)); } catch { return unknown('not JSON — nothing usable was read'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return unknown('not a JSON object');
  if (j.schema !== CAPABILITIES_SCHEMA) {
    return unknown(`schema ${JSON.stringify(j.schema)} is not ${CAPABILITIES_SCHEMA}; refusing to guess at a format this reader does not know`);
  }
  if (typeof j.docker !== 'boolean') return unknown('"docker" must be a boolean');
  if (!Array.isArray(j.verbs)) return unknown('"verbs" must be an array');
  if (!Array.isArray(j.apps)) return unknown('"apps" must be an array');

  /** @type {Map<string, number | null>} */
  const verbs = new Map();
  /** @type {Map<string, string[] | null>} */
  const flags = new Map();
  for (const [i, v] of j.verbs.entries()) {
    if (!v || typeof v !== 'object' || !isStr(v.verb)) return unknown(`verbs[${i}].verb must be a non-empty string`);
    if (!(v.json_schema === null || Number.isInteger(v.json_schema))) {
      return unknown(`verbs[${i}].json_schema (${v.verb}) must be an integer or null`);
    }
    // `schemas` (additive, newer xq): validated when present, though base does not READ it —
    // a known field is never accepted malformed, even one base ignores.
    if (v.schemas !== undefined && !(Array.isArray(v.schemas) && v.schemas.every(Number.isInteger))) {
      return unknown(`verbs[${i}].schemas (${v.verb}) must be an array of integers`);
    }
    // two answers to one question is not an answer
    if (verbs.has(v.verb)) return unknown(`verbs[${i}].verb "${v.verb}" is listed twice`);
    verbs.set(v.verb, v.json_schema);
    if (v.flags === undefined) flags.set(v.verb, null); // an older xq: cannot vouch
    else if (Array.isArray(v.flags) && v.flags.every(isStr)) flags.set(v.verb, v.flags.slice());
    else return unknown(`verbs[${i}].flags (${v.verb}) must be an array of strings`);
  }

  /** @type {XqApp[]} */
  const apps = [];
  const seenApps = new Set();
  for (const [i, a] of j.apps.entries()) {
    const at = `apps[${i}]`;
    if (!a || typeof a !== 'object' || !isStr(a.app)) return unknown(`${at}.app must be a non-empty string`);
    if (seenApps.has(a.app)) return unknown(`${at}.app "${a.app}" is listed twice`);
    seenApps.add(a.app);
    if (!Array.isArray(a.images)) return unknown(`${at}.images (${a.app}) must be an array`);
    /** @type {XqImage[]} */
    const images = [];
    for (const [k, im] of a.images.entries()) {
      const it = `${at}.images[${k}]`;
      if (!im || typeof im !== 'object') return unknown(`${it} (${a.app}) must be an object`);
      for (const f of ['distro', 'scope', 'image']) {
        if (!isStr(im[f])) return unknown(`${it}.${f} (${a.app}) must be a non-empty string`);
      }
      if (!(im.built === null || typeof im.built === 'boolean')) {
        return unknown(`${it}.built (${a.app}/${im.distro}) must be a boolean or null`);
      }
      /** @type {XqControl[] | null} */
      let control = null;
      if (im.control !== null) {
        if (!Array.isArray(im.control)) {
          return unknown(`${it}.control (${a.app}/${im.distro}) must be an array or null`);
        }
        control = [];
        for (const [m, c] of im.control.entries()) {
          for (const f of ['name', 'kind', 'adapter']) {
            if (!c || typeof c !== 'object' || !isStr(c[f])) {
              return unknown(`${it}.control[${m}].${f} (${a.app}/${im.distro}) must be a non-empty string`);
            }
          }
          control.push({ name: c.name, kind: c.kind, adapter: c.adapter });
        }
      }
      images.push({ distro: im.distro, scope: im.scope, image: im.image, built: im.built, control });
    }
    apps.push({ app: a.app, images });
  }
  return {
    verdict: 'ok', schema: j.schema, docker: j.docker, verbs, flags, apps,
    reason: `${verbs.size} verb(s), ${apps.length} app(s)${j.docker ? '' : '; docker unavailable — every control is UNKNOWN'}`,
  };
}

/**
 * Is `verb` implemented by this xq — read from the LIST, never inferred.
 *
 * True only when the verb is listed and, when `jsonSchema` is given, its
 * `json_schema` equals it exactly (`null` asks for "listed, no versioned JSON").
 * Absent ⇒ false. An UNKNOWN capabilities result ⇒ false.
 *
 * @param {Capabilities} caps from `parseCapabilities` / `readCapabilities`
 * @param {string} verb as xq spells it, e.g. `"app version"`
 * @param {{jsonSchema?: number | null}} [opts]
 * @returns {boolean}
 */
export function hasVerb(caps, verb, opts = {}) {
  if (!caps || caps.verdict !== 'ok' || !(caps.verbs instanceof Map)) return false;
  if (!caps.verbs.has(verb)) return false;
  if (opts.jsonSchema !== undefined) return caps.verbs.get(verb) === opts.jsonSchema;
  return true;
}

/**
 * Does this xq's `verb` accept every flag in `wanted`? ⛔ CHECK BEFORE PASSING ANY FLAG.
 *
 * An older xq passes unknown flags after the target THROUGH TO THE APP and still exits 0
 * (measured by xq's lane: an old checkout given `--profile-dir=/p` started chromium on the
 * DEFAULT profile, ignoring the switch — the caller believed its profile was in use). So a
 * flag xq does not list is never sent, and an xq whose capabilities carry no `flags` at all
 * is TOO OLD to vouch for any flag: this returns `{ok:false}`, fail closed — the same rule as
 * base's own resolvers and cdp-client (an option the callee does not honour is refused).
 *
 * @param {Capabilities} caps @param {string} verb @param {string[]} wanted e.g. ['--profile-dir']
 * @returns {{ok: true} | {ok: false, reason: string, missing: string[]}}
 */
export function hasFlag(caps, verb, wanted) {
  if (!caps || caps.verdict !== 'ok' || !(caps.flags instanceof Map) || !caps.verbs.has(verb)) {
    return { ok: false, reason: `xq capabilities do not list the verb '${verb}'`, missing: [...wanted] };
  }
  const listed = caps.flags.get(verb);
  if (listed === null || listed === undefined) {
    return { ok: false, missing: [...wanted],
      reason: `this xq predates per-verb "flags" — too old to vouch for ${wanted.join(', ')}; update xq` };
  }
  const missing = wanted.filter((f) => !listed.includes(f));
  return missing.length
    ? { ok: false, missing, reason: `xq '${verb}' does not accept ${missing.join(', ')} — never send it (an older xq passes it to the app silently)` }
    : { ok: true };
}

/**
 * @typedef {{state: 'unknown' | 'none' | 'declared', controls: XqControl[], reason: string}} ControlVerdict
 */

/**
 * What control surfaces does `app` declare — judged, three-state, never guessed.
 *
 *  * `unknown`  — capabilities not read; `docker: false`; the app (or the `distro`) is
 *                 absent; the image is not built (`built !== true`); `control: null`;
 *                 or, with `distro` omitted, the app's images DISAGREE.
 *  * `none`     — the built image declares `[]`, or nothing it declares matches `adapter`.
 *  * `declared` — the built image declares controls (filtered by `adapter` when given).
 *
 * ⛔ With `distro` omitted and several images, they are judged together and must
 * agree (same state, same controls); otherwise UNKNOWN naming the distros — this
 * never picks one image silently (controls can differ by distro, rx9q §2).
 *
 * @param {Capabilities} caps
 * @param {string} app
 * @param {{distro?: string, adapter?: string}} [opts]
 * @returns {ControlVerdict}
 */
export function controlFor(caps, app, opts = {}) {
  const { distro, adapter } = opts;
  /** @param {string} reason @returns {ControlVerdict} */
  const unknown = (reason) => ({ state: 'unknown', controls: [], reason });
  if (!caps || caps.verdict !== 'ok') return unknown(`capabilities not read: ${(caps && caps.reason) || 'no result'}`);
  if (caps.docker === false) return unknown('xq reports docker unavailable — no image labels can be read');
  const a = caps.apps.find((x) => x.app === app);
  if (!a) return unknown(`app "${app}" is not listed by xq`);
  const images = distro === undefined ? a.images : a.images.filter((im) => im.distro === distro);
  if (images.length === 0) {
    return unknown(distro === undefined ? `app "${app}" lists no images` : `app "${app}" has no "${distro}" image`);
  }

  /** @param {XqImage} im @returns {ControlVerdict} */
  const judge = (im) => {
    const id = `${app}/${im.distro}`;
    if (im.built !== true) return unknown(`${id} image is not built (built: ${JSON.stringify(im.built)}) — labels unread`);
    if (im.control === null) return unknown(`${id} control is null — UNKNOWN, not none`);
    if (im.control.length === 0) return { state: 'none', controls: [], reason: `${id} declares no control surface` };
    if (adapter === undefined) {
      return { state: 'declared', controls: im.control.map((c) => ({ ...c })), reason: `${id} declares ${im.control.length} control(s)` };
    }
    const hit = im.control.filter((c) => c.adapter === adapter);
    if (hit.length === 0) {
      return { state: 'none', controls: [],
        reason: `${id} declares no control with adapter "${adapter}" (declares: ${im.control.map((c) => c.adapter).join(', ')})` };
    }
    return { state: 'declared', controls: hit.map((c) => ({ ...c })), reason: `${id} declares adapter "${adapter}"` };
  };

  const verdicts = images.map(judge);
  if (verdicts.length === 1) return verdicts[0];
  /** @param {ControlVerdict} v */
  const key = (v) => `${v.state}|${JSON.stringify([...v.controls]
    .map((c) => [c.name, c.kind, c.adapter]).sort())}`;
  const first = key(verdicts[0]);
  if (verdicts.every((v) => key(v) === first)) {
    if (verdicts[0].state === 'unknown') {
      return unknown(`every ${app} image is UNKNOWN: ${verdicts.map((v) => v.reason).join('; ')}`);
    }
    return { ...verdicts[0],
      reason: `${images.length} ${app} images (${images.map((im) => im.distro).join(', ')}) agree: ${verdicts[0].state}` };
  }
  return unknown(`${app} images disagree (${images.map((im, i) => `${im.distro}: ${verdicts[i].state}`).join(', ')}); `
    + 'pass { distro } to choose one — refusing to pick silently');
}

/** @param {string} s */
const excerpt = (s) => {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t.length > 300 ? `…${t.slice(-300)}` : t;
};

/**
 * Run `xqBin capabilities --json` and judge it. ⛔ Never throws for anything the
 * child does — every failure is `{verdict: 'unknown', code, reason}`:
 *
 *  * `xq-absent`  — the binary is not there (spawn ENOENT);
 *  * `xq-too-old` — exit 2: argparse's "invalid choice", an xq older than the verb;
 *  * `xq-failed`  — any other non-zero exit, a signal, a timeout, or a spawn error;
 *  * `contract`   — exit 0 but `parseCapabilities` refused the output.
 *
 * argv array, no shell. The child is killed (its whole process group, where the
 * platform has them) on timeout and the result is returned at once — a grandchild
 * holding the pipe open cannot stall it.
 *
 * @param {{xqBin?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<Capabilities>}
 */
export function readCapabilities({ xqBin = 'xq', timeoutMs = 15000 } = {}) {
  const argv = ['capabilities', '--json'];
  const shown = `${xqBin} ${argv.join(' ')}`;
  return new Promise((resolve) => {
    let done = false;
    /** @param {Capabilities} r */
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    /** @param {string} code @param {string} reason @returns {CapabilitiesUnknown} */
    const unknown = (code, reason) => ({ verdict: 'unknown', code, reason });
    const group = process.platform !== 'win32';

    // ⛔ NODE_TEST_CONTEXT is not passed on: inherited from a node:test run it switches
    // any node process underneath (a node-based xq wrapper) into the test-runner protocol.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = child_process.spawn(xqBin, argv, {
        stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: group, env,
      });
    } catch (e) {
      finish(unknown('xq-failed', `could not start \`${shown}\`: ${/** @type {Error} */ (e).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });

    const timer = setTimeout(() => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch {} }
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(unknown('xq-failed', `\`${shown}\` timed out after ${timeoutMs} ms${stderr ? `; stderr: ${excerpt(stderr)}` : ''}`));
    }, timeoutMs);

    child.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
      clearTimeout(timer);
      if (err && err.code === 'ENOENT') {
        finish(unknown('xq-absent', `xq not found (\`${xqBin}\`): install xq — the zone manager that runs base's `
          + 'container modes — and put it on PATH, or pass { xqBin }. `direct` and attach-only modes need no xq.'));
      } else {
        finish(unknown('xq-failed', `could not run \`${shown}\`: ${(err && err.message) || String(err)}`));
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        const parsed = parseCapabilities(stdout);
        finish(parsed.verdict === 'ok' ? parsed : { ...parsed, code: 'contract' });
      } else if (code === 2) {
        const why = /invalid choice/.test(stderr) ? 'it does not know the `capabilities` verb' : 'it rejected the arguments';
        finish(unknown('xq-too-old', `\`${shown}\` exited 2 — ${why}; this xq predates the capabilities contract, upgrade xq`
          + `${stderr ? `; stderr: ${excerpt(stderr)}` : ''}`));
      } else {
        finish(unknown('xq-failed', `\`${shown}\` ${code === null ? `was killed by ${signal}` : `exited ${code}`}`
          + `${stderr ? `; stderr: ${excerpt(stderr)}` : ''}`));
      }
    });
  });
}
