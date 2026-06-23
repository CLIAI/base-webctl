// xpra-html5 access gateway — operator CLI (P3).
// Design: infra-xpra-remote-access-gateway-f6rd §4.3.
//
// `createXpraAccessCli(C, opts)` returns a thin CLI handler that a consumer mounts
// under its own verb namespace (default `xpra-access`). It is a wrapper over the
// gateway's LOOPBACK operator REST — the operator runs the gateway and the CLI
// hits 127.0.0.1:<gatewayPort>/access/* (loopback = always-trusted operator). So a
// headless/scripted approval and an interactive operator share one code path.
//
// Output: human-readable to stdout by default; `--json` switches stdout to lszd
// JSONL (one envelope per command, data-jsonl-machine-interface).
//
// Subcommands: status | enable | disable | grant --who <p> [--ttl 3h] |
//              approve --who <p> [--ttl 3h] | revoke --who <p> | requests
//
// Zero-dep (node:http); `httpRequest` injectable for tests.
//
// Tag: [WEBCTL]

import http from 'node:http';

import { assertConstants } from '../client-config.constants.template.js';

/** @typedef {import('../client-config.constants.template.js').ClientConfigConstants} ClientConfigConstants */

const USAGE_EXIT = 64;   // bad invocation
const SERVER_EXIT = 2;   // gateway returned an error (4xx/5xx)
const UNREACHABLE_EXIT = 3; // could not reach the gateway

/**
 * Minimal flag parser: `--who x --ttl 3h --json`. Booleans have no value.
 * @param {string[]} args
 */
function parseArgs(args) {
  /** @type {Record<string, any>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'json' || key === 'help') { flags[key] = true; continue; }
    const v = args[i + 1];
    if (v != null && !v.startsWith('--')) { flags[key] = v; i++; } else { flags[key] = true; }
  }
  return flags;
}

/**
 * Create the operator CLI handler bound to a tool's constants + a gateway endpoint.
 *
 * @param {ClientConfigConstants} C
 * @param {{
 *   assert?: boolean,
 *   endpoint?: { host?: string, port: number },
 *   verb?: string,
 *   out?: (s: string) => void,
 *   err?: (s: string) => void,
 *   httpRequest?: (o: {method: string, path: string, body?: any}) => Promise<{status: number, json: any, body: string}>,
 * }} [opts]
 * @returns {{ run: (argv: string[]) => Promise<number>, verb: string }}
 */
export function createXpraAccessCli(C, opts = {}) {
  if (opts.assert !== false) assertConstants(C, { context: 'createXpraAccessCli' });
  const verb = opts.verb || 'xpra-access';
  const host = (opts.endpoint && opts.endpoint.host) || '127.0.0.1';
  const port = opts.endpoint && opts.endpoint.port;
  const out = opts.out || ((/** @type {string} */ s) => process.stdout.write(s));
  const err = opts.err || ((/** @type {string} */ s) => process.stderr.write(s));

  /** @param {{method: string, path: string, body?: any}} o */
  function httpRequest(o) {
    if (opts.httpRequest) return opts.httpRequest(o);
    return new Promise((resolve, reject) => {
      const data = o.body != null ? JSON.stringify(o.body) : null;
      const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
      const r = http.request({ host, port, method: o.method, path: o.path, headers }, (res) => {
        let b = '';
        res.on('data', (c) => b += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* non-json */ } resolve({ status: res.statusCode || 0, json: j, body: b }); });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  /** @param {string} command @param {boolean} json @param {any} payload */
  function emit(command, json, payload) {
    if (json) {
      out(JSON.stringify({ type: 'xpra-access-cli', ts: new Date().toISOString(), tool: C.PROJECT, command, ...payload }) + '\n');
    } else {
      out(humanLine(command, payload) + '\n');
    }
  }

  /** @param {string} command @param {any} p */
  function humanLine(command, p) {
    switch (command) {
      case 'status': {
        const g = (p.grants || []).map((/** @type {any} */ x) => `${x.principal} (${x.remainingSeconds == null ? 'forever' : x.remainingSeconds + 's left'})`).join(', ') || 'none';
        const r = (p.requests || []).map((/** @type {any} */ x) => x.principal).join(', ') || 'none';
        return `enabled=${p.enabled}\n  grants:   ${g}\n  pending:  ${r}`;
      }
      case 'requests':
        return (p.requests || []).length
          ? (p.requests).map((/** @type {any} */ x) => `${x.principal}  who=${x.who || '-'}  note=${x.note || '-'}`).join('\n')
          : 'no pending requests';
      case 'enable': case 'disable':
        return `remote access ${p.enabled ? 'ENABLED' : 'DISABLED'}`;
      case 'grant': case 'approve':
        return `granted ${p.principal} (ttl ${p.grant ? p.grant.ttl : ''})`;
      case 'revoke':
        return `revoked ${p.principal} (was ${p.ok ? 'active' : 'not granted'})`;
      default:
        return JSON.stringify(p);
    }
  }

  function usage() {
    err(
      `usage: ${verb} <status|enable|disable|grant|approve|revoke|requests> [--who <principal>] [--ttl 3h] [--json]\n` +
      `  operator CLI for ${C.PROJECT} xpra-html5 remote access (hits the loopback gateway)\n`
    );
    return USAGE_EXIT;
  }

  /**
   * @param {string[]} argv  args AFTER the verb, e.g. ['grant','--who','x','--ttl','3h']
   * @returns {Promise<number>}
   */
  async function run(argv) {
    const sub = (argv && argv[0]) || '';
    const flags = parseArgs((argv || []).slice(1));
    if (!sub || flags.help) return usage();
    if (port == null) { err(`${verb}: no gateway endpoint configured (opts.endpoint.port)\n`); return USAGE_EXIT; }
    const json = !!flags.json;

    /** @type {{method: string, path: string, body?: any}|null} */
    let call = null;
    switch (sub) {
      case 'status':   call = { method: 'GET',  path: '/access/status' }; break;
      case 'requests': call = { method: 'GET',  path: '/access/requests' }; break;
      case 'enable':   call = { method: 'POST', path: '/access/enable' }; break;
      case 'disable':  call = { method: 'POST', path: '/access/disable' }; break;
      case 'grant':
      case 'approve':
        if (!flags.who) { err(`${verb} ${sub}: --who <principal> required\n`); return USAGE_EXIT; }
        call = { method: 'POST', path: '/access/approve', body: { principal: flags.who, ttl: flags.ttl } };
        break;
      case 'revoke':
        if (!flags.who) { err(`${verb} revoke: --who <principal> required\n`); return USAGE_EXIT; }
        call = { method: 'POST', path: '/access/revoke', body: { principal: flags.who } };
        break;
      default:
        err(`${verb}: unknown subcommand "${sub}"\n`);
        return usage();
    }

    let resp;
    try {
      resp = await httpRequest(call);
    } catch (/** @type {any} */ e) {
      err(`${verb} ${sub}: cannot reach gateway at ${host}:${port} (${e && e.code || e && e.message})\n`);
      return UNREACHABLE_EXIT;
    }
    if (resp.status < 200 || resp.status >= 300) {
      const msg = (resp.json && resp.json.error) || resp.body || `HTTP ${resp.status}`;
      err(`${verb} ${sub}: gateway error (${resp.status}): ${String(msg).trim()}\n`);
      return SERVER_EXIT;
    }
    emit(sub, json, resp.json || {});
    return 0;
  }

  return { run, verb };
}
