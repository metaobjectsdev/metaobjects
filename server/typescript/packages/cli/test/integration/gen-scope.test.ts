/**
 * Task 12b: `meta gen` honours the collection-level `scope` declared in
 * `.metaobjects/config.json`, filtering GENERATED output — never input. The
 * collection still loads the whole model; only the emitted file set narrows.
 */
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
// Place temp dirs inside the monorepo so jiti can resolve @metaobjectsdev/*
// when it loads metaobjects.config.ts (same rationale as gen-sqlite.test.ts).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

function genOutDir(root: string): string {
  return join(root, "generated", "db");
}

/** trainer-website-meta declares User/Post/Tag, all in package "trainerWebsite". */
function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-scope-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(genOutDir(root))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
  );
  return root;
}

function declareScope(repo: string, include: string[]): void {
  mkdirSync(join(repo, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(repo, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, scope: { include } }),
    "utf8",
  );
}

describe("meta gen — collection scope", () => {
  test("a declared scope emits only the in-scope entity's files", async () => {
    const root = setupRepo();
    try {
      declareScope(root, ["trainerWebsite::Post"]);

      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(0);

      const outDir = genOutDir(root);
      const files = readdirSync(outDir);
      expect(files).toContain("Post.ts");
      expect(files).not.toContain("User.ts");
      expect(files).not.toContain("Tag.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no declared scope emits every entity (byte-identical to today)", async () => {
    const root = setupRepo();
    try {
      // No .metaobjects/config.json at all — the default, unscoped path.
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(0);

      const outDir = genOutDir(root);
      const files = readdirSync(outDir);
      expect(files).toContain("Post.ts");
      expect(files).toContain("User.ts");
      expect(files).toContain("Tag.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
