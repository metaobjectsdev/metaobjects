// A duration operand that parses but is past 64 bits of microseconds is a bad filter value: a
// 400 `invalid_filter_value`, never an error thrown out of the binder (a 500).

import { describe, test, expect, beforeAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/drizzle-fastify/index.js";
import type { FilterAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

const timers = sqliteTable("timers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  timeout: integer("timeout").notNull(),
});
const InsertSchema = z.object({ label: z.string(), timeout: z.number().int() });
const DURATION_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"] as const;
const filterAllowlist: FilterAllowlist = {
  timeout: { ops: DURATION_OPS, subType: "string", leadingWildcard: false, format: "duration" },
};

let app: FastifyInstance;
beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute("CREATE TABLE timers (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, timeout INTEGER NOT NULL)");
  await client.execute("INSERT INTO timers (label, timeout) VALUES ('hour', 3600000000)");
  app = Fastify();
  mountCrudRoutes({
    fastify: app, path: "/timers", db: drizzle(client), table: timers,
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    filterAllowlist, sortAllowlist: {}, dialect: "sqlite",
  });
  await app.ready();
});

describe("a duration filter operand past the 64-bit microsecond range", () => {
  test("in range: compared as the span", async () => {
    const r = await app.inject({ method: "GET", url: "/timers?filter[timeout][gt]=PT30M" });
    expect(r.statusCode).toBe(200);
    expect((JSON.parse(r.body) as Array<{ label: string }>).map((x) => x.label)).toEqual(["hour"]);
  });

  test("out of range: 400 invalid_filter_value, not a 500", async () => {
    const r = await app.inject({ method: "GET", url: "/timers?filter[timeout][gt]=PT9999999999999H" });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("invalid_filter_value");
  });
});
