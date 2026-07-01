import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { tanstackGrid } from "../src/tanstack-grid.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE        = resolve(import.meta.dir, "fixtures", "single-entity.json");
const MULTI_GRID     = resolve(import.meta.dir, "fixtures", "multi-grid-entity.json");
const GRID_FILTER    = resolve(import.meta.dir, "fixtures", "grid-filter-fixture.json");

async function ctxFor(fixturePath: string): Promise<GenContext> {
  const { root } = await new MetaDataLoader().load([new FileSource(fixturePath)]);
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
    const gen = tanstackGrid();
    // Synthesize a fake entity without grids:
    const fakeEntity = {
      name: "X",
      // ADR-0039: the filter now resolves @emit* via attr() (own + inherited).
      attr: () => undefined,
      ownAttr: () => undefined,
      layouts: () => [] as any[],
    } as any;
    expect(gen.filter?.(fakeEntity)).toBe(false);
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

  test("respects @emitTanstack: false per entity", async () => {
    // Same approach as the freeze workaround in B-T8 — construct a fresh entity.
    // Use MetaData directly. Import what's needed.
    const { MetaObject, TypeId, TYPE_OBJECT: T_OBJ, OBJECT_SUBTYPE_ENTITY } = await import("@metaobjectsdev/metadata");
    const fakeEntity: any = new MetaObject(new TypeId(T_OBJ, OBJECT_SUBTYPE_ENTITY), "Subscriber");
    fakeEntity.setAttr("emitTanstack", false);
    expect(tanstackGrid().filter?.(fakeEntity)).toBe(false);
  });
});
