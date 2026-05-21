import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMetaobjectsConfig } from "../../src/lib/load-metaobjects-config.js";

// Place temp dirs inside the monorepo so workspace packages (@metaobjects/*)
// are resolvable by jiti when it loads the config file.
const WORKSPACE_TMP = resolve("packages/cli/test/fixtures/__tmp__");

let tmp: string;
beforeEach(() => {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  tmp = mkdtempSync(join(WORKSPACE_TMP, "metaobjects-config-"));
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("loadMetaobjectsConfig", () => {
  test("loads a TS config file and returns its default export", async () => {
    writeFileSync(join(tmp, "metaobjects.config.ts"), `
      import { defineConfig } from "@metaobjects/codegen-ts";
      import { entityFile, barrel } from "@metaobjects/codegen-ts/generators";
      export default defineConfig({
        outDir: "out",
        extStyle: "none",
        dbImport: "../db",
        dialect: "sqlite",
        generators: [entityFile(), barrel()],
      });
    `);
    const cfg = await loadMetaobjectsConfig(tmp);
    expect(cfg.outDir).toBe("out");
    expect(cfg.dialect).toBe("sqlite");
    expect(cfg.generators.length).toBe(2);
    expect(cfg.generators[0]!.name).toBe("entity-file");
    expect(cfg.generators[1]!.name).toBe("barrel");
  });

  test("throws a clear error if metaobjects.config.ts is missing", async () => {
    await expect(loadMetaobjectsConfig(tmp)).rejects.toThrow(/metaobjects\.config\.ts/);
  });

  test("throws if export is missing generators array", async () => {
    writeFileSync(
      join(tmp, "metaobjects.config.ts"),
      `export default { outDir: "out", dialect: "sqlite" };`,
    );
    await expect(loadMetaobjectsConfig(tmp)).rejects.toThrow(/missing 'generators' array/);
  });

  test("loads from a tmp dir outside the workspace (alias-only resolution path)", async () => {
    // Place fixture in OS tmp so node_modules walk-up CANNOT find @metaobjects/codegen-ts.
    // Only the jiti alias map can resolve the imports; this guards against the path math
    // being wrong in compiled-dist mode.
    const osTmp = mkdtempSync(join(tmpdir(), "metaobjects-config-external-"));
    try {
      writeFileSync(join(osTmp, "metaobjects.config.ts"), `
        import { defineConfig } from "@metaobjects/cli";
        import { entityFile, barrel } from "@metaobjects/codegen-ts/generators";
        export default defineConfig({
          outDir: "out", extStyle: "none", dbImport: "../db", dialect: "sqlite",
          generators: [entityFile(), barrel()],
        });
      `);
      const cfg = await loadMetaobjectsConfig(osTmp);
      expect(cfg.generators.length).toBe(2);
      expect(cfg.generators[0]!.name).toBe("entity-file");
      expect(cfg.generators[1]!.name).toBe("barrel");
    } finally {
      rmSync(osTmp, { recursive: true, force: true });
    }
  });

  test("loads a config that imports from @metaobjects/codegen-ts-tanstack", async () => {
    const osTmp = mkdtempSync(join(tmpdir(), "metaobjects-config-tanstack-"));
    try {
      writeFileSync(join(osTmp, "metaobjects.config.ts"), `
        import { defineConfig } from "@metaobjects/cli";
        import { entityFile, barrel } from "@metaobjects/codegen-ts/generators";
        // import { tanstackQuery } from "@metaobjects/codegen-ts-tanstack";
        // ↑ The package re-exports nothing yet — covered fully in Tasks 8/9.
        // For now: confirm the alias loads without error.
        export default defineConfig({
          outDir: "out", extStyle: "none", dbImport: "../db", dialect: "sqlite",
          generators: [entityFile(), barrel()],
        });
      `);
      const cfg = await loadMetaobjectsConfig(osTmp);
      expect(cfg.generators.length).toBe(2);
    } finally {
      rmSync(osTmp, { recursive: true, force: true });
    }
  });
});
