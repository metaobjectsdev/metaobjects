/**
 * The cube-model live check on MySQL — the Cube MySQL path executed, not just golden-compared.
 *
 * cube-model.live.ts runs the canonical model against Postgres. The exporter's MySQL output
 * (backtick-quoted identifiers, `UTC_TIMESTAMP(3)`, `DATE_SUB(... WEEKDAY ...)` week buckets,
 * `COUNT(DISTINCT a, b)`) was otherwise only compared with goldens and compiled through `/v1/meta`,
 * which runs no SQL. This file closes that: it starts the same pinned Cube over a private MySQL 8.4
 * holding `fixtures/persistence-conformance/canonical/schema.mysql.sql` (the hand-DDL tables and
 * the `buildReportViews` mysql views) plus `fixtures/cube-model/canonical/seed.mysql.sql`, and:
 *
 *   1. generates the canonical model with `cubeModel()` for the mysql dialect and requires Cube to
 *      compile it and to list every served report's cube;
 *   2. for each served report, builds the Cube query Table F says reproduces it, runs it on MySQL
 *      through Cube, and compares the rows with `SELECT * FROM <view>` under the same
 *      normalization the Postgres check uses.
 *
 * Cube answers each report from the same rollup it does on Postgres (Table I's column), so the
 * rollup build and read SQL Cube writes for MySQL runs too, not only the source-table SQL.
 *
 * `*.live.ts`: runs only by its path, from `bun run test:cube`. Without docker every test is
 * SKIPPED behind a banner.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cubeModel, defineConfig, runGen, servedReport } from "@metaobjectsdev/codegen-ts";
import { reportReadSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  CUBE_IMAGE,
  CUBE_MYSQL_IMAGE,
  cubeStackStartBudgetMs,
  dockerUnavailableReason,
  startCubeStack,
  type CubeStack,
} from "../src/cube-container.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";
import { readCanonicalMysqlSchemaSql } from "../src/canonical-schema-mysql.ts";
import { cubeQueryFor, fromCubeRow, fromViewRow, getMeta, load, sortRows } from "./cube-live-support.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CANONICAL_MODEL = join(CANONICAL_DIR, "meta.fitness.json");
const CANONICAL_SEED = join(REPO_ROOT, "fixtures", "cube-model", "canonical", "seed.mysql.sql");
const GEN_CONFIG = { dialect: "mysql", columnNamingStrategy: "literal" } as const;
const TEST_TIMEOUT_MS = 600_000;

/**
 * Each served canonical report, its view, the rollup Cube answers from (the same table Table I
 * names on Postgres; undefined = the source tables) and its row count on seed.mysql.sql.
 */
const REPORTS: readonly { readonly report: string; readonly view: string; readonly preAggregation: string | undefined; readonly rows: number }[] = [
  { report: "ProgramMinutes", view: "v_program_minutes", preAggregation: "dev_pre_aggregations.week__program_minutes", rows: 3 },
  { report: "FitnessTotals", view: "v_fitness_totals", preAggregation: "dev_pre_aggregations.week__fitness_totals", rows: 1 },
  { report: "ProgramsByMonth", view: "v_programs_by_month", preAggregation: "dev_pre_aggregations.program__programs_by_month", rows: 5 },
  { report: "ProgramsByWeek", view: "v_programs_by_week", preAggregation: "dev_pre_aggregations.program__programs_by_week", rows: 5 },
  { report: "RecentPrograms", view: "v_recent_programs", preAggregation: undefined, rows: 1 },
  { report: "AssetActivity", view: "v_asset_activity", preAggregation: "dev_pre_aggregations.asset__asset_activity", rows: 2 },
  { report: "ProgramRoster", view: "v_program_roster", preAggregation: undefined, rows: 7 },
  { report: "ProgramLongWeeks", view: "v_program_long_weeks", preAggregation: undefined, rows: 7 },
  { report: "FitnessTotalsFilled", view: "v_fitness_totals_filled", preAggregation: "dev_pre_aggregations.week__fitness_totals_filled", rows: 1 },
];

const unavailable = dockerUnavailableReason();
if (unavailable !== undefined) {
  const bar = "!".repeat(78);
  console.warn(
    `\n${bar}\n!! CUBE MYSQL LIVE CHECK SKIPPED: docker unavailable (${unavailable})\n` +
      `!! Nothing was checked against ${CUBE_IMAGE} on ${CUBE_MYSQL_IMAGE}. Every test in this file reports SKIP.\n${bar}\n`,
  );
}
const skip = unavailable !== undefined;

let work = "";
let stack: CubeStack | undefined;
let canonical: MetaRoot | undefined;
const timings: string[] = [];

beforeAll(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), "mo-cube-mysql-live-"));
  process.on("exit", cleanUp);
  try {
    canonical = await loadMetadataFile(CANONICAL_MODEL);
    const outDir = join(work, "out");
    await runGen({
      config: defineConfig({ outDir, ...GEN_CONFIG, generators: [cubeModel()] }),
      metadata: canonical,
      genStateDir: join(work, ".gen-state"),
    });
    const t0 = Date.now();
    const started = await startCubeStack(join(outDir, "model"), {
      dataSource: "mysql",
      initSql: [readCanonicalMysqlSchemaSql(), readFileSync(CANONICAL_SEED, "utf8")],
    });
    if (started.kind === "skipped") throw new Error(`docker answered a moment ago and no longer does: ${started.reason}`);
    stack = started.stack;
    timings.push(`stack up (MySQL + schema + seed, Cube /meta): ${Date.now() - t0} ms`);
  } catch (e) {
    cleanUp();
    throw e;
  }
}, cubeStackStartBudgetMs() + 120_000);

afterAll(() => {
  cleanUp();
  process.off("exit", cleanUp);
  if (timings.length > 0) console.log(`cube mysql live check timings:\n  ${timings.join("\n  ")}`);
}, 180_000);

function cleanUp(): void {
  stack?.stop();
  stack = undefined;
  if (work !== "") rmSync(work, { recursive: true, force: true });
}

function requireStack(): CubeStack {
  if (stack === undefined) throw new Error("the cube stack did not start (see beforeAll)");
  return stack;
}

function requireCanonical(): MetaRoot {
  if (canonical === undefined) throw new Error("the canonical model did not load (see beforeAll)");
  return canonical;
}

function findReport(name: string): MetaObject {
  const report = requireCanonical().objects().find((o) => servedReport(o) && o.name === name);
  if (report === undefined) throw new Error(`the canonical model serves no report '${name}'`);
  return report;
}

/**
 * `SELECT * FROM <view>` through the mysql client, every value as the text MySQL prints for it. A
 * DATETIME prints `2026-05-04 03:30:00.000`; the space becomes `T` so the shared normalization
 * reads it as a UTC instant, as it does Cube's `2026-05-04T03:30:00.000`.
 */
function selectView(s: CubeStack, view: string): Array<Record<string, string | null>> {
  const columns = s.mysql(`SHOW COLUMNS FROM \`${view}\`;`).trim().split("\n").map((l) => l.split("\t")[0] ?? "");
  const out = s.mysql(`SET time_zone = '+00:00'; SELECT ${columns.map((c) => `\`${c}\``).join(", ")} FROM \`${view}\`;`);
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((line) => {
      const cells = line.split("\t");
      const row: Record<string, string | null> = {};
      columns.forEach((c, i) => {
        const v = cells[i] ?? "NULL";
        row[c] = v === "NULL" ? null : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v) ? v.replace(" ", "T") : v;
      });
      return row;
    });
}

describe(`cube-model MySQL live check (${CUBE_IMAGE} over ${CUBE_MYSQL_IMAGE}, development mode)`, () => {
  test.skipIf(skip)("Table coverage: the reports below are exactly the canonical model's served reports", () => {
    const served = requireCanonical().objects().filter(servedReport).map((r) => r.name).sort();
    expect(served).toEqual(REPORTS.map((e) => e.report).sort());
    for (const want of REPORTS) expect(reportReadSource(findReport(want.report))?.physicalName).toBe(want.view);
  });

  test.skipIf(skip)("Cube compiles the MySQL model and lists the cubes over the three tables the reports read", async () => {
    const meta = await getMeta(requireStack());
    expect(meta.error).toBeUndefined();
    const names = new Set(meta.cubes.map((c) => c.name));
    for (const cube of ["Program", "Week", "Asset"]) expect(names.has(cube)).toBe(true);
  }, TEST_TIMEOUT_MS);

  for (const want of REPORTS) {
    test.skipIf(skip)(`${want.report}: the Table F query runs on MySQL and equals ${want.view}`, async () => {
      const s = requireStack();
      const plan = cubeQueryFor(findReport(want.report), requireCanonical());
      const t0 = Date.now();
      const result = await load(s, plan.query);
      const used = Object.keys(result.usedPreAggregations ?? {}).sort();
      const cubeRows = sortRows(result.data.map((row) => fromCubeRow(row, plan)), plan);
      const viewRows = sortRows(selectView(s, want.view).map((row) => fromViewRow(row, plan, want.view)), plan);
      timings.push(`${want.report}: ${cubeRows.length} row(s) compared, served from ${used[0] ?? "the source table"}, load ${Date.now() - t0} ms`);
      expect(viewRows.length).toBe(want.rows);
      expect(cubeRows).toEqual(viewRows);
      expect(used).toEqual(want.preAggregation === undefined ? [] : [want.preAggregation]);
    }, TEST_TIMEOUT_MS);
  }
});
