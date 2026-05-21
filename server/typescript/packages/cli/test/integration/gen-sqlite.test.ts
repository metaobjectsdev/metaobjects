import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
// Place temp dirs inside the monorepo so workspace packages (@metaobjects/*)
// are resolvable by jiti when it loads metaobjects.config.ts.
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

// Generated output lands here — an absolute path inside the temp root, so it
// never pollutes the cli package's own src/ regardless of process.cwd().
function genOutDir(root: string): string {
  return join(root, "generated", "db");
}

function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-sqlite-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  // Write a metaobjects.config.ts so the gen command can load it via jiti.
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjects/codegen-ts";
import { entityFile } from "@metaobjects/codegen-ts/generators";
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

describe("meta gen — sqlite end-to-end", () => {
  test("writes Drizzle schema for User/Post/Tag", async () => {
    const root = setupRepo();
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(0);

      const outDir = genOutDir(root);
      expect(existsSync(outDir)).toBe(true);

      const files = readdirSync(outDir);
      expect(files).toContain("User.ts");
      expect(files).toContain("Post.ts");
      expect(files).toContain("Tag.ts");

      const userContent = readFileSync(join(outDir, "User.ts"), "utf8");
      expect(userContent).toContain("User");
      expect(userContent).toMatch(/sqliteTable\(\s*["']users["']/);
      expect(userContent).toContain("display_name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("positional filter generates only specified entity", async () => {
    const root = setupRepo();
    try {
      const exit = await run(["gen", "--cwd", root, "User"]);
      expect(exit).toBe(0);

      const outDir = genOutDir(root);
      const files = readdirSync(outDir);
      expect(files).toContain("User.ts");
      expect(files).not.toContain("Post.ts");
      expect(files).not.toContain("Tag.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns 2 when metaobjects/ is missing", async () => {
    // For this test, temp dir outside monorepo is fine — it fails before jiti runs
    const empty = mkdtempSync(join(tmpdir(), "forge-gen-empty-"));
    try {
      const exit = await run(["gen", "--cwd", empty]);
      expect(exit).toBe(2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("returns 2 when metaobjects.config.ts is missing", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-noconfig-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
    // deliberately no metaobjects.config.ts
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
