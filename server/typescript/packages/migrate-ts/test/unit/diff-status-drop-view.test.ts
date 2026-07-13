/**
 * Bug gate: `drop-view` was the ONLY drop kind with no allow gate — while pg view
 * introspection enumerated every non-pg_% view. `CREATE EXTENSION
 * pg_stat_statements` (which installs a view in `public`) was enough for the next
 * migrate to emit an UNBLOCKED `DROP VIEW "pg_stat_statements";`.
 *
 * Fix: drop-view is gated behind allow.dropView like every other drop — EXCEPT
 * the internal recreate pair (drop-view immediately re-created by a create-view /
 * replace-view for the same view around a column-altering change, diff Pass 2c),
 * which is not destructive and must stay allowed or every dependent-view rebuild
 * would need a destructive-permission flag.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { SchemaSnapshot, ColumnDescriptor, TableDescriptor } from "../../src/types.js";

function col(name: string, sqlType: ColumnDescriptor["sqlType"], nullable = true): ColumnDescriptor {
  return { name, sqlType, nullable };
}
function tbl(name: string, columns: ColumnDescriptor[]): TableDescriptor {
  return { name, columns, indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
}

describe("diff — drop-view gating", () => {
  test("a real view removal is BLOCKED by default and allowed with allow.dropView", async () => {
    const expected: SchemaSnapshot = { tables: [], views: [] };
    const actual: SchemaSnapshot = {
      tables: [],
      views: [{ name: "pg_stat_statements", sql: "SELECT 1" }],
    };
    const r = await diff({ expected, actual });
    const drop = r.changes.find((c) => c.kind === "drop-view");
    expect(drop?.status.state).toBe("blocked");
    expect(r.blocked).toContain(drop!);

    const allowed = await diff({ expected, actual, allow: { dropView: true } });
    expect(allowed.blocked).toHaveLength(0);
    expect(allowed.changes.find((c) => c.kind === "drop-view")?.status.state).toBe("allowed");
  });

  test("the drop/create RECREATE pair around a column change stays allowed without a flag", async () => {
    const viewSql = "SELECT n FROM t";
    const expected: SchemaSnapshot = {
      tables: [tbl("t", [col("n", { kind: "integer", bits: 64 })])],
      views: [{ name: "v", sql: viewSql, dependsOn: ["t"] }],
    };
    const actual: SchemaSnapshot = {
      tables: [tbl("t", [col("n", { kind: "integer", bits: 32 })])], // widening change → allowed
      views: [{ name: "v", sql: viewSql }],
    };
    const r = await diff({ expected, actual });
    const drop = r.changes.find((c) => c.kind === "drop-view");
    const create = r.changes.find((c) => c.kind === "create-view");
    expect(drop).toBeDefined();
    expect(create).toBeDefined();
    expect(drop!.status.state).toBe("allowed"); // recreate pair — not destructive
    expect(r.blocked).toHaveLength(0);
  });
});
