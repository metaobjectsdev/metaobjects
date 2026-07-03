import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMetaobjectsConfig } from "../../src/lib/load-metaobjects-config.js";

// GeneratorSpec is `Generator | string` (a stable-name ref). These fixtures all
// wire object generators (entityFile()/barrel()), so narrow to the object form
// to read `.name` without tripping the union.
function genName(g: { name: string } | string): string {
  return typeof g === "string" ? g : g.name;
}

// Place temp dirs inside the monorepo so workspace packages (@metaobjectsdev/*)
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
      import { defineConfig } from "@metaobjectsdev/codegen-ts";
      import { entityFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
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
    expect(genName(cfg.generators[0]!)).toBe("entity-file");
    expect(genName(cfg.generators[1]!)).toBe("barrel");
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
    // Place fixture in OS tmp so node_modules walk-up CANNOT find @metaobjectsdev/codegen-ts.
    // Only the jiti alias map can resolve the imports; this guards against the path math
    // being wrong in compiled-dist mode.
    const osTmp = mkdtempSync(join(tmpdir(), "metaobjects-config-external-"));
    try {
      writeFileSync(join(osTmp, "metaobjects.config.ts"), `
        import { defineConfig } from "@metaobjectsdev/cli";
        import { entityFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
        export default defineConfig({
          outDir: "out", extStyle: "none", dbImport: "../db", dialect: "sqlite",
          generators: [entityFile(), barrel()],
        });
      `);
      const cfg = await loadMetaobjectsConfig(osTmp);
      expect(cfg.generators.length).toBe(2);
      expect(genName(cfg.generators[0]!)).toBe("entity-file");
      expect(genName(cfg.generators[1]!)).toBe("barrel");
    } finally {
      rmSync(osTmp, { recursive: true, force: true });
    }
  });

  test("sweeps a stranded .metaobjects-config-proc-*.ts temp file left by an abnormal exit", async () => {
    // A SIGKILL during a prior load can strand the pre-processed temp config
    // (whose deletion normally happens in a finally block). The next load must
    // self-heal by removing any such stale files before proceeding, so a
    // consumer's `git status` never shows the artifact.
    const stale = join(tmp, ".metaobjects-config-proc-deadbeef.ts");
    writeFileSync(stale, `export default { generators: [] };`);
    writeFileSync(join(tmp, "metaobjects.config.ts"), `
      import { defineConfig } from "@metaobjectsdev/codegen-ts";
      import { entityFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
      export default defineConfig({
        outDir: "out", extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [entityFile(), barrel()],
      });
    `);
    expect(existsSync(stale)).toBe(true);
    const cfg = await loadMetaobjectsConfig(tmp);
    expect(cfg.generators.length).toBe(2);      // normal load still works
    expect(existsSync(stale)).toBe(false);      // stale temp file swept
  });

  test("loads a config that imports from @metaobjectsdev/codegen-ts-tanstack", async () => {
    const osTmp = mkdtempSync(join(tmpdir(), "metaobjects-config-tanstack-"));
    try {
      writeFileSync(join(osTmp, "metaobjects.config.ts"), `
        import { defineConfig } from "@metaobjectsdev/cli";
        import { entityFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
        // import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";
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
