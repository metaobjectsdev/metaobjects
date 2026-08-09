/**
 * #234 — PG idempotence + value-semantics gate for a @lenient field.inet.
 *
 * A @lenient field.inet is schema-affecting: its column becomes `text` instead of
 * the Postgres-native `inet` type (the native column would reject a not-strictly-
 * valid value at INSERT, defeating the opt-out). This proves the change is correct
 * against a REAL Postgres:
 *
 *   1. IDEMPOTENCE — build expected → diff empty → emit → apply → re-diff MUST be [].
 *      Catches asymmetry between what emit writes for a lenient-inet `text` column
 *      and what introspect reads back (a native `inet` would re-diff as type drift).
 *   2. VALUE SEMANTICS — a not-strictly-valid value ("example.com") INSERTs into the
 *      lenient `text` column and reads back verbatim; the SAME value INSERTed into the
 *      STRICT `inet` column is rejected by Postgres (proving the columns really differ).
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set (ts-slow CI provides a PG sidecar).
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Endpoint",
          children: [
            { "source.rdb": { "@table": "endpoints" } },
            { "field.long": { name: "id" } },
            { "field.inet": { name: "strictIp" } },
            { "field.inet": { name: "lenientIp", "@lenient": true } },
            { "field.uri": { name: "strictUrl" } },
            { "field.uri": { name: "lenientUrl", "@lenient": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function applyRaw(k: Kysely<Record<string, unknown>>, sqlText: string): Promise<void> {
  for (const stmt of sqlText.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(k);
  }
}

describe("#234 — @lenient field.inet PG idempotence + value semantics", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw("DROP TABLE IF EXISTS endpoints CASCADE").execute(kysely);
  });

  afterAll(async () => {
    await sql.raw("DROP TABLE IF EXISTS endpoints CASCADE").execute(kysely);
    await pool.end();
  });

  test("IDEMPOTENCE: strict inet stays `inet`, lenient inet is `text` — apply then re-diff is []", async () => {
    const metadata = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
    const expected = buildExpectedSchema(metadata, { dialect: "postgres" });

    const initial = await diff({ expected, actual: await introspectPostgres(kysely), dialect: "postgres" });
    expect(initial.blocked).toEqual([]);
    const { up } = emit(initial.changes, { dialect: "postgres" });
    await applyRaw(kysely, up);

    // The physical column types the emit produced.
    const colTypes = await sql<{ column_name: string; data_type: string }>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'endpoints' ORDER BY column_name
    `.execute(kysely);
    const byName = new Map(colTypes.rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.get("strict_ip")).toBe("inet");     // native
    expect(byName.get("lenient_ip")).toBe("text");     // #234 degrade
    expect(byName.get("strict_url")).toBe("text");     // no PG uri type
    expect(byName.get("lenient_url")).toBe("text");

    // Idempotence: a second migrate must be a no-op.
    const followup = await diff({ expected, actual: await introspectPostgres(kysely), dialect: "postgres" });
    if (followup.changes.length > 0) {
      console.error("NOT CONVERGED — a second migrate would emit:", JSON.stringify(followup.changes, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });

  test("VALUE SEMANTICS: a not-strictly-valid value stores in the lenient `text` column and is rejected by the strict `inet` column", async () => {
    // The lenient text column accepts a hostname and returns it verbatim.
    await sql.raw(
      "INSERT INTO endpoints (lenient_ip, lenient_url, strict_ip, strict_url) " +
      "VALUES ('example.com', 'not a url', '10.0.0.1', 'https://a.com')",
    ).execute(kysely);
    const read = await sql<{ lenient_ip: string; lenient_url: string }>`
      SELECT lenient_ip, lenient_url FROM endpoints WHERE strict_ip = '10.0.0.1'::inet
    `.execute(kysely);
    expect(read.rows[0]?.lenient_ip).toBe("example.com");
    expect(read.rows[0]?.lenient_url).toBe("not a url");

    // The STRICT inet column rejects the same non-IP value at the DB layer.
    let rejected = false;
    try {
      await sql.raw("INSERT INTO endpoints (strict_ip) VALUES ('example.com')").execute(kysely);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
