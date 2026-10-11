/**
 * Views and column changes (adopter report D4).
 *
 * Postgres only blocks ALTER on a column a view READS, and only for a type change, a drop
 * or a rename. A default or nullability change, or a change to a column the view does not
 * read, must not drop and recreate the view. (D2, when a view may be replaced in place, is
 * in view-replace.test.ts.)
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { viewFingerprint } from "../../src/view-fingerprint.js";
import type { ColumnDescriptor, Dialect, SchemaSnapshot, TableDescriptor, ViewDescriptor } from "../../src/types.js";

const BODY = "SELECT g.id AS id, g.label AS label FROM games g";

function table(cols: ColumnDescriptor[]): TableDescriptor {
  return { name: "games", columns: cols, indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] };
}
const ID: ColumnDescriptor = { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false };
const LABEL: ColumnDescriptor = { name: "label", sqlType: { kind: "text" }, nullable: false };
const NOTE: ColumnDescriptor = { name: "note", sqlType: { kind: "text" }, nullable: false };

function view(over: Partial<ViewDescriptor> = {}): ViewDescriptor {
  return { name: "v_games", sql: BODY, fingerprint: viewFingerprint(BODY), dependsOn: ["games"], ...over };
}

function snap(t: TableDescriptor, v: ViewDescriptor): SchemaSnapshot {
  return { tables: [t], views: [v] };
}

const kinds = (r: { changes: { kind: string }[] }) => r.changes.map((c) => c.kind);

describe("D4 — a view is recreated only when the migration alters a column it reads", () => {
  const dialect: Dialect = "postgres";
  const run = (expected: TableDescriptor, actual: TableDescriptor) =>
    diff(snap(expected, view()), snap(actual, view()), { dialect, allow: { typeChange: true } });

  test("a type change to a column the view reads recreates it", async () => {
    const r = await run(table([ID, { ...LABEL, sqlType: { kind: "text", maxLength: 255 } }]), table([ID, LABEL]));
    expect(kinds(r)).toEqual(expect.arrayContaining(["change-column-type", "drop-view", "create-view"]));
  });

  test("a type change to a column the view does NOT read leaves it alone", async () => {
    const r = await run(
      table([ID, LABEL, { ...NOTE, sqlType: { kind: "text", maxLength: 255 } }]),
      table([ID, LABEL, NOTE]),
    );
    expect(kinds(r)).toEqual(["change-column-type"]);
  });

  test("a nullability change does not recreate a view over it on Postgres", async () => {
    const r = await run(table([ID, { ...LABEL, nullable: true }]), table([ID, LABEL]));
    expect(kinds(r)).toEqual(["change-column-nullable"]);
  });

  test("a default-only change does not recreate a view over it on Postgres", async () => {
    const r = await run(
      table([ID, { ...LABEL, default: { kind: "literal", value: "x" } }]),
      table([ID, LABEL]),
    );
    expect(kinds(r)).toEqual(["change-column-default"]);
  });

  // Postgres folds an unquoted identifier to lower case, so `g.LABEL` reads column `label`.
  test("a hand-written body that spells the column in another case still reads it", async () => {
    const upper = "SELECT g.ID, g.LABEL FROM games g";
    const v = view({ sql: upper, fingerprint: viewFingerprint(upper) });
    const r = await diff(
      snap(table([ID, { ...LABEL, sqlType: { kind: "text", maxLength: 255 } }]), v),
      snap(table([ID, LABEL]), v),
      { dialect, allow: { typeChange: true } },
    );
    expect(kinds(r)).toEqual(expect.arrayContaining(["change-column-type", "drop-view", "create-view"]));
  });

  test("a view that selects * is recreated by any type change", async () => {
    const star = "SELECT * FROM games";
    const v = view({ sql: star, fingerprint: viewFingerprint(star) });
    const r = await diff(
      snap(table([ID, LABEL, { ...NOTE, sqlType: { kind: "text", maxLength: 255 } }]), v),
      snap(table([ID, LABEL, NOTE]), v),
      { dialect, allow: { typeChange: true } },
    );
    expect(kinds(r)).toEqual(expect.arrayContaining(["drop-view", "create-view"]));
  });

  // Postgres: NATURAL JOIN joins on every column name the two tables share, so the view
  // depends on `note` although its body never spells it, and the ALTER is refused while the
  // view stands ("cannot alter type of a column used by a view or rule").
  test("a view that joins NATURAL is recreated by any type change", async () => {
    const natural = "SELECT g.id FROM games g NATURAL JOIN archive";
    const v = view({ sql: natural, fingerprint: viewFingerprint(natural) });
    const r = await diff(
      snap(table([ID, LABEL, { ...NOTE, sqlType: { kind: "text", maxLength: 255 } }]), v),
      snap(table([ID, LABEL, NOTE]), v),
      { dialect, allow: { typeChange: true } },
    );
    expect(kinds(r)).toEqual(expect.arrayContaining(["change-column-type", "drop-view", "create-view"]));
  });

  test("SQLite still recreates every view over a rebuilt table", async () => {
    const r = await diff(
      snap(table([ID, LABEL, { ...NOTE, nullable: true }]), view()),
      snap(table([ID, LABEL, NOTE]), view()),
      { dialect: "sqlite" },
    );
    expect(kinds(r)).toEqual(expect.arrayContaining(["drop-view", "create-view"]));
  });

  test("a view with a pending definition change is recreated even if the column is not in its new body", async () => {
    const changed = view({ sql: "SELECT g.id AS id FROM games g", fingerprint: viewFingerprint("SELECT g.id AS id FROM games g") });
    const r = await diff(
      snap(table([ID, { ...NOTE, sqlType: { kind: "text", maxLength: 255 } }]), changed),
      snap(table([ID, NOTE]), view({ fingerprint: "f".repeat(64) })),
      { dialect, allow: { typeChange: true } },
    );
    expect(kinds(r)).toEqual(expect.arrayContaining(["drop-view", "create-view"]));
    expect(kinds(r)).not.toContain("replace-view");
  });
});

// A view's `dependsOn` lists the tables the model knows it reads. An `@sql` body may join
// another one (ADR-0043), and Postgres refuses `ALTER COLUMN … TYPE` on a column that a
// standing view reads, whichever table holds it
// (https://www.postgresql.org/docs/current/sql-altertable.html, SET DATA TYPE). The view's
// stored body is what names that table.
describe("an unchanged view whose stored body reads a table outside dependsOn (postgres)", () => {
  const POINTS: ColumnDescriptor = { name: "points", sqlType: { kind: "integer", bits: 32 }, nullable: false };
  const BONUS: ColumnDescriptor = { name: "bonus", sqlType: { kind: "integer", bits: 32 }, nullable: false };
  const wide = (c: ColumnDescriptor): ColumnDescriptor => ({ ...c, sqlType: { kind: "integer", bits: 64 } });
  const scores = (cols: ColumnDescriptor[]): TableDescriptor =>
    ({ name: "scores", columns: [ID, ...cols], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] });
  const JOINED = "SELECT g.id AS id, (SELECT count(*) FROM scores s WHERE s.points > 0) AS scored FROM games g";
  const joined = view({ sql: JOINED, fingerprint: viewFingerprint(JOINED) });
  const run = (v: ViewDescriptor, expected: ColumnDescriptor[]) =>
    diff(
      { tables: [table([ID, LABEL]), scores(expected)], views: [v] },
      { tables: [table([ID, LABEL]), scores([POINTS, BONUS])], views: [v] },
      { dialect: "postgres", allow: { typeChange: true } },
    );

  test("a type change to a column the body reads recreates it, and names the table", async () => {
    const r = await run(joined, [wide(POINTS), BONUS]);
    expect(kinds(r)).toEqual(["change-column-type", "drop-view", "create-view"]);
    expect(r.changes[1]).toMatchObject({ view: "v_games", reason: { kind: "unchanged", tables: ["scores"] } });
    expect(r.blocked).toEqual([]);
  });

  test("a type change to a column of that table the body does not read leaves it alone", async () => {
    expect(kinds(await run(joined, [POINTS, wide(BONUS)]))).toEqual(["change-column-type"]);
  });

  test("a view whose body does not name that table is left alone", async () => {
    expect(kinds(await run(view(), [wide(POINTS), BONUS]))).toEqual(["change-column-type"]);
  });
});
