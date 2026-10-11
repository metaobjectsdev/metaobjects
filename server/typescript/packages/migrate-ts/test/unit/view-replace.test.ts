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
import type { SchemaSnapshot, ViewDescriptor } from "../../src/types.js";

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

  // The replace runs after the plan's table changes and leaves the live view standing while
  // they run. Postgres refuses to retype or drop a column, or drop a table, that a standing
  // view reads (https://www.postgresql.org/docs/current/sql-altertable.html, DROP COLUMN and
  // SET DATA TYPE; sql-droptable.html, RESTRICT). Pass 2c covers a table in `dependsOn`; an
  // `@sql` body joins tables its `dependsOn` does not list.
  describe("a body that reads a table outside dependsOn, in a plan that changes that table", () => {
    type Columns = SchemaSnapshot["tables"][number]["columns"];
    const POINTS: Columns[number] = { name: "points", sqlType: { kind: "integer", bits: 32 }, nullable: false };
    const NOTE: Columns[number] = { name: "note", sqlType: { kind: "text" }, nullable: true };
    const withScores = (views: ViewDescriptor[], columns?: Columns): SchemaSnapshot => {
      const s = snap(views);
      if (columns === undefined) return s;
      return { ...s, tables: [...s.tables, { name: "scores", columns, indexes: [], foreignKeys: [], primaryKey: [], checks: [] }] };
    };
    const joined = (threshold: number): string =>
      `SELECT g.id AS id, (SELECT count(*) FROM scores s WHERE s.points > ${threshold}) AS scored FROM games g`;
    const UNJOINED = "SELECT g.id AS id, 0::bigint AS scored FROM games g";
    const same = { expected: [ID, col("scored", "bigint")], live: [ID, col("scored", "bigint")] };
    const WIDE_POINTS: Columns[number] = { ...POINTS, sqlType: { kind: "integer", bits: 64 } };
    const opts = (probe: ViewReplaceProbe) =>
      ({ dialect: "postgres" as const, viewReplaceProbe: probe, allow: { dropColumn: true, dropTable: true } });

    test.each([
      ["retypes a column the body reads", joined(1), [WIDE_POINTS, NOTE], "change-column-type"],
      ["drops a column the live body reads", UNJOINED, [NOTE], "drop-column"],
      ["drops the table the live body reads", UNJOINED, undefined, "drop-table"],
    ] as const)("a plan that %s drops and creates the view, and the probe is not asked", async (_, body, columns, change) => {
      const { probe, asked } = stub(same);
      const r = await diff(
        withScores([view(body)], columns === undefined ? undefined : [...columns]),
        withScores([view(joined(0))], [POINTS, NOTE]),
        opts(probe),
      );
      expect(kinds(r)).toEqual([change, "drop-view", "create-view"]);
      expect(r.blocked).toEqual([]);
      expect(asked).toEqual([]);
    });

    test("a changed column the bodies do not read leaves the replace to the probe", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(
        withScores([view(joined(1))], [POINTS, { ...NOTE, sqlType: { kind: "integer", bits: 32 } }]),
        withScores([view(joined(0))], [POINTS, NOTE]),
        opts(probe),
      );
      expect(kinds(r)).toEqual(["change-column-type", "replace-view"]);
      expect(asked).toHaveLength(1);
    });

    test("a changed table the bodies do not read leaves the replace to the probe", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(
        withScores([view(NEW_BODY)], [WIDE_POINTS, NOTE]),
        withScores([view(OLD_BODY)], [POINTS, NOTE]),
        opts(probe),
      );
      expect(kinds(r)).toEqual(["change-column-type", "replace-view"]);
      expect(asked).toHaveLength(1);
    });

    // Postgres changes nullability in place under a view.
    test("a nullability change on a column the body reads leaves the replace to the probe", async () => {
      const { probe, asked } = stub(same);
      const r = await diff(
        withScores([view(joined(1))], [{ ...POINTS, nullable: true }, NOTE]),
        withScores([view(joined(0))], [POINTS, NOTE]),
        opts(probe),
      );
      expect(kinds(r)).toEqual(["change-column-nullable", "replace-view"]);
      expect(asked).toHaveLength(1);
    });
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
