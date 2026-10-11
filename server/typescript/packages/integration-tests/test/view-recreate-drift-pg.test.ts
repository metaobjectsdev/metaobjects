/**
 * D3 on a REAL Postgres: a managed view recreated only around a table change is not drift.
 *
 * Postgres refuses to ALTER a column a view reads, so the diff drops and recreates every view
 * over an altered table. Postgres also deparses the stored view body, so equality comes from
 * the fingerprint in the view's COMMENT, not from the text. The pair stays in the migration
 * SQL; it says the view is unchanged, a drift report leaves it out, and it converges.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchema, collectUnmanagedNames, computeDriftFromActual, diff, emit, introspectPostgres, postgresViewReplaceProbe,
  isViewRecreateOnly, type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { isViewChange } from "../src/drift-residue.ts";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

let pg: RunningPg;
let k: Kysely<Record<string, unknown>>;
let canonical: MetaRoot;

beforeAll(async () => {
  pg = await startPostgres();
  k = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: pg.connectionUri }) }),
  });
  canonical = await loadMetadataDir(CANONICAL_DIR);
}, 120_000);

afterAll(async () => {
  await k.destroy();
  await pg.stop();
}, 60_000);

beforeEach(async () => {
  await sql.raw("DROP SCHEMA public CASCADE").execute(k);
  await sql.raw("CREATE SCHEMA public").execute(k);
});

const STRATEGY = "literal" as const;
const views = () => buildProjectionViews(canonical, { dialect: "postgres", columnNamingStrategy: STRATEGY });
const expectedSchema = (): SchemaSnapshot =>
  buildExpectedSchema(canonical, { columnNamingStrategy: STRATEGY, views: views() });

/**
 * The expected schema once the metadata widens `weeks.durationMinutes` to a bigint. Postgres blocks
 * a type change on a column a view reads, so this is the change that strands every view over it
 * (a nullability or default change does not: it alters in place). The views' SQL is untouched, so
 * their fingerprints still match.
 */
let widened = false;
const expectedForRun = (): SchemaSnapshot => {
  const schema = expectedSchema();
  if (!widened) return schema;
  const weeks = schema.tables.find((t) => t.name === "weeks")!;
  weeks.columns.find((c) => c.name === "durationMinutes")!.sqlType = { kind: "integer", bits: 64 };
  return schema;
};

async function applyRaw(text: string): Promise<void> {
  for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }
}

async function migrate(allow = {}) {
  const expected = expectedForRun();
  const unmanagedNames = collectUnmanagedNames(canonical);
  const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres", viewReplaceProbe: postgresViewReplaceProbe(k), allow, unmanagedNames });
  expect(result.blocked).toEqual([]);
  const { up } = result.changes.length === 0 ? { up: "" } : emit(result.changes, { dialect: "postgres" });
  if (up.trim().length > 0) await applyRaw(up);
  return { result, up };
}

/** The canonical model migrated from empty, then the metadata widens `weeks.durationMinutes`. */
async function migratedThenWidened(): Promise<void> {
  widened = false;
  await migrate();
  widened = true;
}

describe("D3 — a view recreated only around a column change is not drift (postgres)", () => {
  test("drift reports the column and no view", async () => {
    await migratedThenWidened();
    // computeDriftFromActual builds its own expected schema from the metadata, so mirror the
    // widening on the other side: the database column reads as the wider type.
    const actual = await introspectPostgres(k);
    actual.tables.find((t) => t.name === "weeks")!.columns.find((c) => c.name === "durationMinutes")!.sqlType =
      { kind: "integer", bits: 64 };
    const drift = await computeDriftFromActual(actual, "postgres", canonical, {
      columnNamingStrategy: STRATEGY,
      views: views(),
    });
    expect(drift.changes.map((c) => c.kind)).toEqual(["change-column-type"]);
    expect(drift.blocked.filter(isViewChange)).toEqual([]);
  }, 60_000);

  test("the diff plans each pair marked unchanged; it applies and converges", async () => {
    await migratedThenWidened();
    const { result, up } = await migrate({ typeChange: true });
    const pairs = result.changes.filter(isViewChange);
    expect(pairs.length).toBeGreaterThan(0);
    for (const c of pairs) {
      expect(isViewRecreateOnly(c)).toBe(true);
      expect("reason" in c ? c.reason : undefined).toEqual({ kind: "unchanged", tables: ["weeks"] });
    }
    expect(up).toContain(`CREATE VIEW "v_program_minutes"`);

    const followup = await diff({
      expected: expectedForRun(),
      actual: await introspectPostgres(k),
      dialect: "postgres",
      viewReplaceProbe: postgresViewReplaceProbe(k),
      unmanagedNames: collectUnmanagedNames(canonical),
    });
    expect(followup.changes).toEqual([]);
  }, 60_000);
});
