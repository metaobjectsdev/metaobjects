// The ObjectManager Fastify mount answers a list query the way the Drizzle and Hono mounts do
// (plan R0): `filter[or]` / `filter[and]`, `?search` that ignores case, a `like` that does not,
// and the same refusals with the same bodies. A real ObjectManager over two drivers (the
// in-memory driver and Kysely on libSQL), no fakes: the parse is shared (`parseListQuery`), so
// what this pins is the OM half, which turns the parsed tree into the ObjectManager's `Filter`.
//
// The expected answers are the ones the generated (Drizzle) routes give for the same model and
// seed in fixtures/api-contract-conformance/list-query/: the rows of this seed whose name
// matches, computed by hand below.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager } from "../../src/object-manager.js";
import { inMemoryDriver, kyselyDriver } from "../../src/drivers/index.js";
import type { PersistenceDriver, Row } from "../../src/persistence-driver.js";
import { mountCrudRoutes } from "../../src/fastify/index.js";
import type { FilterAllowlist, SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::stockroom",
    children: [{
      "object.entity": {
        name: "Part",
        children: [
          { "source.rdb": { "@table": "parts" } },
          { "field.long": { name: "id", "@filterable": true } },
          { "field.string": { name: "name", "@filterable": true } },
          { "field.enum": { name: "category", "@values": ["tool", "part", "kit"], "@filterable": true } },
          { "field.int": { name: "stock", "@filterable": true } },
          { "field.string": { name: "notes" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    }],
  },
});

// The allowlists codegen emits for this model (`<Entity>FilterAllowlist` / `SortAllowlist`).
const FILTERS = {
  id: { ops: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"], subType: "number", leadingWildcard: false, integer: true },
  name: { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string", leadingWildcard: false },
  category: { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string", leadingWildcard: false, enumValues: ["tool", "part", "kit"] },
  stock: { ops: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"], subType: "number", leadingWildcard: false, integer: true },
} as const satisfies FilterAllowlist;
const SORTS = { id: {}, name: {}, category: {}, stock: {} } as const satisfies SortAllowlist;

const NAMES: Record<number, string> = { 1: "Pump Housing", 2: "pump seal", 3: "Bilge PUMP", 4: "Sump Pump", 5: "Anvil", 6: "Bracket" };
const ROWS: Row[] = Object.entries(NAMES).map(([id, name]) => {
  const n = Number(id);
  return { id: n, name, category: ["tool", "part", "kit"][n % 3]!, stock: n % 4, notes: `bin ${n}` };
});

interface DriverCase {
  name: string;
  build: () => Promise<{ driver: PersistenceDriver; teardown: () => Promise<void> }>;
}

const DRIVERS: DriverCase[] = [
  {
    name: "inMemoryDriver",
    build: async () => ({
      driver: inMemoryDriver({ seed: { parts: ROWS.map((r) => ({ ...r })) }, pkFields: { parts: ["id"] } }),
      teardown: async () => {},
    }),
  },
  {
    name: "kyselyDriver/libsql-sqlite",
    build: async () => {
      const dir = mkdtempSync(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "om-list-parity-"));
      const db = new Kysely<Record<string, Row>>({ dialect: new LibsqlDialect({ url: `file:${join(dir, "t.db")}` }) });
      await sql.raw(`CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, stock INTEGER NOT NULL, notes TEXT)`).execute(db);
      await db.insertInto("parts").values(ROWS).execute();
      return {
        driver: kyselyDriver({ db, dialect: "sqlite" }),
        teardown: async () => {
          await db.destroy();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

async function load(): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(result.errors).toEqual([]);
  return result.root as MetaRoot;
}

for (const d of DRIVERS) {
  describe(`ObjectManager Fastify list mount — ${d.name}`, () => {
    let app: FastifyInstance;
    let bare: FastifyInstance;
    let teardown: () => Promise<void> = async () => {};

    beforeAll(async () => {
      const built = await d.build();
      teardown = built.teardown;
      const om = new ObjectManager({ metadata: await load(), driver: built.driver });
      const base = { path: "/parts", entity: "Part", insertSchema: z.object({}), updateSchema: z.object({}), om: async () => om, expose: ["list"] as const };
      app = Fastify();
      mountCrudRoutes({ fastify: app, ...base, filterAllowlist: FILTERS, sortAllowlist: SORTS });
      await app.ready();
      bare = Fastify();
      mountCrudRoutes({ fastify: bare, ...base });
      await bare.ready();
    });

    afterAll(async () => {
      await app.close();
      await bare.close();
      await teardown();
    });

    async function get(url: string, on: FastifyInstance = app): Promise<{ status: number; body: unknown }> {
      const res = await on.inject({ method: "GET", url });
      return { status: res.statusCode, body: res.json() };
    }
    const ids = (body: unknown) => (body as Array<{ id: number }>).map((r) => r.id);

    test("search ignores case and matches anywhere in the text", async () => {
      const r = await get("/parts?search=pump&sort=id:asc");
      expect(r.status).toBe(200);
      expect(ids(r.body)).toEqual([1, 2, 3, 4]);
    });

    test("like is case-sensitive (ADR-0049)", async () => {
      expect(ids((await get("/parts?filter[name][like]=Pump%25&sort=id:asc")).body)).toEqual([1]);
      expect(ids((await get("/parts?filter[name][like]=pump%25&sort=id:asc")).body)).toEqual([2]);
    });

    test("filter[or] matches any branch, ANDed with a sibling condition", async () => {
      const r = await get("/parts?filter[stock][gte]=1&filter[or][0][id][eq]=4&filter[or][1][category][eq]=tool&sort=id:asc");
      expect(r.status).toBe(200);
      // stock >= 1 AND (id = 4 OR category = tool): 3 and 6 are tools in stock; 4 has stock 0.
      expect(ids(r.body)).toEqual([3, 6]);
    });

    test("search and filter are both applied, and withCount counts what they match", async () => {
      const r = await get("/parts?search=PUMP&filter[category][eq]=part&withCount=1&limit=1");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ total: 2 });
      expect((r.body as { rows: unknown[] }).rows).toHaveLength(1);
    });

    test("with no sort the rows come back in key order", async () => {
      expect(ids((await get("/parts")).body)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("a bare field parameter is refused, not ignored", async () => {
      expect(await get("/parts?name=Anvil")).toEqual({ status: 400, body: { error: "filter.bare_field", field: "name", expected: "filter[name][eq]=Anvil" } });
      const notFilterable = await get("/parts?notes=x");
      expect(notFilterable.status).toBe(400);
      expect(notFilterable.body).toMatchObject({ error: "filter.bare_field", field: "notes", filterable: false });
    });

    test("the parse refusals answer the Drizzle mount's bodies", async () => {
      expect(await get("/parts?filter[name][like]=%25pump")).toEqual({ status: 400, body: { error: "filter.leading_wildcard_disallowed", field: "name" } });
      expect(await get("/parts?filter[or][0][or][0][or][0][or][0][or][0][or][0][id][eq]=1")).toEqual({ status: 400, body: { error: "filter.nesting_too_deep", limit: 5 } });
      expect(await get("/parts?filter[stock][gt]=2.5")).toEqual({ status: 400, body: { error: "invalid_filter_value", field: "stock", op: "gt", expected: "integer (a whole number)" } });
      expect((await get("/parts?filter[nope][eq]=1")).body).toMatchObject({ error: "invalid_filter_field", field: "nope" });
      expect(await get("/parts?limit=abc")).toEqual({
        status: 400,
        body: { error: "pagination.invalid_value", param: "limit", value: "abc", expected: "a non-negative integer (0 or more)" },
      });
    });

    test("without a filter allowlist, filter and search are ignored as before", async () => {
      expect(ids((await get("/parts?filter[id][eq]=2&search=zzz&sort=id:asc", bare)).body)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
}

describe("ObjectManager Fastify list mount — default page without api.pagination", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const rows: Row[] = Array.from({ length: 55 }, (_, i) => ({ id: i + 1, name: `part ${i + 1}`, category: "tool", stock: 1, notes: null }));
    const driver = inMemoryDriver({ seed: { parts: rows }, pkFields: { parts: ["id"] } });
    const om = new ObjectManager({ metadata: await load(), driver });
    app = Fastify();
    mountCrudRoutes({
      fastify: app, path: "/parts", entity: "Part", insertSchema: z.object({}), updateSchema: z.object({}),
      om: async () => om, expose: ["list"] as const,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("no ?limit= answers 50 rows, not the whole table", async () => {
    const res = await app.inject({ method: "GET", url: "/parts" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(50);
  });

  test("a large ?limit= answers every row: no maximum without the setting", async () => {
    const res = await app.inject({ method: "GET", url: "/parts?limit=100000" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(55);
  });
});
