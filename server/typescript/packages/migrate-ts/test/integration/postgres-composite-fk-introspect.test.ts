/**
 * Composite foreign keys introspect as the columns they have, paired in order.
 *
 * information_schema.constraint_column_usage carries no column position, so joining it
 * to key_column_usage pairs every FK column with every referenced column: a two-column
 * FK read back as four columns, a three-column one as nine. `meta migrate` reads its
 * expected side back from a shadow database, so the cross product reached the emitted
 * DDL ("foreign key referenced-columns list must not contain duplicates"). The FK below
 * also lists its columns in a different order from the target key, so a reader that
 * pairs by position in the target rather than in the FK fails too.
 */
import { describe, test, expect } from "bun:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { introspectPostgres } from "../../src/introspect/postgres.js";

const PG_URL = process.env.MIGRATE_TS_PG_URL;
const d = PG_URL ? describe : describe.skip;

d("postgres composite FK introspection (real PG)", () => {
  test("reads each composite FK column once, paired with its referenced column", async () => {
    const k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL }) }) });
    const p = "cfk_parent_" + Math.random().toString(36).slice(2, 8);
    const c = "cfk_child_" + Math.random().toString(36).slice(2, 8);
    try {
      await sql.raw(`CREATE TABLE ${p} ( id INTEGER PRIMARY KEY, region INTEGER NOT NULL, kind INTEGER NOT NULL )`).execute(k);
      await sql.raw(`CREATE UNIQUE INDEX ${p}_ak ON ${p} (id, region, kind)`).execute(k);
      await sql.raw(
        `CREATE TABLE ${c} ( id INTEGER PRIMARY KEY, p_kind INTEGER, p_id INTEGER, p_region INTEGER, ` +
        `CONSTRAINT ${c}_fk FOREIGN KEY (p_kind, p_id, p_region) REFERENCES ${p} (kind, id, region) ON DELETE RESTRICT )`,
      ).execute(k);

      const snap = await introspectPostgres(k);
      const fk = snap.tables.find((x) => x.name === c)!.foreignKeys.find((f) => f.name === `${c}_fk`)!;

      expect(fk.columns).toEqual(["p_kind", "p_id", "p_region"]);
      expect(fk.refColumns).toEqual(["kind", "id", "region"]);
      expect(fk.refTable).toBe(p);
      expect(fk.onDelete).toBe("restrict");
    } finally {
      await sql.raw(`DROP TABLE IF EXISTS ${c}`).execute(k);
      await sql.raw(`DROP TABLE IF EXISTS ${p}`).execute(k);
      await k.destroy();
    }
  });

  test("reads a primary key's constraint name when it is not <table>_pkey", async () => {
    const k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL }) }) });
    const named = "pkn_" + Math.random().toString(36).slice(2, 8);
    const plain = "pkp_" + Math.random().toString(36).slice(2, 8);
    try {
      await sql.raw(`CREATE TABLE ${named} ( id INTEGER, CONSTRAINT "PK_${named}" PRIMARY KEY (id) )`).execute(k);
      await sql.raw(`CREATE TABLE ${plain} ( id INTEGER PRIMARY KEY )`).execute(k);

      const snap = await introspectPostgres(k);

      expect(snap.tables.find((x) => x.name === named)!.primaryKeyName).toBe(`PK_${named}`);
      // the default name is left absent, so a snapshot without conventions is unchanged
      expect(snap.tables.find((x) => x.name === plain)!.primaryKeyName).toBeUndefined();
    } finally {
      await sql.raw(`DROP TABLE IF EXISTS ${named}`).execute(k);
      await sql.raw(`DROP TABLE IF EXISTS ${plain}`).execute(k);
      await k.destroy();
    }
  });
});
