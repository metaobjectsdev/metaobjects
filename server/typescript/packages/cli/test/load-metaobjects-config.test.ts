import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetaobjectsConfig } from "../src/lib/load-metaobjects-config.js";

// Guards the config loader's module resolution: a user's metaobjects.config.ts
// imports @metaobjectsdev/codegen-ts*, which the CLI must resolve from its own
// install regardless of the user's node_modules layout (npm / pnpm / bun).
describe("loadMetaobjectsConfig", () => {
  test("loads a config importing the codegen packages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mo-cfg-"));
    try {
      writeFileSync(
        join(dir, "metaobjects.config.ts"),
        [
          `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
          `import { entityFile, queriesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";`,
          `import { formFile } from "@metaobjectsdev/codegen-ts-react";`,
          `import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";`,
          `export default defineConfig({`,
          `  outDir: "out",`,
          `  dialect: "sqlite",`,
          `  generators: [entityFile(), queriesFile(), barrel(), formFile(), tanstackQuery()],`,
          `});`,
        ].join("\n"),
      );
      const cfg = await loadMetaobjectsConfig(dir);
      expect(Array.isArray(cfg.generators)).toBe(true);
      expect(cfg.generators.length).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
