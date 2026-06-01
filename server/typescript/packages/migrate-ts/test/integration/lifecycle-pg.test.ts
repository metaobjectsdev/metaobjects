/**
 * End-to-end migration lifecycle against a REAL Postgres, proving the whole
 * reference-snapshot engine works: baseline → generate → apply → evolve → apply →
 * rollback (down) → idempotency → destructive gating.
 *
 * Drives the actual library API (buildExpectedSchema → diff → emit → applyPending →
 * introspectPostgres → rollbackTo) and asserts the INTROSPECTED real-DB state at
 * every step — not mocks. Gates on MIGRATE_TS_PG_URL (like the other pg integration
 * tests) and skips when absent.
 *
 *   Set MIGRATE_TS_PG_URL=postgres://user:pass@host:port/db to run.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import {
  buildExpectedSchema,
  diff,
  emit,
  introspectPostgres,
  type SchemaSnapshot,
  type TableDescriptor,
} from "../../src/index.js";
import { applyPending, rollbackTo } from "../../src/apply/apply.js";
import { normalizeCheckExpr } from "../../src/check-expr-compare.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const d = PG_URL ? describe : describe.skip;

// ---- metadata: v1 (greenfield) and v2 (evolved) ----------------------------

const V1 = JSON.stringify({
  "metadata.root": { children: [
    { "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"] } },
      { "field.int": { name: "qty", children: [{ "validator.numeric": { name: "r", "@min": 1 } }] } },
      { "field.string": { name: "email" } },
      { "source.rdb": { name: "src", "@table": "lc_orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      { "identity.secondary": { name: "lc_orders_email_uq", "@fields": ["email"] } },
    ] } },
  ] },
});

// v2: + Customer table; Order + note column + customerId FK→Customer;
// status enum gains CANCELLED (enum CHECK evolves); qty validator gains @max (numeric CHECK evolves).
const V2 = JSON.stringify({
  "metadata.root": { children: [
    { "object.entity": { name: "Customer", children: [
      { "field.long": { name: "id" } },
      { "field.string": { name: "name", "@required": true } },
      { "source.rdb": { name: "src", "@table": "lc_customers" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] } },
    { "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED", "CANCELLED"] } },
      { "field.int": { name: "qty", children: [{ "validator.numeric": { name: "r", "@min": 1, "@max": 1000 } }] } },
      { "field.string": { name: "email" } },
      { "field.string": { name: "note" } },
      { "field.long": { name: "customerId" } },
      { "source.rdb": { name: "src", "@table": "lc_orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      { "identity.secondary": { name: "lc_orders_email_uq", "@fields": ["email"] } },
      { "identity.reference": { name: "lc_orders_customer_fk", "@fields": ["customerId"], "@references": "Customer" } },
    ] } },
  ] },
});

async function loadRoot(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

// ---- test harness ----------------------------------------------------------

let db: Kysely<Record<string, unknown>>;
let pool: Pool;
let migRoot: string;

function pgDialect() { return { dialect: "postgres" as const }; }

/** Generate a named migration dir from a change set + write up/down.sql. */
function writeMig(name: string, expected: SchemaSnapshot, up: string, down: string): void {
  const dir = join(migRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "up.sql"), up.endsWith("\n") ? up : up + "\n", "utf8");
  writeFileSync(join(dir, "down.sql"), down.endsWith("\n") ? down : down + "\n", "utf8");
}

/** Introspect lc_* tables only, sorted, so assertions ignore unrelated schema. */
async function introspectLc(): Promise<TableDescriptor[]> {
  const snap = await introspectPostgres(db);
  return snap.tables
    .filter((t) => t.name.startsWith("lc_"))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function tableNames(tables: TableDescriptor[]): string[] {
  return tables.map((t) => t.name);
}
function colNames(t: TableDescriptor): string[] {
  return t.columns.map((c) => c.name).sort();
}
// Use the LIBRARY normalizer so the test reflects the same canonicalization the
// diff uses — PG returns `status = ANY (ARRAY[...])` for an `IN` list, which
// normalizeCheckExpr folds back to `... in ...`.
function checkExprs(t: TableDescriptor): string[] {
  return t.checks.map((c) => normalizeCheckExpr(c.expression)).sort();
}

d("migrate-ts lifecycle against real Postgres", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    migRoot = mkdtempSync(join(tmpdir(), "lc-mig-"));
    // clean slate
    await sql`DROP TABLE IF EXISTS lc_orders CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS lc_customers CASCADE`.execute(db);
    await sql`DROP TABLE IF EXISTS _metaobjects_migrations CASCADE`.execute(db);
  });

  afterAll(async () => {
    try {
      await sql`DROP TABLE IF EXISTS lc_orders CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS lc_customers CASCADE`.execute(db);
      await sql`DROP TABLE IF EXISTS _metaobjects_migrations CASCADE`.execute(db);
    } finally {
      await db.destroy();
      rmSync(migRoot, { recursive: true, force: true });
    }
  });

  test("full lifecycle: create → apply → evolve → apply → rollback → idempotent → gated", async () => {
    // ---- v1: greenfield create ----------------------------------------------
    const root1 = await loadRoot(V1);
    const snap1 = buildExpectedSchema(root1, pgDialect());
    const EMPTY: SchemaSnapshot = { tables: [], views: [] };
    const diff1 = await diff({ expected: snap1, actual: EMPTY, ...pgDialect() });
    expect(diff1.blocked).toHaveLength(0);
    const emit1 = emit(diff1.changes, { dialect: "postgres", expectedSchema: snap1 });
    writeMig("20260101000000-init", snap1, emit1.up, emit1.down);

    const applied1 = await applyPending(db, migRoot, { dialect: "postgres", dryRun: false });
    expect(applied1.applied).toEqual(["20260101000000-init"]);

    // assert real DB == v1
    let live = await introspectLc();
    expect(tableNames(live)).toEqual(["lc_orders"]);
    const orders1 = live[0]!;
    expect(colNames(orders1)).toEqual(["email", "id", "qty", "status"]);
    expect(orders1.primaryKey).toEqual(["id"]);
    expect(orders1.indexes.some((i) => i.unique && i.columns.includes("email"))).toBe(true);
    // enum + numeric checks present
    expect(checkExprs(orders1)).toEqual(
      ["qty >= 1", "status in 'open', 'closed'"].sort(),
    );

    // ---- v2: evolve ---------------------------------------------------------
    const root2 = await loadRoot(V2);
    const snap2 = buildExpectedSchema(root2, pgDialect());
    // diff against the v1 SNAPSHOT (offline path), allowing the constraint swaps the
    // enum/numeric CHECK changes produce.
    const diff2 = await diff({ expected: snap2, actual: snap1, ...pgDialect(), allow: { dropCheck: true } });
    expect(diff2.blocked).toHaveLength(0);
    const kinds2 = diff2.changes.map((c) => c.kind).sort();
    expect(kinds2).toContain("create-table");   // lc_customers
    expect(kinds2).toContain("add-column");      // note / customerId
    expect(kinds2).toContain("add-fk");          // orders→customers
    expect(kinds2).toContain("add-check");       // evolved enum + numeric
    expect(kinds2).toContain("drop-check");      // old enum + numeric
    const emit2 = emit(diff2.changes, { dialect: "postgres", expectedSchema: snap2 });
    writeMig("20260102000000-evolve", snap2, emit2.up, emit2.down);

    const applied2 = await applyPending(db, migRoot, { dialect: "postgres", dryRun: false });
    expect(applied2.applied).toEqual(["20260102000000-evolve"]);

    // assert real DB == v2
    live = await introspectLc();
    expect(tableNames(live)).toEqual(["lc_customers", "lc_orders"]);
    const orders2 = live.find((t) => t.name === "lc_orders")!;
    expect(colNames(orders2)).toEqual(["customer_id", "email", "id", "note", "qty", "status"]);
    expect(orders2.foreignKeys.some((f) => f.refTable === "lc_customers")).toBe(true);
    // evolved checks
    const c2 = checkExprs(orders2);
    expect(c2).toContain("status in 'open', 'closed', 'cancelled'");
    expect(c2).toContain("qty >= 1 and qty <= 1000");

    // ---- rollback v2 → v1 (down) --------------------------------------------
    const rb = await rollbackTo(db, migRoot, "20260101000000-init", { dialect: "postgres" });
    expect(rb.rolledBack).toEqual(["20260102000000-evolve"]);

    // assert real DB == v1 again (down restored structure + original checks)
    live = await introspectLc();
    expect(tableNames(live)).toEqual(["lc_orders"]);          // lc_customers dropped
    const ordersBack = live[0]!;
    expect(colNames(ordersBack)).toEqual(["email", "id", "qty", "status"]); // note/customerId dropped
    expect(ordersBack.foreignKeys).toHaveLength(0);            // fk dropped
    expect(checkExprs(ordersBack)).toEqual(
      ["qty >= 1", "status in 'open', 'closed'"].sort(),       // original checks restored
    );

    // ---- idempotency: re-diff v1 against the live (rolled-back) DB ----------
    const liveSnap = await introspectPostgres(db);
    const liveOrdersOnly: SchemaSnapshot = {
      tables: liveSnap.tables.filter((t) => t.name === "lc_orders"),
      views: [],
    };
    const reDiff = await diff({ expected: snap1, actual: liveOrdersOnly, ...pgDialect() });
    // no structural drift between metadata-v1 and the rolled-back real DB
    expect(reDiff.changes.map((c) => c.kind)).toEqual([]);

    // ---- destructive gating: dropping a column is blocked without allow -----
    const v1MinusEmail = buildExpectedSchema(await loadRoot(JSON.stringify({
      "metadata.root": { children: [
        { "object.entity": { name: "Order", children: [
          { "field.long": { name: "id" } },
          { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"] } },
          { "field.int": { name: "qty", children: [{ "validator.numeric": { name: "r", "@min": 1 } }] } },
          { "source.rdb": { name: "src", "@table": "lc_orders" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ] } },
      ] },
    })), pgDialect());
    const gated = await diff({ expected: v1MinusEmail, actual: liveOrdersOnly, ...pgDialect() });
    const dropCol = gated.changes.find((c) => c.kind === "drop-column");
    expect(dropCol).toBeDefined();
    expect(dropCol!.status.state).toBe("blocked");            // blocked without allow.dropColumn
    const allowed = await diff({ expected: v1MinusEmail, actual: liveOrdersOnly, ...pgDialect(), allow: { dropColumn: true } });
    expect(allowed.changes.find((c) => c.kind === "drop-column")!.status.state).toBe("allowed");
  }, 30000);
});
