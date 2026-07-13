/**
 * View column typing + the CREATE-OR-REPLACE legality rule.
 *
 * These decide whether a view change is applied NON-DESTRUCTIVELY. Get them wrong in
 * the optimistic direction and the migration emits a statement Postgres rejects at
 * APPLY time ("cannot change data type of view column ..."), aborting mid-flight with
 * no plan-time warning. So the fail-safe direction is asserted explicitly below: every
 * unknown resolves to "not replaceable", never to "replaceable".
 *
 * The aggregate result types are not guesses — they are checked against real Postgres
 * by test/../integration-tests view-lifecycle-pg (min/max keep the argument type,
 * count/sum over int widen to bigint, avg goes numeric).
 */

import { describe, test, expect } from "bun:test";
import { resolveViewColumns, viewReplaceIsLegal } from "../../src/view-column-types.js";
import type { TableDescriptor, ViewColumnDescriptor } from "../../src/types.js";

const TABLES: TableDescriptor[] = [
  {
    name: "programs",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      { name: "title", sqlType: { kind: "text", maxLength: 200 }, nullable: false },
      { name: "minutes", sqlType: { kind: "integer", bits: 32 }, nullable: true },
      { name: "price", sqlType: { kind: "numeric", precision: 9, scale: 2 }, nullable: true },
    ],
    indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
  },
];

const col = (name: string, sqlType: ViewColumnDescriptor["sqlType"]): ViewColumnDescriptor =>
  ({ name, sqlType });

describe("resolveViewColumns", () => {
  test("a passthrough column takes its source column's type", () => {
    expect(resolveViewColumns(
      [{ kind: "passthrough", name: "title", sourceTable: "programs", sourceColumn: "title" }],
      TABLES,
    )).toEqual([col("title", { kind: "text", maxLength: 200 })]);
  });

  test("aggregates use POSTGRES result types, not the argument type", () => {
    const of = (agg: string, sourceColumn: string) =>
      resolveViewColumns([{ kind: "aggregate", name: "x", sourceTable: "programs", sourceColumn, agg }], TABLES)?.[0]?.sqlType;

    // count(anything) is bigint — NOT the argument's int32.
    expect(of("count", "minutes")).toEqual({ kind: "integer", bits: 64 });
    // sum(int32) widens to bigint; sum(bigint) goes numeric (it can overflow).
    expect(of("sum", "minutes")).toEqual({ kind: "integer", bits: 64 });
    expect(of("sum", "id")).toEqual({ kind: "numeric" });
    // avg of any exact type is numeric.
    expect(of("avg", "minutes")).toEqual({ kind: "numeric" });
    // min/max preserve the argument type.
    expect(of("min", "minutes")).toEqual({ kind: "integer", bits: 32 });
    expect(of("max", "price")).toEqual({ kind: "numeric", precision: 9, scale: 2 });
  });

  test("an unresolvable column drops the WHOLE list — a partial list would misalign the prefix compare", () => {
    expect(resolveViewColumns(
      [
        { kind: "passthrough", name: "title", sourceTable: "programs", sourceColumn: "title" },
        { kind: "passthrough", name: "gone", sourceTable: "programs", sourceColumn: "nonexistent" },
      ],
      TABLES,
    )).toBeUndefined();

    expect(resolveViewColumns(
      [{ kind: "aggregate", name: "x", sourceTable: "programs", sourceColumn: "minutes", agg: "bogus" }],
      TABLES,
    )).toBeUndefined();
  });
});

describe("viewReplaceIsLegal — Postgres's prefix rule", () => {
  const a = col("a", { kind: "text" });
  const b = col("b", { kind: "integer", bits: 64 });
  const c = col("c", { kind: "boolean" });

  test("identical column lists are replaceable", () => {
    expect(viewReplaceIsLegal([a, b], [a, b])).toBe(true);
  });

  test("APPENDING a column is replaceable — this is what keeps a projection change non-destructive", () => {
    expect(viewReplaceIsLegal([a, b, c], [a, b])).toBe(true);
  });

  test("REMOVING a column is NOT replaceable (Postgres: cannot drop columns from view)", () => {
    expect(viewReplaceIsLegal([a], [a, b])).toBe(false);
  });

  test("REORDERING is NOT replaceable — the old list is no longer a prefix", () => {
    expect(viewReplaceIsLegal([b, a], [a, b])).toBe(false);
  });

  test("INSERTING mid-list is NOT replaceable", () => {
    expect(viewReplaceIsLegal([a, c, b], [a, b])).toBe(false);
  });

  test("RENAMING a column is NOT replaceable", () => {
    expect(viewReplaceIsLegal([col("renamed", { kind: "text" }), b], [a, b])).toBe(false);
  });

  test("RETYPING a column in place is NOT replaceable", () => {
    expect(viewReplaceIsLegal([col("a", { kind: "integer", bits: 32 }), b], [a, b])).toBe(false);
  });

  test("FAIL SAFE: unknown columns on either side are NOT replaceable", () => {
    // A wrong "true" here is not a failed assertion — it is a statement Postgres rejects
    // at apply time, aborting a live migration. Unknown must always mean "drop+create".
    expect(viewReplaceIsLegal(undefined, [a])).toBe(false);
    expect(viewReplaceIsLegal([a], undefined)).toBe(false);
    expect(viewReplaceIsLegal(undefined, undefined)).toBe(false);
  });
});
