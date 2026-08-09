/**
 * #286 — the CRUD helpers must work on Postgres, in BOTH adapters.
 *
 * Drizzle's `.all()` and `.get()` are libsql/better-sqlite3-only. The node-postgres
 * builder is thenable but has neither, so calling them 500s every GET with
 * `TypeError: q.all is not a function`. The Fastify adapter was fixed for this and
 * carries a comment explaining it; **Hono was not**, and shipped broken on Postgres
 * through 0.21.2 and 0.21.3. Reported from a real adoption.
 *
 * The reason it survived is the interesting part, and it is what this file exists to
 * close: EVERY adapter test in this package used libsql (`drizzle-orm/libsql`,
 * `:memory:`), where `.all()`/`.get()` exist and work. No test could have caught the
 * incompatibility for either adapter — Fastify's fix was reasoned, not gated. A
 * per-adapter test suite with a single dialect cannot detect a dialect divergence.
 *
 * So this is a MATRIX: the same read paths, asserted across both adapters, against a
 * REAL Postgres. Adding a third adapter should mean adding a row here, not a new file.
 *
 * It is also a matrix over ENTRY POINTS, which matters more than it looks. This package's
 * `exports` map carries a `"bun"` condition pointing at `./src/**.ts` while everything else
 * resolves `./dist/**.js` — so **Bun executes the TypeScript source and Node executes the
 * build**. A fix applied to one tree and not the other reaches only half the adopters, and a
 * suite importing just one tree cannot tell. (Confirmed live: immediately after fixing `src`,
 * `dist/hono/index.js` still contained the broken calls until a rebuild.) Every row below
 * therefore runs against both resolved entry points.
 *
 * Gated on METAOBJECTS_TEST_PG_URL (CI's ts-slow lane supplies a Postgres sidecar);
 * skips loudly-but-harmlessly when absent, and the sentinel below fails if a lane
 * claims it intends Postgres and then does not provide it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, boolean } from "drizzle-orm/pg-core";
import { z } from "zod";
import { mountCrudRoutes as mountHono } from "../src/hono/index.js";
import { mountCrudRoutes as mountFastify } from "../src/drizzle-fastify/index.js";
import type { FilterAllowlist, SortAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";

const PG_URL = process.env["METAOBJECTS_TEST_PG_URL"];

const subscribers = pgTable("mo286_subscribers", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  firstName: text("first_name").notNull(),
  subscribed: boolean("subscribed").notNull().default(true),
});

const InsertSchema = z.object({
  email: z.string(),
  firstName: z.string(),
  subscribed: z.boolean().optional(),
});
const UpdateSchema = InsertSchema.partial();

const filterAllowlist: FilterAllowlist = {
  email: { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string", leadingWildcard: true },
  firstName: { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string", leadingWildcard: false },
  subscribed: { ops: ["eq", "isNull"], subType: "boolean", leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = { email: {}, firstName: {} };

describe("real-PG dialect matrix sentinel", () => {
  test("METAOBJECTS_TEST_PG_URL is set when the lane declares RUNTIME_TS_PG_EXPECT=1", () => {
    if (process.env["RUNTIME_TS_PG_EXPECT"] === "1") {
      expect(PG_URL).toBeTruthy();
    }
  });
});

describe("#286 — CRUD helpers on real Postgres, both adapters", () => {
  if (!PG_URL) {
    test.skip("skipped — METAOBJECTS_TEST_PG_URL not set", () => {});
    return;
  }

  // biome-ignore lint/suspicious/noExplicitAny: mount option bags are structurally typed
  type HonoMount = (o: any) => void;
  // biome-ignore lint/suspicious/noExplicitAny: mount option bags are structurally typed
  type FastifyMount = (o: any) => void;

  let pool: Pool;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db handle, structurally typed by the mounts
  let db: any;
  const fastifies: FastifyInstance[] = [];
  /** True when dist/ was absent — surfaced as a failing test rather than a silent half-matrix. */
  let builtTreeMissing = false;

  /** Every (adapter x entry-point) combination under test. Filled in beforeAll. */
  type Res = Promise<{ status: number; body: unknown }>;
  const adapters: Array<{
    name: string;
    get: (url: string) => Res;
    send: (method: "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) => Res;
  }> = [];

  // describe() bodies register BEFORE beforeAll fills `adapters`, so the rows are named
  // statically and resolved lazily inside each test.
  const ADAPTER_NAMES = ["hono (src)", "fastify (src)", "hono (dist)", "fastify (dist)"] as const;
  const use = (name: string) => {
    const a = adapters.find((x) => x.name === name);
    if (!a) throw new Error(`adapter row [${name}] was never mounted — the matrix is incomplete`);
    return a;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool);
    await pool.query(`DROP TABLE IF EXISTS mo286_subscribers`);
    await pool.query(
      `CREATE TABLE mo286_subscribers (
         id serial PRIMARY KEY,
         email text NOT NULL,
         first_name text NOT NULL,
         subscribed boolean NOT NULL DEFAULT true
       )`,
    );
    await pool.query(
      `INSERT INTO mo286_subscribers (email, first_name, subscribed)
       VALUES ('alice@x.com','Alice',true), ('bob@x.com','Bob',false), ('carol@y.com','Carol',true)`,
    );

    // src/** is what Bun runs (the `bun` export condition); dist/** is what Node runs.
    // Exercise both — a fix in one tree only would otherwise pass here.
    const entries: Array<{ tree: string; hono: HonoMount; fastify: FastifyMount }> = [
      { tree: "src", hono: mountHono, fastify: mountFastify },
    ];
    if (existsSync(join(import.meta.dir, "..", "dist", "hono", "index.js"))) {
      const dh = await import("../dist/hono/index.js");
      const df = await import("../dist/drizzle-fastify/index.js");
      entries.push({ tree: "dist", hono: dh.mountCrudRoutes, fastify: df.mountCrudRoutes });
    } else {
      builtTreeMissing = true;
    }

    for (const e of entries) {
      const h = new Hono();
      e.hono({
        app: h, path: "/subscribers", db, table: subscribers,
        insertSchema: InsertSchema, updateSchema: UpdateSchema,
        filterAllowlist, sortAllowlist, dialect: "postgres",
      });
      const f = Fastify();
      e.fastify({
        fastify: f, path: "/subscribers", db, table: subscribers,
        insertSchema: InsertSchema, updateSchema: UpdateSchema,
        filterAllowlist, sortAllowlist, dialect: "postgres",
      });
      await f.ready();
      fastifies.push(f);
      adapters.push(
        {
          name: `hono (${e.tree})`,
          get: async (url) => {
            const res = await h.request(url);
            return { status: res.status, body: res.status === 204 ? null : await res.json() };
          },
          send: async (method, url, payload) => {
            const res = await h.request(url, {
              method,
              ...(payload === undefined ? {} : {
                body: JSON.stringify(payload),
                headers: { "content-type": "application/json" },
              }),
            });
            return { status: res.status, body: res.status === 204 ? null : await res.json() };
          },
        },
        {
          name: `fastify (${e.tree})`,
          get: async (url) => {
            const res = await f.inject({ method: "GET", url });
            return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
          },
          send: async (method, url, payload) => {
            const res = payload === undefined
              ? await f.inject({ method, url })
              : await f.inject({ method, url, payload });
            return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
          },
        },
      );
    }
  });

  afterAll(async () => {
    for (const f of fastifies) await f.close();
    await pool.query(`DROP TABLE IF EXISTS mo286_subscribers`);
    await pool.end();
  });

  test("the BUILT tree is present, so Node's entry point is actually covered", () => {
    // dist/ is what `exports.default` resolves to. If it is missing the matrix silently
    // halves, which is the failure mode this whole file exists to prevent — so say so.
    expect(builtTreeMissing).toBe(false);
    expect(adapters.map((a) => a.name).sort()).toEqual([
      "fastify (dist)", "fastify (src)", "hono (dist)", "hono (src)",
    ]);
  });

  for (const a of ADAPTER_NAMES) {
    describe(a, () => {
      test("list returns rows (the exact call that threw `q.all is not a function`)", async () => {
        const { status, body } = await use(a).get("/subscribers");
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect((body as unknown[]).length).toBe(3);
      });

      test("get-by-id returns one row (the `.get()` path)", async () => {
        const list = (await use(a).get("/subscribers")).body as Array<{ id: number; email: string }>;
        const target = list.find((r) => r.email === "bob@x.com");
        expect(target).toBeDefined();
        const { status, body } = await use(a).get(`/subscribers/${target?.id}`);
        expect(status).toBe(200);
        expect((body as { email: string }).email).toBe("bob@x.com");
      });

      test("get-by-id 404s for a missing row rather than throwing", async () => {
        const { status } = await use(a).get("/subscribers/99999");
        expect(status).toBe(404);
      });

      test("withCount returns the {rows,total} envelope (the count-query `.all()` path)", async () => {
        const { status, body } = await use(a).get("/subscribers?withCount=1");
        expect(status).toBe(200);
        const env = body as { rows: unknown[]; total: number };
        expect(Array.isArray(env.rows)).toBe(true);
        expect(env.total).toBe(3);
      });

      test("filter + sort execute on Postgres", async () => {
        const { status, body } = await use(a).get("/subscribers?filter[subscribed]=true&sort=email:desc");
        expect(status).toBe(200);
        const rows = body as Array<{ email: string }>;
        expect(rows.map((r) => r.email)).toEqual(["carol@y.com", "alice@x.com"]);
      });

      // The WRITE verbs. Until now this matrix was GET-only, so create/update/delete
      // on Postgres ran nowhere — the only Hono write tests are libsql :memory:,
      // which is the precise shape in which #286 shipped broken. `.returning()` and
      // extractRowCount()'s duck-typing across three driver result shapes are exactly
      // the things that misreport 201/404/204 rather than throwing, so they need a
      // real engine to be believed.
      test("create → read-back → update → delete round-trips on Postgres", async () => {
        const email = `rt-${a.replace(/[^a-z]/g, "")}@x.com`;
        const created = await use(a).send("POST", "/subscribers", {
          email, firstName: "Round", subscribed: true,
        });
        expect(created.status).toBe(201);
        const id = (created.body as { id: number }).id;
        expect(typeof id).toBe("number");

        // Read it back through the list path, proving the write actually committed.
        const got = await use(a).get(`/subscribers/${id}`);
        expect(got.status).toBe(200);
        expect((got.body as { email: string }).email).toBe(email);

        const patched = await use(a).send("PATCH", `/subscribers/${id}`, { firstName: "Patched" });
        expect(patched.status).toBe(200);
        expect((patched.body as { firstName: string }).firstName).toBe("Patched");

        const deleted = await use(a).send("DELETE", `/subscribers/${id}`);
        expect(deleted.status).toBe(204);
        expect((await use(a).get(`/subscribers/${id}`)).status).toBe(404);
      });

      test("update and delete 404 on a missing row instead of reporting success", async () => {
        // extractRowCount() duck-types the driver's result shape; misreading it turns
        // "nothing matched" into a 200/204, which no GET-only matrix could ever see.
        expect((await use(a).send("PATCH", "/subscribers/99999", { firstName: "X" })).status).toBe(404);
        expect((await use(a).send("DELETE", "/subscribers/99999")).status).toBe(404);
      });

      test("create rejects an invalid payload with 400, not a 500", async () => {
        const { status } = await use(a).send("POST", "/subscribers", { email: 42 });
        expect(status).toBe(400);
      });
    });
  }

  test("every adapter x entry-point returns the SAME payload — the matrix's whole point", async () => {
    const results = await Promise.all(
      ADAPTER_NAMES.map(async (n) => ({ n, r: await use(n).get("/subscribers?sort=email:asc") })),
    );
    const [first, ...rest] = results;
    for (const other of rest) {
      expect(`${other.n}:${other.r.status}`).toBe(`${other.n}:${first!.r.status}`);
      expect(other.r.body).toEqual(first!.r.body);
    }
  });
});
