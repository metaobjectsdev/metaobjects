import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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

  // Regression for the launch-B3 nodenext fix: `meta init` now scaffolds the
  // ADR-0034 owned-generator imports with a `.js` extension (nodenext-safe). The
  // jiti-based loader must still resolve those relative `.js` specifiers to the
  // on-disk `.ts` files when it loads the config — otherwise `meta gen` breaks on
  // a freshly-scaffolded project.
  test("resolves scaffolded owned-generator imports written with a `.js` extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mo-cfg-jsext-"));
    try {
      mkdirSync(join(dir, "codegen", "generators"), { recursive: true });
      writeFileSync(
        join(dir, "codegen", "generators", "entity.ts"),
        // A minimal Generator factory — the loader only needs the module to
        // resolve and the factory to produce a generator-shaped object.
        `export function entityFile() { return { name: "entity-file", generate: () => [] }; }\n`,
      );
      writeFileSync(
        join(dir, "metaobjects.config.ts"),
        [
          `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
          `import { entityFile } from "./codegen/generators/entity.js";`,
          `export default defineConfig({`,
          `  outDir: "src/generated",`,
          `  extStyle: "js",`,
          `  dbImport: "../db",`,
          `  dialect: "sqlite",`,
          `  generators: [entityFile()],`,
          `});`,
        ].join("\n"),
      );
      const cfg = await loadMetaobjectsConfig(dir);
      expect(cfg.generators.length).toBe(1);
      expect(cfg.extStyle).toBe("js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
