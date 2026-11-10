/**
 * An enum's `@default` is what an untouched record stores — against a live Postgres.
 *
 * The C# port stored the wrong member here: its entity started at default(TEnum), not at
 * `@default`, and EF wrote that. The TypeScript port has no constructed record; a create
 * that omits the field leaves it out of the INSERT, so the column DEFAULT `meta migrate`
 * builds must be `@default` in the column's own representation (the member for a
 * string-stored enum, the mapped integer under `@intValueMap`). This proves it through
 * every TypeScript write path: the generated `create`, Drizzle on the generated table, and
 * the runtime ObjectManager.
 *
 * Three backings: string-stored, an int map with a 0 member (0 is not the default), and an
 * int map with no 0 member. Each is declared required and nullable.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { buildExpectedSchema, diff, emit, introspectPostgres } from "@metaobjectsdev/migrate-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile } from "@metaobjectsdev/test-generators";
import { ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg, { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

const META = `{
  "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Setting", "children": [
      { "source.rdb": { "@table": "settings" } },
      { "field.long":   { "name": "id" } },
      { "field.string": { "name": "title", "@required": true } },
      { "field.enum": { "name": "mode", "@values": ["AUTO", "MANUAL"], "@required": true, "@default": "MANUAL" } },
      { "field.enum": { "name": "optMode", "@values": ["AUTO", "MANUAL"], "@default": "MANUAL" } },
      { "field.enum": { "name": "rank", "@values": ["LOW", "HIGH"], "@intValueMap": { "LOW": 0, "HIGH": 1 },
          "@required": true, "@default": "HIGH" } },
      { "field.enum": { "name": "optRank", "@values": ["LOW", "HIGH"], "@intValueMap": { "LOW": 0, "HIGH": 1 },
          "@default": "HIGH" } },
      { "field.enum": { "name": "band", "@values": ["LOW", "HIGH"], "@intValueMap": { "LOW": 1, "HIGH": 2 },
          "@required": true, "@default": "HIGH" } },
      { "field.enum": { "name": "optBand", "@values": ["LOW", "HIGH"], "@intValueMap": { "LOW": 1, "HIGH": 2 },
          "@default": "HIGH" } },
      { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
    ] } }
  ] }
}`;

/** The physical row an untouched create must leave: the member, or its mapped integer. */
const DEFAULTED_ROW = { mode: "MANUAL", optMode: "MANUAL", rank: 1, optRank: 1, band: 2, optBand: 2 };

function literalColumns<T>(root: T): T {
  (root as unknown as { physicalNaming: unknown }).physicalNaming = { columns: "literal", tables: "snake_case" };
  return root;
}

let runningPg: RunningPg;
let pool: Pool;
let k: Kysely<any>;
let tmp: string;
let q: any;
let entity: any;
let gpool: pg.Pool;
let gdb: any;

async function load() {
  return literalColumns((await new MetaDataLoader().load([new InMemoryStringSource(META)])).root);
}

beforeAll(async () => {
  runningPg = await startPostgres();
  pool = new Pool({ connectionString: runningPg.connectionUri });
  k = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });

  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  tmp = mkdtempSync(join(genTmpRoot, "enum-default-"));
  const lr = await runGen({
    config: defineConfig({ outputLayout: "flat", 
      outDir: tmp, extStyle: "none", dbImport: "./db", dialect: "postgres",
      generators: [entityFile(), queriesFile()],
    }),
    metadata: await load(),
  });
  if (lr.warnings.length > 0) throw new Error(`codegen warnings: ${lr.warnings.join("; ")}`);
  q = await import(pathToFileURL(join(tmp, "Setting.queries.ts")).href);
  entity = await import(pathToFileURL(join(tmp, "Setting.ts")).href);
  gpool = new pg.Pool({ connectionString: runningPg.connectionUri });
  gdb = drizzle(gpool);
}, 180_000);

afterAll(async () => {
  await gpool?.end();
  await k?.destroy();
  await runningPg?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.raw(`DROP TABLE IF EXISTS "settings" CASCADE;`).execute(k);
  const expected = buildExpectedSchema(await load(), { dialect: "postgres" });
  const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
  expect(result.blocked).toEqual([]);
  const { up } = emit(result.changes, { dialect: "postgres" });
  for (const stmt of up.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }
});

async function physicalRow(title: string): Promise<Record<string, unknown>> {
  const rows = await sql<Record<string, unknown>>`
    SELECT "mode", "optMode", "rank", "optRank", "band", "optBand" FROM "settings" WHERE "title" = ${title}
  `.execute(k);
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0]!;
}

describe("an enum's @default is what an untouched record stores — real Postgres", () => {
  test("the generated create, given no enum, stores each @default", async () => {
    const created = await q.createSetting(gdb, { title: "gen" });
    expect(await physicalRow("gen")).toEqual(DEFAULTED_ROW);
    // ...and hands the members back, decoded.
    expect(created.mode).toBe("MANUAL");
    expect(created.rank).toBe("HIGH");
    expect(created.band).toBe("HIGH");
    expect(created.optBand).toBe("HIGH");
  }, 120_000);

  test("Drizzle on the generated table, given no enum, stores each @default", async () => {
    await gdb.insert(entity.settings).values({ title: "drizzle" });
    expect(await physicalRow("drizzle")).toEqual(DEFAULTED_ROW);
  }, 120_000);

  test("the ObjectManager, given no enum, stores each @default", async () => {
    const om = new ObjectManager({
      metadata: await load(),
      driver: kyselyDriver({ db: k as never, dialect: "postgres" }),
    });
    const created = await om.create("Setting", { title: "om" });
    expect(await physicalRow("om")).toEqual(DEFAULTED_ROW);
    expect(created.band).toBe("HIGH");
  }, 120_000);

  test("an explicit first member is stored as set", async () => {
    // (The TypeScript create shape takes an omitted non-required field, never a null one.)
    await q.createSetting(gdb, {
      title: "set", mode: "AUTO", optMode: "AUTO", rank: "LOW", optRank: "LOW", band: "LOW", optBand: "LOW",
    });
    expect(await physicalRow("set")).toEqual({ mode: "AUTO", optMode: "AUTO", rank: 0, optRank: 0, band: 1, optBand: 1 });
  }, 120_000);
});
