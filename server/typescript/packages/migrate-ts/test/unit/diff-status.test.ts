import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { SchemaSnapshot, ColumnDescriptor } from "../../src/types.js";

function col(name: string, sqlType: ColumnDescriptor["sqlType"], nullable = true): ColumnDescriptor {
  return { name, sqlType, nullable };
}
function snap(tables: SchemaSnapshot["tables"]): SchemaSnapshot {
  return { tables, views: [] };
}

describe("diff — status enforcement", () => {
  test("drop-column blocked by default", async () => {
    const e = snap([{ name: "u", columns: [col("id", { kind: "integer", bits: 64 })], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }]);
    const a = snap([{ name: "u", columns: [col("id", { kind: "integer", bits: 64 }), col("legacy", { kind: "text" })], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }]);
    const r = await diff(e, a);
    const dropCol = r.changes.find((c) => c.kind === "drop-column");
    expect(dropCol?.status.state).toBe("blocked");
    expect(r.blocked).toContain(dropCol!);
  });

  test("drop-column allowed with allow.dropColumn", async () => {
    const e = snap([{ name: "u", columns: [col("id", { kind: "integer", bits: 64 })], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }]);
    const a = snap([{ name: "u", columns: [col("id", { kind: "integer", bits: 64 }), col("legacy", { kind: "text" })], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }]);
    const r = await diff(e, a, { allow: { dropColumn: true } });
    expect(r.blocked).toHaveLength(0);
    expect(r.changes.find((c) => c.kind === "drop-column")?.status.state).toBe("allowed");
  });

  test("drop-table blocked by default; allowed with allow.dropTable", async () => {
    const e = snap([]);
    const a = snap([{ name: "legacy", columns: [], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    expect((await diff(e, a)).blocked).toHaveLength(1);
    expect((await diff(e, a, { allow: { dropTable: true } })).blocked).toHaveLength(0);
  });

  test("change-column-type widening (int32→int64) allowed without flag", async () => {
    const e = snap([{ name: "t", columns: [col("n", { kind: "integer", bits: 64 })], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    const a = snap([{ name: "t", columns: [col("n", { kind: "integer", bits: 32 })], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    const r = await diff(e, a);
    const c = r.changes.find((c) => c.kind === "change-column-type");
    expect(c?.status.state).toBe("allowed");
  });

  test("change-column-type narrowing (int64→int32) blocked", async () => {
    const e = snap([{ name: "t", columns: [col("n", { kind: "integer", bits: 32 })], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    const a = snap([{ name: "t", columns: [col("n", { kind: "integer", bits: 64 })], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    expect((await diff(e, a)).blocked.some((c) => c.kind === "change-column-type")).toBe(true);
    expect((await diff(e, a, { allow: { typeChange: true } })).blocked).toHaveLength(0);
  });

  test("change-column-nullable: notnull→nullable allowed", async () => {
    const e = snap([{ name: "t", columns: [col("c", { kind: "text" }, true)], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    const a = snap([{ name: "t", columns: [col("c", { kind: "text" }, false)], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    const r = await diff(e, a);
    expect(r.changes.find((c) => c.kind === "change-column-nullable")?.status.state).toBe("allowed");
  });

  test("change-column-nullable: nullable→notnull blocked without flag", async () => {
    const e = snap([{ name: "t", columns: [col("c", { kind: "text" }, false)], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    const a = snap([{ name: "t", columns: [col("c", { kind: "text" }, true)], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    expect((await diff(e, a)).blocked.some((c) => c.kind === "change-column-nullable")).toBe(true);
    expect((await diff(e, a, { allow: { nullableToNotNull: true } })).blocked).toHaveLength(0);
  });

  test("drop-index / drop-fk blocked by default", async () => {
    const e = snap([{ name: "t", columns: [], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }]);
    const a = snap([{
      name: "t", columns: [],
      indexes: [{ name: "old_idx", columns: ["x"], unique: false }],
      foreignKeys: [{ name: "old_fk", columns: ["x"], refTable: "y", refColumns: ["id"] }],
      primaryKey: [],
      checks: [],
    }]);
    const r = await diff(e, a);
    expect(r.blocked.some((c) => c.kind === "drop-index")).toBe(true);
    expect(r.blocked.some((c) => c.kind === "drop-fk")).toBe(true);
  });
});
