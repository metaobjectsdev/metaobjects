import { describe, test, expect } from "bun:test";
import type { ViewSpec } from "../../src/projection/view-spec.js";
import { emitViewDdl } from "../../src/projection/view-ddl-emit.js";

const programSummarySpec: ViewSpec = {
  viewName: "v_program_summary",
  joinTree: {
    baseEntity: "Program",
    baseAlias: "p",
    joins: [
      {
        relationship: "weeks",
        targetEntity: "Week",
        alias: "w",
        cardinality: "many",
        fkColumn: "program_id",
        pkColumn: "id",
        referenceHolder: "target",
        joinType: "left",
        children: [
          {
            relationship: "workouts",
            targetEntity: "Workout",
            alias: "wo",
            cardinality: "many",
            fkColumn: "week_id",
            pkColumn: "id",
            referenceHolder: "target",
            joinType: "left",
            children: [],
          },
        ],
      },
    ],
  },
  selectSpec: {
    columns: [
      { kind: "passthrough", fieldName: "id",    dbColAlias: "id",    sourceAlias: "p", sourceColumn: "id" },
      { kind: "passthrough", fieldName: "title", dbColAlias: "title", sourceAlias: "p", sourceColumn: "title" },
      { kind: "aggregate",   fieldName: "weekCount",    dbColAlias: "week_count",    agg: "count", sourceAlias: "w",  sourceColumn: "id" },
      { kind: "aggregate",   fieldName: "workoutCount", dbColAlias: "workout_count", agg: "count", sourceAlias: "wo", sourceColumn: "id" },
    ],
  },
  groupBy: ["p.id", "p.title"],
};

describe("emitViewDdl — sqlite", () => {
  test("emits CREATE VIEW with JOINs + GROUP BY", () => {
    const sql = emitViewDdl(programSummarySpec, {
      dialect: "sqlite",
      baseTableName: "programs",
      joinTables: { Week: "weeks", Workout: "workouts" },
    });
    expect(sql).toContain("CREATE VIEW v_program_summary AS");
    expect(sql).toMatch(/FROM programs p\b/);
    expect(sql).toMatch(/LEFT OUTER JOIN weeks w ON w\.program_id = p\.id/);
    expect(sql).toMatch(/LEFT OUTER JOIN workouts wo ON wo\.week_id = w\.id/);
    expect(sql).toContain("COUNT(DISTINCT w.id) AS week_count");
    expect(sql).toContain("COUNT(DISTINCT wo.id) AS workout_count");
    expect(sql).toContain("GROUP BY p.id, p.title");
  });
});

describe("emitViewDdl — postgres", () => {
  test("emits the same DDL shape (CREATE VIEW differs only in dialect-specific clauses)", () => {
    const sql = emitViewDdl(programSummarySpec, {
      dialect: "postgres",
      baseTableName: "programs",
      joinTables: { Week: "weeks", Workout: "workouts" },
    });
    expect(sql).toContain("CREATE VIEW v_program_summary AS");
    expect(sql).toMatch(/FROM programs p\b/);
  });
});

describe("emitViewDdl — flat projection with no aggregates", () => {
  test("no GROUP BY clause", () => {
    const spec: ViewSpec = {
      viewName: "v_user",
      joinTree: { baseEntity: "User", baseAlias: "u", joins: [] },
      selectSpec: {
        columns: [
          { kind: "passthrough", fieldName: "id",    dbColAlias: "id",    sourceAlias: "u", sourceColumn: "id" },
          { kind: "passthrough", fieldName: "email", dbColAlias: "email", sourceAlias: "u", sourceColumn: "email" },
        ],
      },
      groupBy: [],
    };
    const sql = emitViewDdl(spec, { dialect: "sqlite", baseTableName: "users", joinTables: {} });
    expect(sql).not.toContain("GROUP BY");
    expect(sql).toContain("FROM users u");
  });
});

describe("emitViewDdl — non-id parent join (pkColumn)", () => {
  test("uses pkColumn instead of id when joining on email", () => {
    const spec: ViewSpec = {
      viewName: "v_customer_summary",
      joinTree: {
        baseEntity: "Customer",
        baseAlias: "c",
        joins: [
          {
            relationship: "purchases",
            targetEntity: "Purchase",
            alias: "p",
            cardinality: "many",
            fkColumn: "customer_email",
            pkColumn: "email",  // non-id join
            referenceHolder: "target",
            joinType: "left",
            children: [],
          },
        ],
      },
      selectSpec: {
        columns: [
          { kind: "passthrough", fieldName: "id",    dbColAlias: "id",    sourceAlias: "c", sourceColumn: "id" },
          { kind: "passthrough", fieldName: "email", dbColAlias: "email", sourceAlias: "c", sourceColumn: "email" },
          { kind: "aggregate",   fieldName: "purchaseCount", dbColAlias: "purchase_count", agg: "count", sourceAlias: "p", sourceColumn: "id" },
        ],
      },
      groupBy: ["c.id", "c.email"],
    };
    const sql = emitViewDdl(spec, {
      dialect: "sqlite",
      baseTableName: "customers",
      joinTables: { Purchase: "purchases" },
    });
    // Must join on customer_email = c.email, NOT c.id
    expect(sql).toMatch(/LEFT OUTER JOIN purchases p ON p\.customer_email = c\.email/);
    // The JOIN condition must not reference c.id (no "= c.id" in the ON clause)
    expect(sql).not.toMatch(/ON p\.customer_email = c\.id/);
    expect(sql).toContain("COUNT(DISTINCT p.id) AS purchase_count");
    expect(sql).toContain("GROUP BY c.id, c.email");
  });
});

// ---------------------------------------------------------------------------
// #195 — the four projection read-model origin lowerings.
// ---------------------------------------------------------------------------

describe("emitViewDdl — #195 predicate quantifier (any/all)", () => {
  const base = (quant: "any" | "all"): ViewSpec => ({
    viewName: "v_session_summary",
    joinTree: {
      baseEntity: "Session",
      baseAlias: "s",
      joins: [
        { relationship: "turns", targetEntity: "Turn", alias: "t", cardinality: "many",
          fkColumn: "session_id", pkColumn: "id", referenceHolder: "target", joinType: "left", children: [] },
      ],
    },
    selectSpec: {
      columns: [
        { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "s", sourceColumn: "id" },
        { kind: "predicateAgg", fieldName: "hasError", dbColAlias: "has_error", quant,
          sourceAlias: "t", joinedPkColumn: "id",
          pred: { kind: "cmp", ref: "t.success", op: "eq", value: false } },
      ],
    },
    groupBy: ["s.id"],
  });

  test("any → COALESCE(bool_or(pred) FILTER (WHERE pk IS NOT NULL), FALSE) on postgres", () => {
    const sql = emitViewDdl(base("any"), { dialect: "postgres", baseTableName: "sessions", joinTables: { Turn: "turns" } });
    expect(sql).toContain("COALESCE(bool_or(t.success = FALSE) FILTER (WHERE t.id IS NOT NULL), FALSE) AS has_error");
  });

  test("all → COALESCE(bool_and(pred) FILTER (WHERE pk IS NOT NULL), TRUE) on postgres", () => {
    const sql = emitViewDdl(base("all"), { dialect: "postgres", baseTableName: "sessions", joinTables: { Turn: "turns" } });
    expect(sql).toContain("COALESCE(bool_and(t.success = FALSE) FILTER (WHERE t.id IS NOT NULL), TRUE) AS has_error");
  });

  test("any → MAX(CASE …) with phantom rows excluded (empty ⇒ 0) on sqlite", () => {
    const sql = emitViewDdl(base("any"), { dialect: "sqlite", baseTableName: "sessions", joinTables: { Turn: "turns" } });
    expect(sql).toContain(
      "COALESCE(MAX(CASE WHEN t.id IS NOT NULL THEN (CASE WHEN t.success = 0 THEN 1 ELSE 0 END) END), 0) AS has_error",
    );
  });

  test("all → MIN(CASE …) with phantom rows excluded (empty ⇒ 1) on sqlite", () => {
    const sql = emitViewDdl(base("all"), { dialect: "sqlite", baseTableName: "sessions", joinTables: { Turn: "turns" } });
    expect(sql).toContain(
      "COALESCE(MIN(CASE WHEN t.id IS NOT NULL THEN (CASE WHEN t.success = 0 THEN 1 ELSE 0 END) END), 1) AS has_error",
    );
  });
});

describe("emitViewDdl — #195 array rollup (collect)", () => {
  const collect = (distinct: boolean, orderBy: { column: string; dir: "asc" | "desc" }[]): ViewSpec => ({
    viewName: "v_order_summary",
    joinTree: {
      baseEntity: "Order",
      baseAlias: "o",
      joins: [
        { relationship: "items", targetEntity: "Item", alias: "i", cardinality: "many",
          fkColumn: "order_id", pkColumn: "id", referenceHolder: "target", joinType: "left", children: [] },
      ],
    },
    selectSpec: {
      columns: [
        { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "o", sourceColumn: "id" },
        { kind: "collectAgg", fieldName: "categories", dbColAlias: "categories",
          sourceAlias: "i", sourceColumn: "category", joinedPkColumn: "id", distinct, orderBy },
      ],
    },
    groupBy: ["o.id"],
  });

  test("distinct → array_agg(DISTINCT of ORDER BY of ASC) FILTER phantom guard, coalesced to '{}' on postgres", () => {
    const sql = emitViewDdl(collect(true, []), { dialect: "postgres", baseTableName: "orders", joinTables: { Item: "items" } });
    expect(sql).toContain(
      "COALESCE(array_agg(DISTINCT i.category ORDER BY i.category ASC) FILTER (WHERE i.id IS NOT NULL), '{}') AS categories",
    );
  });

  test("default (non-distinct, no @orderBy) → value-ascending element order on postgres", () => {
    const sql = emitViewDdl(collect(false, []), { dialect: "postgres", baseTableName: "orders", joinTables: { Item: "items" } });
    expect(sql).toContain(
      "COALESCE(array_agg(i.category ORDER BY i.category ASC) FILTER (WHERE i.id IS NOT NULL), '{}') AS categories",
    );
  });

  test("with @orderBy → orders by the resolved key (nulls last) on postgres", () => {
    const sql = emitViewDdl(collect(false, [{ column: "created_at", dir: "desc" }]),
      { dialect: "postgres", baseTableName: "orders", joinTables: { Item: "items" } });
    expect(sql).toContain(
      "COALESCE(array_agg(i.category ORDER BY i.created_at DESC NULLS LAST) FILTER (WHERE i.id IS NOT NULL), '{}') AS categories",
    );
  });

  test("sqlite → json_group_array coalesced to json_array()", () => {
    const sql = emitViewDdl(collect(true, []), { dialect: "sqlite", baseTableName: "orders", joinTables: { Item: "items" } });
    expect(sql).toContain(
      "COALESCE(json_group_array(DISTINCT i.category ORDER BY i.category ASC) FILTER (WHERE i.id IS NOT NULL), json_array()) AS categories",
    );
  });
});

describe("emitViewDdl — #195 computed expression", () => {
  const computed = (): ViewSpec => ({
    viewName: "v_session_flags",
    joinTree: { baseEntity: "Session", baseAlias: "s", joins: [] },
    selectSpec: {
      columns: [
        { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "s", sourceColumn: "id" },
        { kind: "computed", fieldName: "hasPayload", dbColAlias: "has_payload",
          expr: { kind: "nullTest", negated: true, arg: { kind: "col", ref: "s.payload_json" } } },
      ],
    },
    groupBy: [],
  });

  test("isNotNull → `<col> IS NOT NULL` on both dialects", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      const sql = emitViewDdl(computed(), { dialect, baseTableName: "sessions", joinTables: {} });
      expect(sql).toContain("s.payload_json IS NOT NULL AS has_payload");
    }
  });

  test("nested and/coalesce/comparison lowers to a SQL boolean expression", () => {
    const spec: ViewSpec = {
      viewName: "v_flags",
      joinTree: { baseEntity: "Session", baseAlias: "s", joins: [] },
      selectSpec: {
        columns: [
          { kind: "computed", fieldName: "flag", dbColAlias: "flag",
            expr: { kind: "logic", op: "and", args: [
              { kind: "nullTest", negated: true, arg: { kind: "col", ref: "s.payload_json" } },
              { kind: "cmp", op: "gt",
                left: { kind: "coalesce", args: [ { kind: "col", ref: "s.score" }, { kind: "lit", value: 0 } ] },
                right: { kind: "lit", value: 90 } } ] } },
        ],
      },
      groupBy: [],
    };
    const sql = emitViewDdl(spec, { dialect: "postgres", baseTableName: "sessions", joinTables: {} });
    expect(sql).toContain("(s.payload_json IS NOT NULL AND COALESCE(s.score, 0) > 90) AS flag");
  });
});

describe("emitViewDdl — #195 correlated first (argmax-then-project)", () => {
  const firstSpec = (extraCols: import("../../src/projection/view-spec.js").SelectColumn[] = [], groupBy: string[] = []): ViewSpec => ({
    viewName: "v_parent_summary",
    joinTree: { baseEntity: "Parent", baseAlias: "p", joins: [] },
    selectSpec: {
      columns: [
        { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "p", sourceColumn: "id" },
        ...extraCols,
        { kind: "first", fieldName: "currentLabel", dbColAlias: "current_label",
          childEntity: "ChildA", childAlias: "c0", sourceColumn: "label",
          referenceHolder: "target", fkColumn: "parent_id", pkColumn: "id", childPkColumn: "id",
          orderBy: [{ column: "created_at", dir: "desc" }],
          filter: { kind: "cmp", ref: "c0.is_active", op: "eq", value: true } },
      ],
    },
    groupBy,
  });

  test("emits a correlated scalar subquery with the PK tie-breaker appended, on postgres", () => {
    const sql = emitViewDdl(firstSpec(), { dialect: "postgres", baseTableName: "parents", joinTables: { ChildA: "child_as" } });
    expect(sql).toContain(
      "(SELECT c0.label FROM child_as c0 WHERE c0.parent_id = p.id AND c0.is_active = TRUE ORDER BY c0.created_at DESC NULLS LAST, c0.id ASC LIMIT 1) AS current_label",
    );
  });

  test("sqlite emits the same shape with a sqlite boolean literal in the filter", () => {
    const sql = emitViewDdl(firstSpec(), { dialect: "sqlite", baseTableName: "parents", joinTables: { ChildA: "child_as" } });
    expect(sql).toContain(
      "(SELECT c0.label FROM child_as c0 WHERE c0.parent_id = p.id AND c0.is_active = 1 ORDER BY c0.created_at DESC NULLS LAST, c0.id ASC LIMIT 1) AS current_label",
    );
  });

  test("Task 2.5 mix: passthrough + aggregate + first — the correlated subquery composes with GROUP BY", () => {
    const agg: import("../../src/projection/view-spec.js").SelectColumn = {
      kind: "aggregate", fieldName: "childCount", dbColAlias: "child_count",
      agg: "count", sourceAlias: "c1", sourceColumn: "id",
    };
    const spec: ViewSpec = {
      viewName: "v_parent_summary",
      joinTree: {
        baseEntity: "Parent", baseAlias: "p",
        joins: [ { relationship: "childAs", targetEntity: "ChildA", alias: "c1", cardinality: "many",
          fkColumn: "parent_id", pkColumn: "id", referenceHolder: "target", joinType: "left", children: [] } ],
      },
      selectSpec: {
        columns: [
          { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "p", sourceColumn: "id" },
          agg,
          { kind: "first", fieldName: "currentLabel", dbColAlias: "current_label",
            childEntity: "ChildA", childAlias: "c0", sourceColumn: "label",
            referenceHolder: "target", fkColumn: "parent_id", pkColumn: "id", childPkColumn: "id",
            orderBy: [{ column: "created_at", dir: "desc" }] },
        ],
      },
      groupBy: ["p.id"],
    };
    const sql = emitViewDdl(spec, { dialect: "postgres", baseTableName: "parents", joinTables: { ChildA: "child_as" } });
    // The GROUP BY (base PK) coexists with the correlated subquery keyed on p.id.
    expect(sql).toContain("GROUP BY p.id");
    expect(sql).toContain("COUNT(DISTINCT c1.id) AS child_count");
    expect(sql).toContain(
      "(SELECT c0.label FROM child_as c0 WHERE c0.parent_id = p.id ORDER BY c0.created_at DESC NULLS LAST, c0.id ASC LIMIT 1) AS current_label",
    );
  });
});

describe("emitViewDdl — belongs-to (reference on source)", () => {
  test("emits target.pk = parent.fk when reference holder is source", () => {
    const spec: ViewSpec = {
      viewName: "v_purchase_summary",
      joinTree: {
        baseEntity: "Purchase",
        baseAlias: "p",
        joins: [
          {
            relationship: "program",
            targetEntity: "Program",
            alias: "p0",
            cardinality: "one",
            fkColumn: "program_id",
            pkColumn: "id",
            referenceHolder: "source",
            joinType: "left",
            children: [],
          },
        ],
      },
      selectSpec: {
        columns: [
          { kind: "passthrough", fieldName: "id",           dbColAlias: "id",            sourceAlias: "p",  sourceColumn: "id" },
          { kind: "passthrough", fieldName: "programTitle", dbColAlias: "program_title", sourceAlias: "p0", sourceColumn: "title" },
        ],
      },
      groupBy: [],
    };
    const sql = emitViewDdl(spec, {
      dialect: "sqlite",
      baseTableName: "purchases",
      joinTables: { Program: "programs" },
    });
    expect(sql).toMatch(/LEFT OUTER JOIN programs p0 ON p0\.id = p\.program_id/);
  });
});
