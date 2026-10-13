// isolated-with-docker.mjs — run `isolated` with a FAKE docker CLI (ib4k §3a.5: units record every invocation).
//
// ⛔ The seam (runIsolated's `dockerBin`) is reachable ONLY by importing the harness — never an env var or a flag
// of the CLI — so a production run always takes docker from the system dirs. Everything else `isolated` reads is
// the real host's.
// argv: <harness.mjs> <fake docker> <the args after the `isolated` verb…>
import { pathToFileURL } from 'node:url';

const [harnessPath, dockerBin, ...args] = process.argv.slice(2);
const harness = await import(pathToFileURL(harnessPath).href);
process.exit(await harness.runIsolated(args, { dockerBin }));
