// A filter value that cannot be the field's type is a 400, not a silent `[]`.
//
// Reproduced against a generated app: `GET /api/books?filter[publishedOn][gte]=notadate`
// answered 200 with `[]`. SQLite compared the string 'notadate' against ISO date text,
// matched nothing, and the caller could not tell a typo from an empty result. (On
// Postgres the same request is a driver error — a 500.) The parser now checks the value
// against the field's wire format before it reaches SQL and answers the cross-port
// `invalid_filter_value` envelope, naming the field, the op and the expected format —
// the same shape the number and boolean checks already had.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/drizzle-fastify/index.js";
import { mountCrudRoutes as mountHonoCrudRoutes } from "../../src/hono/index.js";
import { parseFilterParams, FilterParseError } from "../../src/drizzle-fastify/filter-parser.js";
import type { FilterAllowlist, SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

const books = sqliteTable("books", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  title:       text("title").notNull(),
  genre:       text("genre", { enum: ["fiction", "poetry"] }).notNull(),
  publishedOn: text("published_on"),
  opensAt:     text("opens_at"),
  updatedAt:   text("updated_at"),
  externalId:  text("external_id"),
  pageCount:   integer("page_count"),
  inPrint:     integer("in_print", { mode: "boolean" }),
});

const CMP = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"] as const;
const STR = ["eq", "ne", "in", "like", "isNull"] as const;
const filterAllowlist: FilterAllowlist = {
  title:       { ops: STR, subType: "string", leadingWildcard: false },
  genre:       { ops: STR, subType: "string", leadingWildcard: false, enumValues: ["fiction", "poetry"] },
  publishedOn: { ops: CMP, subType: "datetime", leadingWildcard: false, format: "date" },
  opensAt:     { ops: CMP, subType: "datetime", leadingWildcard: false, format: "time" },
  updatedAt:   { ops: CMP, subType: "datetime", leadingWildcard: false, format: "timestamp" },
  externalId:  { ops: STR, subType: "string", leadingWildcard: false, format: "uuid" },
  pageCount:   { ops: CMP, subType: "number", leadingWildcard: false },
  inPrint:     { ops: ["eq", "isNull"], subType: "boolean", leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = {};

function parse(filter: Record<string, unknown>, allowlist: FilterAllowlist = filterAllowlist) {
  return parseFilterParams({ query: { filter }, table: books, allowlist, sortAllowlist, dialect: "sqlite" });
}

function rejection(filter: Record<string, unknown>, allowlist?: FilterAllowlist): FilterParseError {
  try {
    parse(filter, allowlist);
  } catch (e) {
    if (e instanceof FilterParseError) return e;
    throw e;
  }
  throw new Error(`expected ${JSON.stringify(filter)} to be rejected`);
}

describe("filter values are checked against the field's wire format", () => {
  const bad: Array<[string, string, string, RegExp]> = [
    ["publishedOn", "gte", "notadate",            /date/],
    ["publishedOn", "eq",  "2026-02-30",          /date/],   // not a calendar date
    ["publishedOn", "eq",  "2023-02-29",          /date/],   // not a leap year
    ["publishedOn", "eq",  "1900-02-29",          /date/],   // a century, not /400
    ["publishedOn", "eq",  "2026-04-31",          /date/],   // a 30-day month
    ["updatedAt",   "gte", "2020-02-30T10:00:00Z", /timestamp/], // a timestamp's date part too
    ["publishedOn", "eq",  "2026-01-01T00:00:00Z", /date/],  // a timestamp is not a date
    ["publishedOn", "in",  "2026-01-01,nope",     /date/],   // every element of an in-list
    ["publishedOn", "lt",  "",                    /date/],
    ["opensAt",     "gt",  "25:00",               /time/],
    ["opensAt",     "gt",  "noon",                /time/],
    ["updatedAt",   "gte", "yesterday",           /timestamp/],
    ["updatedAt",   "gte", "2026-13-01T00:00:00Z", /timestamp/],
    ["externalId",  "eq",  "not-a-uuid",          /uuid/],
    ["genre",       "eq",  "romance",             /fiction/],
    ["genre",       "in",  "fiction,romance",     /fiction/],
    ["pageCount",   "gt",  "many",                /number/],
    ["pageCount",   "gt",  "",                    /number/],
    ["inPrint",     "eq",  "maybe",               /boolean/],
  ];
  for (const [field, op, value, expected] of bad) {
    test(`${field} ${op} ${JSON.stringify(value)} → filter.invalid_value naming field, op and format`, () => {
      const e = rejection({ [field]: { [op]: value } });
      expect(e.code).toBe("filter.invalid_value");
      expect(e.details?.["field"]).toBe(field);
      expect(e.details?.["op"]).toBe(op);
      expect(String(e.details?.["expected"])).toMatch(expected);
    });
  }

  const good: Array<[string, string, string]> = [
    ["publishedOn", "gte", "2026-01-01"],
    ["publishedOn", "in",  "2026-01-01,2024-02-29"],
    ["publishedOn", "eq",  "2000-02-29"],                // a /400 century IS a leap year
    ["updatedAt",   "gte", "2024-02-29T23:59:59Z"],
    ["opensAt",     "gt",  "09:30"],
    ["opensAt",     "gt",  "09:30:15.250"],
    ["updatedAt",   "gte", "2026-05-25T14:30:00Z"],
    ["updatedAt",   "gte", "2026-05-25T14:30:00.123+02:00"],
    ["updatedAt",   "lt",  "2026-05-25T14:30:00"],       // an @localTime wall clock
    ["updatedAt",   "lt",  "2026-05-25"],                // a day bound on a timestamp
    ["externalId",  "eq",  "0b5b3c1e-8d0a-4f6e-9a57-3a0c1e2d4f60"],
    ["externalId",  "like", "0b5b%"],                    // a pattern, not a value
    ["genre",       "in",  "fiction,poetry"],
    ["genre",       "like", "fic%"],
    ["pageCount",   "gte", "300"],
    ["inPrint",     "eq",  "true"],
  ];
  for (const [field, op, value] of good) {
    test(`${field} ${op} ${JSON.stringify(value)} is accepted`, () => {
      expect(parse({ [field]: { [op]: value } }).where).toBeDefined();
    });
  }

  test("isNull still takes true/false whatever the field's format", () => {
    expect(parse({ publishedOn: { isNull: "true" } }).where).toBeDefined();
    expect(rejection({ publishedOn: { isNull: "maybe" } }).details?.["expected"]).toBe("boolean");
  });

  test("an allowlist generated before `format` existed still rejects a value no temporal type accepts", () => {
    const legacy: FilterAllowlist = { publishedOn: { ops: CMP, subType: "datetime", leadingWildcard: false } };
    expect(rejection({ publishedOn: { gte: "notadate" } }, legacy).details?.["field"]).toBe("publishedOn");
    for (const ok of ["2026-01-01", "09:30:00", "2026-01-01T09:30:00Z"]) {
      expect(parse({ publishedOn: { gte: ok } }, legacy).where).toBeDefined();
    }
  });

  test("an enum rule without enumValues falls back to the Drizzle column's own enum", () => {
    const legacy: FilterAllowlist = { genre: { ops: STR, subType: "string", leadingWildcard: false } };
    expect(rejection({ genre: { eq: "romance" } }, legacy).details?.["allowed"]).toEqual(["fiction", "poetry"]);
  });
});

describe("over HTTP — the reviewer's request, on both mounts", () => {
  let client: Client;
  let fastify: FastifyInstance;
  let hono: Hono;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, genre TEXT NOT NULL, published_on TEXT, opens_at TEXT, updated_at TEXT, external_id TEXT, page_count INTEGER, in_print INTEGER)`);
    await client.execute(`INSERT INTO books (title, genre, published_on) VALUES ('A', 'fiction', '2020-01-01'), ('B', 'poetry', '2026-03-01')`);
    const db = drizzle(client);
    const schema = z.object({ title: z.string() });
    const common = { path: "/books", db, table: books, insertSchema: schema, updateSchema: schema.partial(), filterAllowlist, sortAllowlist, dialect: "sqlite" as const };
    fastify = Fastify();
    mountCrudRoutes({ fastify, ...common });
    await fastify.ready();
    hono = new Hono();
    mountHonoCrudRoutes({ app: hono, ...common });
  });

  afterAll(async () => {
    await fastify.close();
    client.close();
  });

  const expected = {
    error: "invalid_filter_value",
    field: "publishedOn",
    op: "gte",
    expected: "date (YYYY-MM-DD)",
  };

  test("fastify: filter[publishedOn][gte]=notadate → 400 invalid_filter_value", async () => {
    const r = await fastify.inject({ method: "GET", url: "/books?filter[publishedOn][gte]=notadate" });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual(expected);
  });

  test("hono: filter[publishedOn][gte]=notadate → 400 invalid_filter_value", async () => {
    const res = await hono.request("/books?filter[publishedOn][gte]=notadate");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expected);
  });

  test("a well-formed date still filters", async () => {
    const r = await fastify.inject({ method: "GET", url: "/books?filter[publishedOn][gte]=2025-01-01" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).map((b: { title: string }) => b.title)).toEqual(["B"]);
  });
});
