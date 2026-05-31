import { describe, test, expect } from "bun:test";
import type { Change, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor } from "../../src/types.js";

describe("drop-* change kinds carry an optional restore descriptor", () => {
  test("drop-column accepts a restore ColumnDescriptor", () => {
    const col: ColumnDescriptor = { name: "email", sqlType: { kind: "text" }, nullable: false };
    const c: Change = { kind: "drop-column", table: "users", column: "email", restore: col, status: { state: "ok" } } as unknown as Change;
    expect(c.kind === "drop-column" && c.restore?.name).toBe("email");
  });
  test("drop-table accepts a restore TableDescriptor", () => {
    const t: TableDescriptor = { name: "users", columns: [], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const c: Change = { kind: "drop-table", table: "users", restore: t, status: { state: "ok" } } as unknown as Change;
    expect(c.kind === "drop-table" && c.restore?.name).toBe("users");
  });
  test("drop-index / drop-fk accept restore descriptors, and restore is optional", () => {
    const ix: IndexDescriptor = { name: "users_email_idx", columns: ["email"], unique: true };
    const fk: FkDescriptor = { name: "orders_user_fk", columns: ["user_id"], refTable: "users", refColumns: ["id"] };
    const c1: Change = { kind: "drop-index", table: "users", index: "users_email_idx", restore: ix, status: { state: "ok" } } as unknown as Change;
    const c2: Change = { kind: "drop-fk", table: "orders", fk: "orders_user_fk", restore: fk, status: { state: "ok" } } as unknown as Change;
    const c3: Change = { kind: "drop-index", table: "users", index: "x", status: { state: "ok" } } as unknown as Change; // restore omitted = legacy
    expect(c1.kind === "drop-index" && c1.restore?.unique).toBe(true);
    expect(c2.kind === "drop-fk" && c2.restore?.refTable).toBe("users");
    expect(c3.kind === "drop-index" && c3.restore).toBeUndefined();
  });
});
