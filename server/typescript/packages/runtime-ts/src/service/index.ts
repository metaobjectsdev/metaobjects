// The mechanics a generated service shell calls (ADR-0067 layer 4, `meta gen` generator `service`).
//
// A generated operation file decides WHAT runs: which schema validates the input, which fields a
// body may name, which row it loads and writes. This module is HOW, store by store: one transaction
// (or a savepoint inside the caller's), the row lock, the dialect's read-back after a write, the
// list query, and the conversion of a refusal or a constraint failure into a result the transport
// maps to the wire. It imports drizzle-orm and nothing from a web framework, so a job, a queue
// consumer or a test calls a service exactly as a route does.
//
// The semantics are the ones `mountCrudRoutes` (../drizzle-fastify) has always answered with, so a
// service behind the thin transport passes the same shared API tests the flat routes pass.

import { and, asc, count, eq, sql, type SQL } from "drizzle-orm";
import type { ZodTypeAny, z } from "zod";
import { classifyConstraintError, logAndRedact, RedactedDatabaseError } from "../constraint-errors.js";
import { validationErrorBody } from "../route-errors.js";
import { ERROR_CODE_UNKNOWN_FIELDS, stripDeniedColumns, unknownBodyKeys } from "../wire-format.js";
import { supportsReturning, type SqlDialect } from "../sql-dialect.js";
import { coerceIdForColumn, contractErrorCode, extractRowCount, firstRow, isTruthyFlag } from "../drizzle-fastify/util.js";
import { parseFilterParams } from "../drizzle-fastify/filter-parser.js";
import { FilterParseError, pageLimit, type PageSize } from "../drizzle-fastify/list-params.js";
import type { FilterAllowlist, SortAllowlist } from "../drizzle-fastify/filter-allowlist.js";
import { ReportTooLargeError } from "../drizzle-fastify/list-params.js";
import { ReportExportError } from "../drizzle-fastify/report-export.js";
import { InvalidIdError } from "../read-only-read.js";

export type { SqlDialect } from "../sql-dialect.js";
export type { PageSize } from "../drizzle-fastify/list-params.js";
export type { FilterAllowlist, SortAllowlist } from "../drizzle-fastify/filter-allowlist.js";
// The wire mappers a generated service index builds its `<entity>ToWire` from: no framework in them.
export { timestampWire } from "../timestamp-wire.js";
export { withWire } from "../wire-format.js";
// The business-rules mechanics: permission point, state check, guarded update, hook contexts.
export * from "./rules.js";

// biome-ignore lint/suspicious/noExplicitAny: the adopter's Drizzle database, table or transaction
type Drizzle = any;

/** An error body: a short code, and whatever detail the contract gives that code. */
export interface ServiceErrorBody {
  readonly error: string;
  readonly [detail: string]: unknown;
}

/**
 * What an operation answers. A failure carries the HTTP status the REST contract gives its code
 * (docs/features/api-contract.md), so every transport maps it the same way; a caller that is not
 * HTTP reads `error.error`.
 */
export type OpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: ServiceErrorBody };

/** The status of a refusal the shell raises with no status of its own: a business refusal (ADR-0067 §4). */
export const REFUSAL_STATUS = 409;

/** Thrown inside an operation to refuse it. The transaction it was thrown in rolls back. */
export class Refusal extends Error {
  constructor(
    readonly body: ServiceErrorBody,
    readonly status: number = REFUSAL_STATUS,
  ) {
    super(body.error);
    this.name = "Refusal";
  }
}

/** Refuse the operation with `body`, answered with `status`. */
export function refuse(body: ServiceErrorBody, status: number = REFUSAL_STATUS): never {
  throw new Refusal(body, status);
}

/** The refusal of a row that is not there. */
export function notFound(): never {
  refuse({ error: "not_found" }, 404);
}

/** The options every operation takes. `A` is the app's actor type (ADR-0067 §7). */
export interface OpOptions<A = unknown> {
  /**
   * Who the operation runs for. The shell never looks inside it: it passes it to the policy and to
   * the hooks, bodies and event hook. A `@public` operation and the derived CRUD verbs run without one.
   */
  readonly actor?: A | undefined;
  /**
   * A transaction the caller opened, for a job that runs several operations atomically. A write
   * runs in a savepoint inside it, so a refusal undoes this operation's writes and leaves the
   * caller's transaction open; a read runs on it.
   */
  readonly tx?: unknown;
}

/**
 * Run a write operation in one transaction: a new one on `db`, or a savepoint inside `tx`. A
 * refusal rolls the transaction back and is answered as a failed result, as is a write the
 * database refused on a constraint. Any other failure is logged and rethrown redacted, with no
 * SQL in it.
 */
export async function inWriteTransaction<T>(
  db: unknown,
  tx: unknown,
  fn: (tx: Drizzle) => Promise<T>,
): Promise<OpResult<T>> {
  const scope: Drizzle = tx ?? db;
  try {
    const value = isSyncSqlite(scope)
      ? await syncSqliteTransaction(scope, tx !== undefined, fn)
      : await scope.transaction(fn);
    return { ok: true, value };
  } catch (e) {
    return failure(e);
  }
}

/** Run a read operation on `tx` when the caller passed one, else on `db`. A query opens no write transaction. */
export async function inReadScope<T>(db: unknown, tx: unknown, fn: (db: Drizzle) => Promise<T>): Promise<OpResult<T>> {
  try {
    // On a sync SQLite handle a read with no transaction of its own waits for the one in flight:
    // the connection is shared, so reading mid-transaction would see writes that may roll back.
    const value = tx === undefined && isSyncSqlite(db) ? await serialized(db, () => fn(db)) : await fn(tx ?? db);
    return { ok: true, value };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Run a write with no transaction, for a store that cannot hold one across application code
 * (Cloudflare D1; the service generator's `interactiveTransactions: false`). Each statement commits
 * on its own; a refusal or a constraint failure is answered as `inWriteTransaction` answers it.
 */
export async function withoutTransaction<T>(db: unknown, tx: unknown, fn: (db: Drizzle) => Promise<T>): Promise<OpResult<T>> {
  try {
    return { ok: true, value: await fn(tx ?? db) };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Run `fn` in one write transaction on `db` and return what it returned, for a job that runs
 * several operations atomically: pass the handle `fn` receives as each operation's `opts.tx`, and
 * each runs in a savepoint inside it. On a driver with interactive transactions this is
 * `db.transaction(fn)`. On a sync SQLite driver, whose own `transaction()` cannot await, it is the
 * same transaction the service opens for one operation. A throw rolls it all back and is rethrown.
 */
export async function withWriteTransaction<T>(db: unknown, fn: (tx: Drizzle) => Promise<T>): Promise<T> {
  const handle: Drizzle = db;
  return isSyncSqlite(handle) ? syncSqliteTransaction(handle, false, fn) : handle.transaction(fn);
}

/**
 * A sync SQLite handle (`bun:sqlite`, `better-sqlite3`): Drizzle's `resultKind` is "sync". Its
 * `transaction()` runs its callback synchronously and commits when the callback returns, so an
 * async callback would commit at its first `await` and a later refusal would roll nothing back.
 */
function isSyncSqlite(handle: Drizzle): boolean {
  return handle !== null && typeof handle === "object" && handle.resultKind === "sync" && typeof handle.run === "function";
}

/** The transaction in flight on each sync SQLite handle, which the next one waits for. */
const inFlight = new WeakMap<object, Promise<unknown>>();

/**
 * Run `fn` once every earlier `serialized` call on `handle` has settled. SQLite has one writer,
 * and a sync driver one connection, so a transaction that awaits must not interleave with another
 * operation on the same connection.
 */
async function serialized<T>(handle: Drizzle, fn: () => Promise<T>): Promise<T> {
  const before = inFlight.get(handle) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(handle, settled);
  try {
    return await run;
  } finally {
    if (inFlight.get(handle) === settled) inFlight.delete(handle);
  }
}

let savepoints = 0;

/**
 * One transaction on a sync SQLite handle, driven with statements: `BEGIN IMMEDIATE` (it takes
 * the write lock at once, so two writers cannot both read and then collide on commit), `COMMIT`,
 * `ROLLBACK` on a throw. Inside a caller's transaction (`nested`) it is a savepoint instead, and
 * takes no turn of its own: the caller holds it.
 */
async function syncSqliteTransaction<T>(handle: Drizzle, nested: boolean, fn: (tx: Drizzle) => Promise<T>): Promise<T> {
  if (nested) {
    const name = `mo_sp_${++savepoints}`;
    handle.run(sql.raw(`SAVEPOINT ${name}`));
    try {
      const value = await fn(handle);
      handle.run(sql.raw(`RELEASE SAVEPOINT ${name}`));
      return value;
    } catch (e) {
      handle.run(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
      handle.run(sql.raw(`RELEASE SAVEPOINT ${name}`));
      throw e;
    }
  }
  return serialized(handle, async () => {
    handle.run(sql.raw("BEGIN IMMEDIATE"));
    try {
      const value = await fn(handle);
      handle.run(sql.raw("COMMIT"));
      return value;
    } catch (e) {
      handle.run(sql.raw("ROLLBACK"));
      throw e;
    }
  });
}

function failure(e: unknown): OpResult<never> {
  if (e instanceof Refusal) return { ok: false, status: e.status, error: e.body };
  if (e instanceof InvalidIdError) return { ok: false, status: 400, error: { error: "invalid_id" } };
  if (e instanceof ReportTooLargeError) return { ok: false, status: 400, error: { error: "report_too_large", maxRows: e.maxRows } };
  if (e instanceof ReportExportError) return { ok: false, status: e.status, error: e.body };
  if (e instanceof FilterParseError) {
    return { ok: false, status: 400, error: { error: contractErrorCode(e.code), ...(e.details ?? {}) } };
  }
  const f = classifyConstraintError(e);
  if (f !== undefined) return { ok: false, status: f.status, error: f.body };
  logAndRedact(e);
  throw new RedactedDatabaseError();
}

/** What a write body may name. */
export interface WriteBodyRules {
  /** Every key a body may carry; another is refused with `unknown_fields`. Absent, unknown keys are dropped. */
  readonly knownFields?: readonly string[];
  /** Keys a body may carry that no write takes (a credential, a `@formExclude` field): dropped. */
  readonly writeDeniedColumns?: readonly string[];
}

/**
 * Validate a write body against its create or update schema: the keys first (`unknown_fields`),
 * then the schema, which stamps what it declares (`@autoSet`) and lists every issue
 * (`validation`).
 */
export function validateBody<S extends ZodTypeAny>(schema: S, body: unknown, rules: WriteBodyRules): z.output<S> {
  const unknown = unknownBodyKeys(body, rules.knownFields);
  if (unknown.length > 0) refuse({ error: ERROR_CODE_UNKNOWN_FIELDS, fields: unknown }, 400);
  const parsed = schema.safeParse(stripDeniedColumns(body, rules.writeDeniedColumns));
  if (!parsed.success) refuse(validationErrorBody(parsed.error.issues) as unknown as ServiceErrorBody, 400);
  return parsed.data;
}

/**
 * The condition that addresses the row of `table` whose `keyField` is `id`, compared as the column
 * stores it, or a refusal (`invalid_id`) when `id` is not the canonical spelling of a key: a
 * numeric-looking id on a text key stays text, and `0x1` is no numeric key.
 *
 * Built here rather than in the generated file, so the condition and the queries that take it
 * come from one drizzle-orm: a generated file never hands this module a `SQL` of its own copy.
 */
export function keyCondition(table: Drizzle, keyField: string, id: string | number): SQL {
  const column = table[keyField];
  const key = coerceIdForColumn(column, String(id));
  if (key === undefined) refuse({ error: "invalid_id" }, 400);
  return eq(column, key);
}

/** Does this dialect lock a row read for update? SQLite has no row lock: its writer lock is the whole database. */
function locksRows(dialect: SqlDialect): boolean {
  return dialect === "postgres" || dialect === "mysql";
}

/** Read one row by `cond`, locked for the rest of the transaction where the dialect has a row lock. */
export async function loadForWrite(tx: Drizzle, table: Drizzle, cond: SQL, dialect: SqlDialect): Promise<Record<string, unknown> | undefined> {
  let q = tx.select().from(table).where(cond).limit(1).$dynamic();
  if (locksRows(dialect)) q = q.for("update");
  const rows = (await q) as Record<string, unknown>[];
  return rows[0];
}

/** Read one row by `cond`, or undefined. */
export async function readOne(db: Drizzle, src: Drizzle, cond: SQL): Promise<Record<string, unknown> | undefined> {
  return (await firstRow(db, src, cond)) as Record<string, unknown> | undefined;
}

/**
 * Insert `values` and read the written row back. MySQL has no RETURNING, so there the row is read
 * back by its key: the one the body assigned, else the one the database generated.
 */
export async function insertRow(
  tx: Drizzle,
  table: Drizzle,
  values: Record<string, unknown>,
  dialect: SqlDialect,
  keyField = "id",
): Promise<Record<string, unknown>> {
  if (supportsReturning(dialect)) {
    return ((await tx.insert(table).values(values).returning()) as Record<string, unknown>[])[0]!;
  }
  const [inserted] = (await tx.insert(table).values(values).$returningId()) as Array<Record<string, unknown> | undefined>;
  const key = values[keyField] ?? inserted?.[keyField];
  return (await readOne(tx, table, eq(table[keyField], key))) as Record<string, unknown>;
}

/** Update the row `cond` names with `data` and read it back. */
export async function updateRow(
  tx: Drizzle,
  table: Drizzle,
  data: Record<string, unknown>,
  cond: SQL,
  dialect: SqlDialect,
): Promise<Record<string, unknown> | undefined> {
  if (supportsReturning(dialect)) {
    return ((await tx.update(table).set(data).where(cond).returning()) as Record<string, unknown>[])[0];
  }
  await tx.update(table).set(data).where(cond);
  return readOne(tx, table, cond);
}

/** Delete the rows `cond` names, and say how many went. */
export async function deleteRows(tx: Drizzle, table: Drizzle, cond: SQL): Promise<number> {
  return extractRowCount(await tx.delete(table).where(cond));
}

/** How a list reads its source. */
export interface ListSpec {
  readonly filterAllowlist: FilterAllowlist;
  readonly sortAllowlist: SortAllowlist;
  readonly dialect: SqlDialect;
  /** The project's page size (`api.pagination`); absent, a list with no `limit` answers 50 rows. */
  readonly pagination?: PageSize;
  /** The key field a list with no `sort` is ordered by, so a page is stable. Default `id`. */
  readonly keyField?: string;
  /**
   * A condition every row of the list meets besides the query's filter: a single-table subtype's
   * discriminator (`scopeCondition`), so its list answers its own rows only.
   */
  readonly scope?: SQL;
}

/** A page of a list, and the count of every row the filter matches when the query asked for it (`withCount`). */
export interface ListPage<T> {
  readonly rows: T[];
  readonly total?: number;
}

/**
 * The list query, as the bracketed tree a query string parses to
 * (`{ filter: { name: { like: "A%" } }, sort: "name:asc", limit: "10" }`). A job passes the same
 * tree a route parses from its URL.
 */
export type ListQueryInput = Record<string, unknown>;

/**
 * Read a page of `src`: the filter, search, sort and page of `query`, checked against the
 * allowlists, ordered by the key when the query names no sort. A refused query is answered as the
 * REST contract answers it (`invalid_filter_field`, `invalid_sort`, `limit_too_large`, ...).
 */
export async function listRows(db: Drizzle, src: Drizzle, query: ListQueryInput, spec: ListSpec): Promise<ListPage<Record<string, unknown>>> {
  const parsed = parseFilterParams({
    query,
    table: src,
    allowlist: spec.filterAllowlist,
    sortAllowlist: spec.sortAllowlist,
    dialect: spec.dialect,
  });
  const where = and(...[parsed.where, parsed.searchWhere, spec.scope].filter((c): c is SQL => c !== undefined));
  let q = db.select().from(src).$dynamic();
  if (where) q = q.where(where);
  if (parsed.orderBy) q = q.orderBy(...parsed.orderBy);
  else if (src[spec.keyField ?? "id"] !== undefined) q = q.orderBy(asc(src[spec.keyField ?? "id"]));
  q = q.limit(pageLimit(parsed.limit, spec.pagination));
  if (parsed.offset !== undefined) q = q.offset(parsed.offset);
  const rows = (await q) as Record<string, unknown>[];
  if (!isTruthyFlag(query.withCount)) return { rows };
  let cq = db.select({ c: count() }).from(src).$dynamic();
  if (where) cq = cq.where(where);
  const countRow = (await cq)[0] as { c: number } | undefined;
  return { rows, total: countRow?.c ?? 0 };
}

/** `cond`, and `scope` when there is one: a single-table subtype's row is addressed within its own rows. */
export function scoped(cond: SQL, scope: SQL | undefined): SQL {
  return scope === undefined ? cond : and(cond, scope)!;
}

/** The condition a single-table subtype's rows meet: its discriminator `field` holds `value`. */
export function scopeCondition(table: Drizzle, field: string, value: string): SQL {
  return eq(table[field], value);
}

/**
 * The row a write to a write-through entity's table just wrote, read back through its replica
 * view by key, so the answer carries the view's derived columns. Answers the written row when the
 * view has none (it never 500s a write that succeeded).
 */
export async function readThroughView(db: Drizzle, view: Drizzle, keyField: string, written: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await readOne(db, view, eq(view[keyField], written[keyField]))) ?? written;
}

// How a read-only object (a projection, a served report) and a many-to-many traversal are read: the
// same functions the flat routes call, so the service answers what they answer.
export { readOnlyGet, readOnlyList, type ReadOnlyPage, type ReadOnlySpec } from "../read-only-read.js";
export { m2mRelated, type M2mSpec } from "../m2m-read.js";
export type { ReportExportSpec } from "../drizzle-fastify/report-export.js";
