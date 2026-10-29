/**
 * The expression-canon probe: Postgres, not a string rewrite, decides whether an expected
 * CHECK / index expression is the one stored.
 *
 * The oracle is the live engine. A table is created from SQL, the expected side is the same
 * table with one expression changed, and the pair is diffed with and without the probe. The
 * string normaliser alone calls a precedence change and a NOT regrouping equal (it deletes
 * every bracket), so those are the cases that only the probe reports.
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
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const TABLE = "canon_probe_t";

type Db = Kysely<Record<string, unknown>>;

describe("expression-canon probe (live PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  let pool: Pool;
  let db: Db;

  const connect = (options?: string): { pool: Pool; db: Db } => {
    const p = new Pool({ connectionString: PG_URL, ...(options !== undefined ? { options } : {}) });
    return { pool: p, db: new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: p }) }) };
  };

  beforeAll(async () => {
    ({ pool, db } = connect());
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(db);
    await sql
      .raw(`CREATE TABLE ${TABLE} (
        id bigserial PRIMARY KEY, a int, b int, c int, status text, code varchar(16),
        CONSTRAINT canon_prec_chk CHECK ((a = 1 OR b = 1) AND c = 1),
        CONSTRAINT canon_not_chk CHECK (NOT (a = 1 AND b = 1)),
        CONSTRAINT canon_status_chk CHECK (status IN ('open')),
        CONSTRAINT canon_code_chk CHECK (code ~ '^[a-z]+$')
      )`)
      .execute(db);
    await sql.raw(`CREATE INDEX canon_where_idx ON ${TABLE} (id) WHERE (a = 1 OR b = 1) AND c = 1`).execute(db);
    await sql.raw(`CREATE INDEX canon_expr_idx ON ${TABLE} (lower(status))`).execute(db);
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(db);
    await pool.end();
  });

  /** The live table, and the same table declared with `checks` / `indexes` overridden. */
  const declared = async (
    over: { checks?: Record<string, string>; indexes?: Record<string, { expr?: string; where?: string }> },
  ): Promise<{ live: SchemaSnapshot; expected: SchemaSnapshot }> => {
    const live = await introspectPostgres(db);
    const want = structuredClone(live);
    const t = want.tables.find((x) => x.name === TABLE)!;
    for (const [name, expression] of Object.entries(over.checks ?? {})) t.checks.find((c) => c.name === name)!.expression = expression;
    for (const [name, parts] of Object.entries(over.indexes ?? {})) Object.assign(t.indexes.find((i) => i.name === name)!, parts);
    return { live, expected: want };
  };
  const kinds = async (over: Parameters<typeof declared>[0], probe: boolean, conn: Db = db): Promise<string[]> => {
    const { live, expected } = await declared(over);
    const d = await diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      ...(probe ? { exprCanonProbe: postgresExprCanonProbe(conn) } : {}),
    });
    return d.changes.map((c) => c.kind).sort();
  };

  describe("the verified false negatives are reported as drift", () => {
    const precedence = { checks: { canon_prec_chk: "a = 1 OR (b = 1 AND c = 1)" } };
    const notGrouping = { checks: { canon_not_chk: "NOT a = 1 AND b = 1" } };
    const literalCase = { checks: { canon_status_chk: "status IN ('OPEN')" } };
    const regexCase = { checks: { canon_code_chk: "code ~ '^[A-Z]+$'" } };

    test("precedence: (a OR b) AND c  vs  a OR (b AND c)", async () => {
      expect(await kinds(precedence, true)).toEqual(["add-check", "drop-check"]);
    });
    test("NOT grouping: NOT (a AND b)  vs  NOT a AND b", async () => {
      expect(await kinds(notGrouping, true)).toEqual(["add-check", "drop-check"]);
    });
    test("literal case: IN ('open')  vs  IN ('OPEN')", async () => {
      expect(await kinds(literalCase, true)).toEqual(["add-check", "drop-check"]);
    });
    test("regex literal case", async () => {
      expect(await kinds(regexCase, true)).toEqual(["add-check", "drop-check"]);
    });
    test("the string normaliser alone still calls precedence and NOT grouping equal (the reason for the probe)", async () => {
      expect(await kinds(precedence, false)).toEqual([]);
      expect(await kinds(notGrouping, false)).toEqual([]);
    });
  });

  describe("what Postgres stores identically is no drift, however it was written", () => {
    test("authored spellings of the stored constraints", async () => {
      expect(await kinds({
        checks: {
          canon_prec_chk: "((a=1) OR (b=1)) AND (c=1)",
          canon_not_chk: "NOT(a=1 AND b=1)",
          canon_status_chk: `"status" = 'open'::text`,
          canon_code_chk: `"code" ~ '^[a-z]+$'`,
        },
      }, true)).toEqual([]);
    });
    test("a one-element IN and an IS NOT DISTINCT FROM, which Postgres rewrites on analysis", async () => {
      await sql.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT canon_nd_chk CHECK ((a IS NOT NULL) = (status IS NOT DISTINCT FROM 'p'))`).execute(db);
      try {
        const live2 = await introspectPostgres(db);
        const want = structuredClone(live2);
        want.tables.find((x) => x.name === TABLE)!.checks.find((c) => c.name === "canon_nd_chk")!.expression =
          `("a" IS NOT NULL) = ("status" IS NOT DISTINCT FROM 'p')`;
        const d = await diff({ expected: want, actual: live2, dialect: "postgres", scopeSchemas: ["public"], exprCanonProbe: postgresExprCanonProbe(db) });
        expect(d.changes).toEqual([]);
      } finally {
        await sql.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT canon_nd_chk`).execute(db);
      }
    });
  });

  describe("index @expr / @where", () => {
    test("a partial-index predicate with different precedence is drift; the same predicate re-written is not", async () => {
      expect(await kinds({ indexes: { canon_where_idx: { where: "a = 1 OR (b = 1 AND c = 1)" } } }, true))
        .toEqual(["add-index", "drop-index"]);
      expect(await kinds({ indexes: { canon_where_idx: { where: "((a=1) OR (b=1)) AND (c=1)" } } }, true)).toEqual([]);
      // ...which the normaliser alone cannot tell apart.
      expect(await kinds({ indexes: { canon_where_idx: { where: "a = 1 OR (b = 1 AND c = 1)" } } }, false)).toEqual([]);
    });
    test("an expression key authored tight or loose is the same index; a different function is not", async () => {
      expect(await kinds({ indexes: { canon_expr_idx: { expr: "lower(status)" } } }, true)).toEqual([]);
      expect(await kinds({ indexes: { canon_expr_idx: { expr: "upper(status)" } } }, true)).toEqual(["add-index", "drop-index"]);
    });
  });

  describe("falls back to the string normaliser and never reports drift of its own", () => {
    test("a read-only connection answers nothing, and the normaliser decides as before", async () => {
      const ro = connect("-c default_transaction_read_only=on");
      try {
        const { live, expected } = await declared({});
        const t = expected.tables.find((x) => x.name === TABLE)!;
        expect(await postgresExprCanonProbe(ro.db)(live.tables.find((x) => x.name === TABLE)!, t)).toBeUndefined();
        // Equal text: clean. Changed text: drift. Same as without a probe.
        expect(await kinds({ checks: { canon_status_chk: `"status" = 'open'::text` } }, true, ro.db)).toEqual([]);
        expect(await kinds({ checks: { canon_status_chk: "status IN ('OPEN')" } }, true, ro.db)).toEqual(["add-check", "drop-check"]);
        // The normaliser's own blind spot stays a blind spot on this path.
        expect(await kinds({ checks: { canon_prec_chk: "a = 1 OR (b = 1 AND c = 1)" } }, true, ro.db)).toEqual([]);
      } finally {
        await ro.pool.end();
      }
    });
    test("an expression that does not compile against the live columns has no answer", async () => {
      const { live, expected } = await declared({ checks: { canon_prec_chk: "no_such_column = 1" } });
      const answer = await postgresExprCanonProbe(db)(
        live.tables.find((x) => x.name === TABLE)!, expected.tables.find((x) => x.name === TABLE)!,
      );
      const t = expected.tables.find((x) => x.name === TABLE)!;
      expect(answer?.checks.has(t.checks.find((c) => c.name === "canon_prec_chk")!)).toBe(false);
      expect(answer?.checks.has(t.checks.find((c) => c.name === "canon_not_chk")!)).toBe(true);
    });
    test("an expression carrying a second statement is not run", async () => {
      const { live, expected } = await declared({ checks: { canon_not_chk: `a = 1); DROP TABLE ${TABLE}; --` } });
      const t = expected.tables.find((x) => x.name === TABLE)!;
      const answer = await postgresExprCanonProbe(db)(live.tables.find((x) => x.name === TABLE)!, t);
      expect(answer?.checks.has(t.checks.find((c) => c.name === "canon_not_chk")!)).toBe(false);
      const still = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(TABLE)}`.execute(db);
      expect(still.rows[0]!.n).toBe("0");
    });
  });

  describe("hostile expressions are never run", () => {
    const answered = async (over: Parameters<typeof declared>[0]) => {
      const { live, expected } = await declared(over);
      const t = expected.tables.find((x) => x.name === TABLE)!;
      const answer = await postgresExprCanonProbe(db)(live.tables.find((x) => x.name === TABLE)!, t);
      const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(TABLE)}`.execute(db);
      return { answer, t, survived: rows.rows[0]!.n === "0" };
    };
    test("an E-string escape cannot smuggle a statement past the guard", async () => {
      const { answer, t, survived } = await answered({
        checks: { canon_not_chk: `a = E'\\''; COMMIT; DROP TABLE ${TABLE}; --'` },
      });
      expect(answer?.checks.has(t.checks.find((c) => c.name === "canon_not_chk")!)).toBe(false);
      expect(survived).toBe(true);
    });
    test("a dollar quote cannot smuggle a statement past the guard", async () => {
      const { answer, t, survived } = await answered({
        checks: { canon_not_chk: `a = 1 AND $a$'$a$ <> ''; COMMIT; DROP TABLE ${TABLE}; --'` },
      });
      expect(answer?.checks.has(t.checks.find((c) => c.name === "canon_not_chk")!)).toBe(false);
      expect(survived).toBe(true);
    });
    test("an index @using that is not an access-method name is not run", async () => {
      const { live, expected } = await declared({ indexes: { canon_expr_idx: { expr: "lower(status)" } } });
      const t = expected.tables.find((x) => x.name === TABLE)!;
      const ix = t.indexes.find((i) => i.name === "canon_expr_idx")!;
      ix.using = `btree (id); COMMIT; DROP TABLE ${TABLE}; CREATE INDEX x ON ${TABLE} USING btree`;
      const answer = await postgresExprCanonProbe(db)(live.tables.find((x) => x.name === TABLE)!, t);
      expect(answer?.indexes.has(ix)).toBe(false);
      const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(TABLE)}`.execute(db);
      expect(rows.rows[0]!.n).toBe("0");
    });
  });

  describe("a refusal for one table does not switch the probe off for the others", () => {
    const OTHER = "canon_probe_locked";
    const ROLE = "canon_probe_nosel";
    test("a role without SELECT on one table gets no answer there, and is still probed on the next", async () => {
      await sql.raw(`DROP TABLE IF EXISTS ${OTHER}`).execute(db);
      await sql.raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE}; END IF; END $$`).execute(db);
      await sql.raw(`CREATE TABLE ${OTHER} (id int, a int, CONSTRAINT canon_locked_chk CHECK (a > 0))`).execute(db);
      await sql.raw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`).execute(db);
      await sql.raw(`GRANT SELECT ON ${TABLE} TO ${ROLE}`).execute(db);
      const restricted = connect();
      try {
        const live = await introspectPostgres(db);
        const expected = structuredClone(live);
        const lockedLive = live.tables.find((x) => x.name === OTHER)!;
        const lockedWant = expected.tables.find((x) => x.name === OTHER)!;
        const t = live.tables.find((x) => x.name === TABLE)!;
        const tWant = expected.tables.find((x) => x.name === TABLE)!;
        const asRole = async (work: (q: Db) => Promise<void>) => {
          await restricted.db.transaction().execute(async (trx) => {
            await sql.raw(`SET LOCAL ROLE ${ROLE}`).execute(trx);
            await work(trx);
          });
        };
        await asRole(async (trx) => {
          const p = postgresExprCanonProbe(trx);
          expect(await p(lockedLive, lockedWant)).toBeUndefined();
          const next = await p(t, tWant);
          expect(next?.checks.has(tWant.checks.find((c) => c.name === "canon_not_chk")!)).toBe(true);
        });
      } finally {
        await restricted.pool.end();
        await sql.raw(`DROP TABLE IF EXISTS ${OTHER}`).execute(db);
        await sql.raw(`REVOKE ALL ON ${TABLE} FROM ${ROLE}`).execute(db).catch(() => {});
        await sql.raw(`REVOKE USAGE ON SCHEMA public FROM ${ROLE}`).execute(db).catch(() => {});
        await sql.raw(`DROP OWNED BY ${ROLE}`).execute(db).catch(() => {});
        await sql.raw(`DROP ROLE IF EXISTS ${ROLE}`).execute(db).catch(() => {});
      }
    });
  });

  describe("leaves nothing behind", () => {
    test("inside the caller's own transaction the probe uses a savepoint and the transaction stays usable", async () => {
      const { live, expected } = await declared({ checks: { canon_prec_chk: "no_such_column = 1" } });
      const lt = live.tables.find((x) => x.name === TABLE)!;
      const et = expected.tables.find((x) => x.name === TABLE)!;
      await db.transaction().execute(async (trx) => {
        const answer = await postgresExprCanonProbe(trx)(lt, et);
        expect(answer?.checks.size).toBe(3); // one expression failed to compile; the savepoint absorbed it
        const rows = await sql<{ t: string | null; i: string | null }>`
          SELECT to_regclass('pg_temp.mo_check_probe')::text AS t, to_regclass('pg_temp.mo_check_probe_i')::text AS i
        `.execute(trx);
        expect(rows.rows[0]).toEqual({ t: null, i: null });
        await sql`SELECT 1`.execute(trx); // not aborted
      });
    });
    test("on its own the probe commits nothing", async () => {
      const { live, expected } = await declared({});
      await postgresExprCanonProbe(db)(live.tables.find((x) => x.name === TABLE)!, expected.tables.find((x) => x.name === TABLE)!);
      const rows = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM pg_class WHERE relname IN ('mo_check_probe', 'mo_check_probe_i')
      `.execute(db);
      expect(rows.rows[0]!.n).toBe("0");
    });
  });

  describe("adoptGeneratedSpelling (baseline --from-db)", () => {
    test("records the generated text for a proven-equal expression, and Postgres's for the rest", async () => {
      const { live, expected } = await declared({
        checks: {
          canon_status_chk: `"status" IN ('open')`,   // proven equal: generated text replaces Postgres's
          canon_prec_chk: "a = 1 OR (b = 1 AND c = 1)", // a real difference: Postgres's text is kept
        },
        indexes: { canon_where_idx: { where: "(a=1 OR b=1) AND c=1" } },
      });
      const out = await adoptGeneratedSpelling(live, expected, postgresExprCanonProbe(db));
      const t = (s: SchemaSnapshot): TableDescriptor => s.tables.find((x) => x.name === TABLE)!;
      const check = (s: SchemaSnapshot, n: string) => t(s).checks.find((c) => c.name === n)!.expression;
      expect(check(out, "canon_status_chk")).toBe(`"status" IN ('open')`);
      expect(check(out, "canon_prec_chk")).toBe(check(live, "canon_prec_chk"));
      expect(check(out, "canon_not_chk")).toBe(check(live, "canon_not_chk"));
      expect(t(out).indexes.find((i) => i.name === "canon_where_idx")!.where).toBe("(a=1 OR b=1) AND c=1");
      // The offline comparison (no database) now agrees with the model.
      const offline = await diff({ expected, actual: out, dialect: "postgres", scopeSchemas: ["public"] });
      expect(offline.changes.filter((c) => c.kind.endsWith("-check") && "check" in c && c.check === "canon_status_chk")).toEqual([]);
    });
    test("without an answer the snapshot is untouched", async () => {
      const ro = connect("-c default_transaction_read_only=on");
      try {
        const { live, expected } = await declared({});
        const out = await adoptGeneratedSpelling(live, expected, postgresExprCanonProbe(ro.db));
        expect(out).toEqual(live);
      } finally {
        await ro.pool.end();
      }
    });
  });
});
