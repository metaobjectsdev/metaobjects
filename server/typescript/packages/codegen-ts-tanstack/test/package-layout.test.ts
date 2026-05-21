import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { runGen, defineConfig } from "@metaobjects/codegen-ts";
import { entityFile } from "@metaobjects/codegen-ts/generators";
import { tanstackQuery, tanstackGrid } from "../src/index.js";

const PACKAGED_GRID = resolve(import.meta.dir, "fixtures", "packaged-grid-entity.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "tanstack-pkg-layout-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("package-aware output placement — tanstackQuery + tanstackGrid", () => {
  test("package layout: hooks and columns land in package sub-path alongside entity file", async () => {
    const { root, errors } = await new FileMetaDataLoader().loadFiles([PACKAGED_GRID]);
    expect(errors).toEqual([]);

    const out = await runGen({
      config: defineConfig({
        outDir: tmp,
        outputLayout: "package",
        extStyle: "none",
        dbImport: "../db",
        dialect: "sqlite",
        generators: [entityFile(), tanstackQuery(), tanstackGrid()],
      }),
      metadata: root,
    });
    expect(out.warnings).toEqual([]);

    const pkgSubPath = join("shop", "commerce");
    const entityFile_ = join(tmp, pkgSubPath, "Product.ts");
    const hooksFile   = join(tmp, pkgSubPath, "Product.hooks.ts");
    const columnsFile = join(tmp, pkgSubPath, "Product.columns.tsx");

    // Files land in the package sub-directory, not the root.
    expect(existsSync(entityFile_)).toBe(true);
    expect(existsSync(hooksFile)).toBe(true);
    expect(existsSync(columnsFile)).toBe(true);

    // Root should NOT contain flat-named files.
    const rootFiles = readdirSync(tmp);
    expect(rootFiles).not.toContain("Product.ts");
    expect(rootFiles).not.toContain("Product.hooks.ts");
    expect(rootFiles).not.toContain("Product.columns.tsx");

    // Hooks file still references the entity as a same-directory sibling.
    const hooksContent = readFileSync(hooksFile, "utf-8");
    expect(hooksContent).toContain('from "./Product"');

    // Columns file also references the entity as a same-directory sibling.
    const colsContent = readFileSync(columnsFile, "utf-8");
    expect(colsContent).toContain('from "./Product"');
  });

  test("flat layout (default): hooks and columns land at outDir root", async () => {
    const { root, errors } = await new FileMetaDataLoader().loadFiles([PACKAGED_GRID]);
    expect(errors).toEqual([]);

    const out = await runGen({
      config: defineConfig({
        outDir: tmp,
        // outputLayout omitted → defaults to "flat"
        extStyle: "none",
        dbImport: "../db",
        dialect: "sqlite",
        generators: [entityFile(), tanstackQuery(), tanstackGrid()],
      }),
      metadata: root,
    });
    expect(out.warnings).toEqual([]);

    const rootFiles = readdirSync(tmp);
    expect(rootFiles).toContain("Product.ts");
    expect(rootFiles).toContain("Product.hooks.ts");
    expect(rootFiles).toContain("Product.columns.tsx");
  });

  test("extStyle: js — hooks and columns import the entity with a .js extension", async () => {
    const { root, errors } = await new FileMetaDataLoader().loadFiles([PACKAGED_GRID]);
    expect(errors).toEqual([]);

    const out = await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "js",
        dbImport: "../db",
        dialect: "sqlite",
        generators: [entityFile(), tanstackQuery(), tanstackGrid()],
      }),
      metadata: root,
    });
    expect(out.warnings).toEqual([]);

    // The sibling entity import must carry the .js extension, consistent with
    // the core generators — not a bare extensionless specifier.
    const hooksContent = readFileSync(join(tmp, "Product.hooks.ts"), "utf-8");
    expect(hooksContent).toContain('from "./Product.js"');
    const colsContent = readFileSync(join(tmp, "Product.columns.tsx"), "utf-8");
    expect(colsContent).toContain('from "./Product.js"');
  });
});
