// Three filter-value defects from a cold review of 1.0.9-rc.4, on SQLite (TEXT timestamps,
// compared as text):
//
//  1. A zoneless or date-only bound on an INSTANT timestamp (not @localTime) was compared as
//     sent. The generated write schema now stores `"2026-10-06"` as
//     `2026-10-06T00:00:00Z` and `"2026-10-06T09:00"` as `2026-10-06T09:00:00Z`, and
//     a rule marked `instant` reads a bound by the same rule. An @localTime wall clock
//     (no `instant`) keeps its bound as sent.
//  2. `filter[dailyRateCents][gte]=40.5` on an integer field answered 200; a rule marked
//     `integer` now answers `invalid_filter_value`.
//  3. `filter[dueAt][lt]=2026-10-06T00:00:00+00:00` sent unencoded arrives with a space for
//     the `+`, and the 400 said only "expected timestamp"; it now carries a `hint`.

import { describe, test, expect, beforeAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/drizzle-fastify/index.js";
import { utcIsoInstant, utcIsoIfZoned } from "../../src/drizzle-fastify/filter-value-format.js";
import type { FilterAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

const rentals = sqliteTable("rentals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  dueAt: text("due_at").notNull(),
  opensAt: text("opens_at").notNull(),
  dailyRateCents: integer("daily_rate_cents").notNull(),
});

// The generated schema's shape: the instant field normalizes to UTC, the wall clock does not.
const InsertSchema = z.object({
  label: z.string(),
  dueAt: z.string().transform(utcIsoInstant),
  opensAt: z.string(),
  dailyRateCents: z.number().int(),
});

const TIMESTAMP_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"] as const;
const filterAllowlist: FilterAllowlist = {
  dueAt: { ops: TIMESTAMP_OPS, subType: "datetime", leadingWildcard: false, format: "timestamp", instant: true },
  opensAt: { ops: TIMESTAMP_OPS, subType: "datetime", leadingWildcard: false, format: "timestamp" },
  dailyRateCents: { ops: TIMESTAMP_OPS, subType: "number", leadingWildcard: false, integer: true },
};

let app: FastifyInstance;
beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute(
    "CREATE TABLE rentals (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, due_at TEXT NOT NULL, opens_at TEXT NOT NULL, daily_rate_cents INTEGER NOT NULL)",
  );
  app = Fastify();
  mountCrudRoutes({
    fastify: app, path: "/rentals", db: drizzle(client), table: rentals,
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    filterAllowlist, sortAllowlist: {}, dialect: "sqlite",
  });
  await app.ready();
  const rows = [
    ["date-only", "2026-10-06", "2026-10-06T09:00", 4000],
    ["zoneless", "2026-10-06T09:00", "2026-10-06T18:00", 4100],
    ["zoned", "2026-10-05T23:00:00-02:00", "2026-10-05T08:00", 3900],
  ] as const;
  for (const [label, dueAt, opensAt, dailyRateCents] of rows) {
    const r = await app.inject({ method: "POST", url: "/rentals", payload: { label, dueAt, opensAt, dailyRateCents } });
    expect(r.statusCode).toBe(201);
  }
});

async function list(query: string): Promise<{ status: number; body: unknown }> {
  const r = await app.inject({ method: "GET", url: `/rentals?${query}` });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
async function labels(query: string): Promise<string[]> {
  const r = await list(query);
  expect(r.status).toBe(200);
  return (r.body as Array<{ label: string }>).map((x) => x.label).sort();
}
const enc = encodeURIComponent;

describe("an instant timestamp: zoneless is UTC, date-only is midnight UTC (SQLite)", () => {
  test("rows are stored in toISOString form", async () => {
    const rows = (await list("")).body as Array<{ label: string; dueAt: string; opensAt: string }>;
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    expect(byLabel.get("date-only")?.dueAt).toBe("2026-10-06T00:00:00Z");
    expect(byLabel.get("zoneless")?.dueAt).toBe("2026-10-06T09:00:00Z");
    expect(byLabel.get("zoned")?.dueAt).toBe("2026-10-06T01:00:00Z");
    // The @localTime-shaped column keeps what was sent.
    expect(byLabel.get("date-only")?.opensAt).toBe("2026-10-06T09:00");
  });

  test("gte a Z midnight bound includes the date-only row (the reported case)", async () => {
    expect(await labels(`filter[dueAt][gte]=${enc("2026-10-06T00:00:00Z")}`)).toEqual(["date-only", "zoned", "zoneless"]);
  });

  test("a zoneless or date-only BOUND is read as UTC too", async () => {
    expect(await labels("filter[dueAt][gte]=2026-10-06")).toEqual(["date-only", "zoned", "zoneless"]);
    expect(await labels("filter[dueAt][lt]=2026-10-06T01:00")).toEqual(["date-only"]);
    expect(await labels("filter[dueAt][eq]=2026-10-06T09:00")).toEqual(["zoneless"]);
    expect(await labels(`filter[dueAt][in]=${enc("2026-10-06,2026-10-06T09:00:00")}`)).toEqual(["date-only", "zoneless"]);
  });

  test("a wall-clock (non-instant) bound is compared as sent", async () => {
    expect(await labels("filter[opensAt][gte]=2026-10-06T09:00")).toEqual(["date-only", "zoneless"]);
  });
});

describe("an integer-valued field refuses a fractional bound", () => {
  test("gte 40.5 → 400 invalid_filter_value with expected", async () => {
    const r = await list("filter[dailyRateCents][gte]=40.5");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: "invalid_filter_value", field: "dailyRateCents", op: "gte", expected: "integer (a whole number)",
    });
  });

  test("an in-list with one fractional member is refused", async () => {
    expect((await list("filter[dailyRateCents][in]=4000,4100.25")).status).toBe(400);
  });

  test("whole numbers still filter", async () => {
    expect(await labels("filter[dailyRateCents][gte]=4000")).toEqual(["date-only", "zoneless"]);
    expect(await labels("filter[dailyRateCents][lt]=4e3")).toEqual(["zoned"]);
  });
});

describe("an unencoded + offset gets a hint", () => {
  test("lt …T00:00:00+00:00 sent raw → 400 with a hint naming %2B", async () => {
    const r = await list("filter[dueAt][lt]=2026-10-06T00:00:00+00:00");
    expect(r.status).toBe(400);
    const body = r.body as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_filter_value");
    expect(body["field"]).toBe("dueAt");
    expect(String(body["hint"])).toContain("%2B");
    expect(String(body["hint"])).toContain("Z");
  });

  test("the same bound encoded works", async () => {
    expect(await labels(`filter[dueAt][lt]=${enc("2026-10-06T00:00:00+00:00")}`)).toEqual([]);
    expect(await labels(`filter[dueAt][lt]=${enc("2026-10-06T02:00:00+00:00")}`)).toEqual(["date-only", "zoned"]);
  });

  test("an unrelated malformed timestamp carries no hint", async () => {
    const r = await list("filter[dueAt][lt]=tomorrow");
    expect(r.status).toBe(400);
    expect(r.body).not.toHaveProperty("hint");
  });
});

describe("utcIsoInstant / utcIsoIfZoned", () => {
  test("utcIsoInstant reads zoneless and date-only values as UTC", () => {
    expect(utcIsoInstant("2026-10-06")).toBe("2026-10-06T00:00:00Z");
    expect(utcIsoInstant("2026-10-06T09:00")).toBe("2026-10-06T09:00:00Z");
    expect(utcIsoInstant("2026-10-06 09:00:00.123456")).toBe("2026-10-06T09:00:00.123Z");
    expect(utcIsoInstant("2026-10-06T01:00:00+05:00")).toBe("2026-10-05T20:00:00Z");
    expect(utcIsoInstant("not a date")).toBe("not a date");
  });

  test("a value already in the canonical UTC spelling is kept byte-for-byte", () => {
    // Same rule as the generated write schema, so a bound copied from a response matches.
    for (const s of ["2026-09-20T12:10:00Z", "2026-09-20T12:10:00.000Z", "2026-09-20T12:10:00.5Z"]) {
      expect(utcIsoInstant(s)).toBe(s);
      expect(utcIsoIfZoned(s)).toBe(s);
    }
    // Non-canonical Z spellings take the canonical form (no trailing zeros).
    expect(utcIsoInstant("2026-09-20 12:10:00.120z")).toBe("2026-09-20T12:10:00.12Z");
    expect(utcIsoInstant("2026-09-20T12:10Z")).toBe("2026-09-20T12:10:00Z");
  });

  test("utcIsoIfZoned leaves zoneless and date-only values alone", () => {
    expect(utcIsoIfZoned("2026-10-06")).toBe("2026-10-06");
    expect(utcIsoIfZoned("2026-10-06T09:00")).toBe("2026-10-06T09:00");
    expect(utcIsoIfZoned("2026-10-06T01:00:00+05:00")).toBe("2026-10-05T20:00:00Z");
  });
});
