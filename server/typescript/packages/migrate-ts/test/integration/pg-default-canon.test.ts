/**
 * Column DEFAULTs: Postgres, not a regex classifier, decides whether the expected default is
 * the stored one.
 *
 * Postgres re-spells a default at parse analysis (`NOW()` → `now()`, `current_date` →
 * `CURRENT_DATE`, a date literal on a timestamptz → `'2024-01-01 00:00:00+00'::timestamp with
 * time zone`, `'1e3'` on a double → `'1000'::double precision`, `'007'` on an integer → `7`),
 * so comparing the author's text with the live text reported all of them as drift forever.
 * The oracle is the live engine: a table is created from SQL, the expected side is the same
 * table with the author's spelling, and the pair is diffed with and without the probe.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { postgresExprCanonProbe } from "../../src/expr-canon-probe.js";
import { adoptGeneratedSpelling } from "../../src/snapshot/adopt-generated-spelling.js";
import type { ColumnDefault, SchemaSnapshot } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const TABLE = "default_canon_t";

type Db = Kysely<Record<string, unknown>>;

/** The author's spelling of each default, by column: what the model declares. */
const AUTHORED: Record<string, ColumnDefault> = {
  b: { kind: "expr", value: "NOW()" },
  c: { kind: "expr", value: "current_date" },
  d: { kind: "literal", value: "2024-01-01" },
  i: { kind: "literal", value: "1e3" },
  j: { kind: "literal", value: "007" },
  k: { kind: "expr", value: "now() + interval '1 day'" },
};

describe("column DEFAULT canon (live PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  const connect = (options?: string): { pool: Pool; db: Db } => {
    const pool = new Pool({ connectionString: PG_URL, ...(options !== undefined ? { options } : {}) });
    return { pool, db: new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) }) };
  };
  let pool: Pool;
  let db: Db;

  const create = (q: Db): Promise<unknown> =>
    sql.raw(`
      DROP TABLE IF EXISTS ${TABLE};
      CREATE TABLE ${TABLE} (
        id bigserial PRIMARY KEY,
        b timestamptz DEFAULT NOW(), c date DEFAULT current_date, d timestamptz DEFAULT '2024-01-01',
        i double precision DEFAULT '1e3', j integer DEFAULT '007', k timestamptz DEFAULT now() + interval '1 day',
        s text DEFAULT 'a'
      )`).execute(q);

  beforeAll(async () => {
    ({ pool, db } = connect());
    await create(db);
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await pool.end();
  });

  /** The live schema, and a copy declaring `defaults` (column → default) over the live ones. */
  const declared = async (conn: Db, defaults: Record<string, ColumnDefault>): Promise<{ live: SchemaSnapshot; expected: SchemaSnapshot }> => {
    const live = await introspectPostgres(conn);
    const expected = structuredClone(live);
    const t = expected.tables.find((x) => x.name === TABLE)!;
    for (const [col, d] of Object.entries(defaults)) t.columns.find((c) => c.name === col)!.default = d;
    return { live, expected };
  };
  const defaultChanges = async (conn: Db, defaults: Record<string, ColumnDefault>, probe: boolean) => {
    const { live, expected } = await declared(conn, defaults);
    const d = await diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      ...(probe ? { exprCanonProbe: postgresExprCanonProbe(conn) } : {}),
    });
    return d.changes.filter((c) => c.kind === "change-column-default").map((c) => (c as { column: string }).column).sort();
  };

  test("the string classifier reports every re-spelled default as drift (the defect)", async () => {
    expect(await defaultChanges(db, AUTHORED, false)).toEqual(["b", "c", "d", "i", "j", "k"]);
  });

  test("with the probe, NOW(), current_date, a date literal, 1e3, 007 and a composite expression read clean", async () => {
    expect(await defaultChanges(db, AUTHORED, true)).toEqual([]);
  });

  test("a real default change is still reported", async () => {
    const changed: Record<string, ColumnDefault> = {
      ...AUTHORED,
      s: { kind: "literal", value: "b" },
      j: { kind: "literal", value: "008" },
      i: { kind: "literal", value: "1001" },
      d: { kind: "literal", value: "2024-01-02" },
      k: { kind: "expr", value: "now() + interval '2 days'" },
      b: { kind: "expr", value: "clock_timestamp()" },
    };
    expect(await defaultChanges(db, changed, true)).toEqual(["b", "d", "i", "j", "k", "s"]);
  });

  test("an expression that does not compile against the table keeps the classifier's answer", async () => {
    expect(await defaultChanges(db, { s: { kind: "expr", value: "no_such_function(1)" } }, true)).toEqual(["s"]);
  });

  test("the probe leaves nothing behind", async () => {
    await defaultChanges(db, AUTHORED, true);
    const left = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'mo_check_probe' AND relpersistence = 't'`.execute(db);
    expect(left.rows[0]!.n).toBe(0);
  });

  describe("session TimeZone", () => {
    for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
      test(`a timestamptz literal default reads clean when created and read in ${zone}`, async () => {
        const { pool: p, db: conn } = connect(`-c TimeZone=${zone}`);
        try {
          await create(conn);
          expect(await defaultChanges(conn, { d: AUTHORED["d"]! }, true)).toEqual([]);
          // …and a different instant is still a change.
          expect(await defaultChanges(conn, { d: { kind: "literal", value: "2024-01-02" } }, true)).toEqual(["d"]);
        } finally {
          await p.end();
        }
      });
    }
    test("restore the shared table", async () => {
      await create(db);
    });
  });

  test("baseline --from-db records the authored default for one the probe proved equal", async () => {
    const { live, expected } = await declared(db, { ...AUTHORED, s: { kind: "literal", value: "b" } });
    const adopted = await adoptGeneratedSpelling(live, expected, postgresExprCanonProbe(db));
    const cols = adopted.tables.find((t) => t.name === TABLE)!.columns;
    for (const [col, d] of Object.entries(AUTHORED)) expect(cols.find((c) => c.name === col)!.default).toEqual(d);
    // A different default keeps what the database has: recording the authored one would hide it.
    expect(cols.find((c) => c.name === "s")!.default).toEqual({ kind: "literal", value: "a" });

    // The offline plan then compares like with like, and still reports the real change.
    const offline = await diff({ expected, actual: adopted, dialect: "postgres", scopeSchemas: ["public"] });
    expect(offline.changes.filter((c) => c.kind === "change-column-default").map((c) => (c as { column: string }).column)).toEqual(["s"]);
  });
});
