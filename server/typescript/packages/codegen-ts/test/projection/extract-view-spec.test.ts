import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";

// ---------------------------------------------------------------------------
// Helper — wraps an array of top-level node objects in the metadata envelope
// expected by MetaDataLoader and returns { root } with errors thrown if any.
// ---------------------------------------------------------------------------
async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
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

    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    expect(spec.viewName).toBe("v_program_summary");
    expect(spec.joinTree.baseEntity).toBe("Program");
    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0]!.relationship).toBe("weeks");
    expect(spec.joinTree.joins[0]!.targetEntity).toBe("Week");
    expect(spec.joinTree.joins[0]!.fkColumn).toBe("program_id");

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

describe("extractViewSpec — @via over a reference-only FK (FR-024)", () => {
  test("passthrough joins the parent via an identity.reference, no relationship declared", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Enrollment",
          children: [
            { "source.rdb": { "@table": "enrollments" } },
            { "field.int": { name: "id" } },
            { "field.int": { name: "programId" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            // A reference-only FK to Program — NO correlated relationship.
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "EnrollmentView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_enrollment" } },
            { "field.int": { name: "id", extends: "Enrollment.id" } },
            { "identity.primary": { name: "id", extends: "Enrollment.id" } },
            {
              "field.string": {
                name: "program_title",
                children: [
                  {
                    "origin.passthrough": {
                      "@from": "Program.title",
                      // @via names the identity.reference, not a relationship.
                      "@via": "Enrollment.ref_program",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "EnrollmentView")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    expect(spec.viewName).toBe("v_enrollment");
    expect(spec.joinTree.baseEntity).toBe("Enrollment");
    expect(spec.joinTree.joins.length).toBe(1);
    const join = spec.joinTree.joins[0]!;
    expect(join.relationship).toBe("ref_program"); // the reference name IS the hop
    expect(join.targetEntity).toBe("Program");
    expect(join.fkColumn).toBe("program_id"); // FK on Enrollment (the holder/source)
    expect(join.cardinality).toBe("one"); // a forward FK is inherently to-one
    expect(join.referenceHolder).toBe("source");

    const programTitle = spec.selectSpec.columns.find((c) => c.fieldName === "program_title")!;
    expect(programTitle).toBeDefined();
  });
});

describe("extractViewSpec — multi-level via path", () => {
  test("Program.weeks.workouts → 2 joins (1 child on the first join)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "field.int": { name: "id", } },
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
            { "source.rdb": { "@table": "workouts" } },
            { "field.int": { name: "id", } },
            { "field.int": { name: "weekId", } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_week", "@fields": "weekId", "@references": "Week" } },
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
            { "field.string": { name: "title", } },
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
            {
              "field.string": {
                name: "firstWeekTitle",
                children: [
                  {
                    // FR-024 (ADR-0029): a passthrough through a to-many hop is a
                    // row-multiplying passthrough and is now ERR_ORIGIN_CARDINALITY
                    // at load — an aggregate (min) over the same @via keeps this
                    // test's purpose intact: two origins sharing one @via.
                    "origin.aggregate": {
                      "@agg": "min",
                      "@of": "Week.title",
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

    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Both fields reference Program.weeks — should deduplicate to a single join node.
    expect(spec.joinTree.joins.length).toBe(1);
    expect(spec.joinTree.joins[0]!.relationship).toBe("weeks");
    // Both weekCount (count) and firstWeekTitle (min) appear in columns.
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
            { "source.rdb": { "@table": "programs" } },
            { "field.int": { name: "id", } },
            { "field.string": { name: "title", } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ProgramView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_program_view" } },
            { "field.int": { name: "id", extends: "Program.id" } },
            { "field.string": { name: "title", extends: "Program.title" } },
            { "identity.primary": { "name": "id", extends: "Program.id" } },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "ProgramView")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // No cross-entity origins → no joins
    expect(spec.joinTree.joins.length).toBe(0);

    // The two declared extends-bound fields ARE the exposure (fail-closed) —
    // assert membership so the all-passthrough loop below can't pass vacuously.
    expect(spec.selectSpec.columns.map((c) => c.fieldName).sort()).toEqual(["id", "title"]);

    // All columns are passthrough onto the base alias
    for (const col of spec.selectSpec.columns) {
      expect(col.kind).toBe("passthrough");
      if (col.kind === "passthrough") {
        expect(col.sourceAlias).toBe(spec.joinTree.baseAlias);
      }
    }

    // No aggregates → no GROUP BY
    expect(spec.groupBy).toEqual([]);
  });
});

describe("extractViewSpec — pkColumn resolution", () => {
  test("defaults pkColumn to parent primary identity field's column", async () => {
    const root = await load([
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

    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Default: parent's primary identity field is "id" → column "id"
    expect(spec.joinTree.joins[0]!.pkColumn).toBe("id");
  });

  test("uses explicit dotted @references when set (non-id join like email)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.int": { name: "id", } },
            { "field.string": { name: "email", } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
            { "identity.secondary": { "name": "byEmail", "@fields": "email" } },
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
            { "source.rdb": { "@table": "purchases" } },
            { "field.int": { name: "id", } },
            { "field.string": { name: "customerEmail", } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_customer", "@fields": "customerEmail", "@references": "Customer.email" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "CustomerSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_customer_summary" } },
            { "field.int": { name: "id", extends: "Customer.id" } },
            { "identity.primary": { "name": "id", extends: "Customer.id" } },
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
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "CustomerSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    // Must resolve to the "email" column (via the secondary identity), not "id"
    expect(spec.joinTree.joins[0]!.pkColumn).toBe("email");
    expect(spec.joinTree.joins[0]!.fkColumn).toBe("customer_email");
  });
});

describe("extractViewSpec — belongs-to via identity.reference", () => {
  test("Purchase.program (one): pkColumn is target's PK, referenceHolder='source'", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "field.long":   { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "field.long":   { name: "id" } },
            { "field.long":   { name: "programId" } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
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
        "object.projection": {
          name: "PurchaseSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_purchase_summary" } },
            { "field.long": { name: "id", extends: "Purchase.id" } },
            { "identity.primary": { "name": "id", extends: "Purchase.id" } },
            {
              "field.string": {
                name: "programTitle",
                children: [
                  { "origin.passthrough": { "@from": "Program.title", "@via": "Purchase.program" } },
                ],
              },
            },
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
    expect(join.fkColumn).toBe("program_id");
    expect(join.pkColumn).toBe("id");
  });
});

// ---------------------------------------------------------------------------
// #195 — resolution of the four new origin read-model capabilities.
// ---------------------------------------------------------------------------

describe("extractViewSpec — #195 predicate quantifier (any/all)", () => {
  test("origin.aggregate @agg:any resolves a predicateAgg column (no @of; @via terminal + phantom-guard pk)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Session",
          children: [
            { "source.rdb": { "@table": "sessions" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "relationship.association": { name: "turns", "@objectRef": "Turn", "@cardinality": "many" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Turn",
          children: [
            { "source.rdb": { "@table": "turns" } },
            { "field.int": { name: "id" } },
            { "field.int": { name: "sessionId" } },
            { "field.boolean": { name: "success" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_session", "@fields": "sessionId", "@references": "Session" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "SessionSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_session_summary" } },
            { "field.int": { name: "id", extends: "Session.id" } },
            { "identity.primary": { name: "id", extends: "Session.id" } },
            {
              "field.boolean": {
                name: "hasError",
                children: [
                  { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { success: false } } },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "SessionSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "hasError")!;
    expect(col.kind).toBe("predicateAgg");
    if (col.kind === "predicateAgg") {
      expect(col.quant).toBe("any");
      expect(col.joinedPkColumn).toBe("id");
      expect(col.pred).toEqual({ kind: "cmp", ref: `${col.sourceAlias}.success`, op: "eq", value: false });
    }
    // A predicateAgg forces GROUP BY on the base passthrough columns.
    expect(spec.groupBy).toContain(`${spec.joinTree.baseAlias}.id`);
  });
});

describe("extractViewSpec — #195 array rollup (collect)", () => {
  test("origin.aggregate @agg:collect resolves a collectAgg column with @distinct + @of column", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "relationship.association": { name: "items", "@objectRef": "Item", "@cardinality": "many" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Item",
          children: [
            { "source.rdb": { "@table": "items" } },
            { "field.int": { name: "id" } },
            { "field.int": { name: "orderId" } },
            { "field.string": { name: "category" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_order", "@fields": "orderId", "@references": "Order" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "OrderSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_order_summary" } },
            { "field.int": { name: "id", extends: "Order.id" } },
            { "identity.primary": { name: "id", extends: "Order.id" } },
            {
              "field.string": {
                name: "categories",
                isArray: true,
                children: [
                  { "origin.aggregate": { "@agg": "collect", "@of": "Item.category", "@via": "Order.items", "@distinct": true } },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "OrderSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "categories")!;
    expect(col.kind).toBe("collectAgg");
    if (col.kind === "collectAgg") {
      expect(col.distinct).toBe(true);
      expect(col.sourceColumn).toBe("category");
      expect(col.joinedPkColumn).toBe("id");
      expect(col.orderBy).toEqual([]);
    }
    expect(spec.groupBy.length).toBeGreaterThan(0);
  });
});

describe("extractViewSpec — #195 computed expression", () => {
  test("origin.computed resolves a computed column with base-field refs lowered to the base alias", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Session",
          children: [
            { "source.rdb": { "@table": "sessions" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "payloadJson" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "SessionFlags",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_session_flags" } },
            { "field.int": { name: "id", extends: "Session.id" } },
            { "identity.primary": { name: "id", extends: "Session.id" } },
            {
              "field.boolean": {
                name: "hasPayload",
                children: [
                  { "origin.computed": { "@expr": { op: "isNotNull", arg: { field: "payloadJson" } } } },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "SessionFlags")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "hasPayload")!;
    expect(col.kind).toBe("computed");
    if (col.kind === "computed") {
      expect(col.expr).toEqual({
        kind: "nullTest",
        negated: true,
        arg: { kind: "col", ref: `${spec.joinTree.baseAlias}.payload_json` },
      });
    }
    // computed alone (no aggregate) → no GROUP BY.
    expect(spec.groupBy).toEqual([]);
  });
});

describe("extractViewSpec — #195 correlated first", () => {
  test("origin.first resolves a first column with a fresh child alias + PK tie-breaker + correlation", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Parent",
          children: [
            { "source.rdb": { "@table": "parents" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "relationship.association": { name: "childAs", "@objectRef": "ChildA", "@cardinality": "many" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "ChildA",
          children: [
            { "source.rdb": { "@table": "child_as" } },
            { "field.int": { name: "id" } },
            { "field.int": { name: "parentId" } },
            { "field.string": { name: "label" } },
            { "field.timestamp": { name: "createdAt" } },
            { "field.boolean": { name: "isActive" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_parent", "@fields": "parentId", "@references": "Parent" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ParentSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_parent_summary" } },
            { "field.int": { name: "id", extends: "Parent.id" } },
            { "identity.primary": { name: "id", extends: "Parent.id" } },
            {
              "field.string": {
                name: "currentLabel",
                children: [
                  {
                    "origin.first": {
                      "@of": "ChildA.label",
                      "@via": "Parent.childAs",
                      "@orderBy": ["createdAt:desc"],
                      "@filter": { isActive: true },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "ParentSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "currentLabel")!;
    expect(col.kind).toBe("first");
    if (col.kind === "first") {
      expect(col.childEntity).toBe("ChildA");
      expect(col.sourceColumn).toBe("label");
      expect(col.referenceHolder).toBe("target"); // FK (parent_id) lives on the child
      expect(col.fkColumn).toBe("parent_id");
      expect(col.pkColumn).toBe("id");
      expect(col.childPkColumn).toBe("id");
      expect(col.orderBy).toEqual([{ column: "created_at", dir: "desc" }]);
      expect(col.filter).toEqual({ kind: "cmp", ref: `${col.childAlias}.is_active`, op: "eq", value: true });
      // The child alias is FRESH — it must not be the base alias.
      expect(col.childAlias).not.toBe(spec.joinTree.baseAlias);
    }
    // first is correlated (scalar-per-row) → no join in the tree, no GROUP BY.
    expect(spec.joinTree.joins).toEqual([]);
    expect(spec.groupBy).toEqual([]);
  });
});

describe("extractViewSpec — #195 join-inflation WARN (spec §6)", () => {
  const twoManyBranchModel = (): unknown[] => [
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "relationship.association": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
          { "relationship.association": { name: "sessions", "@objectRef": "Sess", "@cardinality": "many" } },
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
          { "field.int": { name: "points" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Sess",
        children: [
          { "source.rdb": { "@table": "sessions" } },
          { "field.int": { name: "id" } },
          { "field.int": { name: "programId" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
  ];

  function captureWarn(fn: () => void): string[] {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try { fn(); } finally { console.warn = orig; }
    return warnings;
  }

  test("sum + two independent many-branches → WARN naming the sensitive field", async () => {
    const model = [
      ...twoManyBranchModel(),
      {
        "object.projection": {
          name: "ProgramTotals",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_program_totals" } },
            { "field.int": { name: "id", extends: "Program.id" } },
            { "identity.primary": { name: "id", extends: "Program.id" } },
            {
              "field.int": {
                name: "totalPoints",
                children: [{ "origin.aggregate": { "@agg": "sum", "@of": "Week.points", "@via": "Program.weeks" } }],
              },
            },
            {
              "field.int": {
                name: "sessionCount",
                children: [{ "origin.aggregate": { "@agg": "count", "@of": "Sess.id", "@via": "Program.sessions" } }],
              },
            },
          ],
        },
      },
    ];
    const root = await load(model);
    const projection = root.objects().find((o) => o.name === "ProgramTotals")!;
    const warnings = captureWarn(() => extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" }));
    expect(warnings.join("\n")).toMatch(/inflation-sensitive/i);
    expect(warnings.join("\n")).toContain("totalPoints");
  });

  test("count-only over two many-branches → NO warn (inflation-immune)", async () => {
    const model = [
      ...twoManyBranchModel(),
      {
        "object.projection": {
          name: "ProgramCounts",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_program_counts" } },
            { "field.int": { name: "id", extends: "Program.id" } },
            { "identity.primary": { name: "id", extends: "Program.id" } },
            {
              "field.int": {
                name: "weekCount",
                children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }],
              },
            },
            {
              "field.int": {
                name: "sessionCount",
                children: [{ "origin.aggregate": { "@agg": "count", "@of": "Sess.id", "@via": "Program.sessions" } }],
              },
            },
          ],
        },
      },
    ];
    const root = await load(model);
    const projection = root.objects().find((o) => o.name === "ProgramCounts")!;
    const warnings = captureWarn(() => extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" }));
    expect(warnings).toEqual([]);
  });
});
