/**
 * Report views — FR-044 Plan 2, against a REAL Postgres.
 *
 * Earlier tasks proved the lowering as text (emitter goldens) and through the unit-level
 * view builder. This is where a report view first meets an engine: it must (1) CONVERGE
 * under `meta migrate` (emit -> apply -> re-diff empty, which is what Postgres deparsing
 * the stored view body makes non-trivial), and (2) return the expected rows.
 *
 * The rows are the ones the shared Task 10 persistence scenarios assert. They are read
 * here with raw SQL straight off the views, so a wrong value is a LOWERING defect, not
 * an ObjectManager one.
 *
 * Raw values are compared as the engine sends them (dates and timestamps as text, int8
 * and numeric as strings). Postgres pads numeric precision (`AVG(int)` is
 * `60.0000000000000000`), so decimals are compared through `canonicalDecimal`, which is
 * what the conformance runner's wire normalisation does too.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchema, diff, emit, introspectPostgres, collectUnmanagedNames,
  type AllowOptions, type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Client, Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

// ---------------------------------------------------------------------------------
// Container + pipeline helpers (the same shape as view-lifecycle-pg.test.ts).
// ---------------------------------------------------------------------------------

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

async function applyRaw(text: string): Promise<void> {
  for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }
}

async function loadInline(metaJson: string): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(metaJson)]);
  // The loader collects errors instead of throwing; a refused inline model must not be migrated.
  expect(r.errors).toEqual([]);
  return r.root;
}

function expectedFor(root: MetaRoot): SchemaSnapshot {
  return buildExpectedSchema(root, {
    columnNamingStrategy: "literal",
    views: buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "literal" }),
  });
}

/** build -> introspect -> diff -> emit -> apply, exactly the production pipeline. */
async function migrate(root: MetaRoot, allow: AllowOptions = {}) {
  const expected = expectedFor(root);
  const unmanagedNames = collectUnmanagedNames(root);
  const result = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres", allow, unmanagedNames });
  const emittable = result.changes.filter((c) => c.status.state !== "blocked");
  const { up } = emittable.length === 0 ? { up: "" } : emit(emittable, { dialect: "postgres" });
  if (result.blocked.length === 0 && up.trim().length > 0) await applyRaw(up);
  return { expected, unmanagedNames, result, up };
}

/** THE gate: re-diffing the just-migrated database proposes nothing. */
async function assertConverged(expected: SchemaSnapshot, unmanagedNames: string[] = []): Promise<void> {
  const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres", unmanagedNames });
  if (followup.changes.length > 0) {
    console.error("NOT CONVERGED — a further `meta migrate` would emit:");
    for (const c of followup.changes) console.error("  -", c.kind, JSON.stringify(c).slice(0, 200));
  }
  expect(followup.changes).toEqual([]);
}

/**
 * Raw, text-faithful reads: only int4 becomes a number; int8, numeric, dates and
 * timestamps stay the strings Postgres sent, so nothing is reshaped by the driver.
 * `sessionZone` runs the connection in that time zone (Review Focus 3).
 */
async function select(query: string, sessionZone?: string): Promise<Record<string, unknown>[]> {
  const c = new Client({
    connectionString: pg.connectionUri,
    types: { getTypeParser: (oid: number) => (oid === 23 ? (v: string) => Number(v) : (v: string) => v) },
  });
  await c.connect();
  try {
    if (sessionZone !== undefined) await c.query(`SET TIME ZONE '${sessionZone}'`);
    return (await c.query(query)).rows as Record<string, unknown>[];
  } finally {
    await c.end();
  }
}

/** `60.0000000000000000` -> `60`, `0.75000000000000000000` -> `0.75`; null stays null. */
function canonicalDecimal(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** The `CREATE VIEW` body this model's builder produces for `name`. */
function viewSql(root: MetaRoot, name: string): string {
  const v = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "literal" })
    .find((x) => x.name === name);
  if (v === undefined) throw new Error(`no view ${name}`);
  return v.sql;
}

// ---------------------------------------------------------------------------------
// Seeds — verbatim from the Task 10 scenarios.
// ---------------------------------------------------------------------------------

const SEED_PROGRAMS_AND_WEEKS = `
  INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00');
  INSERT INTO "weeks" ("id","programId","label","durationMinutes") VALUES
    (10, 1, 'Week 1', 30),
    (11, 1, 'Week 2', 60),
    (12, 1, 'Week 2', 90),
    (13, 1, NULL, 60),
    (20, 2, 'Solo', 45);`;

const SEED_PROGRAMS_BY_TIME = `
  INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00'),
    (3, 'Mobility', 1000, 'DRAFT', '2026-06-01T00:00:00'),
    (4, 'Legacy', 700, 'ARCHIVED', '2026-05-31T23:59:59'),
    (5, 'Monday', 300, 'PUBLISHED', '2026-05-18T00:00:00');`;

const SEED_ASSETS = `
  INSERT INTO "assets" ("ownerId","recordedAt","observedAt","asOfDate","atTime") VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-05-04T03:30:00Z', '2026-05-04T03:30:00', '2026-05-03', '03:30:00'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-05-04T03:45:00Z', '2026-05-04T03:45:00', '2026-05-03', '03:45:00'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-05-04T04:10:00Z', '2026-05-04T04:10:00', '2026-05-04', '04:10:00');`;

const HOUR_BUCKET = `to_char("recordedAtHour" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

describe("report views — canonical model on real Postgres", () => {
  // -------------------------------------------------------------------------
  // Convergence (spec §7: emit -> apply -> re-diff empty).
  // -------------------------------------------------------------------------

  test("CONVERGENCE: the six canonical report views migrate from empty, then a second and third migrate propose nothing", async () => {
    const first = await migrate(canonical);

    for (const view of [
      "v_program_minutes", "v_fitness_totals", "v_programs_by_month",
      "v_programs_by_week", "v_recent_programs", "v_asset_activity",
    ]) {
      expect(first.up).toContain(`CREATE VIEW "${view}" AS`);
      const r = await sql.raw(`SELECT to_regclass('public.${view}') IS NOT NULL AS ok`).execute(k);
      expect((r.rows[0] as { ok: boolean }).ok).toBe(true);
    }

    await assertConverged(first.expected, first.unmanagedNames);

    const second = await migrate(canonical);
    expect(second.up.trim()).toBe("");
    expect(second.result.changes).toEqual([]);
    await assertConverged(second.expected, second.unmanagedNames);

    const third = await migrate(canonical);
    expect(third.up.trim()).toBe("");
    expect(third.result.changes).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Join type: the existing #209 rule, unchanged.
  // -------------------------------------------------------------------------

  test("JOIN TYPE: Week.fkProgram is a required belongs-to, so v_program_minutes joins programs INNER", () => {
    const body = viewSql(canonical, "v_program_minutes");
    expect(body).toContain(`INNER JOIN "programs" p ON p."id" = w."programId"`);
    expect(body).not.toContain("LEFT OUTER JOIN");
  });

  // -------------------------------------------------------------------------
  // Values — the Task 10 scenarios, read straight off the views.
  // -------------------------------------------------------------------------

  describe("values", () => {
    beforeEach(async () => {
      await migrate(canonical);
    });

    test("v_program_minutes: every measure kind, one row per (program, programTitle)", async () => {
      await applyRaw(SEED_PROGRAMS_AND_WEEKS);
      const rows = await select(`SELECT * FROM "v_program_minutes" ORDER BY "program"`);
      expect(rows.map((r) => ({ ...r, avgMinutes: canonicalDecimal(r.avgMinutes), longShare: canonicalDecimal(r.longShare) })))
        .toEqual([
          { program: "1", programTitle: "Foundations", weeks: "4", longWeeks: "3", labels: "2", slots: "3",
            totalMinutes: "240", avgMinutes: "60", minMinutes: 30, maxMinutes: 90, longShare: "0.75" },
          { program: "2", programTitle: "Strength", weeks: "1", longWeeks: "0", labels: "1", slots: "1",
            totalMinutes: "45", avgMinutes: "45", minMinutes: 45, maxMinutes: 45, longShare: "0" },
        ]);

      // The measure-filter, sort and count the shared scenario runs through the view.
      expect(
        (await select(`SELECT "program" FROM "v_program_minutes" WHERE "weeks" >= 2 ORDER BY "program"`)).map((r) => r.program),
      ).toEqual(["1"]);
      expect(
        (await select(`SELECT "program" FROM "v_program_minutes" ORDER BY "totalMinutes" DESC LIMIT 1`)).map((r) => r.program),
      ).toEqual(["1"]);
      expect((await select(`SELECT count(*) AS n FROM "v_program_minutes"`))[0]?.n).toBe("2");
    });

    test("v_fitness_totals: no dimensions, one row over the whole table", async () => {
      await applyRaw(SEED_PROGRAMS_AND_WEEKS);
      const rows = await select(`SELECT * FROM "v_fitness_totals"`);
      expect(rows.map((r) => ({ ...r, longShare: canonicalDecimal(r.longShare) })))
        .toEqual([{ weeks: "5", totalMinutes: "285", longShare: "0.6" }]);
    });

    test("EMPTY GROUPS (Review Focus 4): v_fitness_totals over an empty weeks table is one row (0, NULL, NULL)", async () => {
      const count = await select(`SELECT count(*) AS n FROM "weeks"`);
      expect(count[0]?.n).toBe("0");
      const rows = await select(`SELECT * FROM "v_fitness_totals"`);
      // One row, count 0, a sum of nothing is NULL (not 0), a zero denominator is NULL.
      expect(rows).toEqual([{ weeks: "0", totalMinutes: null, longShare: null }]);
    });

    test("v_programs_by_month and v_programs_by_week: month grain, enum dimension, null filtered sum, ISO Monday boundary, report @segment", async () => {
      await applyRaw(SEED_PROGRAMS_BY_TIME);

      const month = await select(`SELECT * FROM "v_programs_by_month" ORDER BY "status"`);
      expect(month).toEqual([
        { createdAtMonth: "2026-05-01", status: "ARCHIVED", programs: "1", listValue: null },
        { createdAtMonth: "2026-06-01", status: "DRAFT", programs: "1", listValue: null },
        { createdAtMonth: "2026-05-01", status: "PUBLISHED", programs: "3", listValue: "7799" },
      ]);

      // Program 2 (Sunday 23:30) and program 5 (Monday 00:00) are thirty minutes apart
      // and land in different weeks; DRAFT / ARCHIVED are scoped out by the segment.
      const week = await select(`SELECT * FROM "v_programs_by_week" ORDER BY "createdAtWeek"`);
      expect(week).toEqual([
        { createdAtWeek: "2026-04-27", programs: "1" },
        { createdAtWeek: "2026-05-11", programs: "1" },
        { createdAtWeek: "2026-05-18", programs: "1" },
      ]);
    });

    test("v_asset_activity: hour on an instant, week on a field.date", async () => {
      await applyRaw(SEED_ASSETS);
      const rows = await select(
        `SELECT ${HOUR_BUCKET} AS "recordedAtHour", "asOfDateWeek"::text AS "asOfDateWeek", "assets"
           FROM "v_asset_activity" ORDER BY "recordedAtHour"`,
      );
      expect(rows).toEqual([
        { recordedAtHour: "2026-05-04T03:00:00Z", asOfDateWeek: "2026-04-27", assets: "2" },
        { recordedAtHour: "2026-05-04T04:00:00Z", asOfDateWeek: "2026-05-04", assets: "1" },
      ]);
    });

    test("UTC BUCKETS (Review Focus 3): under a New York session zone an instant still lands in its UTC hour bucket", async () => {
      // 23:30 on 2026-05-03 in New York (UTC-4 in May) is 03:30 on 2026-05-04 UTC.
      await sql.raw(
        `INSERT INTO "assets" ("ownerId","recordedAt","observedAt","asOfDate","atTime") VALUES
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-05-03T23:30:00-04:00', '2026-05-03T23:30:00', '2026-05-03', '23:30:00')`,
      ).execute(k);
      const rows = await select(
        `SELECT ${HOUR_BUCKET} AS "recordedAtHour", "assets" FROM "v_asset_activity"`,
        "America/New_York",
      );
      expect(rows).toEqual([{ recordedAtHour: "2026-05-04T03:00:00Z", assets: "1" }]);
      // And the session really was not UTC while it ran.
      expect((await select(`SHOW TIME ZONE`, "America/New_York"))[0]).toEqual({ TimeZone: "America/New_York" });
    });

    test("RELATIVE WINDOW: v_recent_programs counts the program 3 days old, not the one 60 days old", async () => {
      await applyRaw(`
        INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
          (1, 'Recent', 100, 'PUBLISHED', (now() AT TIME ZONE 'UTC') - INTERVAL '3 days'),
          (2, 'Stale', 100, 'PUBLISHED', (now() AT TIME ZONE 'UTC') - INTERVAL '60 days');`);
      expect(await select(`SELECT * FROM "v_recent_programs"`)).toEqual([{ programs: "1" }]);
    });
  });
});

// ---------------------------------------------------------------------------------
// Inline models: the behaviours the canonical corpus does not exercise.
// ---------------------------------------------------------------------------------

/** An Event table, hour and day reports over its UTC instant (Review Focus 3, day grain). */
const EVENT_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Event", children: [
    { "source.rdb": { "@table": "events" } },
    { "field.long": { name: "id" } },
    { "field.timestamp": { name: "recordedAt", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "dimension.time": { name: "recordedAt", "@of": "Event.recordedAt", "@grains": ["hour", "day"] } },
    { "measure.aggregate": { name: "events", "@agg": "count", "@of": "Event.id" } },
  ] } },
  { "object.report": { name: "EventsByDay", "@from": "Event", "@dimensions": ["recordedAt:day"], "@measures": ["events"], children: [
    { "source.rdb": { "@kind": "view", "@view": "v_events_by_day" } } ] } },
  { "object.report": { name: "EventsByHour", "@from": "Event", "@dimensions": ["recordedAt:hour"], "@measures": ["events"], children: [
    { "source.rdb": { "@kind": "view", "@view": "v_events_by_hour" } } ] } },
]}});

/** A Fact whose program reference is NULLABLE, grouped by the referenced program's title. */
const FACT_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Prog", children: [
    { "source.rdb": { "@table": "progs" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "title", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
  ] } },
  { "object.entity": { name: "Fact", children: [
    { "source.rdb": { "@table": "facts" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "progId" } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "identity.reference": { name: "fkProg", "@fields": "progId", "@references": "Prog" } },
    { "dimension.attribute": { name: "progTitle", "@of": "Prog.title", "@via": "Fact.fkProg" } },
    { "measure.aggregate": { name: "facts", "@agg": "count", "@of": "Fact.id" } },
  ] } },
  { "object.report": { name: "FactsByProg", "@from": "Fact", "@dimensions": ["progTitle"], "@measures": ["facts"], children: [
    { "source.rdb": { "@kind": "view", "@view": "v_facts_by_prog" } } ] } },
]}});

/** A Metric table with one measure, optionally a second; the report lists what it has. */
function metricModel(measures: string[]): string {
  const all = [
    { "measure.aggregate": { name: "samples", "@agg": "count", "@of": "Metric.id" } },
    { "measure.aggregate": { name: "total", "@agg": "sum", "@of": "Metric.amount" } },
  ];
  return JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Metric", children: [
      { "source.rdb": { "@table": "metrics" } },
      { "field.long": { name: "id" } },
      { "field.int": { name: "amount", "@required": true } },
      { "field.string": { name: "kind", "@required": true } },
      { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      { "dimension.attribute": { name: "kind", "@of": "Metric.kind" } },
      ...all,
    ] } },
    { "object.report": { name: "MetricsByKind", "@from": "Metric", "@dimensions": ["kind"], "@measures": measures, children: [
      { "source.rdb": { "@kind": "view", "@view": "v_metrics_by_kind" } } ] } },
  ]}});
}

describe("report views — inline models on real Postgres", () => {
  test("UTC BUCKETS (Review Focus 3): a report at recordedAt:day puts 23:30 New York on the next UTC day", async () => {
    const root = await loadInline(EVENT_MODEL);
    const { expected, unmanagedNames } = await migrate(root);
    await assertConverged(expected, unmanagedNames);

    await sql.raw(
      `INSERT INTO "events" ("recordedAt") VALUES ('2026-05-03T23:30:00-04:00')`,
    ).execute(k);

    const day = await select(`SELECT "recordedAtDay"::text AS "recordedAtDay", "events" FROM "v_events_by_day"`, "America/New_York");
    expect(day).toEqual([{ recordedAtDay: "2026-05-04", events: "1" }]);
    const hour = await select(
      `SELECT ${HOUR_BUCKET} AS "recordedAtHour", "events" FROM "v_events_by_hour"`,
      "America/New_York",
    );
    expect(hour).toEqual([{ recordedAtHour: "2026-05-04T03:00:00Z", events: "1" }]);

    // The same rows under a UTC session: the buckets are the reader's-zone-independent.
    expect(await select(`SELECT "recordedAtDay"::text AS "recordedAtDay", "events" FROM "v_events_by_day"`, "UTC"))
      .toEqual(day);
  }, 60_000);

  test("JOIN TYPE: a NULLABLE @via FK lowers to LEFT OUTER JOIN, and a fact with a NULL FK lands in a NULL group", async () => {
    const root = await loadInline(FACT_MODEL);
    const body = viewSql(root, "v_facts_by_prog");
    expect(body).toContain(`LEFT OUTER JOIN "progs"`);
    expect(body).not.toContain("INNER JOIN");

    const { expected, unmanagedNames } = await migrate(root);
    await assertConverged(expected, unmanagedNames);

    await applyRaw(`
      INSERT INTO "progs" ("id","title") VALUES (1, 'Alpha');
      INSERT INTO "facts" ("id","progId") VALUES (1, 1), (2, 1), (3, NULL), (4, NULL), (5, NULL);`);
    const rows = await select(`SELECT * FROM "v_facts_by_prog" ORDER BY "progTitle" NULLS LAST`);
    expect(rows).toEqual([
      { progTitle: "Alpha", facts: "2" },
      { progTitle: null, facts: "3" },
    ]);
  }, 60_000);

  test("CHANGE A REPORT: adding a measure is a drop and a create of that view, and then converges", async () => {
    const before = await loadInline(metricModel(["samples"]));
    const first = await migrate(before);
    await assertConverged(first.expected, first.unmanagedNames);

    const after = await loadInline(metricModel(["samples", "total"]));
    // A plain `meta migrate`, no --allow: the drop is PAIRED with the create of the same view,
    // which is not a destructive change. Passing dropView here would hide a broken pairing.
    const { result, up, expected, unmanagedNames } = await migrate(after);
    expect(result.blocked).toEqual([]);

    const viewChanges = result.changes.filter((c) => c.kind.endsWith("-view"));
    expect(viewChanges.map((c) => c.kind).sort()).toEqual(["create-view", "drop-view"]);
    expect(up).toContain(`DROP VIEW`);
    expect(up).toContain(`CREATE VIEW "v_metrics_by_kind" AS`);
    // A fail-safe drop and create, not CREATE OR REPLACE (the report carries no column list).
    expect(up).not.toContain("CREATE OR REPLACE");

    const cols = await sql.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'v_metrics_by_kind' ORDER BY ordinal_position`,
    ).execute(k);
    expect((cols.rows as { column_name: string }[]).map((c) => c.column_name)).toEqual(["kind", "samples", "total"]);

    await assertConverged(expected, unmanagedNames);
    const again = await migrate(after);
    expect(again.up.trim()).toBe("");
  }, 60_000);

  test("a tuple with a NULL component is not counted, read through the lowered view", async () => {
    // The canonical tuple's components are both required, so only an inline model can put a
    // NULL through the FILTER guard on an engine.
    const root = await loadInline(JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Pair", children: [
        { "source.rdb": { "@table": "pairs" } },
        { "field.long": { name: "id" } },
        { "field.int": { name: "a" } },
        { "field.int": { name: "b" } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
        { "measure.aggregate": { name: "combos", "@agg": "count", "@distinct": true, "@of": ["Pair.a", "Pair.b"] } },
      ] } },
      { "object.report": { name: "PairTotals", "@from": "Pair", "@measures": ["combos"], children: [
        { "source.rdb": { "@kind": "view", "@view": "v_pair_totals" } } ] } },
    ]}}));
    const { expected, unmanagedNames } = await migrate(root);
    await assertConverged(expected, unmanagedNames);
    await applyRaw(`
      INSERT INTO "pairs" ("a","b") VALUES (1, 2), (1, 2), (2, 1), (1, NULL), (NULL, 3), (NULL, NULL);`);
    expect(await select(`SELECT * FROM "v_pair_totals"`)).toEqual([{ combos: "2" }]);
  }, 60_000);

  test("SUM TYPES (Table C): a decimal sum stays numeric and a double sum is double precision, on the engine", async () => {
    const root = await loadInline(JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Reading", children: [
        { "source.rdb": { "@table": "readings" } },
        { "field.long": { name: "id" } },
        { "field.decimal": { name: "amount", "@precision": 12, "@scale": 2 } },
        { "field.double": { name: "score" } },
        { "field.float": { name: "ratio" } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
        { "measure.aggregate": { name: "amountTotal", "@agg": "sum", "@of": "Reading.amount" } },
        { "measure.aggregate": { name: "scoreTotal", "@agg": "sum", "@of": "Reading.score" } },
        { "measure.aggregate": { name: "ratioTotal", "@agg": "sum", "@of": "Reading.ratio" } },
      ] } },
      { "object.report": { name: "ReadingTotals", "@from": "Reading",
        "@measures": ["amountTotal", "scoreTotal", "ratioTotal"], children: [
        { "source.rdb": { "@kind": "view", "@view": "v_reading_totals" } } ] } },
    ]}}));
    const body = viewSql(root, "v_reading_totals");
    expect(body).toContain(`SUM(r."amount") AS "amountTotal"`);
    expect(body).toContain(`CAST(SUM(r."score") AS DOUBLE PRECISION) AS "scoreTotal"`);
    expect(body).toContain(`CAST(SUM(r."ratio") AS DOUBLE PRECISION) AS "ratioTotal"`);

    const { expected, unmanagedNames } = await migrate(root);
    await assertConverged(expected, unmanagedNames);

    // The view's column types are what Table B promises the readers.
    const cols = await sql.raw(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'v_reading_totals' ORDER BY ordinal_position`,
    ).execute(k);
    expect(cols.rows).toEqual([
      { column_name: "amountTotal", data_type: "numeric" },
      { column_name: "scoreTotal", data_type: "double precision" },
      { column_name: "ratioTotal", data_type: "double precision" },
    ]);

    // Over zero rows every sum is NULL, never 0.
    expect(await select(`SELECT * FROM "v_reading_totals"`)).toEqual([
      { amountTotal: null, scoreTotal: null, ratioTotal: null },
    ]);
    await applyRaw(`INSERT INTO "readings" ("amount","score","ratio") VALUES (10.25, 1.5, 0.5), (0.50, 2.25, 0.25);`);
    const [row] = await select(`SELECT * FROM "v_reading_totals"`);
    expect(canonicalDecimal(row!.amountTotal)).toBe("10.75");
    expect(Number(row!.scoreTotal)).toBe(3.75);
    expect(Number(row!.ratioTotal)).toBe(0.75);
  }, 60_000);
});
