import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor, CheckDescriptor } from "../../src/types.js";
import { driftAgainstSnapshot } from "../../src/drift/classify.js";

const CHK = (name: string, expression: string): CheckDescriptor => ({ name, expression });
function tbl(checks: CheckDescriptor[]): TableDescriptor {
  return {
    name: "orders",
    columns: [{ name: "qty", sqlType: { kind: "integer", bits: 32 }, nullable: false }],
    indexes: [], foreignKeys: [], checks, primaryKey: ["qty"],
  };
}
const snap = (checks: CheckDescriptor[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });
const C0 = CHK("orders_qty_numeric_chk", "qty >= 1");
const C1 = CHK("orders_qty_max_chk", "qty <= 100");

describe("driftAgainstSnapshot — dialect-threaded CHECK evolution", () => {
  test("with dialect=postgres: snapshot has 2 checks, DB has 1 → reports check drift", async () => {
    // expected (snapshot) = 2 checks; actual (DB) = 1 check → the missing modeled
    // check surfaces as add-check drift (postgres-gated diffTableChecks).
    const r = await driftAgainstSnapshot(snap([C0, C1]), snap([C0]), "postgres");
    const checkChanges = [...r.drift, ...r.unmanaged].filter((c) => c.kind.endsWith("-check"));
    expect(checkChanges.length).toBeGreaterThan(0);
  });

  test("without dialect (back-compat): same snapshots → no check drift", async () => {
    const r = await driftAgainstSnapshot(snap([C0, C1]), snap([C0]));
    const checkChanges = [...r.drift, ...r.unmanaged].filter((c) => c.kind.endsWith("-check"));
    expect(checkChanges.length).toBe(0);
  });
});
