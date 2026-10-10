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
import {
  buildExpectedSchema, diff, emit, introspectSqlite, type Change, type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
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
  const r = await new MetaDataLoader().load([new InMemoryStringSource(metaJson)]);
  // The loader collects errors instead of throwing; a refused inline model must not be migrated.
  expect(r.errors).toEqual([]);
  return r.root;
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
const INET_COLUMNS: ReadonlySet<string> = new Set(["inetVal", "inet6Val"]);
const isInetResidue = (c: Change): boolean =>
  c.kind === "change-column-type" && c.table === "all_types" && INET_COLUMNS.has(c.column) && c.to.kind === "inet";

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

/** The same, plus program 3 with no weeks: the row a `@spine` report keeps and a plain one drops. */
const SEED_ROSTER = `${SEED_PROGRAMS_AND_WEEKS};
  INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
    (3, 'Mobility', 1000, 'DRAFT', '2026-06-01T00:00:00')`;

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

  test("CONVERGENCE: the nine canonical views apply, then a second and third migrate propose nothing (the emitter is deterministic)", async () => {
    const views = (await select(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`)).map((r) => r.name);
    for (const v of [
      "v_program_minutes", "v_fitness_totals", "v_programs_by_month",
      "v_programs_by_week", "v_recent_programs", "v_asset_activity",
      "v_program_roster", "v_program_long_weeks", "v_fitness_totals_filled",
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

  // -------------------------------------------------------------------------
  // @spine and @default (FR-044 R8 / R9, plan Tables D and E).
  // -------------------------------------------------------------------------

  test("v_program_roster: a row for program 3, which has no weeks; a default reads 0 where its twin reads null", async () => {
    await applyRaw(SEED_ROSTER);
    expect(await select(`SELECT * FROM "v_program_roster" ORDER BY "programKey"`)).toEqual([
      { programKey: 1, programTitle: "Foundations", weeks: 4, totalMinutes: 240, totalMinutesOrZero: 240,
        longShare: 0.75, longShareOrZero: 0.75 },
      { programKey: 2, programTitle: "Strength", weeks: 1, totalMinutes: 45, totalMinutesOrZero: 45,
        longShare: 0, longShareOrZero: 0 },
      { programKey: 3, programTitle: "Mobility", weeks: 0, totalMinutes: null, totalMinutesOrZero: 0,
        longShare: null, longShareOrZero: 0 },
    ]);
  });

  test("v_program_long_weeks: the report @segment is in the join, so a program whose weeks it scopes out still has a row", async () => {
    await applyRaw(SEED_ROSTER);
    expect(await select(`SELECT * FROM "v_program_long_weeks" ORDER BY "programKey"`)).toEqual([
      { programKey: 1, weeks: 3, totalMinutesOrZero: 210 },
      { programKey: 2, weeks: 0, totalMinutesOrZero: 0 },
      { programKey: 3, weeks: 0, totalMinutesOrZero: 0 },
    ]);
  });

  test("v_fitness_totals_filled: no @spine, a default alone; over an empty weeks table it is (0, 0, 0)", async () => {
    expect(await select(`SELECT count(*) AS n FROM "weeks"`)).toEqual([{ n: 0 }]);
    expect(await select(`SELECT * FROM "v_fitness_totals_filled"`))
      .toEqual([{ weeks: 0, totalMinutesOrZero: 0, longShareOrZero: 0 }]);
    // With rows, the default does not touch the value: it is v_fitness_totals' row.
    await applyRaw(SEED_ROSTER);
    expect(await select(`SELECT * FROM "v_fitness_totals_filled"`))
      .toEqual([{ weeks: 5, totalMinutesOrZero: 285, longShareOrZero: 0.6 }]);
  });

  test("the view has one row per program", async () => {
    await applyRaw(SEED_ROSTER);
    const [programs] = await select(`SELECT count(*) AS n FROM "programs"`);
    expect(programs?.n).toBe(3);
    for (const view of ["v_program_roster", "v_program_long_weeks"]) {
      expect((await select(`SELECT count(*) AS n FROM "${view}"`))[0]?.n).toBe(programs?.n);
    }
    // The plain report over the same rows drops program 3: that is what @spine adds.
    expect((await select(`SELECT count(*) AS n FROM "v_program_minutes"`))[0]?.n).toBe(2);
  });

  test("STORAGE CLASSES: a defaulted ratio is REAL in every row, the defaulted ones included (the 0.0 literal)", async () => {
    await applyRaw(SEED_ROSTER);
    expect(await select(
      `SELECT typeof("totalMinutes") AS "totalMinutes", typeof("totalMinutesOrZero") AS "totalMinutesOrZero",
              typeof("longShare") AS "longShare", typeof("longShareOrZero") AS "longShareOrZero"
         FROM "v_program_roster" ORDER BY "programKey"`,
    )).toEqual([
      { totalMinutes: "integer", totalMinutesOrZero: "integer", longShare: "real", longShareOrZero: "real" },
      { totalMinutes: "integer", totalMinutesOrZero: "integer", longShare: "real", longShareOrZero: "real" },
      { totalMinutes: "null", totalMinutesOrZero: "integer", longShare: "null", longShareOrZero: "real" },
    ]);
    expect(await select(
      `SELECT typeof("totalMinutesOrZero") AS "totalMinutesOrZero" FROM "v_program_long_weeks" ORDER BY "programKey"`,
    )).toEqual([{ totalMinutesOrZero: "integer" }, { totalMinutesOrZero: "integer" }, { totalMinutesOrZero: "integer" }]);
    await applyRaw(`DELETE FROM "weeks"`);
    expect(await select(
      `SELECT typeof("totalMinutesOrZero") AS "totalMinutesOrZero", typeof("longShareOrZero") AS "longShareOrZero"
         FROM "v_fitness_totals_filled"`,
    )).toEqual([{ totalMinutesOrZero: "integer", longShareOrZero: "real" }]);
  });
});

/**
 * The spec's nested average (FR-044 design, R2): `avgDaysPerStarter = daysEngaged / starters`,
 * grouped by program. `daysEngaged` is a distinct count of a tuple, and the tuple has to
 * include the customer: without it the numerator is the number of distinct days ANYONE did,
 * not the sum over customers of the days each did.
 */
function engagementModel(tuple: readonly string[]): string {
  return JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "WorkoutEvent", children: [
      { "source.rdb": { "@table": "workout_events" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId", "@required": true } },
      { "field.string": { name: "customerEmail", "@required": true } },
      { "field.int": { name: "weekNumber", "@required": true } },
      { "field.int": { name: "dayNumber", "@required": true } },
      { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      { "dimension.attribute": { name: "program", "@of": "WorkoutEvent.programId" } },
      { "measure.aggregate": { name: "starters", "@agg": "count", "@distinct": true, "@of": "WorkoutEvent.customerEmail" } },
      { "measure.aggregate": { name: "daysEngaged", "@agg": "count", "@distinct": true, "@of": tuple.map((c) => `WorkoutEvent.${c}`) } },
      { "measure.ratio": { name: "avgDaysPerStarter", "@numerator": "daysEngaged", "@denominator": "starters" } },
    ] } },
    { "object.report": { name: "ProgramEngagement", "@from": "WorkoutEvent", "@dimensions": ["program"],
      "@measures": ["starters", "daysEngaged", "avgDaysPerStarter"], children: [
      { "source.rdb": { "@kind": "view", "@view": "v_program_engagement" } } ] } },
  ]}});
}

/** One customer with three days, two customers who share one day: 5 customer-days, 3 starters. */
const ENGAGEMENT_ROWS = `
  INSERT INTO "workout_events" ("programId","customerEmail","weekNumber","dayNumber") VALUES
    (1, 'a@x.test', 1, 1), (1, 'a@x.test', 1, 2), (1, 'a@x.test', 1, 3),
    (1, 'b@x.test', 1, 1), (1, 'c@x.test', 1, 1),
    (1, 'a@x.test', 1, 1)`;

/** A Fact whose prog reference is NULLABLE, in a `@spine` report grouped by the prog's title. */
const FACT_SPINE_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
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
  { "object.report": { name: "FactsByProg", "@from": "Fact", "@spine": "Fact.fkProg", "@dimensions": ["progTitle"], "@measures": ["facts"], children: [
    { "source.rdb": { "@kind": "view", "@view": "v_facts_by_prog" } } ] } },
]}});

/**
 * Program <- Week, where the week's label is nullable: a `count` and a `sum` scoped to the
 * weeks with NO label, in a `@spine` report. A program with no weeks gets one
 * null-extended row whose `label` is null too, and that row must not be counted.
 */
const UNLABELLED_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Program", children: [
    { "source.rdb": { "@table": "programs" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "title", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
  ] } },
  { "object.entity": { name: "Week", children: [
    { "source.rdb": { "@table": "weeks" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "programId", "@required": true } },
    { "field.string": { name: "label" } },
    { "field.int": { name: "durationMinutes", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
    { "dimension.attribute": { name: "programKey", "@of": "Program.id", "@via": "Week.fkProgram" } },
    { "measure.aggregate": { name: "unlabelled", "@agg": "count", "@of": "Week.id", "@filter": { label: { isNull: true } } } },
    { "measure.aggregate": { name: "unlabelledMinutes", "@agg": "sum", "@of": "Week.durationMinutes", "@filter": { label: { isNull: true } } } },
  ] } },
  { "object.report": { name: "UnlabelledWeeks", "@from": "Week", "@spine": "Week.fkProgram",
    "@dimensions": ["programKey"], "@measures": ["unlabelled", "unlabelledMinutes"], children: [
    { "source.rdb": { "@kind": "view", "@view": "v_unlabelled_weeks" } } ] } },
]}});

/** Program <- Week <- Session, spine `Session.week.program` (plan Table D's two-hop case). */
const SESSION_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Program", children: [
    { "source.rdb": { "@table": "programs" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "title", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
  ] } },
  { "object.entity": { name: "Week", children: [
    { "source.rdb": { "@table": "weeks" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "programId", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "identity.reference": { name: "program", "@fields": "programId", "@references": "Program" } },
  ] } },
  { "object.entity": { name: "Session", children: [
    { "source.rdb": { "@table": "sessions" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "weekId", "@required": true } },
    { "field.int": { name: "minutes", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "identity.reference": { name: "week", "@fields": "weekId", "@references": "Week" } },
    { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Session.week.program" } },
    { "measure.aggregate": { name: "sessions", "@agg": "count", "@of": "Session.id" } },
    { "measure.aggregate": { name: "totalMinutes", "@agg": "sum", "@of": "Session.minutes", "@default": 0 } },
  ] } },
  { "object.report": { name: "SessionsByProgram", "@from": "Session", "@spine": "Session.week.program",
    "@dimensions": ["programTitle"], "@measures": ["sessions", "totalMinutes"], "@filter": { minutes: { gte: 10 } }, children: [
    { "source.rdb": { "@kind": "view", "@view": "v_sessions_by_program" } } ] } },
]}});

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

  /** A tuple distinct count whose two components are both NULLABLE (the canonical model's are required). */
  const PAIR_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
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
  ]}});

  test("NESTED AVERAGE: the tuple includes the customer, so 3 + 1 + 1 customer-days over 3 starters is 5 / 3", async () => {
    const root = await loadInline(engagementModel(["programId", "customerEmail", "weekNumber", "dayNumber"]));
    const { expected } = await migrate(root);
    await assertConverged(expected);
    await applyRaw(ENGAGEMENT_ROWS);
    const [row] = await select(`SELECT * FROM "v_program_engagement"`);
    expect(row).toMatchObject({ program: 1, starters: 3, daysEngaged: 5 });
    expect(row!.avgDaysPerStarter as number).toBeCloseTo(5 / 3, 9);
  });

  test("NESTED AVERAGE, the slip it replaces: a tuple without the customer counts days anyone did, 3 / 3", async () => {
    const root = await loadInline(engagementModel(["programId", "weekNumber", "dayNumber"]));
    const { expected } = await migrate(root);
    await assertConverged(expected);
    await applyRaw(ENGAGEMENT_ROWS);
    const [row] = await select(`SELECT * FROM "v_program_engagement"`);
    expect(row).toMatchObject({ program: 1, starters: 3, daysEngaged: 3, avgDaysPerStarter: 1 });
  });

  test("a tuple with a NULL component is not counted, read through the lowered view", async () => {
    const root = await loadInline(PAIR_MODEL);
    expect(viewSql(root, "v_pair_totals")).toContain(
      `COUNT(DISTINCT CASE WHEN p."a" IS NOT NULL AND p."b" IS NOT NULL THEN json_array(p."a", p."b") END)`,
    );
    const { expected } = await migrate(root);
    await assertConverged(expected);
    // (1,2) twice, (2,1) once, and three rows with a NULL component: two distinct tuples.
    await applyRaw(`
      INSERT INTO "pairs" ("a","b") VALUES
        (1, 2), (1, 2), (2, 1), (1, NULL), (NULL, 3), (NULL, NULL)`);
    expect(await select(`SELECT * FROM "v_pair_totals"`)).toEqual([{ combos: 2 }]);
  });

  test("with @spine a fact whose reference is null is in no row", async () => {
    const root = await loadInline(FACT_SPINE_MODEL);
    expect(viewSql(root, "v_facts_by_prog")).toContain(`FROM "progs"`);
    const { expected } = await migrate(root);
    await assertConverged(expected);

    await applyRaw(`
      INSERT INTO "progs" ("id","title") VALUES (1, 'Alpha');
      INSERT INTO "facts" ("id","progId") VALUES (1, 1), (2, 1), (3, NULL), (4, NULL), (5, NULL)`);
    // One row per prog; the three facts with no prog belong to none of them.
    expect(await select(`SELECT * FROM "v_facts_by_prog" ORDER BY "progTitle"`)).toEqual([
      { progTitle: "Alpha", facts: 2 },
    ]);
  });

  test("an isNull condition does not count the empty row", async () => {
    const root = await loadInline(UNLABELLED_MODEL);
    const { expected } = await migrate(root);
    await assertConverged(expected);

    await applyRaw(`
      INSERT INTO "programs" ("id","title") VALUES (1, 'Foundations'), (2, 'Strength'), (3, 'Mobility');
      INSERT INTO "weeks" ("id","programId","label","durationMinutes") VALUES
        (10, 1, 'Week 1', 30), (11, 1, 'Week 2', 60), (12, 1, 'Week 2', 90), (13, 1, NULL, 60),
        (20, 2, 'Solo', 45)`);
    // Program 3's null-extended row has a null label, and the count still reads 0: it counts
    // the fact's id, which is null there too. The sum of nothing is null (no @default).
    expect(await select(`SELECT * FROM "v_unlabelled_weeks" ORDER BY "programKey"`)).toEqual([
      { programKey: 1, unlabelled: 1, unlabelledMinutes: 60 },
      { programKey: 2, unlabelled: 0, unlabelledMinutes: null },
      { programKey: 3, unlabelled: 0, unlabelledMinutes: null },
    ]);
  });

  test("a two-hop spine: every program has a row, whether it has no weeks or only scoped-out sessions", async () => {
    const root = await loadInline(SESSION_MODEL);
    expect(viewSql(root, "v_sessions_by_program")).toContain([
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  LEFT OUTER JOIN "sessions" s ON w."id" = s."weekId" AND s."minutes" >= 10`,
    ].join("\n"));
    const { expected } = await migrate(root);
    await assertConverged(expected);

    // Alpha: two weeks, sessions of 30 and 5 minutes in the first (the 5 is scoped out) and
    // none in the second. Beta: a week whose only session is scoped out. Gamma: no weeks.
    await applyRaw(`
      INSERT INTO "programs" ("id","title") VALUES (1, 'Alpha'), (2, 'Beta'), (3, 'Gamma');
      INSERT INTO "weeks" ("id","programId") VALUES (10, 1), (11, 1), (20, 2);
      INSERT INTO "sessions" ("id","weekId","minutes") VALUES (100, 10, 30), (101, 10, 5), (200, 20, 9)`);
    expect(await select(`SELECT * FROM "v_sessions_by_program" ORDER BY "programTitle"`)).toEqual([
      { programTitle: "Alpha", sessions: 1, totalMinutes: 30 },
      { programTitle: "Beta", sessions: 0, totalMinutes: 0 },
      { programTitle: "Gamma", sessions: 0, totalMinutes: 0 },
    ]);
  });

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
