/**
 * A declared column rename carries the constraints named after that column.
 *
 * CHECK and FK constraint names are DERIVED from the physical column
 * (`<table>_<col>_numeric_chk`, `<table>_<col>_fk`), so renaming a constrained column
 * renames its constraints too. The diff saw that as drop-check + add-check (and
 * drop-fk + add-fk) beside the rename-column, and refused the drop as destructive —
 * `meta migrate --rename-column reviews.rating=stars` failed with a JSON dump and asked
 * for `--allow drop-check`, although nothing is being dropped: the constraint is the same
 * rule over the same data under the column's new name.
 *
 * A declared rename now carries them without an `--allow`: on Postgres the pair folds
 * into the rename-column as `RENAME CONSTRAINT` (PG rewrites the constraint body itself
 * when the column is renamed); on SQLite the pair stays and the table rebuild writes the
 * constraint under its new name while copying rating → stars. Real engines: the rows
 * survive, the constraint still bites, and the re-diff is empty (idempotence).
 *
 * The PG half skips when MIGRATE_TS_PG_URL is not set, like every PG test here.
 */

import { test, expect, beforeAll, afterAll, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { splitSqlStatements } from "../../src/sql/split-statements.js";
import type { Dialect, SchemaSnapshot } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const BOOKS = "rc_books";
const REVIEWS = "rc_reviews";

/** `ratingColumn` / `bookColumn` are the physical names; the field names never change. */
function model(ratingColumn: string, bookColumn: string): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Book",
            children: [
              { "source.rdb": { "@table": BOOKS } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Review",
            children: [
              { "source.rdb": { "@table": REVIEWS } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "bookId", "@column": bookColumn, "@required": true } },
              {
                "field.int": {
                  name: "rating", "@column": ratingColumn, "@required": true,
                  children: [{ "validator.numeric": { name: "range", "@min": 1, "@max": 5 } }],
                },
              },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              { "identity.reference": { name: "bookRef", "@fields": ["bookId"], "@references": "Book" } },
            ],
          },
        },
      ],
    },
  });
}

async function expectedFor(dialect: Dialect, ratingColumn: string, bookColumn = "book_id"): Promise<SchemaSnapshot> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(model(ratingColumn, bookColumn))]);
  expect(loaded.errors).toEqual([]);
  return buildExpectedSchema(loaded.root, { dialect });
}

const RENAME_RATING = { kind: "column", table: REVIEWS, from: "rating", to: "stars" } as const;
const RENAME_BOOK = { kind: "column", table: REVIEWS, from: "book_id", to: "book_ref" } as const;

describe("a declared column rename carries its CHECK and FK (SQLite)", () => {
  let tmpDir: string;
  let k: Kysely<Record<string, unknown>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-rename-carries-"));
    k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "t.db")}` }) });
  });
  afterEach(async () => {
    await k.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const apply = async (text: string): Promise<void> => {
    for (const stmt of splitSqlStatements(text)) await sql.raw(stmt).execute(k);
  };
  const migrate = async (expected: SchemaSnapshot, renames: readonly (typeof RENAME_RATING | typeof RENAME_BOOK)[] = []) => {
    const actual = await introspectSqlite(k);
    const d = await diff({ expected, actual, dialect: "sqlite", renames });
    const { up } = emit(d.changes, {
      dialect: "sqlite", expectedSchema: expected,
      ...(actual.meta !== undefined && { actualMeta: actual.meta }),
    });
    return { d, up };
  };

  test("no --allow needed; rows survive; the CHECK still bites; re-diff is empty", async () => {
    const first = await migrate(await expectedFor("sqlite", "rating"));
    await apply(first.up);
    await sql.raw(`INSERT INTO ${BOOKS} (id) VALUES (1)`).execute(k);
    await sql.raw(`INSERT INTO ${REVIEWS} (id, book_id, rating) VALUES (1, 1, 4), (2, 1, 2)`).execute(k);

    const target = await expectedFor("sqlite", "stars", "book_ref");
    const { d, up } = await migrate(target, [RENAME_RATING, RENAME_BOOK]);
    expect(d.blocked).toEqual([]);
    expect(d.hazards).toEqual([]);
    await apply(up);

    const rows = await sql.raw<{ id: number; book_ref: number; stars: number }>(
      `SELECT id, book_ref, stars FROM ${REVIEWS} ORDER BY id`).execute(k);
    expect(rows.rows).toEqual([{ id: 1, book_ref: 1, stars: 4 }, { id: 2, book_ref: 1, stars: 2 }]);
    await expect(sql.raw(`INSERT INTO ${REVIEWS} (id, book_ref, stars) VALUES (3, 1, 9)`).execute(k))
      .rejects.toThrow(/CHECK/i);

    const again = await diff({ expected: target, actual: await introspectSqlite(k), dialect: "sqlite" });
    expect(again.changes).toEqual([]);
  });
});

describe("a declared column rename carries its CHECK and FK (PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;
  const drop = async (): Promise<void> => {
    await sql.raw(`DROP TABLE IF EXISTS ${REVIEWS} CASCADE`).execute(kysely);
    await sql.raw(`DROP TABLE IF EXISTS ${BOOKS} CASCADE`).execute(kysely);
  };
  const apply = async (text: string): Promise<void> => {
    for (const stmt of splitSqlStatements(text)) await sql.raw(stmt).execute(kysely);
  };
  const actual = async (): Promise<SchemaSnapshot> => {
    const s = await introspectPostgres(kysely);
    return { ...s, tables: s.tables.filter((t) => t.name === BOOKS || t.name === REVIEWS), views: [] };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await drop();
  });
  afterAll(async () => {
    await drop();
    await pool.end();
  });

  test("RENAME COLUMN + RENAME CONSTRAINT: no --allow, rows survive, CHECK bites, re-diff empty, down restores", async () => {
    await drop();
    const create = await diff({ expected: await expectedFor("postgres", "rating"), actual: await actual(), dialect: "postgres" });
    await apply(emit(create.changes, { dialect: "postgres" }).up);
    await sql.raw(`INSERT INTO ${BOOKS} (id) VALUES (1)`).execute(kysely);
    await sql.raw(`INSERT INTO ${REVIEWS} (id, book_id, rating) VALUES (1, 1, 4), (2, 1, 2)`).execute(kysely);
    const before = await actual();

    const target = await expectedFor("postgres", "stars", "book_ref");
    const r = await diff({ expected: target, actual: before, dialect: "postgres", renames: [RENAME_RATING, RENAME_BOOK] });
    expect(r.blocked).toEqual([]);
    expect(r.hazards).toEqual([]);
    expect(r.changes.map((c) => c.kind)).toEqual(["rename-column", "rename-column"]);
    const { up, down } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`RENAME CONSTRAINT "${REVIEWS}_rating_numeric_chk" TO "${REVIEWS}_stars_numeric_chk"`);
    expect(up).toContain(`RENAME CONSTRAINT "${REVIEWS}_book_id_fk" TO "${REVIEWS}_book_ref_fk"`);
    await apply(up);

    const rows = await sql.raw<{ id: string; book_ref: string; stars: number }>(
      `SELECT id, book_ref, stars FROM ${REVIEWS} ORDER BY id`).execute(kysely);
    expect(rows.rows.map((x) => [Number(x.id), Number(x.book_ref), x.stars])).toEqual([[1, 1, 4], [2, 1, 2]]);
    await expect(sql.raw(`INSERT INTO ${REVIEWS} (id, book_ref, stars) VALUES (3, 1, 9)`).execute(kysely))
      .rejects.toThrow(/stars_numeric_chk/);
    expect((await diff({ expected: target, actual: await actual(), dialect: "postgres" })).changes).toEqual([]);

    // The down is the exact mirror: back to the pre-rename schema, which re-diffs empty too.
    await apply(down);
    expect((await diff({ expected: await expectedFor("postgres", "rating"), actual: await actual(), dialect: "postgres" })).changes)
      .toEqual([]);
  });
});
