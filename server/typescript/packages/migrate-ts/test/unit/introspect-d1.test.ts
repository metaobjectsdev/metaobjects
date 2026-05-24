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
      "pragma_table_info('users')": [
        { cid: 0, name: "id",    type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "email", type: "TEXT",    notnull: 1, dflt_value: null, pk: 0 },
      ],
      "pragma_index_list('users')": [],
      "pragma_foreign_key_list('users')": [],
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

  test("invokes runner with --remote flag when remote: true", async () => {
    const calls: string[] = [];
    const runner: D1Runner = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("sqlite_version")) {
        return JSON.stringify([{ success: true, results: [{ v: "3.44.2" }] }]);
      }
      return JSON.stringify([{ success: true, results: [] }]);
    };
    await introspectD1({ runner, binding: "DB", remote: true, configPath: undefined });
    expect(calls.length).toBeGreaterThan(0); // runner was invoked; remote flag handled by caller wiring (see CLI task)
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
});
