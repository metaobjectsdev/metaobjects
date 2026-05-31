// test/check/diff-checks.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";

const tbl = (checks: { name: string; expression: string }[]): TableDescriptor => ({
  name: "orders", columns: [{ name: "status", sqlType: { kind: "text" }, nullable: false }],
  indexes: [], foreignKeys: [], primaryKey: [], checks,
});
const snap = (checks: { name: string; expression: string }[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });
const CHK = { name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" };

describe("diff checks", () => {
  test("create-table carries its checks as add-check", async () => {
    const r = await diff({ expected: snap([CHK]), actual: { tables: [], views: [] } });
    expect(r.changes.some((c) => c.kind === "create-table")).toBe(true);
    expect(r.changes.some((c) => c.kind === "add-check")).toBe(true);
  });
  test("check added to an existing table → add-check", async () => {
    const r = await diff({ expected: snap([CHK]), actual: snap([]) });
    expect(r.changes.filter((c) => c.kind === "add-check")).toHaveLength(1);
  });
  test("check removed → drop-check", async () => {
    const r = await diff({ expected: snap([]), actual: snap([CHK]) });
    expect(r.changes.filter((c) => c.kind === "drop-check")).toHaveLength(1);
  });
  test("identical checks → no change", async () => {
    const r = await diff({ expected: snap([CHK]), actual: snap([CHK]) });
    expect(r.changes.filter((c) => c.kind.endsWith("-check"))).toHaveLength(0);
  });
});
