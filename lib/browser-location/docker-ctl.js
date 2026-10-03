// Thin docker-CLI wrapper for the chromium-docker-xpra-* drivers.
//
// Adapted from xq (26Q2-docker-xpra-x11-apps), commit 64e5f9d
// Original: scripts/lib/dockerctl.py
// License: MIT (confirmed with author 2026-05-27)
//
// Zero-dep Node port — uses only child_process.spawn. Same narrow shape
// as the python original: each function runs one docker verb;
// higher-level orchestration lives in the driver.
//
// Multi-tenant safety: every function that affects container state
// takes an exact container name and matches it as a literal (^name$
// anchors on `docker ps --filter name=`). NEVER pass a substring or
// glob — `<prefix>xpra-default` must not accidentally stop
// `<prefix>xpra-default-extra`.
//
// Tag: [TOOL::*] [WEBCTL::CDP]
//
// ESM port for base-webctl (sb7q). Authored as zero-dependency modern ESM
// with JSDoc types (checked by `tsc --checkJs` in base CI only). The default
// import + call-time property access on `child_process` is deliberate: it
// preserves the monkey-patch seam the consumer unit suites rely on
// (`require('node:child_process').spawn = mock`), since ESM `import cp from
// 'node:child_process'` and CJS `require('node:child_process')` resolve to the
// same mutable builtin module.exports object.

// Indirect import so tests can monkey-patch child_process.spawn.
import child_process from 'node:child_process';

/**
 * @typedef {object} RunResult
 * @property {string} stdout  captured stdout (empty when capture=false)
 * @property {string} stderr  captured stderr (empty when capture=false)
 * @property {number} code    process exit code (127 on spawn error)
 */

/**
 * Build one docker-ctl bound to a context. `ctx.env` is merged into every docker
 * child's environment (and ONLY the child's — the operator's process.env is never
 * mutated). The module's own exports are `make({env: {}})`: unchanged behaviour.
 * @param {{env: Record<string, string>}} ctx
 */
function make(ctx) {
  /**
   * Low-level docker invocation.
   *
   * @param {string[]} args  argv after the docker binary
   * @param {object}   [opts]
   * @param {boolean}  [opts.capture=true]   collect stdout/stderr (else inherit)
   * @param {Record<string,string>} [opts.env]  extra env vars
   * @param {(stream: string, line: string) => void} [opts.onStderrLine]  per-line stderr callback (capture=false flows)
   * @param {number}   [opts.timeoutMs]      hard timeout (kill on exceed)
   * @returns {Promise<RunResult>}
   */
  function run(args, opts) {
    const o = opts || {};
    const capture = o.capture !== false;
    return new Promise((resolve) => {
      const child = child_process.spawn('docker', args, {
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: Object.assign({}, process.env, ctx.env, o.env || {}),
      });

      let stdout = '';
      let stderr = '';
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;

      if (capture) {
        child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
        child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
      }
      if (o.timeoutMs) {
        timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
        }, o.timeoutMs);
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr: stderr + String(err.message), code: 127 });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, code: code == null ? 1 : code });
      });
    });
  }

  /**
   * Async-streaming variant for `docker build` and `docker logs --follow`.
   * Streams every stdout/stderr line through cb(stream, line) and resolves
   * with the final exit code. capture is implied false (output goes through cb).
   *
   * @param {string[]} args
   * @param {(stream: string, line: string) => void} cb  stream is 'stdout'|'stderr'
   * @returns {Promise<number>} exit code
   */
  function stream(args, cb) {
    return new Promise((resolve) => {
      const child = child_process.spawn('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, ctx.env),
      });
      /** @type {{stdout: string, stderr: string}} */
      const buffers = { stdout: '', stderr: '' };
      /**
       * @param {'stdout'|'stderr'} streamName
       * @param {Buffer} chunk
       */
      function feed(streamName, chunk) {
        buffers[streamName] += chunk.toString('utf8');
        let nl;
        while ((nl = buffers[streamName].indexOf('\n')) !== -1) {
          const line = buffers[streamName].slice(0, nl);
          buffers[streamName] = buffers[streamName].slice(nl + 1);
          try { cb(streamName, line); } catch {}
        }
      }
      child.stdout.on('data', (b) => feed('stdout', b));
      child.stderr.on('data', (b) => feed('stderr', b));
      child.on('error', () => resolve(127));
      child.on('close', (code) => {
        // Flush any trailing partial line
        for (const s of /** @type {const} */ (['stdout', 'stderr'])) {
          if (buffers[s]) { try { cb(s, buffers[s]); } catch {} }
        }
        resolve(code == null ? 1 : code);
      });
    });
  }

  /** @returns {Promise<boolean>} */
  async function dockerAvailable() {
    const r = await run(['version', '--format', '{{.Client.Version}}'], { timeoutMs: 5000 });
    return r.code === 0;
  }

  /**
   * @param {string} tag
   * @returns {Promise<boolean>}
   */
  async function imageExists(tag) {
    const r = await run(['image', 'inspect', tag]);
    return r.code === 0;
  }

  /**
   * @param {string} name  exact container name (matched as `^name$`)
   * @returns {Promise<boolean>}
   */
  async function containerExists(name) {
    const r = await run(['ps', '-a', '--filter', `name=^${escapeRe(name)}$`,
                         '--format', '{{.Names}}']);
    if (r.code !== 0) return false;
    return r.stdout.split('\n').map(s => s.trim()).includes(name);
  }

  /**
   * @param {string} name  exact container name (matched as `^name$`)
   * @returns {Promise<boolean>}
   */
  async function containerRunning(name) {
    const r = await run(['ps', '--filter', `name=^${escapeRe(name)}$`,
                         '--filter', 'status=running', '--format', '{{.Names}}']);
    if (r.code !== 0) return false;
    return r.stdout.split('\n').map(s => s.trim()).includes(name);
  }

  /**
   * @param {string} label  docker label filter value, e.g. `project.role=chromium`
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async function psByLabel(label) {
    const r = await run(['ps', '--no-trunc', '--all', '--format', '{{json .}}',
                         '--filter', `label=${label}`]);
    if (r.code !== 0) return [];
    /** @type {Array<Record<string, any>>} */
    const out = [];
    for (const raw of r.stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  }

  /**
   * @param {string} name  exact network name (matched as `^name$`)
   * @returns {Promise<boolean>}
   */
  async function networkExists(name) {
    const r = await run(['network', 'ls', '--filter', `name=^${escapeRe(name)}$`,
                         '--format', '{{.Name}}']);
    if (r.code !== 0) return false;
    return r.stdout.split('\n').map(s => s.trim()).includes(name);
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async function networkCreate(name) {
    if (await networkExists(name)) return;
    await run(['network', 'create', name]);
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async function networkRm(name) {
    if (!await networkExists(name)) return;
    await run(['network', 'rm', name]);
  }

  /**
   * @param {string} name  exact volume name (matched as `^name$`)
   * @returns {Promise<boolean>}
   */
  async function volumeExists(name) {
    const r = await run(['volume', 'ls', '--filter', `name=^${escapeRe(name)}$`,
                         '--format', '{{.Name}}']);
    if (r.code !== 0) return false;
    return r.stdout.split('\n').map(s => s.trim()).includes(name);
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async function volumeCreate(name) {
    if (await volumeExists(name)) return;
    await run(['volume', 'create', name]);
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async function volumeRm(name) {
    if (!await volumeExists(name)) return;
    await run(['volume', 'rm', name]);
  }

  /**
   * @param {string} name  exact container name
   * @param {object} [opts]
   * @param {number} [opts.graceSeconds=5]  `docker stop -t` grace period
   * @returns {Promise<void>}
   */
  async function stop(name, opts) {
    const o = opts || {};
    if (!await containerExists(name)) return;
    const grace = o.graceSeconds == null ? 5 : o.graceSeconds;
    await run(['stop', '-t', String(grace), name], { timeoutMs: (grace + 10) * 1000 });
  }

  /**
   * @param {string} name  exact container name
   * @param {object} [opts]
   * @param {boolean} [opts.force]  `docker rm -f`
   * @returns {Promise<void>}
   */
  async function rm(name, opts) {
    const o = opts || {};
    if (!await containerExists(name)) return;
    const args = ['rm'];
    if (o.force) args.push('-f');
    args.push(name);
    await run(args);
  }

  /**
   * @param {string}   name  exact container name
   * @param {string[]} cmd   argv to exec inside the container
   * @param {object}   [opts]
   * @param {string}   [opts.user]      `docker exec -u`
   * @param {number}   [opts.timeoutMs]
   * @returns {Promise<RunResult>}
   */
  function exec(name, cmd, opts) {
    const o = opts || {};
    const args = ['exec'];
    if (o.user) args.push('-u', o.user);
    args.push(name, ...cmd);
    return run(args, { timeoutMs: o.timeoutMs });
  }

  /**
   * Streaming `docker build`. Resolves with the exit code.
   *
   * @param {object}   opts
   * @param {string}   opts.context    build context directory
   * @param {string}   opts.tag        target tag, e.g. <repo>/chromium-ubuntu:latest
   * @param {Record<string,string>} [opts.buildArgs] e.g. { UID: '1000', GID: '1000' }
   * @param {string}   [opts.dockerfile] override Dockerfile path
   * @param {boolean}  [opts.noCache=false]
   * @param {(stream: string, line: string) => void} [opts.onLine]  per-line callback
   * @returns {Promise<number>} exit code
   */
  async function build(opts) {
    const args = ['build'];
    if (opts.noCache) args.push('--no-cache');
    if (opts.dockerfile) args.push('-f', opts.dockerfile);
    for (const [k, v] of Object.entries(opts.buildArgs || {})) {
      args.push('--build-arg', `${k}=${v}`);
    }
    args.push('-t', opts.tag, opts.context);
    if (opts.onLine) {
      return stream(args, opts.onLine);
    }
    const r = await run(args, { capture: false });
    return r.code;
  }

  /**
   * @typedef {[string, string, string]} TupleMount  [host, ctr, mode]
   * @typedef {{src: string, dst: string, mode?: string, isVolume?: boolean}} ObjectMount
   */

  /**
   * Run a container detached. Mirrors xq's run_detached() shape.
   *
   * @param {object}   opts
   * @param {string}   opts.name
   * @param {string}   opts.image
   * @param {Record<string,string>} [opts.env]  { KEY: 'value' }
   * @param {Array<TupleMount | ObjectMount>} [opts.mounts]
   * @param {Array<[string, string, number]>} [opts.publish]  [host_ip, host_port_str, ctr_port_num]
   * @param {string}   [opts.network]  --network value
   * @param {string}   [opts.shmSize]  e.g. '512m'
   * @param {Record<string,string>} [opts.labels]
   * @param {string[]} [opts.extra]    extra docker-run args inserted before image
   * @param {string[]} [opts.cmd]      args after the image
   * @returns {Promise<RunResult>}
   */
  async function runDetached(opts) {
    const args = ['run', '-d', '--name', opts.name];
    for (const [k, v] of Object.entries(opts.env || {})) {
      args.push('-e', `${k}=${v}`);
    }
    for (const m of (opts.mounts || [])) {
      if (Array.isArray(m) && m.length === 3) {
        args.push('-v', `${m[0]}:${m[1]}:${m[2]}`);
      } else if (m && !Array.isArray(m)) {
        // {src, dst, mode, isVolume}
        args.push('-v', `${m.src}:${m.dst}:${m.mode || 'rw'}`);
      }
    }
    for (const p of (opts.publish || [])) {
      args.push('-p', `${p[0]}:${p[1]}:${p[2]}`);
    }
    if (opts.network) args.push('--network', opts.network);
    if (opts.shmSize) args.push(`--shm-size=${opts.shmSize}`);
    for (const [k, v] of Object.entries(opts.labels || {})) {
      args.push('--label', `${k}=${v}`);
    }
    for (const e of (opts.extra || [])) args.push(e);
    args.push(opts.image);
    for (const c of (opts.cmd || [])) args.push(c);
    return run(args);
  }

  /**
   * @param {string} name  exact container name
   * @param {object} [opts]
   * @param {boolean} [opts.follow]  `docker logs -f`
   * @param {number}  [opts.tail]    `docker logs --tail`
   * @returns {Promise<RunResult>}
   */
  function logs(name, opts) {
    const o = opts || {};
    const args = ['logs'];
    if (o.follow) args.push('-f');
    if (o.tail != null) args.push('--tail', String(o.tail));
    args.push(name);
    return run(args, { capture: false });
  }


  return { run, stream, dockerAvailable, imageExists, containerExists, containerRunning, psByLabel, networkExists, networkCreate, networkRm, volumeExists, volumeCreate, volumeRm, stop, rm, exec, build, runDetached, logs };
}

const DEFAULT = make({ env: {} });
export const { run, stream, dockerAvailable, imageExists, containerExists, containerRunning, psByLabel, networkExists, networkCreate, networkRm, volumeExists, volumeCreate, volumeRm, stop, rm, exec, build, runDetached, logs } = DEFAULT;

/**
 * A docker-ctl that runs every verb against a REMOTE daemon through docker's own ssh
 * transport (`DOCKER_HOST=ssh://<alias>`), including `build` — the context is streamed,
 * so nothing is copied by hand (rb7s §2). Same interface as this module; pass it to the
 * driver as `opts.docker`.
 *
 * ⚠ That alone does NOT make a remote bring-up: the driver's paths, uid/gid, port check,
 * prefs and lock are still local until it is also given a transport and target facts
 * (rb7s §1, phase 2).
 * @param {{dockerHost: string}} o  `ssh://<alias>`, alias as in ~/.ssh/config
 */
export function createDockerCtl(o) {
  const h = o && o.dockerHost;
  if (typeof h !== 'string' || !/^ssh:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(h)) {
    throw new Error('createDockerCtl: dockerHost must be ssh://<alias> (an ssh_config alias, no leading dash)');
  }
  return { ...make({ env: { DOCKER_HOST: h } }), dockerHost: h };
}

/**
 * Escape regex metacharacters so a name can be anchored as `^name$` in a
 * `docker --filter name=` expression (the multi-tenant exact-match primitive).
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exposed for tests (the `_`-prefixed escape primitive the suites assert on).
export { escapeRe as _escapeRe };
