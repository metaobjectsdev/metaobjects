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
import type { CubeStack } from "../src/cube-container.ts";

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
      columns.push({ field: f.name, cubeKey: member, kind: "measure" });
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

export function fromCubeRow(row: Record<string, unknown>, plan: QueryPlan): NormalRow {
  const out: NormalRow = {};
  for (const c of plan.columns) {
    const key = c.derive?.fromKey ?? c.cubeKey;
    if (!(key in row)) throw new Error(`Cube's row has no '${key}': ${JSON.stringify(row)}`);
    const value = normalize(c.kind, row[key], `Cube ${key}`);
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
}

/** A request that never produced a JSON answer: refused, reset, aborted, or a body that is not JSON. */
export class TransportError extends Error {}

export async function getJson(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
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

export function errorOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return `not an object: ${JSON.stringify(body)}`;
  const e = (body as { error?: unknown }).error;
  return e === undefined ? undefined : String(e);
}

export async function getMeta(s: CubeStack, timeoutMs = REQUEST_TIMEOUT_MS): Promise<MetaResponse> {
  const { body } = await getJson(`${s.apiBase}/meta`, timeoutMs);
  const error = errorOf(body);
  if (error !== undefined) return { error, cubes: [] };
  const cubes = (body as { cubes?: unknown }).cubes;
  if (!Array.isArray(cubes)) throw new Error(`/meta answered without a cubes list: ${JSON.stringify(body).slice(0, 300)}`);
  return { cubes: cubes as MetaCube[] };
}

export function queryUrl(s: CubeStack, path: "load" | "sql", query: CubeQuery): string {
  return `${s.apiBase}/${path}?query=${encodeURIComponent(JSON.stringify(query))}`;
}

/**
 * `/v1/load`, retried every second while Cube answers `Continue wait` (a rollup is building), and
 * with backoff after a transport error (at most LOAD_TRANSPORT_RETRIES in a row), all within
 * LOAD_DEADLINE_MS.
 */
export async function load(s: CubeStack, query: CubeQuery): Promise<LoadResponse> {
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

/** The SQL Cube generates for a query (`/v1/sql`); throws when Cube answers without it. */
export async function generatedSql(s: CubeStack, query: CubeQuery): Promise<string> {
  const { status, body } = await getJson(queryUrl(s, "sql", query));
  const sql = (body as { sql?: { sql?: unknown } }).sql?.sql;
  if (!Array.isArray(sql) || typeof sql[0] !== "string") {
    throw new Error(`/v1/sql answered HTTP ${status} without SQL: ${JSON.stringify(body).slice(0, 2000)}`);
  }
  return sql[0];
}

/** The SQL Cube generates for a query, for a failure message. */
export async function cubeSql(s: CubeStack, query: CubeQuery): Promise<string> {
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
  /**
   * The model declares a rollup for this report and Cube never matches it, so it answers from the
   * source table (`preAggregation` is then undefined). Today that is a report listing ONE time
   * dimension at several grains: the `time_dimensions` entry repeats the dimension and Cube 1.7.43
   * matches no query to it (a query names a time dimension once, at one granularity).
   */
  readonly unusedRollup?: true;
}
