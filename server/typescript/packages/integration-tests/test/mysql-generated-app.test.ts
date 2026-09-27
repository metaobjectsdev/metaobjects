// The generated TypeScript tier on MySQL: `dialect: "mysql"` codegen (entity + queries +
// Fastify routes) run against a real MySQL 8.4 server through drizzle-orm/mysql2.
//
// MetaObjects does not own a MySQL schema — `meta migrate` supports Postgres, SQLite and D1 —
// so the DDL below is written by hand, the way an adopter on MySQL writes it. What is under
// test is everything else, byte-for-byte as generated:
//
//   - writes without RETURNING: create/update read the row back by key (AUTO_INCREMENT via
//     `$returningId()`), delete reports whether the row existed;
//   - the ADR-0049 `like` contract (case-SENSITIVE) against MySQL's case-insensitive default
//     collation, and the case-insensitive `?search`;
//   - a column named after a MySQL 8 reserved word (`rank`);
//   - timestamps: DATETIME(3) holds the UTC wall clock, the wire carries ISO with `Z`;
//   - JSON arrays, DECIMAL as a string, a uuid in VARCHAR(36);
//   - a unique violation answered as 409 `constraint_violation`, not a 500.
//
// Requires Docker (or METAOBJECTS_TEST_MYSQL_URL).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql from "mysql2/promise";
import { defineConfig, runGen } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile, routesFile } from "@metaobjectsdev/test-generators";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { startMysql, type MysqlContainerHandle } from "../src/mysql-container.ts";

const MODEL = {
  "metadata.root": {
    package: "library",
    children: [
      {
        "object.entity": {
          name: "Author",
          children: [
            { "source.rdb": { "@table": "authors" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@required": true, "@maxLength": 100, "@filterable": true } },
            { "field.string": { name: "email", "@required": true, "@maxLength": 200 } },
            { "field.string": { name: "bio" } },
            { "field.int": { name: "rank", "@required": true, "@filterable": true, "@sortable": true } },
            { "field.boolean": { name: "active", "@required": true } },
            { "field.enum": { name: "status", "@required": true, "@values": ["ACTIVE", "RETIRED"], "@filterable": true } },
            { "field.uuid": { name: "externalId" } },
            { "field.string": { name: "tags", isArray: true } },
            { "field.decimal": { name: "score", "@precision": 10, "@scale": 2 } },
            { "field.timestamp": { name: "createdAt", "@autoSet": "onCreate" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.secondary": { name: "byEmail", "@fields": ["email"] } },
          ],
        },
      },
    ],
  },
};

const DDL = `CREATE TABLE authors (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL,
  bio TEXT,
  \`rank\` INT NOT NULL,
  active BOOLEAN NOT NULL,
  status VARCHAR(7) NOT NULL,
  external_id VARCHAR(36),
  tags JSON,
  score DECIMAL(10,2),
  created_at DATETIME(3),
  UNIQUE KEY byEmail (email)
)`;

let container: MysqlContainerHandle;
let tmp = "";
let fastify: FastifyInstance;
let admin: mysql.Connection;
// biome-ignore lint/suspicious/noExplicitAny: the generated queries module, imported dynamically
let queries: any;
// biome-ignore lint/suspicious/noExplicitAny: the generated db module, imported dynamically
let dbMod: any;

beforeAll(async () => {
  container = await startMysql();
  admin = await mysql.createConnection(container.url);
  await admin.query("DROP TABLE IF EXISTS authors");
  await admin.query(DDL);

  // Emit inside the package tree so bare `@metaobjectsdev/*` imports resolve (see
  // api-contract-generated-server.ts for the same arrangement).
  const here = dirname(fileURLToPath(import.meta.url));
  const genRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genRoot, { recursive: true });
  tmp = mkdtempSync(join(genRoot, "mysql-generated-"));
  const metaPath = join(tmp, "meta.library.json");
  writeFileSync(metaPath, JSON.stringify(MODEL));

  const result = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      dbImport: "./db",
      dialect: "mysql",
      apiPrefix: "/api",
      generators: [entityFile(), queriesFile(), routesFile()],
    }),
    metadata: await loadMetadataFile(metaPath),
  });
  if (result.warnings.length > 0) throw new Error(`codegen warnings: ${result.warnings.join("; ")}`);

  writeFileSync(join(tmp, "db.ts"), `
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
export const pool = mysql.createPool(${JSON.stringify(container.url)});
export const db = drizzle(pool);
`);
  dbMod = await import(pathToFileURL(join(tmp, "db.ts")).href);
  queries = await import(pathToFileURL(join(tmp, "Author.queries.ts")).href);
  const routes = await import(pathToFileURL(join(tmp, "Author.routes.ts")).href);
  fastify = Fastify();
  await fastify.register(routes.authorRoutes);
  await fastify.ready();
}, 240_000);

afterAll(async () => {
  await fastify?.close();
  await dbMod?.pool.end();
  await admin?.end();
  container?.stop();
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

async function post(body: unknown) {
  return fastify.inject({ method: "POST", url: "/api/authors", payload: body as object });
}

describe("generated TypeScript tier on MySQL", () => {
  test("POST creates, reads the AUTO_INCREMENT key back, and speaks the wire contract", async () => {
    await admin.query("DELETE FROM authors");
    const res = await post({
      name: "Alice", email: "alice@example.com", rank: 10, active: true, status: "ACTIVE",
      externalId: "0f8fad5b-d9cb-469f-a165-70867728950e", tags: ["poetry", "essays"], score: "12.50",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.id).toBe("number");
    expect(body.rank).toBe(10);
    expect(body.active).toBe(true);
    expect(body.tags).toEqual(["poetry", "essays"]);
    expect(body.score).toBe("12.50");
    expect(body.externalId).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // The DATETIME holds the UTC wall clock of that instant.
    const [rows] = await admin.query(
      "SELECT DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%f') AS c FROM authors WHERE id = ?", [body.id]);
    const stored = (rows as Array<{ c: string }>)[0]!.c;
    expect(`${stored.slice(0, 23)}Z`).toBe(body.createdAt);

    const got = await fastify.inject({ method: "GET", url: `/api/authors/${body.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(body);
  });

  test("like is case-SENSITIVE, ?search is not, and the reserved-word column filters and sorts", async () => {
    await admin.query("DELETE FROM authors");
    for (const [name, rank] of [["Alice", 10], ["alice", 20], ["Bob", 30]] as const) {
      const r = await post({ name, email: `${name}${rank}@example.com`, rank, active: true, status: "ACTIVE" });
      expect(r.statusCode).toBe(201);
    }
    const names = async (qs: string) =>
      ((await fastify.inject({ method: "GET", url: `/api/authors?${qs}` })).json() as Array<{ name: string }>)
        .map((a) => a.name);

    expect(await names("filter[name][like]=Al%25")).toEqual(["Alice"]);
    expect((await names("search=ali")).sort()).toEqual(["Alice", "alice"]);
    expect(await names("filter[rank][gte]=20&sort=rank:desc")).toEqual(["Bob", "alice"]);
    expect(await names("sort=rank:asc&limit=1&offset=1")).toEqual(["alice"]);

    const counted = (await fastify.inject({ method: "GET", url: "/api/authors?withCount=1&limit=1" })).json();
    expect(counted.total).toBe(3);
    expect(counted.rows).toHaveLength(1);
  });

  test("PATCH updates and reads back; a missing row is 404; DELETE is 204 then 404", async () => {
    await admin.query("DELETE FROM authors");
    const created = (await post({ name: "Carol", email: "carol@example.com", rank: 5, active: true, status: "ACTIVE" })).json();

    const patched = await fastify.inject({
      method: "PATCH", url: `/api/authors/${created.id}`, payload: { status: "RETIRED", bio: "Poet." },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id: created.id, status: "RETIRED", bio: "Poet.", name: "Carol" });

    const missing = await fastify.inject({ method: "PATCH", url: "/api/authors/999999", payload: { bio: "x" } });
    expect(missing.statusCode).toBe(404);

    expect((await fastify.inject({ method: "DELETE", url: `/api/authors/${created.id}` })).statusCode).toBe(204);
    expect((await fastify.inject({ method: "DELETE", url: `/api/authors/${created.id}` })).statusCode).toBe(404);
  });

  test("a unique violation is 409 constraint_violation, and a bad body is 400", async () => {
    await admin.query("DELETE FROM authors");
    const first = { name: "Dan", email: "dan@example.com", rank: 1, active: false, status: "ACTIVE" };
    expect((await post(first)).statusCode).toBe(201);
    const dup = await post({ ...first, name: "Dan Two" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: "constraint_violation", constraint: "unique" });
    expect((await post({ ...first, email: "x@example.com", status: "LOST" })).statusCode).toBe(400);
  });

  test("the generated queries module: create / update / delete without RETURNING", async () => {
    await admin.query("DELETE FROM authors");
    const { db } = dbMod;
    const a = await queries.createAuthor(db, { name: "Eve", email: "eve@example.com", rank: 7, active: true, status: "ACTIVE" });
    expect(a.id).toBeGreaterThan(0);
    expect(a.createdAt).toBeInstanceOf(Date);

    const u = await queries.updateAuthor(db, a.id, { rank: 8 });
    expect(u).toMatchObject({ id: a.id, rank: 8 });
    expect(await queries.updateAuthor(db, 999999, { rank: 1 })).toBeNull();

    expect(await queries.deleteAuthorById(db, a.id)).toBe(true);
    expect(await queries.deleteAuthorById(db, a.id)).toBe(false);
    expect(await queries.findAuthorById(db, a.id)).toBeNull();
  });
});
