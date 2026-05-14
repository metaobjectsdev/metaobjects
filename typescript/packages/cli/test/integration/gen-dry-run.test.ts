import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve("packages/cli/test/fixtures");
// Place temp dirs inside the monorepo so workspace packages (@metaobjects/*)
// are resolvable by jiti when it loads metaobjects.config.ts.
const WORKSPACE_TMP = resolve("packages/cli/test/fixtures/__tmp__");

describe("meta gen --dry-run", () => {
  test("returns 0 (v0.1 limitation: files still written; output marks --dry-run)", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-dryrun-"));
    cpSync(join(FIXTURES, "downstream-consumer-meta"), root, { recursive: true });
    writeFileSync(
      join(root, "metaobjects.config.ts"),
      `
import { defineConfig } from "@metaobjects/codegen-ts";
import { entityFile } from "@metaobjects/codegen-ts/generators";
export default defineConfig({
  outDir: "./src/db",
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
    );
    const orig = process.cwd();
    process.chdir(root);
    try {
      const exit = await run(["gen", "--dry-run"]);
      expect(exit).toBe(0);
      // v0.1 limitation: codegen-ts has no internal no-write mode; files ARE
      // written but the output marks "--dry-run". Tighten when codegen-ts
      // gains true dry-run in v0.3.
    } finally {
      process.chdir(orig);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
