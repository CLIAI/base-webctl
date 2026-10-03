// fake-docker-inspect.mjs — what a fake docker answers to `docker inspect`.
//
// The docker driver proves a computed-name container ours (or absent) through
// `docker.run(['inspect', …])` before any rm or stop. A fake docker that spreads
// the real module and does not answer `run` would reach the REAL docker CLI on
// the host running the suite — so every fake that drives bring-up or shutdown
// answers inspect explicitly, through these.

/** Exactly what docker says for a name that does not exist (exit 1). */
export const INSPECT_ABSENT = Object.freeze({
  code: 1, stdout: '[]\n', stderr: 'Error: No such object: (fake)\n',
});

/**
 * A successful inspect of one container.
 * @param {string} name  exact container name
 * @param {{labels?: Record<string,string>, binds?: string[], volumes?: string[], ports?: number[]}} [o]
 *   `volumes`: NAMED volumes (Type volume) — never ownership evidence.
 *   `ports`: host ports it was started with (HostConfig.PortBindings).
 */
export function inspectPresent(name, o = {}) {
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify([{
      Name: `/${name}`,
      Config: { Labels: o.labels || {} },
      HostConfig: { PortBindings: Object.fromEntries((o.ports || []).map((p) => [
        `${p}/tcp`, [{ HostIp: '127.0.0.1', HostPort: String(p) }]])) },
      Mounts: [
        ...(o.binds || []).map((s) => ({ Type: 'bind', Source: s, Destination: '/somewhere' })),
        // A named volume's Source is under docker's data root — absolute, so a
        // driver that read it as a bind would be wrong, and this would show it.
        ...(o.volumes || []).map((n) => ({
          Type: 'volume', Name: n, Source: `/var/lib/docker/volumes/${n}/_data`, Destination: '/tmp/.X11-unix',
        })),
      ],
    }]),
  };
}

/**
 * ⛔ A fake docker that CANNOT reach the real CLI (k3wn: behaviourally hermetic).
 *
 * Fakes used to be `{ ...realDocker, <overrides> }`. Every method NOT overridden
 * was then the real one — and the real methods spawn `docker` through their own
 * closure, not through the fake's `run`. So a fake whose driver grew a new call
 * reached the operator's daemon and PASSED or FAILED by what happened to be on
 * it. Measured while adding the ownership inspect: three fakes would have
 * passed only because the containers were absent on the machine running them.
 *
 * Here an unstubbed METHOD, or a `run` of an unstubbed VERB (args[0]), records a
 * violation and throws. The throw alone is not enough — the driver catches some
 * errors (an inspect that throws is a refusal, a failed teardown rm is
 * swallowed) — so callers also assert `violations` is empty.
 *
 * @param {Record<string, any>} stubs  method name → implementation
 * @param {{run?: Record<string, (args: string[]) => any>}} [o]
 *   `run` verb → handler; absent means `run` itself is unstubbed.
 * @returns {{docker: any, violations: string[]}}
 */
export function guardedDocker(stubs, o = {}) {
  /** @type {string[]} */
  const violations = [];
  /** @param {string} what */
  const refuse = (what) => {
    violations.push(what);
    throw new Error(`hermetic fake docker: ${what} is not stubbed — it would reach the real docker CLI`);
  };
  /** @type {Record<string, any>} */
  const target = { ...stubs };
  if (o.run) {
    const verbs = o.run;
    target.run = async (/** @type {string[]} */ args) => (
      Object.prototype.hasOwnProperty.call(verbs, args[0])
        ? verbs[args[0]](args)
        : refuse(`docker.run(${JSON.stringify(args)})`));
  }
  const docker = new Proxy(target, {
    get(t, p) {
      // Symbols and `then` are probed by the runtime (await, inspection), not by
      // the driver; answering them as "unstubbed" would be a false violation.
      if (typeof p === 'symbol' || p === 'then' || p in t) return t[/** @type {any} */ (p)];
      return (/** @type {any[]} */ ...args) => refuse(`docker.${p}(${JSON.stringify(args)})`);
    },
  });
  return { docker, violations };
}

/**
 * Fail loudly if a guarded fake was asked for anything unstubbed — even when
 * the driver caught the throw.
 * @param {string[]} violations
 */
export function assertHermetic(violations) {
  if (violations.length) {
    throw new Error(
      `NOT HERMETIC: the driver asked the fake docker for ${violations.length} unstubbed call(s), ` +
      `each of which would have reached the real docker CLI:\n  ${violations.join('\n  ')}`);
  }
}

/**
 * What `docker inspect` reports for a container started with these
 * `runDetached` opts: its labels, and its BIND mounts (an absolute source; a
 * named volume is not a bind) — the evidence the driver proves ownership by.
 * @param {any} runOpts
 */
export function inspectFromRun(runOpts) {
  const binds = (runOpts.mounts || [])
    .map((/** @type {any} */ m) => (Array.isArray(m) ? m[0] : m && m.src))
    .filter((/** @type {any} */ s) => typeof s === 'string' && s.startsWith('/'));
  return inspectPresent(runOpts.name, { labels: runOpts.labels || {}, binds });
}
