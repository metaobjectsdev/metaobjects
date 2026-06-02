import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor, CheckDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";

const CHK = (name: string, expression: string): CheckDescriptor => ({ name, expression });
function tbl(checks: CheckDescriptor[]): TableDescriptor {
  return { name: "orders", columns: [{ name: "qty", sqlType: { kind: "integer", bits: 32 }, nullable: false }],
    indexes: [], foreignKeys: [], checks, primaryKey: ["qty"] };
}
const snap = (checks: CheckDescriptor[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });
const C0 = CHK("orders_qty_numeric_chk", "qty >= 1");
const C0b = CHK("orders_qty_numeric_chk", "qty >= 5"); // changed bound, same name
const C1 = CHK("orders_qty_max_chk", "qty <= 100");

describe("diffTableChecks — postgres existing-table evolution", () => {
  test("added check on an existing table → add-check", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]), dialect: "postgres" });
    expect(r.changes.filter((c) => c.kind === "add-check").map((c) => (c as any).check.name)).toEqual(["orders_qty_max_chk"]);
  });
  test("removed check → drop-check (gated, so blocked without allow)", async () => {
    const r = await diff({ expected: snap([C0]), actual: snap([C0, C1]), dialect: "postgres" });
    const drop = r.changes.find((c) => c.kind === "drop-check");
    expect(drop && (drop as any).check).toBe("orders_qty_max_chk");
    expect(drop!.status.state).toBe("blocked"); // no allow.dropCheck
  });
  test("changed expression (same name) → drop + add", async () => {
    const r = await diff({ expected: snap([C0b]), actual: snap([C0]), dialect: "postgres", allow: { dropCheck: true } });
    expect(r.changes.some((c) => c.kind === "drop-check")).toBe(true);
    expect(r.changes.some((c) => c.kind === "add-check" && (c as any).check.expression === "qty >= 5")).toBe(true);
  });
  test("PG-rewritten actual expression equal to expected → NO change (idempotent)", async () => {
    const r = await diff({ expected: snap([CHK("orders_qty_numeric_chk", "qty >= 1")]),
      actual: snap([CHK("orders_qty_numeric_chk", "(qty >= 1)")]), dialect: "postgres" });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
  test("dialect gate: sqlite produces NO check changes even when they differ", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]), dialect: "sqlite" });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
  test("no dialect passed → no check evolution (back-compat)", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]) });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
});
