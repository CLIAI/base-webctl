// lib/systemd-timer.js — generate + manage a systemd --user timer that runs a
// periodic maintenance command (e.g. an LRU tab-cleanup janitor).
//
// SERVICE-AGNOSTIC: this file contains NO project specifics. Everything
// project-dependent — the unit slug, Description, ExecStart command, and
// cadence — is passed in by the caller (which sources it from the per-repo
// client-config.constants seam + the resolved binary path). Push specifics into
// the caller.
//
// Pure builders (buildServiceUnit/buildTimerUnit/unitPaths) are unit-tested; the
// side-effecting ops (install/uninstall/status) shell out to `systemctl --user`
// and are covered by live verification.
//
// systemd timer model: a timer named `<slug>.timer` activates `<slug>.service`
// by default (matching basename), so no explicit `Unit=` is needed as long as
// the service + timer share the slug.
//
// base-webctl ESM port (sb7q): zero-dep, JSDoc-typed, no top-level await.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// ---- paths ----------------------------------------------------------------

/**
 * PURE: inject `home` for byte-identical unit testing; defaults to the real
 * home. systemd --user units live at ~/.config/systemd/user. The caller is
 * responsible for an EXACT, client-scoped slug (multi-tenant safety): every
 * install/uninstall/status targets that exact `<slug>.{service,timer}` name —
 * never a glob/prefix match — so per-client and personal timers stay distinct.
 *
 * @param {string} slug
 * @param {{home?: string}} [opts]
 * @returns {{dir: string, service: string, timer: string}}
 */
export function unitPaths(slug, { home = os.homedir() } = {}) {
  const dir = path.join(home, '.config', 'systemd', 'user');
  return { dir, service: path.join(dir, `${slug}.service`), timer: path.join(dir, `${slug}.timer`) };
}

/**
 * @param {{home?: string}} [opts]
 * @returns {string}
 */
export function userUnitDir({ home = os.homedir() } = {}) {
  return path.join(home, '.config', 'systemd', 'user');
}

// ---- pure unit builders ---------------------------------------------------

/**
 * ExecStart MUST be absolute (systemd --user has a minimal PATH): the caller
 * builds it as `${process.execPath} <abs-runner> <command> ...`. Optional
 * workingDirectory + environment (array of "KEY=VALUE") for config discovery —
 * usually unnecessary since --client/--port/--lru-blank-after are baked into
 * ExecStart.
 *
 * @param {object} o
 * @param {string} o.description
 * @param {string} o.execStart
 * @param {string} [o.workingDirectory]
 * @param {string[]} [o.environment]  array of "KEY=VALUE"
 * @returns {string}
 */
export function buildServiceUnit({ description, execStart, workingDirectory, environment }) {
  const lines = ['[Unit]', `Description=${description}`, '', '[Service]', 'Type=oneshot'];
  if (workingDirectory) lines.push(`WorkingDirectory=${workingDirectory}`);
  for (const e of environment || []) lines.push(`Environment=${e}`);
  lines.push(`ExecStart=${execStart}`, '');
  return lines.join('\n');
}

/**
 * @param {object} o
 * @param {string} o.description
 * @param {string} o.onActiveSec
 * @param {string} [o.onBootSec='5min']
 * @param {boolean} [o.persistent=true]
 * @returns {string}
 */
export function buildTimerUnit({ description, onActiveSec, onBootSec = '5min', persistent = true }) {
  const lines = [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Timer]',
    `OnBootSec=${onBootSec}`,
    `OnUnitActiveSec=${onActiveSec}`,
  ];
  if (persistent) lines.push('Persistent=true');
  lines.push('', '[Install]', 'WantedBy=timers.target', '');
  return lines.join('\n');
}

// ---- systemctl --user glue ------------------------------------------------

/**
 * Run `systemctl --user <args>`. Returns { ok, code, stdout, stderr }. Never
 * throws — callers inspect the result (systemctl exits non-zero for
 * is-enabled/is-active when the unit is disabled/inactive, which is normal).
 *
 * @param {string[]} args
 * @returns {{ok: boolean, code: number, stdout: string, stderr: string}}
 */
export function systemctl(args) {
  try {
    const stdout = execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, code: 0, stdout: (stdout || '').trim(), stderr: '' };
  } catch (/** @type {any} */ e) {
    return { ok: false, code: e.status ?? 1, stdout: (e.stdout || '').toString().trim(), stderr: (e.stderr || '').toString().trim() || e.message };
  }
}

/** @returns {boolean} */
export function systemctlAvailable() {
  try {
    execFileSync('systemctl', ['--user', '--version'], { stdio: 'ignore' });
    return true;
  } catch { return false;
  }
}

/**
 * Install + enable the timer.
 * @param {object} o
 * @param {string} o.slug         unit basename (e.g. "chatgpt-webctl-lru")
 * @param {string} o.description  human description (used for both units, " (timer)" appended to timer)
 * @param {string} o.execStart    absolute ExecStart command for the oneshot service
 * @param {string} o.onActiveSec  timer cadence (e.g. "30min")
 * @param {string} [o.onBootSec]
 * @param {boolean} [o.persistent]
 * @param {string} [o.workingDirectory]
 * @param {string[]} [o.environment]
 * @param {string} [o.home]
 * @returns {{ok: boolean, slug: string, paths: object, enabled: boolean, started: boolean, daemonReloaded: boolean, messages: string[]}}
 */
export function install({ slug, description, execStart, onActiveSec, onBootSec, persistent, workingDirectory, environment, home }) {
  const paths = unitPaths(slug, { home });
  const messages = [];
  fs.mkdirSync(paths.dir, { recursive: true });

  const svc = buildServiceUnit({ description, execStart, workingDirectory, environment });
  const tmr = buildTimerUnit({ description: `${description} (timer)`, onActiveSec, onBootSec, persistent });
  fs.writeFileSync(paths.service, svc);
  fs.writeFileSync(paths.timer, tmr);
  messages.push(`wrote ${paths.service}`, `wrote ${paths.timer}`);

  const reload = systemctl(['daemon-reload']);
  if (!reload.ok) messages.push(`daemon-reload: ${reload.stderr}`);
  const enable = systemctl(['enable', '--now', `${slug}.timer`]);
  if (!enable.ok) messages.push(`enable --now: ${enable.stderr}`);

  return { ok: enable.ok, slug, paths, enabled: enable.ok, started: enable.ok, daemonReloaded: reload.ok, messages };
}

/**
 * Stop, disable, and remove the timer + service unit files.
 * @param {object} o
 * @param {string} o.slug
 * @param {string} [o.home]
 * @returns {{ok: boolean, slug: string, removed: string[], messages: string[]}}
 */
export function uninstall({ slug, home }) {
  const paths = unitPaths(slug, { home });
  const messages = [];
  const disable = systemctl(['disable', '--now', `${slug}.timer`]);
  if (!disable.ok) messages.push(`disable --now: ${disable.stderr}`);
  const removed = [];
  for (const f of [paths.timer, paths.service]) {
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(f); } }
    catch (/** @type {any} */ e) { messages.push(`rm ${f}: ${e.message}`); }
  }
  const reload = systemctl(['daemon-reload']);
  if (!reload.ok) messages.push(`daemon-reload: ${reload.stderr}`);
  return { ok: true, slug, removed, messages };
}

/**
 * Report installed/enabled/active state + last/next run.
 * @param {object} o
 * @param {string} o.slug
 * @param {string} [o.home]
 * @returns {{slug: string, available: boolean, installed: boolean, enabled: ?string, active: ?string, lastRun: ?string, nextRun: ?string, execStart: ?string, paths: object}}
 */
export function status({ slug, home }) {
  const paths = unitPaths(slug, { home });
  const installed = fs.existsSync(paths.service) && fs.existsSync(paths.timer);
  const available = systemctlAvailable();

  let enabled = null, active = null, lastRun = null, nextRun = null, execStart = null;
  if (available) {
    const en = systemctl(['is-enabled', `${slug}.timer`]);
    enabled = en.stdout || (en.ok ? 'enabled' : 'disabled');
    const ac = systemctl(['is-active', `${slug}.timer`]);
    active = ac.stdout || (ac.ok ? 'active' : 'inactive');
    // list-timers gives NEXT + LAST columns for the timer.
    const lt = systemctl(['list-timers', '--all', '--no-pager', `${slug}.timer`]);
    if (lt.ok && lt.stdout) {
      const line = lt.stdout.split('\n').find(l => l.includes(`${slug}.timer`));
      if (line) {
        const m = line.match(/^(.*?\bago|.*?\bleft|-)\s+\S/); // best-effort; full parsing is brittle
        void m;
        nextRun = line; // keep the raw timer row; callers/humans read NEXT/LAST from it
      }
    }
    const show = systemctl(['show', `${slug}.service`, '-p', 'ExecMainStartTimestamp', '-p', 'Result', '-p', 'ExecStart']);
    if (show.ok) {
      for (const l of show.stdout.split('\n')) {
        if (l.startsWith('ExecMainStartTimestamp=')) lastRun = l.slice('ExecMainStartTimestamp='.length) || null;
        if (l.startsWith('ExecStart=')) execStart = l.slice('ExecStart='.length) || null;
      }
    }
  }
  return { slug, available, installed, enabled, active, lastRun, nextRun, execStart, paths };
}
