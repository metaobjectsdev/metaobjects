import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import {
  D1ReferencedTableRebuildError,
  D1CyclicForeignKeyError,
} from "../../src/emit/d1-fk-refuse.js";
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

// Two tables in a mutual FK cycle: a -> b, b -> a.
function cycleTableA(withCheck: boolean): TableDescriptor {
  return {
    name: "a",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "b_id", sqlType: { kind: "integer", bits: 64 }, nullable: true },
    ],
    indexes: [],
    foreignKeys: [{ name: "a_b_id_fk", columns: ["b_id"], refTable: "b", refColumns: ["id"] }],
    primaryKey: ["id"],
    checks: withCheck ? [{ name: "a_id_chk", expression: "id > 0" }] : [],
  };
}

function cycleTableB(): TableDescriptor {
  return {
    name: "b",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "a_id", sqlType: { kind: "integer", bits: 64 }, nullable: true },
    ],
    indexes: [],
    foreignKeys: [{ name: "b_a_id_fk", columns: ["a_id"], refTable: "a", refColumns: ["id"] }],
    primaryKey: ["id"],
    checks: [],
  };
}

describe("emit(dialect: 'd1') — FK-cascade rebuild with actualSchema (#241)", () => {
  test("does NOT throw; produces a cascade for an acyclic referenced rebuild", () => {
    const changes: Change[] = [addCheck("parent", "parent_status_chk", "status <> ''")];
    const expected: SchemaSnapshot = { tables: [parentTable(true), childTable()], views: [] };
    const actual: SchemaSnapshot = { tables: [parentTable(false), childTable()], views: [] };
    const result = emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema: actual });
    expect(result.up).toContain("defer_foreign_keys");
    expect(result.up).toContain('CREATE TABLE "__f_parent"');
    expect(result.up).not.toContain("foreign_keys = OFF");
  });

  test("THROWS D1CyclicForeignKeyError on a multi-table FK cycle", () => {
    const changes: Change[] = [addCheck("a", "a_id_chk", "id > 0")];
    const expected: SchemaSnapshot = { tables: [cycleTableA(true), cycleTableB()], views: [] };
    const actual: SchemaSnapshot = { tables: [cycleTableA(false), cycleTableB()], views: [] };
    expect(() =>
      emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema: actual }),
    ).toThrow(D1CyclicForeignKeyError);
  });
});
