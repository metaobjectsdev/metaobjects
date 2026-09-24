/**
 * Data hazards: changes that apply cleanly to an empty table and FAIL on a populated one.
 *
 * An adopter estate hit three of these on a populated database: a new required column with
 * no default (`ADD COLUMN … NOT NULL` fails on any existing row), an enum narrowed to fewer
 * values (the new CHECK fails on a row holding a retired value), and an optional field made
 * required (`SET NOT NULL` fails on a NULL). A replay against a fresh database proves none of
 * them, because a fresh database has no rows. The diff cannot see the rows, so it does not
 * block; it reports the hazard so the CLI can warn and the emitter can say how to prepare.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { SchemaSnapshot, TableDescriptor, ColumnDescriptor, CheckDescriptor } from "../../src/types.js";

const id: ColumnDescriptor = { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false };

function table(cols: ColumnDescriptor[], checks: CheckDescriptor[] = []): TableDescriptor {
  return { name: "shipment", columns: [id, ...cols], indexes: [], foreignKeys: [], primaryKey: ["id"], checks };
}
const snap = (t: TableDescriptor): SchemaSnapshot => ({ tables: [t], views: [] });
const text = (name: string, extra: Partial<ColumnDescriptor> = {}): ColumnDescriptor =>
  ({ name, sqlType: { kind: "text" }, nullable: true, ...extra });

describe("diff reports data hazards", () => {
  test("a required column with no default added to an existing table", async () => {
    const r = await diff({ expected: snap(table([text("mode", { nullable: false })])), actual: snap(table([])) });
    expect(r.hazards).toEqual([{ kind: "add-required-column", table: "shipment", column: "mode" }]);
  });

  test("no hazard for a nullable column, a defaulted one, or a brand-new table", async () => {
    const r1 = await diff({
      expected: snap(table([text("a"), text("b", { nullable: false, default: { kind: "literal", value: "'x'" } })])),
      actual: snap(table([])),
    });
    expect(r1.hazards).toEqual([]);
    const r2 = await diff({ expected: snap(table([text("mode", { nullable: false })])), actual: { tables: [], views: [] } });
    expect(r2.hazards).toEqual([]);
  });

  test("a CHECK added to an existing table", async () => {
    const check = { name: "shipment_mode_chk", expression: "mode IN ('sea', 'air')" };
    const r = await diff({
      expected: snap(table([text("mode")], [check])),
      actual: snap(table([text("mode")])),
      dialect: "postgres",
    });
    expect(r.hazards).toEqual([{ kind: "add-check", table: "shipment", check: "shipment_mode_chk", expression: "mode IN ('sea', 'air')" }]);
  });

  test("an optional column made required", async () => {
    const r = await diff({
      expected: snap(table([text("mode", { nullable: false })])),
      actual: snap(table([text("mode")])),
      allow: { nullableToNotNull: true },
    });
    expect(r.hazards).toEqual([{ kind: "set-not-null", table: "shipment", column: "mode" }]);
  });
});

describe("postgres emit says how to prepare the data", () => {
  test("each hazard statement carries a WARNING comment with the preparation step", async () => {
    const r = await diff({
      expected: snap(table(
        [text("mode", { nullable: false }), text("carrier", { nullable: false })],
        [{ name: "shipment_mode_chk", expression: "mode IN ('sea', 'air')" }],
      )),
      actual: snap(table([text("mode")])),
      allow: { nullableToNotNull: true },
      dialect: "postgres",
    });
    const { up } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(
      `-- WARNING: fails if "shipment" has rows: "carrier" is NOT NULL with no default.`,
    );
    expect(up).toContain(`-- WARNING: fails if any row of "shipment" holds NULL in "mode". Backfill first:`);
    expect(up).toContain(`-- UPDATE "shipment" SET "mode" = <value> WHERE "mode" IS NULL;`);
    expect(up).toContain(`-- WARNING: fails if any row of "shipment" violates "shipment_mode_chk". Find them first:`);
    expect(up).toContain(`-- SELECT * FROM "shipment" WHERE NOT (mode IN ('sea', 'air'));`);
  });

  test("a nullable added column carries no comment", async () => {
    const r = await diff({ expected: snap(table([text("mode")])), actual: snap(table([])) });
    expect(emit(r.changes, { dialect: "postgres" }).up).not.toContain("WARNING");
  });
});
