import { describe, test, expect } from "bun:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { introspectPostgres } from "../../src/introspect/postgres.js";

const PG_URL = process.env.MIGRATE_TS_PG_URL;
const d = PG_URL ? describe : describe.skip;

d("postgres CHECK introspection (real PG)", () => {
  test("reads a table's CHECK constraints with normalized-comparable expressions", async () => {
    const k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL }) }) });
    try {
      const t = "chk_introspect_" + Math.random().toString(36).slice(2, 8);
      await sql.raw(`CREATE TABLE ${t} ( qty INTEGER NOT NULL, CONSTRAINT ${t}_qty_chk CHECK (qty >= 1 AND qty <= 100) )`).execute(k);
      const snap = await introspectPostgres(k);
      const table = snap.tables.find((x) => x.name === t)!;
      const chk = table.checks.find((c) => c.name === `${t}_qty_chk`);
      expect(chk).toBeDefined();
      // pg_get_constraintdef returns a parenthesized form; assert the expression is captured
      expect(chk!.expression.toLowerCase()).toContain("qty >= 1");
      await sql.raw(`DROP TABLE ${t}`).execute(k);
    } finally { await k.destroy(); }
  });
});
