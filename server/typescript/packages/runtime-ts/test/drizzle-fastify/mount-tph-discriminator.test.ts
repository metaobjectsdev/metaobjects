// FR-017 Tier 2 — mountCrudRoutes `discriminator` option (per-subtype TPH routes).
//
// A per-subtype route set is scoped to one subtype of a single-table-inheritance
// base: reads are filtered to the discriminator value, a get/update/delete that
// targets a row of another subtype 404s, create injects the discriminator value
// (the body omits it), and update strips the discriminator (a row's subtype is
// immutable).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/drizzle-fastify/index.js";

describe("mountCrudRoutes — TPH discriminator scoping", () => {
  let fastify: FastifyInstance;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`
      CREATE TABLE auths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        quantity INTEGER,
        copay_amount TEXT
      );
    `);
    await client.execute(
      `INSERT INTO auths (id, type, quantity, copay_amount) VALUES (1,'Bridge',5,NULL),(2,'Copay',NULL,'10.00');`,
    );

    const db = drizzle(client);
    const auths = sqliteTable("auths", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      type: text("type").notNull(),
      quantity: integer("quantity"),
      copay_amount: text("copay_amount"),
    });

    // Per-subtype schemas omit the discriminator (the route injects it).
    const bridgeInsert = z.object({ quantity: z.number().int() });
    const bridgeUpdate = z.object({ quantity: z.number().int() }).partial();

    fastify = Fastify();
    mountCrudRoutes({
      fastify,
      path: "/auths/bridge",
      db,
      table: auths,
      insertSchema: bridgeInsert,
      updateSchema: bridgeUpdate,
      discriminator: { column: "type", value: "Bridge" },
    });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    client.close();
  });

  test("GET list is scoped to the discriminator value", async () => {
    const res = await fastify.inject({ method: "GET", url: "/auths/bridge" });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ id: number; type: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("Bridge");
  });

  test("GET :id of a row of ANOTHER subtype 404s", async () => {
    const own = await fastify.inject({ method: "GET", url: "/auths/bridge/1" });
    expect(own.statusCode).toBe(200);
    const cross = await fastify.inject({ method: "GET", url: "/auths/bridge/2" });
    expect(cross.statusCode).toBe(404);
  });

  test("POST injects the discriminator value (body omits it)", async () => {
    const res = await fastify.inject({
      method: "POST", url: "/auths/bridge", payload: { quantity: 7 },
    });
    expect(res.statusCode).toBe(201);
    const row = JSON.parse(res.body) as { type: string; quantity: number };
    expect(row.type).toBe("Bridge");
    expect(row.quantity).toBe(7);
  });

  test("PATCH strips the discriminator and 404s across subtypes", async () => {
    // Cross-subtype update → 404.
    const cross = await fastify.inject({
      method: "PATCH", url: "/auths/bridge/2", payload: { quantity: 9 },
    });
    expect(cross.statusCode).toBe(404);

    // Own update, with a sneaky discriminator in the body — must be stripped.
    const own = await fastify.inject({
      method: "PATCH", url: "/auths/bridge/1", payload: { quantity: 9, type: "Copay" },
    });
    expect(own.statusCode).toBe(200);
    const row = JSON.parse(own.body) as { type: string; quantity: number };
    expect(row.type).toBe("Bridge"); // unchanged
    expect(row.quantity).toBe(9);
  });

  test("DELETE 404s across subtypes", async () => {
    const cross = await fastify.inject({ method: "DELETE", url: "/auths/bridge/2" });
    expect(cross.statusCode).toBe(404);
  });
});
