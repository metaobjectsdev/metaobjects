// Tests for source-aware dispatch in renderRoutesFile.
// Verifies that:
//   - projection entities emit mountReadOnlyCrudRoutes + camelView import
//   - vanilla entities still emit mountCrudRoutes + table var import

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Shared fixture loader
// ---------------------------------------------------------------------------

async function loadMetadata(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

// ---------------------------------------------------------------------------
// Fixture: ProgramSummary projection (source.rdb @kind:view only)
// ---------------------------------------------------------------------------

async function loadProjectionFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id", } },
          { "field.string": { name: "title", } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
          {
            "relationship.association": {
              name: "weeks",
              "@objectRef": "Week",
              "@cardinality": "many",
            },
          },
        ],
      },
    },
    {
      "object.entity": {
        name: "Week",
        children: [
          { "source.rdb": { "@table": "weeks" } },
          { "field.int": { name: "id", } },
          { "field.int": { name: "programId", } },
          { "identity.primary":   { "name": "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          {
            "field.int": {
              name: "weekCount",
              children: [
                {
                  "origin.aggregate": {
                    "@agg": "count",
                    "@of": "Week.id",
                    "@via": "Program.weeks",
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ]);

  const projection = root.objects().find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, projection, ctx };
}

// ---------------------------------------------------------------------------
// Fixture: vanilla Post entity (source.rdb @kind:table)
// ---------------------------------------------------------------------------

async function loadVanillaFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Post",
        children: [
          { "source.rdb": { "@table": "posts" } },
          { "field.long": { name: "id", } },
          { "field.string": { name: "title", } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
  ]);

  const entity = root.objects().find((o) => o.name === "Post");
  if (!entity) throw new Error("Post not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, entity, ctx };
}

// ---------------------------------------------------------------------------
// Fixture: write-through Order entity (writable table + replica view + derived field)
// ---------------------------------------------------------------------------

async function loadWriteThroughFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Customer",
        children: [
          { "source.rdb": { "@table": "customers" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "name" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Order",
        children: [
          { "source.rdb": { "@role": "primary", "@table": "orders" } },
          { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
          { "field.long": { name: "id" } },
          { "field.long": { name: "customerId", "@required": true } },
          {
            "field.string": {
              name: "customerName",
              children: [{ "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } }],
            },
          },
          { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
        ],
      },
    },
  ]);

  const entity = root.objects().find((o) => o.name === "Order");
  if (!entity) throw new Error("Order not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, entity, ctx };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderRoutesFile — source-aware dispatch", () => {
  describe("projection path (isProjection = true)", () => {
    test("emits @generated header", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountReadOnlyCrudRoutes (not mountCrudRoutes)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("mountReadOnlyCrudRoutes");
      expect(out).not.toContain("mountCrudRoutes(");
    });

    test("imports camelView from entity file", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      // camelName = "programSummary", so "programSummaryView"
      expect(out).toContain("programSummaryView");
    });

    test("imports FilterAllowlist and SortAllowlist", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("ProgramSummaryFilterAllowlist");
      expect(out).toContain("ProgramSummaryFilterAllowlist");
    });

    test("passes view (not table) to mountReadOnlyCrudRoutes", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("view:");
      expect(out).toContain("programSummaryView");
      expect(out).not.toContain("table:");
    });

    test("does NOT import InsertSchema or UpdateSchema", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).not.toContain("InsertSchema");
      expect(out).not.toContain("UpdateSchema");
    });

    test("exports a handler function named programSummaryRoutes", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("programSummaryRoutes");
    });

    test("imports from @metaobjectsdev/runtime-ts/drizzle-fastify", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("@metaobjectsdev/runtime-ts/drizzle-fastify");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits @generated header", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountCrudRoutes (not mountReadOnlyCrudRoutes)", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("mountCrudRoutes");
      expect(out).not.toContain("mountReadOnlyCrudRoutes");
    });

    test("imports table var from entity file", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      // variableNameFromEntity("Post") → "post" table
      expect(out).toContain("post");
    });

    test("imports InsertSchema and UpdateSchema", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("PostInsertSchema");
      expect(out).toContain("PostUpdateSchema");
    });

    test("passes table (not view) to mountCrudRoutes", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("table:");
      expect(out).not.toContain("view:");
    });

    test("exports a handler function named postRoutes", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("postRoutes");
    });
  });

  // #214 — a write-through entity has FULL CRUD (writes → table) but its READS
  // must route through the replica view so the HTTP responses carry the derived
  // origin.passthrough field. The routes file must pass `readView` to mountCrudRoutes.
  describe("write-through entity path (isWriteThrough = true)", () => {
    test("emits mountCrudRoutes (full CRUD, not read-only)", async () => {
      const { entity, ctx } = await loadWriteThroughFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("mountCrudRoutes");
      expect(out).not.toContain("mountReadOnlyCrudRoutes");
    });

    test("passes readView (the replica view) to mountCrudRoutes", async () => {
      const { entity, ctx } = await loadWriteThroughFixture();
      const out = renderRoutesFile(entity, ctx);
      // camelName = "order" → the entity file exports "orderView"
      expect(out).toContain("readView:");
      expect(out).toContain("orderView");
    });

    test("still writes to the table + imports the write schemas", async () => {
      const { entity, ctx } = await loadWriteThroughFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("table:");
      expect(out).toContain("OrderInsertSchema");
      expect(out).toContain("OrderUpdateSchema");
    });
  });
});
