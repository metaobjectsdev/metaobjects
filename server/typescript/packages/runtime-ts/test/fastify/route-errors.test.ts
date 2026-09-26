// The ObjectManager fastify mount answers an unexpected error with
// `500 { error: "internal" }` (no driver text) and a malformed JSON body with
// `400 { error: "invalid_json" }` — the same route-scoped handler drizzle-fastify
// installs (test/drizzle-fastify/route-errors.test.ts carries the full rationale).

import { describe, test, expect, spyOn } from "bun:test";
import Fastify from "fastify";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/fastify/index.js";
import type { ObjectManager } from "../../src/object-manager.js";

const DRIVER_TEXT = 'Failed query: select "id", "display_name" from "readers"\nparams: 1';

// Every method the mount calls fails the way a driver does when the schema drifted.
function brokenOm(): ObjectManager {
  const fail = async () => { throw new Error(DRIVER_TEXT); };
  return { findMany: fail, findById: fail, create: fail, update: fail, delete: fail, count: fail } as unknown as ObjectManager;
}

const InsertSchema = z.object({ displayName: z.string() });

async function app() {
  const a = Fastify();
  const om = brokenOm();
  mountCrudRoutes({
    fastify: a, path: "/readers", entity: "Reader",
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    om: async () => om,
  });
  await a.ready();
  return a;
}

describe("fastify (ObjectManager) mount — error envelopes", () => {
  const cases = [
    { method: "GET", url: "/readers" },
    { method: "GET", url: "/readers/1" },
    { method: "POST", url: "/readers", payload: { displayName: "Bo" } },
    { method: "PATCH", url: "/readers/1", payload: { displayName: "Bo" } },
    { method: "PUT", url: "/readers/1", payload: { displayName: "Bo" } },
    { method: "DELETE", url: "/readers/1" },
  ] as const;
  for (const c of cases) {
    test(`${c.method} ${c.url}: unexpected error → 500 { error: "internal" }, detail logged`, async () => {
      const a = await app();
      const logged: unknown[] = [];
      const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args[0]); });
      try {
        const r = await a.inject({ method: c.method, url: c.url, ...("payload" in c && { payload: c.payload }) });
        expect(r.statusCode).toBe(500);
        expect(JSON.parse(r.body)).toEqual({ error: "internal" });
        expect(r.body).not.toMatch(/select|readers|display_name|params/i);
        expect(logged.length).toBe(1);
      } finally {
        spy.mockRestore();
        await a.close();
      }
    });
  }

  for (const method of ["POST", "PATCH", "PUT"] as const) {
    test(`${method} with a malformed JSON body → 400 { error: "invalid_json" }`, async () => {
      const a = await app();
      const r = await a.inject({
        method, url: method === "POST" ? "/readers" : "/readers/1",
        payload: "not json", headers: { "content-type": "application/json" },
      });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: "invalid_json" });
      await a.close();
    });
  }
});
