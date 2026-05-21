#!/usr/bin/env node
// Note: this .ts source file is executed by Bun in the workspace (not Node).
// The shebang stays as `node` so tsc copies it unchanged to dist/bin/meta.js,
// keeping the published CLI runnable by Node for npm consumers.
import { run } from "../src/index.js";
run(process.argv.slice(2)).then((code) => process.exit(code));
