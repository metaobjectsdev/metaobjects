/**
 * View migration lifecycle — the REAL gate, against a live Postgres.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * Postgres does not store view SQL. It stores the parse tree, and `pg_get_viewdef()`
 * deparses it back in Postgres's own style — so the text we emit can never be read
 * back. The diff used to compare those two texts, which meant every managed view
 * reported as "changed" on EVERY migrate, forever, on a schema with zero metadata
 * changes. `meta migrate` never converged and `verify --db` was permanently red for any
 * project with a projection.
 *
 * Nothing caught it because nothing in the repo ever ran the migrate pipeline TWICE
 * against a real database with a view in it. Every view test either hand-built both
 * sides of the comparison (so they matched by construction — a state that cannot occur
 * against real PG) or applied once and then queried rows. `emit` and `introspect` had
 * never been in the same room.
 *
 * So: every test below applies to a REAL engine and then RE-DIFFS. A gate that cannot
 * see the round trip cannot see this class of bug.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchema, diff, emit, introspectPostgres,
  type AllowOptions, type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

/**
 * A Program table plus a ProgramSummary projection over it (one passthrough + one
 * aggregate). `extraFields` lets a test append or insert projection fields to exercise
 * the replace-vs-drop decision.
 */
function meta(opts: { summaryFields: string[] }): string {
  return `{
    "metadata.root": {
      "package": "acme",
      "children": [
        { "object.entity": { "name": "Program", "children": [
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "title",  "@required": true } },
          { "field.string": { "name": "status", "@required": true } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
          { "relationship.aggregation": { "name": "weeks", "@cardinality": "many", "@objectRef": "Week" } }
        ] } },
        { "object.entity": { "name": "Week", "children": [
          { "field.long": { "name": "id" } },
          { "field.long": { "name": "programId", "@required": true } },
          { "identity.primary":   { "name": "id", "@fields": "id", "@generation": "increment" } },
          { "identity.reference": { "name": "ref_program", "@fields": "programId", "@references": "Program" } }
        ] } },
        { "object.projection": { "name": "ProgramSummary", "children": [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "identity.primary": { "name": "id", "extends": "Program.id", "@fields": "id" } },
          { "field.long": { "name": "id", "extends": "Program.id", "children": [
            { "origin.passthrough": { "@from": "Program.id" } } ] } },
          ${opts.summaryFields.join(",\n          ")}
        ] } }
      ]
    }
  }`;
}

const PASSTHROUGH_TITLE = `{ "field.string": { "name": "title", "children": [
            { "origin.passthrough": { "@from": "Program.title" } } ] } }`;
const PASSTHROUGH_STATUS = `{ "field.string": { "name": "status", "children": [
            { "origin.passthrough": { "@from": "Program.status" } } ] } }`;
const AGG_WEEK_COUNT = `{ "field.long": { "name": "weekCount", "children": [
            { "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } } ] } }`;

// #208 — an @sql projection view: a hand-written body the tool REGISTERS + fingerprints
// + drift-checks but never parses. The body is verbatim SQL over `programs`; the fields
// are pure extends-bound shape (no origin.* — that would be two sources of truth). This
// rides the exact fingerprint/adopt-view pipeline the synthesized body already uses.
const SQL_VIEW_BODY = `SELECT id AS id, title AS title FROM programs WHERE status = 'active'`;
function metaSql(): string {
  return `{
    "metadata.root": {
      "package": "acme",
      "children": [
        { "object.entity": { "name": "Program", "children": [
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "title",  "@required": true } },
          { "field.string": { "name": "status", "@required": true } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.projection": { "name": "ActivePrograms", "children": [
          { "source.rdb": { "@kind": "view", "@view": "v_active_programs", "@sql": ${JSON.stringify(SQL_VIEW_BODY)} } },
          { "identity.primary": { "name": "id", "extends": "Program.id", "@fields": "id" } },
          { "field.long":   { "name": "id",    "extends": "Program.id" } },
          { "field.string": { "name": "title", "extends": "Program.title" } }
        ] } }
      ]
    }
  }`;
}

let pg: RunningPg;
let k: Kysely<Record<string, unknown>>;

// One container for the file; each test gets a pristine `public` schema. Spinning a
// container per test costs ~5s each and blows the hook timeout.
beforeAll(async () => {
  pg = await startPostgres();
  k = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: pg.connectionUri }) }),
  });
}, 120_000);

afterAll(async () => {
  await k.destroy();
  await pg.stop();
}, 60_000);

beforeEach(async () => {
  await sql.raw("DROP SCHEMA IF EXISTS reporting CASCADE").execute(k);
  await sql.raw("DROP SCHEMA public CASCADE").execute(k);
  await sql.raw("CREATE SCHEMA public").execute(k);
  await sql.raw("CREATE SCHEMA reporting").execute(k);
});

/**
 * A downstream application's own view, built on ours and living in ITS OWN schema.
 *
 * The separate schema is the realistic shape AND the sharp edge: the diff scopes itself
 * to the schemas the model declares, so `reporting` is invisible to it — but a
 * `DROP ... CASCADE` does not care about our scoping and would destroy this anyway.
 */
async function createDownstreamDependent(): Promise<void> {
  await sql.raw(
    `CREATE VIEW reporting."downstream_report" AS SELECT "title" FROM public."v_program_summary"`,
  ).execute(k);
}

async function applyRaw(text: string): Promise<void> {
  // Statement-split must not shred the CASCADE warning banner or a view body — split on
  // ";\n" boundaries the emitter actually produces, then drop empties.
  for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }
}

async function expectedFor(metaJson: string): Promise<SchemaSnapshot> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
  return buildExpectedSchema(root, {
    columnNamingStrategy: "literal",
    views: buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "literal" }),
  });
}

/** The full production pipeline: build → introspect → diff → emit → apply. */
async function migrate(metaJson: string, allow: AllowOptions = {}) {
  const expected = await expectedFor(metaJson);
  const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres", allow });
  const emittable = result.changes.filter((c) => c.status.state !== "blocked");
  const { up, down } = emittable.length === 0
    ? { up: "", down: "" }
    : emit(emittable, { dialect: "postgres" });
  if (result.blocked.length === 0 && up.trim().length > 0) await applyRaw(up);
  return { expected, result, up, down };
}

/** THE gate: a second `meta migrate` against the just-migrated DB must be a no-op. */
async function assertConverged(expected: SchemaSnapshot, allow: AllowOptions = {}): Promise<void> {
  const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres", allow });
  if (followup.changes.length > 0) {
    console.error("NOT CONVERGED — a second `meta migrate` would emit:");
    for (const c of followup.changes) console.error("  -", c.kind, JSON.stringify(c).slice(0, 200));
  }
  expect(followup.changes).toEqual([]);
}

async function viewCols(name: string): Promise<string[]> {
  const r = await sql.raw(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = '${name}' ORDER BY ordinal_position`,
  ).execute(k);
  return (r.rows as { column_name: string }[]).map((x) => x.column_name);
}

/** `name` may be bare (assumed public) or schema-qualified. */
async function relationExists(name: string): Promise<boolean> {
  const qualified = name.includes(".") ? name : `public.${name}`;
  const r = await sql.raw(`SELECT to_regclass('${qualified}') IS NOT NULL AS ok`).execute(k);
  return (r.rows[0] as { ok: boolean }).ok;
}

async function viewComment(name: string): Promise<string | null> {
  const r = await sql.raw(
    `SELECT obj_description('public.${name}'::regclass, 'pg_class') AS c`,
  ).execute(k);
  return (r.rows[0] as { c: string | null }).c;
}

describe("view lifecycle — real Postgres", () => {
  // -------------------------------------------------------------------------
  // The bug itself.
  // -------------------------------------------------------------------------

  test("CONVERGENCE: a projection view migrates once, then a second migrate is a NO-OP", async () => {
    const m = meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] });
    const { expected, up } = await migrate(m);

    // The view is stamped with a fingerprint of the body we generated. Without the
    // stamp there is nothing to compare against, because Postgres will hand back a
    // DEPARSED body that never equals what we wrote.
    expect(up).toContain(`CREATE VIEW "v_program_summary" AS`);
    expect(up).toMatch(/COMMENT ON VIEW "v_program_summary" IS 'metaobjects:v1:sha256:[0-9a-f]{64}'/);
    expect(await viewComment("v_program_summary")).toMatch(/^metaobjects:v1:sha256:[0-9a-f]{64}$/);

    // THE regression gate. Before the fix this re-diff emitted `replace-view` — on
    // every run, forever, with zero metadata changes.
    await assertConverged(expected);
  });

  test("CONVERGENCE holds across a THIRD migrate (the pipeline is genuinely idempotent)", async () => {
    const m = meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] });
    await migrate(m);
    const second = await migrate(m);
    expect(second.up.trim()).toBe("");
    await assertConverged(second.expected);
  });

  // #213 — a write-through ENTITY (FR-024 §7 read-view): the writable table carries
  // NO derived column, its replica view IS emitted, and the whole thing converges on
  // a real engine (emit → apply → introspect → re-diff EMPTY). This gates BOTH holes
  // end-to-end: hole 1 (derived-field leak into the table) and hole 2 (view never
  // emitted). literal naming strategy → column names are the field names verbatim.
  test("CONVERGENCE: a write-through entity's table (no derived col) + replica view migrate once, then NO-OP (#213)", async () => {
    const m = JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { "@role": "primary", "@table": "orders" } },
        { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "customerId", "@required": true } },
        { "field.string": { name: "customerName", children: [
          { "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } } ] } },
        { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
      ] } },
    ]}});
    const { expected, up } = await migrate(m);

    // The writable table is created WITHOUT the derived column; the replica view is created.
    expect(up).toContain(`CREATE TABLE "orders"`);
    expect(up).toContain(`CREATE VIEW "v_order_with_customer" AS`);
    // The orders TABLE carries only the stored fields — never the derived customerName.
    expect(await viewCols("orders")).toEqual(["id", "customerId"]);
    // The VIEW exposes o.* (stored) + the derived join column.
    expect(await viewCols("v_order_with_customer")).toEqual(["id", "customerId", "customerName"]);

    // THE gate: a second migrate against the just-migrated DB is a no-op.
    await assertConverged(expected);
  });

  // #214 — the READ half runtime data contract. The generated read-half code writes the
  // TABLE (no derived col) then re-reads the row THROUGH the replica view by PK (create's
  // re-read, findById, list all SELECT from the view). This exercises exactly that query
  // shape against real PG — insert stored columns into the table, re-read from the view by
  // the inserted PK — and asserts the derived customerName is populated from the join. (The
  // generated code that emits this shape is separately gated to type-check by
  // issue-214-read-half-compile.test.ts on both dialects.)
  test("READ HALF: a row written to the table re-reads through the view by PK WITH the derived field (#214)", async () => {
    const m = JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { "@role": "primary", "@table": "orders" } },
        { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "customerId", "@required": true } },
        { "field.string": { name: "customerName", children: [
          { "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } } ] } },
        { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
      ] } },
    ]}});
    await migrate(m);

    // Write ONLY the stored columns to the base table (the derived customerName is
    // never written — it does not exist on the table, per #213). Capture the inserted PK,
    // exactly as the generated create does via `.returning()`.
    await sql.raw(`INSERT INTO "customers" ("name") VALUES ('Acme Corp')`).execute(k);
    const ins = await sql.raw(
      `INSERT INTO "orders" ("customerId") VALUES ((SELECT "id" FROM "customers" WHERE "name" = 'Acme Corp')) RETURNING "id"`,
    ).execute(k);
    const newId = (ins.rows[0] as { id: number }).id;

    // The generated create/findById RE-READ shape: SELECT from the VIEW WHERE pk = <inserted>.
    // The derived customerName is populated from the join — read-your-writes returns it.
    const reread = await sql.raw(
      `SELECT "id", "customerId", "customerName" FROM "v_order_with_customer" WHERE "id" = ${newId} LIMIT 1`,
    ).execute(k);
    expect(reread.rows.length).toBe(1);
    expect((reread.rows[0] as { customerName: string }).customerName).toBe("Acme Corp");
  });

  // #207 — a projection row-scope @filter lowers to an outer WHERE. The view must
  // round-trip on a real engine (emit → apply → introspect → re-diff EMPTY, exactly
  // like the convergence gate above — Postgres deparses the WHERE, so a text compare
  // would never converge), AND it must actually FILTER: rows failing the predicate
  // are absent from the view. literal naming → column names are the field names.
  test("CONVERGENCE + SUBSET: a projection @filter lowers to a WHERE, converges, and the view returns only matching rows (#207)", async () => {
    const m = JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "title", "@required": true } },
        { "field.string": { name: "status", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.projection": { name: "ActivePrograms", "@filter": { status: { eq: "active" } }, children: [
        { "source.rdb": { "@kind": "view", "@table": "v_active_programs" } },
        { "identity.primary": { name: "id", extends: "Program.id", "@fields": "id" } },
        { "field.long": { name: "id", extends: "Program.id", children: [
          { "origin.passthrough": { "@from": "Program.id" } } ] } },
        { "field.string": { name: "title", children: [
          { "origin.passthrough": { "@from": "Program.title" } } ] } },
        { "field.string": { name: "status", children: [
          { "origin.passthrough": { "@from": "Program.status" } } ] } },
      ] } },
    ]}});
    const { expected, up } = await migrate(m);

    // The view carries the row-scope WHERE (literal strategy → bare column, base alias p).
    expect(up).toContain(`CREATE VIEW "v_active_programs" AS`);
    expect(up).toMatch(/WHERE p\.status = 'active'/);

    // THE gate: the filtered view round-trips (a deparsed WHERE would never text-match).
    await assertConverged(expected);

    // And it actually FILTERS: two matching rows + one non-matching; the view omits the latter.
    await sql.raw(
      `INSERT INTO "programs" ("title","status") VALUES ('Keep','active'),('Drop','archived'),('Keep2','active')`,
    ).execute(k);
    const rows = await sql.raw(`SELECT "title" FROM "v_active_programs" ORDER BY "title"`).execute(k);
    expect((rows.rows as { title: string }[]).map((r) => r.title)).toEqual(["Keep", "Keep2"]);
  });

  // -------------------------------------------------------------------------
  // Non-destructive replace — the part that protects downstream applications.
  // -------------------------------------------------------------------------

  test("APPEND a projection field → CREATE OR REPLACE, and a downstream dependent SURVIVES", async () => {
    await migrate(meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] }));

    await createDownstreamDependent();

    // Append a field — declared LAST, which is what makes it non-destructive: Postgres
    // permits CREATE OR REPLACE VIEW only when the existing columns are a PREFIX of the
    // new ones, and projection columns come out in declaration order.
    const m2 = meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT, PASSTHROUGH_STATUS] });
    const { expected, result, up } = await migrate(m2);

    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain("replace-view");
    expect(kinds).not.toContain("drop-view");     // ← the whole point
    expect(up).toContain("CREATE OR REPLACE VIEW");

    expect(await viewCols("v_program_summary")).toEqual(["id", "title", "weekCount", "status"]);
    // The downstream app's view is untouched and still queryable.
    expect(await relationExists("reporting.downstream_report")).toBe(true);
    await sql.raw(`SELECT * FROM reporting."downstream_report"`).execute(k);

    await assertConverged(expected);
  });

  test("REORDER (insert a field mid-list) → Postgres forbids OR REPLACE, so drop+create", async () => {
    await migrate(meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] }));

    // status inserted in the MIDDLE — the existing columns are no longer a prefix of the
    // new ones, so an OR REPLACE would be rejected by Postgres at APPLY time. The diff
    // must decide that at PLAN time and route through drop+create instead.
    const m2 = meta({ summaryFields: [PASSTHROUGH_TITLE, PASSTHROUGH_STATUS, AGG_WEEK_COUNT] });
    const { expected, result } = await migrate(m2, { dropView: true });

    const kinds = result.changes.map((c) => c.kind);
    expect(kinds).toContain("drop-view");
    expect(kinds).toContain("create-view");
    expect(kinds).not.toContain("replace-view");

    expect(await viewCols("v_program_summary")).toEqual(["id", "title", "status", "weekCount"]);
    await assertConverged(expected);
  });

  // -------------------------------------------------------------------------
  // Loud cascades.
  // -------------------------------------------------------------------------

  test("a drop that would CASCADE into an unmanaged dependent is BLOCKED, and names it", async () => {
    await migrate(meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] }));
    await createDownstreamDependent();

    // A reorder forces drop+create. Our view comes back — but the DROP cascades through
    // to the downstream app's view, which does NOT. That must not be silent.
    const m2 = meta({ summaryFields: [PASSTHROUGH_TITLE, PASSTHROUGH_STATUS, AGG_WEEK_COUNT] });
    const expected = await expectedFor(m2);
    const result = await diff({
      expected, actual: await introspectPostgres(k), dialect: "postgres",
      allow: { dropView: true },   // even WITH drop-view, the cascade is still gated
    });

    const blocked = result.blocked.find((c) => c.kind === "drop-view");
    expect(blocked).toBeDefined();
    expect(blocked!.status.blockedReason).toContain("CASCADE");
    expect(blocked!.status.blockedReason).toContain("downstream_report");

    // And the dependent is still standing, because nothing was applied.
    expect(await relationExists("reporting.downstream_report")).toBe(true);
  });

  test("with allow.dropViewCascade the drop proceeds, the SQL carries a warning banner, and the dependent is destroyed", async () => {
    await migrate(meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] }));
    await createDownstreamDependent();

    const m2 = meta({ summaryFields: [PASSTHROUGH_TITLE, PASSTHROUGH_STATUS, AGG_WEEK_COUNT] });
    const { expected, up } = await migrate(m2, { dropView: true, dropViewCascade: true });

    // The banner lives in the committed migration file, where a reviewer sees it.
    expect(up).toContain("WARNING: CASCADE DROP");
    expect(up).toContain("reporting.downstream_report (view)");
    expect(up).toContain(`DROP VIEW "v_program_summary" CASCADE;`);

    // Ours came back; theirs did not — which is exactly what the operator opted into.
    expect(await relationExists("v_program_summary")).toBe(true);
    expect(await relationExists("reporting.downstream_report")).toBe(false);

    await assertConverged(expected, { dropView: true, dropViewCascade: true });
  });

  // -------------------------------------------------------------------------
  // The adopt gate — fail closed on a view we cannot prove is ours.
  // -------------------------------------------------------------------------

  test("an UNSTAMPED view at a projection's name is BLOCKED (hand-written, or pre-fingerprint)", async () => {
    // Exactly what the world looks like after upgrading from a toolchain that did not
    // stamp — and also what a hand-written view looks like. Postgres deparses the body,
    // so the two are INDISTINGUISHABLE. Fail closed.
    const m = meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] });
    await migrate(m);
    await sql.raw(`COMMENT ON VIEW "v_program_summary" IS NULL`).execute(k);

    const expected = await expectedFor(m);
    const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    const blocked = result.blocked.find((c) => c.kind === "replace-view");
    expect(blocked).toBeDefined();
    expect(blocked!.status.blockedReason).toContain("no MetaObjects fingerprint");
    expect(blocked!.status.blockedReason).toContain("allow.adoptView");
  });

  test("with allow.adoptView the unstamped view is adopted, stamped, and then CONVERGES", async () => {
    const m = meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] });
    await migrate(m);
    await sql.raw(`COMMENT ON VIEW "v_program_summary" IS NULL`).execute(k);

    const { expected } = await migrate(m, { adoptView: true });
    expect(await viewComment("v_program_summary")).toMatch(/^metaobjects:v1:sha256:[0-9a-f]{64}$/);

    // The one-time upgrade cost: loud once, then silent forever.
    await assertConverged(expected);
  });

  // -------------------------------------------------------------------------
  // Restorable down migrations — a free win from the deparser that caused the bug.
  // -------------------------------------------------------------------------

  test("the DOWN migration restores the previous view body", async () => {
    await migrate(meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT] }));
    expect(await viewCols("v_program_summary")).toEqual(["id", "title", "weekCount"]);

    const m2 = meta({ summaryFields: [PASSTHROUGH_TITLE, AGG_WEEK_COUNT, PASSTHROUGH_STATUS] });
    const { down } = await migrate(m2);
    expect(await viewCols("v_program_summary")).toEqual(["id", "title", "weekCount", "status"]);

    // pg_get_viewdef is useless for COMPARISON but is perfectly good SQL — so the very
    // deparser that caused the bug is what makes the down migration restorable.
    expect(down).not.toContain("cannot restore the original view definition");
    await applyRaw(down);
    expect(await viewCols("v_program_summary")).toEqual(["id", "title", "weekCount"]);
  });

  // -------------------------------------------------------------------------
  // #208 — @sql DDL-ownership escape valve: a hand-written body, tool-managed lifecycle.
  // -------------------------------------------------------------------------

  test("#208 @sql: a hand-written body emits VERBATIM + a fingerprint stamp, then a second migrate is a NO-OP", async () => {
    const { expected, up } = await migrate(metaSql());

    // The body is the author's verbatim SQL, wrapped in CREATE VIEW — NOT a synthesized
    // base-table passthrough SELECT — and stamped so drift-check has something to compare.
    expect(up).toContain(`CREATE VIEW "v_active_programs" AS`);
    expect(up).toContain(SQL_VIEW_BODY);
    expect(up).toMatch(/COMMENT ON VIEW "v_active_programs" IS 'metaobjects:v1:sha256:[0-9a-f]{64}'/);
    expect(await viewComment("v_active_programs")).toMatch(/^metaobjects:v1:sha256:[0-9a-f]{64}$/);

    // The hand body actually runs: a seeded active/inactive pair filters to the active one.
    await sql.raw(`INSERT INTO "programs" ("id","title","status") VALUES (1,'Live','active'),(2,'Old','archived')`).execute(k);
    const rows = await sql.raw(`SELECT id, title FROM "v_active_programs" ORDER BY id`).execute(k);
    expect(rows.rows).toEqual([{ id: "1", title: "Live" }]);

    // THE gate: opaque body (columns unknown) still converges — the fingerprint matches.
    await assertConverged(expected);
  });

  test("#208 @sql: a pre-existing UNSTAMPED view at the name is BLOCKED pending adopt-view, then adopts + converges", async () => {
    const m = metaSql();
    await migrate(m);
    // Strip the stamp: now indistinguishable from a hand-written view Postgres deparsed.
    await sql.raw(`COMMENT ON VIEW "v_active_programs" IS NULL`).execute(k);

    const expected = await expectedFor(m);
    const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    const blocked = result.blocked.find((c) => c.kind === "replace-view");
    expect(blocked).toBeDefined();
    expect(blocked!.status.blockedReason).toContain("allow.adoptView");

    // The one-time adoption ceremony: `migrate --allow adopt-view` stamps it, then silent.
    const { expected: exp2 } = await migrate(m, { adoptView: true });
    expect(await viewComment("v_active_programs")).toMatch(/^metaobjects:v1:sha256:[0-9a-f]{64}$/);
    await assertConverged(exp2);
  });
});
