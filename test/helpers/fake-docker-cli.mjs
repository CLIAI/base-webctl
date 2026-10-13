#!/usr/bin/env node
// fake-docker-cli.mjs — a FAKE `docker` that RECORDS every invocation (ib4k §3a.5) and answers just enough for the
// docker backend to reach `create` and `start`. It never runs a container: `start` exits 0 at once, so the harness
// reports "docker exited 0 before the isolated side reported in" — the units judge the RECORDED argv, not a run.
//
// It reads two WEBCTL_* vars (the only ones the harness's CLI env keeps): WEBCTL_FAKE_DOCKER_LOG, the file each
// argv is appended to as a JSON line; WEBCTL_FAKE_DOCKER_MODE, a comma list of: `rootless`, `noseccomp`,
// `noimage`, `badlabel`, `hangrm` (rm never returns), `failrm`.
// WEBCTL_FAKE_DOCKER_RECIPE: the recipe hash `image inspect` answers with.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const log = process.env.WEBCTL_FAKE_DOCKER_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify(argv)}\n`);
const mode = new Set((process.env.WEBCTL_FAKE_DOCKER_MODE || '').split(',').filter(Boolean));
const rest = argv[0] === '-H' ? argv.slice(2) : argv;
const verb = rest[0] === 'image' ? `image ${rest[1]}` : rest[0];
const out = (/** @type {string} */ s) => { process.stdout.write(s); process.exit(0); };

switch (verb) {
  case 'version': out('29.0.0-fake\n'); break;
  case 'info': {
    const sec = ['name=apparmor', ...(mode.has('noseccomp') ? [] : ['name=seccomp,profile=builtin']), 'name=cgroupns', ...(mode.has('rootless') ? ['name=rootless'] : [])];
    out(`${JSON.stringify(sec)}\n`);
    break;
  }
  case 'image inspect':
    if (mode.has('noimage')) { process.stderr.write('Error: No such image\n'); process.exit(1); }
    out(`sha256:${'a'.repeat(64)} ${mode.has('badlabel') ? 'not-this-recipe' : process.env.WEBCTL_FAKE_DOCKER_RECIPE || ''}\n`);
    break;
  case 'create': out(`${'b'.repeat(64)}\n`); break;
  case 'start': process.exit(0); break;
  case 'rm':
    if (mode.has('hangrm')) { setInterval(() => {}, 1 << 30); break; }
    if (mode.has('failrm')) { process.stderr.write('Error: cannot remove\n'); process.exit(1); }
    process.exit(0);
    break;
  default: process.exit(0);
}
