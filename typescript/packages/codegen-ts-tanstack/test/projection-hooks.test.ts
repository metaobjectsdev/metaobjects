// Tests for source-aware dispatch in renderHooksFile.
// Verifies that:
//   - projection entities emit only read hooks (useEntity + useEntities, no mutations)
//   - vanilla entities still emit all 5 hooks (read + create/update/delete)

import { describe, test, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import { renderHooksFile } from "../src/templates/hooks-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjects/codegen-ts";

// ---------------------------------------------------------------------------
// Shared fixture loader
// ---------------------------------------------------------------------------

function loadMetadata(children: unknown[]) {
  const loader = new Loader();
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = loader.loadJson(json);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e: { message: string }) => e.message).join("\n")}`,
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
      "object.entity": {
        name: "Program",
        children: [
          { "source.dbTable": { "@name": "programs" } },
          { "field.int": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { "@fields": "id" } },
          {
            "relationship.association": {
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
      "object.entity": {
        name: "Week",
        children: [
          { "source.dbTable": { "@name": "weeks" } },
          { "field.int": { name: "id" } },
          { "identity.primary": { "@fields": "id" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "ProgramSummary",
        extends: "Program",
        children: [
          { "source.dbView": { "@name": "v_program_summary" } },
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
      "object.entity": {
        name: "Post",
        children: [
          { "source.dbTable": { "@name": "posts" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { "@fields": "id" } },
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

describe("renderHooksFile — source-aware dispatch", () => {
  describe("projection path (isProjection = true)", () => {
    test("emits useProgramSummary and useProgramSummaries (list hook, y→ies pluralization)", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).toContain("useProgramSummary");
      expect(out).toContain("useProgramSummaries");
      expect(out).not.toContain("useProgramSummarys");
    });

    test("does NOT emit useCreateProgramSummary, useUpdateProgramSummary, useDeleteProgramSummary", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).not.toContain("useCreateProgramSummary");
      expect(out).not.toContain("useUpdateProgramSummary");
      expect(out).not.toContain("useDeleteProgramSummary");
    });

    test("emits query-key factory (programSummaryKeys)", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).toContain("programSummaryKeys");
    });

    test("does NOT import ProgramSummaryInsert or ProgramSummaryUpdate", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).not.toContain("ProgramSummaryInsert");
      expect(out).not.toContain("ProgramSummaryUpdate");
    });

    test("does NOT import useMutation or useQueryClient", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).not.toContain("useMutation");
      expect(out).not.toContain("useQueryClient");
    });

    test("imports from @tanstack/react-query and @metaobjects/runtime-ts-client", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).toContain("@tanstack/react-query");
      expect(out).toContain("@metaobjects/runtime-ts-client");
    });

    test("fetch URLs use $apiPrefix before $path", () => {
      const { projection, ctx } = loadProjectionFixture();
      const out = renderHooksFile(projection, ctx);
      expect(out).toContain("ProgramSummary.$apiPrefix");
      expect(out).toContain("${ProgramSummary.$apiPrefix}${ProgramSummary.$path}");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits usePost and usePosts", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("usePost");
      expect(out).toContain("usePosts");
    });

    test("emits useCreatePost, useUpdatePost, useDeletePost", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("useCreatePost");
      expect(out).toContain("useUpdatePost");
      expect(out).toContain("useDeletePost");
    });

    test("emits query-key factory (postKeys)", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("postKeys");
    });

    test("imports PostInsert and PostUpdate", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      expect(out).toContain("PostInsert");
      expect(out).toContain("PostUpdate");
    });

    test("mutation hooks invalidate via postKeys.all()", () => {
      const { entity, ctx } = loadVanillaFixture();
      const out = renderHooksFile(entity, ctx);
      const matches = out.match(/invalidateQueries\(\{\s*queryKey:\s*postKeys\.all\(\)/g);
      expect(matches?.length).toBe(3); // create, update, delete
    });
  });
});
