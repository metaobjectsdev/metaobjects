// #287 (discoverability half) — grid artifacts are opt-IN per entity via a
// `layout.dataGrid` child. That is intended; the bug was that NOTHING said so, so
// an adopter who wired tanstackQuery() + tanstackGrid() saw hooks for every entity
// and columns for none and concluded codegen was broken.
//
// These run through runGen() rather than poking the generator directly, because
// the claim under test is about what a `meta gen` RUN reports — including the
// negative cases. A warning test that only pins the positive case lets a later
// change make it fire for everyone.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/test-generators";
import { tanstackQuery, tanstackGrid, tanstackGridHook } from "../src/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import type { Generator } from "@metaobjectsdev/codegen-ts";

const NO_GRID    = resolve(import.meta.dir, "fixtures", "no-grid-layout.json");
const WITH_GRID  = resolve(import.meta.dir, "fixtures", "multi-grid-entity.json");
const MIXED      = resolve(import.meta.dir, "fixtures", "mixed-grid-layout.json");
const VALUE_OBJ  = resolve(import.meta.dir, "fixtures", "value-object-no-grid.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "tanstack-grid-discoverability-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function warningsFor(fixture: string, generators: Generator[], dryRun = false): Promise<string[]> {
  const { root } = await new MetaDataLoader().load([new FileSource(fixture)]);
  const out = await runGen({
    config: defineConfig({
      outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
      generators,
    }),
    metadata: root,
    dryRun,
  });
  return out.warnings;
}

const gridNotes = (warnings: string[]): string[] =>
  warnings.filter((w) => w.includes("layout.dataGrid"));

describe("#287 — a run says why no grid artifacts were emitted", () => {
  test("names every affected entity, once, when tanstackGrid() is configured", async () => {
    const notes = gridNotes(await warningsFor(NO_GRID, [entityFile(), tanstackQuery(), tanstackGrid()]));
    expect(notes.length).toBe(1);
    const note = notes[0]!;
    // Attributed to the generator that skipped, names the artifact and BOTH entities
    // (one note per run — not one per entity).
    expect(note).toContain("[tanstack-grid]");
    expect(note).toContain("<Entity>.columns.tsx");
    expect(note).toContain("Author, Post");
    // Actionable: carries the metadata that would enable emission.
    expect(note).toContain(`{"layout.dataGrid": {"name": "default", "@columns": ["id", "name"]}}`);
  });

  test("tanstackGridHook() carries its own note for its own artifact", async () => {
    const notes = gridNotes(await warningsFor(NO_GRID, [entityFile(), tanstackQuery(), tanstackGridHook()]));
    expect(notes.length).toBe(1);
    expect(notes[0]!).toContain("[tanstack-grid-hook]");
    expect(notes[0]!).toContain("<Entity>.grid.ts");
    expect(notes[0]!).toContain("Author, Post");
  });

  test("SILENT when no grid generator is configured — an adopter who never wanted grids hears nothing", async () => {
    // The whole point of the negative case: hooks-only is a legitimate wiring.
    expect(await warningsFor(NO_GRID, [entityFile(), tanstackQuery()])).toEqual([]);
  });

  test("SILENT when the entities DO declare a layout.dataGrid", async () => {
    expect(
      await warningsFor(WITH_GRID, [entityFile(), tanstackQuery(), tanstackGrid(), tanstackGridHook()]),
    ).toEqual([]);
  });

  test("SILENT for an entity the user's own filter already excluded", async () => {
    // Only the LAYOUT gate should produce the note. An entity held back by a
    // deliberate filter is not a surprise, so naming it would be crying wolf.
    const notes = gridNotes(await warningsFor(NO_GRID, [
      entityFile(),
      tanstackGrid({ filter: (e) => e.name === "Post" }),
    ]));
    expect(notes.length).toBe(1);
    expect(notes[0]!).toContain("Post");
    expect(notes[0]!).not.toContain("Author");
  });

  test("SILENT once ANY object in the model declares a grid — the note self-extinguishes", async () => {
    // The trigger is "this generator emitted NOTHING", not "some entity lacks a
    // layout". Otherwise a 50-entity model with 3 grids would carry a permanent
    // 47-name warning on every run — the cry-wolf failure that got the old
    // timestampMode warning deleted from runner.ts rather than left to nag.
    const notes = gridNotes(await warningsFor(MIXED, [entityFile(), tanstackQuery(), tanstackGrid()]));
    expect(notes).toEqual([]);
  });

  test("never names an object.value — a payload shape is not a grid candidate", async () => {
    // Value objects clear every other gate (they are not abstract), so without an
    // explicit exclusion the note tells you to put a grid on your DTOs.
    const notes = gridNotes(await warningsFor(VALUE_OBJ, [entityFile(), tanstackQuery(), tanstackGrid()]));
    expect(notes.length).toBe(1);
    expect(notes[0]!).toContain("Author");
    expect(notes[0]!).not.toContain("AuthorPayload");
  });

  test("reported on the --dry-run preview path too", async () => {
    const notes = gridNotes(
      await warningsFor(NO_GRID, [entityFile(), tanstackQuery(), tanstackGrid()], true),
    );
    expect(notes.length).toBe(1);
  });

  test("warnings only — a missing layout is never an error", async () => {
    // runGen resolves rather than throwing, and the CLI derives its exit code from
    // a thrown error, never from warnings.
    const { root } = await new MetaDataLoader().load([new FileSource(NO_GRID)]);
    const out = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [entityFile(), tanstackQuery(), tanstackGrid()],
      }),
      metadata: root,
    });
    expect(out.files.length).toBeGreaterThan(0);
    expect(out.conflicts).toEqual([]);
  });
});
