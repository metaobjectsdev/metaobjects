// Hono twin of the read-only mount's itemRoutes / resource tests (drizzle-fastify/mount-read-only.test.ts).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteView, integer } from "drizzle-orm/sqlite-core";
import { mountReadOnlyCrudRoutes, type MountReadOnlyOptions } from "../../src/hono/mount-read-only.js";

describe("hono mountReadOnlyCrudRoutes — itemRoutes / resource", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE sales (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)`);
    await client.execute(`CREATE VIEW v_totals AS SELECT id, amount FROM sales`);
    await client.execute(`INSERT INTO sales (id, amount) VALUES (1, 10), (2, 20)`);
  });

  afterAll(() => {
    client.close();
  });

  function mountView(opts: Partial<MountReadOnlyOptions>): Hono {
    const app = new Hono();
    mountReadOnlyCrudRoutes({
      app,
      path: "/totals",
      db: drizzle(client),
      view: sqliteView("v_totals", {
        id: integer("id").notNull(),
        amount: integer("amount").notNull(),
      }).existing(),
      filterAllowlist: {},
      sortAllowlist: {},
      dialect: "sqlite",
      ...opts,
    });
    return app;
  }

  test("itemRoutes: false mounts no /:id route of any verb", async () => {
    const app = mountView({ itemRoutes: false, resource: "report" });
    expect((await app.request("/totals")).status).toBe(200);
    for (const method of ["GET", "PATCH", "PUT", "DELETE"]) {
      expect((await app.request("/totals/1", { method })).status).toBe(404);
    }
    const post = await app.request("/totals", { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    const body = (await post.json()) as { error: string; message: string };
    expect(body.error).toBe("method_not_allowed");
    expect(body.message).toContain("report");
  });

  test("the default still mounts GET :id and the three item refusals", async () => {
    const app = mountView({});
    expect((await app.request("/totals/1")).status).toBe(200);
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      expect((await app.request("/totals/1", { method })).status).toBe(405);
    }
    const post = await app.request("/totals", { method: "POST", body: "{}" });
    const body = (await post.json()) as { message: string };
    expect(body.message).toBe("POST is not supported on a projection (read-only).");
  });
});
