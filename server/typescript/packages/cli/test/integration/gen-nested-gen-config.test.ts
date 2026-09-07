/**
 * #326 — a sub-project's `metaobjects.config.ts` governs its own codegen, even
 * when the collection it loads from is declared by an ANCESTOR
 * `.metaobjects/config.json`.
 *
 * The two files answer different questions (design §4.6): `.metaobjects/config.json`
 * says where metadata comes from — reasonably repo-global in a polyglot monorepo —
 * while `metaobjects.config.ts` says how THIS package generates TypeScript. Resolving
 * both from the collection's directory made a Maven- or pip-rooted repo with a JS app
 * underneath unable to run `meta gen` at all: the ancestor has no TS config, and the
 * app's was never looked at.
 *
 * The I5 fix this preserves (commit 0c8fd136e) is the opposite arm: a run from a
 * subdirectory that has NO config of its own must still find the project root's,
 * rather than silently defaulting `columnNamingStrategy` and renaming every column.
 * The nearest-ancestor walk gives both — nearest wins, and the project root is the
 * nearest ancestor when a subdirectory declares nothing.
 */
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
// Temp dirs live inside the monorepo so jiti can resolve @metaobjectsdev/* when it
// loads metaobjects.config.ts (same rationale as gen-scope.test.ts).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

function genConfigBody(outDir: string): string {
  return `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`;
}

/**
 * A Maven-rooted monorepo shape: the repo root declares the collection (and has no
 * TypeScript config at all), the JS app underneath carries `metaobjects.config.ts`
 * and the metadata directory the root's `sources` points at.
 */
function setupMonorepo(): { root: string; app: string; outDir: string } {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-nested-"));
  const app = join(root, "app");
  mkdirSync(app, { recursive: true });
  cpSync(join(FIXTURES, "trainer-website-meta"), app, { recursive: true });

  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, sources: [{ path: "app/metaobjects" }] }),
    "utf8",
  );

  const outDir = join(app, "generated", "db");
  writeFileSync(join(app, "metaobjects.config.ts"), genConfigBody(outDir));
  return { root, app, outDir };
}

describe("meta gen — nearest metaobjects.config.ts wins (#326)", () => {
  test("a sub-project generates using its OWN config when the collection is declared by an ancestor", async () => {
    const { root, app, outDir } = setupMonorepo();
    try {
      const exit = await run(["gen", "--cwd", app]);
      expect(exit).toBe(0);
      // The app's own config named this outDir; the ancestor names no TS config at all.
      expect(existsSync(join(outDir, "User.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the I5 arm still holds: a subdirectory with no config of its own uses the project root's", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-nested-i5-"));
    try {
      cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
      mkdirSync(join(root, ".metaobjects"), { recursive: true });
      writeFileSync(
        join(root, ".metaobjects", "config.json"),
        JSON.stringify({ schema_version: 1 }),
        "utf8",
      );
      const outDir = join(root, "generated", "db");
      writeFileSync(join(root, "metaobjects.config.ts"), genConfigBody(outDir));

      // A plain subdirectory — no config of any kind.
      const sub = join(root, "src", "deep");
      mkdirSync(sub, { recursive: true });

      const exit = await run(["gen", "--cwd", sub]);
      expect(exit).toBe(0);
      expect(existsSync(join(outDir, "User.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
