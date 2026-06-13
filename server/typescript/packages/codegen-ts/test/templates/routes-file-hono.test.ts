// Tests for the Hono variant of the routes-file template.
// Verifies that:
//   - projection entities emit mountReadOnlyCrudRoutes (read-only)
//   - vanilla entities emit mountCrudRoutes (full CRUD)
//   - imports come from @metaobjectsdev/runtime-ts/hono (not …/drizzle-fastify)
//   - the exported handler signature is `register<Entity>Routes(app, { db })`
//   - apiPrefix is composed into the resource path

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderRoutesFileHono } from "../../src/templates/routes-file-hono.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

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

async function loadProjectionFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          { "field.string": { name: "title" } },
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
          { "field.int": { name: "id" } },
          { "field.int": { name: "programId" } },
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

async function loadVanillaFixture(apiPrefix = "") {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Post",
        children: [
          { "source.rdb": { "@table": "posts" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "title" } },
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
    apiPrefix,
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, entity, ctx };
}

describe("renderRoutesFileHono — source-aware dispatch", () => {
  describe("projection path (isProjection = true)", () => {
    test("emits @generated header", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFileHono(projection, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountReadOnlyCrudRoutes (not mountCrudRoutes)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFileHono(projection, ctx);
      expect(out).toContain("mountReadOnlyCrudRoutes");
      expect(out).not.toContain("mountCrudRoutes(");
    });

    test("imports from @metaobjectsdev/runtime-ts/hono (not drizzle-fastify)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFileHono(projection, ctx);
      expect(out).toContain("@metaobjectsdev/runtime-ts/hono");
      expect(out).not.toContain("@metaobjectsdev/runtime-ts/drizzle-fastify");
    });

    test("imports Hono type from 'hono'", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFileHono(projection, ctx);
      expect(out).toContain('from "hono"');
      expect(out).toContain("Hono");
    });

    test("exports registerXxxRoutes(app, deps) signature", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFileHono(projection, ctx);
      expect(out).toContain("registerProgramSummaryRoutes");
      expect(out).toContain("deps: { db: unknown }");
    });

    test("passes view (not table) to mountReadOnlyCrudRoutes", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFileHono(projection, ctx);
      expect(out).toContain("view:");
      expect(out).toContain("programSummaryView");
      expect(out).not.toContain("table:");
    });

    test("does NOT import InsertSchema or UpdateSchema", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFileHono(projection, ctx);
      expect(out).not.toContain("InsertSchema");
      expect(out).not.toContain("UpdateSchema");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits @generated header", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountCrudRoutes (not mountReadOnlyCrudRoutes)", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).toContain("mountCrudRoutes");
      expect(out).not.toContain("mountReadOnlyCrudRoutes");
    });

    test("imports from @metaobjectsdev/runtime-ts/hono (not drizzle-fastify)", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).toContain("@metaobjectsdev/runtime-ts/hono");
      expect(out).not.toContain("@metaobjectsdev/runtime-ts/drizzle-fastify");
    });

    test("imports InsertSchema and UpdateSchema", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).toContain("PostInsertSchema");
      expect(out).toContain("PostUpdateSchema");
    });

    test("passes table (not view) to mountCrudRoutes", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).toContain("table:");
      expect(out).not.toContain("view:");
    });

    test("exports registerPostRoutes function", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).toContain("registerPostRoutes");
    });

    test("path composes apiPrefix when set", async () => {
      const { entity, ctx } = await loadVanillaFixture("/api");
      const out = renderRoutesFileHono(entity, ctx);
      // apiPrefix is concatenated to the entity's $path via template literal
      expect(out).toContain("`/api${Post.$path}`");
    });

    test("path is bare Post.$path when no apiPrefix", async () => {
      const { entity, ctx } = await loadVanillaFixture("");
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).toContain("path: Post.$path");
      expect(out).not.toContain("`/");
    });

    test("does NOT emit fastify.register (no prefix-wrapping)", async () => {
      const { entity, ctx } = await loadVanillaFixture("/api");
      const out = renderRoutesFileHono(entity, ctx);
      expect(out).not.toContain("fastify.register");
      expect(out).not.toContain("fastify");
    });
  });
});
