/**
 * Int-backed `field.enum` (`@intValueMap`) — the REAL gate, against a live Postgres.
 *
 * WHY THIS EXISTS
 *
 * Everything else about int-backed enums is verified by unit assertions and by
 * inspecting generated source: migrate-ts says the column is `integer`, codegen-ts
 * says the Drizzle column is a `customType`, and both say the CHECK lists unquoted
 * integers. None of that proves the DDL APPLIES, that a second migrate CONVERGES, or
 * that the codec actually round-trips a member symbol through a real integer column.
 *
 * This repo has a monument to exactly that gap: the 0.15.21 line, where a family of
 * destructive migrate bugs survived a suite of thousands because nothing ever ran the
 * pipeline twice against a real engine. `emit` and `introspect` had never been in the
 * same room. The same is true here until this file runs.
 *
 * So: apply to a REAL engine, RE-DIFF, and then prove the value semantics both ways —
 * a symbol written through the generated codec must land as the mapped INTEGER in the
 * physical column, and an integer already in the column must read back as the symbol.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchema, diff, emit, introspectPostgres,
  type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig, buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile } from "@metaobjectsdev/codegen-ts/generators";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg, { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

// The map is deliberately SPARSE and non-ordinal (0/5/9) so any accidental
// index-of-@values correspondence shows up as a wrong number rather than passing
// by coincidence — the failure mode the design's Goal 3 calls out.
const INT_MAP = { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 } as const;

/** An entity with an int-backed enum. The map lives on a SHARED root-level abstract
 *  declaration and the field inherits it — the shape #246 steers authors toward, and
 *  the one an own-only read would silently get wrong. */
function meta(opts: { withDefault?: boolean } = {}): string {
  const dflt = opts.withDefault ? `, "@default": "PUBLISHED"` : "";
  return `{
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
          { "field.enum":   { "name": "status", "extends": "Status", "@required": true${dflt} } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } }
      ]
    }
  }`;
}

/** The string-backed control: identical model minus @intValueMap. */
function metaStringBacked(): string {
  return `{
    "metadata.root": {
      "package": "acme",
      "children": [
        { "object.entity": { "name": "Order", "children": [
          { "source.rdb": {} },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "title", "@required": true } },
          { "field.enum":   { "name": "status", "@required": true,
            "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } }
      ]
    }
  }`;
}

let runningPg: RunningPg;
let pool: Pool;
let k: Kysely<any>;
/** Shared with the generated-codec block below, which needs its own Drizzle pool
 *  against the SAME database the DDL was applied to. */
let pg2Uri: string;

beforeAll(async () => {
  runningPg = await startPostgres();
  pg2Uri = runningPg.connectionUri;
  pool = new Pool({ connectionString: runningPg.connectionUri });
  k = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
}, 120_000);

afterAll(async () => {
  await k?.destroy();
  await runningPg?.stop();
});

beforeEach(async () => {
  await sql.raw(`DROP TABLE IF EXISTS "orders" CASCADE;`).execute(k);
  await sql.raw(`DROP TABLE IF EXISTS orders CASCADE;`).execute(k);
  // The TPH block below builds its own base table; CASCADE also clears any
  // dependent view left by the projection block.
  await sql.raw(`DROP TABLE IF EXISTS "auths" CASCADE;`).execute(k);
});

async function applyRaw(ddl: string): Promise<void> {
  for (const stmt of ddl.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }
}

async function expectedFor(metaJson: string): Promise<SchemaSnapshot> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
  return buildExpectedSchema(root, { columnNamingStrategy: "literal", dialect: "postgres" });
}

/** build → introspect → diff → emit → apply, then return the expected side. */
async function migrate(metaJson: string): Promise<SchemaSnapshot> {
  const expected = await expectedFor(metaJson);
  const result = await diff({
    expected, actual: await introspectPostgres(k), dialect: "postgres",
  });
  expect(result.blocked).toEqual([]);
  const { up } = result.changes.length === 0
    ? { up: "" }
    : emit(result.changes, { dialect: "postgres" });
  if (up.trim().length > 0) await applyRaw(up);
  return expected;
}

/** THE gate: a second migrate against the just-migrated DB must be a no-op. */
async function assertConverged(expected: SchemaSnapshot): Promise<void> {
  const followup = await diff({
    expected, actual: await introspectPostgres(k), dialect: "postgres",
  });
  if (followup.changes.length > 0) {
    console.error("NOT CONVERGED — a second migrate would emit:");
    for (const c of followup.changes) console.error("  -", c.kind, JSON.stringify(c).slice(0, 300));
  }
  expect(followup.changes).toEqual([]);
}

describe("int-backed field.enum — real Postgres", () => {
  test("the emitted DDL APPLIES and a second migrate converges", async () => {
    const expected = await migrate(meta());
    await assertConverged(expected);
  }, 120_000);

  test("the physical column is integer, not text", async () => {
    await migrate(meta());
    const rows = await sql<{ data_type: string }>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'status'
    `.execute(k);
    expect(rows.rows[0]?.data_type).toBe("integer");
  }, 120_000);

  test("the CHECK enforces the mapped INTEGERS — a valid member's int is accepted, a non-member int rejected", async () => {
    await migrate(meta());
    // 5 === PUBLISHED, so this must be accepted.
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('ok', 5);`).execute(k);
    // 7 maps to no member. If the CHECK had been emitted over the member STRINGS
    // (or omitted), this would succeed and the column would hold an impossible value.
    let rejected = false;
    try {
      await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('bad', 7);`).execute(k);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 120_000);

  test("an ordinal-looking wrong value is rejected — the map is sparse, not positional", async () => {
    await migrate(meta());
    // ARCHIVED is index 2 in @values but maps to 9. If anything derived the stored
    // int from the member's POSITION (design Goal 3's hazard), 2 would be valid.
    let rejected = false;
    try {
      await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('ordinal', 2);`).execute(k);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 120_000);

  test("@default lands as the mapped integer, appliably", async () => {
    const expected = await migrate(meta({ withDefault: true }));
    await assertConverged(expected);
    await sql.raw(`INSERT INTO "orders" ("title") VALUES ('defaulted');`).execute(k);
    const rows = await sql<{ status: number }>`
      SELECT "status" FROM "orders" WHERE "title" = 'defaulted'
    `.execute(k);
    // PUBLISHED === 5. A DEFAULT 'PUBLISHED' on an integer column would not have
    // applied at all, so reaching this assertion is itself part of the proof.
    expect(rows.rows[0]?.status).toBe(5);
  }, 120_000);

  test("the string-backed control still gets a text column and converges", async () => {
    const expected = await migrate(metaStringBacked());
    await assertConverged(expected);
    const rows = await sql<{ data_type: string }>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'status'
    `.execute(k);
    expect(rows.rows[0]?.data_type).toBe("text");
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('s', 'DRAFT');`).execute(k);
  }, 120_000);

  test("toggling the backing on an existing table is BLOCKED (no silent destructive recast)", async () => {
    await migrate(metaStringBacked());
    const intExpected = await expectedFor(meta());
    const result = await diff({
      expected: intExpected, actual: await introspectPostgres(k), dialect: "postgres",
    });
    const typeChange = result.changes.find((c) => c.kind === "change-column-type");
    expect(typeChange).toBeDefined();
    expect(typeChange!.status.state).toBe("blocked");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The CODEC half. Everything above exercises the SCHEMA through raw SQL, so
// customType's toDriver/fromDriver had still never run against a database. This
// block emits the REAL entity file via runGen, imports it unmodified, and drives
// Drizzle through it — the only way to prove the generated codec, as opposed to
// a hand-written mirror of what we think it generates.
// ---------------------------------------------------------------------------

describe("int-backed field.enum — generated codec against real Postgres", () => {
  // Emit INSIDE the package tree (.gen-tmp/, gitignored): the generated module
  // resolves bare specifiers like `drizzle-orm/pg-core` by walking up to a
  // node_modules chain, which the OS tmpdir never reaches.
  let tmp: string;
  let ordersTable: any;
  let gdb: any;
  let gpool: pg.Pool;

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const genTmpRoot = join(here, "..", ".gen-tmp");
    mkdirSync(genTmpRoot, { recursive: true });
    tmp = mkdtempSync(join(genTmpRoot, "enum-intmap-"));

    const root = (await new MetaDataLoader().load([new InMemoryStringSource(meta())])).root;
    const lr = await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "./db",
        dialect: "postgres",
        generators: [entityFile()],
      }),
      metadata: root,
    });
    if (lr.warnings.length > 0) throw new Error(`codegen warnings: ${lr.warnings.join("; ")}`);

    // The emitted entity module, imported UNMODIFIED — codec included.
    const entityUrl = pathToFileURL(join(tmp, "Order.ts")).href;
    const mod: any = await import(entityUrl);
    ordersTable = mod.orders;
    expect(ordersTable).toBeDefined();

    gpool = new pg.Pool({ connectionString: pg2Uri });
    gdb = drizzle(gpool);
  }, 180_000);

  afterAll(async () => {
    await gpool?.end();
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Schema provisioned from the SAME metadata via migrate-ts, so the physical
    // shape the codec writes into is the one the DDL pipeline produces.
    await migrate(meta());
  });

  test("a member symbol written through Drizzle lands as the mapped INTEGER", async () => {
    await gdb.insert(ordersTable).values({ title: "w", status: "PUBLISHED" });
    // Read the PHYSICAL value with raw SQL — bypassing the codec entirely, so this
    // asserts what is actually on disk rather than what the codec round-trips.
    const raw = await sql<{ status: number }>`SELECT "status" FROM "orders" WHERE "title" = 'w'`.execute(k);
    expect(raw.rows[0]?.status).toBe(5);
  }, 120_000);

  test("an integer already in the column reads back as its member symbol", async () => {
    // Insert 9 (ARCHIVED) with raw SQL so the value never passes through toDriver —
    // proving fromDriver decodes, not merely that the two directions cancel out.
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('r', 9);`).execute(k);
    const rows = await gdb.select().from(ordersTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ARCHIVED");
  }, 120_000);

  test("round-trips every member, including the ZERO-valued one", async () => {
    for (const m of ["DRAFT", "PUBLISHED", "ARCHIVED"]) {
      await gdb.insert(ordersTable).values({ title: m, status: m });
    }
    const rows = await gdb.select().from(ordersTable);
    const byTitle = new Map(rows.map((r: any) => [r.title, r.status]));
    // DRAFT maps to 0 — falsy, and therefore the value any truthiness-based codec
    // silently drops or coerces (the #235 bug class).
    expect(byTitle.get("DRAFT")).toBe("DRAFT");
    expect(byTitle.get("PUBLISHED")).toBe("PUBLISHED");
    expect(byTitle.get("ARCHIVED")).toBe("ARCHIVED");
    const raws = await sql<{ title: string; status: number }>`SELECT "title", "status" FROM "orders"`.execute(k);
    expect(new Map(raws.rows.map((r) => [r.title, r.status])).get("DRAFT")).toBe(0);
  }, 120_000);

  // Task 8 — the filter path. This is the claim that customType makes the
  // filter work "for free": Drizzle binds a WHERE comparison through the column
  // type, so a member symbol encodes without the filter layer knowing anything.
  test("a WHERE comparison on a member symbol encodes through the column type", async () => {
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('a', 0), ('b', 9);`).execute(k);
    const archived = await gdb.select().from(ordersTable).where(eq(ordersTable.status, "ARCHIVED"));
    expect(archived).toHaveLength(1);
    expect(archived[0].title).toBe("b");
    const drafts = await gdb.select().from(ordersTable).where(eq(ordersTable.status, "DRAFT"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe("a");
  }, 120_000);

  test("an `in` comparison encodes every member in the list", async () => {
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('a', 0), ('b', 5), ('c', 9);`).execute(k);
    const some = await gdb.select().from(ordersTable)
      .where(inArray(ordersTable.status, ["DRAFT", "ARCHIVED"]));
    expect(some.map((r: any) => r.title).sort()).toEqual(["a", "c"]);
  }, 120_000);

  test("an unmapped stored integer throws on read instead of yielding undefined", async () => {
    // The CHECK normally makes this unreachable; drop it to simulate data written
    // before a member was removed, or by a hand-written migration.
    await sql.raw(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_chk";`).execute(k);
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('bogus', 42);`).execute(k);
    let threw = false;
    try {
      await gdb.select().from(ordersTable);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("unmapped");
    }
    expect(threw).toBe(true);
  }, 120_000);
});

/**
 * A projection row-scope `@filter` (#207) on an int-backed enum.
 *
 * The view body is emitted as LITERAL SQL text and never touches Drizzle, so the
 * customType that rescues the runtime query path does nothing here. Before the fix
 * this emitted `WHERE p.status = 'PUBLISHED'` against an `integer` column, which
 * Postgres rejects at CREATE VIEW time — `invalid input syntax for type integer` —
 * aborting the migration. A unit assertion on the emitted string cannot show that;
 * only applying it can.
 */
describe("int-backed field.enum in a projection view — real Postgres", () => {
  function metaWithView(): string {
    return `{
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
            { "field.enum":   { "name": "status", "extends": "Status", "@required": true } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ] } },
          { "object.projection": { "name": "PublishedOrders",
            "@filter": { "status": { "eq": "PUBLISHED" } }, "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_published_orders" } },
            { "identity.primary": { "name": "id", "extends": "Order.id", "@fields": "id" } },
            { "field.long":   { "name": "id", "extends": "Order.id", "children": [
              { "origin.passthrough": { "@from": "Order.id" } } ] } },
            { "field.string": { "name": "title", "children": [
              { "origin.passthrough": { "@from": "Order.title" } } ] } },
            { "field.enum":   { "name": "status", "extends": "Status", "children": [
              { "origin.passthrough": { "@from": "Order.status" } } ] } }
          ] } }
        ]
      }
    }`;
  }

  /** Views are NOT derived by buildExpectedSchema — they must be passed in
   *  explicitly, so this block needs its own migrate helper rather than the
   *  table-only one above. */
  async function migrateWithViews(metaJson: string): Promise<SchemaSnapshot> {
    const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
    const expected = buildExpectedSchema(root, {
      columnNamingStrategy: "literal",
      dialect: "postgres",
      views: buildProjectionViews(root, {
        dialect: "postgres", columnNamingStrategy: "literal",
      }),
    });
    const result = await diff({
      expected, actual: await introspectPostgres(k), dialect: "postgres",
    });
    expect(result.blocked).toEqual([]);
    const { up } = result.changes.length === 0
      ? { up: "" }
      : emit(result.changes, { dialect: "postgres" });
    if (up.trim().length > 0) await applyRaw(up);
    return expected;
  }

  test("the filtered view APPLIES, converges, and selects by the INTEGER", async () => {
    const expected = await migrateWithViews(metaWithView());
    // The view exists — i.e. the CREATE VIEW did not blow up on a text-vs-integer
    // comparison. This is the assertion the whole test exists for.
    await assertConverged(expected);

    await sql.raw(
      `INSERT INTO "orders" ("title", "status") VALUES ('a', 0), ('b', 5), ('c', 9), ('d', 5);`,
    ).execute(k);

    const rows = await sql<{ title: string }>`
      SELECT "title" FROM "v_published_orders" ORDER BY "title"
    `.execute(k);
    // Only the two PUBLISHED (5) rows — proving the WHERE compared 5, not 'PUBLISHED'.
    expect(rows.rows.map((r) => r.title)).toEqual(["b", "d"]);
  }, 120_000);

  test("the emitted view body carries the integer literal, not the member symbol", async () => {
    const root = (await new MetaDataLoader().load([
      new InMemoryStringSource(metaWithView()),
    ])).root;
    const views = buildProjectionViews(root, {
      dialect: "postgres", columnNamingStrategy: "literal",
    });
    const body = views.find((v) => v.name === "v_published_orders")?.sql ?? "";
    expect(body).toMatch(/WHERE o\.status = 5/);
    expect(body).not.toContain("'PUBLISHED'");
  }, 120_000);
});

/**
 * TPH (single-table discriminator) + int-backed enums — Task 9.
 *
 * Two distinct questions, and the second is the one the plan flagged as possibly
 * needing its own design:
 *   1. a per-subtype read schema must tolerate an int-backed enum COLUMN;
 *   2. an int-backed enum used AS the DISCRIMINATOR must still pin, filter and insert.
 *
 * Reading the generated source says both work: every TPH path goes through Drizzle
 * (`db.select()`, `eq(auths.type, "Bridge")`, `.values()`), so the Task 5 customType
 * encodes and decodes at the column, and the schemas only ever see member symbols.
 * But #203/#229 is the precedent for TPH being a separate code path that everyone
 * assumes is covered — and this repo's 0.15.21 line is what "the source looks right"
 * is worth. So: run it.
 *
 * If this had needed its own design, the documented fallback was to REJECT
 * @intValueMap on a discriminator with a named loader error. It does not — the
 * discriminator case is SUPPORTED, and these tests are what pins that.
 */
describe("int-backed field.enum under TPH — real Postgres", () => {
  // The discriminator (`type`) is int-backed 1/2, and there is ALSO a non-
  // discriminator int-backed enum (`status`, 0/7) so both questions are live in one
  // model. Both maps are non-ordinal so an accidental index-of-@values correspondence
  // shows up as a wrong number rather than passing by coincidence.
  const TPH_META = `{
    "metadata.root": { "package": "demo", "children": [
      { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
        { "source.rdb": { "@table": "auths" } },
        { "field.enum": { "name": "type", "@values": ["Bridge", "Copay"],
          "@intValueMap": { "Bridge": 1, "Copay": 2 } } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "title" } },
        { "field.enum": { "name": "status", "@values": ["OPEN", "SHUT"],
          "@intValueMap": { "OPEN": 0, "SHUT": 7 } } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
      ] } },
      { "object.entity": { "name": "BridgeAuth", "extends": "demo::Auth",
        "@discriminatorValue": "Bridge", "children": [
        { "field.int": { "name": "quantity" } } ] } },
      { "object.entity": { "name": "CopayAuth", "extends": "demo::Auth",
        "@discriminatorValue": "Copay", "children": [
        { "field.int": { "name": "amount" } } ] } }
    ] } }`;

  let tphTmp: string;
  let q: any;          // the generated Auth.queries module
  let tphDb: any;      // Drizzle handle against the same database
  let tphPool: pg.Pool;

  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const genTmpRoot = join(here, "..", ".gen-tmp");
    mkdirSync(genTmpRoot, { recursive: true });
    tphTmp = mkdtempSync(join(genTmpRoot, "enum-tph-"));

    const root = (await new MetaDataLoader().load([new InMemoryStringSource(TPH_META)])).root;
    const lr = await runGen({
      config: defineConfig({
        outDir: tphTmp, extStyle: "none", dbImport: "./db", dialect: "postgres",
        generators: [entityFile(), queriesFile()],
      }),
      metadata: root,
    });
    if (lr.warnings.length > 0) throw new Error(`codegen warnings: ${lr.warnings.join("; ")}`);

    // The queries module takes its Db as a PARAMETER, so it needs no db module —
    // it is imported exactly as emitted.
    q = await import(pathToFileURL(join(tphTmp, "Auth.queries.ts")).href);
    tphPool = new pg.Pool({ connectionString: pg2Uri });
    tphDb = drizzle(tphPool);
  }, 180_000);

  afterAll(async () => {
    await tphPool?.end();
    rmSync(tphTmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await migrate(TPH_META);
  });

  test("the TPH base table DDL applies and a second migrate converges", async () => {
    const expected = await expectedFor(TPH_META);
    await assertConverged(expected);
  }, 120_000);

  test("the discriminator column is integer with an INTEGER check", async () => {
    const col = await sql<{ data_type: string }>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'auths' AND column_name = 'type'
    `.execute(k);
    expect(col.rows[0]?.data_type).toBe("integer");

    const chk = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'auths_type_chk'
    `.execute(k);
    // Unquoted integers, not 'Bridge'/'Copay' — the discriminator's CHECK is
    // subject to the same int-backing as any other enum column.
    expect(chk.rows[0]?.def).toContain("1");
    expect(chk.rows[0]?.def).toContain("2");
    expect(chk.rows[0]?.def).not.toContain("Bridge");
  }, 120_000);

  test("create through the generated per-subtype fn stores BOTH enums as integers", async () => {
    // `type` is required by BridgeAuthInsertSchema (z.literal("Bridge")) — that is
    // pre-existing TPH behaviour, identical for a string-backed discriminator; the
    // ROUTES layer is what omits it and re-adds it from the URL.
    await q.createBridgeAuth(tphDb, {
      type: "Bridge", title: "a", status: "SHUT", quantity: 3,
    });
    // Raw SQL, bypassing the codec — this is what is actually on disk.
    const raw = await sql<{ type: number; status: number }>`
      SELECT "type", "status" FROM "auths" WHERE "title" = 'a'
    `.execute(k);
    expect(raw.rows[0]?.type).toBe(1);      // Bridge, not 'Bridge'
    expect(raw.rows[0]?.status).toBe(7);    // SHUT
  }, 120_000);

  test("the per-subtype read schema decodes an int-backed enum column", async () => {
    // Insert with raw SQL so neither value passes through toDriver — proving the
    // read path decodes rather than the two directions cancelling out.
    await sql.raw(
      `INSERT INTO "auths" ("type", "title", "status", "quantity") VALUES (1, 'b', 0, 9);`,
    ).execute(k);
    const rows = await q.listBridgeAuths(tphDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("Bridge");   // z.literal("Bridge") accepted the decoded value
    expect(rows[0].status).toBe("OPEN");   // the ZERO-valued member
    expect(rows[0].quantity).toBe(9);
  }, 120_000);

  test("the per-subtype filter compares the INTEGER discriminator", async () => {
    await sql.raw(
      `INSERT INTO "auths" ("type", "title", "status") VALUES (1, 'b', 0), (2, 'c', 7), (1, 'd', 7);`,
    ).execute(k);
    const bridges = await q.listBridgeAuths(tphDb);
    expect(bridges.map((r: any) => r.title).sort()).toEqual(["b", "d"]);
    const copays = await q.listCopayAuths(tphDb);
    expect(copays.map((r: any) => r.title)).toEqual(["c"]);
  }, 120_000);

  test("the polymorphic read dispatches on the DECODED discriminator", async () => {
    await sql.raw(
      `INSERT INTO "auths" ("type", "title", "status", "amount") VALUES (2, 'c', 7, 42);`,
    ).execute(k);
    const all = await q.listAuths(tphDb);
    expect(all).toHaveLength(1);
    // parseAuth read `type` as "Copay" and dispatched to CopayAuthSchema — a raw 2
    // would have thrown on the z.enum head parse.
    expect(all[0].type).toBe("Copay");
    expect(all[0].amount).toBe(42);
  }, 120_000);

  test("find-by-id is scoped by the integer discriminator, not just the PK", async () => {
    await sql.raw(
      `INSERT INTO "auths" ("type", "title", "status") VALUES (2, 'c', 7);`,
    ).execute(k);
    const [{ id }] = (await sql<{ id: string }>`SELECT "id" FROM "auths"`.execute(k)).rows as any;
    // The row IS a Copay, so asking for it as a Bridge must miss — proving the AND'd
    // discriminator predicate encoded to 1 rather than binding 'Bridge'.
    expect(await q.findBridgeAuthById(tphDb, Number(id))).toBeNull();
    expect((await q.findCopayAuthById(tphDb, Number(id)))?.title).toBe("c");
  }, 120_000);
});
