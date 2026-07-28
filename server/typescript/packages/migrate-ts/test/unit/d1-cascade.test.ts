import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import { emitD1Cascade } from "../../src/emit/d1-cascade.js";
import { renderSqlite } from "../../src/emit/sqlite.js";
import { applyD1SafetyPass } from "../../src/emit/d1-safety-pass.js";
import {
  D1ReferencedTableRebuildError,
  D1CyclicForeignKeyError,
} from "../../src/emit/d1-fk-refuse.js";
import type { Change, SchemaSnapshot, TableDescriptor } from "../../src/types.js";

const ALLOWED = { state: "allowed" } as const;

// --- fixtures (mirror emit-d1-refuse.test.ts style) -------------------------

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
    checks: withCheck ? [{ name: "parent_status_chk", expression: "status <> ''" }] : [],
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

/** A self-referential table `t` (parent_id -> t.id). */
function selfRefTable(withCheck: boolean): TableDescriptor {
  return {
    name: "t",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "parent_id", sqlType: { kind: "integer", bits: 64 }, nullable: true },
    ],
    indexes: [],
    foreignKeys: [
      { name: "t_parent_id_fk", columns: ["parent_id"], refTable: "t", refColumns: ["id"] },
    ],
    primaryKey: ["id"],
    checks: withCheck ? [{ name: "t_status_chk", expression: "id > 0" }] : [],
  };
}

/** Two tables in a mutual FK cycle: a -> b, b -> a. */
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

const addCheck = (tbl: string, name: string, expr: string): Change => ({
  kind: "add-check",
  status: ALLOWED,
  table: tbl,
  check: { name, expression: expr },
});

describe("emit(dialect: 'd1') — FK-cascade rebuild (#241)", () => {
  // (a) referenced-parent rebuild WITH actualSchema → cascade recipe
  test("cascade rebuilds a referenced parent + pulls in its referrer", () => {
    const changes: Change[] = [addCheck("parent", "parent_status_chk", "status <> ''")];
    const expected: SchemaSnapshot = { tables: [parentTable(true), childTable()], views: [] };
    const actual: SchemaSnapshot = { tables: [parentTable(false), childTable()], views: [] };

    const result = emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema: actual });
    const up = result.up;

    // defer_foreign_keys is the D1-legal alternative to the (no-op) OFF bracket.
    expect(up).toContain("defer_foreign_keys");
    // Both affected tables get a temp table.
    expect(up).toContain('CREATE TABLE "__f_parent"');
    expect(up).toContain('CREATE TABLE "__f_child"');
    // The referrer's FK is rewritten to point at the parent's temp.
    expect(up).toContain('REFERENCES "__f_parent"');

    // The forbidden no-op bracket must NOT appear (the defer form is legal and used instead).
    expect(up).not.toContain("foreign_keys = OFF");
    expect(up).not.toContain("PRAGMA foreign_keys = ON");
    expect(up).not.toMatch(/^\s*BEGIN/im);
    expect(up).not.toMatch(/^\s*COMMIT/im);

    // Referrers-first DROP: child dropped before parent.
    const dropChild = up.indexOf('DROP TABLE "child"');
    const dropParent = up.indexOf('DROP TABLE "parent"');
    expect(dropChild).toBeGreaterThanOrEqual(0);
    expect(dropParent).toBeGreaterThanOrEqual(0);
    expect(dropChild).toBeLessThan(dropParent);

    // Parents-first RENAME: parent renamed before child.
    const renParent = up.indexOf('ALTER TABLE "__f_parent" RENAME TO "parent"');
    const renChild = up.indexOf('ALTER TABLE "__f_child" RENAME TO "child"');
    expect(renParent).toBeGreaterThanOrEqual(0);
    expect(renChild).toBeGreaterThanOrEqual(0);
    expect(renParent).toBeLessThan(renChild);

    // All DROPs precede all RENAMEs.
    expect(dropParent).toBeLessThan(renParent);

    // recreatedTables reports the whole affected set.
    expect(result.recreatedTables.has("parent")).toBe(true);
    expect(result.recreatedTables.has("child")).toBe(true);
  });

  // (b) multi-table cycle → throws the cycle error
  test("throws D1CyclicForeignKeyError on a multi-table FK cycle", () => {
    const changes: Change[] = [addCheck("a", "a_id_chk", "id > 0")];
    const expected: SchemaSnapshot = { tables: [cycleTableA(true), cycleTableB()], views: [] };
    const actual: SchemaSnapshot = { tables: [cycleTableA(false), cycleTableB()], views: [] };

    expect(() =>
      emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema: actual }),
    ).toThrow(D1CyclicForeignKeyError);
  });

  test("emitD1Cascade returns refuseCycle naming the cycle members", () => {
    const changes: Change[] = [addCheck("a", "a_id_chk", "id > 0")];
    const expected: SchemaSnapshot = { tables: [cycleTableA(true), cycleTableB()], views: [] };
    const actual: SchemaSnapshot = { tables: [cycleTableA(false), cycleTableB()], views: [] };

    const result = emitD1Cascade(changes, expected, actual, new Set(["a"]));
    expect("refuseCycle" in result).toBe(true);
    if ("refuseCycle" in result) {
      expect(result.refuseCycle).toContain("a");
      expect(result.refuseCycle).toContain("b");
    }
  });

  // (c) self-ref → single __f_t referencing __f_t
  test("self-referential table produces a single temp referencing itself", () => {
    const changes: Change[] = [addCheck("t", "t_status_chk", "id > 0")];
    const expected: SchemaSnapshot = { tables: [selfRefTable(true)], views: [] };
    const actual: SchemaSnapshot = { tables: [selfRefTable(false)], views: [] };

    const result = emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema: actual });
    const up = result.up;

    expect(up).toContain('CREATE TABLE "__f_t"');
    // The self-FK is rewritten onto the temp itself.
    expect(up).toContain('REFERENCES "__f_t"');
    // Exactly one temp table.
    const tempCount = (up.match(/CREATE TABLE "__f_/g) ?? []).length;
    expect(tempCount).toBe(1);
    expect(up).toContain("defer_foreign_keys");
    expect(up).not.toContain("foreign_keys = OFF");
  });

  // (d) actualSchema absent → still refuses (#226)
  test("refuses (D1ReferencedTableRebuildError) when actualSchema is absent", () => {
    const changes: Change[] = [addCheck("parent", "parent_status_chk", "status <> ''")];
    const expected: SchemaSnapshot = { tables: [parentTable(true), childTable()], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).toThrow(
      D1ReferencedTableRebuildError,
    );
  });

  // (e) non-referenced rebuild → byte-identical to the pre-#241 path
  test("non-referenced rebuild is byte-identical to applyD1SafetyPass(renderSqlite())", () => {
    const changes: Change[] = [addCheck("logs", "logs_level_chk", "level <> ''")];
    const expected: SchemaSnapshot = { tables: [leafTable(true)], views: [] };

    const sq = renderSqlite(changes, expected);
    const d1 = emit(changes, { dialect: "d1", expectedSchema: expected });

    expect(d1.up).toBe(applyD1SafetyPass(sq.up));
    expect(d1.down).toBe(applyD1SafetyPass(sq.down));

    // Passing actualSchema must not change the non-referenced path.
    const actual: SchemaSnapshot = { tables: [leafTable(false)], views: [] };
    const d1WithActual = emit(changes, {
      dialect: "d1",
      expectedSchema: expected,
      actualSchema: actual,
    });
    expect(d1WithActual.up).toBe(d1.up);
    expect(d1WithActual.down).toBe(d1.down);
  });
});
