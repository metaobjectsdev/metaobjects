import { test, expect, describe } from "bun:test";
import { introspectD1, type D1Runner } from "../../src/introspect/d1.js";

/**
 * A mock runner that maps SQL -> canned JSON envelope rows.
 * Wraps each rowset in wrangler's `[{ results: [...], success: true }]` shape.
 */
function mockRunner(table: Record<string, unknown[]>): D1Runner {
  return async (command: string) => {
    for (const [pattern, rows] of Object.entries(table)) {
      if (command.includes(pattern)) {
        return JSON.stringify([{ success: true, results: rows, meta: {} }]);
      }
    }
    return JSON.stringify([{ success: true, results: [], meta: {} }]);
  };
}

describe("introspectD1", () => {
  test("captures sqlite version into snapshot.meta", async () => {
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    expect(snap.meta?.sqliteVersion).toBe("3.44.2");
  });

  test("reads tables and basic columns", async () => {
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
      // Use loose substring match — the implementation builds its own SQL string
      "type='table'": [
        { name: "users", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)" },
      ],
      'pragma_table_info("users")': [
        { cid: 0, name: "id",    type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "email", type: "TEXT",    notnull: 1, dflt_value: null, pk: 0 },
      ],
      'pragma_index_list("users")': [],
      'pragma_foreign_key_list("users")': [],
      "type='view'": [],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    expect(snap.tables).toHaveLength(1);
    expect(snap.tables[0]!.name).toBe("users");
    expect(snap.tables[0]!.columns).toHaveLength(2);
    expect(snap.tables[0]!.columns[0]!.name).toBe("id");
    expect(snap.tables[0]!.primaryKey).toEqual(["id"]);
    expect(snap.tables[0]!.columns[1]!.nullable).toBe(false);
  });

  test("returns empty snapshot when DB has no tables", async () => {
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    expect(snap.tables).toEqual([]);
    expect(snap.views).toEqual([]);
  });

  test("surfaces runner errors with helpful context", async () => {
    const runner: D1Runner = async () => { throw new Error("wrangler not found on PATH"); };
    await expect(introspectD1({ runner, binding: "DB", remote: false, configPath: undefined }))
      .rejects.toThrow(/wrangler not found/);
  });

  test("rejects malformed JSON from runner with helpful error", async () => {
    const runner: D1Runner = async () => "not json";
    await expect(introspectD1({ runner, binding: "DB", remote: false, configPath: undefined }))
      .rejects.toThrow(/failed to parse wrangler JSON output/);
  });

  test("rejects wrangler success:false envelope with the error field", async () => {
    const runner: D1Runner = async () =>
      JSON.stringify([{ success: false, error: "access denied" }]);
    await expect(introspectD1({ runner, binding: "DB", remote: false, configPath: undefined }))
      .rejects.toThrow(/access denied/);
  });

  test("rejects non-array envelope from runner", async () => {
    const runner: D1Runner = async () => JSON.stringify({ success: true, results: [] });
    await expect(introspectD1({ runner, binding: "DB", remote: false, configPath: undefined }))
      .rejects.toThrow(/non-empty array envelope/);
  });

  test("handles table name with single quote safely (no SQL injection)", async () => {
    // A crafted table name containing a single quote — valid as a SQLite identifier
    // via double-quote quoting, but dangerous if interpolated with single-quote wrapping.
    const injectedName = "a' OR 1=1--";
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
      "type='table'": [
        { name: injectedName, sql: `CREATE TABLE "${injectedName}" (id INTEGER)` },
      ],
      // The pragma calls should use double-quoted identifier form, so the mock
      // matches on the double-quoted escaped name in the SQL string.
      ['pragma_table_info("a\' OR 1=1--")']: [
        { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      ],
      ['pragma_index_list("a\' OR 1=1--")']: [],
      ['pragma_foreign_key_list("a\' OR 1=1--")']: [],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    // The table name must be preserved exactly (not interpreted as SQL).
    expect(snap.tables).toHaveLength(1);
    expect(snap.tables[0]!.name).toBe(injectedName);
  });

  test("synthesizes a stable FK name from table + columns; folds multi-column rows by id", async () => {
    // SQLite's pragma_foreign_key_list exposes no constraint NAME, so the
    // introspector synthesizes `<table>_<cols joined by _>_fk`, groups multi-
    // column FKs by `id`, and omits a NO-ACTION referential action.
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
      "type='table'": [
        { name: "posts", sql: "CREATE TABLE posts (org_id INTEGER, slug TEXT)" },
      ],
      'pragma_table_info("posts")': [
        { cid: 0, name: "org_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 1, name: "slug",   type: "TEXT",    notnull: 0, dflt_value: null, pk: 0 },
      ],
      'pragma_index_list("posts")': [],
      // One 2-column FK (org_id, slug) → articles(org_id, slug); two rows, same id.
      'pragma_foreign_key_list("posts")': [
        { id: 0, seq: 0, table: "articles", from: "org_id", to: "org_id", on_delete: "CASCADE", on_update: "NO ACTION" },
        { id: 0, seq: 1, table: "articles", from: "slug",   to: "slug",   on_delete: "CASCADE", on_update: "NO ACTION" },
      ],
      "type='view'": [],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    expect(snap.tables[0]!.foreignKeys).toHaveLength(1);
    const fk = snap.tables[0]!.foreignKeys[0]!;
    expect(fk).toMatchObject({
      name: "posts_org_id_slug_fk",
      columns: ["org_id", "slug"],
      refTable: "articles",
      refColumns: ["org_id", "slug"],
      onDelete: "cascade",
    });
    // NO ACTION on update is the default → omitted, not emitted.
    expect("onUpdate" in fk).toBe(false);
  });
});
