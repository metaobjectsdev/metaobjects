// rc.21 part B (U2): the text @dbColumnType spellings are the column types `meta migrate` creates;
// an unbounded varchar and text compare as one type, a character(n) as its own.

import { expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { pgType } from "../src/emit/postgres.js";
import { sqliteType } from "../src/emit/sqlite.js";
import { sqlTypeEquals, isWidening } from "../src/sql-type.js";
import { pgTypeToSqlType } from "../src/introspect/postgres.js";
import { sqliteTypeToSqlType } from "../src/introspect/sqlite-shared.js";

test("each spelling is its column type on Postgres and SQLite", async () => {
  const spellings = ["text", "varchar", "character varying", "varchar(12)", "character varying(12)", "character(3)"];
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "R", children: [
      { "source.rdb": { "@table": "r" } }, { "field.long": { name: "id" } },
      ...spellings.map((t, i) => ({ "field.string": { name: `c${i}`, "@dbColumnType": t } })),
      { "identity.primary": { name: "id", "@fields": "id" } } ] } } ] } }))]);
  expect(errors).toEqual([]);
  const cols = buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!.columns.filter((c) => c.name !== "id");
  expect(cols.map((c) => pgType(c.sqlType))).toEqual(["TEXT", "VARCHAR", "VARCHAR", "VARCHAR(12)", "VARCHAR(12)", "CHARACTER(3)"]);
  expect(cols.map((c) => sqliteType(c.sqlType, undefined))).toEqual(["TEXT", "VARCHAR", "VARCHAR", "VARCHAR(12)", "VARCHAR(12)", "CHARACTER(3)"]);
});

test("introspection reads them back to the same types", () => {
  expect(sqlTypeEquals(pgTypeToSqlType("character varying", null), { kind: "text", variant: "varchar" })).toBe(true);
  expect(pgTypeToSqlType("character", 3)).toEqual({ kind: "text", maxLength: 3, variant: "char" });
  expect(sqliteTypeToSqlType("CHARACTER(3)")).toEqual({ kind: "text", maxLength: 3, variant: "char" });
  expect(sqliteTypeToSqlType("VARCHAR")).toEqual({ kind: "text", variant: "varchar" });
});

test("an unbounded varchar equals text; character(n) equals neither, and is no widening", () => {
  expect(sqlTypeEquals({ kind: "text" }, { kind: "text", variant: "varchar" })).toBe(true);
  expect(sqlTypeEquals({ kind: "text", maxLength: 3 }, { kind: "text", maxLength: 3, variant: "char" })).toBe(false);
  expect(isWidening({ kind: "text", maxLength: 3, variant: "char" }, { kind: "text" })).toBe(false);
});
