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
 * @param {{labels?: Record<string,string>, binds?: string[]}} [o]
 */
export function inspectPresent(name, o = {}) {
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify([{
      Name: `/${name}`,
      Config: { Labels: o.labels || {} },
      Mounts: (o.binds || []).map((s) => ({ Type: 'bind', Source: s, Destination: '/somewhere' })),
    }]),
  };
}

/**
 * A `run` for fakes in which no container exists: inspect → absent, anything
 * else → `other`.
 * @param {{code: number, stdout: string, stderr: string}} [other]
 */
export function runAbsent(other = { code: 0, stdout: '', stderr: '' }) {
  return async (/** @type {string[]} */ args) => (args[0] === 'inspect' ? INSPECT_ABSENT : other);
}
