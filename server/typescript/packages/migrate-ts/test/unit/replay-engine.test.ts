import { describe, test, expect } from "bun:test";
import { sql } from "kysely";
import { openReplayEngine } from "../../src/verify/replay-engine.js";
import { introspect } from "../../src/introspect/index.js";

describe("openReplayEngine", () => {
  test("sqlite: gives an empty, usable database", async () => {
    const engine = await openReplayEngine("sqlite");
    try {
      await sql`CREATE TABLE t (id integer primary key)`.execute(engine.db);
      await sql`INSERT INTO t (id) VALUES (1)`.execute(engine.db);
      const rows = await sql<{ id: number }>`SELECT id FROM t`.execute(engine.db);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await engine.dispose();
    }
  });

  test("postgres: gives an empty, usable database with real PG DDL", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      // Schema namespacing + a CHECK — neither is expressible in sqlite, so this
      // proves the postgres engine really is Postgres.
      await sql`CREATE SCHEMA IF NOT EXISTS "reporting"`.execute(engine.db);
      await sql`CREATE TABLE "reporting"."t" (id integer primary key, n integer CHECK (n > 0))`.execute(engine.db);
      const rows = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'reporting'
      `.execute(engine.db);
      expect(rows.rows.map((r) => r.table_name)).toContain("t");
    } finally {
      await engine.dispose();
    }
  });

  // THE defect that nearly shipped, and the reason this case exists on BOTH dialects:
  // `applyPending` runs every migration file inside a transaction, so a table created
  // by migration 1 must be visible to migration 2 and to the introspection that
  // follows. Under `@libsql/kysely-libsql`, `:memory:` gives each CONNECTION its own
  // database, so a tx-created table vanishes the instant the transaction's connection
  // is released — a whole chain would replay into a series of throwaway databases and
  // the gate would pass having proved nothing. Only a cross-transaction assertion
  // catches it; the non-transactional cases above all passed.
  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`${dialect}: a table created inside a transaction survives it`, async () => {
      const engine = await openReplayEngine(dialect);
      try {
        await engine.db.transaction().execute(async (trx) => {
          await sql`CREATE TABLE in_tx (id integer primary key)`.execute(trx);
        });
        // A second transaction must SEE the first one's table, the way migration 2
        // sees migration 1's.
        await engine.db.transaction().execute(async (trx) => {
          await sql`INSERT INTO in_tx (id) VALUES (1)`.execute(trx);
        });
        const snap = await introspect(engine.db, dialect);
        expect(snap.tables.map((x) => x.name)).toContain("in_tx");
      } finally {
        await engine.dispose();
      }
    });
  }

  // applyPending runs each migration file inside a kysely transaction and takes a
  // pg advisory lock on postgres. Both must work through the shim, or the gate
  // fails for a reason that has nothing to do with the chain under test.
  test("postgres: transactions roll back, and advisory locks work", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      await sql`CREATE TABLE t (id integer primary key)`.execute(engine.db);
      await expect(
        engine.db.transaction().execute(async (trx) => {
          await sql`INSERT INTO t (id) VALUES (1)`.execute(trx);
          throw new Error("boom");
        }),
      ).rejects.toThrow(/boom/);
      const after = await sql<{ c: string }>`SELECT count(*)::text AS c FROM t`.execute(engine.db);
      expect(after.rows[0]?.c).toBe("0");

      await sql`SELECT pg_advisory_lock(hashtext('meta'))`.execute(engine.db);
      await sql`SELECT pg_advisory_unlock(hashtext('meta'))`.execute(engine.db);
    } finally {
      await engine.dispose();
    }
  });

  // The whole gate rests on this: a statement against a missing object must REJECT.
  test("postgres: dropping a missing table rejects — the #313 signal", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      await expect(sql`DROP TABLE "theirs"`.execute(engine.db)).rejects.toThrow(/theirs/);
    } finally {
      await engine.dispose();
    }
  });

  test("sqlite: dropping a missing table rejects — the #313 signal", async () => {
    const engine = await openReplayEngine("sqlite");
    try {
      await expect(sql`DROP TABLE "theirs"`.execute(engine.db)).rejects.toThrow(/theirs/);
    } finally {
      await engine.dispose();
    }
  });

  // `--replay-snapshot` introspects the replayed database, so the postgres
  // introspector — information_schema, pg_catalog, pg_get_viewdef — has to work
  // against the in-process engine or that whole tier is unreachable.
  test("postgres: introspect reads back a table and a view", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      await sql`CREATE TABLE t (id integer primary key, n integer NOT NULL)`.execute(engine.db);
      await sql`CREATE VIEW v AS SELECT id FROM t`.execute(engine.db);
      const snap = await introspect(engine.db, "postgres");
      expect(snap.tables.map((x) => x.name)).toContain("t");
      expect(snap.views.map((x) => x.name)).toContain("v");
    } finally {
      await engine.dispose();
    }
  });

  test("two engines of the same dialect do not share state", async () => {
    const a = await openReplayEngine("sqlite");
    const b = await openReplayEngine("sqlite");
    try {
      await sql`CREATE TABLE only_in_a (id integer)`.execute(a.db);
      const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name = 'only_in_a'`.execute(b.db);
      expect(rows.rows).toHaveLength(0);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  test("two postgres engines do not share state either", async () => {
    const a = await openReplayEngine("postgres");
    const b = await openReplayEngine("postgres");
    try {
      await sql`CREATE TABLE only_in_a (id integer)`.execute(a.db);
      const rows = await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM information_schema.tables WHERE table_name = 'only_in_a'
      `.execute(b.db);
      expect(rows.rows[0]?.c).toBe("0");
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  // A caller disposes in a `finally` after an early return, so a double dispose
  // must not throw.
  test("dispose is idempotent", async () => {
    const engine = await openReplayEngine("sqlite");
    await engine.dispose();
    await engine.dispose();
  });
});
