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

  // A VIEW's columns count as the entity's fields too: `?extra=x` names one that is not
  // filterable, so it is refused rather than ignored.
  test("a bare view-column parameter that is not filterable → 400 filter.bare_field", async () => {
    const res = await fastify.inject({ method: "GET", url: "/program-summaries?extra=x" });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("filter.bare_field");
    expect(body.field).toBe("extra");
    expect(body.filterable).toBe(false);
    expect(body.allowed).toEqual(["title"]);
  });

  test("?limit=abc → 400 pagination.invalid_value", async () => {
    const res = await fastify.inject({ method: "GET", url: "/program-summaries?limit=abc" });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("pagination.invalid_value");
    expect(body.param).toBe("limit");
  });

  test("bare array contract is unchanged when withCount is absent", async () => {
    const res = await fastify.inject({ method: "GET", url: "/program-summaries" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  test("withCount=1 returns { rows, total } and total reflects the full filtered set", async () => {
    // withCount without a filter — total should be 2 (both rows)
    const res = await fastify.inject({ method: "GET", url: "/program-summaries?withCount=1" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[]; total: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(2);
    expect(body.total).toBe(2);
  });

  test("withCount=1 with filter — total counts the filtered set, not the whole table", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/program-summaries?filter[title]=Alpha&withCount=1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[]; total: number };
    expect(body.rows).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  test("search= filters rows via OR-like across string fields", async () => {
    // "Alpha" only matches the first row by title
    const res = await fastify.inject({
      method: "GET",
      url: "/program-summaries?search=Alpha&withCount=1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect((body.rows[0] as { title: string }).title).toBe("Alpha");
  });

  test("search AND filter combine — intersection of both predicates", async () => {
    // search="Alpha" matches first row; filter[title]=Beta matches second row
    // AND combination → 0 results
    const res = await fastify.inject({
      method: "GET",
      url: "/program-summaries?search=Alpha&filter[title]=Beta&withCount=1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[]; total: number };
    expect(body.total).toBe(0);
  });
});

// An OPAQUE view (empty column map) takes the raw-SQL branch, which pages to at most
// RAW_VIEW_MAX_LIMIT rows. It used to CLAMP a bad bound (`?limit=abc` → 1000, `-5` → 1);
// now a bound that is not an integer in 0..1000 is refused, naming the range.
describe("mountReadOnlyCrudRoutes — raw-SQL (opaque view) page bounds", () => {
  let fastify: FastifyInstance;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    await client.execute(`CREATE VIEW v_things AS SELECT id, name FROM things`);
    await client.execute(`INSERT INTO things (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
    const db = drizzle(client);
    fastify = Fastify();
    mountReadOnlyCrudRoutes({
      fastify, path: "/things", db, view: sqliteView("v_things", {}).existing(),
      filterAllowlist: {}, sortAllowlist: {}, dialect: "sqlite",
    });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    client.close();
  });

  test("a valid limit/offset pages the rows", async () => {
    const res = await fastify.inject({ method: "GET", url: "/things?limit=1&offset=1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ id: 2, name: "b" }]);
  });

  for (const [param, value] of [["limit", "abc"], ["limit", "-5"], ["limit", "1001"], ["offset", "x"]] as const) {
    test(`?${param}=${value} → 400 naming the range`, async () => {
      const res = await fastify.inject({ method: "GET", url: `/things?${param}=${value}` });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("pagination.invalid_value");
      expect(body.param).toBe(param);
      expect(body.expected).toBe(param === "limit" ? "an integer from 0 to 1000" : "a non-negative integer (0 or more)");
    });
  }
});
