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

// Checks are create-time-only: they ride on `create-table.table.checks` and are
// inlined into the CREATE TABLE DDL at emit time. The diff never produces
// add-check / drop-check (existing-table enum-value evolution is deferred).
describe("diff checks (inline create-time only)", () => {
  test("create-table carries its checks on table.checks, not as a separate add-check", async () => {
    const r = await diff({ expected: snap([CHK]), actual: { tables: [], views: [] } });
    const create = r.changes.find((c) => c.kind === "create-table");
    expect(create).toBeDefined();
    expect((create as { table: TableDescriptor }).table.checks).toEqual([CHK]);
    // No standalone -check change is produced.
    expect(r.changes.every((c) => !c.kind.endsWith("-check"))).toBe(true);
  });
  test("check added to an existing table → NO -check change (deferred)", async () => {
    const r = await diff({ expected: snap([CHK]), actual: snap([]) });
    expect(r.changes.every((c) => !c.kind.endsWith("-check"))).toBe(true);
  });
  test("check removed from an existing table → NO -check change (deferred)", async () => {
    const r = await diff({ expected: snap([]), actual: snap([CHK]) });
    expect(r.changes.every((c) => !c.kind.endsWith("-check"))).toBe(true);
  });
  test("identical checks → no -check change", async () => {
    const r = await diff({ expected: snap([CHK]), actual: snap([CHK]) });
    expect(r.changes.every((c) => !c.kind.endsWith("-check"))).toBe(true);
  });
});
