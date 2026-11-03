/**
 * Real Postgres: a field.duration column is a native INTERVAL. Its table applies, a value in the
 * canonical ISO-8601 form is stored as the span it names, and a second diff proposes nothing —
 * including for a declared @default, which Postgres stores in its own interval spelling.
 *
 * Gated on MIGRATE_TS_PG_URL; skips cleanly when unset.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource, formatPostgresInterval, parseDurationLiteral } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const realDescribe = PG_URL ? describe : describe.skip;
const TABLE = "duration_rt";

const META = JSON.stringify({ "metadata.root": { package: "acme", children: [{ "object.entity": { name: "Timer", children: [
  { "source.rdb": { "@table": TABLE } },
  { "field.long": { name: "id" } },
  { "field.duration": { name: "timeout", "@required": true } },
  { "field.duration": { name: "grace", "@default": "PT1H30M" } },
  { "field.duration": { name: "backoff", isArray: true } },
  { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
] } }] } });

let k: Kysely<Record<string, unknown>>;

if (PG_URL) {
  beforeAll(() => {
    k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL }) }) });
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(k);
    await k.destroy();
  });
}

const ours = (changes: readonly unknown[]) => changes.filter((c) => JSON.stringify(c).includes(TABLE));

realDescribe("field.duration on Postgres", () => {
  test("the table applies as INTERVAL columns and re-diffs empty", async () => {
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(k);
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
    expect(errors.map((e) => e.message)).toEqual([]);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const first = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    const { up } = emit(ours(first.changes) as typeof first.changes, { dialect: "postgres", expectedSchema: expected });
    expect(up).toContain('"timeout" INTERVAL NOT NULL');
    for (const stmt of up.split(";").map((s) => s.trim()).filter(Boolean)) await sql.raw(stmt).execute(k);

    const types = (await sql.raw(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${TABLE}' ORDER BY column_name`,
    ).execute(k)).rows as Array<{ column_name: string; data_type: string }>;
    expect(Object.fromEntries(types.map((r) => [r.column_name, r.data_type]))).toEqual({
      backoff: "ARRAY", grace: "interval", id: "bigint", timeout: "interval",
    });

    const followup = ours((await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" })).changes);
    if (followup.length > 0) for (const c of followup) console.error("  -", JSON.stringify(c));
    expect(followup).toEqual([]);
  });

  test("a value bound in the Postgres spelling is stored as the span it names; the default applies", async () => {
    // Postgres reads a non-negative ISO-8601 duration as interval input but refuses a signed one
    // (`-PT1M30S`), which is why a string is bound in its own spelling (formatPostgresInterval).
    await expect(sql.raw(`SELECT '-PT1M30S'::interval`).execute(k)).rejects.toThrow(/invalid input syntax/);
    const bound = [parseDurationLiteral("PT26H0.5S")!, parseDurationLiteral("PT1S")!, parseDurationLiteral("-PT1M30S")!].map(formatPostgresInterval);
    await sql.raw(`INSERT INTO "${TABLE}" ("timeout", "backoff") VALUES ('${bound[0]}', ARRAY['${bound[1]}','${bound[2]}']::interval[])`).execute(k);
    const row = (await sql.raw(
      `SELECT EXTRACT(EPOCH FROM "timeout")::text AS t, EXTRACT(EPOCH FROM "grace")::text AS g, "backoff"::text AS b FROM "${TABLE}"`,
    ).execute(k)).rows[0] as Record<string, string>;
    expect(Number(row["t"])).toBe(26 * 3600 + 0.5);
    expect(Number(row["g"])).toBe(5400);
    expect(row["b"]).toBe('{00:00:01,-00:01:30}');
    // Read back, each element is exactly the spelling it was bound in.
    const back = (await sql.raw(`SELECT "timeout"::text AS t FROM "${TABLE}"`).execute(k)).rows[0] as Record<string, string>;
    expect(back["t"]).toBe(bound[0]);
  });

  test("an existing interval column modelled as a string, as it had to be before field.duration, is not drift", async () => {
    const legacy = "duration_legacy_rt";
    await sql.raw(`DROP TABLE IF EXISTS "${legacy}" CASCADE`).execute(k);
    await sql.raw(`CREATE TABLE "${legacy}" ("id" bigint PRIMARY KEY, "wait" interval, "waits" interval[])`).execute(k);
    try {
      const doc = JSON.stringify({ "metadata.root": { package: "acme", children: [{ "object.entity": { name: "Legacy", children: [
        { "source.rdb": { "@table": legacy } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "wait" } },
        { "field.string": { name: "waits", isArray: true } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } }] } });
      const { root } = await new MetaDataLoader().load([new InMemoryStringSource(doc)]);
      const expected = buildExpectedSchema(root, { dialect: "postgres" });
      const changes = (await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" })).changes
        .filter((c) => JSON.stringify(c).includes(legacy));
      expect(changes).toEqual([]);
    } finally {
      await sql.raw(`DROP TABLE IF EXISTS "${legacy}" CASCADE`).execute(k);
    }
  });
});
