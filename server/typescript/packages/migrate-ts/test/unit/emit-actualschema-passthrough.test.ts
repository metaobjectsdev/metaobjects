import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change, SchemaSnapshot } from "../../src/types.js";

describe("emit(dialect: 'd1') — actualSchema passthrough (#241 Task 3)", () => {
  test("accepts actualSchema on EmitOptions without throwing", () => {
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
        checks: [],
      },
    }];
    const expected: SchemaSnapshot = { tables: [], views: [] };
    const actualSchema: SchemaSnapshot = { tables: [], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema })).not.toThrow();
  });

  test("byte-identical output whether or not actualSchema is passed (renderD1 doesn't use it yet)", () => {
    const changes: Change[] = [{
      kind: "create-table",
      status: { state: "allowed" },
      table: {
        name: "books",
        columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
        checks: [],
      },
    }];
    const expected: SchemaSnapshot = { tables: [], views: [] };
    // A non-empty actualSchema, distinct from expectedSchema, to prove it's inert for now.
    const actualSchema: SchemaSnapshot = {
      tables: [{
        name: "unrelated",
        columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
        checks: [],
      }],
      views: [],
    };

    const withoutActual = emit(changes, { dialect: "d1", expectedSchema: expected });
    const withActual = emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema });

    expect(withActual.up).toBe(withoutActual.up);
    expect(withActual.down).toBe(withoutActual.down);
    expect(withActual.recreatedTables).toEqual(withoutActual.recreatedTables);
  });
});
