// Tests for source-aware dispatch in renderQueriesFile.
// Regression for a real bug: the entity-file generator omits InsertSchema for a
// projection (read-only), but the queries generator used to UNCONDITIONALLY import
// `<Name>InsertSchema` and emit create/update — referencing exports the projection
// file never produces → `TS2724`. A projection's queries must be read-only:
// findById + list selecting from the VIEW var, no insert import, no writes.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

async function loadMetadata(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
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
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "relationship.association": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
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
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "field.int": { name: "id" } },
          {
            "field.int": {
              name: "weekCount",
              children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }],
            },
          },
        ],
      },
    },
  ]);
  const projection = root.objects().find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found");
  const ctx = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return { root, projection, ctx };
}

async function loadVanillaFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Post",
        children: [
          { "source.rdb": { "@table": "posts" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    },
  ]);
  const entity = root.objects().find((o) => o.name === "Post");
  if (!entity) throw new Error("Post not found");
  const ctx = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return { root, entity, ctx };
}

describe("renderQueriesFile — source-aware dispatch", () => {
  describe("projection path (read-only queries)", () => {
    test("emits @generated header", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      expect(renderQueriesFile(projection, ctx)).toContain(GENERATED_HEADER);
    });

    test("does NOT import or reference InsertSchema (the TS2724 bug)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      expect(renderQueriesFile(projection, ctx)).not.toContain("InsertSchema");
    });

    test("emits read-only queries only — findById + list, NO create/update/delete", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderQueriesFile(projection, ctx);
      expect(out).toContain("findProgramSummaryById");
      expect(out).toContain("listProgramSummaries");
      expect(out).not.toContain("createProgramSummary");
      expect(out).not.toContain("updateProgramSummary");
      expect(out).not.toContain("deleteProgramSummary");
    });

    test("selects from the VIEW var (programSummaryView), not a table var", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderQueriesFile(projection, ctx);
      expect(out).toContain("programSummaryView");
      expect(out).toContain("from(programSummaryView)");
    });

    test("imports the inferred type ProgramSummary from the entity file", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderQueriesFile(projection, ctx);
      expect(out).toMatch(/import\s*\{[^}]*type ProgramSummary[^}]*\}/);
    });
  });

  describe("vanilla entity path (full CRUD — regression guard)", () => {
    test("still imports InsertSchema and emits create/update", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderQueriesFile(entity, ctx);
      expect(out).toContain("PostInsertSchema");
      expect(out).toContain("createPost");
      expect(out).toContain("updatePost");
    });
  });
});
