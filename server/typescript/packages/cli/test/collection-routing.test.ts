import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { genCommand } from "../src/commands/gen.js";

// Place temp dirs inside the monorepo so metaobjects.config.ts's
// `@metaobjectsdev/*` imports resolve the same way the existing
// integration/gen-sqlite.test.ts fixtures do.
const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures/__tmp__");

function genOutDir(root: string): string {
  return join(root, "generated", "db");
}

describe("gen routes metadata discovery through resolveCollection", () => {
  test("generates from a sources-declared tree with no metaobjects/ present anywhere", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "collection-routing-"));
    try {
      mkdirSync(join(root, ".git"));

      // Metadata lives OUTSIDE the app directory entirely — under `model/`,
      // not `metaobjects/` — and nowhere under `apps/ui`.
      mkdirSync(join(root, "model"), { recursive: true });
      writeFileSync(
        join(root, "model", "meta.a.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              {
                "object.entity": {
                  name: "Order",
                  children: [
                    { "source.rdb": { "@table": "orders" } },
                    { "field.long": { name: "id", "@column": "id" } },
                    {
                      "identity.primary": {
                        name: "pk",
                        "@fields": ["id"],
                        "@generation": "increment",
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

      // The app's config declares its own metadata source — a relative path
      // outside the app dir — instead of relying on a `metaobjects/` default.
      mkdirSync(join(root, "apps", "ui", ".metaobjects"), { recursive: true });
      writeFileSync(
        join(root, "apps", "ui", ".metaobjects", "config.json"),
        JSON.stringify({
          schema_version: 1,
          sources: [{ path: "../../model" }],
        }),
      );

      const appRoot = join(root, "apps", "ui");
      writeFileSync(
        join(appRoot, "metaobjects.config.ts"),
        `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(genOutDir(appRoot))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
      );

      const code = await genCommand([], appRoot);
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
