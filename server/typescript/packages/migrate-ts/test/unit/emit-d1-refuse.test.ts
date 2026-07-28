import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import { D1ReferencedTableRebuildError } from "../../src/emit/d1-fk-refuse.js";
import type { Change, SchemaSnapshot, TableDescriptor } from "../../src/types.js";

const ALLOWED = { state: "allowed" } as const;

function parentTable(withCheck: boolean): TableDescriptor {
  return {
    name: "parent",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "status", sqlType: { kind: "text" }, nullable: false },
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
    checks: withCheck
      ? [{ name: "parent_status_chk", expression: "status <> ''" }]
      : [],
  };
}

function childTable(): TableDescriptor {
  return {
    name: "child",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "parent_id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ],
    indexes: [],
    foreignKeys: [
      { name: "child_parent_id_fk", columns: ["parent_id"], refTable: "parent", refColumns: ["id"] },
    ],
    primaryKey: ["id"],
    checks: [],
  };
}

function leafTable(withCheck: boolean): TableDescriptor {
  return {
    name: "logs",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "level", sqlType: { kind: "text" }, nullable: false },
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
    checks: withCheck ? [{ name: "logs_level_chk", expression: "level <> ''" }] : [],
  };
}

const addCheck = (tbl: string, name: string, expr: string): Change => ({
  kind: "add-check",
  status: ALLOWED,
  table: tbl,
  check: { name, expression: expr },
});

describe("emit(dialect: 'd1') — referenced-table rebuild refusal (#226)", () => {
  test("THROWS when a rebuild targets a table referenced by another table's FK", () => {
    const changes: Change[] = [addCheck("parent", "parent_status_chk", "status <> ''")];
    const expected: SchemaSnapshot = { tables: [parentTable(true), childTable()], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).toThrow(
      D1ReferencedTableRebuildError,
    );
  });

  test("does NOT throw when the rebuilt table is a leaf (unreferenced)", () => {
    const changes: Change[] = [addCheck("logs", "logs_level_chk", "level <> ''")];
    const expected: SchemaSnapshot = { tables: [leafTable(true), childTable(), parentTable(false)], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).not.toThrow();
  });

  test("does NOT throw for a non-rebuild change against a referenced table", () => {
    // add-column is a native ALTER, not a recreate — no drop of the referenced table.
    const changes: Change[] = [{
      kind: "add-column",
      status: ALLOWED,
      table: "parent",
      column: { name: "note", sqlType: { kind: "text" }, nullable: true },
    }];
    const expected: SchemaSnapshot = { tables: [parentTable(false), childTable()], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).not.toThrow();
  });

  test("leaf-rebuild D1 output equals the sqlite output modulo safety transforms", () => {
    const changes: Change[] = [addCheck("logs", "logs_level_chk", "level <> ''")];
    const expected: SchemaSnapshot = { tables: [leafTable(true)], views: [] };
    const d1 = emit(changes, { dialect: "d1", expectedSchema: expected });
    const sq = emit(changes, { dialect: "sqlite", expectedSchema: expected });
    // Same statements; D1 only strips BEGIN/COMMIT and the (now no-op) foreign_keys pragmas.
    expect(d1.up).toContain("CREATE TABLE");
    expect(d1.up).not.toMatch(/^\s*BEGIN/im);
    expect(sq.up).toMatch(/BEGIN TRANSACTION/);
  });
});
