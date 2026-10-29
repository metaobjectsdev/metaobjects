/**
 * A column rename carries the CHECK named after it only when Postgres says the rule is the
 * same. The pairing used to compare the author's text with the live text through the string
 * normaliser, which folds a literal-case change (`'OPEN'` → `'open'`) into a plain
 * RENAME CONSTRAINT, so the stale values survived the migration.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { postgresExprCanonProbe } from "../../src/expr-canon-probe.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const TABLE = "rename_carry_t";

describe("column rename carry (live PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  let pool: Pool;
  let db: Kysely<Record<string, unknown>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw(`
      DROP TABLE IF EXISTS ${TABLE};
      CREATE TABLE ${TABLE} (id bigserial PRIMARY KEY, status text,
        CONSTRAINT ${TABLE}_status_chk CHECK (status IN ('OPEN', 'CLOSED')))`).execute(db);
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await pool.end();
  });

  const run = async (expression: string, probe: boolean) => {
    const live = await introspectPostgres(db);
    const expected = structuredClone(live);
    const t = expected.tables.find((x) => x.name === TABLE)!;
    t.columns.find((c) => c.name === "status")!.name = "state";
    t.checks = [{ name: `${TABLE}_state_chk`, expression }];
    return diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      renames: [{ kind: "column", table: TABLE, from: "status", to: "state" }],
      ...(probe ? { exprCanonProbe: postgresExprCanonProbe(db) } : {}),
    });
  };
  const kinds = (r: Awaited<ReturnType<typeof run>>) => r.changes.map((c) => c.kind).sort();

  test("the same rule under the new column name folds into the rename", async () => {
    const r = await run(`"state" IN ('OPEN', 'CLOSED')`, true);
    expect(kinds(r)).toEqual(["rename-column"]);
    expect((r.changes[0] as { constraintRenames?: unknown }).constraintRenames).toEqual([
      { from: `${TABLE}_status_chk`, to: `${TABLE}_state_chk` },
    ]);
  });

  test("a rename plus a literal-case change is NOT folded: the stale values must be rewritten", async () => {
    const r = await run(`"state" IN ('open', 'closed')`, true);
    expect(kinds(r)).toEqual(["add-check", "drop-check", "rename-column"]);
  });

  test("a rename plus a changed rule is not folded either", async () => {
    const r = await run(`"state" IN ('OPEN')`, true);
    expect(kinds(r)).toEqual(["add-check", "drop-check", "rename-column"]);
  });

  test("the probe compiles an expected expression against the renamed columns", async () => {
    const live = (await introspectPostgres(db)).tables.find((t) => t.name === TABLE)!;
    const check = { name: `${TABLE}_state_chk`, expression: `"state" IN ('OPEN', 'CLOSED')` };
    const probe = postgresExprCanonProbe(db);
    const renames = new Map([["status", "state"]]);
    const answer = await probe(live, { ...live, columns: [], indexes: [], checks: [check] }, renames);
    expect(answer?.checks.get(check)).toBe("(state = ANY (ARRAY['OPEN'::text, 'CLOSED'::text]))");
    // Without the rename the column does not exist yet, so there is no answer for it.
    expect((await probe(live, { ...live, columns: [], indexes: [], checks: [check] }))?.checks.size ?? 0).toBe(0);
  });
});
