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
  buildExpectedSchema, collectUnmanagedNames, computeDriftFromActual, diff, emit, introspectPostgres,
  isViewRecreateOnly, type Change, type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import type { MetaRoot } from "@metaobjectsdev/metadata";
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

async function applyRaw(text: string): Promise<void> {
  for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }
}

function isViewChange(c: Change): boolean {
  return c.kind === "create-view" || c.kind === "drop-view" || c.kind === "replace-view";
}

async function migrate(allow = {}) {
  const expected = expectedSchema();
  const unmanagedNames = collectUnmanagedNames(canonical);
  const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres", allow, unmanagedNames });
  expect(result.blocked).toEqual([]);
  const { up } = result.changes.length === 0 ? { up: "" } : emit(result.changes, { dialect: "postgres" });
  if (up.trim().length > 0) await applyRaw(up);
  return { result, up };
}

/** The canonical model migrated from empty, then `weeks.durationMinutes` made nullable by hand. */
async function migratedWithNullableWeeks(): Promise<void> {
  await migrate();
  await sql.raw(`ALTER TABLE "weeks" ALTER COLUMN "durationMinutes" DROP NOT NULL`).execute(k);
}

describe("D3 — a view recreated only around a column change is not drift (postgres)", () => {
  test("drift reports the column and no view", async () => {
    await migratedWithNullableWeeks();
    const drift = await computeDriftFromActual(await introspectPostgres(k), "postgres", canonical, {
      columnNamingStrategy: STRATEGY,
      views: views(),
    });
    expect(drift.changes.map((c) => c.kind)).toEqual(["change-column-nullable"]);
    expect(drift.blocked.filter(isViewChange)).toEqual([]);
  }, 60_000);

  test("the diff plans each pair marked unchanged; it applies and converges", async () => {
    await migratedWithNullableWeeks();
    const { result, up } = await migrate({ nullableToNotNull: true });
    const pairs = result.changes.filter(isViewChange);
    expect(pairs.length).toBeGreaterThan(0);
    for (const c of pairs) {
      expect(isViewRecreateOnly(c)).toBe(true);
      expect("reason" in c ? c.reason : undefined).toEqual({ kind: "unchanged", tables: ["weeks"] });
    }
    expect(up).toContain(`CREATE VIEW "v_program_minutes"`);

    const followup = await diff({
      expected: expectedSchema(),
      actual: await introspectPostgres(k),
      dialect: "postgres",
      unmanagedNames: collectUnmanagedNames(canonical),
    });
    expect(followup.changes).toEqual([]);
  }, 60_000);
});
