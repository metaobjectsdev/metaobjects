import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { SchemaSnapshot, ColumnDescriptor } from "../../src/types.js";

const empty: SchemaSnapshot = { tables: [], views: [] };

function snapshot(tables: SchemaSnapshot["tables"]): SchemaSnapshot {
  return { tables, views: [] };
}

function col(name: string, kind: "text" | "integer" | "boolean" = "text"): ColumnDescriptor {
  if (kind === "integer") return { name, sqlType: { kind: "integer", bits: 64 }, nullable: false };
  if (kind === "boolean") return { name, sqlType: { kind: "boolean" }, nullable: false };
  return { name, sqlType: { kind: "text" }, nullable: false };
}

describe("diff — table-level", () => {
  test("empty → empty: no changes", async () => {
    const r = await diff(empty, empty);
    expect(r.changes).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  test("expected table not in actual → create-table", async () => {
    const expected = snapshot([{ name: "users", columns: [col("id", "integer"), col("email")], indexes: [], foreignKeys: [], primaryKey: ["id"] }]);
    const r = await diff(expected, empty);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.kind).toBe("create-table");
  });

  test("actual table not in expected → drop-table", async () => {
    const actual = snapshot([{ name: "legacy", columns: [col("id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"] }]);
    const r = await diff(empty, actual);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.kind).toBe("drop-table");
  });
});

describe("diff — per-table column-level", () => {
  test("expected column not in actual → add-column", async () => {
    const tableE = { name: "users", columns: [col("id", "integer"), col("email")], indexes: [], foreignKeys: [], primaryKey: ["id"] };
    const tableA = { name: "users", columns: [col("id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "add-column", table: "users" });
  });

  test("actual column not in expected → drop-column", async () => {
    const tableE = { name: "users", columns: [col("id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"] };
    const tableA = { name: "users", columns: [col("id", "integer"), col("legacy_field")], indexes: [], foreignKeys: [], primaryKey: ["id"] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "drop-column", table: "users", column: "legacy_field" });
  });

  test("type mismatch → change-column-type", async () => {
    const tableE = { name: "users", columns: [{ ...col("count"), sqlType: { kind: "integer" as const, bits: 64 as const } }], indexes: [], foreignKeys: [], primaryKey: [] };
    const tableA = { name: "users", columns: [col("count", "text")], indexes: [], foreignKeys: [], primaryKey: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    const c = r.changes.find((x) => x.kind === "change-column-type");
    expect(c).toBeDefined();
  });

  test("nullable mismatch → change-column-nullable", async () => {
    const tableE = { name: "users", columns: [{ ...col("note"), nullable: true }], indexes: [], foreignKeys: [], primaryKey: [] };
    const tableA = { name: "users", columns: [{ ...col("note"), nullable: false }], indexes: [], foreignKeys: [], primaryKey: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    const c = r.changes.find((x) => x.kind === "change-column-nullable");
    expect(c).toBeDefined();
    expect(c).toMatchObject({ from: false, to: true });
  });

  test("default mismatch → change-column-default", async () => {
    const tableE = { name: "users", columns: [{ ...col("flag", "boolean"), default: { kind: "literal" as const, value: "true" } }], indexes: [], foreignKeys: [], primaryKey: [] };
    const tableA = { name: "users", columns: [col("flag", "boolean")], indexes: [], foreignKeys: [], primaryKey: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes.find((x) => x.kind === "change-column-default")).toBeDefined();
  });
});

describe("diff — per-table index/FK", () => {
  test("expected index not in actual → add-index", async () => {
    const tableE = { name: "users", columns: [col("id", "integer"), col("email")], indexes: [{ name: "users_email_idx", columns: ["email"], unique: true }], foreignKeys: [], primaryKey: ["id"] };
    const tableA = { name: "users", columns: [col("id", "integer"), col("email")], indexes: [], foreignKeys: [], primaryKey: ["id"] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes.find((x) => x.kind === "add-index")).toBeDefined();
  });

  test("actual FK not in expected → drop-fk", async () => {
    const tableE = { name: "weeks", columns: [col("id", "integer"), col("program_id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"] };
    const tableA = { name: "weeks", columns: [col("id", "integer"), col("program_id", "integer")], indexes: [], foreignKeys: [{ name: "weeks_program_id_fk", columns: ["program_id"], refTable: "programs", refColumns: ["id"] }], primaryKey: ["id"] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes.find((x) => x.kind === "drop-fk")).toBeDefined();
  });
});
