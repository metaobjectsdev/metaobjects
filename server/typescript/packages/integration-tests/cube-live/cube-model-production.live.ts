/**
 * The cube-model live check in Cube's PRODUCTION mode — the gate cube-model.live.ts (development
 * mode) cannot be: there the rollups are built in the data source's own schema, on demand, and Cube
 * runs without auth. Production mode is what an adopter deploys, and it differs in every way that
 * matters to a rollup:
 *
 *   * `CUBEJS_DEV_MODE=false`: every request carries a signed JWT;
 *   * rollups live in a real Cube Store (`cubejs/cubestore`, the Cube image's version), so a query
 *     answered from one reports `external: true` under `prod_pre_aggregations`;
 *   * a rollup answers only once it is BUILT. The lane builds every one through the
 *     pre-aggregations jobs API and waits for each job to be `done` before it queries.
 *
 * For each dialect (Postgres, then MySQL) it generates the canonical model with `cubeModel()`,
 * starts the stack, builds the rollups, and then, for every served report:
 *
 *   * runs the Table F query and requires the rows to equal `SELECT *` from the report's view and
 *     the answer to come FROM the report's rollup (`usedPreAggregations` names it and says
 *     `external: true`) — or from the source table when the report has no rollup;
 *   * for a report that lists a time dimension at several grains (one rollup per grain), runs the
 *     query at EACH grain and requires that grain's rollup to answer it, with rows equal to the
 *     same grouping computed directly from the source table.
 *
 * Last, it requires every rollup the generated model declares to have answered at least one query:
 * a rollup no Cube query can match (the defect "Several grains" used to be) fails here.
 *
 * `*.live.ts`: runs only by its path, from `bun run test:cube`. Without docker every test is
 * SKIPPED behind a banner.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cubeModel, defineConfig, runGen, servedReport } from "@metaobjectsdev/codegen-ts";
import { reportShape, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  CUBE_IMAGE,
  CUBE_MYSQL_IMAGE,
  CUBE_POSTGRES_IMAGE,
  cubeStackStartBudgetMs,
  dockerUnavailableReason,
  startCubeStack,
  type CubeDataSource,
  type CubeStack,
} from "../src/cube-container.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";
import { readCanonicalMysqlSchemaSql } from "../src/canonical-schema-mysql.ts";
import { CUBE_STORE_IMAGE, startProductionCube, type ProdCube } from "./cube-prod-stack.ts";
import {
  CANONICAL_REPORTS,
  type NormalRow,
  buildAllPreAggregations,
  cubeQueryFor,
  fromCubeRow,
  fromViewRow,
  getMeta,
  load,
  productionPreAggregation,
  selectSqlMysql,
  selectSqlPg,
  selectViewMysql,
  selectViewPg,
  sortRows,
  type LoadResponse,
  type QueryPlan,
} from "./cube-live-support.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CANONICAL_MODEL = join(CANONICAL_DIR, "meta.fitness.json");
const PG_SCHEMA = join(CANONICAL_DIR, "schema.postgres.sql");
const PG_SEED = join(REPO_ROOT, "fixtures", "cube-model", "canonical", "seed.sql");
const MYSQL_SEED = join(REPO_ROOT, "fixtures", "cube-model", "canonical", "seed.mysql.sql");
const TEST_TIMEOUT_MS = 600_000;

const unavailable = dockerUnavailableReason();
if (unavailable !== undefined) {
  const bar = "!".repeat(78);
  console.warn(
    `\n${bar}\n!! CUBE PRODUCTION-MODE LIVE CHECK SKIPPED: docker unavailable (${unavailable})\n` +
      `!! Nothing was checked against ${CUBE_IMAGE} and ${CUBE_STORE_IMAGE}. Every test in this file reports SKIP.\n${bar}\n`,
  );
}
const skip = unavailable !== undefined;

/** `ProgramsOverTime_day` → `programs_over_time_day`: Cube's snake case for the table of a cube or rollup. */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Every rollup a model tree declares: `{ cube, name }` for each `pre_aggregations` entry. */
function declaredRollups(modelDir: string): { cube: string; name: string }[] {
  const out: { cube: string; name: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".yml")) continue;
      const doc = YAML.parse(readFileSync(full, "utf8")) as { cubes?: { name?: unknown; pre_aggregations?: { name?: unknown }[] }[] };
      for (const c of doc.cubes ?? []) {
        for (const p of c.pre_aggregations ?? []) out.push({ cube: String(c.name), name: String(p.name) });
      }
    }
  };
  walk(modelDir);
  return out;
}

/** The rollup table (`prod_pre_aggregations.<cube>__<rollup>`) Cube names for a declared rollup. */
function rollupTable(r: { cube: string; name: string }): string {
  return `prod_pre_aggregations.${snake(r.cube)}__${snake(r.name)}`;
}

const GRAINS = ["day", "quarter", "year"] as const;
type Grain = (typeof GRAINS)[number];

/**
 * The source-table grouping `ProgramsOverTime` is reproduced by at one grain: what its view
 * groups, minus the other grains, written by hand against the `programs` table (the view cannot be
 * re-aggregated: an average of averages is not the average).
 */
function overTimeSql(dialect: CubeDataSource, grain: Grain): { select: string; columns: string[] } {
  const field = `createdAt${grain.charAt(0).toUpperCase()}${grain.slice(1)}`;
  if (dialect === "postgres") {
    return {
      select:
        `SELECT CAST(date_trunc('${grain}', p."created_ts") AS DATE) AS "${field}", COUNT(p."id") AS "programs", ` +
        `AVG(p."priceCents") AS "avgPrice", MIN(p."priceCents") AS "cheapest", MAX(p."priceCents") AS "priciest" ` +
        `FROM "programs" p GROUP BY 1`,
      columns: [],
    };
  }
  const bucket = {
    day: "DATE(p.`created_ts`)",
    quarter: "MAKEDATE(YEAR(p.`created_ts`), 1) + INTERVAL (QUARTER(p.`created_ts`) - 1) QUARTER",
    year: "MAKEDATE(YEAR(p.`created_ts`), 1)",
  }[grain];
  return {
    select:
      `SELECT ${bucket} AS \`${field}\`, COUNT(p.\`id\`) AS \`programs\`, AVG(p.\`priceCents\`) AS \`avgPrice\`, ` +
      `MIN(p.\`priceCents\`) AS \`cheapest\`, MAX(p.\`priceCents\`) AS \`priciest\` FROM \`programs\` p GROUP BY 1`,
    columns: [field, "programs", "avgPrice", "cheapest", "priciest"],
  };
}

const MULTI_GRAIN_REPORT = "ProgramsOverTime";

for (const dialect of ["postgres", "mysql"] as const) {
  describe(`cube-model production-mode live check (${CUBE_IMAGE} + ${CUBE_STORE_IMAGE} over ${dialect === "mysql" ? CUBE_MYSQL_IMAGE : CUBE_POSTGRES_IMAGE})`, () => {
    let work = "";
    let prod: ProdCube | undefined;
    let canonical: MetaRoot | undefined;
    /** The base stack: its database is the one the views and source tables are read from. */
    let baseStack: CubeStack | undefined;
    let builtTables: string[] = [];
    let modelDir = "";
    /** The rollup tables queries were answered from, across this block's tests. */
    const answeredFrom = new Set<string>();
    const timings: string[] = [];

    function cleanUp(): void {
      prod?.stop();
      prod = undefined;
      baseStack = undefined;
      if (work !== "") rmSync(work, { recursive: true, force: true });
      work = "";
    }

    beforeAll(async () => {
      if (skip) return;
      work = mkdtempSync(join(tmpdir(), `mo-cube-prod-${dialect}-`));
      process.on("exit", cleanUp);
      try {
        canonical = await loadMetadataFile(CANONICAL_MODEL);
        const outDir = join(work, "out");
        await runGen({
          config: defineConfig({ outDir, dialect, generators: [cubeModel()] }),
          metadata: canonical,
          genStateDir: join(work, ".gen-state"),
        });
        modelDir = join(outDir, "model");
        const t0 = Date.now();
        const started = await startCubeStack(modelDir, {
          dataSource: dialect,
          initSql:
            dialect === "mysql"
              ? [readCanonicalMysqlSchemaSql(), readFileSync(MYSQL_SEED, "utf8")]
              : [readFileSync(PG_SCHEMA, "utf8"), readFileSync(PG_SEED, "utf8")],
        });
        if (started.kind === "skipped") throw new Error(`docker answered a moment ago and no longer does: ${started.reason}`);
        const base = started.stack;
        try {
          prod = await startProductionCube(base, modelDir, dialect);
        } catch (e) {
          base.stop();
          throw e;
        }
        baseStack = base;
        timings.push(`stack up (database, Cube Store, production Cube): ${Date.now() - t0} ms`);
        const t1 = Date.now();
        builtTables = await buildAllPreAggregations(prod);
        timings.push(`${builtTables.length} pre-aggregation(s) built into Cube Store: ${Date.now() - t1} ms`);
      } catch (e) {
        cleanUp();
        throw e;
      }
    }, cubeStackStartBudgetMs() + 900_000);

    afterAll(() => {
      cleanUp();
      process.off("exit", cleanUp);
      if (timings.length > 0) console.log(`cube production-mode ${dialect} timings:\n  ${timings.join("\n  ")}`);
    }, 180_000);

    const requireProd = (): ProdCube => {
      if (prod === undefined) throw new Error("the production Cube stack did not start (see beforeAll)");
      return prod;
    };
    const requireCanonical = (): MetaRoot => {
      if (canonical === undefined) throw new Error("the canonical model did not load (see beforeAll)");
      return canonical;
    };
    const findReport = (name: string): MetaObject => {
      const report = requireCanonical().objects().find((o) => servedReport(o) && o.name === name);
      if (report === undefined) throw new Error(`the canonical model serves no report '${name}'`);
      return report;
    };
    const requireBase = (): CubeStack => {
      if (baseStack === undefined) throw new Error("the database stack did not start (see beforeAll)");
      return baseStack;
    };
    const viewRows = (view: string): Array<Record<string, string | null>> =>
      dialect === "mysql" ? selectViewMysql(requireBase(), view) : selectViewPg(requireBase(), view);

    /**
     * Cube answered from exactly the rollup `want` (or from no rollup, when undefined). A rollup's
     * answer is Cube Store's: the response says `external: true` and `extDbType: "cubestore"`, and
     * `usedPreAggregations` names the rollup under production mode's schema.
     */
    function expectAnsweredFrom(report: string, result: LoadResponse, want: string | undefined): void {
      const keys = Object.keys(result.usedPreAggregations ?? {}).sort();
      expect({ report, usedPreAggregations: keys }).toEqual({ report, usedPreAggregations: want === undefined ? [] : [want] });
      if (want === undefined) {
        expect({ report, external: result.external === true }).toEqual({ report, external: false });
        return;
      }
      expect({ report, table: want, external: result.external, extDbType: result.extDbType }).toEqual({ report, table: want, external: true, extDbType: "cubestore" });
      answeredFrom.add(want);
    }

    test.skipIf(skip)("production mode is on: the API refuses a request without the token, and the rollups are in Cube Store", async () => {
      const p = requireProd();
      const bare = await fetch(`${p.apiBase}/meta`, { signal: AbortSignal.timeout(30_000) });
      expect(bare.status).toBe(403);
      expect((await getMeta(p)).error).toBeUndefined();
      const declared = declaredRollups(modelDir);
      expect(declared.length).toBeGreaterThan(0);
      // Every declared rollup was built, each under production mode's schema.
      for (const r of declared) {
        const table = rollupTable(r);
        expect({ rollup: r.name, built: builtTables.some((t) => t.startsWith(table)) }).toEqual({ rollup: r.name, built: true });
      }
      expect(builtTables.every((t) => t.startsWith("prod_pre_aggregations."))).toBe(true);
    }, TEST_TIMEOUT_MS);

    test.skipIf(skip)("the reports below are exactly the canonical model's served reports", () => {
      const served = requireCanonical().objects().filter(servedReport).map((r) => r.name).sort();
      expect(served).toEqual(CANONICAL_REPORTS.map((e) => e.report).sort());
    });

    for (const want of CANONICAL_REPORTS) {
      test.skipIf(skip)(
        `${want.report}: the Table F query equals ${want.view}${want.preAggregation === undefined ? " (source table)" : " (from its rollup in Cube Store)"}`,
        async () => {
          const p = requireProd();
          const plan = cubeQueryFor(findReport(want.report), requireCanonical());
          const t0 = Date.now();
          const result = await load(p, plan.query);
                    const cubeRows = sortRows(result.data.map((row) => fromCubeRow(row, plan, dialect)), plan);
          const expected = sortRows(viewRows(want.view).map((row) => fromViewRow(row, plan, want.view)), plan);
          timings.push(`${want.report}: ${cubeRows.length} row(s), ${Object.keys(result.usedPreAggregations ?? {})[0] ?? "source table"}, ${Date.now() - t0} ms`);
          expectAnsweredFrom(want.report, result, want.preAggregation === undefined ? undefined : productionPreAggregation(want.preAggregation));
          expect(expected.length).toBe(want.rows);
          if (want.cubeRows !== undefined) {
            expect(cubeRows).toEqual([...want.cubeRows]);
            expect(cubeRows).not.toEqual(expected);
          } else {
            expect(cubeRows).toEqual(expected);
          }
        },
        TEST_TIMEOUT_MS,
      );
    }

    for (const grain of GRAINS) {
      test.skipIf(skip)(`${MULTI_GRAIN_REPORT} at ${grain}: its ${grain} rollup answers a query at that grain, with the source table's rows`, async () => {
        const p = requireProd();
        const report = findReport(MULTI_GRAIN_REPORT);
        const base: QueryPlan = cubeQueryFor(report, requireCanonical());
        // The report lists createdAt at every one of GRAINS: the model must carry one rollup for each.
        const listed = reportShape(report, requireCanonical()).fields.filter((f) => f.grain !== undefined).map((f) => f.grain);
        expect(listed.sort()).toEqual([...GRAINS].sort());
        const field = `createdAt${grain.charAt(0).toUpperCase()}${grain.slice(1)}`;
        const plan: QueryPlan = {
          query: { ...base.query, timeDimensions: [{ dimension: "Program.createdAt", granularity: grain }] },
          columns: [
            { field, cubeKey: `Program.createdAt.${grain}`, kind: "time" },
            ...base.columns.filter((c) => c.kind === "measure"),
          ],
        };
        const result = await load(p, plan.query);
        const sql = overTimeSql(dialect, grain);
        const sourceRows: Array<Record<string, string | null>> =
          dialect === "mysql" ? selectSqlMysql(requireBase(), sql.select, sql.columns) : selectSqlPg(requireBase(), sql.select);
        const cubeRows: NormalRow[] = sortRows(result.data.map((row) => fromCubeRow(row, plan, dialect)), plan);
        const expected: NormalRow[] = sortRows(sourceRows.map((row) => fromViewRow(row, plan, `programs@${grain}`)), plan);
        expectAnsweredFrom(`${MULTI_GRAIN_REPORT}@${grain}`, result, `prod_pre_aggregations.program__programs_over_time_${grain}`);
        expect(expected.length).toBeGreaterThan(0);
        // Cube Store keeps a rolled-up average to 5 decimal places (`2322.11111`), where the source
        // database prints 16 (`2322.1111111111111111`): same number, different scale. Compare the
        // average at 4 places; every other column is compared as it is.
        const atFourPlaces = (rows: NormalRow[]): NormalRow[] =>
          rows.map((r) => ({ ...r, avgPrice: r.avgPrice === null || r.avgPrice === undefined ? null : Number(r.avgPrice).toFixed(4) }));
        expect(atFourPlaces(cubeRows)).toEqual(atFourPlaces(expected));
      }, TEST_TIMEOUT_MS);
    }

    test.skipIf(skip)("every rollup the generated model declares answered a query: none is a rollup no Cube query can match", () => {
      const declared = declaredRollups(modelDir).map(rollupTable).sort();
      expect([...answeredFrom].sort()).toEqual(declared);
    });
  });
}
