import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { SchemaSnapshot, ColumnDescriptor } from "../../src/types.js";
import type { ViewReplaceProbe } from "../../src/view-replace.js";

const empty: SchemaSnapshot = { tables: [], views: [] };

function snapshot(tables: SchemaSnapshot["tables"]): SchemaSnapshot {
  return { tables, views: [] };
}

function col(name: string, kind: "text" | "integer" | "boolean" = "text"): ColumnDescriptor {
  if (kind === "integer") return { name, sqlType: { kind: "integer", bits: 64 }, nullable: false };
  if (kind === "boolean") return { name, sqlType: { kind: "boolean" }, nullable: false };
  return { name, sqlType: { kind: "text" }, nullable: false };
}

describe("diff — table-level", () => {
  test("empty → empty: no changes", async () => {
    const r = await diff(empty, empty);
    expect(r.changes).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  test("expected table not in actual → create-table", async () => {
    const expected = snapshot([{ name: "users", columns: [col("id", "integer"), col("email")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }]);
    const r = await diff(expected, empty);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.kind).toBe("create-table");
  });

  test("actual table not in expected → drop-table", async () => {
    const actual = snapshot([{ name: "legacy", columns: [col("id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }]);
    const r = await diff(empty, actual);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.kind).toBe("drop-table");
  });
});

describe("diff — per-table column-level", () => {
  test("expected column not in actual → add-column", async () => {
    const tableE = { name: "users", columns: [col("id", "integer"), col("email")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] };
    const tableA = { name: "users", columns: [col("id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "add-column", table: "users" });
  });

  test("actual column not in expected → drop-column", async () => {
    const tableE = { name: "users", columns: [col("id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] };
    const tableA = { name: "users", columns: [col("id", "integer"), col("legacy_field")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "drop-column", table: "users", column: "legacy_field" });
  });

  test("type mismatch → change-column-type", async () => {
    const tableE = { name: "users", columns: [{ ...col("count"), sqlType: { kind: "integer" as const, bits: 64 as const } }], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const tableA = { name: "users", columns: [col("count", "text")], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    const c = r.changes.find((x) => x.kind === "change-column-type");
    expect(c).toMatchObject({ kind: "change-column-type", table: "users", column: "count" });
  });

  test("nullable mismatch → change-column-nullable", async () => {
    const tableE = { name: "users", columns: [{ ...col("note"), nullable: true }], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const tableA = { name: "users", columns: [{ ...col("note"), nullable: false }], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    const c = r.changes.find((x) => x.kind === "change-column-nullable");
    expect(c).toBeDefined();
    expect(c).toMatchObject({ from: false, to: true });
  });

  test("default mismatch → change-column-default", async () => {
    const tableE = { name: "users", columns: [{ ...col("flag", "boolean"), default: { kind: "literal" as const, value: "true" } }], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const tableA = { name: "users", columns: [col("flag", "boolean")], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes.find((x) => x.kind === "change-column-default")).toMatchObject({
      kind: "change-column-default", table: "users", column: "flag", to: { kind: "literal", value: "true" },
    });
  });
});

describe("diff — per-table index/FK", () => {
  test("expected index not in actual → add-index", async () => {
    const tableE = { name: "users", columns: [col("id", "integer"), col("email")], indexes: [{ name: "users_email_idx", columns: ["email"], unique: true }], foreignKeys: [], primaryKey: ["id"], checks: [] };
    const tableA = { name: "users", columns: [col("id", "integer"), col("email")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes.find((x) => x.kind === "add-index")).toMatchObject({
      kind: "add-index", table: "users", index: { name: "users_email_idx", columns: ["email"], unique: true },
    });
  });

  test("actual FK not in expected → drop-fk", async () => {
    const tableE = { name: "weeks", columns: [col("id", "integer"), col("program_id", "integer")], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] };
    const tableA = { name: "weeks", columns: [col("id", "integer"), col("program_id", "integer")], indexes: [], foreignKeys: [{ name: "weeks_program_id_fk", columns: ["program_id"], refTable: "programs", refColumns: ["id"] }], primaryKey: ["id"], checks: [] };
    const r = await diff(snapshot([tableE]), snapshot([tableA]));
    expect(r.changes.find((x) => x.kind === "drop-fk")).toMatchObject({
      kind: "drop-fk", table: "weeks", fk: "weeks_program_id_fk",
    });
  });
});

describe("diff — view-body drift", () => {
  function withViews(views: SchemaSnapshot["views"]): SchemaSnapshot {
    return { tables: [], views };
  }

  test("same-named view, identical body (whitespace-normalized) → no change", async () => {
    // Expected side carries body-only SQL (view body, as buildProjectionViews produces).
    const expected = withViews([{ name: "order_summary", sql: "SELECT id, total FROM orders" }]);
    // Actual side carries the full CREATE VIEW statement (as sqlite_master.sql).
    const actual = withViews([
      { name: "order_summary", sql: "CREATE VIEW order_summary AS SELECT id,   total\nFROM orders" },
    ]);
    const r = await diff(expected, actual);
    expect(r.changes.filter((c) => c.kind.endsWith("-view"))).toEqual([]);
  });

  test("same-named view, DIFFERENT body → replace-view", async () => {
    const expected = withViews([{ name: "order_summary", sql: "SELECT id, total, tax FROM orders" }]);
    const actual = withViews([
      { name: "order_summary", sql: "CREATE VIEW order_summary AS SELECT id, total FROM orders" },
    ]);
    const r = await diff(expected, actual);
    const viewChange = r.changes.find((c) => c.kind === "replace-view");
    expect(viewChange).toMatchObject({ kind: "replace-view", view: { name: "order_summary" } });
    // No spurious create/drop pair when the view exists on both sides.
    expect(r.changes.find((c) => c.kind === "create-view")).toBeUndefined();
    expect(r.changes.find((c) => c.kind === "drop-view")).toBeUndefined();
  });

  test("expected view absent from actual → create-view (unchanged)", async () => {
    const expected = withViews([{ name: "order_summary", sql: "SELECT id FROM orders" }]);
    const r = await diff(expected, { tables: [], views: [] });
    expect(r.changes.find((c) => c.kind === "create-view")).toMatchObject({
      kind: "create-view", view: { name: "order_summary" },
    });
  });
});

// ---------------------------------------------------------------------------
// #239 — the Postgres adopt-view branch (DB view carries no fingerprint) must
// make the SAME legal/illegal OR-REPLACE decision the managed path makes.
// A structural change (rename / reorder / mid-insert / retype) is NOT a legal
// CREATE OR REPLACE, so it must be emitted as drop-view + create-view — and the
// adoption of an unmanaged view still requires allow.adoptView (the recreate-pair
// auto-allow must not wave through clobbering hand-written SQL).
//
// Whether the replace is legal is asked of the database (view-replace.ts). Here the
// probe is a stub that reports the columns Postgres would: the planner's decision is
// the unit under test.
// ---------------------------------------------------------------------------
describe("diff — Postgres adopt-view legality (#239)", () => {
  // A view metadata (expected) side always carries a fingerprint.
  const expView = (cols: string[]) => ({
    name: "v_foo",
    sql: `SELECT ${cols.map((c) => `t.${c} AS ${c}`).join(", ")} FROM t`,
    fingerprint: "a".repeat(64), // raw sha256-hex; renderFingerprintMarker adds the prefix
  });
  // The DB (actual) side has NO fingerprint — pre-fingerprint or hand-written.
  const dbView = (cols: string[]) => ({
    name: "v_foo",
    sql: `SELECT ${cols.map((c) => `t.${c} AS ${c}`).join(", ")} FROM t`,
  });
  const text = (names: string[]) => names.map((name) => ({ name, type: "text", collation: "100" }));
  /** What Postgres reports: the expected definition's columns and the live view's. */
  const probing = (expected: string[], live: string[]): ViewReplaceProbe =>
    async () => ({ expected: text(expected), live: text(live) });
  const opts = (viewReplaceProbe: ViewReplaceProbe | undefined, adoptView = true) => ({
    dialect: "postgres" as const,
    allow: { adoptView },
    ...(viewReplaceProbe !== undefined ? { viewReplaceProbe } : {}),
  });

  test("STRUCTURAL change (renamed output column) → drop-view + create-view, NOT replace-view", async () => {
    // DB view outputs (a, b); metadata renames b→c → columns (a, c). Postgres cannot
    // OR-REPLACE a column rename ("cannot change name of view column").
    const r = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(probing(["a", "c"], ["a", "b"])),
    );
    expect(r.changes.find((c) => c.kind === "replace-view")).toBeUndefined();
    expect(r.changes.find((c) => c.kind === "drop-view")).toMatchObject({ kind: "drop-view", view: "v_foo" });
    expect(r.changes.find((c) => c.kind === "create-view")).toMatchObject({
      kind: "create-view", view: { name: "v_foo" },
    });
  });

  test("adopting an unmanaged view via drop+create STILL requires allow.adoptView", async () => {
    // Without allow.adoptView the drop must be BLOCKED — the recreate-pair auto-allow
    // must not silently clobber the (possibly hand-written) unmanaged view.
    const probe = probing(["a", "c"], ["a", "b"]);
    const r = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(probe, false),
    );
    const dropv = r.changes.find((c) => c.kind === "drop-view");
    expect(dropv?.status.state).toBe("blocked");
    // With allow.adoptView → allowed.
    const r2 = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(probe),
    );
    expect(r2.changes.find((c) => c.kind === "drop-view")?.status.state).toBe("allowed");
  });

  test("PURE APPEND (live columns are a prefix) is a legal replace-view (unmanagedActual), gated on adoptView", async () => {
    // DB (a, b); metadata (a, b, c) — c appended. Undoing it removes a column, which a
    // replace cannot do, so the change is not restorable in place.
    const probe = probing(["a", "b", "c"], ["a", "b"]);
    const r = await diff(
      { tables: [], views: [expView(["a", "b", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(probe),
    );
    expect(r.changes.map((c) => c.kind)).toEqual(["replace-view"]);
    expect(r.changes[0]).toMatchObject({
      view: { name: "v_foo" }, unmanagedActual: true, proven: { restorable: false },
    });
    const blocked = await diff(
      { tables: [], views: [expView(["a", "b", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(probe, false),
    );
    expect(blocked.blocked.map((c) => c.kind)).toEqual(["replace-view"]);
  });

  test("#240 offline adopt: no database to ask → drop+create, still gated on adoptView", async () => {
    // An offline plan diffs against the committed snapshot. Nothing can prove the replace,
    // so it is never planned, even for columns that look like a pure append.
    const r = await diff(
      { tables: [], views: [expView(["a", "b", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(undefined),
    );
    expect(r.changes.map((c) => c.kind)).toEqual(["drop-view", "create-view"]);
    const rBlocked = await diff(
      { tables: [], views: [expView(["a", "b", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(undefined, false),
    );
    expect(rBlocked.changes.find((c) => c.kind === "drop-view")?.status.state).toBe("blocked");
  });

  test("OPAQUE @sql body: replaced in place when the database proves it, dropped and created when nothing can", async () => {
    // A hand-written @sql body is never parsed, but Postgres can still say what columns
    // it produces. Re-stamping an identical pre-fingerprint view (#208) is the common case.
    const opaque = { name: "v_foo", sql: "SELECT t.a AS a, t.b AS b FROM t", fingerprint: "b".repeat(64) };
    const proven = await diff(
      { tables: [], views: [opaque] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(probing(["a", "b"], ["a", "b"])),
    );
    expect(proven.changes.map((c) => c.kind)).toEqual(["replace-view"]);
    expect(proven.changes[0]).toMatchObject({ unmanagedActual: true, proven: { restorable: true } });

    const unproven = await diff(
      { tables: [], views: [opaque] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(undefined),
    );
    expect(unproven.changes.map((c) => c.kind)).toEqual(["drop-view", "create-view"]);
  });

  test("emitted up.sql for a structural adoption is DROP+CREATE (no illegal CREATE OR REPLACE)", async () => {
    // The bug's symptom: `CREATE OR REPLACE VIEW` for a rename fails at apply on a DB
    // that already holds the prior view. The fix emits DROP VIEW + CREATE VIEW + a
    // fingerprint COMMENT (so the next migrate converges).
    const r = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(probing(["a", "c"], ["a", "b"])),
    );
    const up = emit(r.changes, { dialect: "postgres" }).up;
    expect(up).not.toMatch(/CREATE OR REPLACE VIEW/i);
    expect(up).toMatch(/DROP VIEW/i);
    expect(up).toMatch(/CREATE VIEW/i);
    expect(up).toMatch(/COMMENT ON VIEW .* IS 'metaobjects:/i);
  });
});

// A type change carries its column's default change. Beside a separate
// change-column-default, the down ran FIRST and set the old default on a column
// still holding the new type.
describe("diff — a type change carries its column's default", () => {
  const TABLE = { indexes: [], foreignKeys: [], primaryKey: [], checks: [] };

  test("the default change rides on the type change, not beside it", async () => {
    const e = { name: "users", ...TABLE, columns: [{ ...col("status"), sqlType: { kind: "integer" as const, bits: 32 as const }, default: { kind: "literal" as const, value: "5" } }] };
    const a = { name: "users", ...TABLE, columns: [{ ...col("status", "text"), default: { kind: "literal" as const, value: "PUBLISHED" } }] };
    const r = await diff(snapshot([e]), snapshot([a]));
    expect(r.changes.find((x) => x.kind === "change-column-default")).toBeUndefined();
    expect(r.changes.find((x) => x.kind === "change-column-type")).toMatchObject({
      fromDefault: { kind: "literal", value: "PUBLISHED" }, toDefault: { kind: "literal", value: "5" },
    });
  });

  test("a uuid identity's default, which the diff never compares, is KEPT through a type change", async () => {
    const live = { kind: "expr" as const, value: "gen_random_uuid()" };
    const e = { name: "users", ...TABLE, columns: [{ ...col("id"), sqlType: { kind: "uuid" as const }, identity: "uuid" as const }] };
    const a = { name: "users", ...TABLE, columns: [{ ...col("id", "text"), default: live }] };
    const r = await diff(snapshot([e]), snapshot([a]));
    expect(r.changes.find((x) => x.kind === "change-column-type")).toMatchObject({ fromDefault: live, toDefault: live });
  });

  test("dropping a live auto-sequence default is still refused when it rides on a type change", async () => {
    const e = { name: "users", ...TABLE, columns: [{ ...col("id"), sqlType: { kind: "integer" as const, bits: 64 as const } }] };
    const a = { name: "users", ...TABLE, columns: [{ ...col("id"), sqlType: { kind: "integer" as const, bits: 32 as const }, default: { kind: "expr" as const, value: "nextval('users_id_seq'::regclass)" } }] };
    const blocked = await diff(snapshot([e]), snapshot([a]));
    expect(blocked.changes.find((x) => x.kind === "change-column-type")?.status.state).toBe("blocked");
    const allowed = await diff(snapshot([e]), snapshot([a]), { allow: { dropIdentityDefault: true } });
    expect(allowed.changes.find((x) => x.kind === "change-column-type")?.status.state).toBe("allowed");
  });
});
