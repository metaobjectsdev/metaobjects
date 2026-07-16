// #207 — a projection-level row `@filter` lowers to an outer WHERE in the view DDL,
// scoping which base rows the view returns (soft-delete / status / type views). It
// renders BEFORE any GROUP BY and reuses the shipped ViewFilterClause renderer. This
// unit tests the EMIT layer with hand-built ViewSpecs (the extraction + registration
// land separately).

import { describe, test, expect } from "bun:test";
import { emitViewDdl } from "../../src/projection/view-ddl-emit.js";
import type { ViewSpec } from "../../src/projection/view-spec.js";

const OPTS = { dialect: "postgres", baseTableName: "orders", joinTables: {}, bodyOnly: true } as const;

function baseSpec(where: ViewSpec["where"], groupBy: string[] = []): ViewSpec {
  return {
    viewName: "v_active_orders",
    joinTree: { baseEntity: "Order", baseAlias: "o", joins: [] },
    selectSpec: { columns: [
      { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "o", sourceColumn: "id" },
    ] },
    groupBy,
    // exactOptionalPropertyTypes: an optional field must be OMITTED, not set undefined.
    ...(where !== undefined ? { where } : {}),
  };
}

describe("#207 — view-level @filter lowers to an outer WHERE", () => {
  test("no where clause → no WHERE emitted (byte-identical to before)", () => {
    const sql = emitViewDdl(baseSpec(undefined), OPTS);
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("FROM orders o");
  });

  test("a simple eq predicate renders WHERE after FROM", () => {
    const sql = emitViewDdl(baseSpec({ kind: "cmp", ref: "o.status", op: "eq", value: "active" }), OPTS);
    expect(sql).toContain("WHERE o.status = 'active'");
  });

  test("an isNull-OR-eq predicate renders correctly (soft-delete shape)", () => {
    const where = { kind: "or", clauses: [
      { kind: "cmp", ref: "o.flag", op: "isNull", value: true },
      { kind: "cmp", ref: "o.flag", op: "eq", value: 1 },
    ] } as const;
    const sql = emitViewDdl(baseSpec(where), OPTS);
    expect(sql).toContain("WHERE (o.flag IS NULL OR o.flag = 1)");
  });

  test("WHERE renders BEFORE GROUP BY (scopes base rows, not aggregate inputs)", () => {
    const sql = emitViewDdl(baseSpec({ kind: "cmp", ref: "o.status", op: "eq", value: "active" }, ["o.id"]), OPTS);
    const wherePos = sql.indexOf("WHERE");
    const groupPos = sql.indexOf("GROUP BY");
    expect(wherePos).toBeGreaterThan(-1);
    expect(groupPos).toBeGreaterThan(-1);
    expect(wherePos).toBeLessThan(groupPos);
  });
});
