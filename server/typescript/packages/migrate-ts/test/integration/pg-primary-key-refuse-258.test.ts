/**
 * Real-Postgres gate for #258 — "adopting a database whose PRIMARY KEY differs
 * from the metadata identity."
 *
 * Root cause: the diff/emit has no primary-key change kind, so a table whose live
 * PK moved (e.g. live `PRIMARY KEY (user_id)`, metadata identity `id`) degrades
 * silently into an add-column `id` + drop-column `user_id`: the old PK column (and
 * its constraint) is dropped, the new column is never made PK, and the table is left
 * with NO primary key — so every foreign key that references it is rejected at apply
 * ("there is no unique constraint matching given keys for referenced table …").
 *
 * The fix is DETECT-AND-REFUSE: migration generation compares the introspected PK to
 * the metadata identity and throws PrimaryKeyChangeError instead of emitting the
 * un-appliable SQL. This test proves the refusal fires against the REAL introspected
 * schema (a unit assertion on hand-built snapshots is not sufficient evidence that
 * introspection reads the live PK correctly) — and that WITHOUT the guard the diff
 * still produces the silent add/drop pair, so the guard is what closes the gap.
 *
 * Gated on MIGRATE_TS_PG_URL like every other pg integration test here; skips cleanly
 * when unset.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { PrimaryKeyChangeError } from "../../src/errors.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const realDescribe = PG_URL ? describe : describe.skip;

// Metadata: user_profiles keyed on `id` (uuid). The LIVE table (raw SQL below) is
// instead keyed on `user_id` — the PK MOVE the bug is about.
const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "UserProfile",
          children: [
            { "source.rdb": { "@table": "user_profiles" } },
            { "field.uuid": { name: "id" } },
            { "field.string": { name: "authUserId", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

let k: Kysely<Record<string, unknown>>;
let pool: Pool;

if (PG_URL) {
  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL });
    k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
  });
  afterAll(async () => {
    await cleanup();
    await k.destroy();
  });
}

async function cleanup(): Promise<void> {
  await sql.raw(`DROP TABLE IF EXISTS "agent_configs" CASCADE`).execute(k);
  await sql.raw(`DROP TABLE IF EXISTS "user_profiles" CASCADE`).execute(k);
}

async function loadRoot(json: string) {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

realDescribe("PG #258 — a live primary-key move is refused, not silently dropped", () => {
  test("adopting a DB whose PRIMARY KEY differs from the metadata identity refuses instead of losing the PK", async () => {
    await cleanup();

    // LIVE schema: user_profiles keyed on user_id, with a second table whose FK
    // references it — the exact shape where a silent PK drop breaks the FK at apply.
    await sql
      .raw(`CREATE TABLE "user_profiles" ("user_id" bigint PRIMARY KEY, "auth_user_id" text NOT NULL)`)
      .execute(k);
    await sql
      .raw(
        `CREATE TABLE "agent_configs" ("id" bigint PRIMARY KEY, ` +
          `"created_by" bigint NOT NULL REFERENCES "user_profiles" ("user_id"))`,
      )
      .execute(k);

    const root = await loadRoot(META);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const actual = await introspectPostgres(k);

    // Introspection read the live PK as user_id (the premise of the whole bug).
    const liveUP = actual.tables.find((t) => t.name === "user_profiles");
    expect(liveUP?.primaryKey).toEqual(["user_id"]);

    // WITHOUT the guard: the diff silently degrades into add-column id + drop-column
    // user_id — the PK is dropped and never re-added (the un-appliable migration).
    const unsafe = await diff({ expected, actual, dialect: "postgres", allow: { dropColumn: true } });
    expect(unsafe.changes.some((c) => c.kind === "add-column" && c.column.name === "id")).toBe(true);
    expect(unsafe.changes.some((c) => c.kind === "drop-column" && c.column === "user_id")).toBe(true);

    // WITH the guard (migration generation): refuse loudly, so no bad SQL is emitted.
    let refused: unknown;
    try {
      await diff({ expected, actual, dialect: "postgres", refusePrimaryKeyChange: true, allow: { dropColumn: true } });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(PrimaryKeyChangeError);
    const err = refused as PrimaryKeyChangeError;
    expect(err.table).toBe("user_profiles");
    expect(err.livePrimaryKey).toEqual(["user_id"]);
    expect(err.expectedPrimaryKey).toEqual(["id"]);
  });
});
