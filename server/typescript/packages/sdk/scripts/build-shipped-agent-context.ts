// Assemble the static agent files every non-TypeScript port ships, into `agent-context-shipped/`
// at the repository root (1.3.0 design call 17). Each port's package build embeds that tree and
// its own `agent-docs` command copies a stack out of it, so no port needs Node for these files.
//
//   bun scripts/build-shipped-agent-context.ts           write the tree (only files whose bytes changed)
//   bun scripts/build-shipped-agent-context.ts --check   exit 1, naming each file, when it is stale
//
// The drift test (`test/agent-context/shipped.test.ts`) runs the same comparison in memory.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { buildShippedAgentContext, shippedTreeFiles } from "../src/agent-context/shipped.js";

const REPO_ROOT = join(import.meta.dir, "../../../../..");
const CONTENT_ROOT = join(REPO_ROOT, "agent-context");
const OUT = join(REPO_ROOT, "agent-context-shipped");
const README = "README.md";

function onDisk(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
    }
  };
  walk(root);
  out.delete(README); // hand-written, not built
  return out;
}

const want = shippedTreeFiles(buildShippedAgentContext(CONTENT_ROOT));
const have = onDisk(OUT);
const stale = [...want].filter(([p, c]) => have.get(p) !== c).map(([p]) => p);
const extra = [...have.keys()].filter((p) => !want.has(p));

if (process.argv.includes("--check")) {
  if (stale.length === 0 && extra.length === 0) {
    console.log(`agent-context-shipped is current (${want.size} files)`);
    process.exit(0);
  }
  for (const p of stale) console.error(`stale: agent-context-shipped/${p}`);
  for (const p of extra) console.error(`not built: agent-context-shipped/${p}`);
  console.error("Run: bun server/typescript/packages/sdk/scripts/build-shipped-agent-context.ts");
  process.exit(1);
}

for (const p of stale) {
  const abs = join(OUT, p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, want.get(p)!);
}
for (const p of extra) rmSync(join(OUT, p));
console.log(`agent-context-shipped: ${stale.length} written, ${extra.length} removed, ${want.size} files`);
