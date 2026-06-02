/**
 * SQLite emits native ALTER for column rename/drop only on new-enough engines,
 * and falls back to recreate-and-copy on older ones. The version boundaries are
 * load-bearing — pick the wrong DDL and the migration fails on the target
 * engine. These tests pin the exact thresholds:
 *   - native RENAME COLUMN: SQLite >= 3.25.0
 *   - native DROP COLUMN:   SQLite >= 3.35.0
 * and that an unparseable/absent version is treated as modern.
 */
import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change } from "../../src/types.js";
import type { SchemaSnapshot } from "../../src/types.js";

const TABLE: SchemaSnapshot = {
  tables: [{
    name: "t",
    columns: [{ name: "a", sqlType: { kind: "text" }, nullable: true }],
    indexes: [],
    foreignKeys: [],
    primaryKey: [],
    checks: [],
  }],
  views: [],
};

function emitSqlite(changes: Change[], sqliteVersion?: string) {
  return emit(changes, {
    dialect: "sqlite",
    expectedSchema: TABLE,
    // Omit actualMeta entirely when no version (exactOptionalPropertyTypes
    // forbids assigning `undefined` to the optional property).
    ...(sqliteVersion !== undefined ? { actualMeta: { sqliteVersion } } : {}),
  });
}

const renameChange: Change[] = [{ kind: "rename-column", status: { state: "allowed" }, table: "t", from: "a", to: "b" }];
const dropChange: Change[] = [{ kind: "drop-column", status: { state: "allowed" }, table: "t", column: "a" }];

describe("SQLite rename-column version gating (>= 3.25.0 native)", () => {
  test("3.25.0 → native ALTER … RENAME COLUMN (no recreate)", () => {
    const r = emitSqlite(renameChange, "3.25.0");
    expect(r.up).toContain("RENAME COLUMN");
    expect([...r.recreatedTables]).toEqual([]);
  });

  test("3.24.0 (one patch below) → recreate-and-copy", () => {
    const r = emitSqlite(renameChange, "3.24.0");
    expect(r.up).not.toMatch(/RENAME COLUMN/);
    expect(r.up).toContain("CREATE TABLE");
    expect([...r.recreatedTables]).toEqual(["t"]);
  });
});

describe("SQLite drop-column version gating (>= 3.35.0 native)", () => {
  test("3.35.0 → native ALTER … DROP COLUMN (no recreate)", () => {
    const r = emitSqlite(dropChange, "3.35.0");
    expect(r.up).toMatch(/DROP COLUMN/i);
    expect([...r.recreatedTables]).toEqual([]);
  });

  test("3.34.0 (one minor below) → recreate-and-copy", () => {
    const r = emitSqlite(dropChange, "3.34.0");
    expect(r.up).not.toMatch(/DROP COLUMN/i);
    expect(r.up).toContain("CREATE TABLE");
    expect([...r.recreatedTables]).toEqual(["t"]);
  });
});

describe("SQLite version parsing fallback", () => {
  test("an unparseable version string is treated as modern (native DDL)", () => {
    const r = emitSqlite(dropChange, "garbage");
    expect(r.up).toMatch(/DROP COLUMN/i);
    expect([...r.recreatedTables]).toEqual([]);
  });

  test("an absent version (no actualMeta) is treated as modern (native DDL)", () => {
    const r = emitSqlite(dropChange, undefined);
    expect(r.up).toMatch(/DROP COLUMN/i);
    expect([...r.recreatedTables]).toEqual([]);
  });
});
