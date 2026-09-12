/**
 * FR-023 §11.1 item 2 — the schema-scope half of the import exclusion, against a
 * REAL Postgres, because it is the only place the bug is visible.
 *
 * `scopeExpectedSchema` pins `diff`'s schema scope to the UNSCOPED model on purpose:
 * "a scope narrows objects, never schemas". That is right for `migrate.scope` — the
 * same model declared into that schema — and wrong for an import. The consumer never
 * declared into the publisher's schema, so leaving it pinned makes every table the
 * publisher did NOT export a proposed `DROP TABLE` against the publisher's own data.
 *
 * SQLite cannot see this: it has no schema concept, so every object normalizes to one
 * prefix and the pin is a constant. Postgres can, which is why this lives here.
 *
 * The consumer declares `app.orders` (its own schema) and imports `acme::common::Customer`
 * (`public.customers`). The database also holds `public.invoices` — a publisher table the
 * artifact does not export, and which this consumer has therefore never heard of.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchemaWithProvenance,
  collectUnmanagedNames,
  diff,
  introspectPostgres,
  scopeExpectedSchema,
  scopedDiffInputs,
} from "@metaobjectsdev/migrate-ts";
import type { Change } from "@metaobjectsdev/migrate-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

/** The dependency's published artifact (the committed v1 corpus shape): no root
 *  package, each top-level node carrying its own. */
const ARTIFACT = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Customer",
          package: "acme::common",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email", "@maxLength": 120 } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** The consumer's own model, in its own database schema. */
const APP = JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders", "@schema": "app" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

const ownOnly = (fqn: string): boolean => fqn === "app::Order";
const imported = (fqn: string): boolean => fqn.startsWith("acme::common::");

let runningPg: RunningPg;
let pool: Pool;
let k: Kysely<Record<string, unknown>>;
let root: MetaRoot;

beforeAll(async () => {
  runningPg = await startPostgres();
  pool = new Pool({ connectionString: runningPg.connectionUri });
  k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
  const loaded = await new MetaDataLoader().load([
    new InMemoryStringSource(ARTIFACT),
    new InMemoryStringSource(APP),
  ]);
  expect(loaded.errors).toHaveLength(0);
  root = loaded.root;
}, 180_000);

afterAll(async () => {
  await k?.destroy();
  await runningPg?.stop();
});

beforeEach(async () => {
  await sql.raw(`DROP TABLE IF EXISTS public.customers CASCADE;`).execute(k);
  await sql.raw(`DROP TABLE IF EXISTS public.invoices CASCADE;`).execute(k);
  await sql.raw(`DROP SCHEMA IF EXISTS app CASCADE;`).execute(k);
  // The publisher's database, as the publisher made it: the exported table, and one
  // it never exported.
  await sql.raw(`CREATE TABLE public.customers (id bigint primary key, email varchar(120));`).execute(k);
  await sql.raw(`CREATE TABLE public.invoices (id bigint primary key);`).execute(k);
});

/** Every change the scoped run proposes, with drops ALLOWED so a proposed drop shows
 *  up in `changes` rather than being filed under `blocked` and missed. */
async function plan(inScope: (fqn: string) => boolean, withImportExclusion: boolean): Promise<Change[]> {
  const built = buildExpectedSchemaWithProvenance(root, { dialect: "postgres" });
  const scoped = withImportExclusion
    ? scopeExpectedSchema(built, inScope, { imported })
    : scopeExpectedSchema(built, inScope);
  const actual = await introspectPostgres(k);
  const result = await diff({
    ...scopedDiffInputs(scoped, collectUnmanagedNames(root)),
    actual,
    dialect: "postgres",
    allow: { dropTable: true },
  });
  return result.changes;
}

const touching = (ops: Change[], table: string): Change[] =>
  ops.filter((c) => ("table" in c ? (typeof c.table === "string" ? c.table : c.table.name) === table : false));

describe("an imported table leaves both sides of the schema diff — real Postgres", () => {
  test("the consumer's own table is created, and the publisher's schema is never governed", async () => {
    const ops = await plan(ownOnly, true);

    // The consumer's own table, in its own schema.
    const creates = ops.filter((c) => c.kind === "create-table");
    expect(creates).toHaveLength(1);
    const [create] = creates;
    if (create?.kind !== "create-table") throw new Error("expected a create-table");
    expect(create.table.name).toBe("orders");
    expect(create.table.schema).toBe("app");

    // THE assertion. `public.invoices` is a publisher table this consumer has never
    // heard of. If the import stayed on the expected side long enough to pin `public`
    // as a declared schema, this is a DROP TABLE against the publisher's data.
    expect(touching(ops, "invoices")).toEqual([]);

    // And the imported table itself is untouched in either direction.
    expect(touching(ops, "customers")).toEqual([]);
  }, 180_000);

  test("counter-assert: a consumer that OWNS the package governs that schema, visibly", async () => {
    // `migrate.scope` naming `acme::common` is the opt-in — the consumer took the
    // publisher's package, so `public` is legitimately its schema now, and an
    // undeclared table in it is a drop candidate exactly as it would be in its own.
    const ops = await plan(() => true, true);

    const drops = touching(ops, "invoices");
    expect(drops).toHaveLength(1);
    expect(drops[0]?.kind).toBe("drop-table");

    // The exported table matches the metadata, so it produces nothing either way.
    expect(touching(ops, "customers")).toEqual([]);
  }, 180_000);

  test("the hazard is real: with no import predicate the same run proposes the destructive drop", async () => {
    // Today's behaviour, pinned as the counter-assertion: the consumer governs only
    // its own object, yet `public` is still pinned by the import it never declared —
    // so the publisher's unexported table is proposed for DROP.
    const ops = await plan(ownOnly, false);

    const drops = touching(ops, "invoices");
    expect(drops).toHaveLength(1);
    expect(drops[0]?.kind).toBe("drop-table");
  }, 180_000);
});
