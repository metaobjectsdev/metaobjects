/**
 * A `field.string` + `@dbColumnType: jsonb` column moved to `isArray` — the one rung of the
 * authoring skill's jsonb ladder that MIGRATES the column — against a live Postgres.
 *
 * The emitter used to write a bare `ALTER COLUMN … TYPE TEXT[]`, which Postgres refuses
 * ("cannot be cast automatically"), and its down was refused the same way. Every unit
 * assertion on the SQL string passed. So this runs the change through the REAL apply path:
 * `applyPending` executes a migration file in one transaction on one connection, which is
 * what lets the up's `pg_temp` helper be seen by the ALTER that follows it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  applyPending, buildExpectedSchema, diff, emit, introspectPostgres, rollbackTo,
  type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

const V1 = "20260911000000-threads";
const V2 = "20260911000001-threads-to-arrays";

/** v1 holds both lists as open jsonb; v2 declares them as the typed arrays they are. */
function meta(typed: boolean): string {
  const emails = typed
    ? `{ "field.string": { "name": "emails", "isArray": true } }`
    : `{ "field.string": { "name": "emails", "@dbColumnType": "jsonb" } }`;
  const scores = typed
    ? `{ "field.double": { "name": "scores", "isArray": true } }`
    : `{ "field.string": { "name": "scores", "@dbColumnType": "jsonb" } }`;
  return `{
    "metadata.root": {
      "package": "acme",
      "children": [
        { "object.entity": { "name": "Thread", "children": [
          { "source.rdb": {} },
          { "field.long": { "name": "id" } },
          ${emails},
          ${scores},
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } }
      ]
    }
  }`;
}

let runningPg: RunningPg;
let pool: Pool;
let k: Kysely<any>;
let dir: string;

beforeAll(async () => {
  runningPg = await startPostgres();
  pool = new Pool({ connectionString: runningPg.connectionUri });
  k = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
}, 120_000);

afterAll(async () => {
  await k?.destroy();
  await runningPg?.stop();
});

beforeEach(async () => {
  for (const table of ["threads", "orders", "notes"]) {
    await sql.raw(`DROP TABLE IF EXISTS "${table}" CASCADE;`).execute(k);
  }
  await sql.raw(`DROP TABLE IF EXISTS "_metaobjects_migrations" CASCADE;`).execute(k);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "mo-jsonb-to-array-"));
});

async function expectedFor(metaJson: string): Promise<SchemaSnapshot> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
  return buildExpectedSchema(root, { columnNamingStrategy: "literal", dialect: "postgres" });
}

/** Diff → emit → write the migration files → apply them through the real runner. */
async function migrate(id: string, metaJson: string): Promise<SchemaSnapshot> {
  const expected = await expectedFor(metaJson);
  const result = await diff({
    expected, actual: await introspectPostgres(k), dialect: "postgres",
    // drop-check: the @intValueMap switch replaces the enum's string-valued CHECK.
    allow: { typeChange: true, dropCheck: true },
  });
  expect(result.blocked).toEqual([]);
  const { up, down } = emit(result.changes, { dialect: "postgres" });
  mkdirSync(join(dir, id));
  writeFileSync(join(dir, id, "up.sql"), up);
  writeFileSync(join(dir, id, "down.sql"), down);
  await applyPending(k, dir, { dryRun: false, dialect: "postgres" });
  return expected;
}

async function seedV1(): Promise<void> {
  await migrate(V1, meta(false));
  // An element holding brackets and a quote, a SQL NULL, a JSON null, and an empty array:
  // each one is a way a textual jsonb → array conversion would get the data wrong.
  await sql.raw(`
    INSERT INTO "threads" ("emails", "scores") VALUES
      ('["b@x.com", "a[1]@x.com", "q\\"uote"]', '[0.87, 0.5]'),
      (NULL, 'null'),
      ('[]', '[]');
  `).execute(k);
}

async function rows(): Promise<{ emails: unknown; scores: unknown }[]> {
  return (await sql<{ emails: unknown; scores: unknown }>`
    SELECT "emails", "scores" FROM "threads" ORDER BY "id"
  `.execute(k)).rows;
}

async function udt(column: string): Promise<string | undefined> {
  return (await sql<{ udt_name: string }>`
    SELECT udt_name FROM information_schema.columns
    WHERE table_name = 'threads' AND column_name = ${column}
  `.execute(k)).rows[0]?.udt_name;
}

describe("jsonb → native array — real Postgres", () => {
  test("the migration APPLIES, keeps every row's elements in order, and a second migrate converges", async () => {
    await seedV1();
    const expected = await migrate(V2, meta(true));

    expect(await udt("emails")).toBe("_text");
    expect(await udt("scores")).toBe("_float8");
    expect(await rows()).toEqual([
      { emails: ["b@x.com", "a[1]@x.com", 'q"uote'], scores: [0.87, 0.5] },
      { emails: null, scores: null },
      { emails: [], scores: [] },
    ]);

    const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    expect(followup.changes).toEqual([]);
  }, 120_000);

  test("the down migration restores the jsonb arrays (a top-level JSON null comes back as SQL NULL)", async () => {
    await seedV1();
    await migrate(V2, meta(true));
    await rollbackTo(k, dir, V1, { dialect: "postgres" });

    expect(await udt("emails")).toBe("jsonb");
    expect(await udt("scores")).toBe("jsonb");
    expect(await rows()).toEqual([
      { emails: ["b@x.com", "a[1]@x.com", 'q"uote'], scores: [0.87, 0.5] },
      { emails: null, scores: null },
      { emails: [], scores: [] },
    ]);
  }, 120_000);

  test("a row that is not a JSON array fails the migration loudly and leaves the column as it was", async () => {
    await migrate(V1, meta(false));
    await sql.raw(`INSERT INTO "threads" ("emails", "scores") VALUES ('"not-an-array"', '[1]');`).execute(k);

    await expect(migrate(V2, meta(true))).rejects.toThrow(/cannot extract elements from a scalar/);

    expect(await udt("emails")).toBe("jsonb");
    expect(await rows()).toEqual([{ emails: "not-an-array", scores: [1] }]);
  }, 120_000);
});

/** A string-backed enum with a DEFAULT, then the same enum switched to `@intValueMap`. */
function enumMeta(intBacked: boolean): string {
  const map = intBacked ? `, "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 }` : "";
  return `{ "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Order", "children": [
      { "source.rdb": {} },
      { "field.long": { "name": "id" } },
      { "field.enum": { "name": "status", "@required": true, "@default": "PUBLISHED",
        "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"]${map} } },
      { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
    ] } } ] } }`;
}

/** A plain string column, then the same column declared `isArray`. */
function noteMeta(isArray: boolean): string {
  return `{ "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Note", "children": [
      { "source.rdb": {} },
      { "field.long": { "name": "id" } },
      { "field.string": { "name": "tag"${isArray ? `, "isArray": true` : ""} } },
      { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
    ] } } ] } }`;
}

async function tags(): Promise<unknown[]> {
  return (await sql<{ tag: unknown }>`SELECT "tag" FROM "notes" ORDER BY "id"`.execute(k)).rows.map((r) => r.tag);
}

describe("other conversions a type change needs — real Postgres", () => {
  // Postgres converts a DEFAULT by assignment cast and never through USING, so this
  // failed with "default for column cannot be cast automatically" on an EMPTY table.
  // (A POPULATED one still needs the documented manual recast: `status::INTEGER` has
  // no way to know that 'PUBLISHED' is 5.)
  test("a column DEFAULT no longer blocks a converting change", async () => {
    await migrate(V1, enumMeta(false));
    const expected = await migrate(V2, enumMeta(true));

    const col = (await sql<{ udt_name: string; column_default: string }>`
      SELECT udt_name, column_default FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'status'
    `.execute(k)).rows[0];
    expect(col?.udt_name).toBe("int4");
    await sql.raw(`INSERT INTO "orders" DEFAULT VALUES;`).execute(k);
    const rows = (await sql<{ status: number }>`SELECT "status" FROM "orders"`.execute(k)).rows;
    expect(rows).toEqual([{ status: 5 }]);

    const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    expect(followup.changes).toEqual([]);
  }, 120_000);

  // An explicit `::TEXT[]` would PARSE each value as an array literal: '{a,b}' would
  // silently become two elements and 'hello' would fail as malformed.
  test("a plain string moved to isArray becomes each row's one element, and the down takes it back out", async () => {
    await migrate(V1, noteMeta(false));
    await sql.raw(`INSERT INTO "notes" ("tag") VALUES ('hello'), ('{a,b}'), (NULL);`).execute(k);
    const expected = await migrate(V2, noteMeta(true));
    expect(await tags()).toEqual([["hello"], ["{a,b}"], null]);
    const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    expect(followup.changes).toEqual([]);

    await rollbackTo(k, dir, V1, { dialect: "postgres" });
    expect(await tags()).toEqual(["hello", "{a,b}", null]);
  }, 120_000);

  // `"tag"[1]` would keep the first element and drop the rest without a word.
  test("removing isArray narrows a one-element row, and an empty or NULL one to NULL", async () => {
    await migrate(V1, noteMeta(true));
    await sql.raw(`INSERT INTO "notes" ("tag") VALUES (ARRAY['solo']), (NULL), ('{}');`).execute(k);
    const expected = await migrate(V2, noteMeta(false));
    expect(await tags()).toEqual(["solo", null, null]);
    const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    expect(followup.changes).toEqual([]);
  }, 120_000);

  test("removing isArray fails loudly on a row holding more than one element, and leaves it", async () => {
    await migrate(V1, noteMeta(true));
    await sql.raw(`INSERT INTO "notes" ("tag") VALUES (ARRAY['a', 'b']);`).execute(k);
    await expect(migrate(V2, noteMeta(false))).rejects.toThrow(/cannot narrow an array of 2 elements/);
    expect(await tags()).toEqual([["a", "b"]]);
  }, 120_000);
});
