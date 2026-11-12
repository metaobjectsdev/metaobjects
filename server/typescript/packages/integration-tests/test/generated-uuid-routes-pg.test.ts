/**
 * The STOCK generated routes on Postgres with uuid keys and a uuid foreign key — the one
 * combination no adopter exercised, which is how two 500s shipped in it:
 *
 *   - `?search=` ILIKEd the uuid FK (it is `subType: "string", format: "uuid"` in the
 *     generated allowlist), and Postgres has no `uuid ~~* text` operator.
 *   - A malformed uuid in `:id`, or in a body FK, reached Postgres as a literal and failed
 *     with "invalid input syntax for type uuid" — a 500 where a malformed numeric id already
 *     answered 400 `invalid_id`.
 *
 * SQLite stores a uuid as text, so neither shows there. This runs the real chain: the schema
 * from the migrate engine, `entityFile()` + `routesFile()` emitted by `runGen`, and the
 * emitted `*.routes.ts` imported unmodified and mounted on Fastify.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { buildExpectedSchema, diff, emit, introspectPostgres } from "@metaobjectsdev/migrate-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

const META = `{
  "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Client", "children": [
      { "source.rdb": { "@table": "clients" } },
      { "field.uuid":   { "name": "id" } },
      { "field.string": { "name": "name", "@required": true, "@maxLength": 100, "@filterable": true } },
      { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "uuid" } }
    ] } },
    { "object.entity": { "name": "Project", "children": [
      { "source.rdb": { "@table": "projects" } },
      { "field.uuid":   { "name": "id" } },
      { "field.uuid":   { "name": "clientId", "@required": true, "@filterable": true } },
      { "field.string": { "name": "name", "@required": true, "@maxLength": 100, "@filterable": true } },
      { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "uuid" } },
      { "identity.reference": { "name": "fkClient", "@fields": "clientId", "@references": "Client" } }
    ] } }
  ] }
}`;

let runningPg: RunningPg;
let pool: pg.Pool;
let k: Kysely<any>;
let tmp: string;
let fastify: FastifyInstance;
let genPool: pg.Pool | undefined;
let clientId: string;

async function load() {
  return (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
}

async function call(method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fastify.inject({
    method: method as "GET",
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
}

beforeAll(async () => {
  runningPg = await startPostgres();
  pool = new pg.Pool({ connectionString: runningPg.connectionUri });
  k = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });

  // The schema the migrate engine builds, so the uuid columns are what `meta migrate` makes.
  await sql.raw(`DROP TABLE IF EXISTS "projects", "clients" CASCADE;`).execute(k);
  const result = await diff({
    expected: buildExpectedSchema(await load(), { dialect: "postgres" }),
    actual: await introspectPostgres(k),
    dialect: "postgres",
  });
  expect(result.blocked).toEqual([]);
  const { up } = emit(result.changes, { dialect: "postgres" });
  for (const stmt of up.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  tmp = mkdtempSync(join(genTmpRoot, "generated-uuid-routes-"));
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp, extStyle: "none", dbImport: "./db", dialect: "postgres",
      generators: [entityFile(), routesFile()],
    }),
    metadata: await load(),
  });
  if (lr.warnings.length > 0) throw new Error(`codegen warnings: ${lr.warnings.join("; ")}`);
  writeFileSync(join(tmp, "db.ts"), `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(runningPg.connectionUri)} });
export const db = drizzle(pool);
`, "utf8");

  type RoutesModule = Record<string, (f: FastifyInstance) => Promise<void>>;
  const clientRoutes = (await import(pathToFileURL(join(tmp, "Client.routes.ts")).href)) as RoutesModule;
  const projectRoutes = (await import(pathToFileURL(join(tmp, "Project.routes.ts")).href)) as RoutesModule;
  genPool = ((await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool }).pool;
  fastify = Fastify();
  await fastify.register(clientRoutes["clientRoutes"]!);
  await fastify.register(projectRoutes["projectRoutes"]!);
  await fastify.ready();

  const client = await call("POST", "/clients", { name: "Acme" });
  expect(client.status).toBe(201);
  clientId = client.body.id;
  for (const name of ["Acme relaunch", "Globex audit"]) {
    expect((await call("POST", "/projects", { clientId, name })).status).toBe(201);
  }
}, 180_000);

afterAll(async () => {
  await fastify?.close();
  await genPool?.end();
  await k?.destroy();
  await runningPg?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("stock generated routes — uuid keys and a uuid FK on real Postgres", () => {
  test("?search= on an entity with a uuid FK answers 200 and searches its text columns", async () => {
    const { status, body } = await call("GET", "/projects?search=acme");
    expect(status).toBe(200);
    expect(body.map((r: { name: string }) => r.name)).toEqual(["Acme relaunch"]);
  });

  test("filtering on the uuid FK still works", async () => {
    const { status, body } = await call("GET", `/projects?filter[clientId][eq]=${clientId}`);
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
  });

  for (const method of ["GET", "PATCH", "DELETE"]) {
    test(`${method} /projects/not-a-uuid answers 400 invalid_id`, async () => {
      const { status, body } = await call(method, "/projects/not-a-uuid", method === "PATCH" ? { name: "x" } : undefined);
      expect(status).toBe(400);
      expect(body).toEqual({ error: "invalid_id" });
    });
  }

  test("a well-formed uuid that names no row answers 404", async () => {
    expect((await call("GET", "/projects/00000000-0000-0000-0000-0000000000ff")).status).toBe(404);
  });

  test("POST and PATCH with a malformed uuid FK answer 400 validation", async () => {
    const created = await call("POST", "/projects", { clientId: "nope", name: "x" });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("validation");

    const target = (await call("GET", "/projects?search=globex")).body[0].id as string;
    const patched = await call("PATCH", `/projects/${target}`, { clientId: "123" });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toBe("validation");
  });
});
