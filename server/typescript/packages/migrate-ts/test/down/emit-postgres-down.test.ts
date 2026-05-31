import { describe, test, expect } from "bun:test";
import type { Change } from "../../src/types.js";
import { emit } from "../../src/emit/index.js";

const ALLOWED = { state: "ok" } as const;
const down = (c: Change) => emit([c], { dialect: "postgres" }).down;

describe("postgres down-from-restore", () => {
  test("drop-column with restore → ADD COLUMN + data-not-restored note", () => {
    const c = { kind: "drop-column", table: "users", column: "email",
      restore: { name: "email", sqlType: { kind: "text" }, nullable: false }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`ALTER TABLE "users" ADD COLUMN "email" TEXT NOT NULL;`);
    expect(d).toMatch(/column data is not restored/i);
  });
  test("drop-table with restore → CREATE TABLE + data-not-restored note", () => {
    const c = { kind: "drop-table", table: "users",
      restore: { name: "users", columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`CREATE TABLE "users"`);
    expect(d).toMatch(/table data is not restored/i);
  });
  test("drop-index with restore → CREATE INDEX (full structural restore, no data note)", () => {
    const c = { kind: "drop-index", table: "users", index: "users_email_idx",
      restore: { name: "users_email_idx", columns: ["email"], unique: true }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");`);
    expect(d).not.toMatch(/not restored/i);
  });
  test("drop-fk with restore → ADD CONSTRAINT FOREIGN KEY", () => {
    const c = { kind: "drop-fk", table: "orders", fk: "orders_user_fk",
      restore: { name: "orders_user_fk", columns: ["user_id"], refTable: "users", refColumns: ["id"] }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id")`);
  });
  test("drop-column WITHOUT restore → falls back to the legacy TODO stub", () => {
    const c = { kind: "drop-column", table: "users", column: "email", status: ALLOWED } as unknown as Change;
    expect(down(c)).toMatch(/TODO: re-add dropped column/i);
  });
});
