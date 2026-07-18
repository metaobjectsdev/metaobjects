/**
 * #214 write-through entity — the generated REST routes must READ through the
 * replica VIEW so a derived (origin.passthrough) field is present in the HTTP
 * response (read-your-writes), while WRITES still target the base table (which
 * excludes the derived column, per #213).
 *
 * The bug: mountCrudRoutes had no view concept — every verb read/wrote
 * `opts.table`, so a write-through entity's GET/POST responses OMITTED the
 * derived field. This pins the fix: a `readView` option routes reads (list, get,
 * and the post-write re-read on create/update) through the view.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/drizzle-fastify/index.js";

// The writable base table — NO derived column (customerName lives only in the view).
const ordersTable = () =>
  sqliteTable("orders", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: integer("customer_id").notNull(),
  });

// The read replica view — carries the derived customerName from the Customer join.
const orderView = () =>
  sqliteView("v_order_with_customer", {
    id: integer("id").notNull(),
    customerId: integer("customer_id").notNull(),
    customerName: text("customer_name").notNull(),
  }).existing();

const InsertSchema = z.object({ customerId: z.number() });
const UpdateSchema = InsertSchema.partial();

describe("mountCrudRoutes write-through — reads route through the replica view (#214)", () => {
  let client: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    await client.execute(
      `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL)`,
    );
    await client.execute(
      `CREATE VIEW v_order_with_customer AS
         SELECT o.id AS id, o.customer_id AS customer_id, c.name AS customer_name
         FROM orders o JOIN customers c ON o.customer_id = c.id`,
    );
    await client.execute(`INSERT INTO customers (id, name) VALUES (1, 'Acme')`);
    const db = drizzle(client);
    app = Fastify();
    mountCrudRoutes({
      fastify: app,
      path: "/orders",
      db,
      table: ordersTable(),
      readView: orderView(),
      insertSchema: InsertSchema,
      updateSchema: UpdateSchema,
      dialect: "sqlite",
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    client.close();
  });

  test("POST create re-reads through the view → response carries the derived customerName", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: 1 }),
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body);
    expect(body.customerId).toBe(1);
    expect(body.customerName).toBe("Acme"); // derived field present (read-your-writes)
  });

  test("GET :id reads through the view → carries the derived customerName", async () => {
    const created = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/orders",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerId: 1 }),
        })
      ).body,
    );
    const g = await app.inject({ method: "GET", url: `/orders/${created.id}` });
    expect(g.statusCode).toBe(200);
    expect(JSON.parse(g.body).customerName).toBe("Acme");
  });

  test("GET list reads through the view → every row carries the derived customerName", async () => {
    const l = await app.inject({ method: "GET", url: "/orders" });
    expect(l.statusCode).toBe(200);
    const rows = JSON.parse(l.body) as Array<{ customerName?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.customerName === "Acme")).toBe(true);
  });

  test("PATCH re-reads through the view → response carries the derived customerName", async () => {
    await client.execute(`INSERT INTO customers (id, name) VALUES (2, 'Globex')`);
    const created = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/orders",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerId: 1 }),
        })
      ).body,
    );
    const p = await app.inject({
      method: "PATCH",
      url: `/orders/${created.id}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: 2 }),
    });
    expect(p.statusCode).toBe(200);
    expect(JSON.parse(p.body).customerName).toBe("Globex");
  });

  test("writes still target the TABLE — the orders table has no derived column", async () => {
    const cols = await client.execute(`PRAGMA table_info(orders)`);
    expect((cols.rows as unknown as Array<{ name: string }>).map((c) => c.name).sort()).toEqual([
      "customer_id",
      "id",
    ]);
  });
});
