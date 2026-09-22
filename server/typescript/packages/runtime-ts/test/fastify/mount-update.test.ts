import { describe, test, expect } from "bun:test";
import Fastify from "fastify";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/fastify/index.js";
import type { ObjectManager } from "../../src/object-manager.js";

// The cross-port REST contract (FR-008) makes the update verb reachable via BOTH
// PATCH and PUT, routed to one handler — every other port's controller maps both,
// and the drizzle-fastify flavor mounts both by default. This mount used to
// register PATCH alone unless told otherwise, so a PUT the contract promises
// answered Fastify's own 404.

type Author = { id: number; name: string };

// In-memory fake ObjectManager — only the `update` surface the mount calls.
function fakeOm(): ObjectManager {
  const rows = new Map<string, Author>([["1", { id: 1, name: "Alice" }]]);
  return {
    async update(_entity: string, id: string, data: Partial<Author>) {
      const row = rows.get(String(id));
      if (!row) return undefined;
      const next = { ...row, ...data };
      rows.set(String(id), next);
      return next;
    },
    // biome-ignore lint/suspicious/noExplicitAny: fake only implements the methods the mount calls
  } as any;
}

const InsertSchema = z.object({ name: z.string() });
const UpdateSchema = InsertSchema.partial();

async function appWith(updateMethod?: "patch" | "put") {
  const app = Fastify();
  const om = fakeOm();
  mountCrudRoutes({
    fastify: app,
    path: "/authors",
    entity: "Author",
    insertSchema: InsertSchema,
    updateSchema: UpdateSchema,
    om: async () => om,
    ...(updateMethod !== undefined && { updateMethod }),
  });
  await app.ready();
  return app;
}

describe("plain fastify mount — update verb (PATCH and PUT)", () => {
  test("PATCH and PUT both reach the update handler by default", async () => {
    const app = await appWith();
    for (const [method, name] of [["PATCH", "Alicia"], ["PUT", "Ally"]] as const) {
      const r = await app.inject({ method, url: "/authors/1", payload: { name } });
      expect(r.statusCode, method).toBe(200);
      expect(JSON.parse(r.body).name, method).toBe(name);
    }
  });

  test("PUT on a missing row answers the not_found envelope, like PATCH", async () => {
    const app = await appWith();
    const r = await app.inject({ method: "PUT", url: "/authors/99", payload: { name: "X" } });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe("not_found");
  });

  test("updateMethod restricts the surface to the one verb it names", async () => {
    for (const [only, other] of [["patch", "PUT"], ["put", "PATCH"]] as const) {
      const app = await appWith(only);
      const mounted = await app.inject({ method: only.toUpperCase() as "PATCH" | "PUT", url: "/authors/1", payload: { name: "B" } });
      expect(mounted.statusCode, `${only} mounted`).toBe(200);
      const refused = await app.inject({ method: other, url: "/authors/1", payload: { name: "B" } });
      expect(refused.statusCode, `${other} not mounted`).toBe(404);
    }
  });
});
