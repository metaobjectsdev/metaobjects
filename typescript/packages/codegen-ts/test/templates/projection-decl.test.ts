import { describe, test, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
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
function makeMinimalProjection(projName: string, baseName: string) {
  const loader = new Loader();
  const json = JSON.stringify({
    metadata: {
      package: "test",
      children: [
        {
          object: {
            name: baseName,
            subType: "entity",
            children: [
              { source: { subType: "dbTable", "@name": baseName.toLowerCase() + "s" } },
              { field: { name: "id", subType: "int" } },
              { identity: { subType: "primary", "@fields": "id" } },
            ],
          },
        },
        {
          object: {
            name: projName,
            subType: "entity",
            extends: baseName,
            children: [
              { source: { subType: "dbView", "@name": `v_${projName.toLowerCase()}` } },
              { identity: { subType: "primary", "@fields": "id" } },
            ],
          },
        },
      ],
    },
  });
  const result = loader.loadJson(json);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const root = result.root;
  const projection = root.children().find((o) => o.name === projName)!;
  return { root, projection };
}

describe("pathFromProjectionName — pluralization edge cases", () => {
  test("BoxView → /box-views (x-ending uses pluralize())", () => {
    // "BoxView" → pluralize("BoxView") = "BoxViews" → snake "box_views" → kebab "/box-views"
    const { root, projection } = makeMinimalProjection("BoxView", "Box");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/box-views"');
  });

  test("WishView → /wish-views (sh-ending uses pluralize())", () => {
    const { root, projection } = makeMinimalProjection("WishView", "Wish");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/wish-views"');
  });

  test("ProgramSummary → /program-summaries (y-ending regression)", () => {
    const { root, projection } = makeMinimalProjection("ProgramSummary", "Program");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/program-summaries"');
  });

  test("CustomerSummary → /customer-summaries (y-ending regression)", () => {
    const { root, projection } = makeMinimalProjection("CustomerSummary", "Customer");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/customer-summaries"');
  });
});

// ---------------------------------------------------------------------------
// Helper — load a Program + Week + ProgramSummary tri-entity setup.
// Returns { root, projection } — root is the Loader's root MetaModel (all
// top-level objects are direct children), projection is ProgramSummary.
// ---------------------------------------------------------------------------
function loadProjection() {
  const loader = new Loader();
  const json = JSON.stringify({
    metadata: {
      package: "test",
      children: [
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
      ],
    },
  });

  const result = loader.loadJson(json);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }

  const root = result.root;
  const projection = root
    .children()
    .find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found in root");

  return { root, projection };
}

describe("renderProjectionDecl emits Drizzle view + Zod read schema + constants", () => {
  test("sqlite dialect uses sqliteView", () => {
    const { root, projection } = loadProjection();
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

  test("postgres dialect uses pgView", () => {
    const { root, projection } = loadProjection();
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

  test("inherited fields from super appear in schema and constants", () => {
    const { root, projection } = loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    // Program.id and Program.title are inherited; weekCount is projection-declared
    expect(code).toContain("id:");
    expect(code).toContain("title:");
    expect(code).toContain("weekCount:");
  });

  test("$entity constant matches projection name", () => {
    const { root, projection } = loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain('$entity: "ProgramSummary"');
  });

  test(".existing() is emitted on the view declaration", () => {
    const { root, projection } = loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain(".existing()");
  });

  test("emits FilterAllowlist, SortAllowlist, and Filter type", () => {
    const { root, projection } = loadProjection();
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
