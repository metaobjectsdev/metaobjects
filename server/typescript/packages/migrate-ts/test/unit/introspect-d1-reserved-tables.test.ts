/**
 * D1 introspection must exclude Cloudflare/wrangler infrastructure tables.
 *
 * Two tables slip past the existing `sqlite_%` / `__new_%` exclusions:
 *
 *  - `_cf_METADATA` — Cloudflare/miniflare bookkeeping. It springs into existence
 *    the moment ANY write touches a local D1, and D1's authorizer then denies even
 *    a bare `pragma_table_info` against it (SQLITE_AUTH). Because `readTableInfo`
 *    runs once per enumerated table, having it in the list is FATAL — it aborts
 *    every second-and-later `meta migrate --dialect d1` in a project's life (the
 *    first migration is the very write that creates it).
 *
 *  - `d1_migrations` — wrangler's own migration-tracking table. Queryable, so it
 *    doesn't crash; instead it reads as an undeclared "extra" table and the diff
 *    happily proposes `DROP TABLE "d1_migrations"` — deleting wrangler's bookkeeping.
 *
 * Reported by a downstream consumer against 0.15.20.
 */
import { test, expect, describe } from "bun:test";
import { introspectD1, type D1Runner } from "../../src/introspect/d1.js";

/** Names a real D1 would hold once wrangler has applied any migration. */
const LIVE_TABLES = ["_cf_METADATA", "d1_migrations", "members"];

/**
 * A runner that behaves like the real thing: it evaluates the `NOT LIKE 'x%'` /
 * `!= 'y'` predicates actually present in the sqlite_master query, and — like D1's
 * authorizer — THROWS SQLITE_AUTH if anything tries to read `_cf_METADATA`.
 * So this test fails loudly on the unfixed code rather than relying on a mock that
 * quietly ignores the WHERE clause.
 */
function d1Like(seen: string[]): D1Runner {
  return async (command: string) => {
    seen.push(command);
    if (command.includes("_cf_METADATA")) {
      throw new Error('not authorized: SQLITE_AUTH');
    }
    if (command.includes("sqlite_master")) {
      const notLike = [...command.matchAll(/name NOT LIKE '([^']+)'/g)].map((m) => m[1]!);
      const notEq = [...command.matchAll(/name != '([^']+)'/g)].map((m) => m[1]!);
      // Honour ESCAPE '\\': a backslash-escaped `_` is a LITERAL underscore, a bare `_`
      // is a single-char wildcard. Simulating this is the whole point — a mock that
      // ignores it would hide the very bug the escaping fixes.
      const toRegex = (pat: string): RegExp => {
        let out = "";
        for (let i = 0; i < pat.length; i++) {
          const ch = pat[i]!;
          if (ch === "\\") { out += pat[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
          if (ch === "%") { out += ".*"; continue; }
          if (ch === "_") { out += "."; continue; }
          out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        return new RegExp(`^${out}$`);
      };
      const rows = LIVE_TABLES.filter((n) => {
        if (notEq.includes(n)) return false;
        return !notLike.some((p) => toRegex(p).test(n));
      }).map((name) => ({ name, sql: `CREATE TABLE "${name}" (id TEXT)` }));
      return JSON.stringify([{ success: true, results: rows, meta: {} }]);
    }
    if (command.includes("pragma_table_info")) {
      return JSON.stringify([{ success: true, meta: {}, results: [
        { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      ] }]);
    }
    return JSON.stringify([{ success: true, results: [], meta: {} }]);
  };
}

describe("introspectD1 — Cloudflare/wrangler reserved tables", () => {
  test("does not crash on a D1 that already holds _cf_METADATA (SQLITE_AUTH)", async () => {
    const seen: string[] = [];
    // Unfixed, this rejects with `failed to introspect D1: not authorized: SQLITE_AUTH`.
    const snapshot = await introspectD1({ runner: d1Like(seen), binding: "DB", remote: false, configPath: undefined });
    expect(snapshot.tables.map((t) => t.name)).not.toContain("_cf_METADATA");
  });

  test("never enumerates wrangler's d1_migrations (else the diff proposes dropping it)", async () => {
    const snapshot = await introspectD1({ runner: d1Like([]), binding: "DB", remote: false, configPath: undefined });
    expect(snapshot.tables.map((t) => t.name)).not.toContain("d1_migrations");
  });

  test("still returns the project's real tables", async () => {
    const snapshot = await introspectD1({ runner: d1Like([]), binding: "DB", remote: false, configPath: undefined });
    expect(snapshot.tables.map((t) => t.name)).toEqual(["members"]);
  });

  test("the exclusions live in the sqlite_master query itself (never fetched, not filtered after)", async () => {
    const seen: string[] = [];
    await introspectD1({ runner: d1Like(seen), binding: "DB", remote: false, configPath: undefined });
    const q = seen.find((c) => c.includes("sqlite_master"))!;
    // `_` is a LIKE wildcard, so the prefixes must be ESCAPE-d (an unescaped
    // '__new_%' would also swallow a real table named "renewals").
    expect(q).toContain("\\_cf\\_%");
    expect(q).toContain("d1_migrations");
    expect(q).toContain("sqlite\\_%");
    expect(q).toContain("\\_\\_new\\_%");
    expect(q).toContain("ESCAPE");
  });
});
