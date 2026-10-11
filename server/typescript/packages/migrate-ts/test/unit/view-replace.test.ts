/**
 * When may a live Postgres view be changed with `CREATE OR REPLACE VIEW`? (adopter report D2)
 *
 * Postgres permits it only when every existing column keeps its name, type, collation and
 * position, with new columns at the end, and it refuses anything else at APPLY time. The
 * planner does not predict the answer: it asks the database through a probe and plans a
 * replace only on that evidence. These tests pin the rule itself, taken from the Postgres
 * documentation (https://www.postgresql.org/docs/current/sql-createview.html), and the
 * planner's use of it with a stubbed probe. The real probe runs against a live Postgres in
 * integration-tests view-replace-probe-pg.
 */

import { describe, test, expect } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { viewFingerprint } from "../../src/view-fingerprint.js";
import { viewReplaceIsLegal, type ExactViewColumn, type ViewReplaceProbe } from "../../src/view-replace.js";
import type { DeclaredRename, SchemaSnapshot, ViewDescriptor } from "../../src/types.js";

const col = (name: string, type: string, collation = "0"): ExactViewColumn => ({ name, type, collation });

describe("viewReplaceIsLegal — Postgres's prefix rule", () => {
  const a = col("a", "text", "100");
  const b = col("b", "bigint");
  const c = col("c", "boolean");

  test("identical column lists are replaceable", () => {
    expect(viewReplaceIsLegal([a, b], [a, b])).toBe(true);
  });

  test("APPENDING a column is replaceable; undoing the append is not", () => {
    expect(viewReplaceIsLegal([a, b, c], [a, b])).toBe(true);
    expect(viewReplaceIsLegal([a, b], [a, b, c])).toBe(false);
  });

  test("REORDERING, INSERTING mid-list and RENAMING are not replaceable", () => {
    expect(viewReplaceIsLegal([b, a], [a, b])).toBe(false);
    expect(viewReplaceIsLegal([a, c, b], [a, b])).toBe(false);
    expect(viewReplaceIsLegal([col("renamed", "text", "100"), b], [a, b])).toBe(false);
  });

  // Each pair is one type under a coarser model and two types to Postgres, which refuses
  // the replace with "cannot change data type of view column".
  test.each([
    ["json", "jsonb"],
    ["smallint", "integer"],
    ["character varying", "text"],
    ["character varying(40)", "character varying"],
    ["character varying[]", "text[]"],
    ["numeric(9,2)", "numeric"],
    ["integer", "bigint"],
  ])("RETYPING %s to %s is not replaceable", (from, to) => {
    expect(viewReplaceIsLegal([col("x", to)], [col("x", from)])).toBe(false);
    expect(viewReplaceIsLegal([col("x", from)], [col("x", from)])).toBe(true);
  });

  test("a changed collation is not replaceable", () => {
    expect(viewReplaceIsLegal([col("x", "text", "950")], [col("x", "text", "100")])).toBe(false);
  });

  test("a view with no columns proves nothing", () => {
    expect(viewReplaceIsLegal([a], [])).toBe(false);
    expect(viewReplaceIsLegal([], [])).toBe(false);
  });
});

describe("the planner replaces a view only on the probe's evidence", () => {
  const OLD_BODY = "SELECT g.id AS id, COALESCE(g.nickname, 'x') AS label FROM games g";
  const NEW_BODY = "SELECT g.id AS id, COALESCE(g.notes, 'x') AS label FROM games g";
  const view = (sql: string, stamped = true): ViewDescriptor => ({
    name: "v_games", sql, dependsOn: ["games"],
    ...(stamped ? { fingerprint: viewFingerprint(sql) } : {}),
  });
  const snap = (views: ViewDescriptor[]): SchemaSnapshot => ({
    tables: [{
      name: "games",
      columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
      indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [],
    }],
    views,
  });
  const kinds = (r: { changes: { kind: string }[] }) => r.changes.map((c) => c.kind);
  const ID = col("id", "bigint");

  /** A probe that answers with `evidence` and records what it was asked. */
  function stub(evidence: Awaited<ReturnType<ViewReplaceProbe>>) {
    const asked: { expected: string; live: string }[] = [];
    const probe: ViewReplaceProbe = async (expected, live) => {
      asked.push({ expected: expected.sql ?? "", live: live.sql ?? "" });
      return evidence;
    };
    return { probe, asked };
  }

  const changed = (probe?: ViewReplaceProbe) =>
    diff(snap([view(NEW_BODY)]), snap([view(OLD_BODY)]), {
      dialect: "postgres",
      ...(probe !== undefined ? { viewReplaceProbe: probe } : {}),
    });

  test("a managed change the database proves legal is a replace, restorable when the columns are the same", async () => {
    const label = col("label", "text", "100");
    const { probe, asked } = stub({ expected: [ID, label], live: [ID, label] });
    const r = await changed(probe);
    expect(kinds(r)).toEqual(["replace-view"]);
    expect(r.changes[0]).toMatchObject({ proven: { restorable: true } });
    expect(r.blocked).toEqual([]);
    // Asked once, about the expected definition and the live view it would replace.
    expect(asked).toEqual([{ expected: NEW_BODY, live: OLD_BODY }]);
  });

  // The regression: a coalesce that moves from a varchar(40) field to an unbounded one keeps
  // its name and its string-ness, and changes type. Postgres refuses the replace.
  test("a managed change that retypes a column is a drop and a create", async () => {
    const { probe } = stub({
      expected: [ID, col("label", "text", "100")],
      live: [ID, col("label", "character varying", "100")],
    });
    const r = await changed(probe);
    expect(kinds(r)).toEqual(["drop-view", "create-view"]);
    expect(r.blocked).toEqual([]);
  });

  test("a probe that could not answer plans a drop and a create", async () => {
    const { probe, asked } = stub(undefined);
    expect(kinds(await changed(probe))).toEqual(["drop-view", "create-view"]);
    expect(asked).toHaveLength(1);
  });

  test("no probe (an offline plan) plans a drop and a create", async () => {
    expect(kinds(await changed())).toEqual(["drop-view", "create-view"]);
  });

  test("the probe is not asked about a view that is unchanged, new, or undeclared", async () => {
    const { probe, asked } = stub({ expected: [ID], live: [ID] });
    const opts = { dialect: "postgres" as const, viewReplaceProbe: probe };
    expect(kinds(await diff(snap([view(OLD_BODY)]), snap([view(OLD_BODY)]), opts))).toEqual([]);
    expect(kinds(await diff(snap([view(OLD_BODY)]), snap([]), opts))).toEqual(["create-view"]);
    expect(kinds(await diff(snap([]), snap([view(OLD_BODY)]), { ...opts, allow: { dropView: true } }))).toEqual(["drop-view"]);
    expect(asked).toEqual([]);
  });

  // The probe sees the schema before the plan's table changes; the replace runs after them.
  // `SELECT *` re-expands then, so a column the plan adds lands in the middle of the view's
  // column list and Postgres refuses the replace ("cannot change name of view column").
  describe("a body that reads every column, in a plan that adds a column", () => {
    const TAGLINE = { name: "tagline", sqlType: { kind: "text" as const }, nullable: true };
    const withTagline = (views: ViewDescriptor[]): SchemaSnapshot => {
      const s = snap(views);
      return { ...s, tables: s.tables.map((t) => ({ ...t, columns: [...t.columns, TAGLINE] })) };
    };
    const same = { expected: [ID, col("extra", "integer")], live: [ID, col("extra", "integer")] };
    const STAR_OLD = "SELECT g.*, 1 AS extra FROM games g";
    const STAR_NEW = "SELECT g.*, 2 AS extra FROM games g";

    test("is dropped and created, and the probe is not asked", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(withTagline([view(STAR_NEW)]), snap([view(STAR_OLD)]), { dialect: "postgres", viewReplaceProbe: probe });
      expect(kinds(r)).toEqual(["add-column", "drop-view", "create-view"]);
      expect(asked).toEqual([]);
    });

    test("is still replaced on the probe's evidence when the plan adds no column", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(snap([view(STAR_NEW)]), snap([view(STAR_OLD)]), { dialect: "postgres", viewReplaceProbe: probe });
      expect(kinds(r)).toEqual(["replace-view"]);
      expect(asked).toHaveLength(1);
    });

    test("a body that names its columns is still replaced beside an added column", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(withTagline([view(NEW_BODY)]), snap([view(OLD_BODY)]), { dialect: "postgres", viewReplaceProbe: probe });
      expect(kinds(r)).toEqual(["add-column", "replace-view"]);
      expect(asked).toHaveLength(1);
    });
  });

  // A second table, `scores`, that a view body may read without listing it in dependsOn.
  type Columns = SchemaSnapshot["tables"][number]["columns"];
  const POINTS: Columns[number] = { name: "points", sqlType: { kind: "integer", bits: 32 }, nullable: false };
  const WIDE_POINTS: Columns[number] = { ...POINTS, sqlType: { kind: "integer", bits: 64 } };
  const NOTE: Columns[number] = { name: "note", sqlType: { kind: "text" }, nullable: true };
  const withScores = (views: ViewDescriptor[], columns?: readonly Columns[number][], table = "scores"): SchemaSnapshot => {
    const s = snap(views);
    if (columns === undefined) return s;
    return { ...s, tables: [...s.tables, { name: table, columns: [...columns], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }] };
  };
  const opaque = (sql: string): ViewDescriptor => ({ ...view(sql), opaque: true });
  const joined = (threshold: number): string =>
    `SELECT g.id AS id, (SELECT count(*) FROM scores s WHERE s.points > ${threshold}) AS scored FROM games g`;
  const UNJOINED = "SELECT g.id AS id, 0::bigint AS scored FROM games g";
  const same = { expected: [ID, col("scored", "bigint")], live: [ID, col("scored", "bigint")] };
  const opts = (probe: ViewReplaceProbe, renames: readonly DeclaredRename[] = []) =>
    ({ dialect: "postgres" as const, viewReplaceProbe: probe, allow: { dropColumn: true, dropTable: true }, renames });

  // The probe sees the schema before the plan runs; the replace runs after the plan's table
  // changes. Postgres refuses to retype or drop a column, or drop a table, that a standing
  // view reads (https://www.postgresql.org/docs/current/sql-altertable.html, SET DATA TYPE
  // and DROP COLUMN; sql-droptable.html, RESTRICT). An `@sql` body is not parsed and may join
  // a table its `dependsOn` does not list, so any table's column change may be one it reads.
  describe("an opaque @sql body, in a plan that changes a table's columns", () => {
    test.each([
      ["retypes a column of a table outside dependsOn", joined(1), [WIDE_POINTS, NOTE], "change-column-type"],
      ["drops a column of a table outside dependsOn", UNJOINED, [NOTE], "drop-column"],
      ["drops a table outside dependsOn", UNJOINED, undefined, "drop-table"],
      ["adds a column to a table outside dependsOn", joined(1), [POINTS, NOTE, { ...NOTE, name: "memo" }], "add-column"],
    ] as const)("a plan that %s drops and creates the view, and the probe is not asked", async (_, body, columns, change) => {
      const { probe, asked } = stub(same);
      const r = await diff(withScores([opaque(body)], columns), withScores([view(joined(0))], [POINTS, NOTE]), opts(probe));
      expect(kinds(r)).toEqual([change, "drop-view", "create-view"]);
      expect(r.blocked).toEqual([]);
      expect(asked).toEqual([]);
    });

    test("a plan that changes no table still replaces it on the probe's evidence", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(withScores([opaque(joined(1))], [POINTS, NOTE]), withScores([view(joined(0))], [POINTS, NOTE]), opts(probe));
      expect(kinds(r)).toEqual(["replace-view"]);
      expect(asked).toHaveLength(1);
    });

    // A derived body lists every table it reads in dependsOn, so a change elsewhere cannot reach it.
    test("a derived body beside the same table change is still replaced on the probe's evidence", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(withScores([view(NEW_BODY)], [WIDE_POINTS, NOTE]), withScores([view(OLD_BODY)], [POINTS, NOTE]), opts(probe));
      expect(kinds(r)).toEqual(["change-column-type", "replace-view"]);
      expect(asked).toHaveLength(1);
    });
  });

  // The probe proves the NEW body. The LIVE view stands while the plan's table changes run,
  // and Postgres refuses to retype or drop a column, or drop a table, that it reads
  // (sql-altertable.html; sql-droptable.html). A table the new body no longer reads is
  // outside dependsOn, so only the live body's own text says the view reads it.
  describe("a derived body whose live view reads a table the new body does not", () => {
    const live = () => withScores([view(joined(0))], [POINTS, NOTE]);
    const PTS: Columns[number] = { ...POINTS, name: "pts" };
    const kindsSorted = (r: { changes: { kind: string }[] }) => kinds(r).sort();

    test.each([
      ["retypes a column of that table", [WIDE_POINTS, NOTE], "change-column-type"],
      ["drops a column of that table", [NOTE], "drop-column"],
      ["drops that table", undefined, "drop-table"],
    ] as const)("a plan that %s drops and creates the view, and the probe is not asked", async (_, columns, change) => {
      const { probe, asked } = stub(same);
      const r = await diff(withScores([view(UNJOINED)], columns), live(), opts(probe));
      expect(kinds(r)).toEqual([change, "drop-view", "create-view"]);
      expect(r.blocked).toEqual([]);
      expect(asked).toEqual([]);
    });

    // Postgres lets a column be renamed under a view; recreating the view anyway is safe.
    test("a plan that renames a column of that table drops and creates the view", async () => {
      const { probe, asked } = stub(same);
      const renames = [{ kind: "column", table: "scores", from: "points", to: "pts" }] as const;
      const r = await diff(withScores([view(UNJOINED)], [PTS, NOTE]), live(), opts(probe, renames));
      expect(kindsSorted(r)).toEqual(["create-view", "drop-view", "rename-column"]);
      expect(asked).toEqual([]);
    });

    // A change on a renamed table is keyed by its new name; the live body holds the old one.
    test("a plan that renames that table and drops a column of it drops and creates the view", async () => {
      const { probe, asked } = stub(same);
      const renames = [{ kind: "table", from: "scores", to: "tallies" }] as const;
      const r = await diff(withScores([view(UNJOINED)], [NOTE], "tallies"), live(), opts(probe, renames));
      expect(kindsSorted(r)).toEqual(["create-view", "drop-column", "drop-view", "rename-table"]);
      expect(asked).toEqual([]);
    });

    // A view follows a renamed table (it holds the table's OID), and nullability changes
    // in place under a view, so neither is refused: the probe decides.
    test.each([
      ["only renames that table", [POINTS, NOTE], "tallies", [{ kind: "table", from: "scores", to: "tallies" }], "rename-table"],
      ["changes a column's nullability on that table", [{ ...POINTS, nullable: true }, NOTE], "scores", [], "change-column-nullable"],
    ] as const)("a plan that %s still replaces the view on the probe's evidence", async (_, columns, table, renames, change) => {
      const { probe, asked } = stub(same);
      const r = await diff(withScores([view(UNJOINED)], columns, table), live(), opts(probe, renames));
      expect(kinds(r)).toEqual([change, "replace-view"]);
      expect(asked).toHaveLength(1);
    });
  });

  // `SELECT *` over another view is re-expanded when the view is replaced. Once the plan has
  // given that other view a new column, the column lands mid-list and Postgres refuses the
  // replace ("cannot change name of view column", sql-createview.html).
  describe("a body that reads every column of another view, in a plan that changes that view", () => {
    const named = (name: string, sql: string, over: Partial<ViewDescriptor> = {}): ViewDescriptor =>
      ({ name, sql, dependsOn: ["games"], fingerprint: viewFingerprint(sql), ...over });
    const base = (sql: string) => named("v_base", sql);
    const top = (extra: number) => named("v_top", `SELECT b.*, ${extra} AS extra FROM v_base b`, { opaque: true });
    const BASE = "SELECT g.id AS id FROM games g";
    const BASE_APPENDED = "SELECT g.id AS id, g.id AS twice FROM games g";
    const TWICE = col("twice", "bigint");
    const EXTRA = col("extra", "integer");

    /** Answers for each view as Postgres would before the plan runs, and records who was asked. */
    function probeBeforeThePlan() {
      const asked: string[] = [];
      const probe: ViewReplaceProbe = async (expected) => {
        asked.push(expected.name);
        return expected.name === "v_base"
          ? { expected: [ID, TWICE], live: [ID] }
          : { expected: [ID, EXTRA], live: [ID, EXTRA] };
      };
      return { probe, asked };
    }

    test("the view it reads is replaced in place, and it is dropped and created", async () => {
      const { probe, asked } = probeBeforeThePlan();
      const r = await diff(snap([base(BASE_APPENDED), top(2)]), snap([base(BASE), top(1)]), { dialect: "postgres", viewReplaceProbe: probe });
      expect(r.changes.map((c) => [c.kind, c.kind === "drop-view" ? c.view : (c as { view: ViewDescriptor }).view.name])).toEqual([
        ["replace-view", "v_base"], ["drop-view", "v_top"], ["create-view", "v_top"],
      ]);
      expect(r.blocked).toEqual([]);
      expect(asked).toEqual(["v_base"]);
    });

    test("with no other view changing, it is replaced on the probe's evidence", async () => {
      const { probe, asked } = probeBeforeThePlan();
      const r = await diff(snap([base(BASE), top(2)]), snap([base(BASE), top(1)]), { dialect: "postgres", viewReplaceProbe: probe });
      expect(kinds(r)).toEqual(["replace-view"]);
      expect(asked).toEqual(["v_top"]);
    });
  });

  test.each([
    ["a derived body", {}],
    ["an opaque @sql body", { opaque: true as const }],
  ])("adopting an unstamped view with %s the database proves compatible is a replace in place", async (_, marker) => {
    const label = col("label", "text", "100");
    const { probe, asked } = stub({ expected: [ID, label], live: [ID, label] });
    const r = await diff(snap([{ ...view(NEW_BODY), ...marker }]), snap([view(OLD_BODY, false)]), {
      dialect: "postgres", viewReplaceProbe: probe, allow: { adoptView: true },
    });
    expect(kinds(r)).toEqual(["replace-view"]);
    expect(r.changes[0]).toMatchObject({ unmanagedActual: true });
    expect(r.blocked).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  test("SQLite and D1 never ask: a replace there is written as DROP + CREATE", async () => {
    for (const dialect of ["sqlite", "d1"] as const) {
      const { probe, asked } = stub({ expected: [ID], live: [ID] });
      const live: ViewDescriptor = { name: "v_games", sql: `CREATE VIEW "v_games" AS ${OLD_BODY}`, dependsOn: ["games"] };
      const r = await diff(snap([view(NEW_BODY)]), snap([live]), { dialect, viewReplaceProbe: probe });
      expect(kinds(r)).toEqual(["replace-view"]);
      expect(asked).toEqual([]);
    }
  });
});
