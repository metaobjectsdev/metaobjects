import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { run } from "../../src/index.js";
import { readReferenceTemplate } from "@metaobjectsdev/codegen-ts";

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
          package: "shop::commerce",
          children: [
            { "source.rdb": {} },
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

  // `routesFile` takes a per-generator `target`, so it cannot be named as a bare registry
  // string here. Post-1.0 that means an OWNED copy — the same file `meta init` scaffolds —
  // which is also the shape this gate should be proving: an owned generator resolving the
  // engine through the CLI alias map, then routing its output to a named target.
  mkdirSync(join(root, "codegen", "generators"), { recursive: true });
  writeFileSync(join(root, "codegen", "generators", "routes.ts"), readReferenceTemplate("routes"));

  writeFileSync(join(root, "metaobjects.config.ts"), `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { routesFile } from "./codegen/generators/routes";
import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "packages/database/src/generated"))},
  importBase: "@acme/database/generated",
  extStyle: "none", dbImport: "../index", dialect: "sqlite", outputLayout: "package", apiPrefix: "/api",
  targets: {
    api: { outDir: ${JSON.stringify(join(root, "apps/api/src/generated"))}, dbImport: "@acme/database" },
    web: { outDir: ${JSON.stringify(join(root, "apps/web/src/generated"))} },
  },
  generators: [ "entity", "queries", routesFile({ target: "api" }), tanstackQuery({ target: "web" }) ],
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

      const entityPath = join(root, "packages/database/src/generated/shop/commerce/Program.ts");
      const routesPath = join(root, "apps/api/src/generated/shop/commerce/Program.routes.ts");
      const hooksPath  = join(root, "apps/web/src/generated/shop/commerce/Program.hooks.ts");
      expect(existsSync(entityPath)).toBe(true);
      expect(existsSync(routesPath)).toBe(true);
      expect(existsSync(hooksPath)).toBe(true);

      const routes = readFileSync(routesPath, "utf-8");
      expect(routes).toContain("@acme/database/generated/shop/commerce/Program");
      expect(routes).toContain('from "@acme/database"');     // per-target db import
      expect(routes).not.toContain('"./Program"');

      const hooks = readFileSync(hooksPath, "utf-8");
      expect(hooks).toContain("@acme/database/generated/shop/commerce/Program");
      expect(hooks).not.toContain('"./Program"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
