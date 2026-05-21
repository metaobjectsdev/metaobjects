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
        fkField: "programId",
        pkField: "id",
        referenceHolder: "target",
        children: [
          {
            relationship: "workouts",
            targetEntity: "Workout",
            alias: "wo",
            cardinality: "many",
            fkField: "weekId",
            pkField: "id",
            referenceHolder: "target",
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

describe("emitViewDdl — non-id parent join (pkField)", () => {
  test("uses pkField instead of id when joining on email", () => {
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
            fkField: "customerEmail",
            pkField: "email",  // non-id join
            referenceHolder: "target",
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
            fkField: "programId",
            pkField: "id",
            referenceHolder: "source",
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
