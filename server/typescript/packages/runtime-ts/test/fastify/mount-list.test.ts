import { describe, test, expect, beforeAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/fastify/index.js";
import type { ObjectManager } from "../../src/object-manager.js";
import type { SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

// In-memory fake ObjectManager — exercises only the surface the plain fastify
// mount calls (findMany + count). Keeps the test off a real DB so it stays a
// fast unit test of the route-layer contract (withCount / invalid_sort).
type Author = { id: number; name: string; createdAt: string };
// createdAt is deliberately ordered NEITHER like `name` nor like `id`, so every arm
// below yields a distinct permutation: a server that ignored `sort` and echoed id
// order could not accidentally match an expected result.
//   asc  → Bob(01) Carol(02) Alice(03)   desc → Alice(03) Carol(02) Bob(01)
const SEED: Author[] = [
  { id: 1, name: "Alice", createdAt: "2026-01-03" },
  { id: 2, name: "Bob", createdAt: "2026-01-01" },
  { id: 3, name: "Carol", createdAt: "2026-01-02" },
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
// createdAt carries the DECLARED default; name declares none — the pair the read
// side has to tell apart.
const sortAllowlist: SortAllowlist = { name: {}, createdAt: { defaultOrder: "desc" } };

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

  // The plain fastify mount carries its OWN parseSort, documented as mirroring the
  // drizzle-fastify parser's sort semantics. When @sortableDefaultOrder's read side
  // landed it landed in the drizzle parser only, so this mount kept hardcoding "asc"
  // and the two mounts answered one declaration two ways — same query string, same
  // generated allowlist, different rows depending on which mount a project mounted.
  // These cases pin the read here so the drift cannot return silently.
  test("?sort=<field> with no :order applies that field's DECLARED defaultOrder", async () => {
    const r = await app.inject({ method: "GET", url: "/authors?sort=createdAt" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Author[];
    expect(body.map((a) => a.createdAt)).toEqual(["2026-01-03", "2026-01-02", "2026-01-01"]);
  });

  test("a DECLARED order does not override an explicit one", async () => {
    // createdAt declares desc; the caller asks for asc. The declaration fills in a
    // MISSING direction, it never fights a present one.
    const r = await app.inject({ method: "GET", url: "/authors?sort=createdAt:asc" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Author[];
    expect(body.map((a) => a.createdAt)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  test("a field declaring NOTHING falls back to asc", async () => {
    // The fallback is spelled once per port, at the read — not baked into the
    // allowlist artifact, or a port could drift by baking a different default there.
    const r = await app.inject({ method: "GET", url: "/authors?sort=name" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Author[];
    expect(body.map((a) => a.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

});
