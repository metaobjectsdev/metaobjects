// ADR-0034 verification, FR-040 §4.1: the copyable reference templates
// (src/reference/*.ts) must produce BYTE-IDENTICAL output to the built-in generators
// they were relocated from. The reference generators import only the PUBLIC engine
// (`@metaobjectsdev/codegen-ts` + `@metaobjectsdev/codegen-ts-tanstack`); if this
// passes, a consumer can `meta eject` them and own them with no behaviour change.
//
// WHY THIS FILE EXISTS. `codegen-ts` has had this gate since ADR-0034 landed, covering
// the four templates `meta init` scaffolds. FR-040 added five more — routes-hono here,
// hooks/grid/grid-hook in this package, form in codegen-ts-react — and each is a
// near-verbatim fork of the shipped generator beside it. Without an equivalence gate,
// `src/reference/*.ts` is excluded from tsconfig, imported by nothing and executed by
// nothing: `renderColumnsFile`'s signature, `hasDataGridLayout`, or the filter deciding
// WHICH entities emit can all change with every lane green, and the first person to
// find out is an adopter running `meta eject grid` against a build that no longer
// compiles — or worse, one that compiles and silently emits a different entity set.
// A header substring assertion cannot see any of that; only running both halves can.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import type { Generator } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile } from "@metaobjectsdev/codegen-ts/generators";
import {
  tanstackQuery as builtinHooks,
  tanstackGrid as builtinGrid,
  tanstackGridHook as builtinGridHook,
} from "../src/index.js";
import { REFERENCE_GENERATOR_NAMES } from "../src/index.js";
import { tanstackQuery as refHooks } from "../src/reference/hooks.js";
import { tanstackGrid as refGrid } from "../src/reference/grid.js";
import { tanstackGridHook as refGridHook } from "../src/reference/grid-hook.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE_DIR = resolve(import.meta.dir, "fixtures");
// Deliberately spans the branches these generators actually take: an entity WITH a
// layout.dataGrid, one WITHOUT (the emit gate), several grids on one entity, a
// packaged entity (path/import derivation), and a value object (skipped entirely).
const FIXTURES = [
  "multi-grid-entity.json",
  "single-entity.json",
  "no-grid-layout.json",
  "mixed-grid-layout.json",
  "packaged-grid-entity.json",
  "value-object-no-grid.json",
];

/** Generate into a fresh temp dir and read the whole emitted tree back. */
async function gen(generators: Generator[], root: Parameters<typeof runGen>[0]["metadata"]) {
  const dir = mkdtempSync(join(tmpdir(), "tanstack-ref-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: dir, extStyle: "none", dbImport: "../db", dialect: "sqlite", generators,
      }),
      metadata: root,
    });
    const out: Record<string, string> = {};
    for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), "utf-8");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The names this file actually puts under the equivalence gate above.
const COVERED = ["hooks", "grid", "grid-hook"] as const;

describe("ADR-0034 — tanstack reference templates are byte-identical to built-ins", () => {
  // The gap this whole file was written to close is "a template ships with no gate",
  // so the gate has to notice its own coverage shrinking. Without this, adding a
  // tenth template is silently unverified — the same way the five FR-040 added were.
  test("every ejectable template in this package is covered", () => {
    expect([...COVERED].sort()).toEqual([...REFERENCE_GENERATOR_NAMES].sort());
  });

  for (const fixture of FIXTURES) {
    test(fixture, async () => {
      const { root, errors } = await new MetaDataLoader().load([
        new FileSource(join(FIXTURE_DIR, fixture)),
      ]);
      expect(errors).toEqual([]);

      // entityFile/queriesFile ride along on both sides so the UI artifacts are
      // rendered in the same context a real run gives them (imports resolve against
      // an entity module that actually exists), and are identical on both sides.
      const a = await gen(
        [entityFile(), queriesFile(), builtinHooks(), builtinGrid(), builtinGridHook()],
        root,
      );
      const b = await gen(
        [entityFile(), queriesFile(), refHooks(), refGrid(), refGridHook()],
        root,
      );

      // Same set of files: catches a drifted FILTER (an entity that stops emitting).
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      // Byte-identical contents: catches a drifted renderer or composition.
      for (const k of Object.keys(a).sort()) {
        expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
      }
    });
  }
});
