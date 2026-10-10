/**
 * The cube-model live check — FR-044 Plan 4, Task 7 (contract Tables F, H and I).
 *
 * Spec §7 asks for more than goldens: "a real Cube instance accepts the output; the Cube query
 * result equals the report view result on the conformance data". This file is that check. It runs
 * a pinned Cube (cubejs/cube:v1.7.43, development mode) over a private Postgres 16 holding the
 * persistence-conformance schema and `fixtures/cube-model/canonical/seed.sql`, and:
 *
 *   1. generates the canonical model with `cubeModel()` and requires it to be the reviewed golden
 *      (`fixtures/cube-model/canonical/expected/`), so what Cube loads is what review approved;
 *   2. requires Cube to compile it and to list every cube and member the files declare;
 *   3. for each served report, builds the Cube query Table F says reproduces it, requires Cube to
 *      answer from the report's rollup when the model has one, and compares the rows with
 *      `SELECT * FROM <view>` under Table I's normalization. A report with `@spine` is a Cube
 *      view, queried by its own name, and its rows include the spine rows with no facts;
 *   4. loads every case of the mapping corpus that has an expected tree into the same Cube and
 *      requires each to compile, which turns the shapes no live query reaches (alias cubes, a TPH
 *      subtype's `sql`, one-to-one joins, Jinja-escaped text) into executed checks. The MySQL
 *      cases are loaded too: Cube's `/v1/meta` compile runs no SQL, so the Postgres data source
 *      does not stop a MySQL model from compiling;
 *   5. reads the `escaping` case's SQL back through `/v1/sql` and requires each of its literals,
 *      and its braced column, to reach the SQL exactly as the report view writes them (Cube
 *      compiles every `sql` as a template literal, so a missed escape changes the value);
 *   6. reads the `measure-default` case's SQL back through `/v1/sql` and requires a ratio over an
 *      operand that declares `@default` to divide that operand's COALESCE, as the view does.
 *
 * It is `*.live.ts`, so no directory-walking `bun test` picks it up: it runs only by its path,
 * from `bun run test:cube` (the `cube` lane of scripts/ci-local.sh). Without docker every test is
 * SKIPPED behind a banner; nothing here ever passes without having run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JOIN_PATH_SEPARATOR, cubeModel, defineConfig, runGen, servedReport } from "@metaobjectsdev/codegen-ts";
import {
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_TITLE,
  GRAIN_HOUR,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  TYPE_DIMENSION,
  TYPE_MEASURE,
  TYPE_SEGMENT,
  reportReadSource,
  reportShape,
  reportSpine,
  type MetaData,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import {
  CUBE_IMAGE,
  cubeStackStartBudgetMs,
  dockerUnavailableReason,
  startCubeStack,
  type CubeStack,
} from "../src/cube-container.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import {
  type CubeQuery,
  type LoadResponse,
  type MetaCube,
  type MetaMember,
  type MetaResponse,
  type QueryPlan,
  REQUEST_TIMEOUT_MS,
  TransportError,
  cubeQueryFor,
  cubeSql,
  generatedSql,
  fromCubeRow,
  fromViewRow,
  getJson,
  getMeta,
  load,
  normalize,
  sortRows,
} from "./cube-live-support.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

// cube-live → integration-tests → packages → typescript → server → repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CUBE_CORPUS_DIR = join(REPO_ROOT, "fixtures", "cube-model");
const CUBE_CANONICAL_DIR = join(CUBE_CORPUS_DIR, "canonical");
const CANONICAL_EXPECTED_DIR = join(CUBE_CANONICAL_DIR, "expected");
const CANONICAL_MODEL = join(CANONICAL_DIR, "meta.fitness.json");
const CANONICAL_SCHEMA = join(CANONICAL_DIR, "schema.postgres.sql");
const CANONICAL_SEED = join(CUBE_CANONICAL_DIR, "seed.sql");

/** The persistence corpus's schema spells columns literally, and so does the golden. */
const GEN_CONFIG = { dialect: "postgres", columnNamingStrategy: "literal" } as const;

const TEST_TIMEOUT_MS = 600_000;
/** Each corpus case's share of the corpus pass's budget: its empty-model wait plus its load. */
const CASE_BUDGET_MS = 60_000;

/** The corpus cases the compile pass loads, known when the tests are defined (its timeout scales with them). */
const CORPUS_CASES = corpusCasesWithTree();
/** The corpus pass's one budget, which every case's deadline is drawn from. */
const CORPUS_BUDGET_MS = CORPUS_CASES.length * CASE_BUDGET_MS;

/**
 * Table I: what each served canonical report must produce. `preAggregation` is the table Cube
 * names in `usedPreAggregations`: development mode's schema `dev_pre_aggregations`, then
 * `<cube>__<rollup>` in snake case, TWO underscores (executed on 1.7.43); undefined means Table F
 * emits no rollup and Cube reads the source tables (a relative date, or a `@spine` report, which
 * is a Cube view). `rows` is the row count on canonical/seed.sql: a `@spine` report has one row
 * per program, the four with no weeks (and, for ProgramLongWeeks, the two whose weeks are all
 * short) included.
 */
interface ExpectedReport {
  readonly report: string;
  readonly view: string;
  readonly preAggregation: string | undefined;
  readonly rows: number;
}

const TABLE_I: readonly ExpectedReport[] = [
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

// ---------------------------------------------------------------------------------------------
// Skip semantics: never a silent pass.
// ---------------------------------------------------------------------------------------------

const unavailable = dockerUnavailableReason();
if (unavailable !== undefined) {
  const bar = "!".repeat(78);
  console.warn(
    `\n${bar}\n!! CUBE LIVE CHECK SKIPPED: docker unavailable (${unavailable})\n` +
      `!! Nothing was checked against ${CUBE_IMAGE}. Every test in this file reports SKIP.\n${bar}\n`,
  );
}
const skip = unavailable !== undefined;

// ---------------------------------------------------------------------------------------------
// Shared state: one stack for the file.
// ---------------------------------------------------------------------------------------------

let work = "";
let outDir = "";
let stack: CubeStack | undefined;
let canonical: MetaRoot | undefined;
const timings: string[] = [];

beforeAll(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), "mo-cube-live-"));
  outDir = join(work, "out");
  // An interrupted run exits through process.exit (cube-container.ts's signal handler), which
  // never reaches afterAll: remove the temp directory on the way out as well.
  process.on("exit", cleanUp);
  try {
    canonical = await loadMetadataFile(CANONICAL_MODEL);
    await runGen({
      config: defineConfig({ outDir, ...GEN_CONFIG, generators: [cubeModel()] }),
      metadata: canonical,
      genStateDir: join(work, ".gen-state"),
    });
    // Before Cube starts: the lane loads the reviewed golden or nothing at all.
    assertCanonicalGolden();

    const t0 = Date.now();
    // The schema and seed go in before Cube starts, so no rollup can be built over empty tables.
    const started = await startCubeStack(modelDir(), {
      initSql: [readFileSync(CANONICAL_SCHEMA, "utf8"), readFileSync(CANONICAL_SEED, "utf8")],
    });
    if (started.kind === "skipped") throw new Error(`docker answered a moment ago and no longer does: ${started.reason}`);
    stack = started.stack;
    timings.push(`stack up (pull if needed, Postgres + schema + seed, Cube /meta): ${Date.now() - t0} ms`);
  } catch (e) {
    // Clean up here as well as in afterAll: a failed setup must not depend on the runner
    // calling the after hook.
    cleanUp();
    throw e;
  }
}, cubeStackStartBudgetMs() + 120_000);

afterAll(() => {
  cleanUp();
  process.off("exit", cleanUp);
  if (timings.length > 0) console.log(`cube live check timings:\n  ${timings.join("\n  ")}`);
}, 180_000);

/** Remove the containers, the network and the temp directory. Idempotent. */
function cleanUp(): void {
  stack?.stop();
  stack = undefined;
  if (work !== "") rmSync(work, { recursive: true, force: true });
}

/** The command that rewrites the canonical golden, for a drift message. */
const REGEN_CANONICAL = "cd server/typescript/packages/codegen-ts && bun run gen:cube-canonical";

/** Throw, naming each drifted file, unless the generated tree is the committed golden. */
function assertCanonicalGolden(): void {
  const got = readTree(outDir);
  const want = readTree(CANONICAL_EXPECTED_DIR);
  const drift = [...new Set([...got.keys(), ...want.keys()])]
    .sort()
    .filter((path) => got.get(path) !== want.get(path))
    .map((path) => (!got.has(path) ? `${path} (in the golden, not generated)` : !want.has(path) ? `${path} (generated, not in the golden)` : `${path} (differs)`));
  if (drift.length > 0) {
    throw new Error(
      `the generated canonical Cube model is not fixtures/cube-model/canonical/expected/: ${drift.join(", ")}. ` +
        `Review the change, then regenerate the golden: ${REGEN_CANONICAL}`,
    );
  }
}

/** The directory mounted at /cube/conf/model: the generator's `model/` (it holds `cubes/`). */
function modelDir(): string {
  return join(outDir, "model");
}

function requireStack(): CubeStack {
  if (stack === undefined) throw new Error("the cube stack did not start (see beforeAll)");
  return stack;
}

function requireCanonical(): MetaRoot {
  if (canonical === undefined) throw new Error("the canonical model did not load (see beforeAll)");
  return canonical;
}

// ---------------------------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------------------------

describe(`cube-model live check (${CUBE_IMAGE}, development mode)`, () => {
  test.skipIf(skip)("the model Cube loads is the reviewed canonical golden", () => {
    // Already required in beforeAll, before Cube started; restated so a green run lists it.
    expect(Object.fromEntries(readTree(outDir))).toEqual(Object.fromEntries(readTree(CANONICAL_EXPECTED_DIR)));
  });

  test.skipIf(skip)("Cube compiles the model and lists every cube and member it declares (Table H)", async () => {
    const meta = await getMeta(requireStack());
    expect(meta.error).toBeUndefined();
    expect(metaSummary(meta.cubes)).toEqual(declaredSummary(readTree(modelDir())));
  }, TEST_TIMEOUT_MS);

  test.skipIf(skip)("Table I covers exactly the canonical model's served reports", () => {
    const served = requireCanonical().objects().filter(servedReport).map((r) => r.name).sort();
    expect(served).toEqual(TABLE_I.map((e) => e.report).sort());
    for (const want of TABLE_I) {
      const report = findReport(want.report);
      expect(reportReadSource(report)?.physicalName).toBe(want.view);
      // Table I's rollup column agrees with the golden: a rollup named after the report on its
      // `@from` cube exactly when Table I expects Cube to answer from one.
      const cube = reportShape(report, requireCanonical()).from.name;
      expect(declaredRollups(readTree(CANONICAL_EXPECTED_DIR), cube).includes(want.report)).toBe(want.preAggregation !== undefined);
      // And a Cube view named after the report exactly when it declares @spine.
      const views = declaredViews(readTree(CANONICAL_EXPECTED_DIR)).map((v) => String(v.name));
      expect(views.includes(want.report)).toBe(reportSpine(report) !== undefined);
    }
  });

  for (const want of TABLE_I) {
    test.skipIf(skip)(`${want.report}: the Table F query equals ${want.view}${want.preAggregation === undefined ? " (source table)" : " (from its rollup)"}`, async () => {
      const s = requireStack();
      const plan = cubeQueryFor(findReport(want.report), requireCanonical());

      const t0 = Date.now();
      const result = await load(s, plan.query);
      const loadMs = Date.now() - t0;

      // Rows first, so a rollup mismatch can say whether the numbers were right anyway.
      const cubeRows = sortRows(result.data.map((row) => fromCubeRow(row, plan)), plan);
      const viewRows = sortRows(selectView(s, want.view).map((row) => fromViewRow(row, plan, want.view)), plan);
      const rowsMatch = Bun.deepEquals(cubeRows, viewRows);
      const used = Object.keys(result.usedPreAggregations ?? {}).sort();
      const wantUsed = want.preAggregation === undefined ? [] : [want.preAggregation];
      timings.push(`${want.report}: ${cubeRows.length} row(s) compared, served from ${used[0] ?? "the source table"}, load ${loadMs} ms`);

      if (!Bun.deepEquals(used, wantUsed)) {
        throw new Error(
          `${want.report}: Cube answered from [${used.join(", ")}], expected [${wantUsed.join(", ")}]; ` +
            `the rows ${rowsMatch ? "DID" : "did NOT"} equal ${want.view}.\n` +
            `query: ${JSON.stringify(plan.query)}\nCube's SQL: ${await cubeSql(s, plan.query)}`,
        );
      }
      expect(viewRows.length).toBe(want.rows);
      if (!rowsMatch) {
        console.error(`${want.report}: Cube's SQL for ${JSON.stringify(plan.query)}:\n${await cubeSql(s, plan.query)}`);
      }
      expect(cubeRows).toEqual(viewRows);
    }, TEST_TIMEOUT_MS);
  }

  test.skipIf(skip)("every case of the mapping corpus with an expected tree compiles in Cube, MySQL included", async () => {
    const s = requireStack();
    const cases = CORPUS_CASES;
    expect(cases.length).toBeGreaterThan(0);
    const rejected: string[] = [];
    const t0 = Date.now();
    const budgetEnd = t0 + CORPUS_BUDGET_MS;
    for (const [i, name] of cases.entries()) {
      if (Date.now() >= budgetEnd) {
        throw new Error(
          `the corpus pass spent its ${CORPUS_BUDGET_MS / 1000}s budget before case '${name}' ` +
            `(${i}/${cases.length} done; not reached: ${cases.slice(i).join(", ")}); ` +
            `rejected so far: ${rejected.length === 0 ? "none" : rejected.join(" | ")}`,
        );
      }
      // Each case's own deadline, drawn from the one budget: a slow Cube is named on the case it was on.
      const deadline = Math.min(Date.now() + CASE_BUDGET_MS, budgetEnd);
      const outcome = await swapInCase(s, name, deadline);
      if (outcome !== undefined) rejected.push(`${name}: ${outcome}`);
    }
    timings.push(
      `corpus compile pass: ${cases.length - rejected.length}/${cases.length} case(s) loaded in ${Date.now() - t0} ms, ` +
        `${freeTextChecked} declared title/description value(s) handed back verbatim (${cases.join(", ")})`,
    );
    expect(rejected).toEqual([]);
    // The free-text check is not vacuous: free-text-jinja alone declares six values.
    expect(freeTextChecked).toBeGreaterThanOrEqual(6);
  }, CORPUS_BUDGET_MS + 60_000);

  test.skipIf(skip)("escaping: each literal and the braced column reach Cube's SQL as the view writes them", async () => {
    const s = requireStack();
    const outcome = await swapInCase(s, ESCAPING_CASE, Date.now() + CASE_BUDGET_MS);
    if (outcome !== undefined) throw new Error(`${ESCAPING_CASE}: ${outcome}`);

    // Every segment the case declares has its expected literal below, so a new one cannot go unchecked.
    const declared = declaredCubes(readTree(join(CUBE_CORPUS_DIR, ESCAPING_CASE, "expected", "model")));
    const segments = declared.flatMap((c) => (c.segments ?? []).map((m) => String(m.name))).sort();
    expect(segments).toEqual(ESCAPING_LITERALS.map((e) => e.segment).sort());

    const wrong: string[] = [];
    for (const { segment, literal } of ESCAPING_LITERALS) {
      const query: CubeQuery = {
        measures: [],
        dimensions: [`${ESCAPING_CUBE}.code`],
        timeDimensions: [],
        segments: [`${ESCAPING_CUBE}.${segment}`],
        timezone: "UTC",
      };
      const sql = await generatedSql(s, query);
      // The view writes `"title" = <literal>`; Cube puts its cube alias in front of the column.
      const predicate = `."title" = ${literal}`;
      const column = `."co{de}"`;
      const found = sql.includes(predicate) && sql.includes(column);
      timings.push(`escaping /v1/sql ${segment}: ${found ? "ok" : "MISMATCH"}, ${JSON.stringify(predicate)}`);
      if (!found) wrong.push(`${segment}: want ${JSON.stringify(predicate)} and ${JSON.stringify(column)} in Cube's SQL, got ${JSON.stringify(sql)}`);
    }
    expect(wrong).toEqual([]);
  }, CASE_BUDGET_MS + 120_000);

  test("measure-default: a ratio over a defaulted operand divides the operand's COALESCE, as the view does", async () => {
    const s = requireStack();
    const outcome = await swapInCase(s, DEFAULT_CASE, Date.now() + CASE_BUDGET_MS);
    if (outcome !== undefined) throw new Error(`${DEFAULT_CASE}: ${outcome}`);
    const sqlOf = async (measure: string): Promise<string> => {
      const query: CubeQuery = { measures: [`${DEFAULT_CUBE}.${measure}`], dimensions: [], timeDimensions: [], segments: [], timezone: "UTC" };
      return (await generatedSql(s, query)).replace(/\s+/g, " ");
    };
    // Cube inlines each member reference, so the operand's own COALESCE(sum(...), 0) is inside the
    // ratio's cast (the zero-rows / measure-defaults plan's decision 4), with or without the ratio's.
    const operand = `CAST(COALESCE(sum("sale"."amount"), 0) AS NUMERIC) / NULLIF(count("sale"."id"), 0)`;
    const perSale = await sqlOf("revenuePerSale");
    const orZero = await sqlOf("revenuePerSaleOrZero");
    timings.push(`measure-default /v1/sql: revenuePerSale ${perSale.includes(operand) ? "ok" : "MISMATCH"}, revenuePerSaleOrZero ${orZero.includes(`COALESCE(${operand}, 0)`) ? "ok" : "MISMATCH"}`);
    expect({ perSale: perSale.includes(operand), sql: perSale }).toEqual({ perSale: true, sql: perSale });
    expect({ orZero: orZero.includes(`COALESCE(${operand}, 0)`), sql: orZero }).toEqual({ orZero: true, sql: orZero });
  }, CASE_BUDGET_MS + 120_000);
});

const DEFAULT_CASE = "measure-default";
/** The case's one cube (fixtures/cube-model/measure-default/meta.json). */
const DEFAULT_CUBE = "Sale";

// ---------------------------------------------------------------------------------------------
// The escaping case through /v1/sql.
// ---------------------------------------------------------------------------------------------

const ESCAPING_CASE = "escaping";
/** The case's one cube (fixtures/cube-model/escaping/meta.json). */
const ESCAPING_CUBE = "Program";

/**
 * Each segment of the `escaping` case and the literal its `@filter` value is in the report view's
 * own SQL (report-sql.ts `literal`, Postgres: `'` doubled, nothing else changed), written out by
 * hand. After Jinja and its template reader, Cube's SQL must hold each one exactly as written here.
 */
const ESCAPING_LITERALS: readonly { readonly segment: string; readonly literal: string }[] = [
  { segment: "braces", literal: "'a{b}c'" },
  { segment: "doubleBraces", literal: "'{{x}}'" },
  { segment: "jinja", literal: "'{{y}} {% z %} {# c #}'" },
  { segment: "quote", literal: "'it''s'" },
  { segment: "backslash", literal: "'a\\b'" },
  { segment: "trailingBackslash", literal: "'ends\\'" },
  { segment: "backslashBrace", literal: "'a\\{b}'" },
  { segment: "lineBreak", literal: "'two\nlines'" },
];

function findReport(name: string): MetaObject {
  const report = requireCanonical().objects().find((o) => servedReport(o) && o.name === name);
  if (report === undefined) throw new Error(`the canonical model serves no report '${name}'`);
  return report;
}

/**
 * `SELECT * FROM <view>` through psql, every value as the TEXT Postgres prints for it (a numeric
 * keeps its scale, a timestamptz its offset), in a UTC session.
 */
function selectView(s: CubeStack, view: string): Array<Record<string, string | null>> {
  const out = s.psql(
    `SET TIME ZONE 'UTC';\n` +
      `SELECT coalesce(json_agg(t.o), '[]'::json)::text FROM (\n` +
      `  SELECT (SELECT json_object_agg(e.key, e.value) FROM json_each_text(row_to_json(v)) e) AS o\n` +
      `  FROM "${view}" v\n` +
      `) t;\n`,
  );
  const line = out.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  const parsed: unknown = JSON.parse(line);
  if (!Array.isArray(parsed)) throw new Error(`${view}: psql did not print a JSON array: ${line.slice(0, 200)}`);
  return parsed as Array<Record<string, string | null>>;
}

// ---------------------------------------------------------------------------------------------
// What the files declare, and what Cube lists.
// ---------------------------------------------------------------------------------------------

/** One cube as a comparable summary: `public`, and each member with its kind, type and `public`. */
interface CubeSummary {
  readonly public: boolean;
  readonly members: readonly string[];
}

/** Cube's meta `aggType` for each measure `type` the exporter writes (Table D). */
const AGG_TYPE: Readonly<Record<string, string>> = {
  count: "count",
  count_distinct: "countDistinct",
  sum: "sum",
  avg: "avg",
  min: "min",
  max: "max",
  number: "number",
};

function metaSummary(cubes: readonly MetaCube[]): Record<string, CubeSummary> {
  const out: Record<string, CubeSummary> = {};
  for (const c of cubes) {
    out[c.name] = {
      public: c.public !== false,
      members: [
        ...(c.dimensions ?? []).map((m) => `dimension ${m.name} ${m.type ?? "?"}${m.public === false ? " private" : ""}`),
        ...(c.measures ?? []).map((m) => `measure ${m.name} ${m.aggType ?? "?"}${m.public === false ? " private" : ""}`),
        ...(c.segments ?? []).map((m) => `segment ${m.name}${m.public === false ? " private" : ""}`),
      ].sort(),
    };
  }
  return out;
}

interface YamlMember {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly public?: unknown;
  readonly primary_key?: unknown;
}

interface YamlCube {
  readonly name?: unknown;
  readonly public?: unknown;
  readonly dimensions?: readonly YamlMember[];
  readonly measures?: readonly YamlMember[];
  readonly segments?: readonly YamlMember[];
  readonly pre_aggregations?: readonly YamlMember[];
}

interface YamlViewInclude {
  readonly name?: unknown;
  readonly alias?: unknown;
}

interface YamlView {
  readonly name?: unknown;
  readonly cubes?: readonly { readonly join_path?: unknown; readonly includes?: readonly YamlViewInclude[] }[];
}

/** The `cubes` and `views` lists of every YAML file of a model tree. */
function declaredDocs(tree: ReadonlyMap<string, string>): { cubes: YamlCube[]; views: YamlView[] } {
  const cubes: YamlCube[] = [];
  const views: YamlView[] = [];
  for (const [path, text] of tree) {
    if (!path.endsWith(".yml")) continue;
    const doc: unknown = YAML.parse(text);
    const lists = typeof doc === "object" && doc !== null ? (doc as { cubes?: unknown; views?: unknown }) : {};
    if (!Array.isArray(lists.cubes) && !Array.isArray(lists.views)) throw new Error(`${path}: no cubes or views list`);
    if (Array.isArray(lists.cubes)) cubes.push(...(lists.cubes as YamlCube[]));
    if (Array.isArray(lists.views)) views.push(...(lists.views as YamlView[]));
  }
  return { cubes, views };
}

/** Every cube the YAML files of a model tree declare. */
function declaredCubes(tree: ReadonlyMap<string, string>): YamlCube[] {
  return declaredDocs(tree).cubes;
}

/** Every Cube view the YAML files of a model tree declare. */
function declaredViews(tree: ReadonlyMap<string, string>): YamlView[] {
  return declaredDocs(tree).views;
}

/**
 * The summary Cube's meta should give for these files: a cube is public unless `public: false`;
 * every member of a `public: false` cube is private (executed on 1.7.43: a facts cube's measures,
 * which carry no `public` of their own); otherwise a primary key is private unless it says
 * otherwise (Cube's default), and every other member is public unless `public: false`. A view is public, and so is each member it includes, under its
 * alias, with the kind and type of the cube member it includes (executed on 1.7.43: a private key
 * and a `public: false` member are public in a view).
 */
function declaredSummary(tree: ReadonlyMap<string, string>): Record<string, CubeSummary> {
  const out: Record<string, CubeSummary> = {};
  const { cubes, views } = declaredDocs(tree);
  for (const c of cubes) {
    const name = String(c.name);
    const isPrivate = (m: YamlMember): boolean =>
      c.public === false || m.public === false || (m.primary_key === true && m.public !== true);
    const flag = (m: YamlMember): string => (isPrivate(m) ? " private" : "");
    out[name] = {
      public: c.public !== false,
      members: [
        ...(c.dimensions ?? []).map((m) => `dimension ${name}.${String(m.name)} ${String(m.type)}${flag(m)}`),
        ...(c.measures ?? []).map((m) => `measure ${name}.${String(m.name)} ${AGG_TYPE[String(m.type)] ?? `?${String(m.type)}`}${flag(m)}`),
        ...(c.segments ?? []).map((m) => `segment ${name}.${String(m.name)}${flag(m)}`),
      ].sort(),
    };
  }
  for (const v of views) {
    const name = String(v.name);
    const members: string[] = [];
    for (const entry of v.cubes ?? []) {
      // The members a join path includes are the members of the cube it ends on.
      const target = String(entry.join_path).split(JOIN_PATH_SEPARATOR).pop();
      const cube = cubes.find((c) => String(c.name) === target);
      if (cube === undefined) throw new Error(`view ${name}: join_path ${String(entry.join_path)} ends on no declared cube`);
      for (const include of entry.includes ?? []) {
        const member = String(include.name);
        const as = `${name}.${String(include.alias ?? member)}`;
        const dim = (cube.dimensions ?? []).find((m) => String(m.name) === member);
        const measure = (cube.measures ?? []).find((m) => String(m.name) === member);
        if (dim !== undefined) members.push(`dimension ${as} ${String(dim.type)}`);
        else if (measure !== undefined) members.push(`measure ${as} ${AGG_TYPE[String(measure.type)] ?? `?${String(measure.type)}`}`);
        else throw new Error(`view ${name}: includes ${member}, which ${String(cube.name)} does not declare`);
      }
    }
    out[name] = { public: true, members: members.sort() };
  }
  return out;
}

function declaredRollups(tree: ReadonlyMap<string, string>, cube: string): string[] {
  const c = declaredCubes(tree).find((x) => x.name === cube);
  return (c?.pre_aggregations ?? []).map((p) => String(p.name));
}

// ---------------------------------------------------------------------------------------------
// The corpus compile pass.
// ---------------------------------------------------------------------------------------------

/**
 * Mapping-corpus cases with an `expected/` tree, of either dialect. Compiling a model runs no SQL
 * (`/v1/meta` neither queries the data source nor builds a rollup), so a MySQL case compiles
 * against the Postgres data source as well. Its SQL is held by the golden, not executed.
 */
function corpusCasesWithTree(): string[] {
  return readdirSync(CUBE_CORPUS_DIR)
    .filter((name) => name !== "canonical" && statSync(join(CUBE_CORPUS_DIR, name)).isDirectory())
    .filter((name) => existsSync(join(CUBE_CORPUS_DIR, name, "expected")))
    .sort();
}

let swapCount = 0;

/**
 * Replace the mounted model with a case's expected files, and wait until Cube lists exactly that
 * case's cubes. Returns undefined when it compiled clean, else why not.
 *
 * Two steps, both atomic renames inside the mounted directory: the current `cubes/` moves out
 * (Cube must then list no cube at all), then the case's `cubes/`, staged outside the mount, moves
 * in. Passing through the empty model is what makes "the names match" mean "Cube compiled THIS
 * case": many cases share a cube name with the case before them.
 */
async function swapInCase(s: CubeStack, name: string, deadline: number): Promise<string | undefined> {
  const n = swapCount++;
  const model = modelDir();
  const started = Date.now();
  const spent = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  for (const entry of readdirSync(model)) renameSync(join(model, entry), join(work, `retired-${n}-${entry}`));
  const emptied = await waitForMeta(s, (m) => m.error === undefined && m.cubes.length === 0, deadline);
  if (emptied === undefined || emptied.error !== undefined || emptied.cubes.length !== 0) {
    const last = emptied === undefined ? "no answer" : emptied.error ?? emptied.cubes.map((c) => c.name).join(", ");
    return `the model did not empty before loading it, after ${spent()} of its deadline (last /meta: ${last})`;
  }

  const expected = join(CUBE_CORPUS_DIR, name, "expected", "model");
  const stage = join(work, `stage-${n}`);
  mkdirSync(stage);
  cpSync(expected, stage, { recursive: true });
  for (const entry of readdirSync(stage)) renameSync(join(stage, entry), join(model, entry));

  const tree = readTree(expected);
  const wantNames = Object.keys(declaredSummary(tree)).sort();
  const loaded = await waitForMeta(s, (m) => m.error !== undefined || sameNames(m, wantNames), deadline);
  if (loaded === undefined) return `Cube did not answer /v1/meta within the case's deadline (${spent()})`;
  if (loaded.error !== undefined) return `Cube refused it: ${loaded.error}`;
  if (!sameNames(loaded, wantNames)) {
    return `Cube listed [${loaded.cubes.map((c) => c.name).sort().join(", ")}] within the case's deadline (${spent()}), not [${wantNames.join(", ")}]`;
  }
  const got = metaSummary(loaded.cubes);
  const want = declaredSummary(tree);
  if (!Bun.deepEquals(got, want)) return `Cube's members differ from the files: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
  const pairs = freeTextPairs(await loadMetadataFile(join(CUBE_CORPUS_DIR, name, "meta.json")), loaded.cubes);
  const wrong = pairs.filter((p) => p.got !== p.declared).map((p) => `${p.where}: declared ${JSON.stringify(p.declared)}, Cube says ${JSON.stringify(p.got)}`);
  if (wrong.length > 0) return `Cube does not hand back the model's free text as declared: ${wrong.join("; ")}`;
  freeTextChecked += pairs.length;
  return undefined;
}

let freeTextChecked = 0;

interface FreeTextPair {
  readonly where: string;
  readonly declared: string;
  readonly got: string | undefined;
}

const REPORTING_MEMBER_TYPES: ReadonlySet<string> = new Set([TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT]);

/**
 * Cube reads `title` and `description` as templates, so the exporter escapes them. The check that
 * the escape is exact: every title and description the case's MODEL declares (on an
 * entity Cube lists, and on its dimensions, measures and segments) is paired with what
 * `/v1/meta` hands back, which must be the same text. `/v1/meta` exposes a cube's `title` and
 * `description`, and a member's `description` and `shortTitle` (its own title; `title` there is
 * the cube's and the member's joined).
 */
function freeTextPairs(root: MetaRoot, cubes: readonly MetaCube[]): FreeTextPair[] {
  const out: FreeTextPair[] = [];
  const text = (node: MetaData, attr: string): string | undefined => {
    // ADR-0039: resolving attr(), as the exporter reads it.
    const v = node.attr(attr);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const push = (where: string, declared: string | undefined, got: string | undefined): void => {
    if (declared !== undefined) out.push({ where, declared, got });
  };
  for (const obj of root.objects()) {
    const cube = cubes.find((c) => c.name === obj.name);
    if (cube === undefined) continue;
    push(`cube ${cube.name} title`, text(obj, DOC_ATTR_TITLE), cube.title);
    push(`cube ${cube.name} description`, text(obj, DOC_ATTR_DESCRIPTION), cube.description);
    // ADR-0039: resolving children(), so an inherited member is checked where Cube lists it.
    for (const child of obj.children()) {
      if (!REPORTING_MEMBER_TYPES.has(child.type)) continue;
      const key = `${cube.name}.${child.name}`;
      const member = [...(cube.dimensions ?? []), ...(cube.measures ?? []), ...(cube.segments ?? [])].find((m) => m.name === key);
      push(`${child.type} ${key} title`, text(child, DOC_ATTR_TITLE), member?.shortTitle);
      push(`${child.type} ${key} description`, text(child, DOC_ATTR_DESCRIPTION), member?.description);
    }
    // A @spine report's view (its own title and description are paired above): each member is a
    // report field, and carries the docs of the dimension or measure the report lists.
    if (servedReport(obj) && reportSpine(obj) !== undefined) {
      for (const f of reportShape(obj, root).fields) {
        const node: MetaData | undefined = f.dimension ?? f.measure;
        if (node === undefined) continue;
        const key = `${cube.name}.${node.name}`;
        const member = [...(cube.dimensions ?? []), ...(cube.measures ?? [])].find((m) => m.name === key);
        push(`view member ${key} title`, text(node, DOC_ATTR_TITLE), member?.shortTitle);
        push(`view member ${key} description`, text(node, DOC_ATTR_DESCRIPTION), member?.description);
      }
    }
  }
  return out;
}

function sameNames(m: MetaResponse, want: readonly string[]): boolean {
  return m.error === undefined && Bun.deepEquals(m.cubes.map((c) => c.name).sort(), want);
}

/**
 * Poll `/v1/meta` until `done` or `deadline`; the last answer, or undefined when none came. A
 * transport error is polled past: Cube may be busy recompiling.
 */
async function waitForMeta(s: CubeStack, done: (m: MetaResponse) => boolean, deadline: number): Promise<MetaResponse | undefined> {
  let last: MetaResponse | undefined;
  for (;;) {
    try {
      last = await getMeta(s, deadline - Date.now());
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
    }
    if ((last !== undefined && done(last)) || Date.now() >= deadline) return last;
    await Bun.sleep(500);
  }
}

// ---------------------------------------------------------------------------------------------
// Files.
// ---------------------------------------------------------------------------------------------

/** Every file under `dir`, keyed by its `/`-separated path relative to `dir`, in path order. */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(dir, full).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}
