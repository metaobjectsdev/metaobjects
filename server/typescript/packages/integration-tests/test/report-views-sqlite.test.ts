/**
 * Report views — FR-044 Plan 2, against a REAL SQLite (libsql).
 *
 * The Postgres counterpart is `report-views-pg.test.ts`. SQLite lowers a report
 * differently on every axis the contract tables name: conditional aggregates are
 * `CASE WHEN`, the tuple distinct count goes through `json_array`, time grains are
 * `strftime` / `date` modifiers over ISO-8601 TEXT, and a ratio divides as `REAL`.
 *
 * CONVERGENCE here is a different claim than on Postgres. SQLite stores a view's SQL
 * text verbatim and introspection reads it back, so a second diff is empty only when the
 * emitter is DETERMINISTIC and its text survives the round trip byte for byte.
 *
 * THE INSTANT'S LITERAL (contract Table D, UNVERIFIED item, resolved below). Both
 * TypeScript SQLite writers spell an instant `YYYY-MM-DDTHH:MM:SS.sssZ`, with a
 * three-digit fraction even when it is zero:
 *   - the application stamp is `new Date().toISOString()` (`@autoSet`), and
 *   - the DDL default is `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (migrate-ts
 *     `SQLITE_ISO_NOW`, which `drizzle-schema.ts` mirrors byte for byte).
 * Table D's hour bucket for an instant is `strftime('%Y-%m-%dT%H:00:00.000Z', x)`, which
 * has that same spelling, so a bucket is text-comparable with a stored instant. A value
 * written without the fraction (`...:00Z`, what a client hands the wire in) is parsed by
 * `strftime` identically and lands in the same bucket; only its own stored text differs.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { buildExpectedSchema, diff, emit, introspectSqlite, type SchemaSnapshot } from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "report-views-sqlite-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "test.db")}` }) });
});

afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

// libsql execute() is single-statement: split on ";" (no view body or seed carries an inner ";").
async function applyRaw(text: string): Promise<void> {
  for (const stmt of text.trim().split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

async function loadInline(metaJson: string): Promise<MetaRoot> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
}

function expectedFor(root: MetaRoot): SchemaSnapshot {
  return buildExpectedSchema(root, {
    dialect: "sqlite",
    columnNamingStrategy: "literal",
    views: buildProjectionViews(root, { dialect: "sqlite", columnNamingStrategy: "literal" }),
  });
}

/**
 * `field.inet` has no SQLite storage class of its own: the canonical model's `all_types`
 * table declares two, SQLite introspects them back as TEXT, and the diff reports a blocked
 * `text -> inet` change on every run. That is a property of the table, not of any report
 * (nothing here reads `all_types`), and it is the only residue the canonical model leaves.
 * It is named, not swallowed: a residual change on any OTHER table or on any view fails.
 */
const isInetResidue = (c: { kind: string; table?: string }): boolean =>
  c.kind === "change-column-type" && c.table === "all_types";

/** build -> introspect -> diff -> emit -> apply. */
async function migrate(root: MetaRoot) {
  const expected = expectedFor(root);
  const actual = await introspectSqlite(k);
  const result = await diff({ expected, actual, dialect: "sqlite" });
  expect(result.blocked.filter((c) => !isInetResidue(c))).toEqual([]);
  const { up } = emit(result.changes.filter((c) => !isInetResidue(c)), {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual.meta !== undefined && { actualMeta: actual.meta }),
  });
  if (up.trim().length > 0) await applyRaw(up);
  return { expected, result, up };
}

async function assertConverged(expected: SchemaSnapshot): Promise<void> {
  const followup = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" });
  const residual = followup.changes.filter((c) => !isInetResidue(c));
  if (residual.length > 0) {
    console.error("NOT CONVERGED (sqlite) — a further migrate would emit:");
    for (const c of residual) console.error("  -", c.kind, JSON.stringify(c).slice(0, 200));
  }
  expect(residual).toEqual([]);
}

async function select(query: string): Promise<Record<string, unknown>[]> {
  return (await sql.raw(query).execute(k)).rows as Record<string, unknown>[];
}

function viewSql(root: MetaRoot, name: string): string {
  const v = buildProjectionViews(root, { dialect: "sqlite", columnNamingStrategy: "literal" })
    .find((x) => x.name === name);
  if (v === undefined) throw new Error(`no view ${name}`);
  return v.sql;
}

const SEED_PROGRAMS_AND_WEEKS = `
  INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00');
  INSERT INTO "weeks" ("id","programId","label","durationMinutes") VALUES
    (10, 1, 'Week 1', 30),
    (11, 1, 'Week 2', 60),
    (12, 1, 'Week 2', 90),
    (13, 1, NULL, 60),
    (20, 2, 'Solo', 45)`;

const SEED_PROGRAMS_BY_TIME = `
  INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00'),
    (3, 'Mobility', 1000, 'DRAFT', '2026-06-01T00:00:00'),
    (4, 'Legacy', 700, 'ARCHIVED', '2026-05-31T23:59:59'),
    (5, 'Monday', 300, 'PUBLISHED', '2026-05-18T00:00:00')`;

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("report views — canonical model on real SQLite", () => {
  let canonical: MetaRoot;
  let expected: SchemaSnapshot;

  beforeEach(async () => {
    canonical = await loadMetadataDir(CANONICAL_DIR);
    ({ expected } = await migrate(canonical));
  });

  test("CONVERGENCE: the six canonical views apply, then a second and third migrate propose nothing (the emitter is deterministic)", async () => {
    const views = (await select(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`)).map((r) => r.name);
    for (const v of [
      "v_program_minutes", "v_fitness_totals", "v_programs_by_month",
      "v_programs_by_week", "v_recent_programs", "v_asset_activity",
    ]) {
      expect(views).toContain(v);
    }

    await assertConverged(expected);
    const second = await migrate(canonical);
    expect(second.up.trim()).toBe("");
    expect(second.result.changes.filter((c) => !isInetResidue(c))).toEqual([]);
    const third = await migrate(canonical);
    expect(third.up.trim()).toBe("");
  });

  test("SQLite lowering shapes: CASE WHEN conditions, json_array tuple, REAL ratio, INNER JOIN", () => {
    const body = viewSql(canonical, "v_program_minutes");
    expect(body).toContain(`COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS "longWeeks"`);
    expect(body).toContain(`json_array(w."programId", w."durationMinutes")`);
    expect(body).toContain(`CAST(COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS REAL) / NULLIF(COUNT(w."id"), 0)`);
    expect(body).toContain(`INNER JOIN "programs" p ON p."id" = w."programId"`);
  });

  test("v_program_minutes: every measure kind, incl. the tuple distinct count through json_array", async () => {
    await applyRaw(SEED_PROGRAMS_AND_WEEKS);
    const rows = await select(`SELECT * FROM "v_program_minutes" ORDER BY "program"`);
    // SQLite has no decimal type: avg and the ratio are REAL (numbers), not decimal strings.
    expect(rows).toEqual([
      { program: 1, programTitle: "Foundations", weeks: 4, longWeeks: 3, labels: 2, slots: 3,
        totalMinutes: 240, avgMinutes: 60, minMinutes: 30, maxMinutes: 90, longShare: 0.75 },
      { program: 2, programTitle: "Strength", weeks: 1, longWeeks: 0, labels: 1, slots: 1,
        totalMinutes: 45, avgMinutes: 45, minMinutes: 45, maxMinutes: 45, longShare: 0 },
    ]);
    // Program 1 has four rows but three distinct (programId, durationMinutes) tuples, and
    // its labels are 'Week 1', 'Week 2' and one NULL: two distinct, the null uncounted.
    expect(await select(`SELECT "program" FROM "v_program_minutes" WHERE "weeks" >= 2`)).toEqual([{ program: 1 }]);
    expect(await select(`SELECT "program" FROM "v_program_minutes" ORDER BY "totalMinutes" DESC LIMIT 1`)).toEqual([{ program: 1 }]);
  });

  test("a tuple with a NULL component is not counted", async () => {
    // durationMinutes is required, so null the other component: programId is required too.
    // Prove the guard on the lowered text instead, and the count it protects by hand.
    const body = viewSql(canonical, "v_program_minutes");
    expect(body).toContain(`WHEN w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL THEN json_array(`);
    const r = await select(
      `SELECT COUNT(DISTINCT CASE WHEN a IS NOT NULL AND b IS NOT NULL THEN json_array(a, b) END) AS n
         FROM (SELECT 1 AS a, 2 AS b UNION ALL SELECT 1, 2 UNION ALL SELECT 1, NULL UNION ALL SELECT NULL, 3)`,
    );
    expect(r).toEqual([{ n: 1 }]);
  });

  test("v_fitness_totals: no dimensions, one row; ratio is REAL", async () => {
    await applyRaw(SEED_PROGRAMS_AND_WEEKS);
    expect(await select(`SELECT * FROM "v_fitness_totals"`)).toEqual([{ weeks: 5, totalMinutes: 285, longShare: 0.6 }]);
  });

  test("EMPTY GROUPS (Review Focus 4): v_fitness_totals over an empty weeks table is one row (0, NULL, NULL)", async () => {
    expect(await select(`SELECT count(*) AS n FROM "weeks"`)).toEqual([{ n: 0 }]);
    expect(await select(`SELECT * FROM "v_fitness_totals"`)).toEqual([{ weeks: 0, totalMinutes: null, longShare: null }]);
  });

  test("v_programs_by_month / v_programs_by_week: month grain, null filtered sum, ISO Monday boundary, report @segment", async () => {
    await applyRaw(SEED_PROGRAMS_BY_TIME);
    expect(await select(`SELECT * FROM "v_programs_by_month" ORDER BY "status"`)).toEqual([
      { createdAtMonth: "2026-05-01", status: "ARCHIVED", programs: 1, listValue: null },
      { createdAtMonth: "2026-06-01", status: "DRAFT", programs: 1, listValue: null },
      { createdAtMonth: "2026-05-01", status: "PUBLISHED", programs: 3, listValue: 7799 },
    ]);
    expect(await select(`SELECT * FROM "v_programs_by_week" ORDER BY "createdAtWeek"`)).toEqual([
      { createdAtWeek: "2026-04-27", programs: 1 },
      { createdAtWeek: "2026-05-11", programs: 1 },
      { createdAtWeek: "2026-05-18", programs: 1 },
    ]);
  });

  test("WEEK BOUNDARY: 2026-05-17T23:30:00 (Sunday) is in the week of 2026-05-11; 2026-05-18T00:00:00 (Monday) opens 2026-05-18", async () => {
    const r = await select(
      `SELECT date(t, 'weekday 0', '-6 days') AS wk FROM
         (SELECT '2026-05-17T23:30:00' AS t UNION ALL SELECT '2026-05-18T00:00:00' ORDER BY 1)`,
    );
    expect(r).toEqual([{ wk: "2026-05-11" }, { wk: "2026-05-18" }]);
    // And through the view's own expression, on the programs seeded exactly there.
    await applyRaw(`
      INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
        (1, 'Sunday', 1, 'PUBLISHED', '2026-05-17T23:30:00'),
        (2, 'Monday', 1, 'PUBLISHED', '2026-05-18T00:00:00')`);
    expect(await select(`SELECT "createdAtWeek" FROM "v_programs_by_week" ORDER BY 1`))
      .toEqual([{ createdAtWeek: "2026-05-11" }, { createdAtWeek: "2026-05-18" }]);
  });

  test("v_asset_activity: hour on an instant, week on a field.date; the hour bucket's literal is `…:00:00.000Z`", async () => {
    // Instants are stored the way the TS writers spell them: a three-digit fraction + Z.
    await applyRaw(`
      INSERT INTO "assets" ("id","ownerId","recordedAt","observedAt","asOfDate","atTime") VALUES
        ('00000000-0000-4000-8000-000000000001', '${OWNER}', '2026-05-04T03:30:00.000Z', '2026-05-04T03:30:00.000', '2026-05-03', '03:30:00'),
        ('00000000-0000-4000-8000-000000000002', '${OWNER}', '2026-05-04T03:45:00.000Z', '2026-05-04T03:45:00.000', '2026-05-03', '03:45:00'),
        ('00000000-0000-4000-8000-000000000003', '${OWNER}', '2026-05-04T04:10:00.000Z', '2026-05-04T04:10:00.000', '2026-05-04', '04:10:00')`);
    const rows = await select(`SELECT * FROM "v_asset_activity" ORDER BY "recordedAtHour"`);
    expect(rows).toEqual([
      { recordedAtHour: "2026-05-04T03:00:00.000Z", asOfDateWeek: "2026-04-27", assets: 2 },
      { recordedAtHour: "2026-05-04T04:00:00.000Z", asOfDateWeek: "2026-05-04", assets: 1 },
    ]);

    // PIN: the bucket has the same spelling as every instant the TS adapters store, so it
    // sorts and compares as text against them. Both writers' spellings, derived live:
    const written = await select(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '2026-05-04T03:00:00Z') AS ddlDefault`);
    expect(written[0]?.ddlDefault).toBe("2026-05-04T03:00:00.000Z"); // migrate-ts SQLITE_ISO_NOW
    expect(new Date("2026-05-04T03:00:00Z").toISOString()).toBe("2026-05-04T03:00:00.000Z"); // @autoSet
    expect(rows[0]?.recordedAtHour).toBe(written[0]?.ddlDefault as string);
    expect(rows[0]?.recordedAtHour).toBe(new Date("2026-05-04T03:00:00Z").toISOString());

    // A value stored WITHOUT the fraction (an unpadded wire string) still buckets the same.
    await applyRaw(`
      INSERT INTO "assets" ("id","ownerId","recordedAt","observedAt","asOfDate","atTime") VALUES
        ('00000000-0000-4000-8000-000000000004', '${OWNER}', '2026-05-04T03:59:59Z', '2026-05-04T03:59:59', '2026-05-04', '03:59:59')`);
    expect(await select(`SELECT "assets" FROM "v_asset_activity" WHERE "recordedAtHour" = '2026-05-04T03:00:00.000Z' AND "asOfDateWeek" = '2026-05-04'`))
      .toEqual([{ assets: 1 }]);
  });

  test("RELATIVE WINDOW: v_recent_programs counts the program 3 days old, not the one 60 days old", async () => {
    // created_ts is a naive timestamp, stored as a naive wall clock (no Z).
    await applyRaw(`
      INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
        (1, 'Recent', 100, 'PUBLISHED', strftime('%Y-%m-%dT%H:%M:%f','now','-3 days')),
        (2, 'Stale', 100, 'PUBLISHED', strftime('%Y-%m-%dT%H:%M:%f','now','-60 days'))`);
    expect(await select(`SELECT * FROM "v_recent_programs"`)).toEqual([{ programs: 1 }]);
  });
});

describe("report views — inline model on real SQLite", () => {
  /** A Stamp table with date and naive-timestamp columns for the quarter / year grains. */
  const STAMP_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Stamp", children: [
      { "source.rdb": { "@table": "stamps" } },
      { "field.long": { name: "id" } },
      { "field.date": { name: "day", "@required": true } },
      { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      { "dimension.time": { name: "day", "@of": "Stamp.day", "@grains": ["quarter", "year"] } },
      { "measure.aggregate": { name: "stamps", "@agg": "count", "@of": "Stamp.id" } },
    ] } },
    { "object.report": { name: "StampsByQuarter", "@from": "Stamp", "@dimensions": ["day:quarter"], "@measures": ["stamps"], children: [
      { "source.rdb": { "@kind": "view", "@view": "v_stamps_by_quarter" } } ] } },
    { "object.report": { name: "StampsByYear", "@from": "Stamp", "@dimensions": ["day:year"], "@measures": ["stamps"], children: [
      { "source.rdb": { "@kind": "view", "@view": "v_stamps_by_year" } } ] } },
  ]}});

  test("QUARTER and YEAR grains: every month of a quarter lands on its first day, and the view converges", async () => {
    const root = await loadInline(STAMP_MODEL);
    expect(viewSql(root, "v_stamps_by_quarter")).toContain(
      `date(s."day", 'start of month', '-' || ((CAST(strftime('%m', s."day") AS INTEGER) - 1) % 3) || ' months')`,
    );
    const { expected } = await migrate(root);
    await assertConverged(expected);

    await applyRaw(`
      INSERT INTO "stamps" ("day") VALUES
        ('2026-01-01'), ('2026-03-31'),
        ('2026-04-01'), ('2026-05-01'), ('2026-06-30'),
        ('2026-07-01'),
        ('2026-12-31'),
        ('2027-02-14')`);
    expect(await select(`SELECT * FROM "v_stamps_by_quarter" ORDER BY "dayQuarter"`)).toEqual([
      { dayQuarter: "2026-01-01", stamps: 2 },
      { dayQuarter: "2026-04-01", stamps: 3 },
      { dayQuarter: "2026-07-01", stamps: 1 },
      { dayQuarter: "2026-10-01", stamps: 1 },
      { dayQuarter: "2027-01-01", stamps: 1 },
    ]);
    expect(await select(`SELECT * FROM "v_stamps_by_year" ORDER BY "dayYear"`)).toEqual([
      { dayYear: "2026-01-01", stamps: 7 },
      { dayYear: "2027-01-01", stamps: 1 },
    ]);
  });
});
