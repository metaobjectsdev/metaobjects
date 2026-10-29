// #484: a report that groups by a credential column is served with `hiddenColumns` (the generator
// derives it from the read model), so the list route over HTTP omits the key, on both adapters.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { mountReadOnlyCrudRoutes as mountFastify } from "../src/drizzle-fastify/mount-read-only.js";
import { mountReadOnlyCrudRoutes as mountHono } from "../src/hono/mount-read-only.js";

describe("a report list route hides a credential column", () => {
  let client: ReturnType<typeof createClient>;
  let fastify: FastifyInstance;
  let plain: FastifyInstance;
  let hono: Hono;

  const view = () => sqliteView("v_accounts_by_pin", {
    pinHash: text("pin_hash"),
    accounts: integer("accounts").notNull(),
  }).existing();

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, pin_hash TEXT)`);
    await client.execute(`INSERT INTO accounts (pin_hash) VALUES ('h1'), ('h1'), ('h2')`);
    await client.execute(`CREATE VIEW v_accounts_by_pin AS SELECT pin_hash, COUNT(*) AS accounts FROM accounts GROUP BY pin_hash`);
    const base = { path: "/accounts_by_pins", db: drizzle(client), view: view(), filterAllowlist: {}, sortAllowlist: {}, dialect: "sqlite" as const, itemRoutes: false, resource: "report" as const };

    fastify = Fastify();
    mountFastify({ fastify, ...base, hiddenColumns: ["pinHash"] });
    await fastify.ready();

    plain = Fastify();
    mountFastify({ fastify: plain, ...base });
    await plain.ready();

    hono = new Hono();
    mountHono({ app: hono, ...base, hiddenColumns: ["pinHash"] });
  });

  afterAll(async () => {
    await fastify.close();
    await plain.close();
    client.close();
  });

  const sorted = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => Number(a["accounts"]) - Number(b["accounts"]));

  test("Fastify: every row lacks the key, the measure stays", async () => {
    const res = await fastify.inject({ url: "/accounts_by_pins" });
    expect(res.statusCode).toBe(200);
    expect(sorted(res.json())).toEqual([{ accounts: 1 }, { accounts: 2 }]);
  });

  test("Hono: every row lacks the key, the measure stays", async () => {
    const res = await hono.request("/accounts_by_pins");
    expect(res.status).toBe(200);
    expect(sorted((await res.json()) as Record<string, unknown>[])).toEqual([{ accounts: 1 }, { accounts: 2 }]);
  });

  test("without hiddenColumns the same report serves the column (the exposure this closes)", async () => {
    const res = await plain.inject({ url: "/accounts_by_pins" });
    expect(sorted(res.json())).toEqual([{ pinHash: "h2", accounts: 1 }, { pinHash: "h1", accounts: 2 }]);
  });
});
