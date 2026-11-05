// `field.object @storage: "flattened"` (#524). The generated Drizzle table must bind the columns
// `meta migrate` creates (one per member of the value object, none for the field), and the
// value object must stay a nested JSON object through the generated queries and routes.
//
//  1. parity: the columns of the generated table, per dialect, are exactly migrate-ts's expected
//     schema for the same model;
//  2. round trip: GENERATED entity, queries and routes executed over bun:sqlite. The surface is
//     FLAT (as the Prisma generator's): each member is a key `<field><Member>` (`shipToStreet`)
//     on the row, the write schemas and the filter allowlist.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts";
import { runGen } from "../src/runner.js";
import { defineConfig, type Dialect } from "../src/metaobjects-config.js";
import { entityFile } from "../src/reference/entity.js";
import { queriesFile } from "../src/reference/queries.js";
import { routesFileHono } from "../src/reference/routes-hono.js";
import { routesFile } from "../src/reference/routes.js";

const META = JSON.stringify({
  "metadata.root": { package: "acme", children: [
    { "object.value": { name: "Address", children: [
      { "field.string": { name: "street" } },
      { "field.string": { name: "city", "@filterable": true } },
      { "field.int": { name: "floor" } },
    ] } },
    { "object.entity": { name: "Shipment", children: [
      { "source.rdb": { "@table": "shipments" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "ref", "@required": true } },
      { "field.object": { name: "shipTo", "@objectRef": "Address", "@storage": "flattened" } },
      { "field.object": { name: "billTo", "@objectRef": "Address", "@storage": "flattened", "@required": true } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ] } },
  ] },
});

async function load(): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(META, { id: "acme.json" })]);
  expect(errors).toEqual([]);
  return root;
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function generate(root: MetaRoot, dialect: Dialect, generators: ReturnType<typeof entityFile>[], parent: string): Promise<string> {
  const repo = mkdtempSync(join(parent, "flat-"));
  dirs.push(repo);
  const outDir = join(repo, "out");
  await runGen({
    config: defineConfig({ outDir, dialect, extStyle: "js", dbImport: "../db", generators }),
    metadata: root,
    projectRoot: repo,
  });
  return outDir;
}

const allTs = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));

describe("flattened storage: generated Drizzle columns match migrate's expected schema", () => {
  const expectedColumns = async (): Promise<string[]> => {
    const expected = buildExpectedSchema(await load(), { dialect: "postgres" });
    return expected.tables.find((t) => t.name === "shipments")!.columns.map((c) => c.name).sort();
  };

  test("migrate creates one column per member and none for the field", async () => {
    expect(await expectedColumns()).toEqual([
      "bill_to_city", "bill_to_floor", "bill_to_street", "id", "ref",
      "ship_to_city", "ship_to_floor", "ship_to_street",
    ]);
  });

  for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
    test(`${dialect}: the Drizzle table binds exactly those columns`, async () => {
      const outDir = await generate(await load(), dialect, [entityFile()], tmpdir());
      const file = allTs(outDir).find((f) => f.endsWith("Shipment.ts"))!;
      const source = readFileSync(file, "utf8");
      const table = source.slice(source.indexOf("Table(\"shipments\""), source.indexOf("});", source.indexOf("Table(\"shipments\"")));
      const bound = [...table.matchAll(/^\s+\w+: \w+\("([^"]+)"/gm)].map((m) => m[1]!).sort();
      expect(bound).toEqual(await expectedColumns());
      // The issue's defect: a single jsonb column named for the field.
      expect(table).not.toContain('"ship_to"');
      expect(table).not.toMatch(/jsonb\(/);
    });
  }
});

describe("flattened storage: a TPH subtype's own flattened field keeps migrate's single column", () => {
  test("migrate folds a subtype's field.object as one column, so the table binds one column named for the field", async () => {
    const TPH = JSON.stringify({
      "metadata.root": { package: "acme", children: [
        { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }] } },
        { "object.entity": { name: "Party", "@discriminator": "kind", children: [
          { "source.rdb": { "@table": "parties" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "kind", "@required": true } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ] } },
        { "object.entity": { name: "Org", extends: "Party", "@discriminatorValue": "org", children: [
          { "field.object": { name: "hq", "@objectRef": "Address", "@storage": "flattened" } },
        ] } },
      ] },
    });
    const { root } = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(TPH, { id: "tph.json" })]);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const expectedColumns = expected.tables.find((t) => t.name === "parties")!.columns.map((c) => c.name).sort();
    const outDir = await generate(root, "postgres", [entityFile()], tmpdir());
    const source = readFileSync(allTs(outDir).find((f) => f.endsWith("Party.ts"))!, "utf8");
    const table = source.slice(source.indexOf("Table(\"parties\""), source.indexOf("});", source.indexOf("Table(\"parties\"")));
    const bound = [...table.matchAll(/^\s+\w+: \w+\("([^"]+)"/gm)].map((m) => m[1]!).sort();
    expect(bound).toEqual(expectedColumns);
  });
});

describe("flattened storage: a value object has no table, so it does not flatten", () => {
  test("a flattened field on an object.value stays one key", async () => {
    const VO = JSON.stringify({
      "metadata.root": { package: "acme", children: [
        { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }] } },
        { "object.value": { name: "Contact", children: [
          { "field.object": { name: "home", "@objectRef": "Address", "@storage": "flattened" } },
        ] } },
      ] },
    });
    const { root } = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(VO, { id: "vo.json" })]);
    const outDir = await generate(root, "sqlite", [entityFile()], import.meta.dir);
    const mod = (await import(pathToFileURL(allTs(outDir).find((f) => f.endsWith("Contact.ts"))!).href)) as Record<string, { shape?: object }>;
    const schema = Object.values(mod).find((v) => typeof v === "object" && v !== null && "shape" in v)!;
    expect(Object.keys(schema.shape!)).toEqual(["home"]);
  });
});

describe("flattened storage: a write-through entity is refused, not emitted broken", () => {
  test("the replica view has no flattened-member form", async () => {
    const WT = JSON.stringify({
      "metadata.root": { package: "acme", children: [
        { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }] } },
        { "object.entity": { name: "Site", children: [
          { "source.rdb": { "@table": "sites", "@role": "primary" } },
          { "source.rdb": { "@kind": "view", "@view": "v_sites", "@role": "replica" } },
          { "field.long": { name: "id" } },
          { "field.object": { name: "hq", "@objectRef": "Address", "@storage": "flattened" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ] } },
      ] },
    });
    const { root } = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(WT, { id: "wt.json" })]);
    await expect(generate(root, "sqlite", [entityFile()], tmpdir())).rejects.toThrow(/flattened/);
  });
});

describe("flattened storage: generated queries and routes, executed on SQLite", () => {
  let queries: Record<string, (...args: unknown[]) => Promise<unknown>>;
  let app: Hono;
  let sqlite: Database;
  let db: unknown;

  beforeAll(async () => {
    const outDir = await generate(
      await load(), "sqlite",
      [entityFile({ runtimeImport: "@metaobjectsdev/runtime-ts" }), queriesFile(), routesFileHono({ runtimeImport: "@metaobjectsdev/runtime-ts" }), routesFile({ runtimeImport: "@metaobjectsdev/runtime-ts" })],
      import.meta.dir,
    );
    sqlite = new Database(":memory:");
    // The DDL `meta migrate` produces for this model (columns asserted equal above).
    sqlite.run(`CREATE TABLE shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL,
      ship_to_street TEXT, ship_to_city TEXT, ship_to_floor INTEGER,
      bill_to_street TEXT, bill_to_city TEXT, bill_to_floor INTEGER)`);
    db = drizzle(sqlite);
    const find = (suffix: string) => allTs(outDir).find((f) => f.endsWith(suffix))!;
    queries = (await import(pathToFileURL(find("Shipment.queries.ts")).href)) as typeof queries;
    const hono = (await import(pathToFileURL(find("Shipment.routes.hono.ts")).href)) as Record<string, (app: Hono, deps: { db: unknown }) => void>;
    app = new Hono();
    hono["registerShipmentRoutes"]!(app, { db });
  });

  const post = (body: unknown) => app.request("/shipments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("create stores the member columns and answers the flat keys", async () => {
    const row = await queries["createShipment"]!(db, { ref: "a", shipToStreet: "1 Main", shipToCity: "Oslo", shipToFloor: 3, billToStreet: "2 Side" });
    expect(row).toMatchObject({ ref: "a", shipToStreet: "1 Main", shipToCity: "Oslo", shipToFloor: 3, billToStreet: "2 Side", billToCity: null });
    expect(row).not.toHaveProperty("shipTo");
    expect(sqlite.query("SELECT ship_to_street, ship_to_floor, bill_to_street FROM shipments WHERE ref = 'a'").get())
      .toEqual({ ship_to_street: "1 Main", ship_to_floor: 3, bill_to_street: "2 Side" });
  });

  test("find, list and update read and write the flat keys", async () => {
    const created = (await queries["createShipment"]!(db, { ref: "b", shipToCity: "Rome" })) as { id: number };
    expect(await queries["findShipmentById"]!(db, created.id)).toMatchObject({ shipToCity: "Rome", shipToStreet: null });
    const updated = await queries["updateShipment"]!(db, created.id, { shipToStreet: "new" });
    expect(updated).toMatchObject({ shipToStreet: "new", shipToCity: "Rome" });
    expect(((await queries["listShipments"]!(db)) as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  test("Hono routes: flat JSON in and out", async () => {
    const res = await post({ ref: "r", shipToStreet: "1 Main", shipToFloor: 2 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number };
    expect(body).toMatchObject({ shipToStreet: "1 Main", shipToFloor: 2, shipToCity: null });
    const patched = await app.request(`/shipments/${body.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ shipToCity: "Bergen" }) });
    expect(await patched.json()).toMatchObject({ shipToStreet: "1 Main", shipToCity: "Bergen" });
  });

  test("a member of the wrong type is a 400", async () => {
    expect((await post({ ref: "bad", billToFloor: "high" })).status).toBe(400);
  });

  test("a flattened member filters and sorts by its flat key", async () => {
    await queries["createShipment"]!(db, { ref: "f1", shipToCity: "Zagreb" });
    await queries["createShipment"]!(db, { ref: "f2", shipToCity: "Athens" });
    const filtered = await app.request("/shipments?filter[shipToCity][eq]=Zagreb");
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { ref: string }[]).map((r) => r.ref)).toEqual(["f1"]);
    const sorted = await app.request("/shipments?filter[shipToCity][in]=Zagreb,Athens&sort=shipToCity:asc");
    expect(sorted.status).toBe(200);
    expect(((await sorted.json()) as { ref: string }[]).map((r) => r.ref)).toEqual(["f2", "f1"]);
  });

  test("Fastify routes: flat JSON in and out", async () => {
    const outDir = join(dirs[dirs.length - 1]!, "out");
    // fastify is runtime-ts's dev dependency, not codegen-ts's: resolve it from there.
    const fastifyPath = Bun.resolveSync("fastify", join(import.meta.dir, "../../runtime-ts"));
    const Fastify = ((await import(pathToFileURL(fastifyPath).href)) as { default: () => FastifyLike }).default;
    // The Fastify routes import the app's database module; supply the same in-memory one.
    const { writeFileSync } = await import("node:fs");
    (globalThis as { __flatDb?: unknown }).__flatDb = db;
    writeFileSync(join(outDir, "..", "db.ts"), "export const db = (globalThis as { __flatDb?: unknown }).__flatDb as never;\nexport default db;\n");
    const routes = (await import(pathToFileURL(allTs(outDir).find((f) => f.endsWith("Shipment.routes.ts"))!).href)) as Record<string, (f: FastifyLike) => Promise<void>>;
    const f = Fastify();
    const register = Object.values(routes).find((v) => typeof v === "function")!;
    await register(f);
    const created = await f.inject({ method: "POST", url: "/shipments", payload: { ref: "fx", shipToStreet: "9 Elm", billToFloor: 4 } });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: number };
    expect(body).toMatchObject({ shipToStreet: "9 Elm", billToFloor: 4, shipToCity: null });
    const got = await f.inject({ method: "GET", url: `/shipments/${body.id}` });
    expect(got.json()).toEqual(body);
    await f.close();
  });
});

interface FastifyLike {
  inject: (o: object) => Promise<{ statusCode: number; json: () => unknown }>;
  close: () => Promise<void>;
}
