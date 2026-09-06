// Tests for source-aware dispatch in renderHooksFile.
// Verifies that:
//   - projection entities emit only read hooks (useEntity + useEntities, no mutations)
//   - vanilla entities still emit all 5 hooks (read + create/update/delete)

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderHooksFile } from "../src/templates/hooks-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

// ---------------------------------------------------------------------------
// Shared fixture loader
// ---------------------------------------------------------------------------

async function loadMetadata(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e: { message: string }) => e.message).join("\n")}`,
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
            { "field.int": { name: "id", extends: "Program.id" } },
            { "identity.primary": { "name": "id", extends: "Program.id" } },
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

  const projection = root.findObject("ProgramSummary");
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
          { "field.long": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
  ]);

  const entity = root.findObject("Post");
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

describe("renderHooksFile — source-aware dispatch", () => {
  describe("projection path (isProjection = true)", () => {
    test("emits useProgramSummary and useProgramSummaries (list hook, y→ies pluralization)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).toContain("useProgramSummary");
      expect(out).toContain("useProgramSummaries");
      expect(out).not.toContain("useProgramSummarys");
    });

    test("does NOT emit useCreateProgramSummary, useUpdateProgramSummary, useDeleteProgramSummary", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).not.toContain("useCreateProgramSummary");
      expect(out).not.toContain("useUpdateProgramSummary");
      expect(out).not.toContain("useDeleteProgramSummary");
    });

    test("emits query-key factory (programSummaryKeys)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).toContain("programSummaryKeys");
    });

    test("does NOT import ProgramSummaryInsert or ProgramSummaryUpdate", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).not.toContain("ProgramSummaryInsert");
      expect(out).not.toContain("ProgramSummaryUpdate");
    });

    test("does NOT import useMutation or useQueryClient", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).not.toContain("useMutation");
      expect(out).not.toContain("useQueryClient");
    });

    test("imports from @tanstack/react-query and @metaobjectsdev/tanstack", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).toContain("@tanstack/react-query");
      expect(out).toContain("@metaobjectsdev/tanstack");
    });

    test("fetch URLs start at $path — the base is the provider's, not the hook's", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      // Inverted: a projection's read hooks are as entity-relative as an entity's.
      expect(out).not.toContain("$apiPrefix");
      expect(out).toContain("${ProgramSummary.$path}");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits usePost and usePosts", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("usePost");
      expect(out).toContain("usePosts");
    });

    test("emits useCreatePost, useUpdatePost, useDeletePost", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("useCreatePost");
      expect(out).toContain("useUpdatePost");
      expect(out).toContain("useDeletePost");
    });

    test("emits query-key factory (postKeys)", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("postKeys");
    });

    test("imports PostInsert and PostUpdate", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("PostInsert");
      expect(out).toContain("PostUpdate");
    });

    test("mutation hooks invalidate via postKeys.all()", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      const matches = out.match(/invalidateQueries\(\{\s*queryKey:\s*postKeys\.all\(\)/g);
      expect(matches?.length).toBe(3); // create, update, delete
    });
  });
});
