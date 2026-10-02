// remotes.js — validators for rm7t: remote targets, refresh verification, inventory.
//
// Design: docs/design/arch-remote-targets-build-inventory-rm7t.md
//
// Pure: no fs, no network, no process. Lanes do the reading (over ssh, from their
// zone manager); base decides whether what they read is acceptable. Every verdict is
// tri-state where "cannot tell" is possible, and UNKNOWN never collapses into the
// reassuring answer.

const CONTROL = Object.freeze(['ssh', 'local']);
const VIEW = Object.freeze(['ssh', 'tailscale-relay']);
const KIND = Object.freeze(['docker-xpra', 'direct', 'managed-zone']);

/**
 * Validate a target record (the parsed `~/.config/webctl/targets/<name>.toml`).
 *
 * @param {Record<string, any>} t
 * @returns {{verdict: 'valid' | 'invalid', errors: {field: string, message: string}[]}}
 */
export function validateTarget(t) {
  /** @type {{field: string, message: string}[]} */
  const errors = [];
  const add = (/** @type {string} */ field, /** @type {string} */ message) => errors.push({ field, message });
  if (!t || typeof t !== 'object') return { verdict: 'invalid', errors: [{ field: '*', message: 'not a record' }] };

  if (typeof t.name !== 'string' || !t.name.trim()) add('name', 'required');

  // ⛔ The tailscale refusal gets its OWN message: the operator must learn WHY, not
  // meet a generic "not one of ssh|local".
  if (t.control === 'tailscale') {
    add('control', 'control never travels over the tailnet; use --tailscale <host> to '
      + 'reach ssh, and control goes through ssh');
  } else if (!CONTROL.includes(t.control)) {
    add('control', `must be one of ${CONTROL.join(' | ')}`);
  }

  if (t.view !== undefined) {
    const v = Array.isArray(t.view) ? t.view : [t.view];
    for (const x of v) if (!VIEW.includes(x)) add('view', `"${x}" is not one of ${VIEW.join(' | ')}`);
  }

  if (t.control === 'ssh' && !(typeof t.ssh === 'string' && t.ssh.trim()) && !(typeof t.machine === 'string' && t.machine.trim())) {
    add('ssh', 'control = "ssh" needs an ssh destination or a machine reference');
  }

  if (t.kind !== undefined && !KIND.includes(t.kind)) add('kind', `must be one of ${KIND.join(' | ')}`);

  // btg4 §2: a target names a profile by OPAQUE id, never a path.
  if (t.profile_id !== undefined) {
    const p = String(t.profile_id);
    if (/[\\/]/.test(p) || /^[~.]/.test(p) || !p.trim()) {
      add('profile_id', 'must be an opaque id, never a path (btg4 §2)');
    }
  }
  return { verdict: errors.length ? 'invalid' : 'valid', errors };
}

/**
 * Is a config file's mode acceptable? Refuses anything readable or writable by group
 * or other — on shared hosts, a host-and-target map is reconnaissance (D8).
 *
 * @param {number} mode st_mode or permission bits
 * @returns {{verdict: 'ok' | 'refused', reason: string}}
 */
export function checkConfigMode(mode) {
  if (typeof mode !== 'number' || !Number.isFinite(mode)) {
    return { verdict: 'refused', reason: 'mode could not be read — refusing rather than assuming 600' };
  }
  const bits = mode & 0o777;
  return (bits & 0o077)
    ? { verdict: 'refused', reason: `mode ${bits.toString(8).padStart(3, '0')} is readable or writable beyond its owner; chmod 600` }
    : { verdict: 'ok', reason: `mode ${bits.toString(8).padStart(3, '0')}` };
}

/** @param {string} s */
const numeric = (s) => (/^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null);

/**
 * Compare a READING against a DECLARED target, naming both.
 *
 * ⛔ A refresh that exits 0 is not a refresh: measured, a plain rebuild reproduced a
 * stale browser because the package layer was cached. Success is the binary's own
 * reported version equalling the declared candidate.
 *
 * @param {{reading?: {value?: string|null, instrument?: string, at?: string} | null, declared?: string | null}} x
 * @returns {{verdict: 'current' | 'outdated' | 'ahead' | 'differs' | 'unknown',
 *   reading: string | null, declared: string | null, reason: string}}
 */
export function versionVerdict({ reading, declared } = {}) {
  const r = reading && typeof reading.value === 'string' && reading.value.trim() ? reading.value.trim() : null;
  const d = typeof declared === 'string' && declared.trim() ? declared.trim() : null;
  if (!r) return { verdict: 'unknown', reading: null, declared: d, reason: 'no reading — unreachable or unread is UNKNOWN, not current' };
  if (!d) return { verdict: 'unknown', reading: r, declared: null, reason: 'no declared target to compare against' };
  if (!reading || !reading.instrument) {
    return { verdict: 'unknown', reading: r, declared: d, reason: 'a reading without its instrument is a claim, not a measurement' };
  }
  if (r === d) return { verdict: 'current', reading: r, declared: d, reason: `reads ${r}, declared ${d}` };
  const a = numeric(r), b = numeric(d);
  if (a && b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) {
        return x < y
          ? { verdict: 'outdated', reading: r, declared: d, reason: `reads ${r}, declared ${d}` }
          : { verdict: 'ahead', reading: r, declared: d, reason: `reads ${r}, newer than declared ${d} — the declaration may be stale` };
      }
    }
    return { verdict: 'current', reading: r, declared: d, reason: `reads ${r}, declared ${d}` };
  }
  return { verdict: 'differs', reading: r, declared: d, reason: `reads ${r}, declared ${d} — not comparable as versions` };
}

/**
 * Build inventory rows so that EVERY target has one. An unreachable target is an
 * UNKNOWN row, never an omitted one — an inventory that drops what it could not reach
 * reports a smaller fleet as a healthier one.
 *
 * @param {string[]} targets target names
 * @param {Record<string, {value: string, instrument: string, at: string}>} readings by target
 * @returns {{target: string, state: 'read' | 'unknown', reading: any}[]}
 */
export function inventoryRows(targets, readings) {
  const rd = readings || {};
  return (Array.isArray(targets) ? targets : []).map((t) => {
    const r = rd[t];
    const ok = r && typeof r.value === 'string' && r.value && r.instrument && r.at;
    return { target: t, state: ok ? 'read' : 'unknown', reading: ok ? r : null };
  });
}
