// Package-layout golden snapshot harness.
// Pins the file placement + import specifiers produced by outputLayout:"package"
// so any regression in path computation or import rewriting is caught immediately.
//
// This is ALSO the one golden that runs `namesFile()`, so it is where §A6's ON arm has byte
// coverage: the entity modules here reference `<Entity>Names` rather than embedding the
// physical names a second time. It carries that duty because package layout is the layout
// the consumption can actually break in — the names artifact has to land beside the entity
// module that imports it, and under "flat" a bare filename and `entityOutputPath(...)`
// return the identical string, so a flat golden cannot see a placement bug at all.
//
// Run with UPDATE_GOLDEN=1 to (re)write snapshots:
//   UPDATE_GOLDEN=1 bun test test/golden/package-layout.test.ts
//
// Run without the env var to assert byte-identical match:
//   bun test test/golden/package-layout.test.ts

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { namesFile } from "../../src/generators/index.js";
import { barrel } from "../../src/generators/barrel.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "../fixtures/packaged-shape.json");
const SNAP = join(import.meta.dir, "__snapshots__/package");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

// ---------------------------------------------------------------------------
// Recursive directory walker — returns all file paths relative to `dir`.
// ---------------------------------------------------------------------------
function walkDir(dir: string, base: string = dir): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...walkDir(full, base));
    } else {
      result.push(relative(base, full));
    }
  }
  return result.sort();
}

// Load metadata once for all tests.
const loader = new MetaDataLoader();
const loadResult = await loader.load([new FileSource(FIXTURE)]);
if (loadResult.errors.length > 0) {
  throw new Error(`Fixture load errors: ${loadResult.errors.join(", ")}`);
}
const metadataRoot = loadResult.root;

describe("golden output — package layout placement + import gate", () => {
  it("generates correct file placement and imports — sqlite / outputLayout:package", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "codegen-golden-pkg-"));
    try {
      const result = await runGen({
        config: defineConfig({
          outDir: tmp,
          extStyle: "none",
          dbImport: "../db",
          dialect: "sqlite",
          outputLayout: "package",
          generators: [entityFile(), queriesFile(), routesFile(), formFile(), namesFile(), barrel()],
        }),
        metadata: metadataRoot,
      });

      expect(result.warnings).toEqual([]);
      expect(result.files.length).toBeGreaterThan(0);

      // Walk the entire output tree (subdirectories included).
      const writtenFiles = walkDir(tmp);
      expect(writtenFiles.length).toBeGreaterThan(0);

      if (UPDATE) {
        mkdirSync(SNAP, { recursive: true });
      }

      for (const relPath of writtenFiles) {
        const content = readFileSync(join(tmp, relPath), "utf-8");
        // Use the relative path (with OS separator converted to POSIX) as key.
        const snapKey = relPath.replaceAll("\\", "/");
        const snapPath = join(SNAP, snapKey);

        if (UPDATE) {
          mkdirSync(dirname(snapPath), { recursive: true });
          writeFileSync(snapPath, content);
        } else {
          expect(
            existsSync(snapPath),
            `missing golden snapshot: ${snapKey} — run UPDATE_GOLDEN=1 to generate`,
          ).toBe(true);
          const golden = readFileSync(snapPath, "utf-8");
          expect(content, `content mismatch for ${snapKey}`).toBe(golden);
        }
      }

      // When updating, verify snapshot count matches written file count
      // (catches stale snapshots from deleted entities).
      if (UPDATE) {
        const snapFiles = walkDir(SNAP);
        expect(snapFiles).toEqual(writtenFiles);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
