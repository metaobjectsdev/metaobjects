import { describe, it, expect } from "bun:test";
import {
  renderCreateTable,
  renderCreateIndex,
  computeCarryColumns,
  type CarryColumns,
} from "../../src/emit/sqlite.js";
import type { TableDescriptor, IndexDescriptor, Change } from "../../src/types.js";

describe("SQLite primitives export", () => {
  it("renderCreateTable emits CREATE TABLE statement", () => {
    const table: TableDescriptor = {
      name: "t",
      columns: [
        {
          name: "id",
          sqlType: { kind: "integer", bits: 64 },
          nullable: false,
          identity: "increment",
          default: undefined,
        },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKey: ["id"],
      checks: [],
    };

    const result = renderCreateTable(table);
    expect(result).toContain('CREATE TABLE "t"');
    expect(result).toContain('"id"');
    expect(result).toContain("INTEGER");
    expect(result).toContain("PRIMARY KEY");
  });

  it("renderCreateIndex emits CREATE INDEX statement", () => {
    const ix: IndexDescriptor = {
      name: "idx_col",
      columns: ["col"],
      unique: false,
      expr: undefined,
      where: undefined,
      orders: undefined,
    };

    const result = renderCreateIndex("my_table", ix);
    expect(result).toContain("CREATE INDEX");
    expect(result).toContain('"idx_col"');
    expect(result).toContain('"my_table"');
    expect(result).toContain('"col"');
  });

  it("computeCarryColumns maps renamed columns correctly", () => {
    const changes: Change[] = [
      {
        kind: "rename-column",
        table: "users",
        from: "old_name",
        to: "new_name",
      },
      {
        kind: "add-column",
        table: "users",
        column: {
          name: "added_col",
          sqlType: { kind: "text" },
          nullable: true,
          identity: undefined,
          default: undefined,
        },
      },
    ];

    const newTable: TableDescriptor = {
      name: "users",
      columns: [
        {
          name: "id",
          sqlType: { kind: "integer", bits: 64 },
          nullable: false,
          identity: "increment",
          default: undefined,
        },
        {
          name: "new_name",
          sqlType: { kind: "text" },
          nullable: true,
          identity: undefined,
          default: undefined,
        },
        {
          name: "added_col",
          sqlType: { kind: "text" },
          nullable: true,
          identity: undefined,
          default: undefined,
        },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKey: ["id"],
      checks: [],
    };

    const result = computeCarryColumns(changes, newTable);

    // insertCols should exclude added_col
    expect(result.insertCols).toEqual(["id", "new_name"]);

    // selectCols should map new_name to old_name, id stays as id
    expect(result.selectCols).toEqual(["id", "old_name"]);
  });

  it("computeCarryColumns returns CarryColumns interface", () => {
    const changes: Change[] = [];
    const newTable: TableDescriptor = {
      name: "t",
      columns: [
        {
          name: "id",
          sqlType: { kind: "integer", bits: 64 },
          nullable: false,
          identity: "increment",
          default: undefined,
        },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKey: ["id"],
      checks: [],
    };

    const result: CarryColumns = computeCarryColumns(changes, newTable);
    expect(result).toHaveProperty("insertCols");
    expect(result).toHaveProperty("selectCols");
    expect(Array.isArray(result.insertCols)).toBe(true);
    expect(Array.isArray(result.selectCols)).toBe(true);
  });
});
