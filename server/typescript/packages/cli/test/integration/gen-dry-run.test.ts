import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
// Place temp dirs inside the monorepo so workspace packages (@metaobjectsdev/*)
// are resolvable by jiti when it loads metaobjects.config.ts.
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

describe("meta gen --dry-run", () => {
  test("returns 0 (v0.1 limitation: files still written; output marks --dry-run)", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-dryrun-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
    // outDir is an absolute path inside the temp root so generated files never
    // land in the cli package's own src/ — codegen-ts v0.1 writes even on
    // --dry-run, so the path must be sandboxed regardless of process.cwd().
    const outDir = join(root, "generated", "db");
    writeFileSync(
      join(root, "metaobjects.config.ts"),
      `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
    );
    try {
      const exit = await run(["gen", "--cwd", root, "--dry-run"]);
      expect(exit).toBe(0);
      // v0.1 limitation: codegen-ts has no internal no-write mode; files ARE
      // written but the output marks "--dry-run". Tighten when codegen-ts
      // gains true dry-run in v0.3.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
