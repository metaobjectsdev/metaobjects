import type { FastifyInstance } from "fastify";
import { sql, eq, and, count } from "drizzle-orm";
import qs from "qs";
import { parseFilterParams, FilterParseError } from "./filter-parser.js";
import type { FilterAllowlist, SortAllowlist } from "./filter-allowlist.js";
import { isTruthyFlag, contractErrorCode, coerceIdForColumn, rawIdLiteral } from "./util.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user-supplied views
type AnyView = any;

/**
 * Drizzle v0.45 stores view config under this well-known Symbol.
 * Accessing `view._` on a proxy-wrapped view (empty-column .existing()) throws
 * because the proxy tries to spread `subquery._.selectedFields` which is undefined.
 * Using the symbol bypasses the proxy entirely.
 */
const VIEW_BASE_CONFIG = Symbol.for("drizzle:ViewBaseConfig");

export interface MountReadOnlyOptions {
  readonly fastify: FastifyInstance;
  readonly path: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic Drizzle client
  readonly db: any;
  readonly view: AnyView;
  readonly filterAllowlist: FilterAllowlist;
  readonly sortAllowlist: SortAllowlist;
  readonly dialect: "postgres" | "sqlite";
  /** Override default ID column name (defaults to "id"). */
  readonly idColumn?: string;
}

const REJECT_MUTATION = async (
  request: { method: string },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => {
  reply
    .code(405)
    .send({ error: "method_not_allowed", message: `${request.method} is not supported on a projection (read-only).` });
};

function getViewConfig(view: AnyView): Record<string, unknown> | undefined {
  try {
    const cfg = (view as Record<symbol, unknown>)[VIEW_BASE_CONFIG];
    if (cfg && typeof cfg === "object") return cfg as Record<string, unknown>;
  } catch {
    // ignore — proxy handler may throw on unexpected shapes
  }
  return undefined;
}

function resolveViewName(view: AnyView): string | undefined {
  const cfg = getViewConfig(view);
  if (cfg) {
    if (typeof cfg["name"] === "string") return cfg["name"] as string;
  }
  // Fallback for non-proxy shapes
  const v = view as Record<string, unknown>;
  return (
    (typeof v["__tableName"] === "string" ? v["__tableName"] as string : undefined) ??
    (typeof v["_name"] === "string" ? v["_name"] as string : undefined)
  );
}

/**
 * Detect whether a Drizzle view was declared with `.existing()` and an empty
 * column schema (`{}`). In that case, `db.select().from(view)` generates
 * `SELECT  FROM ...` (invalid SQL), and we must fall back to raw SQL.
 */
function isEmptyColumnView(view: AnyView): boolean {
  const cfg = getViewConfig(view);
  if (cfg) {
    const fields = cfg["selectedFields"] as Record<string, unknown> | undefined;
    return fields !== undefined && Object.keys(fields).length === 0;
  }
  return false;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Normalise a raw SQL result row's keys from snake_case to camelCase. */
function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}

/**
 * Execute a raw SQL read and return its rows, on EITHER dialect.
 *
 * There is no shared method: drizzle's `BaseSQLiteDatabase` has `.all()` and no
 * `.execute()`; `PgDatabase` has `.execute()` and no `.all()` at all (verified
 * against drizzle-orm's own `sqlite-core/db.d.ts` and `pg-core/db.d.ts`). So this
 * must DISPATCH — unlike the #286 sites, where the query builder is thenable on
 * both dialects and simply awaiting it was enough.
 *
 * That difference is exactly why the #286 sweep missed these. It hunted `.all()`
 * on a query BUILDER; these are `.all()` on the top-level `db` HANDLE — the libsql
 * raw-exec API, which node-postgres does not implement. BOTH read-only mounts
 * carried three each, so the Fastify adapter was broken here too despite being the
 * correct reference for the builder shape. Reported by an adopting project's code
 * review of the 0.21.4 upgrade.
 *
 * Reachable whenever `useRawSql` is true — an opaque `@sql` view body (the ADR-0043
 * escape hatch), where the view declares no columns for the query builder to select.
 *
 * The two Postgres drivers disagree on the result shape (node-postgres returns a
 * QueryResult with `.rows`, postgres-js returns the array itself), so both are
 * handled rather than betting on one.
 */
// biome-ignore lint/suspicious/noExplicitAny: driver handle is consumer-provided
async function rawRows(db: any, dialect: string | undefined, query: unknown): Promise<Record<string, unknown>[]> {
  if (dialect === "postgres") {
    const res: unknown = await db.execute(query);
    if (Array.isArray(res)) return res as Record<string, unknown>[];
    return (res as { rows?: Record<string, unknown>[] } | null)?.rows ?? [];
  }
  return (await db.all(query)) as Record<string, unknown>[];
}

export function mountReadOnlyCrudRoutes(opts: MountReadOnlyOptions): void {
  const { fastify, path, db, view, filterAllowlist, sortAllowlist, dialect } = opts;
  const idCol = opts.idColumn ?? "id";

  const viewName = resolveViewName(view);
  const useRawSql = isEmptyColumnView(view) && !!viewName;

  // ── List ──────────────────────────────────────────────────────────────────
  fastify.get(path, async (req, reply) => {
    try {
      if (useRawSql) {
        // .existing() view with no column schema — use raw SQL.
        // Simple limit/offset only; filter/sort via allowlist is not available
        // because column refs don't exist. This is sufficient for projection
        // endpoints that return small full-table results.
        const url = req.raw.url ?? "";
        const qIdx = url.indexOf("?");
        const queryString = qIdx >= 0 ? url.slice(qIdx + 1) : "";
        const parsed = qs.parse(queryString) as Record<string, unknown>;
        const limitVal = Math.min(1000, Math.max(1, Number(typeof parsed["limit"] === "string" ? parsed["limit"] : 1000)));
        const offsetVal = Math.max(0, Number(typeof parsed["offset"] === "string" ? parsed["offset"] : 0));
        const withCount = isTruthyFlag(parsed["withCount"]);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
        const rows = await rawRows(db, dialect, sql.raw(`SELECT * FROM "${viewName}" LIMIT ${limitVal} OFFSET ${offsetVal}`)) as any[];
        const camelRows = rows.map((r: Record<string, unknown>) => camelizeRow(r));
        if (!withCount) return camelRows;
        // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
        const countRows = await rawRows(db, dialect, sql.raw(`SELECT COUNT(*) AS c FROM "${viewName}"`)) as any[];
        const total: number = Number(countRows[0]?.c ?? 0);
        return { rows: camelRows, total };
      }

      const url = req.raw.url ?? "";
      const qIdx = url.indexOf("?");
      const queryString = qIdx >= 0 ? url.slice(qIdx + 1) : "";
      const parsed = qs.parse(queryString) as Record<string, unknown>;
      const withCount = isTruthyFlag(parsed["withCount"]);
      const result = parseFilterParams({
        query: parsed,
        table: view,
        allowlist: filterAllowlist,
        sortAllowlist,
        dialect,
      });
      const combinedWhere = result.where && result.searchWhere
        ? and(result.where, result.searchWhere)
        : (result.where ?? result.searchWhere);
      let q = db.select().from(view);
      if (combinedWhere) q = q.where(combinedWhere);
      if (result.orderBy) q = q.orderBy(...result.orderBy);
      if (result.limit !== undefined) q = q.limit(result.limit);
      if (result.offset !== undefined) q = q.offset(result.offset);
      // Await directly — `.all()` is libsql/better-sqlite3-only; the
      // node-postgres builder is thenable. (The useRawSql branch above keeps
      // db.all(sql.raw(...)) because that is the libsql raw-exec API, only
      // reachable for `.existing()` empty-column views which are sqlite-only.)
      const rows = await q;

      if (!withCount) return rows;

      // Count query: same WHERE, no limit/offset/orderBy.
      let cq = db.select({ c: count() }).from(view);
      if (combinedWhere) cq = cq.where(combinedWhere);
      const countRow = (await cq)[0] as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      return { rows, total };
    } catch (err) {
      if (err instanceof FilterParseError) {
        reply.code(400).send({ error: contractErrorCode(err.code), message: err.message });
        return;
      }
      throw err;
    }
  });

  // ── Get by ID ─────────────────────────────────────────────────────────────
  fastify.get(`${path}/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (useRawSql) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
      const rows = await rawRows(db, dialect, sql.raw(`SELECT * FROM "${viewName}" WHERE "${idCol}" = ${rawIdLiteral(id)} LIMIT 1`)) as any[];
      const row = rows[0] ? camelizeRow(rows[0]) : undefined;
      return row ?? reply.code(404).send({ error: "not_found" });
    }
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle table/view column ref
    const colRef = (view as any)[idCol];
    // Compare against the PK's real type — a uuid/text key must NOT go through Number().
    const idValue = coerceIdForColumn(colRef, id);
    if (idValue === undefined) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    // Await + first row rather than `.get()` (libsql/better-sqlite3-only).
    const rows = await db.select().from(view).where(
      colRef !== undefined ? eq(colRef, idValue) : undefined
    ).limit(1);
    const row = (rows as unknown[])[0];
    return row ?? reply.code(404).send({ error: "not_found" });
  });

  // ── Mutations explicitly rejected (405) ───────────────────────────────────
  fastify.post(path, REJECT_MUTATION);
  fastify.patch(`${path}/:id`, REJECT_MUTATION);
  fastify.delete(`${path}/:id`, REJECT_MUTATION);
}
