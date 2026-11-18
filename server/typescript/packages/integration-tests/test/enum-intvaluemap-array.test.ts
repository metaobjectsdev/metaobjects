/**
 * Int-backed `field.enum` ARRAYS (`@intValueMap` + `isArray`) against real engines.
 *
 * Each element persists as its declared integer and reads back as its member. The
 * failure these tests exist for is design D7's: a codec that maps only scalars writes
 * the member SYMBOLS into the array, which Postgres' `integer[]` refuses outright but a
 * JSON-text column (SQLite, MySQL) stores without complaint. So every write below is
 * checked by reading the PHYSICAL value with raw SQL, bypassing the codec, and every
 * read starts from integers inserted with raw SQL, so the two directions cannot
 * merely cancel out.
 *
 * Two write paths, both covered: the generated Drizzle column codec (codegen-ts) and
 * the ObjectManager row codec (runtime-ts).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, diff, emit, introspectPostgres } from "@metaobjectsdev/migrate-ts";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/test-generators";
import { ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

/** The adopter shape: the map on a shared abstract enum, a scalar and an array field inheriting it. */
const META = `{
  "metadata.root": {
    "package": "acme",
    "children": [
      { "field.enum": { "name": "Status", "abstract": true,
        "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
        "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": {} },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "title", "@required": true } },
        { "field.enum":   { "name": "status", "extends": "Status" } },
        { "field.enum":   { "name": "history", "extends": "Status", "isArray": true } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
      ] } }
    ]
  }
}`;

function literalColumns<T>(root: T): T {
  (root as unknown as { physicalNaming: unknown }).physicalNaming = { columns: "literal", tables: "snake_case" };
  return root;
}

async function loadRoot(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(res.errors).toEqual([]);
  return literalColumns(res.root) as MetaRoot;
}

/** Emit the entity module INSIDE the package tree so its bare imports resolve, then import it unmodified. */
async function generated(dialect: "postgres" | "sqlite"): Promise<{ table: any; cleanup: () => void }> {
  const genTmpRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const dir = mkdtempSync(join(genTmpRoot, `enum-intmap-array-${dialect}-`));
  const lr = await runGen({
    config: defineConfig({ outDir: dir, extStyle: "none", dbImport: "./db", dialect, generators: [entityFile()] }),
    metadata: await loadRoot(),
  });
  if (lr.warnings.length > 0) throw new Error(`codegen warnings: ${lr.warnings.join("; ")}`);
  const mod: any = await import(pathToFileURL(join(dir, "Order.ts")).href);
  expect(mod.orders).toBeDefined();
  return { table: mod.orders, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The error message a query fails with (Drizzle builders are thenables, not promises). */
async function failure(run: () => PromiseLike<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected the query to fail, but it succeeded");
}

const SQLITE_DDL = `CREATE TABLE "orders" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT NOT NULL, "status" INTEGER, "history" TEXT)`;

describe("int-backed enum array — generated Drizzle codec on SQLite", () => {
  let table: any;
  let cleanup: () => void;
  let raw: Database;
  let db: any;

  beforeAll(async () => {
    ({ table, cleanup } = await generated("sqlite"));
    raw = new Database(":memory:");
    raw.run(SQLITE_DDL);
    db = drizzleSqlite(raw);
  }, 120_000);

  afterAll(() => {
    raw?.close();
    cleanup?.();
  });

  test("a member array is written as a JSON array of the mapped INTS", async () => {
    await db.insert(table).values({ title: "w", status: "ARCHIVED", history: ["PUBLISHED", "DRAFT"] });
    const row = raw.query(`SELECT "status", "history" FROM "orders" WHERE "title" = 'w'`).get() as Record<string, unknown>;
    expect(row.history).toBe("[5,0]");
    expect(row.status).toBe(9);
  });

  test("raw ints read back as members, in order; [] stays [], null stays null", async () => {
    raw.run(`INSERT INTO "orders" ("title","history") VALUES ('r1','[9,5]'), ('r2','[]'), ('r3', NULL)`);
    const rows: any[] = await db.select().from(table);
    const by = new Map(rows.map((r) => [r.title, r.history]));
    expect(by.get("r1")).toEqual(["ARCHIVED", "PUBLISHED"]);
    expect(by.get("r2")).toEqual([]);
    expect(by.get("r3")).toBeNull();
  });

  test("an unmapped stored int, or a stored SYMBOL, throws on read", async () => {
    for (const bad of ["[5,42]", '["PUBLISHED"]']) {
      const d = new Database(":memory:");
      d.run(SQLITE_DDL);
      d.run(`INSERT INTO "orders" ("title","history") VALUES ('bad', '${bad}')`);
      expect(await failure(() => drizzleSqlite(d).select().from(table))).toMatch(/unmapped historyIntEnumArray value/);
      d.close();
    }
  });

  test("an unmapped member throws on write instead of landing in the JSON", async () => {
    expect(() => db.insert(table).values({ title: "x", history: ["NOPE"] }).run()).toThrow(/unmapped historyIntEnumArray member/);
  });
});

describe("int-backed enum array — ObjectManager on SQLite", () => {
  test("create stores a JSON array of ints; findById reads members", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ivm-om-sqlite-"));
    const k = new Kysely<never>({ dialect: new LibsqlDialect({ url: `file:${join(dir, "t.db")}` }) });
    try {
      await sql.raw(SQLITE_DDL).execute(k);
      const om = new ObjectManager({ metadata: await loadRoot(), driver: kyselyDriver({ db: k as never, dialect: "sqlite" }) });
      const created = await om.create("Order", { title: "w", status: "PUBLISHED", history: ["ARCHIVED", "DRAFT"] });
      const physical = await sql<{ history: string }>`SELECT "history" FROM "orders"`.execute(k);
      expect(physical.rows[0]?.history).toBe("[9,0]");
      const back = await om.findById("Order", created.id);
      expect(back?.history).toEqual(["ARCHIVED", "DRAFT"]);
      expect(back?.status).toBe("PUBLISHED");
    } finally {
      await k.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("int-backed enum array — real Postgres", () => {
  let runningPg: RunningPg;
  let pool: pg.Pool;
  let k: Kysely<any>;
  let table: any;
  let cleanup: () => void;
  let db: any;

  beforeAll(async () => {
    runningPg = await startPostgres();
    pool = new pg.Pool({ connectionString: runningPg.connectionUri });
    k = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    const expected = buildExpectedSchema(await loadRoot(), { dialect: "postgres" });
    const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    expect(result.blocked).toEqual([]);
    const { up } = emit(result.changes, { dialect: "postgres" });
    for (const stmt of up.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
    }
    // THE convergence gate: a second migrate against the migrated DB is a no-op.
    const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    expect(followup.changes).toEqual([]);
    ({ table, cleanup } = await generated("postgres"));
    db = drizzlePg(pool);
  }, 180_000);

  afterAll(async () => {
    await k?.destroy();
    await runningPg?.stop();
    cleanup?.();
  });

  test("the column is integer[] with no CHECK", async () => {
    const col = await sql<{ udt_name: string }>`
      SELECT udt_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'history'`.execute(k);
    expect(col.rows[0]?.udt_name).toBe("_int4");
    const checks = await sql<{ conname: string }>`
      SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c'`.execute(k);
    expect(checks.rows.map((r) => r.conname)).toEqual(["orders_status_chk"]);
  });

  test("Drizzle writes the mapped ints and reads raw ints back as members", async () => {
    await db.insert(table).values({ title: "d", history: ["PUBLISHED", "DRAFT"] });
    const physical = await sql<{ history: number[] }>`SELECT "history" FROM "orders" WHERE "title" = 'd'`.execute(k);
    expect(physical.rows[0]?.history).toEqual([5, 0]);
    await sql.raw(`INSERT INTO "orders" ("title","history") VALUES ('d2', '{9,NULL,5}'), ('d3', '{}')`).execute(k);
    const rows: any[] = await db.select().from(table);
    const by = new Map(rows.map((r) => [r.title, r.history]));
    expect(by.get("d")).toEqual(["PUBLISHED", "DRAFT"]);
    // A null ELEMENT reads back null, as in a string-backed text[].
    expect(by.get("d2")).toEqual(["ARCHIVED", null, "PUBLISHED"]);
    expect(by.get("d3")).toEqual([]);
  });

  test("ObjectManager writes the mapped ints and reads them back as members", async () => {
    const om = new ObjectManager({ metadata: await loadRoot(), driver: kyselyDriver({ db: k as never, dialect: "postgres" }) });
    const created = await om.create("Order", { title: "o", status: "DRAFT", history: ["ARCHIVED"] });
    const physical = await sql<{ history: number[] }>`SELECT "history" FROM "orders" WHERE "title" = 'o'`.execute(k);
    expect(physical.rows[0]?.history).toEqual([9]);
    expect((await om.findById("Order", created.id))?.history).toEqual(["ARCHIVED"]);
  });

  test("an unmapped stored int throws on read through both codecs", async () => {
    await sql.raw(`INSERT INTO "orders" ("title","history") VALUES ('bad', '{5,42}')`).execute(k);
    expect(await failure(() => db.select().from(table))).toMatch(/unmapped historyIntEnum value/);
    const om = new ObjectManager({ metadata: await loadRoot(), driver: kyselyDriver({ db: k as never, dialect: "postgres" }) });
    await expect(om.findMany("Order", { title: "bad" })).rejects.toThrow(/stored value 42 with no member/);
    await sql.raw(`DELETE FROM "orders" WHERE "title" = 'bad'`).execute(k);
  });
});
