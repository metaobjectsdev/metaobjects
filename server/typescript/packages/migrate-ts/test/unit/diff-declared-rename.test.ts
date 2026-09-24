/**
 * A declared rename (`meta migrate --rename-column` / `--rename-table`) resolves a drop+add
 * pair as a rename no matter how different the names are.
 *
 * The heuristic pairs a column only within a small edit distance, so `origin_city` →
 * `origin_port` (4 edits) was never even offered as a rename: the migration dropped the
 * column and added an empty one, losing every value. An adopter estate hit exactly that and
 * had to hand-edit the emitted SQL. The author knows it is a rename; this is how they say so.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { DeclaredRenameError } from "../../src/errors.js";
import type { SchemaSnapshot, AmbiguousChange, TableDescriptor } from "../../src/types.js";

type Col = { name: string; type?: "text" | "integer"; nullable?: boolean; default?: string };

function table(name: string, cols: Col[]): TableDescriptor {
  return {
    name,
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      ...cols.map((c) => ({
        name: c.name,
        sqlType: c.type === "integer" ? { kind: "integer" as const, bits: 64 as const } : { kind: "text" as const },
        nullable: c.nullable ?? true,
        ...(c.default !== undefined ? { default: { kind: "literal" as const, value: c.default } } : {}),
      })),
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
    checks: [],
  };
}

const snap = (...tables: TableDescriptor[]): SchemaSnapshot => ({ tables, views: [] });

describe("declared column rename", () => {
  test("pairs names the heuristic never offers, without asking", async () => {
    const calls: AmbiguousChange[] = [];
    const r = await diff({
      expected: snap(table("shipment", [{ name: "origin_port" }])),
      actual: snap(table("shipment", [{ name: "origin_city" }])),
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
      onAmbiguous: async (q) => { calls.push(q); return "abort"; },
    });
    expect(calls).toHaveLength(0);
    expect(r.changes).toEqual([
      { kind: "rename-column", table: "shipment", from: "origin_city", to: "origin_port", status: { state: "allowed" } },
    ]);
    expect(r.blocked).toHaveLength(0);
  });

  test("other ambiguous pairs on the same table still go to the heuristic", async () => {
    const calls: AmbiguousChange[] = [];
    const r = await diff({
      expected: snap(table("shipment", [{ name: "origin_port" }, { name: "first_name" }])),
      actual: snap(table("shipment", [{ name: "origin_city" }, { name: "firstname" }])),
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
      onAmbiguous: async (q) => { calls.push(q); return "rename"; },
    });
    expect(calls.map((c) => c.kind)).toEqual(["possible-column-rename"]);
    expect(r.changes.filter((c) => c.kind === "rename-column")).toHaveLength(2);
  });

  test("a declared column on a table renamed in the same run uses the NEW table name", async () => {
    const r = await diff({
      expected: snap(table("shipment_leg", [{ name: "origin_port" }])),
      actual: snap(table("leg", [{ name: "origin_city" }])),
      renames: [
        { kind: "table", from: "leg", to: "shipment_leg" },
        { kind: "column", table: "shipment_leg", from: "origin_city", to: "origin_port" },
      ],
    });
    expect(r.changes.map((c) => c.kind)).toEqual(["rename-table", "rename-column"]);
  });

  test("refuses when the old column is not being dropped", async () => {
    const run = diff({
      expected: snap(table("shipment", [{ name: "origin_port" }])),
      actual: snap(table("shipment", [])),
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
    });
    await expect(run).rejects.toBeInstanceOf(DeclaredRenameError);
    await expect(run).rejects.toThrow(/shipment\.origin_city.*not in the database/);
  });

  test("refuses when the new column is not being added", async () => {
    await expect(diff({
      expected: snap(table("shipment", [])),
      actual: snap(table("shipment", [{ name: "origin_city" }])),
      allow: { dropColumn: true },
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
    })).rejects.toThrow(/shipment\.origin_port.*not in the metadata/);
  });

  test("refuses a rename that is already applied, naming the flag to drop", async () => {
    await expect(diff({
      expected: snap(table("shipment", [{ name: "origin_port" }])),
      actual: snap(table("shipment", [{ name: "origin_port" }])),
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
    })).rejects.toThrow(/already/);
  });

  test("refuses a rename that also changes the column's type — ordering cannot express both", async () => {
    await expect(diff({
      expected: snap(table("shipment", [{ name: "origin_port", type: "integer" }])),
      actual: snap(table("shipment", [{ name: "origin_city", type: "text" }])),
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
    })).rejects.toThrow(/type/);
  });

  test("refuses a rename that also changes nullability or default", async () => {
    await expect(diff({
      expected: snap(table("shipment", [{ name: "origin_port", nullable: false }])),
      actual: snap(table("shipment", [{ name: "origin_city", nullable: true }])),
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
    })).rejects.toThrow(/nullab/);
    await expect(diff({
      expected: snap(table("shipment", [{ name: "origin_port", default: "'x'" }])),
      actual: snap(table("shipment", [{ name: "origin_city" }])),
      renames: [{ kind: "column", table: "shipment", from: "origin_city", to: "origin_port" }],
    })).rejects.toThrow(/default/);
  });
});

describe("declared table rename", () => {
  test("pairs tables whose columns overlap too little for the heuristic", async () => {
    const calls: AmbiguousChange[] = [];
    const r = await diff({
      expected: snap(table("port_call", [{ name: "arrival" }, { name: "berth" }, { name: "cargo" }])),
      actual: snap(table("stop", [{ name: "sequence_no" }, { name: "remarks" }])),
      allow: { dropColumn: true },
      renames: [{ kind: "table", from: "stop", to: "port_call" }],
      onAmbiguous: async (q) => { calls.push(q); return "abort"; },
    });
    expect(calls).toHaveLength(0);
    expect(r.changes[0]).toMatchObject({ kind: "rename-table", from: "stop", to: "port_call" });
    expect(r.changes.some((c) => c.kind === "drop-table" || c.kind === "create-table")).toBe(false);
  });

  test("refuses when the old table is not in the database", async () => {
    await expect(diff({
      expected: snap(table("port_call", [])),
      actual: snap(),
      renames: [{ kind: "table", from: "stop", to: "port_call" }],
    })).rejects.toThrow(/stop.*not in the database/);
  });

  test("refuses when the new table is not in the metadata", async () => {
    await expect(diff({
      expected: snap(),
      actual: snap(table("stop", [])),
      allow: { dropTable: true },
      renames: [{ kind: "table", from: "stop", to: "port_call" }],
    })).rejects.toThrow(/port_call.*not in the metadata/);
  });
});

describe("declared renames — review follow-ups", () => {
  test("refuses a column rename that also changes its identity", async () => {
    const t = (col: string, identity?: "increment") => ({
      ...table("shipment", []),
      columns: [
        { name: "id", sqlType: { kind: "integer" as const, bits: 64 as const }, nullable: false },
        { name: col, sqlType: { kind: "integer" as const, bits: 64 as const }, nullable: false, ...(identity ? { identity } : {}) },
      ],
    });
    await expect(diff({
      expected: snap(t("seq_no", "increment")),
      actual: snap(t("sequence")),
      renames: [{ kind: "column", table: "shipment", from: "sequence", to: "seq_no" }],
    })).rejects.toThrow(/identity \(none → increment\)/);
  });

  test("two table declarations sharing a source cannot both claim it", async () => {
    await expect(diff({
      expected: snap(table("port_call", []), table("other", [])),
      actual: snap(table("stop", [])),
      renames: [{ kind: "table", from: "stop", to: "port_call" }, { kind: "table", from: "stop", to: "other" }],
    })).rejects.toThrow(/stop.*not in the database/);
  });

  test("two column declarations sharing a source cannot both claim it", async () => {
    await expect(diff({
      expected: snap(table("shipment", [{ name: "origin_port" }, { name: "origin_town" }])),
      actual: snap(table("shipment", [{ name: "origin_city" }])),
      renames: [
        { kind: "column", table: "shipment", from: "origin_city", to: "origin_port" },
        { kind: "column", table: "shipment", from: "origin_city", to: "origin_town" },
      ],
    })).rejects.toThrow(/origin_city.*not in the database/);
  });
});
