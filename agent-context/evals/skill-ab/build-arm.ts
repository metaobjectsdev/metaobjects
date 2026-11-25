// Assemble the installed skill tree for one A/B arm, per stack, from a content root.
//   bun build-arm.ts <repo-root> <content-root> <out-dir>
// Writes <out-dir>/<stack>/{.claude/skills/...,.metaobjects/AGENTS.md}, and adds the
// pre-adoption fit-assessment skill (never scaffolded) beside the six scaffolded ones.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 3) throw new Error("usage: build-arm.ts <repo-root> <content-root> <out-dir>");
// Resolved, because a relative path handed to import() is read as a package name.
const [repo, contentRoot, outDir] = args.map((a) => resolve(a));
const sdk = join(repo, "server/typescript/packages/sdk/src/agent-context");
const { assemble } = await import(join(sdk, "assemble.ts"));
const { makeStack } = await import(join(sdk, "resolve.ts"));

const STACKS: Record<string, { servers: string[]; clients: string[] }> = {
  "ts-react-tanstack": { servers: ["typescript"], clients: ["react", "tanstack"] },
  python: { servers: ["python"], clients: [] },
  "java-react": { servers: ["java"], clients: ["react"] },
};

rmSync(outDir, { recursive: true, force: true });
for (const [id, spec] of Object.entries(STACKS)) {
  const files = assemble({ contentRoot, stack: makeStack(spec.servers as never, spec.clients as never) });
  for (const f of files) {
    const out = join(outDir, id, f.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, f.contents);
  }
  cpSync(
    join(contentRoot, "skills/metaobjects-fit-assessment"),
    join(outDir, id, ".claude/skills/metaobjects-fit-assessment"),
    { recursive: true },
  );
  console.log(`${id}: ${files.length} files`);
}
