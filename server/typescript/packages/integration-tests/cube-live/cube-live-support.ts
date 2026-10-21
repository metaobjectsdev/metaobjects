// cube-live-support.ts — what the Cube live checks share, whatever data source Cube reads: the
// Table F query that reproduces a report, Table I's normalization, and a client for Cube's REST
// API. cube-model.live.ts (Postgres) and cube-model-mysql.live.ts (MySQL) import it.

import { expect } from "bun:test";
import {
  FIELD_ATTR_INT_VALUE_MAP,
  GRAIN_HOUR,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  reportShape,
  reportSpine,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";

/**
 * Where a Cube API answers: a development stack (no auth) or a production one (a JWT in
 * `headers`). `CubeStack` (src/cube-container.ts) is one; cube-prod-stack.ts's `ProdCube` is the other.
 */
export interface CubeEndpoint {
  /** `http://127.0.0.1:<port>/cubejs-api/v1`. */
  readonly apiBase: string;
  /** Request headers the API requires; absent in development mode. */
  readonly headers?: Readonly<Record<string, string>>;
  cubeLogs(lines?: number): string;
}

/** One HTTP request to Cube; a stalled socket is aborted and counts as a transport error. */
export const REQUEST_TIMEOUT_MS = 60_000;
/**
 * How long one `/v1/load` may keep retrying (`Continue wait` while a rollup builds, or a
 * transport error). The worst case stays inside TEST_TIMEOUT_MS: this deadline, one request
 * timeout and the last backoff, then a `/v1/sql` request and the view read.
 */
export const LOAD_DEADLINE_MS = 300_000;
/** Consecutive transport errors (refused, reset, aborted, a body that is not JSON) a load survives. */
export const LOAD_TRANSPORT_RETRIES = 6;
/** Backoff after a transport error: 1 s, doubling, capped here. */
export const LOAD_BACKOFF_CAP_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// Table F: the Cube query that reproduces a report.
// ---------------------------------------------------------------------------------------------

export interface CubeTimeDimension {
  readonly dimension: string;
  readonly granularity: string;
}

export interface CubeQuery {
  readonly measures: readonly string[];
  readonly dimensions: readonly string[];
  readonly timeDimensions: readonly CubeTimeDimension[];
  readonly segments: readonly string[];
  /** Cube query filters (the MySQL cases pick rows with them). */
  readonly filters?: readonly { readonly member: string; readonly operator: string; readonly values: readonly string[] }[];
  /** Table I fixes the query time zone at UTC (Table J: another zone re-buckets). */
  readonly timezone: "UTC";
}

/** The grains one Cube query can ask together, finest first: each bucket lies inside the next. */
const NESTING_ORDER: readonly string[] = ["day", "month", "quarter", "year"];

export type ColumnKind = "attribute" | "time" | "hour" | "measure";

/** One report field: its view column and the Cube row key that carries it. */
export interface PlannedColumn {
  readonly field: string;
  readonly cubeKey: string;
  readonly kind: ColumnKind;
  /**
   * A coarser grain of a dimension the query already asks at a finer one. Cube answers a time
   * dimension at ONE granularity per query, so the report's other grains are read off that
   * bucket's start: day, month, quarter and year nest, and the group the finest grain makes is
   * the group they make.
   */
  readonly derive?: { readonly fromKey: string; readonly grain: string };
  /**
   * An int-backed enum: the view holds the stored integer, Cube's `CASE` the member symbol (as
   * every port's read returns it). Maps the integer, as text, to its symbol.
   */
  readonly symbols?: Readonly<Record<string, string>>;
  /**
   * A boolean measure (`@agg: any` / `all`). Over Postgres Cube must send a JSON boolean. Over
   * MySQL, which has no boolean type, Cube sends the string `"1"` or `"0"`, and nothing else.
   */
  readonly boolean?: true;
}

export interface QueryPlan {
  readonly query: CubeQuery;
  readonly columns: readonly PlannedColumn[];
}



/** Lower camel case of a report name: `RecentPrograms` → `recentPrograms` (Table F's scope segment). */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function cubeQueryFor(report: MetaObject, root: MetaRoot): QueryPlan {
  const shape = reportShape(report, root);
  // A @spine report is a Cube view of its own name, whose scope is inside its facts cube.
  const spine = reportSpine(report) !== undefined;
  const cube = spine ? report.name : shape.from.name;
  const measures: string[] = [];
  const dimensions: string[] = [];
  const timeDimensions: CubeTimeDimension[] = [];
  const columns: PlannedColumn[] = [];
  for (const f of shape.fields) {
    if (f.role === "measure") {
      if (f.measure === undefined) throw new Error(`${report.name}.${f.name}: a measure field without its measure`);
      const member = `${cube}.${f.measure.name}`;
      measures.push(member);
      columns.push({ field: f.name, cubeKey: member, kind: "measure", ...(f.subType === "boolean" ? { boolean: true as const } : {}) });
    } else {
      if (f.dimension === undefined) throw new Error(`${report.name}.${f.name}: a dimension field without its dimension`);
      const member = `${cube}.${f.dimension.name}`;
      if (f.grain === undefined) {
        dimensions.push(member);
        const intMap = f.typeSource?.attr(FIELD_ATTR_INT_VALUE_MAP);
        const symbols =
          typeof intMap === "object" && intMap !== null
            ? Object.fromEntries(Object.entries(intMap as Record<string, unknown>).map(([symbol, n]) => [String(n), symbol]))
            : undefined;
        // A date dimension is a Cube `time` member: it sends the day as a midnight timestamp.
        columns.push({ field: f.name, cubeKey: member, kind: f.subType === "date" ? "time" : "attribute", ...(symbols === undefined ? {} : { symbols }) });
      } else {
        // One granularity per time dimension per Cube query: ask the finest grain the report
        // lists, and derive the coarser ones from that bucket (see PlannedColumn.derive).
        const dimName = f.dimension.name;
        const grains = shape.fields.filter((g) => g.dimension?.name === dimName && g.grain !== undefined).map((g) => g.grain as string);
        const rank = (g: string): number => NESTING_ORDER.indexOf(g);
        if (grains.length > 1 && grains.some((g) => rank(g) < 0)) {
          throw new Error(`${report.name}.${f.name}: ${member} at ${grains.join(" and ")} does not nest, so one Cube query cannot ask both`);
        }
        const fine = grains.slice().sort((x, y) => rank(x) - rank(y))[0] as string;
        if (!timeDimensions.some((t) => t.dimension === member)) timeDimensions.push({ dimension: member, granularity: fine });
        columns.push(
          f.grain === fine
            ? { field: f.name, cubeKey: `${member}.${fine}`, kind: f.grain === GRAIN_HOUR ? "hour" : "time" }
            : { field: f.name, cubeKey: `${member}.${f.grain}`, kind: "time", derive: { fromKey: `${member}.${fine}`, grain: f.grain } },
        );
      }
    }
  }
  const segments: string[] = [];
  const segment = report.attr(OBJECT_REPORT_ATTR_SEGMENT);
  if (!spine && typeof segment === "string") segments.push(`${cube}.${segment}`);
  if (!spine && report.attr(OBJECT_REPORT_ATTR_FILTER) !== undefined) segments.push(`${cube}.${lowerFirst(report.name)}Scope`);
  return { query: { measures, dimensions, timeDimensions, segments, timezone: "UTC" }, columns };
}

// ---------------------------------------------------------------------------------------------
// Table I: normalization and comparison.
// ---------------------------------------------------------------------------------------------

export type NormalRow = Record<string, string | null>;

export const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** `60.0000000000000000` → `60`, `0.75000000000000000000` → `0.75`; an integer string is kept. */
export function canonicalDecimal(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEMPORAL_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** True when the string already names its offset (`Z`, `+00:00`, `-0500`). */
export const HAS_ZONE_RE = /(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * Read a temporal string as a UTC instant: an explicit offset wins, a date-only value is
 * midnight, and a naive wall clock (`2026-05-01T08:30:00.000` — Cube's spelling with the
 * query pinned to UTC) is read as UTC. One zone-handling site for every temporal column.
 */
function isoInstant(s: string, where: string): string {
  const d = new Date(DATE_ONLY_RE.test(s) ? `${s}T00:00:00Z` : HAS_ZONE_RE.test(s) ? s : `${s}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`${where}: '${s}' is not a timestamp`);
  return d.toISOString();
}

export function normalize(kind: ColumnKind, raw: unknown, where: string): string | null {
  if (raw === null || raw === undefined) return null;
  // A boolean measure (`@agg: any` / `all`): Cube sends a JSON boolean, the view's text is `true` / `false`.
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    throw new Error(`${where}: unexpected value ${JSON.stringify(raw)}`);
  }
  const s = String(raw);
  switch (kind) {
    case "time":
      // A day, week, month, quarter or year bucket: Cube sends `2026-05-01T00:00:00.000`, the view a DATE.
      return s.slice(0, 10);
    case "hour":
      // An instant. Cube sends the wall clock in the query time zone (UTC, fixed by the query);
      // the view sends a timestamptz with its offset.
      return isoInstant(s, where);
    case "attribute":
      return DECIMAL_RE.test(s) ? canonicalDecimal(s) : s;
    case "measure":
      // A min or max over a date or a timestamp is a temporal value: Cube sends every one as
      // `YYYY-MM-DDTHH:MM:SS.sss` (a date at midnight), the view as the column's own text, with an
      // offset for a timestamptz. Both are read as UTC instants and compared as such.
      if (TEMPORAL_RE.test(s)) return isoInstant(s, where);
      return DECIMAL_RE.test(s) ? canonicalDecimal(s) : s;
  }
}

/** The start of the month, quarter or year that holds `day` (`YYYY-MM-DD`). */
function coarsen(day: string, grain: string): string {
  const [y, m] = day.split("-") as [string, string];
  switch (grain) {
    case "month":
      return `${y}-${m}-01`;
    case "quarter":
      return `${y}-${String(Math.floor((Number(m) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
    case "year":
      return `${y}-01-01`;
    default:
      throw new Error(`cannot derive a ${grain} bucket from a day`);
  }
}

export function fromCubeRow(row: Record<string, unknown>, plan: QueryPlan, dialect: "postgres" | "mysql"): NormalRow {
  const out: NormalRow = {};
  for (const c of plan.columns) {
    const key = c.derive?.fromKey ?? c.cubeKey;
    if (!(key in row)) throw new Error(`Cube's row has no '${key}': ${JSON.stringify(row)}`);
    const raw = row[key];
    if (c.boolean === true && raw !== null && raw !== undefined) {
      const wellFormed = dialect === "postgres" ? typeof raw === "boolean" : raw === "1" || raw === "0";
      if (!wellFormed) {
        const want = dialect === "postgres" ? "a JSON boolean" : 'the string "1" or "0"';
        throw new Error(`Cube ${key}: a boolean measure came back as ${typeof raw} ${JSON.stringify(raw)}, not ${want}`);
      }
    }
    const value = normalize(c.kind, raw, `Cube ${key}`);
    out[c.field] = c.derive === undefined || value === null ? value : coarsen(value, c.derive.grain);
  }
  return out;
}

export function fromViewRow(row: Record<string, string | null>, plan: QueryPlan, view: string): NormalRow {
  const want = plan.columns.map((c) => c.field).sort();
  expect(Object.keys(row).sort()).toEqual(want);
  const out: NormalRow = {};
  for (const c of plan.columns) {
    const raw = row[c.field];
    out[c.field] = normalize(c.kind, raw !== null && raw !== undefined && c.symbols?.[raw] !== undefined ? c.symbols[raw] : raw, `${view}.${c.field}`);
  }
  return out;
}

/** Rows as a set, ordered by their dimension values (then by the whole row, for determinism). */
export function sortRows(rows: NormalRow[], plan: QueryPlan): NormalRow[] {
  const dims = plan.columns.filter((c) => c.kind !== "measure").map((c) => c.field);
  const key = (r: NormalRow): string => JSON.stringify([dims.map((d) => r[d] ?? null), plan.columns.map((c) => r[c.field] ?? null)]);
  return rows.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// The Cube REST API.
// ---------------------------------------------------------------------------------------------

export interface MetaMember {
  readonly name: string;
  readonly type?: string;
  readonly aggType?: string;
  readonly public?: boolean;
  /** A member's own declared title (`title` is the cube's title and this one, joined). */
  readonly shortTitle?: string;
  readonly description?: string;
}

export interface MetaCube {
  readonly name: string;
  readonly public?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly measures?: readonly MetaMember[];
  readonly dimensions?: readonly MetaMember[];
  readonly segments?: readonly MetaMember[];
}

export interface MetaResponse {
  readonly error?: string;
  readonly cubes: readonly MetaCube[];
}

export interface LoadResponse {
  readonly data: Array<Record<string, unknown>>;
  readonly usedPreAggregations?: Record<string, unknown>;
  /** True when Cube answered from Cube Store (a rollup built there) rather than from the data source. */
  readonly external?: boolean;
  /** The external store that answered: `cubestore` in production mode. */
  readonly extDbType?: string;
}

/** A request that never produced a JSON answer: refused, reset, aborted, or a body that is not JSON. */
export class TransportError extends Error {}

export async function getJson(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  headers: Readonly<Record<string, string>> = {},
  post?: unknown,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      headers: post === undefined ? { ...headers } : { ...headers, "Content-Type": "application/json" },
      ...(post === undefined ? {} : { method: "POST", body: JSON.stringify(post) }),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
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

export function errorOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return `not an object: ${JSON.stringify(body)}`;
  const e = (body as { error?: unknown }).error;
  return e === undefined ? undefined : String(e);
}

export async function getMeta(s: CubeEndpoint, timeoutMs = REQUEST_TIMEOUT_MS): Promise<MetaResponse> {
  const { body } = await getJson(`${s.apiBase}/meta`, timeoutMs, s.headers);
  const error = errorOf(body);
  if (error !== undefined) return { error, cubes: [] };
  const cubes = (body as { cubes?: unknown }).cubes;
  if (!Array.isArray(cubes)) throw new Error(`/meta answered without a cubes list: ${JSON.stringify(body).slice(0, 300)}`);
  return { cubes: cubes as MetaCube[] };
}

export function queryUrl(s: CubeEndpoint, path: "load" | "sql", query: CubeQuery): string {
  return `${s.apiBase}/${path}?query=${encodeURIComponent(JSON.stringify(query))}`;
}

/**
 * `/v1/load`, retried every second while Cube answers `Continue wait` (a rollup is building), and
 * with backoff after a transport error (at most LOAD_TRANSPORT_RETRIES in a row), all within
 * LOAD_DEADLINE_MS.
 */
export async function load(s: CubeEndpoint, query: CubeQuery): Promise<LoadResponse> {
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  let transportErrors = 0;
  for (;;) {
    let answer: { status: number; body: unknown };
    try {
      answer = await getJson(queryUrl(s, "load", query), REQUEST_TIMEOUT_MS, s.headers);
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

/** The SQL Cube generates for a query (`/v1/sql`); throws when Cube answers without it. */
export async function generatedSql(s: CubeEndpoint, query: CubeQuery): Promise<string> {
  const { status, body } = await getJson(queryUrl(s, "sql", query), REQUEST_TIMEOUT_MS, s.headers);
  const sql = (body as { sql?: { sql?: unknown } }).sql?.sql;
  if (!Array.isArray(sql) || typeof sql[0] !== "string") {
    throw new Error(`/v1/sql answered HTTP ${status} without SQL: ${JSON.stringify(body).slice(0, 2000)}`);
  }
  return sql[0];
}

/** The SQL Cube generates for a query, for a failure message. */
export async function cubeSql(s: CubeEndpoint, query: CubeQuery): Promise<string> {
  try {
    return await generatedSql(s, query);
  } catch (e) {
    return `(no SQL: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * Table I: what each served canonical report must produce. `preAggregation` is the table Cube
 * names in `usedPreAggregations`: development mode's schema `dev_pre_aggregations`, then
 * `<cube>__<rollup>` in snake case, TWO underscores (executed on 1.7.43); undefined means Table F
 * emits no rollup and Cube reads the source tables (a relative date, or a `@spine` report, which
 * is a Cube view). `rows` is the row count on the lane's seed (canonical/seed.sql, or seed.mysql.sql on MySQL): a `@spine` report has one row
 * per program, the eight with no weeks (and, for ProgramLongWeeks, the two whose weeks are all
 * short) included.
 */
export interface ExpectedReport {
  readonly report: string;
  readonly view: string;
  readonly preAggregation: string | undefined;
  readonly rows: number;
  /**
   * A known difference (docs/features/cube-export.md, "Where a Cube query and the view differ"):
   * the rows Cube answers where the view's differ. The test requires Cube to send exactly these
   * and the view NOT to, so the difference stays an executed check rather than a skipped one.
   */
  readonly cubeRows?: readonly Record<string, string | null>[];
}

/**
 * Every served canonical report, its view, the rollup Cube answers it from (undefined = the
 * source tables) and its row count on the seed. Postgres and MySQL agree on all three, so both
 * lanes, in both Cube modes, read this one table. `preAggregation` is written for development
 * mode; {@link productionPreAggregation} names the same rollup in production mode.
 */
export const CANONICAL_REPORTS: readonly ExpectedReport[] = [
  { report: "ProgramMinutes", view: "v_program_minutes", preAggregation: "dev_pre_aggregations.week__program_minutes", rows: 3 },
  { report: "FitnessTotals", view: "v_fitness_totals", preAggregation: "dev_pre_aggregations.week__fitness_totals", rows: 1 },
  { report: "ProgramsByMonth", view: "v_programs_by_month", preAggregation: "dev_pre_aggregations.program__programs_by_month", rows: 5 },
  { report: "ProgramsByWeek", view: "v_programs_by_week", preAggregation: "dev_pre_aggregations.program__programs_by_week", rows: 5 },
  { report: "RecentPrograms", view: "v_recent_programs", preAggregation: undefined, rows: 1 },
  { report: "AssetActivity", view: "v_asset_activity", preAggregation: "dev_pre_aggregations.asset__asset_activity", rows: 2 },
  { report: "ProgramRoster", view: "v_program_roster", preAggregation: undefined, rows: 11 },
  { report: "ProgramLongWeeks", view: "v_program_long_weeks", preAggregation: undefined, rows: 11 },
  { report: "ProgramFlags", view: "v_program_flags", preAggregation: "dev_pre_aggregations.week__program_flags", rows: 3 },
  { report: "ProgramFlagRoster", view: "v_program_flag_roster", preAggregation: undefined, rows: 11 },
  { report: "FitnessTotalsFilled", view: "v_fitness_totals_filled", preAggregation: "dev_pre_aggregations.week__fitness_totals_filled", rows: 1 },
  { report: "MeasurementStats", view: "v_measurement_stats", preAggregation: "dev_pre_aggregations.measurement__measurement_stats", rows: 1 },
  { report: "MeasurementStatsFilled", view: "v_measurement_stats_filled", preAggregation: "dev_pre_aggregations.measurement__measurement_stats_filled", rows: 1 },
  { report: "AssetDays", view: "v_asset_days", preAggregation: "dev_pre_aggregations.asset__asset_days", rows: 1 },
  { report: "AllTypesBreakdown", view: "v_all_types_breakdown", preAggregation: undefined, rows: 2 },
  // A report listing createdAt at day, quarter and year has one rollup per grain; the Table F query
  // asks the finest (day), so it is answered from the day rollup. The other two are proven by the
  // production-mode lane's per-grain queries.
  { report: "ProgramsOverTime", view: "v_programs_over_time", preAggregation: "dev_pre_aggregations.program__programs_over_time_day", rows: 7 },
  { report: "LiveIntroPrograms", view: "v_live_intro_programs", preAggregation: "dev_pre_aggregations.program__live_intro_programs", rows: 2 },
  // No dimension, no row in scope: the view reads one row with the count 0 and the default; Cube
  // sums the (empty) rollup, which is null for every measure, the count and the default included.
  { report: "ProgramsEmptyScope", view: "v_programs_empty_scope", preAggregation: "dev_pre_aggregations.program__programs_empty_scope", rows: 1, cubeRows: [{ avgPriceOrMinusOne: null, programs: null }] },
  { report: "WeekShapes", view: "v_week_shapes", preAggregation: "dev_pre_aggregations.week__week_shapes", rows: 3 },
  { report: "SessionsByProgram", view: "v_sessions_by_program", preAggregation: "dev_pre_aggregations.session__sessions_by_program", rows: 3 },
  { report: "ProgramSessions", view: "v_program_sessions", preAggregation: undefined, rows: 11 },
  { report: "NodesByParent", view: "v_nodes_by_parent", preAggregation: "dev_pre_aggregations.node__nodes_by_parent", rows: 3 },
  { report: "AuthsByKind", view: "v_auths_by_kind", preAggregation: "dev_pre_aggregations.auth__auths_by_kind", rows: 3 },
  // A dimension reached through an abstract parent's redeclared field (Gadget.label, column gadget_code): 3 gadgets with events.
  { report: "GadgetEventsByLabel", view: "v_gadget_events_by_label", preAggregation: "dev_pre_aggregations.gadget_event__gadget_events_by_label", rows: 3 },
  // Exact-decimal measures over four buckets (A, B, C with all-null amounts, D).
  { report: "EntryTotals", view: "v_entry_totals", preAggregation: "dev_pre_aggregations.entry__entry_totals", rows: 4 },
];

/** The rollup table Cube's production mode names for a development-mode name: `prod_pre_aggregations.<same table>`. */
export function productionPreAggregation(dev: string): string {
  return dev.replace(/^dev_pre_aggregations\./, "prod_pre_aggregations.");
}

/**
 * `SELECT * FROM <view>` through psql, every value as the TEXT Postgres prints for it (a numeric
 * keeps its scale, a timestamptz its offset), in a UTC session.
 */
export function selectViewPg(s: { psql(sqlText: string): string }, view: string): Array<Record<string, string | null>> {
  return selectSqlPg(s, `SELECT * FROM "${view}"`);
}

/** The rows of any `SELECT` through psql, as {@link selectViewPg} prints them. */
export function selectSqlPg(s: { psql(sqlText: string): string }, select: string): Array<Record<string, string | null>> {
  const out = s.psql(
    `SET TIME ZONE 'UTC';\n` +
      `SELECT coalesce(json_agg(t.o), '[]'::json)::text FROM (\n` +
      `  SELECT (SELECT json_object_agg(e.key, e.value) FROM json_each_text(row_to_json(v)) e) AS o\n` +
      `  FROM (${select}) v\n` +
      `) t;\n`,
  );
  const line = out.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  const parsed: unknown = JSON.parse(line);
  if (!Array.isArray(parsed)) throw new Error(`psql did not print a JSON array: ${line.slice(0, 200)}`);
  return parsed as Array<Record<string, string | null>>;
}

/**
 * `SELECT * FROM <view>` through the mysql client, every value as the text MySQL prints for it. A
 * DATETIME prints `2026-05-04 03:30:00.000`; the space becomes `T` so the shared normalization
 * reads it as a UTC instant, as it does Cube's `2026-05-04T03:30:00.000`.
 */
export function selectViewMysql(s: { mysql(sqlText: string): string }, view: string): Array<Record<string, string | null>> {
  const columns = s.mysql(`SHOW COLUMNS FROM \`${view}\`;`).trim().split("\n").map((l) => l.split("\t")[0] ?? "");
  return selectSqlMysql(s, `SELECT ${columns.map((c) => `\`${c}\``).join(", ")} FROM \`${view}\``, columns);
}

/** The rows of any `SELECT` through the mysql client, named `columns` in order. */
export function selectSqlMysql(s: { mysql(sqlText: string): string }, select: string, columns: readonly string[]): Array<Record<string, string | null>> {
  const out = s.mysql(`SET time_zone = '+00:00'; ${select};`);
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

// ---------------------------------------------------------------------------------------------
// Production mode: building rollups.
// ---------------------------------------------------------------------------------------------

/** One pre-aggregation build job as the jobs API reports it. */
interface BuildJob {
  readonly table?: string;
  readonly status?: string;
}

/**
 * Build every pre-aggregation of the model into Cube Store through the pre-aggregations jobs API
 * (`POST /v1/pre-aggregations/jobs`, `action: post`, then `action: get` until each job is `done`).
 * Production mode answers from a rollup only once it is built; this makes "built" a fact the test
 * waits for rather than a race it hopes to win. Returns the tables built (`schema.table`).
 */
export async function buildAllPreAggregations(s: CubeEndpoint, timeoutMs = 600_000): Promise<string[]> {
  const url = `${s.apiBase}/pre-aggregations/jobs`;
  const started = await getJson(
    url,
    REQUEST_TIMEOUT_MS,
    s.headers,
    { action: "post", selector: { contexts: [{ securityContext: {} }], timezones: ["UTC"] } },
  );
  const tokens = started.body;
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.some((t) => typeof t !== "string")) {
    throw new Error(`the jobs API did not hand back job tokens (HTTP ${started.status}): ${JSON.stringify(started.body).slice(0, 500)}\n${s.cubeLogs(40)}`);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await getJson(url, REQUEST_TIMEOUT_MS, s.headers, { action: "get", resType: "object", tokens });
    const jobs = Object.values((body ?? {}) as Record<string, BuildJob>);
    const failed = jobs.filter((j) => typeof j.status === "string" && j.status.startsWith("failure"));
    if (failed.length > 0) {
      throw new Error(`pre-aggregation build failed: ${failed.map((j) => `${j.table}: ${j.status}`).join("; ")}\n${s.cubeLogs(60)}`);
    }
    if (jobs.length === tokens.length && jobs.every((j) => j.status === "done")) return jobs.map((j) => String(j.table)).sort();
    if (Date.now() > deadline) {
      throw new Error(`pre-aggregations were not built within ${timeoutMs / 1000}s: ${JSON.stringify(body).slice(0, 800)}\n${s.cubeLogs(60)}`);
    }
    await Bun.sleep(2000);
  }
}
