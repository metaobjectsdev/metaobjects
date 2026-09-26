/**
 * A resolved column rename carries the CHECK / FK constraints named after the column
 * (the diff half; the real-engine proof is integration/declared-rename-carries-constraints).
 *
 * What must NOT be carried is just as important: a constraint whose rule changed beyond the
 * rename is a real drop+add, and stays gated.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { renameExprIdentifiers } from "../../src/check-expr-compare.js";
import type { Dialect, SchemaSnapshot, TableDescriptor, CheckDescriptor, FkDescriptor } from "../../src/types.js";

function reviews(ratingCol: string, check: CheckDescriptor | undefined, fk?: FkDescriptor): TableDescriptor {
  return {
    name: "reviews",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      { name: ratingCol, sqlType: { kind: "integer", bits: 32 }, nullable: false },
      ...(fk !== undefined ? [{ name: fk.columns[0]!, sqlType: { kind: "integer" as const, bits: 64 as const }, nullable: false }] : []),
    ],
    indexes: [],
    foreignKeys: fk !== undefined ? [fk] : [],
    primaryKey: ["id"],
    checks: check !== undefined ? [check] : [],
  };
}
const snap = (...tables: TableDescriptor[]): SchemaSnapshot => ({ tables, views: [] });
const range = (col: string, max = 5): CheckDescriptor =>
  ({ name: `reviews_${col}_numeric_chk`, expression: `"${col}" >= 1 AND "${col}" <= ${max}` });
const RENAME = [{ kind: "column", table: "reviews", from: "rating", to: "stars" }] as const;

describe("a column rename carries its constraints", () => {
  test("postgres: the CHECK name follows as RENAME CONSTRAINT; nothing is gated", async () => {
    const r = await diff({
      expected: snap(reviews("stars", range("stars"))),
      // PG hands the live body back re-spelled; the pairing must see through that.
      actual: snap(reviews("rating", { name: "reviews_rating_numeric_chk", expression: "((rating >= 1) AND (rating <= 5))" })),
      dialect: "postgres", renames: RENAME,
    });
    expect(r.blocked).toEqual([]);
    expect(r.hazards).toEqual([]);
    expect(r.changes).toEqual([{
      kind: "rename-column", table: "reviews", from: "rating", to: "stars",
      constraintRenames: [{ from: "reviews_rating_numeric_chk", to: "reviews_stars_numeric_chk" }],
      status: { state: "allowed" },
    }]);
  });

  test("postgres: an FK named after the column follows it too", async () => {
    const fk = (col: string): FkDescriptor =>
      ({ name: `reviews_${col}_fk`, columns: [col], refTable: "books", refColumns: ["id"], onDelete: "restrict" });
    const r = await diff({
      expected: snap(reviews("rating", undefined, fk("book_ref"))),
      actual: snap(reviews("rating", undefined, fk("book_id"))),
      dialect: "postgres",
      renames: [{ kind: "column", table: "reviews", from: "book_id", to: "book_ref" }],
    });
    expect(r.blocked).toEqual([]);
    expect(r.changes).toEqual([{
      kind: "rename-column", table: "reviews", from: "book_id", to: "book_ref",
      constraintRenames: [{ from: "reviews_book_id_fk", to: "reviews_book_ref_fk" }],
      status: { state: "allowed" },
    }]);
  });

  for (const dialect of ["sqlite", "d1"] as const satisfies readonly Dialect[]) {
    test(`${dialect}: the pair stays for the rebuild, marked carried — not gated, no hazard`, async () => {
      const r = await diff({
        expected: snap(reviews("stars", range("stars"))),
        actual: snap(reviews("rating", range("rating"))),
        dialect, renames: RENAME,
      });
      expect(r.blocked).toEqual([]);
      expect(r.hazards).toEqual([]);
      expect(r.changes.map((c) => c.kind).sort()).toEqual(["add-check", "drop-check", "rename-column"]);
      for (const c of r.changes) {
        if (c.kind === "add-check" || c.kind === "drop-check") expect(c.carriedByRename).toBe(true);
      }
    });
  }

  test("a rule that changed beyond the rename is NOT carried: the drop stays gated", async () => {
    const r = await diff({
      expected: snap(reviews("stars", range("stars", 10))),
      actual: snap(reviews("rating", range("rating", 5))),
      dialect: "postgres", renames: RENAME,
    });
    expect(r.blocked.map((c) => c.kind)).toEqual(["drop-check"]);
    const rename = r.changes.find((c) => c.kind === "rename-column");
    expect(rename !== undefined && "constraintRenames" in rename).toBe(false);
  });

  test("an unrelated dropped check on the same table is NOT carried", async () => {
    const r = await diff({
      expected: snap(reviews("stars", undefined)),
      actual: snap(reviews("rating", range("rating"))),
      dialect: "sqlite", renames: RENAME,
    });
    expect(r.blocked.map((c) => c.kind)).toEqual(["drop-check"]);
  });
});

describe("renameExprIdentifiers", () => {
  const m = new Map([["rating", "stars"]]);
  test("respells quoted and bare identifiers", () => {
    expect(renameExprIdentifiers(`"rating" >= 1 AND rating <= 5`, m)).toBe(`"stars" >= 1 AND stars <= 5`);
  });
  test("leaves string literals and longer words alone", () => {
    expect(renameExprIdentifiers(`rating_note = 'rating' OR "rating" IS NULL`, m))
      .toBe(`rating_note = 'rating' OR "stars" IS NULL`);
  });
});
