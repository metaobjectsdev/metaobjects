/**
 * Pure-unit coverage for the Postgres introspection helpers. These are exported
 * precisely so they can be tested WITHOUT a live database — the pg-mem-backed
 * tests can't exercise them (pg-mem returns null for column_default and type
 * metadata), and the real-Postgres round-trip tests are gated on
 * MIGRATE_TS_PG_URL. This file pins the `--from-db` type/default mapping that
 * migration correctness rides on.
 */
import { test, expect, describe } from "bun:test";
import { pgTypeToSqlType, parsePgDefault } from "../../src/introspect/postgres.js";

describe("pgTypeToSqlType", () => {
  test("integer family maps to the modeled bit width (smallint folds into 32)", () => {
    expect(pgTypeToSqlType("bigint")).toEqual({ kind: "integer", bits: 64 });
    expect(pgTypeToSqlType("int8")).toEqual({ kind: "integer", bits: 64 });
    expect(pgTypeToSqlType("bigserial")).toEqual({ kind: "integer", bits: 64 });
    expect(pgTypeToSqlType("integer")).toEqual({ kind: "integer", bits: 32 });
    expect(pgTypeToSqlType("serial")).toEqual({ kind: "integer", bits: 32 });
    expect(pgTypeToSqlType("smallint")).toEqual({ kind: "integer", bits: 32 });
  });

  test("varchar carries maxLength inline or from the separate column", () => {
    expect(pgTypeToSqlType("character varying(255)")).toEqual({ kind: "text", maxLength: 255 });
    expect(pgTypeToSqlType("varchar(64)")).toEqual({ kind: "text", maxLength: 64 });
    // bare varchar + separate maxLength column
    expect(pgTypeToSqlType("character varying", 100)).toEqual({ kind: "text", maxLength: 100 });
    // bare varchar with no length info → plain text
    expect(pgTypeToSqlType("character varying")).toEqual({ kind: "text" });
    expect(pgTypeToSqlType("text")).toEqual({ kind: "text" });
  });

  test("numeric carries precision/scale when present", () => {
    expect(pgTypeToSqlType("numeric(10,2)")).toEqual({ kind: "numeric", precision: 10, scale: 2 });
    expect(pgTypeToSqlType("numeric(8)")).toEqual({ kind: "numeric", precision: 8 });
    expect(pgTypeToSqlType("numeric")).toEqual({ kind: "numeric" });
    expect(pgTypeToSqlType("decimal(12,4)")).toEqual({ kind: "numeric", precision: 12, scale: 4 });
  });

  test("floating point distinguishes single vs double precision", () => {
    expect(pgTypeToSqlType("real")).toEqual({ kind: "real4" });
    expect(pgTypeToSqlType("float4")).toEqual({ kind: "real4" });
    expect(pgTypeToSqlType("double precision")).toEqual({ kind: "real" });
    expect(pgTypeToSqlType("float8")).toEqual({ kind: "real" });
  });

  test("temporal types carry timezone awareness", () => {
    expect(pgTypeToSqlType("date")).toEqual({ kind: "date" });
    expect(pgTypeToSqlType("timestamp without time zone")).toEqual({ kind: "timestamp", withTimezone: false });
    expect(pgTypeToSqlType("timestamptz")).toEqual({ kind: "timestamp", withTimezone: true });
    expect(pgTypeToSqlType("timestamp with time zone")).toEqual({ kind: "timestamp", withTimezone: true });
  });

  test("boolean, json, binary, uuid", () => {
    expect(pgTypeToSqlType("boolean")).toEqual({ kind: "boolean" });
    expect(pgTypeToSqlType("jsonb")).toEqual({ kind: "json" });
    expect(pgTypeToSqlType("json")).toEqual({ kind: "json" });
    expect(pgTypeToSqlType("bytea")).toEqual({ kind: "blob" });
    expect(pgTypeToSqlType("uuid")).toEqual({ kind: "uuid" });
  });

  test("unknown / user-defined types fall back to text (don't blow up)", () => {
    expect(pgTypeToSqlType("citext")).toEqual({ kind: "text" });
    expect(pgTypeToSqlType("ltree")).toEqual({ kind: "text" });
    expect(pgTypeToSqlType("my_custom_enum")).toEqual({ kind: "text" });
  });

  test("type matching is case-insensitive and trims", () => {
    expect(pgTypeToSqlType("  BIGINT ")).toEqual({ kind: "integer", bits: 64 });
    expect(pgTypeToSqlType("TIMESTAMPTZ")).toEqual({ kind: "timestamp", withTimezone: true });
  });
});

describe("parsePgDefault", () => {
  test("absent default → undefined", () => {
    expect(parsePgDefault(null)).toBeUndefined();
    expect(parsePgDefault(undefined)).toBeUndefined();
    expect(parsePgDefault("")).toBeUndefined();
  });

  test("function/keyword expressions are kind=expr (verbatim)", () => {
    expect(parsePgDefault("now()")).toEqual({ kind: "expr", value: "now()" });
    expect(parsePgDefault("CURRENT_TIMESTAMP")).toEqual({ kind: "expr", value: "CURRENT_TIMESTAMP" });
    expect(parsePgDefault("CURRENT_DATE")).toEqual({ kind: "expr", value: "CURRENT_DATE" });
    expect(parsePgDefault("nextval('users_id_seq'::regclass)")).toEqual({
      kind: "expr",
      value: "nextval('users_id_seq'::regclass)",
    });
  });

  test("quoted literals strip the ::type cast and the surrounding quotes", () => {
    expect(parsePgDefault("'hi'::text")).toEqual({ kind: "literal", value: "hi" });
    expect(parsePgDefault("'true'::boolean")).toEqual({ kind: "literal", value: "true" });
    expect(parsePgDefault("'42'::integer")).toEqual({ kind: "literal", value: "42" });
    // no trailing cast
    expect(parsePgDefault("'plain'")).toEqual({ kind: "literal", value: "plain" });
  });

  test("a bare non-quoted value with a :: cast is a complex expression", () => {
    expect(parsePgDefault("NULL::text")).toEqual({ kind: "expr", value: "NULL::text" });
    expect(parsePgDefault("ARRAY[]::text[]")).toEqual({ kind: "expr", value: "ARRAY[]::text[]" });
  });

  test("a bare literal with no quotes and no cast is kind=literal", () => {
    expect(parsePgDefault("42")).toEqual({ kind: "literal", value: "42" });
  });
});
