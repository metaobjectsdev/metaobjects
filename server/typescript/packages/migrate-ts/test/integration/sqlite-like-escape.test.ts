/**
 * `_` is a SINGLE-CHARACTER WILDCARD in SQL `LIKE`. The introspectors' infra-table
 * exclusions were written as if it were a literal:
 *
 *     name NOT LIKE 'sqlite_%'   -- intended: the sqlite_ prefix
 *     name NOT LIKE '__new_%'    -- intended: our recreate-and-copy shadow tables
 *     name NOT LIKE '_cf_%'      -- intended: Cloudflare's _cf_ bookkeeping
 *
 * Verified against real SQLite: `'renewals' LIKE '__new_%'` → 1. So an ordinary entity
 * `Renewal` (table `renewals`) is SILENTLY INVISIBLE to introspection — the diff then
 * proposes `CREATE TABLE renewals` on every run, and the second apply dies with
 * "table renewals already exists". Same for any table with "cf" in positions 2-3
 * (`mcfarland_clients`) under `_cf_%`.
 *
 * The fix is `ESCAPE '\'` with the underscores escaped, so the patterns match only what
 * they were always meant to match.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { introspectSqlite } from "../../src/introspect/sqlite.js";

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-like-escape-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "t.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sqlite introspection — infra-table exclusions must not swallow real tables", () => {
  test("a table named `renewals` is NOT mistaken for a `__new_%` shadow table", async () => {
    await sql.raw(`CREATE TABLE "renewals" (id INTEGER PRIMARY KEY)`).execute(k);
    const snap = await introspectSqlite(k);
    // Unfixed: 'renewals' LIKE '__new_%' is TRUE, so the table vanishes from the snapshot
    // and every migrate re-proposes CREATE TABLE renewals.
    expect(snap.tables.map((t) => t.name)).toContain("renewals");
  });

  test("other innocent names that trip the single-char wildcard are kept", async () => {
    await sql.raw(`CREATE TABLE "renewed_tokens" (id INTEGER PRIMARY KEY)`).execute(k);
    await sql.raw(`CREATE TABLE "sqlite2_stats" (id INTEGER PRIMARY KEY)`).execute(k);
    const names = (await introspectSqlite(k)).tables.map((t) => t.name);
    expect(names).toContain("renewed_tokens");
    expect(names).toContain("sqlite2_stats");
  });

  test("the real shadow tables are STILL excluded", async () => {
    await sql.raw(`CREATE TABLE "__new_photos" (id INTEGER PRIMARY KEY)`).execute(k);
    await sql.raw(`CREATE TABLE "photos" (id INTEGER PRIMARY KEY)`).execute(k);
    const names = (await introspectSqlite(k)).tables.map((t) => t.name);
    expect(names).not.toContain("__new_photos");
    expect(names).toContain("photos");
  });
});
