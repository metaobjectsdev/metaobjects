// Timestamp filters with UTC offsets on SQLite, where a string-mode field.timestamp is TEXT
// and compares as text.
//
// Reported against 1.0.9-rc.3: POST `"tastedAt":"2026-09-21T01:00:00+05:00"` (= 20:00Z),
// then `filter[tastedAt][gt]=2026-09-20T21:00:00Z` returned it — the offset was stored as
// sent and `"2026-09-21T01…" > "2026-09-20T21…"` as text. The generated insert/update
// schemas now store a zoned value in its `toISOString()` spelling (codegen-ts
// zod-validators-execution.test.ts pins that), and the filter parser rewrites a zoned
// bound the same way. The schema below is the generated one's shape for a required,
// filterable field.timestamp: the format check, then the same zoned-to-UTC rewrite.

import { describe, test, expect, beforeAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/drizzle-fastify/index.js";
import { utcIsoIfZoned } from "../../src/drizzle-fastify/filter-value-format.js";
import type { FilterAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

const notes = sqliteTable("tasting_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  tastedAt: text("tasted_at").notNull(),
});

const tastedAt = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "must be an ISO 8601 timestamp")
  .transform(utcIsoIfZoned);
const InsertSchema = z.object({ label: z.string(), tastedAt });
const UpdateSchema = z.object({ label: z.string().optional(), tastedAt: tastedAt.optional() });

const filterAllowlist: FilterAllowlist = {
  tastedAt: {
    ops: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
    subType: "datetime",
    leadingWildcard: false,
    format: "timestamp",
  },
};

let app: FastifyInstance;
beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute(
    "CREATE TABLE tasting_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, tasted_at TEXT NOT NULL)",
  );
  app = Fastify();
  mountCrudRoutes({
    fastify: app, path: "/notes", db: drizzle(client), table: notes,
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    filterAllowlist, sortAllowlist: {}, dialect: "sqlite",
  });
  await app.ready();
  for (const [label, at] of [["A", "2026-09-21T01:00:00+05:00"], ["B", "2026-09-20T22:00:00Z"]]) {
    const r = await app.inject({ method: "POST", url: "/notes", payload: { label, tastedAt: at } });
    expect(r.statusCode).toBe(201);
  }
});

async function labels(query: string): Promise<string[]> {
  const r = await app.inject({ method: "GET", url: `/notes?${query}` });
  expect(r.statusCode).toBe(200);
  return (JSON.parse(r.body) as Array<{ label: string }>).map((n) => n.label).sort();
}

const q = (op: string, v: string) => `filter[tastedAt][${op}]=${encodeURIComponent(v)}`;

describe("timestamp filters compare instants, not offset-bearing text (SQLite)", () => {
  test("the offset-bearing row is stored in UTC", async () => {
    const r = await app.inject({ method: "GET", url: "/notes" });
    const a = (JSON.parse(r.body) as Array<{ label: string; tastedAt: string }>).find((n) => n.label === "A");
    expect(a?.tastedAt).toBe("2026-09-20T20:00:00Z");
  });

  test("gt a Z bound excludes the earlier-instant row sent with +05:00 (the reported case)", async () => {
    expect(await labels(q("gt", "2026-09-20T21:00:00Z"))).toEqual(["B"]);
  });

  test("an offset on the FILTER side is normalized too", async () => {
    // 2026-09-21T02:30:00+05:00 = 21:30Z
    expect(await labels(q("gt", "2026-09-21T02:30:00+05:00"))).toEqual(["B"]);
    // 2026-09-20T16:30:00-04:00 = 20:30Z
    expect(await labels(q("lt", "2026-09-20T16:30:00-04:00"))).toEqual(["A"]);
  });

  test("eq matches the same instant in any spelling", async () => {
    expect(await labels(q("eq", "2026-09-20T20:00:00Z"))).toEqual(["A"]);
    expect(await labels(q("eq", "2026-09-21T01:00:00+05:00"))).toEqual(["A"]);
    expect(await labels(q("in", "2026-09-21T01:00:00+05:00,2026-09-20T22:00:00Z"))).toEqual(["A", "B"]);
  });
});

describe("a failed format check answers its message, never the regex source", () => {
  // Zod 4 puts the regex source on a `.regex()` issue as `pattern`; for a generated
  // date/timestamp check that is a ~300-character calendar regex, and an authored
  // validator.regex pattern is the server's own business. The message says what is expected.
  test("POST with a malformed timestamp → 400 with the message and no pattern", async () => {
    const r = await app.inject({ method: "POST", url: "/notes", payload: { label: "C", tastedAt: "tomorrow" } });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body) as { error: string; issues: Array<Record<string, unknown>> };
    expect(body.error).toBe("validation");
    expect(body.issues[0]?.["message"]).toBe("must be an ISO 8601 timestamp");
    expect(body.issues[0]?.["path"]).toEqual(["tastedAt"]);
    expect(body.issues.some((i) => "pattern" in i)).toBe(false);
    expect(r.body).not.toContain("\\\\d{4}");
  });

  test("PATCH answers the same way", async () => {
    const r = await app.inject({ method: "PATCH", url: "/notes/1", payload: { tastedAt: "tomorrow" } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain("pattern");
  });
});

describe("utcIsoIfZoned", () => {
  test("rewrites zoned values to toISOString form", () => {
    expect(utcIsoIfZoned("2026-09-21T01:00:00+05:00")).toBe("2026-09-20T20:00:00Z");
    expect(utcIsoIfZoned("2026-09-21 01:00:00+05")).toBe("2026-09-20T20:00:00Z");
    expect(utcIsoIfZoned("2026-09-20 16:30:00.123456-04:30")).toBe("2026-09-20T21:00:00.123Z");
    expect(utcIsoIfZoned("2026-09-20t21:00z")).toBe("2026-09-20T21:00:00Z");
  });

  test("leaves naive and date-only values alone", () => {
    for (const s of ["2026-09-20T21:00:00", "2026-09-20 21:00", "2026-09-20", "not a date"]) {
      expect(utcIsoIfZoned(s)).toBe(s);
    }
  });
});
