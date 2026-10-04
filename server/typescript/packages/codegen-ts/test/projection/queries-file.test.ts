// Tests for source-aware dispatch in renderQueriesFile.
// Regression for a real bug: the entity-file generator omits InsertSchema for a
// projection (read-only), but the queries generator used to UNCONDITIONALLY import
// `<Name>InsertSchema` and emit create/update — referencing exports the projection
// file never produces → `TS2724`. A projection's queries must be read-only:
// findById + list selecting from the VIEW var, no insert import, no writes.

import { describe, test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MetaDataLoader, InMemoryStringSource, loadUris, reportReadModel } from "@metaobjectsdev/metadata";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { renderEntityFile } from "../../src/templates/entity-file.js";
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

// ---------------------------------------------------------------------------
// FR-044 Plan 3 — a served report, a keyless projection, and the decimal read type
// ---------------------------------------------------------------------------

// test/projection → test → codegen-ts → packages → typescript → server → repo root
const REPO_FIXTURES = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..", "fixtures");

async function loadFile(...segments: string[]): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(join(REPO_FIXTURES, ...segments)).href]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

function readModel(root: MetaRoot, name: string): MetaObject {
  const report = root.objects().find((o) => o.name === name);
  if (!report) throw new Error(`${name} not found`);
  return reportReadModel(report, root);
}

function pgCtx(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
}

/** A served report whose first dimension is named `id`: the read model then has a field
 *  called `id`, which must not be mistaken for an identity. */
const REPORT_WITH_ID_FIELD = [
  {
    "object.entity": {
      name: "Invoice",
      children: [
        { "source.rdb": { "@table": "invoices" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "status" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "dimension.attribute": { name: "id", "@of": "Invoice.id" } },
        { "measure.aggregate": { name: "invoices", "@agg": "count", "@of": "Invoice.id" } },
      ],
    },
  },
  {
    "object.report": {
      name: "InvoiceRows",
      "@from": "Invoice",
      "@dimensions": ["id"],
      "@measures": ["invoices"],
      children: [{ "source.rdb": { "@kind": "view", "@table": "v_invoice_rows" } }],
    },
  },
];

describe("renderQueriesFile — a served report and a keyless projection (FR-044 Plan 3)", () => {
  test("a served report gets a list query and no by-id query", async () => {
    const root = await loadFile("codegen-noop", "reporting", "with", "meta.shop.json");
    const out = renderQueriesFile(readModel(root, "StoreTotals"), pgCtx(root));
    expect(out).toContain("export async function listStoreTotals(");
    expect(out).toContain("from(storeTotalsView)");
    expect(out).not.toContain("findStoreTotalsById");
    expect(out).not.toContain("ById");
    // `eq` was only ever imported for the by-id predicate.
    expect(out).not.toContain("drizzle-orm\"");
    expect(out).toContain("— report (read-only)");
    expect(out).not.toContain("projection");
  });

  test("a projection with an `id` column and no declared identity keeps its by-id query", async () => {
    // The id-by-convention shape: `getPkInfo` falls back to `id`, the column exists, and
    // the query compiles and works. It is not keyless, and its output does not move.
    const { projection, ctx } = await loadProjectionFixture();
    expect(projection.primaryIdentity()).toBeUndefined();
    const out = renderQueriesFile(projection, ctx);
    expect(out).toContain("export async function findProgramSummaryById(db: Db, id: number)");
    expect(out).toContain("eq(programSummaryView.id, id)");
  });

  test("a report with a derived field named `id` still gets no by-id query", async () => {
    const root = await loadMetadata(REPORT_WITH_ID_FIELD);
    const out = renderQueriesFile(readModel(root, "InvoiceRows"), pgCtx(root));
    expect(out).toContain("export async function listInvoiceRows(");
    expect(out).not.toContain("ById");
  });

  test("a keyless projection (no identity, no `id` column) gets a list query and no by-id query", async () => {
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Tag",
          children: [
            { "source.rdb": { "@table": "tags" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "label" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "TagLabel",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_tag_label" } },
            { "field.string": { name: "label", extends: "Tag.label" } },
          ],
        },
      },
    ]);
    const projection = root.objects().find((o) => o.name === "TagLabel");
    if (!projection) throw new Error("TagLabel not found");
    const out = renderQueriesFile(projection, makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    }));
    expect(out).toContain("export async function listTagLabels(");
    expect(out).not.toContain("ById");
    expect(out).toContain("— projection (read-only)");
  });

  test("a decimal derived field is a string in the read schema", async () => {
    const root = await loadFile("persistence-conformance", "canonical", "meta.fitness.json");
    const out = renderEntityFile(readModel(root, "ProgramMinutes"), pgCtx(root));
    const squashed = out.replace(/\s+/g, " ");
    expect(squashed).toContain("avgMinutes: z.string().nullable()");
    expect(squashed).toContain("longShare: z.string().nullable()");
    expect(squashed).toContain("totalMinutes: z.number().int().nullable()");
  });
});
