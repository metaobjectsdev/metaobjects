/**
 * Integration tests for introspectPostgres().
 *
 * pg-mem coverage gaps (documented):
 *
 * 1. Kysely's `db.introspection.getTables()` uses a `!~` regex operator that
 *    pg-mem (v3.0.14) does not support. Introspection falls back to raw
 *    information_schema queries instead.
 *
 * 2. pg-mem's information_schema loses type fidelity:
 *    - bigserial → "integer" (no sequence tracking)
 *    - varchar(255) → "text" (no character_maximum_length)
 *    - column_default is always null
 *    Therefore the following tests are gated on MIGRATE_TS_PG_URL:
 *      - "normalizes varchar(255) → text(maxLength=255)"
 *      - "normalizes bigserial → integer{64} with identity=increment"
 *      - "boolean column has a default value"
 *    When MIGRATE_TS_PG_URL is not set, these tests are skipped.
 *
 * 3. pg-mem's pg_constraint / information_schema.table_constraints /
 *    information_schema.key_column_usage all return empty rows — primary key
 *    detection does not work. "captures primary key" is also gated.
 *
 * 4. pg-mem's information_schema.columns reports is_nullable = 'NO' for ALL
 *    columns regardless of whether NOT NULL was specified, so nullable tests
 *    are also gated on MIGRATE_TS_PG_URL.
 *
 * 5. pg-mem does not implement array_position() — the pg_index catalog query
 *    in readPgIndexes() throws. introspectPostgres() catches and returns []
 *    for indexes when on pg-mem. Index tests are gated on MIGRATE_TS_PG_URL.
 *
 * 6. pg-mem's information_schema.referential_constraints is not supported —
 *    readPgForeignKeys() catches and returns [] on pg-mem. FK tests are
 *    gated on MIGRATE_TS_PG_URL.
 *
 * Tests that DO run against pg-mem (information_schema.columns works partially):
 *   - table presence
 *   - column names
 *   - snapshot.views always present
 *
 * When MIGRATE_TS_PG_URL is set the entire describe block runs against a real
 * Postgres 16 instance (using the `pg` package Pool).  All gated tests then
 * execute with full fidelity.  When the env var is absent the block falls back
 * to pg-mem, which covers the non-gated smoke tests only.
 *
 * The pgTypeToSqlType and parsePgDefault helpers are exported for unit-testing
 * and run unconditionally — they don't need a live DB.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { introspectPostgres, pgTypeToSqlType, parsePgDefault } from "../../src/introspect/postgres.js";
import { introspect } from "../../src/introspect/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePgMemKysely(): Kysely<Record<string, unknown>> {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  return new Kysely({
    dialect: new PostgresDialect({ pool: pool as never }),
  });
}

function makeRealPgKysely(connectionString: string): { kysely: Kysely<Record<string, unknown>>; pool: Pool } {
  const pool = new Pool({ connectionString });
  const kysely = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool }),
  });
  return { kysely, pool };
}

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

// ---------------------------------------------------------------------------
// Integration — pg-mem or real Postgres (when MIGRATE_TS_PG_URL is set)
// ---------------------------------------------------------------------------

describe("introspectPostgres — tables + columns", () => {
  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool | undefined;

  beforeAll(async () => {
    if (PG_URL) {
      // Use real Postgres — provides full information_schema fidelity.
      const result = makeRealPgKysely(PG_URL);
      kysely = result.kysely;
      pool = result.pool;
      // Drop + recreate so repeated runs don't fail on pre-existing table.
      await sql`DROP TABLE IF EXISTS users`.execute(kysely);
    } else {
      // Fall back to pg-mem for environments without a live PG instance.
      kysely = makePgMemKysely();
    }
    await kysely.schema
      .createTable("users")
      .addColumn("id", "bigserial", (c) => c.primaryKey())
      .addColumn("email", "varchar(255)", (c) => c.notNull())
      .addColumn("first_name", "text")
      .addColumn("is_active", "boolean", (c) => c.notNull().defaultTo(true))
      .addColumn("created_at", "timestamp", (c) => c.defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  });

  afterAll(async () => {
    if (PG_URL) {
      await sql`DROP TABLE IF EXISTS users`.execute(kysely);
      await pool?.end();
    }
  });

  // ── Works against pg-mem ──────────────────────────────────────────────────

  test("introspects table users", async () => {
    const snapshot = await introspectPostgres(kysely);
    const users = snapshot.tables.find((t) => t.name === "users");
    expect(users).toBeDefined();
  });

  test("column names are present", async () => {
    const snapshot = await introspectPostgres(kysely);
    const users = snapshot.tables.find((t) => t.name === "users");
    const names = users?.columns.map((c) => c.name) ?? [];
    expect(names).toContain("id");
    expect(names).toContain("email");
    expect(names).toContain("first_name");
    expect(names).toContain("is_active");
    expect(names).toContain("created_at");
  });

  // pg-mem gap: is_nullable returns 'NO' for ALL columns (even nullable ones)
  test("email is not nullable (NOT NULL)", async () => {
    if (!PG_URL) {
      // pg-mem gap: all columns reported as NOT NULL regardless of actual constraint
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const email = snapshot.tables
      .find((t) => t.name === "users")
      ?.columns.find((c) => c.name === "email");
    expect(email?.nullable).toBe(false);
  });

  // pg-mem gap: is_nullable returns 'NO' for ALL columns (even nullable ones)
  test("first_name is nullable (no NOT NULL)", async () => {
    if (!PG_URL) {
      // pg-mem gap: all columns reported as NOT NULL regardless of actual constraint
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const firstName = snapshot.tables
      .find((t) => t.name === "users")
      ?.columns.find((c) => c.name === "first_name");
    expect(firstName?.nullable).toBe(true);
  });

  test("snapshot.views always present (empty for v0.1)", async () => {
    const snapshot = await introspectPostgres(kysely);
    expect(Array.isArray(snapshot.views)).toBe(true);
  });

  // ── Gated on real PG (MIGRATE_TS_PG_URL) ─────────────────────────────────
  // pg-mem gap: varchar(255) loses maxLength, stored as plain "text"

  test("normalizes varchar(255) → text(maxLength=255)", async () => {
    if (!PG_URL) {
      // pg-mem gap: character_maximum_length always null — type fidelity lost
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const email = snapshot.tables
      .find((t) => t.name === "users")
      ?.columns.find((c) => c.name === "email");
    expect(email?.sqlType).toEqual({ kind: "text", maxLength: 255 });
  });

  // pg-mem gap: bigserial → "integer" with no serial/sequence detection
  test("normalizes bigserial → integer{64} with identity=increment", async () => {
    if (!PG_URL) {
      // pg-mem gap: bigserial collapses to "integer", isAutoIncrementing not tracked
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const id = snapshot.tables
      .find((t) => t.name === "users")
      ?.columns.find((c) => c.name === "id");
    expect(id?.sqlType).toEqual({ kind: "integer", bits: 64 });
    expect(id?.identity).toBe("increment");
  });

  // pg-mem gap: column_default always null in information_schema
  test("boolean column has a default value", async () => {
    if (!PG_URL) {
      // pg-mem gap: column_default is always null
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const isActive = snapshot.tables
      .find((t) => t.name === "users")
      ?.columns.find((c) => c.name === "is_active");
    expect(isActive?.sqlType).toEqual({ kind: "boolean" });
    expect(isActive?.nullable).toBe(false);
    expect(isActive?.default).toBeDefined();
  });

  // pg-mem gap: pg_constraint / information_schema.key_column_usage return empty
  test("captures primary key", async () => {
    if (!PG_URL) {
      // pg-mem gap: PK constraint metadata unavailable
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const users = snapshot.tables.find((t) => t.name === "users");
    expect(users?.primaryKey).toEqual(["id"]);
  });
});

// ---------------------------------------------------------------------------
// indexes + FKs
// ---------------------------------------------------------------------------

describe("introspectPostgres — indexes + FKs", () => {
  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool | undefined;

  beforeAll(async () => {
    if (PG_URL) {
      const result = makeRealPgKysely(PG_URL);
      kysely = result.kysely;
      pool = result.pool;
      await sql`DROP TABLE IF EXISTS weeks`.execute(kysely);
      await sql`DROP TABLE IF EXISTS programs`.execute(kysely);
    } else {
      kysely = makePgMemKysely();
    }
    await kysely.schema
      .createTable("programs")
      .addColumn("id", "bigserial", (c) => c.primaryKey())
      .addColumn("slug", "varchar(255)", (c) => c.notNull().unique())
      .execute();
    await kysely.schema
      .createTable("weeks")
      .addColumn("id", "bigserial", (c) => c.primaryKey())
      .addColumn("program_id", "bigint", (c) => c.notNull().references("programs.id"))
      .addColumn("week_number", "integer", (c) => c.notNull())
      .execute();
    await kysely.schema
      .createIndex("weeks_program_id_idx")
      .on("weeks")
      .column("program_id")
      .execute();
  });

  afterAll(async () => {
    if (PG_URL) {
      await sql`DROP TABLE IF EXISTS weeks`.execute(kysely);
      await sql`DROP TABLE IF EXISTS programs`.execute(kysely);
      await pool?.end();
    }
  });

  // pg-mem gap: pg_index / pg_class / pg_namespace / pg_attribute joins not supported
  test("captures unique index from UNIQUE constraint", async () => {
    if (!PG_URL) {
      // pg-mem gap: pg_index catalog joins not supported
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const programs = snapshot.tables.find((t) => t.name === "programs");
    const slugIdx = programs?.indexes.find((i) => i.columns.includes("slug"));
    expect(slugIdx?.unique).toBe(true);
  });

  // pg-mem gap: pg_index / pg_class / pg_namespace / pg_attribute joins not supported
  test("captures non-unique index", async () => {
    if (!PG_URL) {
      // pg-mem gap: pg_index catalog joins not supported
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const weeks = snapshot.tables.find((t) => t.name === "weeks");
    const idx = weeks?.indexes.find((i) => i.name === "weeks_program_id_idx");
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(false);
    expect(idx?.columns).toEqual(["program_id"]);
  });

  // pg-mem gap: information_schema.referential_constraints returns empty rows
  test("captures FK with default actions", async () => {
    if (!PG_URL) {
      // pg-mem gap: information_schema.referential_constraints not supported
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const weeks = snapshot.tables.find((t) => t.name === "weeks");
    expect(weeks?.foreignKeys).toHaveLength(1);
    const fk = weeks?.foreignKeys[0];
    expect(fk?.columns).toEqual(["program_id"]);
    expect(fk?.refTable).toBe("programs");
    expect(fk?.refColumns).toEqual(["id"]);
    // Default PG action is NO ACTION; we normalize to "no-action".
    expect(fk?.onDelete ?? "no-action").toBe("no-action");
  });

  // pg-mem gap: pg_index catalog joins not supported
  test("PK index is NOT reported as a regular index", async () => {
    if (!PG_URL) {
      // pg-mem gap: pg_index catalog joins not supported
      return; // skip
    }
    const snapshot = await introspectPostgres(kysely);
    const programs = snapshot.tables.find((t) => t.name === "programs");
    // Only the slug unique index, not the PK index.
    const pkIdx = programs?.indexes.find((i) => i.columns.length === 1 && i.columns[0] === "id");
    expect(pkIdx).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pgTypeToSqlType — pure unit tests, no DB needed
// ---------------------------------------------------------------------------

describe("pgTypeToSqlType normalization", () => {
  test("character varying(255) → text(255)", () => {
    expect(pgTypeToSqlType("character varying(255)")).toEqual({ kind: "text", maxLength: 255 });
  });

  test("varchar(120) → text(120)", () => {
    expect(pgTypeToSqlType("varchar(120)")).toEqual({ kind: "text", maxLength: 120 });
  });

  test("character varying (unbounded) → text", () => {
    expect(pgTypeToSqlType("character varying")).toEqual({ kind: "text" });
  });

  test("text → text", () => {
    expect(pgTypeToSqlType("text")).toEqual({ kind: "text" });
  });

  test("int8 → integer{64}", () => {
    expect(pgTypeToSqlType("int8")).toEqual({ kind: "integer", bits: 64 });
  });

  test("bigint → integer{64}", () => {
    expect(pgTypeToSqlType("bigint")).toEqual({ kind: "integer", bits: 64 });
  });

  test("bigserial → integer{64}", () => {
    expect(pgTypeToSqlType("bigserial")).toEqual({ kind: "integer", bits: 64 });
  });

  test("int4 → integer{32}", () => {
    expect(pgTypeToSqlType("int4")).toEqual({ kind: "integer", bits: 32 });
  });

  test("integer → integer{32}", () => {
    expect(pgTypeToSqlType("integer")).toEqual({ kind: "integer", bits: 32 });
  });

  test("bool → boolean", () => {
    expect(pgTypeToSqlType("bool")).toEqual({ kind: "boolean" });
  });

  test("boolean → boolean", () => {
    expect(pgTypeToSqlType("boolean")).toEqual({ kind: "boolean" });
  });

  test("date → date", () => {
    expect(pgTypeToSqlType("date")).toEqual({ kind: "date" });
  });

  test("timestamp → timestamp{withTimezone:false}", () => {
    expect(pgTypeToSqlType("timestamp")).toEqual({ kind: "timestamp", withTimezone: false });
  });

  test("timestamp without time zone → timestamp{withTimezone:false}", () => {
    expect(pgTypeToSqlType("timestamp without time zone")).toEqual({
      kind: "timestamp",
      withTimezone: false,
    });
  });

  test("timestamptz → timestamp{withTimezone:true}", () => {
    expect(pgTypeToSqlType("timestamptz")).toEqual({ kind: "timestamp", withTimezone: true });
  });

  test("timestamp with time zone → timestamp{withTimezone:true}", () => {
    expect(pgTypeToSqlType("timestamp with time zone")).toEqual({
      kind: "timestamp",
      withTimezone: true,
    });
  });

  test("json → json", () => {
    expect(pgTypeToSqlType("json")).toEqual({ kind: "json" });
  });

  test("jsonb → json", () => {
    expect(pgTypeToSqlType("jsonb")).toEqual({ kind: "json" });
  });

  test("bytea → blob", () => {
    expect(pgTypeToSqlType("bytea")).toEqual({ kind: "blob" });
  });

  test("uuid → uuid", () => {
    expect(pgTypeToSqlType("uuid")).toEqual({ kind: "uuid" });
  });

  test("numeric(10,2) → numeric{precision:10,scale:2}", () => {
    expect(pgTypeToSqlType("numeric(10,2)")).toEqual({ kind: "numeric", precision: 10, scale: 2 });
  });

  test("numeric (bare) → numeric", () => {
    expect(pgTypeToSqlType("numeric")).toEqual({ kind: "numeric" });
  });

  test("float4 → real4 (single-precision)", () => {
    expect(pgTypeToSqlType("float4")).toEqual({ kind: "real4" });
  });

  test("real (pg alias for float4) → real4 (single-precision)", () => {
    expect(pgTypeToSqlType("real")).toEqual({ kind: "real4" });
  });

  test("double precision → real (double-precision)", () => {
    expect(pgTypeToSqlType("double precision")).toEqual({ kind: "real" });
  });

  test("float8 (pg alias for double precision) → real (double-precision)", () => {
    expect(pgTypeToSqlType("float8")).toEqual({ kind: "real" });
  });

  test("unknown type falls back to text", () => {
    expect(pgTypeToSqlType("citext")).toEqual({ kind: "text" });
  });
});

// ---------------------------------------------------------------------------
// parsePgDefault — pure unit tests, no DB needed
// ---------------------------------------------------------------------------

describe("parsePgDefault", () => {
  test("undefined → undefined", () => {
    expect(parsePgDefault(undefined)).toBeUndefined();
  });

  test("empty string → undefined", () => {
    expect(parsePgDefault("")).toBeUndefined();
  });

  test("now() → expr", () => {
    expect(parsePgDefault("now()")).toEqual({ kind: "expr", value: "now()" });
  });

  test("CURRENT_TIMESTAMP → expr", () => {
    expect(parsePgDefault("CURRENT_TIMESTAMP")).toEqual({
      kind: "expr",
      value: "CURRENT_TIMESTAMP",
    });
  });

  test("nextval('seq') → expr", () => {
    expect(parsePgDefault("nextval('users_id_seq'::regclass)")).toEqual({
      kind: "expr",
      value: "nextval('users_id_seq'::regclass)",
    });
  });

  test("'true'::boolean → literal{value:'true'}", () => {
    expect(parsePgDefault("'true'::boolean")).toEqual({ kind: "literal", value: "true" });
  });

  test("'hello'::text → literal{value:'hello'}", () => {
    expect(parsePgDefault("'hello'::text")).toEqual({ kind: "literal", value: "hello" });
  });

  test("'42'::integer → literal{value:'42'}", () => {
    expect(parsePgDefault("'42'::integer")).toEqual({ kind: "literal", value: "42" });
  });

  test("bare 'world' (no cast) → literal{value:'world'}", () => {
    expect(parsePgDefault("'world'")).toEqual({ kind: "literal", value: "world" });
  });
});

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

describe("introspectPostgres — views", () => {
  // pg-mem may not support CREATE VIEW — gate this test on MIGRATE_TS_PG_URL.
  test("captures view names", async () => {
    if (!PG_URL) {
      // pg-mem may not support CREATE VIEW — skip
      return;
    }
    const { kysely, pool } = makeRealPgKysely(PG_URL);
    try {
      await sql`DROP VIEW IF EXISTS order_summary`.execute(kysely);
      await sql`DROP TABLE IF EXISTS orders`.execute(kysely);
      await kysely.schema.createTable("orders").addColumn("id", "bigserial").execute();
      await sql`CREATE VIEW order_summary AS SELECT id FROM orders`.execute(kysely as never);
      const snapshot = await introspectPostgres(kysely);
      expect(snapshot.views.map((v) => v.name)).toContain("order_summary");
    } finally {
      await sql`DROP VIEW IF EXISTS order_summary`.execute(kysely);
      await sql`DROP TABLE IF EXISTS orders`.execute(kysely);
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

describe("introspect — dispatcher", () => {
  test("dispatches to introspectPostgres for dialect 'postgres'", async () => {
    const kysely = makePgMemKysely();
    await kysely.schema.createTable("t").addColumn("id", "integer", (c) => c.primaryKey()).execute();
    const snapshot = await introspect(kysely, "postgres");
    expect(snapshot.tables.find((t) => t.name === "t")).toBeDefined();
  });
});
