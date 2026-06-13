import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { run } from "../../src/index.js";

// Temp dirs live inside the monorepo so jiti can resolve @metaobjectsdev/* when
// it loads metaobjects.config.ts (mirrors gen-sqlite.test.ts).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-multitarget-"));

  // Entity carries an object-level package so package-layout subpaths are exercised.
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.commerce.json"), JSON.stringify({
    "metadata.root": {
      children: [
        { "object.entity": {
          name: "Program",
          package: "mikes::commerce",
          children: [
            { "field.long": { name: "id", children: [
              { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
            ] } },
            { "field.string": { name: "title", "@required": true } },
            { "layout.dataGrid": { name: "default", "@pageSize": 25, "@columns": ["title"] } },
          ],
        } },
      ],
    },
  }));

  writeFileSync(join(root, "metaobjects.config.ts"), `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "packages/database/src/generated"))},
  importBase: "@mf/database/generated",
  extStyle: "none", dbImport: "../index", dialect: "sqlite", outputLayout: "package", apiPrefix: "/api",
  targets: {
    api: { outDir: ${JSON.stringify(join(root, "apps/api/src/generated"))}, dbImport: "@mf/database" },
    web: { outDir: ${JSON.stringify(join(root, "apps/web/src/generated"))} },
  },
  generators: [ entityFile(), queriesFile(), routesFile({ target: "api" }), tanstackQuery({ target: "web" }) ],
});
`);
  return root;
}

describe("meta gen — multi-target end-to-end", () => {
  test("routes/hooks land in their target with importBase-qualified entity imports", async () => {
    const root = setupRepo();
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(0);

      const entityPath = join(root, "packages/database/src/generated/mikes/commerce/Program.ts");
      const routesPath = join(root, "apps/api/src/generated/mikes/commerce/Program.routes.ts");
      const hooksPath  = join(root, "apps/web/src/generated/mikes/commerce/Program.hooks.ts");
      expect(existsSync(entityPath)).toBe(true);
      expect(existsSync(routesPath)).toBe(true);
      expect(existsSync(hooksPath)).toBe(true);

      const routes = readFileSync(routesPath, "utf-8");
      expect(routes).toContain("@mf/database/generated/mikes/commerce/Program");
      expect(routes).toContain('from "@mf/database"');     // per-target db import
      expect(routes).not.toContain('"./Program"');

      const hooks = readFileSync(hooksPath, "utf-8");
      expect(hooks).toContain("@mf/database/generated/mikes/commerce/Program");
      expect(hooks).not.toContain('"./Program"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
