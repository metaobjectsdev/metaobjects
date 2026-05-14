// Tests for source-aware dispatch in renderRoutesFile.
// Verifies that:
//   - projection entities emit mountReadOnlyCrudRoutes + camelView import
//   - vanilla entities still emit mountCrudRoutes + table var import

import { describe, test, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Shared fixture loader
// ---------------------------------------------------------------------------

function loadMetadata(children: unknown[]) {
  const loader = new Loader();
  const json = JSON.stringify({ metadata: { package: "test", children } });
  const result = loader.loadJson(json);
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

function loadProjectionFixture() {
  const root = loadMetadata([
    {
      object: {
        name: "Program",
        subType: "entity",
        children: [
          { source: { subType: "dbTable", "@name": "programs" } },
          { field: { name: "id", subType: "int" } },
          { field: { name: "title", subType: "string" } },
          { identity: { subType: "primary", "@fields": "id" } },
          {
            relationship: {
              subType: "association",
              name: "weeks",
              "@objectRef": "Week",
              "@cardinality": "many",
              "@fkField": "programId",
            },
          },
        ],
      },
    },
    {
      object: {
        name: "Week",
        subType: "entity",
        children: [
          { source: { subType: "dbTable", "@name": "weeks" } },
          { field: { name: "id", subType: "int" } },
          { identity: { subType: "primary", "@fields": "id" } },
        ],
      },
    },
    {
      object: {
        name: "ProgramSummary",
        subType: "entity",
        extends: "Program",
        children: [
          { source: { subType: "dbView", "@name": "v_program_summary" } },
          {
            field: {
              name: "weekCount",
              subType: "int",
              children: [
                {
                  origin: {
                    subType: "aggregate",
                    "@agg": "count",
                    "@of": "Week.id",
                    "@via": "Program.weeks",
                  },
                },
              ],
            },
          },
          { identity: { subType: "primary", "@fields": "id" } },
        ],
      },
    },
  ]);

  const projection = root.children().find((o) => o.name === "ProgramSummary");
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

function loadVanillaFixture() {
  const root = loadMetadata([
    {
      object: {
        name: "Post",
        subType: "entity",
        children: [
          { source: { subType: "dbTable", "@name": "posts" } },
          { field: { name: "id", subType: "long" } },
          { field: { name: "title", subType: "string" } },
          { identity: { subType: "primary", "@fields": "id" } },
        ],
      },
    },
  ]);

  const entity = root.children().find((o) => o.name === "Post");
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
    test("emits @generated header", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountReadOnlyCrudRoutes (not mountCrudRoutes)", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("mountReadOnlyCrudRoutes");
      expect(out).not.toContain("mountCrudRoutes(");
    });

    test("imports camelView from entity file", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      // camelName = "programSummary", so "programSummaryView"
      expect(out).toContain("programSummaryView");
    });

    test("imports FilterAllowlist and SortAllowlist", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("ProgramSummaryFilterAllowlist");
      expect(out).toContain("ProgramSummaryFilterAllowlist");
    });

    test("passes view (not table) to mountReadOnlyCrudRoutes", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("view:");
      expect(out).toContain("programSummaryView");
      expect(out).not.toContain("table:");
    });

    test("does NOT import InsertSchema or UpdateSchema", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).not.toContain("InsertSchema");
      expect(out).not.toContain("UpdateSchema");
    });

    test("exports a handler function named programSummaryRoutes", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("programSummaryRoutes");
    });

    test("imports from @metaobjects/runtime-ts/drizzle-fastify", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("@metaobjects/runtime-ts/drizzle-fastify");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits @generated header", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountCrudRoutes (not mountReadOnlyCrudRoutes)", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("mountCrudRoutes");
      expect(out).not.toContain("mountReadOnlyCrudRoutes");
    });

    test("imports table var from entity file", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      // variableNameFromEntity("Post") → "post" table
      expect(out).toContain("post");
    });

    test("imports InsertSchema and UpdateSchema", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("PostInsertSchema");
      expect(out).toContain("PostUpdateSchema");
    });

    test("passes table (not view) to mountCrudRoutes", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("table:");
      expect(out).not.toContain("view:");
    });

    test("exports a handler function named postRoutes", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("postRoutes");
    });
  });
});
