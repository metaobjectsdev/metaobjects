// Tests for source-aware dispatch in renderEntityFile.
// Verifies that:
//   - projection entities route through renderProjectionDecl (view + Zod read schema)
//   - vanilla entities still go through the Drizzle-table path

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { renderEntityFile } from "../../src/templates/entity-file.js";
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
// Fixture: ProgramSummary projection (extends Program, source[dbView])
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

describe("renderEntityFile — source-aware dispatch", () => {
  describe("projection path (isProjection = true)", () => {
    test("emits @generated header", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits Drizzle view declaration (sqliteView for sqlite)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("sqliteView");
      expect(out).toContain("v_program_summary");
      expect(out).toContain(".existing()");
    });

    test("emits Zod read schema (ProgramSummarySchema)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("ProgramSummarySchema");
      expect(out).toContain("z.object");
    });

    test("emits constants block with $view and $path", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("$view");
      expect(out).toContain("$path");
      expect(out).toContain("/program-summaries");
    });

    test("does NOT emit Drizzle table declaration", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).not.toContain("sqliteTable");
    });

    test("does NOT emit Insert/Update Zod schemas", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).not.toContain("InsertSchema");
      expect(out).not.toContain("UpdateSchema");
    });

    test("inherited fields from super appear in schema", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      // id and title are inherited from Program
      expect(out).toContain("id:");
      expect(out).toContain("title:");
      // weekCount is projection-declared
      expect(out).toContain("weekCount:");
    });

    test("postgres dialect emits pgView", async () => {
      const { root, projection } = await loadProjectionFixture();
      const ctx = makeRenderContext({
        dialect: "postgres",
        loadedRoot: root,
        outDir: "/x",
        dbImport: "~/db",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
      });
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("pgView");
      expect(out).not.toContain("sqliteView");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits @generated header", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits Drizzle table declaration (sqliteTable)", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain("sqliteTable");
    });

    test("emits Insert and Update Zod schemas", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain("PostInsertSchema");
      expect(out).toContain("PostUpdateSchema");
    });

    test("emits InferSelectModel type", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain("InferSelectModel");
    });

    test("does NOT emit sqliteView", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).not.toContain("sqliteView");
    });
  });
});
