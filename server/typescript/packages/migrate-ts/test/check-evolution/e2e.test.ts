import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor, CheckDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const CHK = (n: string, e: string): CheckDescriptor => ({ name: n, expression: e });
function tbl(checks: CheckDescriptor[]): TableDescriptor {
  return { name: "orders", columns: [{ name: "qty", sqlType: { kind: "integer", bits: 32 }, nullable: false }],
    indexes: [], foreignKeys: [], checks, primaryKey: ["qty"] };
}
const snap = (checks: CheckDescriptor[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });

describe("e2e: existing-table CHECK evolution (postgres)", () => {
  test("adding a check on an existing table emits ALTER TABLE ADD CONSTRAINT", async () => {
    const r = await diff({ expected: snap([CHK("orders_qty_chk", "qty >= 1")]), actual: snap([]), dialect: "postgres" });
    const { up } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_qty_chk" CHECK (qty >= 1);`);
  });
  test("create-table on empty actual inlines the check (no separate ADD CONSTRAINT)", async () => {
    // a brand-new table carries its checks inline in CREATE TABLE; diffTableChecks
    // runs only for tables present on BOTH sides, so no add-check fires here.
    const fresh: SchemaSnapshot = { tables: [tbl([CHK("orders_qty_chk", "qty >= 1")])], views: [] };
    const r = await diff({ expected: fresh, actual: { tables: [], views: [] }, dialect: "postgres" });
    const { up } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`CONSTRAINT "orders_qty_chk" CHECK (qty >= 1)`); // inline in CREATE TABLE
    expect(up).not.toContain(`ADD CONSTRAINT "orders_qty_chk"`);          // not also an ALTER
  });
});
