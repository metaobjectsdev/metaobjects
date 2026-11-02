// test/check/emit-postgres-check.test.ts
import { describe, test, expect } from "bun:test";
import type { TableDescriptor, Change } from "../../src/types.js";
import { emit } from "../../src/emit/index.js";

const ALLOWED = { state: "ok" } as const;
const CHK = { name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" };
const table: TableDescriptor = {
  name: "orders", columns: [{ name: "status", sqlType: { kind: "text" }, nullable: false }],
  indexes: [], foreignKeys: [], primaryKey: [], checks: [CHK],
};

describe("emit postgres — checks", () => {
  test("create-table inlines the CHECK constraint", () => {
    const r = emit([{ kind: "create-table", table, status: ALLOWED } as unknown as Change], { dialect: "postgres" });
    expect(r.up).toContain(`CONSTRAINT "orders_status_chk" CHECK (status IN ('OPEN','CLOSED'))`);
  });
  test("add-check → ALTER TABLE ADD CONSTRAINT; down drops it", () => {
    const r = emit([{ kind: "add-check", table: "orders", check: CHK, status: ALLOWED } as unknown as Change], { dialect: "postgres" });
    expect(r.up).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_chk" CHECK (status IN ('OPEN','CLOSED'));`);
    expect(r.down).toContain(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_chk";`);
  });
  test("drop-check → ALTER TABLE DROP CONSTRAINT", () => {
    const r = emit([{ kind: "drop-check", table: "orders", check: "orders_status_chk", status: ALLOWED } as unknown as Change], { dialect: "postgres" });
    // #313 — the forward drop carries IF EXISTS. The add-check test above asserts the
    // matching DOWN, which stays bare; the two together pin the direction split.
    // F10 — `IF EXISTS` on the enclosing `ALTER TABLE` too, not just the
    // constraint name: `DROP CONSTRAINT IF EXISTS` alone still requires the
    // TABLE to exist, so a table another tool owns still failed the replay.
    expect(r.up).toContain(`ALTER TABLE IF EXISTS "orders" DROP CONSTRAINT IF EXISTS "orders_status_chk";`);
  });
});
