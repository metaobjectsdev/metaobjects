/**
 * A uuid-keyed entity on a real Postgres: ordinary bad input must answer 4xx, never 500.
 *
 * Both defects were found by building a 19-entity app on the generated routes:
 *   - `?search=` ILIKEd every `subType: "string"` allowlist rule, and a uuid FK is
 *     `subType: "string", format: "uuid"` on the wire. Postgres has no `uuid ~~* text`
 *     operator, so a search on any entity with a uuid FK answered 500.
 *   - A malformed `:id` on a uuid primary key reached Postgres as a literal and failed
 *     with "invalid input syntax for type uuid" — a 500 where a malformed numeric id
 *     already answered 400 `invalid_id`.
 *
 * Neither shows on SQLite (uuid is text there), which is why this file needs Postgres.
 * Gated on METAOBJECTS_TEST_PG_URL, like dialect-matrix-pg.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { mountCrudRoutes as mountHono } from "../src/hono/index.js";
import { mountCrudRoutes as mountFastify } from "../src/drizzle-fastify/index.js";
import type { FilterAllowlist, SortAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";

const PG_URL = process.env["METAOBJECTS_TEST_PG_URL"];

const projects = pgTable("mo_uuid_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull(),
  name: text("name").notNull(),
});

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const InsertSchema = z.object({ clientId: z.string().regex(UUID, "Invalid uuid"), name: z.string() });
const UpdateSchema = InsertSchema.partial();

const filterAllowlist: FilterAllowlist = {
  clientId: { ops: ["eq", "ne", "in", "isNull"], subType: "string", leadingWildcard: false, format: "uuid" },
  name: { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string", leadingWildcard: true },
};
const sortAllowlist: SortAllowlist = { name: {} };

const CLIENT = "00000000-0000-0000-0000-000000000001";

describe("uuid-keyed entity on real Postgres — bad input answers 4xx", () => {
  if (!PG_URL) {
    test.skip("skipped — METAOBJECTS_TEST_PG_URL not set", () => {});
    return;
  }

  let pool: Pool;
  let fastify: FastifyInstance;
  type Res = Promise<{ status: number; body: unknown }>;
  const adapters: Array<{ name: string; call: (method: string, url: string, payload?: unknown) => Res }> = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    const db = drizzle(pool);
    await pool.query(`DROP TABLE IF EXISTS mo_uuid_projects`);
    await pool.query(
      `CREATE TABLE mo_uuid_projects (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         client_id uuid NOT NULL,
         name text NOT NULL
       )`,
    );
    await pool.query(
      `INSERT INTO mo_uuid_projects (client_id, name) VALUES ($1, 'Acme relaunch'), ($1, 'Globex audit')`,
      [CLIENT],
    );
    const opts = {
      path: "/projects", db, table: projects, insertSchema: InsertSchema, updateSchema: UpdateSchema,
      filterAllowlist, sortAllowlist, dialect: "postgres" as const,
    };
    const h = new Hono();
    mountHono({ app: h, ...opts });
    fastify = Fastify();
    mountFastify({ fastify, ...opts });
    await fastify.ready();
    adapters.push(
      {
        name: "hono",
        call: async (method, url, payload) => {
          const res = await h.request(url, {
            method,
            ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
          });
          return { status: res.status, body: res.status === 204 ? null : await res.json() };
        },
      },
      {
        name: "fastify",
        call: async (method, url, payload) => {
          const res = await fastify.inject({
            method: method as "GET",
            url,
            ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
          });
          return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
        },
      },
    );
  });

  afterAll(async () => {
    await fastify?.close();
    await pool.query(`DROP TABLE IF EXISTS mo_uuid_projects`);
    await pool.end();
  });

  for (const name of ["hono", "fastify"]) {
    const use = () => {
      const a = adapters.find((x) => x.name === name);
      if (!a) throw new Error(`adapter ${name} was never mounted`);
      return a;
    };

    describe(name, () => {
      test("?search= skips the uuid FK and still searches the text columns", async () => {
        const { status, body } = await use().call("GET", "/projects?search=acme");
        expect(status).toBe(200);
        expect((body as Array<{ name: string }>).map((r) => r.name)).toEqual(["Acme relaunch"]);
      });

      for (const method of ["GET", "PATCH", "DELETE"]) {
        test(`${method} with a malformed uuid id answers 400 invalid_id`, async () => {
          const { status, body } = await use().call(method, "/projects/not-a-uuid", method === "PATCH" ? { name: "x" } : undefined);
          expect(status).toBe(400);
          expect(body).toEqual({ error: "invalid_id" });
        });
      }

      test("a well-formed but absent uuid id still answers 404", async () => {
        const { status } = await use().call("GET", "/projects/00000000-0000-0000-0000-0000000000ff");
        expect(status).toBe(404);
      });

      test("POST with a malformed uuid FK answers 400 from the insert schema", async () => {
        const { status, body } = await use().call("POST", "/projects", { clientId: "nope", name: "x" });
        expect(status).toBe(400);
        expect((body as { error: string }).error).toBe("validation");
      });
    });
  }
});
