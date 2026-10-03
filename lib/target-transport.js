// The ssh ARGV transport and target facts (rb7s §2, §3).
//
// Everything a remote bring-up does on the target that is NOT docker — reading the
// target's facts, creating the profile dir, listing listeners, writing the lock — goes
// through `createSshTransport({ssh})`. Docker itself goes over `DOCKER_HOST=ssh://`
// (`createDockerCtl({dockerHost})`); this module never runs docker.
//
// ⛔ ssh JOINS its remote argv with spaces into ONE string and the remote login shell
// RE-PARSES it (r7x2 §1b). An argv array does not survive the hop, and `--` only ends
// LOCAL option parsing. So every element is POSIX single-quoted here, before it is sent,
// and a NUL byte (which no shell string can carry) is refused rather than truncated.
//
// ⚠ The quoting is POSIX-shell quoting. It assumes the target user's login shell parses
// single quotes the POSIX way (sh, bash, dash, zsh, ksh do). A csh-family login shell
// does not accept a newline inside single quotes.
//
// The connection is dedicated and non-interactive (btg4 §5, rm7t §1): BatchMode (never
// prompt), a connect timeout, no connection sharing (ControlMaster=no, ControlPath=none —
// an operator's multiplexed master must not carry our commands), no agent forwarding.
//
// `sshBin` is injectable, so a recording stub stands in for ssh in tests (nl0c §5.1);
// `child_process.spawn` is read at call time, so the monkey-patch seam of docker-ctl.js
// works here too.
//
// Tag: [WEBCTL::CDP]

// Indirect import so tests can monkey-patch child_process.spawn.
import child_process from 'node:child_process';

import { SSH_ALIAS_RE } from './remotes.js';

/**
 * POSIX single-quote ONE argument for a shell: always quoted, `'` written as `'\''`.
 * The result is exactly one word to any POSIX shell, with nothing inside it expanded.
 * @param {unknown} s  non-strings are String()-ed
 * @returns {string}
 */
export function shQuote(s) {
  const str = String(s);
  if (str.includes('\0')) {
    throw new Error('shQuote: an argument contains a NUL byte, which no shell string can carry');
  }
  return `'${str.replaceAll("'", "'\\''")}'`;
}

/**
 * The options every transport call passes to ssh, before `--` and the alias.
 * @type {readonly string[]}
 */
export const SSH_BASE_OPTS = Object.freeze([
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ControlMaster=no',
  '-o', 'ControlPath=none',
  '-o', 'ForwardAgent=no',
  '-o', 'LogLevel=ERROR',
]);

/** Grace between SIGTERM and SIGKILL once a call has timed out. */
const KILL_GRACE_MS = 2000;

/**
 * @typedef {object} TransportResult
 * @property {number} code    exit code (127 on spawn error; non-zero on timeout)
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} SshTransport
 * @property {string} alias
 * @property {(argv: string[]) => string[]} argvFor  the exact argv handed to sshBin
 * @property {(argv: string[], opts?: {input?: string|Buffer, timeoutMs?: number}) => Promise<TransportResult>} run
 */

/**
 * @param {unknown} argv
 * @returns {string[]}
 */
function checkArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('ssh transport: argv must be a non-empty array of strings');
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error('ssh transport: argv must be a non-empty array of strings');
    }
  }
  return /** @type {string[]} */ (argv);
}

/**
 * An ssh transport bound to ONE target alias.
 * @param {{ssh: string, sshBin?: string}} opts
 * @returns {SshTransport}
 */
export function createSshTransport({ ssh, sshBin = 'ssh' }) {
  if (typeof ssh !== 'string' || !SSH_ALIAS_RE.test(ssh)) {
    // Never echo the value: a rejected alias may be an injection attempt or a typo'd
    // host the caller would not want in a log.
    throw new Error('ssh transport: `ssh` must be an ssh alias of letters, digits, ".", "_", "-", '
      + 'never starting with "-" (ssh would read it as an option)');
  }
  const alias = ssh;

  /** @param {string[]} argv */
  function argvFor(argv) {
    const a = checkArgv(argv);
    return [...SSH_BASE_OPTS, '--', alias, a.map(shQuote).join(' ')];
  }

  /**
   * @param {string[]} argv
   * @param {{input?: string|Buffer, timeoutMs?: number}} [opts]
   * @returns {Promise<TransportResult>}
   */
  function run(argv, { input, timeoutMs = 30000 } = {}) {
    const sshArgv = argvFor(argv);
    return new Promise((resolve) => {
      const child = child_process.spawn(sshBin, sshArgv, { stdio: ['pipe', 'pipe', 'pipe'] });
      /** @type {Buffer[]} */
      const out = [];
      /** @type {Buffer[]} */
      const err = [];
      let settled = false;
      let timedOut = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let killTimer = null;

      /** @param {number} code @param {string} [note] */
      function finish(code, note) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        const stderr = Buffer.concat(err).toString('utf8') + (note || '');
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr });
      }
      const timeoutNote = () => `\nssh transport: timed out after ${timeoutMs} ms; sent SIGTERM\n`;

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        // A child that ignores SIGTERM must not hang the caller.
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          finish(124, timeoutNote());
        }, KILL_GRACE_MS);
      }, timeoutMs);

      child.stdout.on('data', (b) => { out.push(b); });
      child.stderr.on('data', (b) => { err.push(b); });
      // EPIPE when the remote command exits without reading its stdin is not an error.
      child.stdin.on('error', () => {});

      child.on('error', (e) => finish(127, String(e.message)));
      // On timeout, resolve at EXIT: a grandchild may still hold the pipes open, and
      // waiting for 'close' would wait for it.
      child.on('exit', () => { if (timedOut) finish(124, timeoutNote()); });
      child.on('close', (code) => finish(code == null ? 1 : code));

      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  return { alias, argvFor, run };
}

/**
 * @typedef {{ok: true, home: string, uid: number, gid: number}
 *   | {ok: false, error: string, stderr?: string}} TargetFacts
 */

/** The ONE remote command targetFacts sends: three lines, home / uid / gid. */
const FACTS_ARGV = Object.freeze(['sh', '-c', 'printf "%s\\n%s\\n%s\\n" "$HOME" "$(id -u)" "$(id -g)"']);

/**
 * Read the target user's `$HOME`, `id -u`, `id -g` in ONE transport call (rb7s §3).
 * Never defaults a value: anything unreadable is an error naming which field.
 * @param {Pick<SshTransport, 'run'>} transport
 * @returns {Promise<TargetFacts>}
 */
export async function targetFacts(transport) {
  const r = await transport.run([...FACTS_ARGV]);
  if (r.code !== 0) {
    return { ok: false, error: `target facts: transport exited with code ${r.code}`, stderr: r.stderr };
  }
  const lines = r.stdout.split('\n');
  // Exactly three newline-terminated lines: the split leaves one trailing ''.
  const [home, uid, gid, ...rest] = lines;
  if (home === undefined || home === '' || !home.startsWith('/')) {
    return { ok: false, error: 'target facts: home could not be read (not an absolute path)' };
  }
  if (uid === undefined || !/^\d+$/.test(uid) || !Number.isSafeInteger(Number(uid))) {
    return { ok: false, error: 'target facts: uid could not be read (not a decimal number)' };
  }
  if (gid === undefined || !/^\d+$/.test(gid) || !Number.isSafeInteger(Number(gid))) {
    return { ok: false, error: 'target facts: gid could not be read (not a decimal number)' };
  }
  if (rest.length !== 1 || rest[0] !== '') {
    return { ok: false, error: 'target facts: unexpected output after the gid line' };
  }
  return { ok: true, home, uid: Number(uid), gid: Number(gid) };
}
