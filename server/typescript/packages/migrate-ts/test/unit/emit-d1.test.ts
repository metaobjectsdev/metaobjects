import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change, SchemaSnapshot } from "../../src/types.js";

describe("emit(dialect: 'd1')", () => {
  test("produces sqlite-style DDL with no explicit BEGIN/COMMIT", () => {
    const changes: Change[] = [{
      kind: "create-table",
      status: { state: "allowed" },
      table: {
        name: "users",
        columns: [
          { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
          { name: "email", sqlType: { kind: "text" }, nullable: false },
        ],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
      },
    }];
    const expected: SchemaSnapshot = { tables: [], views: [] };
    const result = emit(changes, { dialect: "d1", expectedSchema: expected });
    expect(result.up).toContain("CREATE TABLE");
    expect(result.up).toContain("users");
    expect(result.up).not.toMatch(/^\s*BEGIN/im);
    expect(result.up).not.toMatch(/^\s*COMMIT/im);
    expect(result.down).toContain("DROP TABLE");
    expect(result.down).not.toMatch(/^\s*BEGIN/im);
  });

  test("matches sqlite emit modulo safety transforms (no recreate)", () => {
    const changes: Change[] = [{
      kind: "create-table",
      status: { state: "allowed" },
      table: {
        name: "books",
        columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
      },
    }];
    const expected: SchemaSnapshot = { tables: [], views: [] };
    const sqliteResult = emit(changes, { dialect: "sqlite", expectedSchema: expected });
    const d1Result = emit(changes, { dialect: "d1", expectedSchema: expected });
    // For a simple CREATE TABLE there are no BEGIN/COMMIT to strip; outputs should match.
    expect(d1Result.up).toBe(sqliteResult.up);
    expect(d1Result.down).toBe(sqliteResult.down);
  });

  test("recreatedTables propagates through the wrapper", () => {
    // Build an actual SchemaSnapshot whose meta forces recreate-and-copy.
    // The detailed recreate scenario is covered by sqlite tests; here we
    // just confirm the wrapper exposes the same `recreatedTables` field.
    const changes: Change[] = [{
      kind: "drop-column",
      status: { state: "allowed" },
      table: "users",
      column: "old_col",
    }];
    const actualMeta = { sqliteVersion: "3.20.0" }; // older than 3.35 → triggers recreate
    const expected: SchemaSnapshot = {
      tables: [{
        name: "users",
        columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
      }],
      views: [],
    };
    const result = emit(changes, { dialect: "d1", expectedSchema: expected, actualMeta });
    expect(result.recreatedTables.has("users")).toBe(true);
    // recreate-and-copy emits PRAGMA foreign_keys=OFF/ON; safety pass MUST preserve these.
    expect(result.up).toContain("PRAGMA foreign_keys");
    // But it must NOT contain explicit BEGIN/COMMIT in d1 mode.
    expect(result.up).not.toMatch(/^\s*BEGIN/im);
    expect(result.up).not.toMatch(/^\s*COMMIT/im);
  });
});
