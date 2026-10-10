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
 *      `SELECT * FROM <view>` under Table I's normalization;
 *   4. loads every Postgres case of the mapping corpus into the same Cube and requires each to
 *      compile (controller Ruling 11), which turns the shapes no live query reaches (alias cubes,
 *      a TPH subtype's `sql`, one-to-one joins, Jinja-escaped text) into executed checks.
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
import { cubeModel, defineConfig, runGen, servedReport } from "@metaobjectsdev/codegen-ts";
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
/** One HTTP request to Cube; a stalled socket is aborted and counts as a transport error. */
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * How long one `/v1/load` may keep retrying (`Continue wait` while a rollup builds, or a
 * transport error). The worst case stays inside TEST_TIMEOUT_MS: this deadline, one request
 * timeout and the last backoff, then a `/v1/sql` request and the view read.
 */
const LOAD_DEADLINE_MS = 300_000;
/** Consecutive transport errors (refused, reset, aborted, a body that is not JSON) a load survives. */
const LOAD_TRANSPORT_RETRIES = 6;
/** Backoff after a transport error: 1 s, doubling, capped here. */
const LOAD_BACKOFF_CAP_MS = 10_000;
/** Each corpus case's share of the corpus pass's budget: its empty-model wait plus its load. */
const CASE_BUDGET_MS = 60_000;

/** The corpus cases the compile pass loads, known when the tests are defined (its timeout scales with them). */
const CORPUS_CASES = postgresCorpusCases();
/** The corpus pass's one budget, which every case's deadline is drawn from. */
const CORPUS_BUDGET_MS = CORPUS_CASES.length * CASE_BUDGET_MS;

/**
 * Table I: what each served canonical report must produce. `preAggregation` is the table Cube
 * names in `usedPreAggregations`: development mode's schema `dev_pre_aggregations`, then
 * `<cube>__<rollup>` in snake case, TWO underscores (executed on 1.7.43); undefined means Table F
 * emits no rollup and Cube reads the source table. `rows` is the row count on canonical/seed.sql.
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

  test.skipIf(skip)("every Postgres case of the mapping corpus compiles in Cube (Ruling 11)", async () => {
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
});

// ---------------------------------------------------------------------------------------------
// Table F: the Cube query that reproduces a report.
// ---------------------------------------------------------------------------------------------

interface CubeTimeDimension {
  readonly dimension: string;
  readonly granularity: string;
}

interface CubeQuery {
  readonly measures: readonly string[];
  readonly dimensions: readonly string[];
  readonly timeDimensions: readonly CubeTimeDimension[];
  readonly segments: readonly string[];
  /** Table I fixes the query time zone at UTC (Table J: another zone re-buckets). */
  readonly timezone: "UTC";
}

type ColumnKind = "attribute" | "time" | "hour" | "measure";

/** One report field: its view column and the Cube row key that carries it. */
interface PlannedColumn {
  readonly field: string;
  readonly cubeKey: string;
  readonly kind: ColumnKind;
}

interface QueryPlan {
  readonly query: CubeQuery;
  readonly columns: readonly PlannedColumn[];
}

function findReport(name: string): MetaObject {
  const report = requireCanonical().objects().find((o) => servedReport(o) && o.name === name);
  if (report === undefined) throw new Error(`the canonical model serves no report '${name}'`);
  return report;
}

/** Lower camel case of a report name: `RecentPrograms` → `recentPrograms` (Table F's scope segment). */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function cubeQueryFor(report: MetaObject, root: MetaRoot): QueryPlan {
  const shape = reportShape(report, root);
  const cube = shape.from.name;
  const measures: string[] = [];
  const dimensions: string[] = [];
  const timeDimensions: CubeTimeDimension[] = [];
  const columns: PlannedColumn[] = [];
  for (const f of shape.fields) {
    if (f.role === "measure") {
      if (f.measure === undefined) throw new Error(`${report.name}.${f.name}: a measure field without its measure`);
      const member = `${cube}.${f.measure.name}`;
      measures.push(member);
      columns.push({ field: f.name, cubeKey: member, kind: "measure" });
    } else {
      if (f.dimension === undefined) throw new Error(`${report.name}.${f.name}: a dimension field without its dimension`);
      const member = `${cube}.${f.dimension.name}`;
      if (f.grain === undefined) {
        dimensions.push(member);
        columns.push({ field: f.name, cubeKey: member, kind: "attribute" });
      } else {
        timeDimensions.push({ dimension: member, granularity: f.grain });
        columns.push({ field: f.name, cubeKey: `${member}.${f.grain}`, kind: f.grain === GRAIN_HOUR ? "hour" : "time" });
      }
    }
  }
  const segments: string[] = [];
  const segment = report.attr(OBJECT_REPORT_ATTR_SEGMENT);
  if (typeof segment === "string") segments.push(`${cube}.${segment}`);
  if (report.attr(OBJECT_REPORT_ATTR_FILTER) !== undefined) segments.push(`${cube}.${lowerFirst(report.name)}Scope`);
  return { query: { measures, dimensions, timeDimensions, segments, timezone: "UTC" }, columns };
}

// ---------------------------------------------------------------------------------------------
// Table I: normalization and comparison.
// ---------------------------------------------------------------------------------------------

type NormalRow = Record<string, string | null>;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** `60.0000000000000000` → `60`, `0.75000000000000000000` → `0.75`; an integer string is kept. */
function canonicalDecimal(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** True when the string already names its offset (`Z`, `+00:00`, `-0500`). */
const HAS_ZONE_RE = /(Z|[+-]\d{2}(:?\d{2})?)$/;

function normalize(kind: ColumnKind, raw: unknown, where: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`${where}: unexpected value ${JSON.stringify(raw)}`);
  const s = String(raw);
  switch (kind) {
    case "time":
      // A day, week, month, quarter or year bucket: Cube sends `2026-05-01T00:00:00.000`, the view a DATE.
      return s.slice(0, 10);
    case "hour": {
      // An instant. Cube sends the wall clock in the query time zone (UTC, fixed by the query);
      // the view sends a timestamptz with its offset.
      const d = new Date(HAS_ZONE_RE.test(s) ? s : `${s}Z`);
      if (Number.isNaN(d.getTime())) throw new Error(`${where}: '${s}' is not a timestamp`);
      return d.toISOString();
    }
    case "attribute":
    case "measure":
      return DECIMAL_RE.test(s) ? canonicalDecimal(s) : s;
  }
}

function fromCubeRow(row: Record<string, unknown>, plan: QueryPlan): NormalRow {
  const out: NormalRow = {};
  for (const c of plan.columns) {
    if (!(c.cubeKey in row)) throw new Error(`Cube's row has no '${c.cubeKey}': ${JSON.stringify(row)}`);
    out[c.field] = normalize(c.kind, row[c.cubeKey], `Cube ${c.cubeKey}`);
  }
  return out;
}

function fromViewRow(row: Record<string, string | null>, plan: QueryPlan, view: string): NormalRow {
  const want = plan.columns.map((c) => c.field).sort();
  expect(Object.keys(row).sort()).toEqual(want);
  const out: NormalRow = {};
  for (const c of plan.columns) out[c.field] = normalize(c.kind, row[c.field], `${view}.${c.field}`);
  return out;
}

/** Rows as a set, ordered by their dimension values (then by the whole row, for determinism). */
function sortRows(rows: NormalRow[], plan: QueryPlan): NormalRow[] {
  const dims = plan.columns.filter((c) => c.kind !== "measure").map((c) => c.field);
  const key = (r: NormalRow): string => JSON.stringify([dims.map((d) => r[d] ?? null), plan.columns.map((c) => r[c.field] ?? null)]);
  return rows.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
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
// The Cube REST API.
// ---------------------------------------------------------------------------------------------

interface MetaMember {
  readonly name: string;
  readonly type?: string;
  readonly aggType?: string;
  readonly public?: boolean;
  /** A member's own declared title (`title` is the cube's title and this one, joined). */
  readonly shortTitle?: string;
  readonly description?: string;
}

interface MetaCube {
  readonly name: string;
  readonly public?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly measures?: readonly MetaMember[];
  readonly dimensions?: readonly MetaMember[];
  readonly segments?: readonly MetaMember[];
}

interface MetaResponse {
  readonly error?: string;
  readonly cubes: readonly MetaCube[];
}

interface LoadResponse {
  readonly data: Array<Record<string, unknown>>;
  readonly usedPreAggregations?: Record<string, unknown>;
}

/** A request that never produced a JSON answer: refused, reset, aborted, or a body that is not JSON. */
class TransportError extends Error {}

async function getJson(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1000, timeoutMs)) });
    text = await res.text();
  } catch (e) {
    throw new TransportError(`${url.split("?")[0]}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, { cause: e });
  }
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new TransportError(`${url.split("?")[0]}: HTTP ${res.status}, not JSON: ${text.slice(0, 500)}`);
  }
}

function errorOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return `not an object: ${JSON.stringify(body)}`;
  const e = (body as { error?: unknown }).error;
  return e === undefined ? undefined : String(e);
}

async function getMeta(s: CubeStack, timeoutMs = REQUEST_TIMEOUT_MS): Promise<MetaResponse> {
  const { body } = await getJson(`${s.apiBase}/meta`, timeoutMs);
  const error = errorOf(body);
  if (error !== undefined) return { error, cubes: [] };
  const cubes = (body as { cubes?: unknown }).cubes;
  if (!Array.isArray(cubes)) throw new Error(`/meta answered without a cubes list: ${JSON.stringify(body).slice(0, 300)}`);
  return { cubes: cubes as MetaCube[] };
}

function queryUrl(s: CubeStack, path: "load" | "sql", query: CubeQuery): string {
  return `${s.apiBase}/${path}?query=${encodeURIComponent(JSON.stringify(query))}`;
}

/** `/v1/load`, retried every second while Cube answers `Continue wait` (a rollup is building). */
/**
 * `/v1/load`, retried every second while Cube answers `Continue wait` (a rollup is building), and
 * with backoff after a transport error (at most LOAD_TRANSPORT_RETRIES in a row), all within
 * LOAD_DEADLINE_MS.
 */
async function load(s: CubeStack, query: CubeQuery): Promise<LoadResponse> {
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  let transportErrors = 0;
  for (;;) {
    let answer: { status: number; body: unknown };
    try {
      answer = await getJson(queryUrl(s, "load", query));
      transportErrors = 0;
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      transportErrors++;
      if (transportErrors > LOAD_TRANSPORT_RETRIES || Date.now() > deadline) {
        throw new Error(`/v1/load failed ${transportErrors} time(s) in a row, last: ${e.message}\n${s.cubeLogs(40)}`, { cause: e });
      }
      await Bun.sleep(Math.min(1000 * 2 ** (transportErrors - 1), LOAD_BACKOFF_CAP_MS));
      continue;
    }
    const { status, body } = answer;
    const error = errorOf(body);
    if (error === "Continue wait") {
      if (Date.now() > deadline) throw new Error(`Cube kept answering 'Continue wait' for ${LOAD_DEADLINE_MS / 1000}s:\n${s.cubeLogs(40)}`);
      await Bun.sleep(1000);
      continue;
    }
    if (error !== undefined) {
      throw new Error(`/v1/load answered HTTP ${status}: ${error}\nquery: ${JSON.stringify(query)}\nSQL: ${await cubeSql(s, query)}`);
    }
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error(`/v1/load answered without data: ${JSON.stringify(body).slice(0, 300)}`);
    return body as LoadResponse;
  }
}

/** The SQL Cube generates for a query, for a failure message. */
async function cubeSql(s: CubeStack, query: CubeQuery): Promise<string> {
  try {
    const { body } = await getJson(queryUrl(s, "sql", query));
    const sql = (body as { sql?: { sql?: unknown } }).sql?.sql;
    return Array.isArray(sql) ? String(sql[0]) : JSON.stringify(body).slice(0, 2000);
  } catch (e) {
    return `(no SQL: ${e instanceof Error ? e.message : String(e)})`;
  }
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

/** Every cube the YAML files of a model tree declare. */
function declaredCubes(tree: ReadonlyMap<string, string>): YamlCube[] {
  const out: YamlCube[] = [];
  for (const [path, text] of tree) {
    if (!path.endsWith(".yml")) continue;
    const doc: unknown = YAML.parse(text);
    const cubes = typeof doc === "object" && doc !== null ? (doc as { cubes?: unknown }).cubes : undefined;
    if (!Array.isArray(cubes)) throw new Error(`${path}: no cubes list`);
    out.push(...(cubes as YamlCube[]));
  }
  return out;
}

/**
 * The summary Cube's meta should give for these files: a cube is public unless `public: false`;
 * a primary key is private unless it says otherwise (Cube's default); every other member is
 * public unless `public: false`.
 */
function declaredSummary(tree: ReadonlyMap<string, string>): Record<string, CubeSummary> {
  const out: Record<string, CubeSummary> = {};
  for (const c of declaredCubes(tree)) {
    const name = String(c.name);
    const isPrivate = (m: YamlMember): boolean => m.public === false || (m.primary_key === true && m.public !== true);
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
  return out;
}

function declaredRollups(tree: ReadonlyMap<string, string>, cube: string): string[] {
  const c = declaredCubes(tree).find((x) => x.name === cube);
  return (c?.pre_aggregations ?? []).map((p) => String(p.name));
}

// ---------------------------------------------------------------------------------------------
// The corpus compile pass.
// ---------------------------------------------------------------------------------------------

/** Mapping-corpus cases with an `expected/` tree whose dialect is postgres (the default). */
function postgresCorpusCases(): string[] {
  return readdirSync(CUBE_CORPUS_DIR)
    .filter((name) => name !== "canonical" && statSync(join(CUBE_CORPUS_DIR, name)).isDirectory())
    .filter((name) => existsSync(join(CUBE_CORPUS_DIR, name, "expected")))
    .filter((name) => caseDialect(name) === "postgres")
    .sort();
}

function caseDialect(name: string): string {
  const path = join(CUBE_CORPUS_DIR, name, "case.json");
  if (!existsSync(path)) return "postgres";
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const dialect = typeof raw === "object" && raw !== null ? (raw as { dialect?: unknown }).dialect : undefined;
  return typeof dialect === "string" ? dialect : "postgres";
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
 * Ruling 28: Cube reads `title` and `description` as templates, so the exporter escapes them. The
 * check that the escape is exact: every title and description the case's MODEL declares (on an
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
