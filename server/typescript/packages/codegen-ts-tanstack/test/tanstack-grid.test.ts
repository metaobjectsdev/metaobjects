import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { tanstackGrid } from "../src/tanstack-grid.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

// A model carrying the retired `@emitTanstack: false` — deliberately. The strict loader
// (`meta verify`) rejects it with ERR_UNKNOWN_ATTR; the non-strict loader `meta gen` runs
// accepts it, which is exactly the half-working state this deletion ends. Keeping a real
// carrier here is what makes the inertness assertions below real: a test that only checks
// the constant is gone would pass against a half-done deletion.
const STALE_ATTR_MODEL = JSON.stringify({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Subscriber",
        "@emitTanstack": false,
        children: [
          { "source.rdb": { "@table": "subscribers" } },
          { "field.long": { name: "id", children: [
            { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
          ] } },
          { "field.string": { name: "email" } },
          { "layout.dataGrid": { name: "default", "@columns": ["email"] } },
        ],
      },
    }],
  },
});

const FIXTURE        = resolve(import.meta.dir, "fixtures", "single-entity.json");
const MULTI_GRID     = resolve(import.meta.dir, "fixtures", "multi-grid-entity.json");
const GRID_FILTER    = resolve(import.meta.dir, "fixtures", "grid-filter-fixture.json");
const NO_GRID        = resolve(import.meta.dir, "fixtures", "no-grid-layout.json");

async function ctxFor(fixturePath: string): Promise<GenContext> {
  const { root } = await new MetaDataLoader().load([new FileSource(fixturePath)]);
  return ctxForRoot(root);
}

async function ctxForRoot(root: MetaRoot): Promise<GenContext> {
  const entities = root.objects();
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return {
    entities, loadedRoot: root,
    matches: (e) => tanstackGrid().filter?.(e) ?? true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
}

describe("tanstackGrid() factory", () => {
  test("returns a Generator named 'tanstack-grid'", () => {
    const gen = tanstackGrid();
    expect(gen.name).toBe("tanstack-grid");
  });

  test("emits Subscriber.columns.tsx with grid config + ColumnDef array", async () => {
    const ctx = await ctxFor(FIXTURE);
    const files = await tanstackGrid().generate(ctx);
    expect(files.length).toBe(1);
    const file = files[0]!;
    expect(file.path).toBe("Subscriber.columns.tsx");
    expect(file.content).toContain("subscriberDefaultGrid");
    expect(file.content).toContain("subscriberDefaultColumns");
    expect(file.content).toContain("ColumnDef<SubscriberRow>");
    expect(file.content).toContain(`pageSize: 25`);
    expect(file.content).toContain(`field: "createdAt"`);
    expect(file.content).toContain(`order: "desc"`);
    // Only the columns named in grid-column children are emitted:
    expect(file.content).toContain('id: "email"');
    expect(file.content).toContain('id: "createdAt"');
    // Each column carries meta.view from the field's view subtype:
    expect(file.content).toMatch(/meta:\s*\{\s*view:\s*"text"/);    // email field
    expect(file.content).toMatch(/meta:\s*\{\s*view:\s*"date"/);    // createdAt field
  });

  test("supports multiple named grids per entity", async () => {
    const ctx = await ctxFor(MULTI_GRID);
    const files = await tanstackGrid().generate(ctx);
    expect(files.length).toBe(1);
    const file = files[0]!;
    expect(file.path).toBe("Program.columns.tsx");
    // Both grids emit their own consts:
    expect(file.content).toContain("programDefaultGrid");
    expect(file.content).toContain("programDefaultColumns");
    expect(file.content).toContain("programCompactGrid");
    expect(file.content).toContain("programCompactColumns");
  });

  test("entity with no data-grid view emits nothing (factory filter rejects)", async () => {
    // The factory's filter checks for data-grid presence; if absent, filter returns false.
    // Uses a REAL loaded entity (sourced, no layout.dataGrid) rather than a hand-rolled
    // stub: the stub this replaced implemented only the three accessors the filter
    // happened to call, so it silently broke the moment the filter began consulting a
    // fourth (`children()`, via the #248 source gate) — a fake that has to be updated
    // in lockstep with the code it tests is not testing much.
    const { root } = await new MetaDataLoader().load([new FileSource(NO_GRID)]);
    const author = root.objects().find((o) => o.name === "Author")!;
    expect(tanstackGrid().filter?.(author)).toBe(false);
  });

  test("grid with @filter emits typed filter const", async () => {
    const ctx = await ctxFor(GRID_FILTER);
    const files = await tanstackGrid().generate(ctx);
    expect(files.length).toBe(1);
    const file = files[0]!;
    // Should emit the grid const and columns const for the "active" grid:
    expect(file.content).toContain("subscriberActiveGrid");
    expect(file.content).toContain("subscriberActiveColumns");
    // Filter const typed as SubscriberFilter:
    expect(file.content).toContain("subscriberActiveFilter");
    expect(file.content).toContain("SubscriberFilter");
    // The filter value contains the subscribed field set to true:
    expect(file.content).toContain("subscribed");
    // Import should include SubscriberFilter alongside SubscriberRow:
    expect(file.content).toMatch(/import type \{[^}]*SubscriberFilter[^}]*\} from "\.\/Subscriber"/);
  });

  // `@emitTanstack` was read by this filter but was NEVER registered metamodel
  // vocabulary, so the strict loader — which `meta verify` runs — rejected it with
  // ERR_UNKNOWN_ATTR while `meta gen` honoured it. The read is gone; these two tests pin
  // BOTH halves, because a deletion proved only by an absent assertion is not proved.
  test("@emitTanstack is INERT — a stale one no longer suppresses the columns file", async () => {
    const { root } = await new MetaDataLoader().load([new InMemoryStringSource(STALE_ATTR_MODEL)]);
    const subscriber = root.objects().find((o) => o.name === "Subscriber")!;
    expect(subscriber.hasAttr("emitTanstack")).toBe(true);  // the adopter really wrote it …
    expect(tanstackGrid().filter?.(subscriber)).toBe(true); // … and it decides nothing.
    const files = await tanstackGrid().generate(await ctxForRoot(root));
    expect(files.map((f) => f.path)).toEqual(["Subscriber.columns.tsx"]);
  });

  test("`filter` is how you narrow — it AND-composes with the built-in gates", async () => {
    const gen = tanstackGrid({ filter: (e) => e.name !== "Subscriber" });
    const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
    expect(gen.filter?.(root.objects().find((o) => o.name === "Subscriber")!)).toBe(false);
    const ctx = await ctxForRoot(root);
    expect(await gen.generate({ ...ctx, matches: (e) => gen.filter?.(e) ?? true })).toEqual([]);
  });
});
