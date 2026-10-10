// cube-live-support.ts — what the Cube live checks share, whatever data source Cube reads: the
// Table F query that reproduces a report, Table I's normalization, and a client for Cube's REST
// API. cube-model.live.ts (Postgres) and cube-model-mysql.live.ts (MySQL) import it.

import { expect } from "bun:test";
import {
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

export type ColumnKind = "attribute" | "time" | "hour" | "measure";

/** One report field: its view column and the Cube row key that carries it. */
export interface PlannedColumn {
  readonly field: string;
  readonly cubeKey: string;
  readonly kind: ColumnKind;
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
        columns.push({ field: f.name, cubeKey: member, kind: "attribute" });
      } else {
        timeDimensions.push({ dimension: member, granularity: f.grain });
        columns.push({ field: f.name, cubeKey: `${member}.${f.grain}`, kind: f.grain === GRAIN_HOUR ? "hour" : "time" });
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

/** True when the string already names its offset (`Z`, `+00:00`, `-0500`). */
export const HAS_ZONE_RE = /(Z|[+-]\d{2}(:?\d{2})?)$/;

export function normalize(kind: ColumnKind, raw: unknown, where: string): string | null {
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

export function fromCubeRow(row: Record<string, unknown>, plan: QueryPlan): NormalRow {
  const out: NormalRow = {};
  for (const c of plan.columns) {
    if (!(c.cubeKey in row)) throw new Error(`Cube's row has no '${c.cubeKey}': ${JSON.stringify(row)}`);
    out[c.field] = normalize(c.kind, row[c.cubeKey], `Cube ${c.cubeKey}`);
  }
  return out;
}

export function fromViewRow(row: Record<string, string | null>, plan: QueryPlan, view: string): NormalRow {
  const want = plan.columns.map((c) => c.field).sort();
  expect(Object.keys(row).sort()).toEqual(want);
  const out: NormalRow = {};
  for (const c of plan.columns) out[c.field] = normalize(c.kind, row[c.field], `${view}.${c.field}`);
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

