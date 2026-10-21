/**
 * f. Postgres: a report view that `meta migrate` drops and creates again keeps its GRANTs.
 *
 * `DROP VIEW` discards the privileges granted on the view. The emitted migration therefore
 * captures them from `relacl` before the drop and grants them again after the create, to the
 * same grantees and WITH GRANT OPTION where it was held, using nothing a non-superuser lacks.
 * Two roads lead to a drop and create: a view over a column whose type changes (drop-view +
 * create-view, which the planner picks when the live probe shows a replace is illegal or when
 * it plans offline with no probe). A replace the probe proved legal is `CREATE OR REPLACE`, which
 * Postgres itself keeps the grants through; the emitter's unproven replace-view branch is covered
 * in migrate-ts/test/emit-postgres-view-grants.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchema, collectUnmanagedNames, diff, emit, introspectPostgres, postgresViewReplaceProbe,
  splitSqlStatements, viewFingerprint, type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

const VIEW = "v_program_minutes";
let pg: RunningPg;
let k: Kysely<Record<string, unknown>>;
let canonical: MetaRoot;

beforeAll(async () => {
  pg = await startPostgres();
  k = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: pg.connectionUri, max: 1 }) }),
  });
  canonical = await loadMetadataDir(CANONICAL_DIR);
  // The project setting `"naming": { "columns": "literal" }` (ADR-0058), set where the project-aware load sets it.
  (canonical as unknown as { physicalNaming: unknown }).physicalNaming = { columns: "literal", tables: "snake_case" };
}, 120_000);

afterAll(async () => {
  await k.destroy();
  await pg.stop();
}, 60_000);

beforeEach(async () => {
  await sql.raw("DROP SCHEMA public CASCADE").execute(k);
  await sql.raw("CREATE SCHEMA public").execute(k);
  await sql.raw("GRANT USAGE ON SCHEMA public TO PUBLIC").execute(k);
  for (const role of ["mo_reader", "mo_admin"]) {
    await sql.raw(`DROP ROLE IF EXISTS ${role}`).execute(k);
    await sql.raw(`CREATE ROLE ${role}`).execute(k);
  }
  widened = false;
  renamed = false;
});

let widened = false;
let renamed = false;
const expectedSchema = (): SchemaSnapshot => {
  const schema = buildExpectedSchema(canonical, { views: buildProjectionViews(canonical, { dialect: "postgres" }) });
  if (widened) {
    schema.tables.find((t) => t.name === "weeks")!.columns.find((c) => c.name === "durationMinutes")!.sqlType =
      { kind: "integer", bits: 64 };
  }
  if (renamed) {
    // A renamed output column: `CREATE OR REPLACE VIEW` refuses it, so it is written as DROP + CREATE.
    const v = schema.views.find((x) => x.name === VIEW)!;
    v.sql = v.sql!.replace(' AS "totalMinutes"', ' AS "totalMinutesRenamed"');
    v.fingerprint = viewFingerprint(v.sql!);
  }
  return schema;
};

async function apply(text: string): Promise<void> {
  await sql.raw("BEGIN").execute(k);
  try {
    for (const stmt of splitSqlStatements(text)) await sql.raw(stmt).execute(k);
    await sql.raw("COMMIT").execute(k);
  } catch (e) {
    await sql.raw("ROLLBACK").execute(k);
    throw e;
  }
}

async function migrate(probe = true): Promise<{ up: string; notices: readonly string[]; kinds: string[] }> {
  const result = await diff({
    expected: expectedSchema(), actual: await introspectPostgres(k), dialect: "postgres",
    ...(probe ? { viewReplaceProbe: postgresViewReplaceProbe(k) } : {}), allow: { typeChange: true },
    unmanagedNames: collectUnmanagedNames(canonical),
  });
  expect(result.blocked).toEqual([]);
  const emitted = emit(result.changes, { dialect: "postgres" });
  if (emitted.up.trim().length > 0) await apply(emitted.up);
  return { up: emitted.up, notices: emitted.notices ?? [], kinds: result.changes.map((c) => c.kind) };
}

async function grantsOn(view: string): Promise<string[]> {
  const rows = await sql<{ g: string }>`
    SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || ':' || a.privilege_type ||
           (CASE WHEN a.is_grantable THEN ':grant' ELSE '' END) AS g
    FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.oid = to_regclass(${view}) AND a.grantee <> c.relowner ORDER BY 1`.execute(k);
  return rows.rows.map((r) => r.g);
}

async function grantThenCheck(): Promise<void> {
  await sql.raw(`GRANT SELECT ON ${VIEW} TO mo_reader`).execute(k);
  await sql.raw(`GRANT SELECT ON ${VIEW} TO mo_admin WITH GRANT OPTION`).execute(k);
  await sql.raw(`GRANT SELECT ON ${VIEW} TO PUBLIC`).execute(k);
  expect(await grantsOn(VIEW)).toEqual(["PUBLIC:SELECT", "mo_admin:SELECT:grant", "mo_reader:SELECT"]);
}

async function readerCanSelect(): Promise<void> {
  await sql.raw("SET ROLE mo_reader").execute(k);
  try {
    await sql.raw(`SELECT * FROM ${VIEW}`).execute(k);
  } finally {
    await sql.raw("RESET ROLE").execute(k);
  }
}

describe("a recreated report view keeps its grants (postgres)", () => {
  test("drop-view + create-view around a column type change", async () => {
    await migrate();
    await grantThenCheck();
    widened = true;
    const { up, notices, kinds } = await migrate();
    expect(kinds).toContain("drop-view");
    expect(up).toContain(`CREATE VIEW "${VIEW}"`);
    expect(notices).toContain(`view public.${VIEW}: dropped and recreated; its grants are carried over.`);
    expect(await grantsOn(VIEW)).toEqual(["PUBLIC:SELECT", "mo_admin:SELECT:grant", "mo_reader:SELECT"]);
    await readerCanSelect();
  }, 60_000);

  test("a report whose body changes, planned offline with no probe (drop + create)", async () => {
    await migrate();
    await grantThenCheck();
    renamed = true;
    const { up, kinds } = await migrate(false);
    expect(kinds).toContain("drop-view");
    expect(up).toContain(`DROP VIEW IF EXISTS "${VIEW}"`);
    expect(await grantsOn(VIEW)).toEqual(["PUBLIC:SELECT", "mo_admin:SELECT:grant", "mo_reader:SELECT"]);
    await readerCanSelect();
  }, 60_000);
});
