// isolated-with-mounts.mjs — run `isolated` with a FAKE mount table for the cgroup2 `nsdelegate` check.
//
// ⛔ The seam (runIsolated's `readHostMounts`) is reachable ONLY by importing the harness — never an
// env var or a flag of the CLI — so a production run cannot be told to skip the check. Everything
// else `isolated` reads (the keeps, the masks, the read-backs inside) is the real host's.
// argv: <harness.mjs> <mountinfo-file> <the args after the `isolated` verb…>
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [harnessPath, mountinfoFile, ...args] = process.argv.slice(2);
const harness = await import(pathToFileURL(harnessPath).href);
const fake = harness.parseMountinfo(fs.readFileSync(mountinfoFile, 'utf8'));
process.exit(await harness.runIsolated(args, { readHostMounts: () => fake }));
