// Regenerate the agent-context conformance goldens from the assembler.
// Run after an intentional change to assemble() (e.g. deploy-all references):
//   bun scripts/regen-agent-context-conformance.ts
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { assemble } from "../src/agent-context/assemble.js";
import { makeStack } from "../src/agent-context/resolve.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../agent-context");
const CORPUS = join(import.meta.dir, "../../../../../fixtures/agent-context-conformance");

for (const name of readdirSync(CORPUS)) {
  const dir = join(CORPUS, name);
  if (!existsSync(join(dir, "stack.json"))) continue;
  const spec = JSON.parse(readFileSync(join(dir, "stack.json"), "utf8")) as {
    servers: string[];
    clients: string[];
  };
  const stack = makeStack(spec.servers as never, spec.clients as never);
  const files = assemble({ contentRoot: CONTENT_ROOT, stack });
  const expDir = join(dir, "expected");
  rmSync(expDir, { recursive: true, force: true });
  for (const f of files) {
    const out = join(expDir, f.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, f.contents);
  }
  console.log(`${name} -> ${files.length} files`);
}
