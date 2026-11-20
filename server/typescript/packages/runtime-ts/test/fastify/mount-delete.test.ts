import { describe, test, expect } from "bun:test";
import Fastify from "fastify";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/fastify/index.js";
import { NotFoundError } from "../../src/errors.js";
import type { ObjectManager } from "../../src/object-manager.js";

// DELETE on a row that is not there must answer the contract's 404. ObjectManager.delete
// THROWS for a missing row unless it is told `ifMissing: "ignore"`, and a thrown
// NotFoundError is not a constraint failure, so the mount used to answer the redacted 500.

// A fake with ObjectManager.delete's real missing-row behaviour: throw by default,
// return false only under `ifMissing: "ignore"`.
function fakeOm(): ObjectManager {
  const rows = new Set(["1"]);
  return {
    async delete(entity: string, id: string, opts: { ifMissing?: "throw" | "ignore" } = {}) {
      if (rows.delete(String(id))) return true;
      if (opts.ifMissing === "ignore") return false;
      throw new NotFoundError(`${entity} ${String(id)} not found`, { entity, id });
    },
    // biome-ignore lint/suspicious/noExplicitAny: fake only implements the method the mount calls
  } as any;
}

const InsertSchema = z.object({ name: z.string() });

async function app() {
  const a = Fastify();
  const om = fakeOm();
  mountCrudRoutes({
    fastify: a, path: "/authors", entity: "Author",
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    om: async () => om,
  });
  await a.ready();
  return a;
}

describe("plain fastify mount: delete", () => {
  test("a row that exists is deleted with 204", async () => {
    const a = await app();
    const r = await a.inject({ method: "DELETE", url: "/authors/1" });
    expect(r.statusCode).toBe(204);
    await a.close();
  });

  test("a missing row answers 404 not_found, not the redacted 500", async () => {
    const a = await app();
    const missing = await a.inject({ method: "DELETE", url: "/authors/99" });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: "not_found" });
    // Deleting the same row twice: the second is the 404.
    expect((await a.inject({ method: "DELETE", url: "/authors/1" })).statusCode).toBe(204);
    const again = await a.inject({ method: "DELETE", url: "/authors/1" });
    expect(again.statusCode).toBe(404);
    expect(JSON.parse(again.body)).toEqual({ error: "not_found" });
    await a.close();
  });
});
