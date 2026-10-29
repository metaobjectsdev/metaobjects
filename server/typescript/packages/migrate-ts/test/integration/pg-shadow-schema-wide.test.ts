/**
 * The shadow path is a catalog-to-catalog diff, not a list of expression rules. Nothing in
 * this file has a special case anywhere in migrate-ts: an `int4` column against a model
 * `integer`, and an FK `ON DELETE SET NULL`, read clean through the shadow path because
 * Postgres (not a rule) says what they are, and each is still reported when it really differs.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { postgresShadowSchema } from "../../src/shadow-canon.js";
import type { FkDescriptor, SchemaSnapshot } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const SHADOW_DB = "mo_shadow_wide_test";

type Db = Kysely<Record<string, unknown>>;

describe("shadow path is schema-wide (live PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  const connect = (url: string): { pool: Pool; db: Db } => {
    const pool = new Pool({ connectionString: url });
    return { pool, db: new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) }) };
  };
  let main: { pool: Pool; db: Db };
  const shadow = postgresShadowSchema(async () => {
    const u = new URL(PG_URL);
    u.pathname = `/${SHADOW_DB}`;
    const s = connect(u.toString());
    return { db: s.db, close: async () => { await s.db.destroy(); } };
  });

  beforeAll(async () => {
    main = connect(PG_URL);
    await sql.raw(`DROP DATABASE IF EXISTS ${SHADOW_DB}`).execute(main.db);
    await sql.raw(`CREATE DATABASE ${SHADOW_DB}`).execute(main.db);
    await sql.raw(`
      DROP TABLE IF EXISTS sc2_child; DROP TABLE IF EXISTS sc2_parent;
      CREATE TABLE sc2_parent (id int4 PRIMARY KEY, label character varying(20) NOT NULL);
      CREATE TABLE sc2_child (
        id int4 PRIMARY KEY, parent_id integer,
        CONSTRAINT sc2_child_parent_fk FOREIGN KEY (parent_id) REFERENCES sc2_parent (id) ON DELETE SET NULL
      )`).execute(main.db);
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS sc2_child; DROP TABLE IF EXISTS sc2_parent`).execute(main.db);
    await sql.raw(`DROP DATABASE IF EXISTS ${SHADOW_DB}`).execute(main.db);
    await main.pool.end();
  });

  /** The model, written by hand (not read from the live database). */
  const model = (over?: { onDelete?: FkDescriptor["onDelete"]; parentIdBits?: 32 | 64; labelLength?: number }): SchemaSnapshot => ({
    views: [],
    tables: [
      {
        name: "sc2_parent", schema: "public", indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
        columns: [
          { name: "id", sqlType: { kind: "integer", bits: 32 }, nullable: false },
          { name: "label", sqlType: { kind: "text", maxLength: over?.labelLength ?? 20 }, nullable: false },
        ],
      },
      {
        name: "sc2_child", schema: "public", indexes: [], checks: [], primaryKey: ["id"],
        columns: [
          { name: "id", sqlType: { kind: "integer", bits: 32 }, nullable: false },
          { name: "parent_id", sqlType: { kind: "integer", bits: over?.parentIdBits ?? 32 }, nullable: true },
        ],
        foreignKeys: [{
          name: "sc2_child_parent_fk", columns: ["parent_id"], refTable: "sc2_parent", refColumns: ["id"],
          onDelete: over?.onDelete ?? "set-null",
        }],
      },
    ],
  });
  const run = async (expected: SchemaSnapshot, withShadow: boolean) => {
    const live = await introspectPostgres(main.db);
    const r = await diff({
      expected, actual: live, dialect: "postgres", scopeSchemas: ["public"],
      ...(withShadow ? { shadowSchema: shadow } : {}),
    });
    return { kinds: r.changes.filter((c) => "table" in c && String(c.table).startsWith("sc2_")).map((c) => c.kind).sort(), path: r.exprCanonPath };
  };

  test("int4 against integer, varchar spelling and an FK ON DELETE SET NULL read clean", async () => {
    expect(await run(model(), true)).toEqual({ kinds: [], path: "shadow" });
  });

  test("each is still reported when it really differs", async () => {
    expect((await run(model({ onDelete: "cascade" }), true)).kinds).toEqual(["add-fk", "drop-fk"]);
    expect((await run(model({ parentIdBits: 64 }), true)).kinds).toEqual(["change-column-type"]);
    expect((await run(model({ labelLength: 40 }), true)).kinds).toEqual(["change-column-type"]);
  });
});
