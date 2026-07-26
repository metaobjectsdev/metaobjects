/**
 * PG round-trip — #239: adopting an UNMANAGED view (no fingerprint) whose shape
 * changed too much for a legal `CREATE OR REPLACE` must be emitted as DROP+CREATE,
 * and it must APPLY cleanly against a DB that already holds the prior view.
 *
 * The bug: the adopt-view branch pushed `replace-view` unconditionally, so a renamed
 * output column emitted `CREATE OR REPLACE VIEW` — which Postgres rejects at apply
 * ("cannot change name of view column"). Invisible until apply (offline migrate /
 * a fresh DB where CREATE OR REPLACE behaves as CREATE never hit it).
 *
 * Acceptance gate (per the migrate round-trip discipline):
 *   hold the prior unmanaged view → diff (adoptView) → emit → APPLY → re-diff == [].
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { viewFingerprint } from "../../src/view-fingerprint.js";
import type { SchemaSnapshot } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

async function applyRaw(k: Kysely<Record<string, unknown>>, sqlText: string): Promise<void> {
  for (const stmt of sqlText.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(k);
  }
}

describe("PG adopt-view structural change round-trip (#239)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw(`DROP VIEW IF EXISTS v_foo CASCADE`).execute(kysely);
    await sql.raw(`DROP TABLE IF EXISTS t_239 CASCADE`).execute(kysely);
    await sql.raw(`CREATE TABLE t_239 (a text, b text)`).execute(kysely);
    // An UNMANAGED view: NO metaobjects fingerprint COMMENT (pre-fingerprint / hand-written).
    await sql.raw(`CREATE VIEW v_foo AS SELECT t_239.a AS a, t_239.b AS b FROM t_239`).execute(kysely);
  });

  afterAll(async () => {
    await sql.raw(`DROP VIEW IF EXISTS v_foo CASCADE`).execute(kysely);
    await sql.raw(`DROP TABLE IF EXISTS t_239 CASCADE`).execute(kysely);
    await pool.end();
  });

  test("renamed output column: adopt via DROP+CREATE, applies clean, re-diff empty", async () => {
    const actual = await introspectPostgres(kysely);
    // Metadata renames the second output column b → c (a structural change).
    const body = `SELECT t_239.a AS a, t_239.b AS c FROM t_239`;
    const expectedView = {
      name: "v_foo",
      sql: body,
      fingerprint: viewFingerprint(body),
      columns: [
        { name: "a", sqlType: { kind: "text" as const } },
        { name: "c", sqlType: { kind: "text" as const } },
      ],
      dependsOn: ["t_239"],
    };
    const expected: SchemaSnapshot = { tables: actual.tables, views: [expectedView] };

    const r = await diff(expected, actual, { dialect: "postgres", allow: { adoptView: true } });
    // The fix: a structural adoption is DROP+CREATE, never an illegal OR-REPLACE.
    expect(r.changes.find((c) => c.kind === "replace-view")).toBeUndefined();
    expect(r.changes.find((c) => c.kind === "drop-view")).toBeDefined();
    expect(r.blocked).toEqual([]);

    const up = emit(r.changes, { dialect: "postgres" }).up;
    expect(up).not.toMatch(/CREATE OR REPLACE VIEW/i);

    // Apply against the DB that ALREADY HOLDS the prior view — the bug threw HERE
    // with "cannot change name of view column b to c".
    await applyRaw(kysely, up);

    // Converged: the view is now fingerprint-stamped, so a re-diff is empty.
    const actual2 = await introspectPostgres(kysely);
    const r2 = await diff({ tables: actual2.tables, views: [expectedView] }, actual2, { dialect: "postgres" });
    expect(r2.changes.filter((c) => c.kind.endsWith("-view"))).toEqual([]);
  });
});
