/**
 * The shadow-database path: the expected schema is applied to a scratch database, introspected
 * by the same introspector as the live one, and the two are compared in Postgres's own
 * spelling. One round trip covers every shape the string comparison used to get wrong (CHECK
 * variants, the five re-spelled defaults, a composite default, index expressions and
 * predicates, a view), and a real change of each kind must still be reported.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { postgresExprCanonProbe } from "../../src/expr-canon-probe.js";
import { postgresShadowSchema, type ShadowOpener } from "../../src/shadow-canon.js";
import type { ChangeKind, SchemaSnapshot, TableDescriptor } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const TABLE = "shadow_canon_t";
const SHADOW_DB = "mo_shadow_canon_test";

type Db = Kysely<Record<string, unknown>>;

describe("shadow-database canon (live PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  const connect = (url: string): { pool: Pool; db: Db } => {
    const pool = new Pool({ connectionString: url });
    return { pool, db: new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) }) };
  };
  const shadowUrl = (): string => {
    const u = new URL(PG_URL);
    u.pathname = `/${SHADOW_DB}`;
    return u.toString();
  };
  let main: { pool: Pool; db: Db };
  let closes = 0;

  const opener: ShadowOpener = async () => {
    const s = connect(shadowUrl());
    return { db: s.db, close: async () => { closes++; await s.db.destroy(); } };
  };

  beforeAll(async () => {
    main = connect(PG_URL);
    await sql.raw(`DROP DATABASE IF EXISTS ${SHADOW_DB}`).execute(main.db);
    await sql.raw(`CREATE DATABASE ${SHADOW_DB}`).execute(main.db);
    await sql.raw(`
      DROP VIEW IF EXISTS ${TABLE}_v; DROP TABLE IF EXISTS ${TABLE};
      CREATE TABLE ${TABLE} (
        id bigint PRIMARY KEY, a int, b int, status text, code varchar(16),
        ts timestamptz DEFAULT NOW(), dt date DEFAULT current_date, ts2 timestamptz DEFAULT '2024-01-01',
        dbl double precision DEFAULT '1e3', n integer DEFAULT '007', soon timestamptz DEFAULT now() + interval '1 day',
        label text DEFAULT 'a',
        CONSTRAINT sc_prec_chk CHECK ((a = 1 OR b = 1) AND status = 'x'),
        CONSTRAINT sc_in_chk CHECK (status IN ('OPEN', 'CLOSED')),
        CONSTRAINT sc_re_chk CHECK (code ~ '^[a-z]+$'),
        CONSTRAINT sc_ns_chk CHECK (a IS NOT DISTINCT FROM b)
      );
      CREATE INDEX sc_expr_idx ON ${TABLE} (lower(status));
      CREATE INDEX sc_part_idx ON ${TABLE} (id) WHERE (a = 1 OR b = 1) AND status = 'x';
      CREATE VIEW ${TABLE}_v AS SELECT id, status FROM ${TABLE}`).execute(main.db);
  });
  afterAll(async () => {
    await sql.raw(`DROP VIEW IF EXISTS ${TABLE}_v; DROP TABLE IF EXISTS ${TABLE}`).execute(main.db);
    await sql.raw(`DROP DATABASE IF EXISTS ${SHADOW_DB}`).execute(main.db);
    await main.pool.end();
  });

  const tableOf = (s: SchemaSnapshot): TableDescriptor => s.tables.find((t) => t.name === TABLE)!;

  /** The expected side: the live schema with the author's spelling (and any real change) laid over it. */
  const declared = async (edit: (t: TableDescriptor) => void): Promise<{ live: SchemaSnapshot; expected: SchemaSnapshot }> => {
    const live = await introspectPostgres(main.db);
    const expected = structuredClone(live);
    edit(tableOf(expected));
    return { live, expected };
  };
  const AUTHORED = (t: TableDescriptor): void => {
    const col = (n: string) => t.columns.find((c) => c.name === n)!;
    col("ts").default = { kind: "expr", value: "NOW()" };
    col("dt").default = { kind: "expr", value: "current_date" };
    col("ts2").default = { kind: "literal", value: "2024-01-01" };
    col("dbl").default = { kind: "literal", value: "1e3" };
    col("n").default = { kind: "literal", value: "007" };
    col("soon").default = { kind: "expr", value: "now() + interval '1 day'" };
    const chk = (n: string) => t.checks.find((c) => c.name === n)!;
    chk("sc_prec_chk").expression = `("a" = 1 OR "b" = 1) AND "status" = 'x'`;
    chk("sc_in_chk").expression = `"status" IN ('OPEN', 'CLOSED')`;
    chk("sc_re_chk").expression = `"code" ~ '^[a-z]+$'`;
    chk("sc_ns_chk").expression = `"a" IS NOT DISTINCT FROM "b"`;
    const ix = (n: string) => t.indexes.find((i) => i.name === n)!;
    ix("sc_expr_idx").expr = `lower("status")`;
    ix("sc_part_idx").where = `("a" = 1 OR "b" = 1) AND "status" = 'x'`;
  };
  const changeKinds = async (edit: (t: TableDescriptor) => void, how: "shadow" | "probe" | "none") => {
    const { live, expected } = await declared(edit);
    const r = await diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      ...(how === "shadow" ? { shadowSchema: postgresShadowSchema(opener) } : {}),
      ...(how === "probe" ? { exprCanonProbe: postgresExprCanonProbe(main.db) } : {}),
    });
    return { kinds: r.changes.map((c) => c.kind).sort(), path: r.exprCanonPath };
  };

  test("the string comparison alone reports the authored spellings as drift (the defect)", async () => {
    const r = await changeKinds(AUTHORED, "none");
    expect(r.path).toBe("normaliser");
    expect(r.kinds).toContain("change-column-default");
  });

  test("the shadow path reads every authored spelling as clean", async () => {
    const before = closes;
    const r = await changeKinds(AUTHORED, "shadow");
    expect(r).toEqual({ kinds: [], path: "shadow" });
    expect(closes).toBe(before + 1);
  });

  test("the shadow leaves nothing behind in the shadow database", async () => {
    const s = connect(shadowUrl());
    try {
      const left = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE ${`${TABLE}%`}`.execute(s.db);
      expect(left.rows[0]!.n).toBe(0);
    } finally {
      await s.pool.end();
    }
  });

  test("a real change of each kind is still reported", async () => {
    const cases: Array<[string, (t: TableDescriptor) => void, ChangeKind[]]> = [
      ["default value", (t) => { AUTHORED(t); t.columns.find((c) => c.name === "label")!.default = { kind: "literal", value: "b" }; }, ["change-column-default"]],
      ["default instant", (t) => { AUTHORED(t); t.columns.find((c) => c.name === "ts2")!.default = { kind: "literal", value: "2024-01-02" }; }, ["change-column-default"]],
      ["default expression", (t) => { AUTHORED(t); t.columns.find((c) => c.name === "soon")!.default = { kind: "expr", value: "now() + interval '2 days'" }; }, ["change-column-default"]],
      ["check literal case", (t) => { AUTHORED(t); t.checks.find((c) => c.name === "sc_in_chk")!.expression = `"status" IN ('open', 'closed')`; }, ["add-check", "drop-check"]],
      ["check precedence", (t) => { AUTHORED(t); t.checks.find((c) => c.name === "sc_prec_chk")!.expression = `"a" = 1 OR ("b" = 1 AND "status" = 'x')`; }, ["add-check", "drop-check"]],
      ["index expression", (t) => { AUTHORED(t); t.indexes.find((i) => i.name === "sc_expr_idx")!.expr = `upper("status")`; }, ["add-index", "drop-index"]],
      ["index predicate", (t) => { AUTHORED(t); t.indexes.find((i) => i.name === "sc_part_idx")!.where = `"a" = 1 OR ("b" = 1 AND "status" = 'x')`; }, ["add-index", "drop-index"]],
    ];
    for (const [label, edit, want] of cases) {
      const r = await changeKinds(edit, "shadow");
      expect({ label, path: r.path, kinds: r.kinds }).toEqual({ label, path: "shadow", kinds: want });
    }
  });

  test("a schema that does not apply to the shadow falls back to the probe, then the normaliser", async () => {
    const { live, expected } = await declared(AUTHORED);
    tableOf(expected).foreignKeys.push({ name: "sc_fk", columns: ["a"], refTable: "no_such_table", refColumns: ["id"], onDelete: "restrict" });
    const r = await diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      shadowSchema: postgresShadowSchema(opener), exprCanonProbe: postgresExprCanonProbe(main.db),
    });
    expect(r.exprCanonPath).toBe("probe");
    expect(r.shadowUnavailable).toContain("does not apply");
    expect(r.changes.map((c) => c.kind)).toEqual(["add-fk"]);
  });

  test("an explicitly configured shadow that does not apply is an error naming the cause", async () => {
    const { live, expected } = await declared(AUTHORED);
    tableOf(expected).foreignKeys.push({ name: "sc_fk", columns: ["a"], refTable: "no_such_table", refColumns: ["id"], onDelete: "restrict" });
    const run = diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      shadowSchema: postgresShadowSchema(opener, { required: true }), exprCanonProbe: postgresExprCanonProbe(main.db),
    });
    await expect(run).rejects.toThrow(/shadow database: the expected schema does not apply to it: .*no_such_table/);
  });

  test("a view that does not apply to the shadow is left out, and the tables are still compared there", async () => {
    const { live, expected } = await declared(AUTHORED);
    expected.views.push({ name: `${TABLE}_lost_v`, schema: "public", sql: "SELECT id FROM only_on_live_table", fingerprint: "f" });
    const r = await diff({ expected, actual: live, dialect: "postgres", scopeSchemas: ["public"], shadowSchema: postgresShadowSchema(opener) });
    expect(r.exprCanonPath).toBe("shadow");
    expect(r.changes.map((c) => c.kind)).toEqual(["create-view"]);
  });

  test("an opener that cannot open reads as unavailable", async () => {
    const { live, expected } = await declared(AUTHORED);
    const r = await diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      shadowSchema: postgresShadowSchema(async () => { throw new Error("no CREATE DATABASE"); }),
    });
    expect(r.exprCanonPath).toBe("normaliser");
    expect(r.shadowUnavailable).toBe("could not be opened: no CREATE DATABASE");
  });

  test("an explicitly configured shadow that cannot be opened is an error naming the cause", async () => {
    const { live, expected } = await declared(AUTHORED);
    const run = diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      shadowSchema: postgresShadowSchema(async () => { throw new Error("password authentication failed"); }, { required: true }),
    });
    await expect(run).rejects.toThrow("shadow database: could not be opened: password authentication failed");
  });
});
