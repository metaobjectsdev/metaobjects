/**
 * A regex CHECK on a text-family column must not read as drift on Postgres.
 *
 * Postgres stores `"key" ~ '^[a-z0-9][a-z0-9-]*$'` as `(((key)::text ~ '…'::text))`. The
 * oracle is the live engine: create the table from the DDL migrate emits for the authored
 * check, read the constraint back through the real introspector, and diff the authored
 * metadata against it. On a citext column the cast changes the operator (case-sensitive vs
 * citext's case-insensitive `~`), so the same pair must still read as drift.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const PATTERN = "^[a-z0-9][a-z0-9-]*$";

const meta = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Space",
          children: [
            { "source.rdb": { "@table": "spaces" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "key", "@column": "key", children: [{ "validator.regex": { name: "re", "@pattern": PATTERN } }] } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

describe("regex CHECK vs Postgres's stored rewrite (live PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  let pool: Pool;
  let kysely: Kysely<Record<string, unknown>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw("CREATE EXTENSION IF NOT EXISTS citext").execute(kysely);
  });
  afterAll(async () => {
    await sql.raw("DROP TABLE IF EXISTS spaces CASCADE").execute(kysely);
    await pool.end();
  });

  const checkChanges = async (colType: string, authoredCheck = `"key" ~ '${PATTERN}'`) => {
    await sql.raw("DROP TABLE IF EXISTS spaces CASCADE").execute(kysely);
    // The constraint is created from the AUTHORED spelling; PG stores its own rendering.
    await sql
      .raw(`CREATE TABLE spaces (id bigserial PRIMARY KEY, "key" ${colType} NOT NULL,
            CONSTRAINT spaces_key_regex_chk CHECK (${authoredCheck}))`)
      .execute(kysely);
    const actual = await introspectPostgres(kysely);
    const stored = actual.tables.find((t) => t.name === "spaces")?.checks.find((c) => c.name === "spaces_key_regex_chk");
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(meta)]);
    expect(loaded.errors).toEqual([]);
    const d = await diff({ expected: buildExpectedSchema(loaded.root, { dialect: "postgres" }), actual, dialect: "postgres" });
    return { stored: stored?.expression, kinds: d.changes.filter((c) => c.kind.endsWith("-check")).map((c) => c.kind).sort() };
  };

  test.each(["varchar(64)", "text", "char(8)"])("%s column: PG's rewrite is no drift", async (colType) => {
    const r = await checkChanges(colType);
    // The gate is not vacuous: PG really did rewrite the authored text.
    expect(r.stored).toContain("::text");
    expect(r.kinds).toEqual([]);
  });

  test("citext column, uncast check: PG keeps citext's own operator and it is clean", async () => {
    const r = await checkChanges("citext");
    expect(r.stored).toContain("::citext");
    expect(r.kinds).toEqual([]);
  });

  test("citext column: a check stored with an explicit ::text cast is a different (case-sensitive) check, so drift", async () => {
    const r = await checkChanges("citext", `("key")::text ~ '${PATTERN}'`);
    expect(r.kinds).toEqual(["add-check", "drop-check"]);
  });

  // char(n) has its own regex operator (bpcharregexeq), which sees the blank padding that
  // `(col)::text` trims — so an explicit cast is a different check, not Postgres's rewrite.
  // Postgres itself never adds the column cast on a bpchar column.
  test("char(n) column: Postgres stores the uncast check without a column cast", async () => {
    const r = await checkChanges("char(8)");
    expect(r.stored).not.toContain("(key)::text");
    expect(r.kinds).toEqual([]);
  });
  test("char(n) column: a check stored with an explicit ::text cast is drift", async () => {
    const r = await checkChanges("char(8)", `("key")::text ~ '${PATTERN}'`);
    expect(r.stored).toContain("(key)::text");
    expect(r.kinds).toEqual(["add-check", "drop-check"]);
  });

  test("varchar column: a changed pattern still reads as drift", async () => {
    const r = await checkChanges("varchar(64)", `"key" ~ '^[a-z]+$'`);
    expect(r.kinds).toEqual(["add-check", "drop-check"]);
  });
});
