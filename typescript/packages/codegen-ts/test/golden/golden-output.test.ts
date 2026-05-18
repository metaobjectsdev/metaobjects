// Golden-output snapshot harness — byte-identical port gate.
// Captures the pre-port generated output so any downstream port task that
// accidentally changes output is caught immediately.
//
// Run with UPDATE_GOLDEN=1 to (re)write snapshots:
//   UPDATE_GOLDEN=1 bun test test/golden/golden-output.test.ts
//
// Run without the env var to assert byte-identical match:
//   bun test test/golden/golden-output.test.ts

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { runGen, defineConfig } from "../../src/index.js";
import { entityFile, queriesFile, routesFile, formFile, barrel } from "../../src/generators/index.js";

const FIXTURE = resolve(import.meta.dir, "../fixtures/trainer-website-shape.json");
const SNAP = join(import.meta.dir, "__snapshots__");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

// Load metadata once for all tests — same mechanism as integration.test.ts.
const loader = new FileMetaDataLoader();
const loadResult = await loader.loadFiles([FIXTURE]);
if (loadResult.errors.length > 0) {
  throw new Error(`Fixture load errors: ${loadResult.errors.join(", ")}`);
}
const metadataRoot = loadResult.root;

describe("golden output — byte-identical port gate", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    it(`generates byte-identical output — ${dialect}`, async () => {
      // Use a temp dir so runGen can write files; we read them back for comparison.
      const tmp = mkdtempSync(join(tmpdir(), `codegen-golden-${dialect}-`));
      try {
        const result = await runGen({
          config: defineConfig({
            outDir: tmp,
            extStyle: "none",
            dbImport: "~/server/db",
            dialect,
            generators: [entityFile({}), queriesFile({}), routesFile({}), formFile({}), barrel()],
          }),
          metadata: metadataRoot,
        });

        expect(result.warnings).toEqual([]);
        expect(result.files.length).toBeGreaterThan(0);

        // Collect all written files from the temp dir (runGen writes them there).
        const writtenFiles = readdirSync(tmp).sort();
        expect(writtenFiles.length).toBeGreaterThan(0);

        for (const filename of writtenFiles) {
          const content = readFileSync(join(tmp, filename), "utf-8");
          // Use filename as snapshot key (safe: codegen emits flat directory).
          const snapPath = join(SNAP, dialect, filename);

          if (UPDATE) {
            mkdirSync(join(SNAP, dialect), { recursive: true });
            writeFileSync(snapPath, content);
          } else {
            expect(
              existsSync(snapPath),
              `missing golden snapshot: ${dialect}/${filename} — run UPDATE_GOLDEN=1 to generate`,
            ).toBe(true);
            const golden = readFileSync(snapPath, "utf-8");
            expect(content, `content mismatch for ${dialect}/${filename}`).toBe(golden);
          }
        }

        // When updating, also verify snapshot count matches written file count.
        if (UPDATE) {
          const snapFiles = readdirSync(join(SNAP, dialect)).sort();
          expect(snapFiles).toEqual(writtenFiles);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
