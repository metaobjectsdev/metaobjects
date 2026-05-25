import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderProjectionDecl } from "../../src/templates/projection-decl.js";

// ---------------------------------------------------------------------------
// Unit tests for pathFromProjectionName (Fix 1 — pluralize() for sh/ch/x/z)
// ---------------------------------------------------------------------------
// pathFromProjectionName is not exported; exercise it via renderProjectionDecl
// output and inspect the $path constant. We create minimal projections named
// after the edge-case words to verify the correct URL segment.

/**
 * Build a minimal two-entity setup: a base table entity named `baseName`
 * and a projection named `projName` that extends it. Used to exercise
 * `pathFromProjectionName` via renderProjectionDecl.
 */
async function makeMinimalProjection(projName: string, baseName: string) {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: baseName,
            children: [
              { "source.rdb": { "@table": baseName.toLowerCase() + "s" } },
              { "field.int": { name: "id", } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: projName,
            extends: baseName,
            children: [
              { "source.rdb": { "@kind": "view", "@table": `v_${projName.toLowerCase()}` } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const root = result.root;
  const projection = root.objects().find((o) => o.name === projName)!;
  return { root, projection };
}

describe("pathFromProjectionName — pluralization edge cases", () => {
  test("BoxView → /box-views (x-ending uses pluralize())", async () => {
    // "BoxView" → pluralize("BoxView") = "BoxViews" → snake "box_views" → kebab "/box-views"
    const { root, projection } = await makeMinimalProjection("BoxView", "Box");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/box-views"');
  });

  test("WishView → /wish-views (sh-ending uses pluralize())", async () => {
    const { root, projection } = await makeMinimalProjection("WishView", "Wish");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/wish-views"');
  });

  test("ProgramSummary → /program-summaries (y-ending regression)", async () => {
    const { root, projection } = await makeMinimalProjection("ProgramSummary", "Program");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/program-summaries"');
  });

  test("CustomerSummary → /customer-summaries (y-ending regression)", async () => {
    const { root, projection } = await makeMinimalProjection("CustomerSummary", "Customer");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/customer-summaries"');
  });
});

// ---------------------------------------------------------------------------
// Helper — load a Program + Week + ProgramSummary tri-entity setup.
// Returns { root, projection } — root is the loader's root MetaData (all
// top-level objects are direct children, from LoadResult.root), projection is ProgramSummary.
// ---------------------------------------------------------------------------
async function loadProjection() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
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
      ],
    },
  });

  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }

  const root = result.root;
  const projection = root
    .objects()
    .find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found in root");

  return { root, projection };
}

describe("renderProjectionDecl emits Drizzle view + Zod read schema + constants", () => {
  test("sqlite dialect uses sqliteView", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain("sqliteView");
    expect(code).toContain('"v_program_summary"');
    expect(code).toContain("export const ProgramSummarySchema");
    expect(code).toContain("export const ProgramSummary");
    expect(code).toContain('$view:');
    expect(code).toContain('"v_program_summary"');
    expect(code).toContain('$path:');
    expect(code).toContain('"/program-summaries"');

    // Read-only: no Insert/Update Zod schemas or types
    expect(code).not.toContain("ProgramSummaryInsert");
    expect(code).not.toContain("ProgramSummaryUpdate");
  });

  test("postgres dialect uses pgView", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "postgres",
    });

    expect(code).toContain("pgView");
    expect(code).not.toContain("sqliteView");
    expect(code).toContain('"v_program_summary"');
    expect(code).toContain("export const ProgramSummarySchema");
    expect(code).toContain("export const ProgramSummary");
  });

  test("inherited fields from super appear in schema and constants", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    // Program.id and Program.title are inherited; weekCount is projection-declared
    expect(code).toContain("id:");
    expect(code).toContain("title:");
    expect(code).toContain("weekCount:");
  });

  test("$entity constant matches projection name", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain('$entity: "ProgramSummary"');
  });

  test(".existing() is emitted on the view declaration", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain(".existing()");
  });

  test("emits FilterAllowlist, SortAllowlist, and Filter type", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    // All three filter symbols must be exported so routes can import them.
    expect(code).toContain("ProgramSummaryFilterAllowlist");
    expect(code).toContain("ProgramSummarySortAllowlist");
    expect(code).toContain("ProgramSummaryFilter");
  });
});
