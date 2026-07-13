/**
 * WRONG-ROW write/delete on a TEXT/string primary key.
 *
 * The writable mounts coerced every `:id` path param through `parseId` —
 * `Number(raw)` whenever the string LOOKS numeric — with no reference to the
 * PK column's actual type. For a TEXT pk holding both '0123' and '123',
 * `parseId("0123")` yields the NUMBER 123; SQLite's comparison affinity then
 * converts 123 to '123' and matches the OTHER row. So:
 *
 *   DELETE /docs/0123  →  deletes row '123'   (data loss, wrong row)
 *   PATCH  /docs/0123  →  updates row '123'   (wrong row mutated)
 *   GET    /docs/0123  →  returns row '123'   (wrong row served)
 *
 * This is the writable-mount twin of the read-only NaN-404 bug fixed via
 * `coerceIdForColumn` (see read-only-uuid-pk.test.ts). It affected every
 * writable mount: drizzle-fastify, hono, the ObjectManager-flavored fastify
 * mount, the TPH-discriminator-scoped routes (same handlers), and the M:N
 * traversal source id.
 *
 * Reported class: a downstream consumer with string business keys.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { Database as BunSqliteDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/libsql";
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";
import {
  mountCrudRoutes as mountDrizzleFastifyCrud,
  mountM2mRoute,
} from "../src/drizzle-fastify/index.js";
import { mountCrudRoutes as mountHonoCrud } from "../src/hono/index.js";
import { mountCrudRoutes as mountOmCrud } from "../src/fastify/index.js";
import { ObjectManager } from "../src/object-manager.js";
import { drizzleDriver } from "../src/drivers/index.js";

const InsertSchema = z.object({ id: z.string().optional(), title: z.string() });
const UpdateSchema = InsertSchema.partial();

/** TEXT-pk table holding BOTH '0123' and '123' — the collision parseId conflates. */
function docsTable() {
  return sqliteTable("docs", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
  });
}

async function seedDocs(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
  await client.execute(`INSERT INTO docs (id, title) VALUES ('0123', 'LeadingZero'), ('123', 'Plain')`);
}

async function titles(client: Client): Promise<Record<string, string>> {
  const rs = await client.execute(`SELECT id, title FROM docs`);
  const out: Record<string, string> = {};
  for (const r of rs.rows) out[String(r["id"])] = String(r["title"]);
  return out;
}

// ---------------------------------------------------------------------------
// drizzle-fastify writable mount
// ---------------------------------------------------------------------------
describe("drizzle-fastify writable mount — TEXT pk '0123' vs '123'", () => {
  let client: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await seedDocs(client);
    const db = drizzle(client);
    app = Fastify();
    mountDrizzleFastifyCrud({
      fastify: app, path: "/docs", db, table: docsTable(),
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); client.close(); });

  test("GET /docs/0123 returns row '0123' — NOT row '123'", async () => {
    const r = await app.inject({ method: "GET", url: "/docs/0123" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ id: "0123", title: "LeadingZero" });
  });

  test("PATCH /docs/0123 updates row '0123' and leaves row '123' untouched", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/docs/0123",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "LeadingZeroUpdated" }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).id).toBe("0123");
    expect(await titles(client)).toEqual({ "0123": "LeadingZeroUpdated", "123": "Plain" });
  });

  test("DELETE /docs/0123 deletes row '0123' — row '123' MUST survive", async () => {
    const r = await app.inject({ method: "DELETE", url: "/docs/0123" });
    expect(r.statusCode).toBe(204);
    expect(await titles(client)).toEqual({ "123": "Plain" });
  });
});

// ---------------------------------------------------------------------------
// THE WRONG-ROW PROOF — classic SQLite bindings (bun:sqlite; same for
// better-sqlite3 / D1) apply column affinity to bound params, so the
// parseId-coerced number 123 MATCHES the TEXT row '123':
//
//   DELETE /docs/0123 deleted row '123' — data loss on the wrong row.
//
// (Under libsql the same bug surfaces as a 404 — the row is unfindable —
// covered by the blocks above/below.)
// ---------------------------------------------------------------------------
describe("drizzle-fastify writable mount on bun:sqlite — WRONG-ROW proof", () => {
  let sqlite: BunSqliteDatabase;
  let app: FastifyInstance;

  const bunTitles = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of sqlite.query(`SELECT id, title FROM docs`).all() as Array<{ id: string; title: string }>) {
      out[r.id] = r.title;
    }
    return out;
  };

  beforeAll(async () => {
    sqlite = new BunSqliteDatabase(":memory:");
    sqlite.run(`CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    sqlite.run(`INSERT INTO docs (id, title) VALUES ('0123', 'LeadingZero'), ('123', 'Plain')`);
    const db = drizzleBunSqlite(sqlite);
    app = Fastify();
    mountDrizzleFastifyCrud({
      fastify: app, path: "/docs", db, table: docsTable(),
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); sqlite.close(); });

  test("GET /docs/0123 must NOT serve row '123' (was: affinity matched the wrong row)", async () => {
    const r = await app.inject({ method: "GET", url: "/docs/0123" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ id: "0123", title: "LeadingZero" });
  });

  test("PATCH /docs/0123 must NOT mutate row '123'", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/docs/0123",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "LeadingZeroUpdated" }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).id).toBe("0123");
    expect(bunTitles()).toEqual({ "0123": "LeadingZeroUpdated", "123": "Plain" });
  });

  test("DELETE /docs/0123 must NOT delete row '123' (was: wrong-row data loss)", async () => {
    const r = await app.inject({ method: "DELETE", url: "/docs/0123" });
    expect(r.statusCode).toBe(204);
    expect(bunTitles()).toEqual({ "123": "Plain" });
  });
});

// ---------------------------------------------------------------------------
// hono writable mount (near-duplicate of the fastify flavor — test both so a
// divergence can't hide)
// ---------------------------------------------------------------------------
describe("hono writable mount — TEXT pk '0123' vs '123'", () => {
  let client: Client;
  let app: Hono;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await seedDocs(client);
    const db = drizzle(client);
    app = new Hono();
    mountHonoCrud({
      app, path: "/docs", db, table: docsTable(),
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
    });
  });
  afterAll(() => { client.close(); });

  test("GET /docs/0123 returns row '0123' — NOT row '123'", async () => {
    const res = await app.request("/docs/0123");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "0123", title: "LeadingZero" });
  });

  test("PATCH /docs/0123 updates row '0123' and leaves row '123' untouched", async () => {
    const res = await app.request("/docs/0123", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "LeadingZeroUpdated" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("0123");
    expect(await titles(client)).toEqual({ "0123": "LeadingZeroUpdated", "123": "Plain" });
  });

  test("DELETE /docs/0123 deletes row '0123' — row '123' MUST survive", async () => {
    const res = await app.request("/docs/0123", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await titles(client)).toEqual({ "123": "Plain" });
  });
});

// ---------------------------------------------------------------------------
// ObjectManager-flavored fastify mount — same class of bug: the mount
// pre-coerced through parseId before ObjectManager ever saw the id, so the
// metadata (field.string pk) could not undo the '0123' → 123 conflation.
// ---------------------------------------------------------------------------
describe("ObjectManager fastify mount — TEXT pk '0123' vs '123'", () => {
  let client: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await seedDocs(client);
    const table = docsTable();
    const db = drizzle(client, { schema: { docs: table } });
    const loader = new MetaDataLoader();
    const result = await loader.load([
      new FileSource(resolve(import.meta.dir, "fixtures/string-pk.json")),
    ]);
    expect(result.errors).toEqual([]);
    const om = new ObjectManager({
      metadata: result.root,
      driver: drizzleDriver({ db, schema: { docs: table }, dialect: "sqlite" }),
    });
    app = Fastify();
    mountOmCrud({
      fastify: app, path: "/docs", entity: "Doc",
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
      om: async () => om,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); client.close(); });

  test("GET /docs/0123 returns row '0123' — NOT row '123'", async () => {
    const r = await app.inject({ method: "GET", url: "/docs/0123" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ id: "0123", title: "LeadingZero" });
  });

  test("PATCH /docs/0123 updates row '0123' and leaves row '123' untouched", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/docs/0123",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "LeadingZeroUpdated" }),
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).id).toBe("0123");
    expect(await titles(client)).toEqual({ "0123": "LeadingZeroUpdated", "123": "Plain" });
  });

  test("DELETE /docs/0123 deletes row '0123' — row '123' MUST survive", async () => {
    const r = await app.inject({ method: "DELETE", url: "/docs/0123" });
    expect(r.statusCode).toBe(204);
    expect(await titles(client)).toEqual({ "123": "Plain" });
  });
});

// ---------------------------------------------------------------------------
// TPH discriminator-scoped routes — same handlers, discriminator ANDed in.
// Prove the wrong-row conflation cannot cross a string pk under TPH either.
// ---------------------------------------------------------------------------
describe("drizzle-fastify TPH subtype routes — TEXT pk '0123' vs '123'", () => {
  let client: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(
      `CREATE TABLE animals (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL)`,
    );
    await client.execute(
      `INSERT INTO animals (id, kind, name) VALUES ('0123', 'dog', 'LeadingZeroDog'), ('123', 'dog', 'PlainDog')`,
    );
    const animals = sqliteTable("animals", {
      id: text("id").primaryKey(),
      kind: text("kind").notNull(),
      name: text("name").notNull(),
    });
    const db = drizzle(client);
    app = Fastify();
    mountDrizzleFastifyCrud({
      fastify: app, path: "/dogs", db, table: animals,
      insertSchema: z.object({ id: z.string(), name: z.string() }),
      updateSchema: z.object({ name: z.string() }).partial(),
      discriminator: { column: "kind", value: "dog" },
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); client.close(); });

  test("GET /dogs/0123 returns row '0123' — NOT row '123'", async () => {
    const r = await app.inject({ method: "GET", url: "/dogs/0123" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).name).toBe("LeadingZeroDog");
  });

  test("DELETE /dogs/0123 deletes row '0123' — row '123' MUST survive", async () => {
    const r = await app.inject({ method: "DELETE", url: "/dogs/0123" });
    expect(r.statusCode).toBe(204);
    const rs = await client.execute(`SELECT id FROM animals`);
    expect(rs.rows.map((row) => String(row["id"]))).toEqual(["123"]);
  });
});

// ---------------------------------------------------------------------------
// M:N traversal — the SOURCE id went through parseId too, so
// GET /posts/0123/tags traversed post '123''s junction rows.
// ---------------------------------------------------------------------------
describe("mountM2mRoute — TEXT source pk '0123' vs '123'", () => {
  let client: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    await client.execute(`CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    await client.execute(`CREATE TABLE post_tags (post_id TEXT NOT NULL, tag_id INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO posts (id, title) VALUES ('0123', 'LeadingZero'), ('123', 'Plain')`);
    await client.execute(`INSERT INTO tags (id, name) VALUES (10, 'zero-tag'), (20, 'plain-tag')`);
    await client.execute(`INSERT INTO post_tags (post_id, tag_id) VALUES ('0123', 10), ('123', 20)`);

    const posts = sqliteTable("posts", {
      id: text("id").primaryKey(),
      title: text("title").notNull(),
    });
    const tags = sqliteTable("tags", {
      id: integer("id").primaryKey(),
      name: text("name").notNull(),
    });
    const postTags = sqliteTable("post_tags", {
      postId: text("post_id").notNull(),
      tagId: integer("tag_id").notNull(),
    });
    void posts;
    const db = drizzle(client);
    app = Fastify();
    mountM2mRoute({
      fastify: app, path: "/posts", relationName: "tags", db,
      junctionTable: postTags, targetTable: tags,
      sourceColumn: "post_id", targetColumn: "tag_id", targetPkColumn: "id",
      symmetric: false,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); client.close(); });

  test("GET /posts/0123/tags returns post '0123''s tags — NOT post '123''s", async () => {
    const r = await app.inject({ method: "GET", url: "/posts/0123/tags" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).map((t: { name: string }) => t.name)).toEqual(["zero-tag"]);
  });

  test("GET /posts/123/tags still returns post '123''s tags", async () => {
    const r = await app.inject({ method: "GET", url: "/posts/123/tags" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).map((t: { name: string }) => t.name)).toEqual(["plain-tag"]);
  });
});

// ---------------------------------------------------------------------------
// Regression guards — a NUMERIC pk must behave exactly as before, and a
// malformed id on a numeric pk answers 400 (the coerceIdForColumn contract
// already shipped on the read-only mounts).
// ---------------------------------------------------------------------------
describe("regression guards — numeric pk writable mounts", () => {
  let client: Client;
  let fastifyApp: FastifyInstance;
  let honoApp: Hono;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(
      `CREATE TABLE programs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)`,
    );
    await client.execute(`INSERT INTO programs (id, title) VALUES (1, 'Alpha'), (2, 'Beta')`);
    const programs = sqliteTable("programs", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      title: text("title").notNull(),
    });
    const db = drizzle(client);
    const schemas = {
      insertSchema: z.object({ title: z.string() }),
      updateSchema: z.object({ title: z.string() }).partial(),
    };
    fastifyApp = Fastify();
    mountDrizzleFastifyCrud({
      fastify: fastifyApp, path: "/programs", db, table: programs, ...schemas,
    });
    await fastifyApp.ready();
    honoApp = new Hono();
    mountHonoCrud({ app: honoApp, path: "/programs", db, table: programs, ...schemas });
  });
  afterAll(async () => { await fastifyApp.close(); client.close(); });

  test("fastify: GET/PATCH by numeric id still works", async () => {
    const g = await fastifyApp.inject({ method: "GET", url: "/programs/1" });
    expect(g.statusCode).toBe(200);
    expect(JSON.parse(g.body).title).toBe("Alpha");
    const p = await fastifyApp.inject({
      method: "PATCH", url: "/programs/1",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "AlphaUpdated" }),
    });
    expect(p.statusCode).toBe(200);
    expect(JSON.parse(p.body).title).toBe("AlphaUpdated");
  });

  test("fastify: absent numeric id still 404s", async () => {
    const r = await fastifyApp.inject({ method: "GET", url: "/programs/9999" });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body).error).toBe("not_found");
  });

  test("fastify: garbage id on a numeric pk answers 400 (never hits the DB)", async () => {
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const r = await fastifyApp.inject({
        method, url: "/programs/not-a-number",
        ...(method === "PATCH"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }
          : {}),
      });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toBe("invalid_id");
    }
  });

  test("hono: GET by numeric id still works; garbage → 400", async () => {
    const ok = await honoApp.request("/programs/2");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { title: string }).title).toBe("Beta");
    const bad = await honoApp.request("/programs/not-a-number");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_id");
  });

  test("fastify: DELETE by numeric id still works", async () => {
    const r = await fastifyApp.inject({ method: "DELETE", url: "/programs/2" });
    expect(r.statusCode).toBe(204);
    const rs = await client.execute(`SELECT id FROM programs`);
    expect(rs.rows.map((row) => Number(row["id"]))).toEqual([1]);
  });
});
