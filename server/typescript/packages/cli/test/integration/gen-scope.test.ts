/**
 * Task 12b: `meta gen` honours the collection-level `scope` declared in
 * `.metaobjects/config.json`, filtering GENERATED output — never input. The
 * collection still loads the whole model; only the emitted file set narrows.
 */
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

  test("an unscoped run emits every entity, byte-for-byte the same as an all-matching scope", async () => {
    // Previously titled "byte-identical to today" while asserting only that three
    // FILENAMES were present. A title claiming a byte guarantee over a test that
    // reads no bytes is how the real guarantee went unexamined — the resolver was
    // reordering the loaded file list, and therefore the emitted content, with
    // nothing here able to see it.
    const unscoped = setupRepo();
    const allMatching = setupRepo();
    try {
      // No .metaobjects/config.json at all — the default, unscoped path.
      expect(await run(["gen", "--cwd", unscoped])).toBe(0);
      // A scope that admits everything must be indistinguishable from no scope.
      declareScope(allMatching, ["trainerWebsite::**"]);
      expect(await run(["gen", "--cwd", allMatching])).toBe(0);

      const names = readdirSync(genOutDir(unscoped)).sort();
      expect(names).toContain("Post.ts");
      expect(names).toContain("User.ts");
      expect(names).toContain("Tag.ts");
      expect(readdirSync(genOutDir(allMatching)).sort()).toEqual(names);

      for (const name of names) {
        const a = readFileSync(join(genOutDir(unscoped), name), "utf8");
        const b = readFileSync(join(genOutDir(allMatching), name), "utf8");
        // Real bytes, not a filename listing. The outDir is baked into each
        // repo's config, so nothing generated should mention it — if that ever
        // changes, this is the assertion that says so.
        expect(a).not.toContain(unscoped);
        expect(b).toBe(a);
      }
    } finally {
      rmSync(unscoped, { recursive: true, force: true });
      rmSync(allMatching, { recursive: true, force: true });
    }
  });
});
