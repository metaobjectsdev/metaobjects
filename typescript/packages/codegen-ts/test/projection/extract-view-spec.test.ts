import { describe, test, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";

// ---------------------------------------------------------------------------
// Helper — wraps an array of top-level node objects in the metadata envelope
// expected by the Loader and returns { root } with errors thrown if any.
// ---------------------------------------------------------------------------
function load(children: unknown[]) {
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

describe("extractViewSpec — flat passthrough via extends", () => {
  test("ProgramSummary extends Program with 1 aggregate field", () => {
    const root = load([
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
            { field: { name: "programId", subType: "int" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "ProgramSummary",
          subType: "entity",
          "extends": "Program",
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

    const projection = root.children().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    expect(spec.viewName).toBe("v_program_summary");
    expect(spec.joinTree.baseEntity).toBe("Program");
    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0].relationship).toBe("weeks");
    expect(spec.joinTree.joins[0].targetEntity).toBe("Week");
    expect(spec.joinTree.joins[0].fkField).toBe("programId");

    // Select columns: id + title (inherited from extends), weekCount (aggregate)
    const fieldNames = spec.selectSpec.columns.map((c) => c.fieldName);
    expect(fieldNames).toContain("id");
    expect(fieldNames).toContain("title");
    expect(fieldNames).toContain("weekCount");

    const weekCount = spec.selectSpec.columns.find((c) => c.fieldName === "weekCount")!;
    expect(weekCount.kind).toBe("aggregate");
    if (weekCount.kind === "aggregate") {
      expect(weekCount.agg).toBe("count");
      expect(weekCount.sourceColumn).toBe("id"); // Week.id → "id" (snake_case no-op)
    }

    // GROUP BY contains the non-aggregate column fragments.
    expect(spec.groupBy.length).toBeGreaterThan(0);
  });
});

describe("extractViewSpec — multi-level via path", () => {
  test("Program.weeks.workouts → 2 joins (1 child on the first join)", () => {
    const root = load([
      {
        object: {
          name: "Program",
          subType: "entity",
          children: [
            { source: { subType: "dbTable", "@name": "programs" } },
            { field: { name: "id", subType: "int" } },
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
            {
              relationship: {
                subType: "association",
                name: "workouts",
                "@objectRef": "Workout",
                "@cardinality": "many",
                "@fkField": "weekId",
              },
            },
          ],
        },
      },
      {
        object: {
          name: "Workout",
          subType: "entity",
          children: [
            { source: { subType: "dbTable", "@name": "workouts" } },
            { field: { name: "id", subType: "int" } },
            { field: { name: "weekId", subType: "int" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "ProgramSummary",
          subType: "entity",
          "extends": "Program",
          children: [
            { source: { subType: "dbView", "@name": "v_program_summary" } },
            {
              field: {
                name: "workoutCount",
                subType: "int",
                children: [
                  {
                    origin: {
                      subType: "aggregate",
                      "@agg": "count",
                      "@of": "Workout.id",
                      "@via": "Program.weeks.workouts",
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

    const projection = root.children().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0].children.length).toBe(1);
    expect(spec.joinTree.joins[0].children[0].targetEntity).toBe("Workout");
  });
});

describe("extractViewSpec — shared @via deduplication", () => {
  test("two aggregates sharing the same @via produce ONE join", () => {
    const root = load([
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
            { field: { name: "programId", subType: "int" } },
            { field: { name: "title", subType: "string" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "ProgramSummary",
          subType: "entity",
          "extends": "Program",
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
            {
              field: {
                name: "firstWeekTitle",
                subType: "string",
                children: [
                  {
                    origin: {
                      subType: "passthrough",
                      "@from": "Week.title",
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

    const projection = root.children().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Both fields reference Program.weeks — should deduplicate to a single join node.
    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0].relationship).toBe("weeks");
    // Both weekCount (aggregate) and firstWeekTitle (passthrough) appear in columns.
    const fieldNames = spec.selectSpec.columns.map((c) => c.fieldName);
    expect(fieldNames).toContain("weekCount");
    expect(fieldNames).toContain("firstWeekTitle");
  });
});

describe("extractViewSpec — pure-extends projection (no origin children)", () => {
  test("pure-extends projection with no additional fields has empty join tree and all-passthrough columns", () => {
    const root = load([
      {
        object: {
          name: "Program",
          subType: "entity",
          children: [
            { source: { subType: "dbTable", "@name": "programs" } },
            { field: { name: "id", subType: "int" } },
            { field: { name: "title", subType: "string" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "ProgramView",
          subType: "entity",
          "extends": "Program",
          children: [
            { source: { subType: "dbView", "@name": "v_program_view" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
    ]);

    const projection = root.children().find((o) => o.name === "ProgramView")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // No cross-entity origins → no joins
    expect(spec.joinTree.joins.length).toBe(0);

    // All columns are passthrough onto the base alias
    for (const col of spec.selectSpec.columns) {
      expect(col.kind).toBe("passthrough");
      expect(col.sourceAlias).toBe(spec.joinTree.baseAlias);
    }

    // No aggregates → no GROUP BY
    expect(spec.groupBy).toEqual([]);
  });
});

describe("extractViewSpec — parentJoinField resolution", () => {
  test("defaults parentJoinField to parent primary identity field name", () => {
    const root = load([
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
          "extends": "Program",
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

    const projection = root.children().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Default: parent's primary identity field is "id"
    expect(spec.joinTree.joins[0].parentJoinField).toBe("id");
  });

  test("uses explicit @parentField when set (non-id join like email)", () => {
    const root = load([
      {
        object: {
          name: "Customer",
          subType: "entity",
          children: [
            { source: { subType: "dbTable", "@name": "customers" } },
            { field: { name: "id", subType: "int" } },
            { field: { name: "email", subType: "string" } },
            { identity: { subType: "primary", "@fields": "id" } },
            {
              relationship: {
                subType: "association",
                name: "purchases",
                "@objectRef": "Purchase",
                "@cardinality": "many",
                "@fkField": "customerEmail",
                "@parentField": "email",
              },
            },
          ],
        },
      },
      {
        object: {
          name: "Purchase",
          subType: "entity",
          children: [
            { source: { subType: "dbTable", "@name": "purchases" } },
            { field: { name: "id", subType: "int" } },
            { field: { name: "customerEmail", subType: "string" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "CustomerSummary",
          subType: "entity",
          "extends": "Customer",
          children: [
            { source: { subType: "dbView", "@name": "v_customer_summary" } },
            {
              field: {
                name: "purchaseCount",
                subType: "int",
                children: [
                  {
                    origin: {
                      subType: "aggregate",
                      "@agg": "count",
                      "@of": "Purchase.id",
                      "@via": "Customer.purchases",
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

    const projection = root.children().find((o) => o.name === "CustomerSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Must resolve to "email", not "id"
    expect(spec.joinTree.joins[0].parentJoinField).toBe("email");
    expect(spec.joinTree.joins[0].fkField).toBe("customerEmail");
  });
});
