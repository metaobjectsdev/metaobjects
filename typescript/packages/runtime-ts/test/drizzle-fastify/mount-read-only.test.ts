import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { mountReadOnlyCrudRoutes } from "../../src/drizzle-fastify/mount-read-only.js";
import type { FilterAllowlist, SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

describe("mountReadOnlyCrudRoutes", () => {
  let fastify: FastifyInstance;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`
      CREATE TABLE programs (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    `);
    await client.execute(`
      CREATE VIEW v_program_summary AS SELECT id, title, 'x' AS extra FROM programs;
    `);
    await client.execute(`INSERT INTO programs (id, title) VALUES (1, 'Alpha'), (2, 'Beta');`);

    const db = drizzle(client);
    const view = sqliteView("v_program_summary", {
      id: integer("id").notNull(),
      title: text("title").notNull(),
      extra: text("extra"),
    }).existing();

    const filterAllowlist: FilterAllowlist = {
      title: { ops: ["eq", "like"], subType: "string", leadingWildcard: true },
    };
    const sortAllowlist: SortAllowlist = { id: { defaultOrder: "asc" } };

    fastify = Fastify();
    mountReadOnlyCrudRoutes({
      fastify,
      path: "/program-summaries",
      db,
      view,
      filterAllowlist,
      sortAllowlist,
      dialect: "sqlite",
    });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    client.close();
  });

  test("GET /program-summaries returns rows", async () => {
    const res = await fastify.inject({ method: "GET", url: "/program-summaries" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
  });

  test("GET /program-summaries/:id returns one row", async () => {
    const res = await fastify.inject({ method: "GET", url: "/program-summaries/1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBe("Alpha");
  });

  test("POST /program-summaries returns 405", async () => {
    const res = await fastify.inject({
      method: "POST", url: "/program-summaries",
      payload: { title: "Gamma" },
    });
    expect(res.statusCode).toBe(405);
  });

  test("PATCH /program-summaries/1 returns 405", async () => {
    const res = await fastify.inject({
      method: "PATCH", url: "/program-summaries/1",
      payload: { title: "Renamed" },
    });
    expect(res.statusCode).toBe(405);
  });

  test("DELETE /program-summaries/1 returns 405", async () => {
    const res = await fastify.inject({ method: "DELETE", url: "/program-summaries/1" });
    expect(res.statusCode).toBe(405);
  });

  test("filter applies via allowlist", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/program-summaries?filter[title]=Alpha",
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Alpha");
  });
});
