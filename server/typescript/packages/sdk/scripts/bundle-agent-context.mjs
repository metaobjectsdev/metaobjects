import { cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ → package root → walk up to the monorepo agent-context/
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir = pkgDir, src = "";
for (let i = 0; i < 8; i++) {
  const cand = join(dir, "agent-context", "skills", "metaobjects-authoring", "SKILL.md");
  if (existsSync(cand) && dir !== pkgDir) { src = join(dir, "agent-context"); break; }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
if (!src) { console.error("monorepo agent-context/ not found to bundle"); process.exit(1); }
const dest = join(pkgDir, "agent-context");
rmSync(dest, { recursive: true, force: true });
// evals/ is the test harness for the skills (trigger cases, the skill A/B), not content an
// installed project reads, so it stays out of the bundle and therefore out of the npm package.
const evals = join(src, "evals");
cpSync(src, dest, { recursive: true, filter: (from) => from !== evals });
console.log("bundled agent-context →", dest);
