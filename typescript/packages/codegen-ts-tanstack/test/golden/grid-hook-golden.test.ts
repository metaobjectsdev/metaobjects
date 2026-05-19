// Golden-output snapshot harness for tanstackGridHook().
// Captures the generated <Entity>.grid.ts output so any unintentional change
// to the template is caught immediately.
//
// Run with UPDATE_GOLDEN=1 to (re)write snapshots:
//   UPDATE_GOLDEN=1 bun test test/golden/grid-hook-golden.test.ts
//
// Run without the env var to assert byte-identical match:
//   bun test test/golden/grid-hook-golden.test.ts

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { runGen, defineConfig } from "@metaobjects/codegen-ts";
import { entityFile } from "@metaobjects/codegen-ts/generators";
import { tanstackGridHook } from "../../src/index.js";

const SNAP = join(import.meta.dir, "__snapshots__");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

// ---------------------------------------------------------------------------
// Fixtures with dataGrid layouts:
//   single-entity.json  → Subscriber entity with one "default" dataGrid
//   multi-grid-entity.json → Program entity with "default" + "compact" dataGrids
// ---------------------------------------------------------------------------

const fixtures = [
  {
    name: "single-entity",
    path: resolve(import.meta.dir, "../fixtures/single-entity.json"),
  },
  {
    name: "multi-grid",
    path: resolve(import.meta.dir, "../fixtures/multi-grid-entity.json"),
  },
] as const;

describe("tanstackGridHook() — golden snapshot", () => {
  for (const fixture of fixtures) {
    it(`generates byte-identical .grid.ts output — ${fixture.name}`, async () => {
      const { root, errors } = await new FileMetaDataLoader().loadFiles([fixture.path]);
      if (errors.length > 0) {
        throw new Error(`Fixture load errors: ${errors.join(", ")}`);
      }

      const tmp = mkdtempSync(join(tmpdir(), `grid-hook-golden-${fixture.name}-`));
      try {
        const result = await runGen({
          config: defineConfig({
            outDir: tmp,
            extStyle: "none",
            dbImport: "../db",
            dialect: "sqlite",
            generators: [entityFile(), tanstackGridHook()],
          }),
          metadata: root,
        });

        expect(result.warnings).toEqual([]);

        // Only check .grid.ts files (entityFile also emits entity files; we only gate the new artifact).
        const writtenFiles = readdirSync(tmp)
          .filter((f) => f.endsWith(".grid.ts"))
          .sort();

        expect(writtenFiles.length).toBeGreaterThan(0);

        const snapDir = join(SNAP, fixture.name);

        for (const filename of writtenFiles) {
          const content = readFileSync(join(tmp, filename), "utf-8");
          const snapPath = join(snapDir, filename);

          if (UPDATE) {
            mkdirSync(snapDir, { recursive: true });
            writeFileSync(snapPath, content);
          } else {
            expect(
              existsSync(snapPath),
              `missing golden snapshot: ${fixture.name}/${filename} — run UPDATE_GOLDEN=1 to generate`,
            ).toBe(true);
            const golden = readFileSync(snapPath, "utf-8");
            expect(content, `content mismatch for ${fixture.name}/${filename}`).toBe(golden);
          }
        }

        // When updating, verify snapshot count matches written file count.
        if (UPDATE && existsSync(snapDir)) {
          const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".grid.ts")).sort();
          expect(snapFiles).toEqual(writtenFiles);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
