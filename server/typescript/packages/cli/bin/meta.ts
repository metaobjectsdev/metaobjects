#!/usr/bin/env node
// Note: this .ts source file is executed by Bun in the workspace (not Node).
// The shebang stays as `node` so tsc copies it unchanged to dist/bin/meta.js,
// keeping the published CLI runnable by Node for npm consumers.
//
// A bare version probe is answered here, from a leaf module that imports only node
// builtins, BEFORE the command graph loads. `src/index.ts` statically pulls in the sdk
// and codegen-ts, so answering `--version` there cost ~10x a bare `node` start on every
// probe. Everything else — including a version flag in any other position — falls
// through to `run()`, which stays the single owner of the general case.
import { cliVersion, isVersionFlag } from "../src/lib/version.js";

const argv = process.argv.slice(2);
if (argv.length === 1 && isVersionFlag(argv[0])) {
  console.log(cliVersion());
  process.exit(0);
}
const { run } = await import("../src/index.js");
process.exit(await run(argv));
