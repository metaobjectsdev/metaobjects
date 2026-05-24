// Tests for source-aware dispatch in renderRoutesFile.
// Verifies that:
//   - projection entities emit mountReadOnlyCrudRoutes + camelView import
//   - vanilla entities still emit mountCrudRoutes + table var import

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
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
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

// ---------------------------------------------------------------------------
// Fixture: ProgramSummary projection (source[dbView] only)
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
          { "identity.primary": { "@fields": "id" } },
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
          { "identity.primary":   { "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "ProgramSummary",
        extends: "Program",
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
          { "identity.primary": { "@fields": "id" } },
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
// Fixture: vanilla Post entity (source[dbTable])
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
          { "identity.primary": { "@fields": "id" } },
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
});
