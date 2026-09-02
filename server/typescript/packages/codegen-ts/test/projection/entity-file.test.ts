// Tests for source-aware dispatch in renderEntityFile.
// Verifies that:
//   - projection entities route through renderProjectionDecl (view + Zod read schema)
//   - vanilla entities still go through the Drizzle-table path

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
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
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

// ---------------------------------------------------------------------------
// Fixture: ProgramSummary projection (extends Program, source.rdb @kind:view)
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
          { "field.int": { name: "id", extends: "Program.id" } },
          { "field.string": { name: "title", extends: "Program.title" } },
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

    test("declared extends-bound fields appear in schema (FR-024 inclusive list)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      // id and title are DECLARED extends-bound fields (the inclusive list)
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

  // A contract-only target (selfTarget.runtime === false) is the UI/wire-package
  // axis: no server runtime bindings at all. A projection keeps its Zod read
  // schema + inferred type but drops the Drizzle view; a write-through entity
  // renders as its plain shape (interface + Zod) instead of a Drizzle table.
  // Neither imports drizzle-orm. This replaces the old per-call includeViewDecl
  // flag — the decision now lives on the target's audience, not on each artifact.
  describe("contract-only target (runtime: false)", () => {
    function contractCtx(root: Parameters<typeof buildPkMap>[0]) {
      return makeRenderContext({
        dialect: "postgres",
        loadedRoot: root,
        outDir: "/x",
        dbImport: "~/db",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
        selfTarget: {
          name: "shared", outDir: "/x", importBase: "@pkg/shared/generated",
          outputLayout: "flat", dbImport: "~/db", runtime: false,
        },
      });
    }

    test("projection: keeps Zod read schema + type, drops pgView + drizzle-orm", async () => {
      const { root, projection } = await loadProjectionFixture();
      const out = renderEntityFile(projection, contractCtx(root));
      // contract kept:
      expect(out).toContain("ProgramSummarySchema");
      expect(out).toContain("export type ProgramSummary");
      // runtime stripped:
      expect(out).not.toContain("pgView");
      expect(out).not.toContain(".existing()");
      expect(out).not.toContain("drizzle-orm");
    });

    test("write-through entity: renders plain shape, no pgTable / drizzle-orm", async () => {
      const { root, entity } = await loadVanillaFixture();
      const out = renderEntityFile(entity, contractCtx(root));
      // shape kept (Zod schema + a type for the entity):
      expect(out).toContain("z.object");
      expect(out).toContain("Post");
      // runtime stripped:
      expect(out).not.toContain("pgTable");
      expect(out).not.toContain("drizzle-orm");
      expect(out).not.toContain("InferSelectModel");
    });

    test("no runtime-ts allowlists in a contract target", async () => {
      const { root, projection } = await loadProjectionFixture();
      const out = renderEntityFile(projection, contractCtx(root));
      expect(out).not.toContain("@metaobjectsdev/runtime-ts");
      expect(out).not.toContain("FilterAllowlist");
    });
  });
});

// ---------------------------------------------------------------------------
// §A6 Task 1 — a projection's dbCol + view name/columns reference the names
// artifact. Own fixture (NOT loadProjectionFixture above): the discriminating
// assertion needs a field whose @column is deliberately NOT the snake_case of
// its field name (`callPurpose` -> `purpose_code`), so a re-derivation that
// ignored @column would produce `call_purpose` and this test would catch it.
// ---------------------------------------------------------------------------

async function loadProjectionNamesFixture(includeNames: boolean) {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          // Deliberately NOT the snake_case of the field name.
          { "field.string": { name: "callPurpose", "@column": "purpose_code" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "field.int": { name: "id", extends: "Program.id" } },
          { "field.string": { name: "callPurpose", extends: "Program.callPurpose" } },
          { "identity.primary": { "name": "id", extends: "Program.id" } },
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
    includeNames,
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, projection, ctx };
}

describe("renderEntityFile — a projection's dbCol + view name/columns reference the names artifact (§A6)", () => {
  test("with the names generator ACTIVE, dbCol references the constant, honoring an inherited @column", async () => {
    const { projection, ctx } = await loadProjectionNamesFixture(true);
    const out = renderEntityFile(projection, ctx);

    expect(out).toContain("dbCol: ProgramSummaryNames.fields.callPurpose.column");
    // The literal must be GONE, not merely accompanied.
    expect(out).not.toContain('dbCol: "purpose_code"');
    // And the re-derivation trap: a naive snake_case-of-the-field-name transform
    // would have produced this instead of honoring the inherited @column.
    expect(out).not.toContain('dbCol: "call_purpose"');
  });

  test("with the names generator ACTIVE, the Drizzle view declaration references the view name + column constants", async () => {
    const { projection, ctx } = await loadProjectionNamesFixture(true);
    const out = renderEntityFile(projection, ctx);

    expect(out).toContain("sqliteView(ProgramSummaryNames.name");
    expect(out).toContain("ProgramSummaryNames.fields.callPurpose.column");
    expect(out).not.toContain('sqliteView("v_program_summary"');
    expect(out).not.toContain('"purpose_code"');
  });

  test("with the names generator NOT in the run, the projection keeps every literal", async () => {
    const { projection, ctx } = await loadProjectionNamesFixture(false);
    const out = renderEntityFile(projection, ctx);

    expect(out).toContain('dbCol: "purpose_code"');
    expect(out).toContain('sqliteView("v_program_summary"');
    expect(out).not.toContain("ProgramSummaryNames");
  });
});
