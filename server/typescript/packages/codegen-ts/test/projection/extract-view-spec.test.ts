import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";

// ---------------------------------------------------------------------------
// Helper — wraps an array of top-level node objects in the metadata envelope
// expected by MetaDataLoader and returns { root } with errors thrown if any.
// ---------------------------------------------------------------------------
async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

describe("extractViewSpec — flat passthrough via extends", () => {
  test("ProgramSummary extends Program with 1 aggregate field", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.dbTable": { "@name": "programs" } },
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
            { "source.dbTable": { "@name": "weeks" } },
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
          "extends": "Program",
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

    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    expect(spec.viewName).toBe("v_program_summary");
    expect(spec.joinTree.baseEntity).toBe("Program");
    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0]!.relationship).toBe("weeks");
    expect(spec.joinTree.joins[0]!.targetEntity).toBe("Week");
    expect(spec.joinTree.joins[0]!.fkField).toBe("programId");

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
  test("Program.weeks.workouts → 2 joins (1 child on the first join)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.dbTable": { "@name": "programs" } },
            { "field.int": { name: "id", } },
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
            { "source.dbTable": { "@name": "weeks" } },
            { "field.int": { name: "id", } },
            { "field.int": { name: "programId", } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
            {
              "relationship.association": {
                name: "workouts",
                "@objectRef": "Workout",
                "@cardinality": "many",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "Workout",
          children: [
            { "source.dbTable": { "@name": "workouts" } },
            { "field.int": { name: "id", } },
            { "field.int": { name: "weekId", } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_week", "@fields": "weekId", "@references": "Week" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "ProgramSummary",
          "extends": "Program",
          children: [
            { "source.dbView": { "@name": "v_program_summary" } },
            {
              "field.int": {
                name: "workoutCount",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "count",
                      "@of": "Workout.id",
                      "@via": "Program.weeks.workouts",
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

    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0]!.children.length).toBe(1);
    expect(spec.joinTree.joins[0]!.children[0]!.targetEntity).toBe("Workout");
  });
});

describe("extractViewSpec — shared @via deduplication", () => {
  test("two aggregates sharing the same @via produce ONE join", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.dbTable": { "@name": "programs" } },
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
            { "source.dbTable": { "@name": "weeks" } },
            { "field.int": { name: "id", } },
            { "field.int": { name: "programId", } },
            { "field.string": { name: "title", } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "ProgramSummary",
          "extends": "Program",
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
            {
              "field.string": {
                name: "firstWeekTitle",
                children: [
                  {
                    "origin.passthrough": {
                      "@from": "Week.title",
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

    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Both fields reference Program.weeks — should deduplicate to a single join node.
    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0]!.relationship).toBe("weeks");
    // Both weekCount (aggregate) and firstWeekTitle (passthrough) appear in columns.
    const fieldNames = spec.selectSpec.columns.map((c) => c.fieldName);
    expect(fieldNames).toContain("weekCount");
    expect(fieldNames).toContain("firstWeekTitle");
  });
});

describe("extractViewSpec — pure-extends projection (no origin children)", () => {
  test("pure-extends projection with no additional fields has empty join tree and all-passthrough columns", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.dbTable": { "@name": "programs" } },
            { "field.int": { name: "id", } },
            { "field.string": { name: "title", } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "ProgramView",
          "extends": "Program",
          children: [
            { "source.dbView": { "@name": "v_program_view" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "ProgramView")!;
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

describe("extractViewSpec — pkField resolution", () => {
  test("defaults pkField to parent primary identity field name", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.dbTable": { "@name": "programs" } },
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
            { "source.dbTable": { "@name": "weeks" } },
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
          "extends": "Program",
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

    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Default: parent's primary identity field is "id"
    expect(spec.joinTree.joins[0]!.pkField).toBe("id");
  });

  test("uses explicit dotted @references when set (non-id join like email)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.dbTable": { "@name": "customers" } },
            { "field.int": { name: "id", } },
            { "field.string": { name: "email", } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.secondary": { "@fields": "email" } },
            {
              "relationship.association": {
                name: "purchases",
                "@objectRef": "Purchase",
                "@cardinality": "many",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "source.dbTable": { "@name": "purchases" } },
            { "field.int": { name: "id", } },
            { "field.string": { name: "customerEmail", } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_customer", "@fields": "customerEmail", "@references": "Customer.email" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "CustomerSummary",
          "extends": "Customer",
          children: [
            { "source.dbView": { "@name": "v_customer_summary" } },
            {
              "field.int": {
                name: "purchaseCount",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "count",
                      "@of": "Purchase.id",
                      "@via": "Customer.purchases",
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

    const projection = root.objects().find((o) => o.name === "CustomerSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Must resolve to "email", not "id"
    expect(spec.joinTree.joins[0]!.pkField).toBe("email");
    expect(spec.joinTree.joins[0]!.fkField).toBe("customerEmail");
  });
});

describe("extractViewSpec — belongs-to via identity.reference", () => {
  test("Purchase.program (one): pkField is target's PK, referenceHolder='source'", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "field.long":   { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "field.long":   { name: "id" } },
            { "field.long":   { name: "programId" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
            {
              "relationship.association": {
                name: "program",
                "@cardinality": "one",
                "@objectRef": "Program",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "PurchaseSummary",
          "extends": "Purchase",
          children: [
            { "source.dbView": { "@name": "v_purchase_summary" } },
            {
              "field.string": {
                name: "programTitle",
                children: [
                  { "origin.passthrough": { "@from": "Program.title", "@via": "Purchase.program" } },
                ],
              },
            },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
    ]);

    const proj = root.objects().find((o) => o.name === "PurchaseSummary")!;
    const spec = extractViewSpec(proj, root, { columnNamingStrategy: "snake_case" });

    expect(spec.joinTree.joins).toHaveLength(1);
    const join = spec.joinTree.joins[0]!;
    expect(join.cardinality).toBe("one");
    expect(join.referenceHolder).toBe("source");
    expect(join.fkField).toBe("programId");
    expect(join.pkField).toBe("id");
  });
});
