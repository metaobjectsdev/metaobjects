import { describe, test, expect, beforeAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/fastify/index.js";
import type { ObjectManager } from "../../src/object-manager.js";
import type { SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

// In-memory fake ObjectManager — exercises only the surface the plain fastify
// mount calls (findMany + count). Keeps the test off a real DB so it stays a
// fast unit test of the route-layer contract (withCount / invalid_sort).
type Author = { id: number; name: string };
const SEED: Author[] = [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" },
  { id: 3, name: "Carol" },
];

function fakeOm(): ObjectManager {
  return {
    async findMany(
      _entity: string,
      _filter: unknown,
      opts: { limit?: number; offset?: number; orderBy?: [string, "asc" | "desc"] } = {},
    ) {
      let rows = [...SEED];
      if (opts.orderBy) {
        const [field, dir] = opts.orderBy;
        rows.sort((a, b) =>
          String((a as Record<string, unknown>)[field]).localeCompare(String((b as Record<string, unknown>)[field])),
        );
        if (dir === "desc") rows.reverse();
      }
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? rows.length;
      return rows.slice(offset, offset + limit);
    },
    async count() {
      return SEED.length;
    },
    // biome-ignore lint/suspicious/noExplicitAny: fake only implements the methods the mount calls
  } as any;
}

const InsertSchema = z.object({ name: z.string() });
const UpdateSchema = InsertSchema.partial();
const sortAllowlist: SortAllowlist = { name: {} };

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  const om = fakeOm();
  mountCrudRoutes({
    fastify: app,
    path: "/authors",
    entity: "Author",
    insertSchema: InsertSchema,
    updateSchema: UpdateSchema,
    om: async () => om,
    sortAllowlist,
  });
  await app.ready();
});

describe("plain fastify mount — contract parity", () => {
  test("bare list returns the plain rows array (back-compat)", async () => {
    const r = await app.inject({ method: "GET", url: "/authors" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
  });

  test("?withCount=1 returns { rows, total } envelope", async () => {
    const r = await app.inject({ method: "GET", url: "/authors?withCount=1&limit=2" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(2);
    expect(body.total).toBe(3); // unpaginated count
  });

  test("?sort against a field not on the allowlist returns 400 invalid_sort", async () => {
    const r = await app.inject({ method: "GET", url: "/authors?sort=unknownfield:asc" });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe("invalid_sort");
  });

  test("?sort against an allowed field is applied (no 400)", async () => {
    const r = await app.inject({ method: "GET", url: "/authors?sort=name:desc" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Author[];
    expect(body.map((a) => a.name)).toEqual(["Carol", "Bob", "Alice"]);
  });
});
