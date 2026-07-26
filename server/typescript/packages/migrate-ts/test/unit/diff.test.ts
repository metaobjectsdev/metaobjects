import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { SchemaSnapshot, ColumnDescriptor } from "../../src/types.js";

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
// A structural change (rename / reorder / mid-insert) is NOT a legal
// CREATE OR REPLACE, so it must be emitted as drop-view + create-view — and the
// adoption of an unmanaged view still requires allow.adoptView (the recreate-pair
// auto-allow must not wave through clobbering hand-written SQL).
// ---------------------------------------------------------------------------
describe("diff — Postgres adopt-view legality (#239)", () => {
  const T = { kind: "text" as const };
  // A view metadata (expected) side always carries a fingerprint.
  const expView = (cols: string[]) => ({
    name: "v_foo",
    sql: `SELECT ${cols.map((c) => `t.${c} AS ${c}`).join(", ")} FROM t`,
    fingerprint: "a".repeat(64), // raw sha256-hex; renderFingerprintMarker adds the prefix
    columns: cols.map((name) => ({ name, sqlType: T })),
  });
  // The DB (actual) side has NO fingerprint — pre-fingerprint or hand-written.
  const dbView = (cols: string[]) => ({
    name: "v_foo",
    sql: `SELECT ${cols.map((c) => `t.${c} AS ${c}`).join(", ")} FROM t`,
    columns: cols.map((name) => ({ name, sqlType: T })),
  });
  const opts = (adoptView = false) => ({ dialect: "postgres" as const, allow: { adoptView } });

  test("STRUCTURAL change (renamed output column) → drop-view + create-view, NOT replace-view", async () => {
    // DB view outputs (a, b); metadata renames b→c → columns (a, c). Postgres cannot
    // OR-REPLACE a column rename ("cannot change name of view column").
    const r = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(true),
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
    const r = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(false),
    );
    const dropv = r.changes.find((c) => c.kind === "drop-view");
    expect(dropv?.status.state).toBe("blocked");
    // With allow.adoptView → allowed.
    const r2 = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(true),
    );
    expect(r2.changes.find((c) => c.kind === "drop-view")?.status.state).toBe("allowed");
  });

  test("PURE APPEND (columns are a prefix) is still a legal replace-view (unmanagedActual)", async () => {
    // DB (a, b); metadata (a, b, c) — c appended. Legal OR-REPLACE → replace-view,
    // still gated on adoptView.
    const r = await diff(
      { tables: [], views: [expView(["a", "b", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(true),
    );
    expect(r.changes.find((c) => c.kind === "replace-view")).toMatchObject({
      kind: "replace-view", view: { name: "v_foo" }, unmanagedActual: true,
    });
    expect(r.changes.find((c) => c.kind === "drop-view")).toBeUndefined();
  });

  test("OPAQUE @sql body (columns unknown) adopts via non-destructive replace-view, not drop+create", async () => {
    // A hand-written @sql view has no parsed columns, so replace legality is unprovable.
    // The common case is re-stamping an identical pre-fingerprint view (#208), which a
    // legal CREATE OR REPLACE handles without cascading — so adoption keeps replace-view.
    const opaque = { name: "v_foo", sql: "SELECT t.a AS a, t.b AS b FROM t", fingerprint: "b".repeat(64) };
    const r = await diff(
      { tables: [], views: [opaque] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(true),
    );
    expect(r.changes.find((c) => c.kind === "replace-view")).toMatchObject({
      kind: "replace-view", view: { name: "v_foo" }, unmanagedActual: true,
    });
    expect(r.changes.find((c) => c.kind === "drop-view")).toBeUndefined();
  });

  test("emitted up.sql for a structural adoption is DROP+CREATE (no illegal CREATE OR REPLACE)", async () => {
    // The bug's symptom: `CREATE OR REPLACE VIEW` for a rename fails at apply on a DB
    // that already holds the prior view. The fix emits DROP VIEW + CREATE VIEW + a
    // fingerprint COMMENT (so the next migrate converges).
    const r = await diff(
      { tables: [], views: [expView(["a", "c"])] },
      { tables: [], views: [dbView(["a", "b"])] },
      opts(true),
    );
    const up = emit(r.changes, { dialect: "postgres" }).up;
    expect(up).not.toMatch(/CREATE OR REPLACE VIEW/i);
    expect(up).toMatch(/DROP VIEW/i);
    expect(up).toMatch(/CREATE VIEW/i);
    expect(up).toMatch(/COMMENT ON VIEW .* IS 'metaobjects:/i);
  });
});
