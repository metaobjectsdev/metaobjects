/**
 * Report views — FR-044 Plan 2, against a REAL MySQL 8.4.
 *
 * `meta migrate` does not own a MySQL schema (ADR-0015; `--dialect mysql` is refused), so
 * there is no convergence gate here. What ships for MySQL is the SQL:
 * `buildReportViews(root, { dialect: "mysql" })` returns each view-backed report's body for
 * the adopter to put in their own DDL (docs/recipes/mysql.md, "Reports"). This file proves
 * that SQL is ACCEPTED and RIGHT:
 *
 *   - every canonical view is created under the server's DEFAULT `sql_mode`, which includes
 *     ONLY_FULL_GROUP_BY (the mode the view bodies must satisfy; nothing here relaxes it);
 *   - the rows are the ones the shared Task 10 persistence scenarios assert, read with raw
 *     SQL straight off the views, so a wrong value is a LOWERING defect;
 *   - Review Focus 5: MySQL divides to four fractional digits, so 2/3 is `0.6667` (Postgres
 *     is `0.66666666666666666667`, SQLite `0.6666666666666666`). Pinned so the documented
 *     behaviour cannot drift unnoticed;
 *   - the view's column types follow contract Table B (`CAST(SUM(...) AS SIGNED)` is BIGINT);
 *   - the Table D grain expressions and the Table E relative-date expressions return the
 *     documented values.
 *
 * `DATETIME(3)` holds the UTC wall clock, so the relative-date seeds are written from
 * `UTC_TIMESTAMP(3)`. Values are read with `dateStrings` and `bigNumberStrings` so nothing is
 * reshaped by the driver: BIGINT, DECIMAL, DATE and DATETIME arrive as the text MySQL sent;
 * only INT (the min/max of an int column) is a number.
 *
 * Requires Docker (or METAOBJECTS_TEST_MYSQL_URL).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import mysql from "mysql2/promise";
import { buildReportViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, loadDirectory, type MetaRoot } from "@metaobjectsdev/metadata";
import { startMysql, type MysqlContainerHandle } from "../src/mysql-container.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

let container: MysqlContainerHandle;
let conn: mysql.Connection;
let canonical: MetaRoot;

const CANONICAL_VIEWS = [
  "v_program_minutes", "v_fitness_totals", "v_programs_by_month",
  "v_programs_by_week", "v_recent_programs", "v_asset_activity",
];

/** The adopter's hand-written DDL (MySQL schema is not MetaObjects'). */
const DDL = [
  `CREATE TABLE programs (
     id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
     title VARCHAR(200) NOT NULL,
     priceCents BIGINT NOT NULL,
     status VARCHAR(9) NOT NULL,
     created_ts DATETIME(3) NOT NULL
   )`,
  `CREATE TABLE weeks (
     id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
     programId BIGINT NOT NULL,
     label VARCHAR(80),
     durationMinutes INT NOT NULL,
     FOREIGN KEY (programId) REFERENCES programs (id)
   )`,
  `CREATE TABLE assets (
     id VARCHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
     ownerId VARCHAR(36) NOT NULL,
     recordedAt DATETIME(3) NOT NULL,
     observedAt DATETIME(3) NOT NULL,
     asOfDate DATE NOT NULL,
     atTime TIME(3) NOT NULL
   )`,
];

async function loadInline(metaJson: string): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(metaJson)]);
  // The loader collects errors instead of throwing; a refused inline model must not reach MySQL.
  expect(r.errors).toEqual([]);
  return r.root;
}

function reportViews(root: MetaRoot) {
  return buildReportViews(root, { dialect: "mysql", columnNamingStrategy: "literal" });
}

/** `CREATE VIEW` for every report view of `root`, exactly as the recipe shows. */
async function createViews(root: MetaRoot): Promise<string[]> {
  const views = reportViews(root);
  for (const v of views) {
    await conn.query(`DROP VIEW IF EXISTS \`${v.name}\``);
    await conn.query(`CREATE VIEW \`${v.name}\` AS\n${v.sql}`);
  }
  return views.map((v) => v.name);
}

async function select(query: string): Promise<Record<string, unknown>[]> {
  const [rows] = await conn.query(query);
  return rows as Record<string, unknown>[];
}

const SEED_PROGRAMS_AND_WEEKS = `
  INSERT INTO programs (id, title, priceCents, status, created_ts) VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00');
  INSERT INTO weeks (id, programId, label, durationMinutes) VALUES
    (10, 1, 'Week 1', 30),
    (11, 1, 'Week 2', 60),
    (12, 1, 'Week 2', 90),
    (13, 1, NULL, 60),
    (20, 2, 'Solo', 45);`;

const SEED_PROGRAMS_BY_TIME = `
  INSERT INTO programs (id, title, priceCents, status, created_ts) VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00'),
    (3, 'Mobility', 1000, 'DRAFT', '2026-06-01T00:00:00'),
    (4, 'Legacy', 700, 'ARCHIVED', '2026-05-31T23:59:59'),
    (5, 'Monday', 300, 'PUBLISHED', '2026-05-18T00:00:00');`;

const SEED_ASSETS = `
  INSERT INTO assets (ownerId, recordedAt, observedAt, asOfDate, atTime) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-05-04T03:30:00', '2026-05-04T03:30:00', '2026-05-03', '03:30:00'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-05-04T03:45:00', '2026-05-04T03:45:00', '2026-05-03', '03:45:00'),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-05-04T04:10:00', '2026-05-04T04:10:00', '2026-05-04', '04:10:00');`;

/** Seed scripts hold several statements; the connection runs one at a time. */
async function exec(script: string): Promise<void> {
  for (const stmt of script.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await conn.query(stmt.endsWith(";") ? stmt.slice(0, -1) : stmt);
  }
}

// ---------------------------------------------------------------------------------
// Inline models: the Table D grains and the Table E durations the canonical corpus does
// not exercise (it has no quarter or year grain and only `-P30D`).
// ---------------------------------------------------------------------------------

/** One report with EVERY grain over a timestamp, grouped by all of them (one row per instant). */
const GRAIN_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Event", children: [
    { "source.rdb": { "@table": "events" } },
    { "field.long": { name: "id" } },
    { "field.timestamp": { name: "recordedAt", "@required": true } },
    { "field.date": { name: "happenedOn", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "dimension.time": { name: "recordedAt", "@of": "Event.recordedAt",
        "@grains": ["hour", "day", "week", "month", "quarter", "year"] } },
    { "dimension.time": { name: "happenedOn", "@of": "Event.happenedOn", "@grains": ["week", "quarter"] } },
    { "measure.aggregate": { name: "events", "@agg": "count", "@of": "Event.id" } },
  ] } },
  { "object.report": { name: "EventsByGrain", "@from": "Event",
    "@dimensions": ["recordedAt:hour", "recordedAt:day", "recordedAt:week", "recordedAt:month",
      "recordedAt:quarter", "recordedAt:year", "happenedOn:week", "happenedOn:quarter"],
    "@measures": ["events"], children: [
      { "source.rdb": { "@kind": "view", "@view": "v_events_by_grain" } } ] } },
]}});

/** Three windows, one per Table E branch: an instant duration, a date duration, a forward one. */
const RELATIVE_MODEL = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Event", children: [
    { "source.rdb": { "@table": "events" } },
    { "field.long": { name: "id" } },
    { "field.timestamp": { name: "recordedAt", "@required": true } },
    { "field.date": { name: "happenedOn", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "measure.aggregate": { name: "events", "@agg": "count", "@of": "Event.id" } },
  ] } },
  { "object.report": { name: "LastTwelveHours", "@from": "Event", "@measures": ["events"],
    "@filter": { recordedAt: { gte: { now: "-PT12H" } } }, children: [
      { "source.rdb": { "@kind": "view", "@view": "v_last_twelve_hours" } } ] } },
  { "object.report": { name: "LastTwoWeeks", "@from": "Event", "@measures": ["events"],
    "@filter": { happenedOn: { gte: { now: "-P2W" } } }, children: [
      { "source.rdb": { "@kind": "view", "@view": "v_last_two_weeks" } } ] } },
  { "object.report": { name: "UpToTomorrow", "@from": "Event", "@measures": ["events"],
    "@filter": { recordedAt: { lte: { now: "P1DT1H" } } }, children: [
      { "source.rdb": { "@kind": "view", "@view": "v_up_to_tomorrow" } } ] } },
]}});

/** Every view and table this file creates: the canonical six, the inline models' and the recipe's. */
const OWN_VIEWS = [
  ...CANONICAL_VIEWS,
  "v_events_by_grain", "v_last_twelve_hours", "v_last_two_weeks", "v_up_to_tomorrow",
  "v_program_minutes_recipe",
] as const;
const OWN_TABLES = ["weeks", "programs", "assets", "events"] as const;

beforeAll(async () => {
  container = await startMysql();
  conn = await mysql.createConnection({
    uri: container.url,
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  // Idempotent: a rerun against a persistent METAOBJECTS_TEST_MYSQL_URL starts clean, and
  // every test below is independent of test order (or of `-t` selecting one of them).
  // Only the views and tables THIS file creates, by name: METAOBJECTS_TEST_MYSQL_URL may point
  // at a shared database, and sweeping information_schema would drop somebody else's views.
  for (const v of OWN_VIEWS) await conn.query(`DROP VIEW IF EXISTS \`${v}\``);
  for (const t of OWN_TABLES) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
  for (const ddl of DDL) await conn.query(ddl);
  canonical = await loadMetadataDir(CANONICAL_DIR);
  await createViews(canonical);
}, 240_000);

afterAll(async () => {
  await conn?.end();
  container?.stop();
}, 60_000);

beforeEach(async () => {
  await conn.query("DELETE FROM weeks");
  await conn.query("DELETE FROM programs");
  await conn.query("DELETE FROM assets");
});

describe("report views — canonical model on real MySQL 8.4", () => {
  test("every canonical view is accepted under the server's default sql_mode (ONLY_FULL_GROUP_BY)", async () => {
    // Assert the mode rather than assume it: the whole claim is "valid under the default".
    const [mode] = await select(`SELECT @@GLOBAL.sql_mode AS g, @@SESSION.sql_mode AS s`);
    expect(String(mode?.g)).toContain("ONLY_FULL_GROUP_BY");
    expect(String(mode?.s)).toContain("ONLY_FULL_GROUP_BY");

    // Re-create them here, under the mode just asserted, so this test does not lean on beforeAll.
    const names = await createViews(canonical);
    expect([...names].sort()).toEqual([...CANONICAL_VIEWS].sort());
    for (const name of names) {
      // Selecting proves the stored body still resolves, not merely that it parsed.
      await select(`SELECT * FROM \`${name}\``);
    }
    const created = await select(
      `SELECT table_name AS n FROM information_schema.views WHERE table_schema = DATABASE() ORDER BY table_name`,
    );
    // The inline-model tests below add views of their own, so assert inclusion, not equality.
    expect(created.map((r) => r.n)).toEqual(expect.arrayContaining([...CANONICAL_VIEWS]));
  }, 60_000);

  describe("values", () => {
    test("v_program_minutes: every measure kind, one row per (program, programTitle); longShare 0.7500 and 0.0000", async () => {
      await exec(SEED_PROGRAMS_AND_WEEKS);
      const rows = await select("SELECT * FROM `v_program_minutes` ORDER BY `program`");
      expect(rows).toEqual([
        { program: "1", programTitle: "Foundations", weeks: "4", longWeeks: "3", labels: "2", slots: "3",
          totalMinutes: "240", avgMinutes: "60.0000", minMinutes: 30, maxMinutes: 90, longShare: "0.7500" },
        { program: "2", programTitle: "Strength", weeks: "1", longWeeks: "0", labels: "1", slots: "1",
          totalMinutes: "45", avgMinutes: "45.0000", minMinutes: 45, maxMinutes: 45, longShare: "0.0000" },
      ]);

      // The measure filter, sort and count the shared scenario runs through the view.
      expect((await select("SELECT `program` FROM `v_program_minutes` WHERE `weeks` >= 2 ORDER BY `program`")).map((r) => r.program))
        .toEqual(["1"]);
      expect((await select("SELECT `program` FROM `v_program_minutes` ORDER BY `totalMinutes` DESC LIMIT 1")).map((r) => r.program))
        .toEqual(["1"]);
      expect((await select("SELECT count(*) AS n FROM `v_program_minutes`"))[0]?.n).toBe("2");
    });

    test("REVIEW FOCUS 5: a ratio of 2/3 is 0.6667 on MySQL (four fractional digits, not Postgres' 20)", async () => {
      await exec(`
        INSERT INTO programs (id, title, priceCents, status, created_ts) VALUES
          (1, 'Thirds', 100, 'PUBLISHED', '2026-05-01T10:00:00');
        INSERT INTO weeks (programId, label, durationMinutes) VALUES
          (1, 'a', 30), (1, 'b', 60), (1, 'c', 90);`);
      // Two of three weeks are >= 60 minutes.
      expect((await select("SELECT `longShare` FROM `v_program_minutes`"))[0]?.longShare).toBe("0.6667");
      expect((await select("SELECT `longShare` FROM `v_fitness_totals`"))[0]?.longShare).toBe("0.6667");
    });

    test("v_fitness_totals: no dimensions, one row over the whole table", async () => {
      await exec(SEED_PROGRAMS_AND_WEEKS);
      expect(await select("SELECT * FROM `v_fitness_totals`"))
        .toEqual([{ weeks: "5", totalMinutes: "285", longShare: "0.6000" }]);
    });

    test("EMPTY GROUPS (Review Focus 4): v_fitness_totals over an empty weeks table is one row (0, NULL, NULL)", async () => {
      expect((await select("SELECT count(*) AS n FROM weeks"))[0]?.n).toBe("0");
      expect(await select("SELECT * FROM `v_fitness_totals`"))
        .toEqual([{ weeks: "0", totalMinutes: null, longShare: null }]);
    });

    test("COLUMN TYPES: totalMinutes is bigint (CAST ... AS SIGNED); counts are bigint, avg and ratio decimal, min/max keep the field's int", async () => {
      const cols = await select(
        `SELECT column_name AS c, data_type AS t FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'v_program_minutes' ORDER BY ordinal_position`,
      );
      expect(Object.fromEntries(cols.map((r) => [r.c, r.t]))).toEqual({
        program: "bigint", programTitle: "varchar",
        weeks: "bigint", longWeeks: "bigint", labels: "bigint", slots: "bigint",
        totalMinutes: "bigint", avgMinutes: "decimal", minMinutes: "int", maxMinutes: "int", longShare: "decimal",
      });
      // A bare SUM(int) would be decimal(32,0); the cast is what makes it bigint.
      const fitness = await select(
        `SELECT data_type AS t FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'v_fitness_totals' AND column_name = 'totalMinutes'`,
      );
      expect(fitness[0]?.t).toBe("bigint");
    });

    test("v_programs_by_month and v_programs_by_week: month grain, enum dimension, null filtered sum, ISO Monday boundary, report @segment", async () => {
      await exec(SEED_PROGRAMS_BY_TIME);

      expect(await select("SELECT * FROM `v_programs_by_month` ORDER BY `status`")).toEqual([
        { createdAtMonth: "2026-05-01", status: "ARCHIVED", programs: "1", listValue: null },
        { createdAtMonth: "2026-06-01", status: "DRAFT", programs: "1", listValue: null },
        { createdAtMonth: "2026-05-01", status: "PUBLISHED", programs: "3", listValue: "7799" },
      ]);

      // Program 2 (Sunday 23:30) and program 5 (Monday 00:00) are thirty minutes apart and
      // land in different weeks; DRAFT / ARCHIVED are scoped out by the segment.
      expect(await select("SELECT * FROM `v_programs_by_week` ORDER BY `createdAtWeek`")).toEqual([
        { createdAtWeek: "2026-04-27", programs: "1" },
        { createdAtWeek: "2026-05-11", programs: "1" },
        { createdAtWeek: "2026-05-18", programs: "1" },
      ]);
    });

    test("v_asset_activity: hour on a timestamp, week on a field.date", async () => {
      await exec(SEED_ASSETS);
      expect(await select("SELECT * FROM `v_asset_activity` ORDER BY `recordedAtHour`")).toEqual([
        { recordedAtHour: "2026-05-04 03:00:00.000", asOfDateWeek: "2026-04-27", assets: "2" },
        { recordedAtHour: "2026-05-04 04:00:00.000", asOfDateWeek: "2026-05-04", assets: "1" },
      ]);
      // The hour bucket is a DATETIME(3), so it compares with a stored instant.
      const t = await select(
        `SELECT data_type AS t, datetime_precision AS p FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'v_asset_activity' AND column_name = 'recordedAtHour'`,
      );
      expect(t[0]).toEqual({ t: "datetime", p: 3 });
    });

    test("RELATIVE WINDOW: v_recent_programs counts the program 3 days old, not the one 60 days old", async () => {
      await exec(`
        INSERT INTO programs (id, title, priceCents, status, created_ts) VALUES
          (1, 'Recent', 100, 'PUBLISHED', UTC_TIMESTAMP(3) - INTERVAL 3 DAY),
          (2, 'Stale', 100, 'PUBLISHED', UTC_TIMESTAMP(3) - INTERVAL 60 DAY);`);
      expect(await select("SELECT * FROM `v_recent_programs`")).toEqual([{ programs: "1" }]);
    });
  });
});

describe("report views — inline models on real MySQL 8.4", () => {
  test("TABLE D: hour, day, week, month, quarter and year grains, on a timestamp and on a date", async () => {
    await conn.query("DROP TABLE IF EXISTS events");
    await conn.query(
      `CREATE TABLE events (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, recordedAt DATETIME(3) NOT NULL, happenedOn DATE NOT NULL)`,
    );
    const root = await loadInline(GRAIN_MODEL);
    const names = await createViews(root);
    expect(names).toEqual(["v_events_by_grain"]);

    await exec(`
      INSERT INTO events (recordedAt, happenedOn) VALUES
        ('2026-05-01T10:15:00', '2026-05-01'),
        ('2026-05-17T23:30:00', '2026-05-17'),
        ('2026-06-01T00:00:00', '2026-06-01'),
        ('2026-01-01T00:00:00', '2026-01-01'),
        ('2026-07-01T05:05:05', '2026-07-01'),
        ('2026-12-31T23:59:59', '2026-12-31');`);

    const grain = (hour: string, day: string, week: string, month: string, quarter: string, year: string,
      dWeek: string, dQuarter: string) => ({
      recordedAtHour: hour, recordedAtDay: day, recordedAtWeek: week, recordedAtMonth: month,
      recordedAtQuarter: quarter, recordedAtYear: year,
      happenedOnWeek: dWeek, happenedOnQuarter: dQuarter, events: "1",
    });
    expect(await select("SELECT * FROM `v_events_by_grain` ORDER BY `recordedAtHour`")).toEqual([
      // 2026-01-01 is a Thursday: ISO week starts Monday 2025-12-29, in the previous year.
      grain("2026-01-01 00:00:00.000", "2026-01-01", "2025-12-29", "2026-01-01", "2026-01-01", "2026-01-01", "2025-12-29", "2026-01-01"),
      // Contract Table D checked values: day, week, month, quarter, year of 2026-05-01T10:00.
      grain("2026-05-01 10:00:00.000", "2026-05-01", "2026-04-27", "2026-05-01", "2026-04-01", "2026-01-01", "2026-04-27", "2026-04-01"),
      // A Sunday at 23:30 is still the week of Monday 2026-05-11.
      grain("2026-05-17 23:00:00.000", "2026-05-17", "2026-05-11", "2026-05-01", "2026-04-01", "2026-01-01", "2026-05-11", "2026-04-01"),
      // A Monday midnight starts its own week.
      grain("2026-06-01 00:00:00.000", "2026-06-01", "2026-06-01", "2026-06-01", "2026-04-01", "2026-01-01", "2026-06-01", "2026-04-01"),
      grain("2026-07-01 05:00:00.000", "2026-07-01", "2026-06-29", "2026-07-01", "2026-07-01", "2026-01-01", "2026-06-29", "2026-07-01"),
      grain("2026-12-31 23:00:00.000", "2026-12-31", "2026-12-28", "2026-12-01", "2026-10-01", "2026-01-01", "2026-12-28", "2026-10-01"),
    ]);

    // The grain's column types (Table B): hour is a DATETIME(3), every other grain a DATE.
    const cols = await select(
      `SELECT column_name AS c, data_type AS t FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'v_events_by_grain' AND column_name <> 'events'`,
    );
    for (const r of cols) expect(r.t).toBe(r.c === "recordedAtHour" ? "datetime" : "date");
  }, 60_000);

  test("TABLE E: relative-date windows read the UTC wall clock (an instant, a date, a forward duration)", async () => {
    await conn.query("DROP TABLE IF EXISTS events");
    await conn.query(
      `CREATE TABLE events (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, recordedAt DATETIME(3) NOT NULL, happenedOn DATE NOT NULL)`,
    );
    const root = await loadInline(RELATIVE_MODEL);
    expect((await createViews(root)).sort()).toEqual(["v_last_twelve_hours", "v_last_two_weeks", "v_up_to_tomorrow"]);

    // Clock-relative on purpose: the view calls UTC_TIMESTAMP(3) when it is QUERIED.
    await exec(`
      INSERT INTO events (recordedAt, happenedOn) VALUES
        (UTC_TIMESTAMP(3) - INTERVAL 1 HOUR, DATE(UTC_TIMESTAMP(3) - INTERVAL 1 DAY)),
        (UTC_TIMESTAMP(3) - INTERVAL 11 HOUR, DATE(UTC_TIMESTAMP(3) - INTERVAL 13 DAY)),
        (UTC_TIMESTAMP(3) - INTERVAL 13 HOUR, DATE(UTC_TIMESTAMP(3) - INTERVAL 15 DAY)),
        (UTC_TIMESTAMP(3) + INTERVAL 1 HOUR,  DATE(UTC_TIMESTAMP(3) - INTERVAL 40 DAY)),
        (UTC_TIMESTAMP(3) + INTERVAL 3 DAY,   DATE(UTC_TIMESTAMP(3) - INTERVAL 60 DAY));`);

    // gte -PT12H: only the 13h-old instant is out (1h and 11h ago, and both future rows, are in).
    expect(await select("SELECT * FROM `v_last_twelve_hours`")).toEqual([{ events: "4" }]);
    // -P2W is 14 days, applied to the date: 1 and 13 days ago are in, 15, 40 and 60 are out.
    expect(await select("SELECT * FROM `v_last_two_weeks`")).toEqual([{ events: "2" }]);
    // P1DT1H forward: everything up to a day and an hour ahead; the 3-days-ahead row is out.
    expect(await select("SELECT * FROM `v_up_to_tomorrow`")).toEqual([{ events: "4" }]);
  }, 60_000);
});

describe("the recipe's declaration and script", () => {
  /** The first fenced `json` block under "### Reports" in docs/recipes/mysql.md. */
  function recipeDeclaration(): string {
    const doc = readFileSync(join(REPO_ROOT, "docs/recipes/mysql.md"), "utf8");
    const section = doc.slice(doc.indexOf("### Reports"));
    const m = /```json\n([\s\S]*?)\n```/.exec(section);
    if (m === null) throw new Error("docs/recipes/mysql.md has no json block under '### Reports'");
    return m[1]!;
  }

  /** A model whose one report carries `sourceJson` as its source, written where `loadDirectory` reads it. */
  function modelDir(sourceJson: string): string {
    const dir = mkdtempSync(join(tmpdir(), "report-recipe-"));
    const source = JSON.parse(sourceJson) as Record<string, unknown>;
    writeFileSync(join(dir, "meta.fitness.json"), JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Week", children: [
        { "source.rdb": { "@table": "weeks" } },
        { "field.long": { name: "id" } },
        { "field.int": { name: "durationMinutes", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
        { "measure.aggregate": { name: "weeks", "@agg": "count", "@of": "Week.id" } },
      ] } },
      { "object.report": { name: "ProgramMinutes", "@from": "Week", "@measures": ["weeks"], children: [source] } },
    ]}}));
    return dir;
  }

  /** The recipe's script, minus the console.log. */
  async function recipeViews(sourceJson: string) {
    const dir = modelDir(sourceJson);
    try {
      const { root } = await loadDirectory(dir);
      return buildReportViews(root, { dialect: "mysql" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("the declaration the recipe shows yields exactly one view, and MySQL accepts its body", async () => {
    const declaration = recipeDeclaration();
    expect(declaration).not.toContain("@unmanaged");
    const views = await recipeViews(declaration);
    expect(views.map((v) => v.name)).toEqual(["v_program_minutes"]);

    // The body is built over the default snake_case column names; the recipe's own `weeks`
    // table has `id`, so it resolves as it stands.
    await conn.query("DROP VIEW IF EXISTS `v_program_minutes_recipe`");
    await conn.query(`CREATE VIEW \`v_program_minutes_recipe\` AS\n${views[0]!.sql}`);
    await exec(`
      INSERT INTO programs (id, title, priceCents, status, created_ts) VALUES (1, 'P', 1, 'DRAFT', '2026-05-01T10:00:00');
      INSERT INTO weeks (programId, label, durationMinutes) VALUES (1, 'a', 30), (1, 'b', 45);`);
    expect(await select("SELECT * FROM `v_program_minutes_recipe`")).toEqual([{ weeks: "2" }]);
    await conn.query("DROP VIEW `v_program_minutes_recipe`");
  }, 60_000);

  test("the same declaration with @unmanaged: true yields no view: buildReportViews skips an unmanaged source", async () => {
    const unmanaged = JSON.parse(recipeDeclaration()) as { "source.rdb": Record<string, unknown> };
    unmanaged["source.rdb"]["@unmanaged"] = true;
    expect(await recipeViews(JSON.stringify(unmanaged))).toEqual([]);
  });
});
