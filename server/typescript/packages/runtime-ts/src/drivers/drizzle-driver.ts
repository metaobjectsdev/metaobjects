// Drizzle driver for ObjectManager.
//
// Lets a consumer that already has Drizzle wired up (schema, connection, types)
// also expose the same database via ObjectManager — no second connection, no
// separate ORM. The driver is dynamic: it resolves table names from the user's
// schema object at construction time and dispatches per-request.
//
// Why exists: runtime-ts ships with Kysely + in-memory drivers, but most TS
// apps use Drizzle. Shipping a Drizzle driver lets ObjectManager layer on top
// of an existing Drizzle setup instead of forcing a parallel ORM stack.
//
// Java analog: ObjectConnection backed by a JDBC DataSource.

import {
  and as drzAnd,
  or as drzOr,
  eq as drzEq,
  ne as drzNe,
  gt as drzGt,
  gte as drzGte,
  lt as drzLt,
  lte as drzLte,
  like as drzLike,
  inArray as drzInArray,
  isNull as drzIsNull,
  isNotNull as drzIsNotNull,
  asc as drzAsc,
  desc as drzDesc,
  count as drzCount,
  getTableName,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import type {
  PersistenceDriver,
  SelectSpec,
  CountSpec,
  InsertSpec,
  InsertManySpec,
  UpdateSpec,
  UpdateManySpec,
  DeleteSpec,
  DeleteManySpec,
  WhereClause,
  Row,
} from "../persistence-driver.js";
import { ConstraintViolationError } from "../errors.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Minimal Drizzle DB shape we need. We don't import a concrete backend type
 * (PgDatabase / BaseSQLiteDatabase / ...) so the driver works for any of them.
 * The runtime calls match Drizzle's universal builder API.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic table dispatch
type AnyDrizzleDB = any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic table dispatch
type AnyTable = any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic table dispatch
type AnyColumn = any;

export interface DrizzleDriverOptions {
  /** A Drizzle database instance — `drizzle(...)` from any backend module. */
  db: AnyDrizzleDB;
  /**
   * The user's schema namespace, typically `import * as schema from "./schema"`.
   * The driver resolves table-name strings via `getTableName(table)` so the
   * JS variable name doesn't have to match the SQL table name.
   */
  schema: Record<string, unknown>;
  dialect: "sqlite" | "postgres";
}

export interface DrizzleDriverPublic extends PersistenceDriver {
  /** The underlying Drizzle instance — escape hatch for hand-written queries. */
  readonly db: AnyDrizzleDB;
}

export function drizzleDriver(opts: DrizzleDriverOptions): DrizzleDriverPublic {
  const tables = indexTables(opts.schema);
  return makeDrizzleDriver(opts.db, tables, opts.dialect);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** SQL table name → Drizzle table const. */
type TableIndex = Map<string, AnyTable>;

function indexTables(schema: Record<string, unknown>): TableIndex {
  const index: TableIndex = new Map();
  for (const value of Object.values(schema)) {
    if (!isDrizzleTable(value)) continue;
    const tableName = getTableName(value as AnyTable);
    if (typeof tableName === "string") index.set(tableName, value as AnyTable);
  }
  return index;
}

function isDrizzleTable(v: unknown): boolean {
  // Drizzle tables expose a non-enumerable Symbol-keyed metadata block.
  // We don't depend on the exact symbol; `getTableName` will throw for non-tables,
  // so we let `try { getTableName(v) }` discriminate.
  if (v === null || typeof v !== "object") return false;
  try {
    return typeof getTableName(v as AnyTable) === "string";
  } catch {
    return false;
  }
}

function makeDrizzleDriver(
  db: AnyDrizzleDB,
  tables: TableIndex,
  dialect: "sqlite" | "postgres",
): DrizzleDriverPublic {
  function requireTable(name: string): AnyTable {
    const t = tables.get(name);
    if (!t) {
      throw new Error(
        `drizzleDriver: no table named '${name}' in the provided schema (known: ${[...tables.keys()].sort().join(", ") || "<none>"})`,
      );
    }
    return t;
  }

  /** Build a `dbColumnName → DrizzleColumn` map for a table. */
  function columnMap(table: AnyTable): Map<string, AnyColumn> {
    const m = new Map<string, AnyColumn>();
    const cols = getTableColumns(table) as Record<string, AnyColumn>;
    for (const col of Object.values(cols)) {
      // `col.name` is the SQL column name; the JS key is the JS field name.
      const dbName = (col as { name: string }).name;
      if (typeof dbName === "string") m.set(dbName, col);
    }
    return m;
  }

  /** Build a `jsFieldName → DrizzleColumn` map (used when constructing input rows). */
  function jsColumnMap(table: AnyTable): Map<string, AnyColumn> {
    const m = new Map<string, AnyColumn>();
    const cols = getTableColumns(table) as Record<string, AnyColumn>;
    for (const [jsKey, col] of Object.entries(cols)) {
      m.set(jsKey, col);
    }
    return m;
  }

  /**
   * Convert spec.values (keyed by DB column names) into the JS-keyed object
   * Drizzle's `.values()`/`.set()` expects. Skips columns not present on the
   * table.
   */
  function toJsValues(table: AnyTable, dbKeyed: Row): Row {
    const dbToJs = new Map<string, string>();
    const cols = getTableColumns(table) as Record<string, AnyColumn>;
    for (const [jsKey, col] of Object.entries(cols)) {
      dbToJs.set((col as { name: string }).name, jsKey);
    }
    const out: Row = {};
    for (const [dbKey, val] of Object.entries(dbKeyed)) {
      const jsKey = dbToJs.get(dbKey);
      if (jsKey) out[jsKey] = val;
    }
    return out;
  }

  /**
   * Result rows from `db.select({alias: column})` are already keyed by the
   * alias we passed. Since `buildSelectMap` uses DB names as aliases, the
   * row is already in the DB-keyed shape that ObjectManager expects — no
   * translation needed.
   */
  function toDbKeyedRow(_table: AnyTable, row: Row | undefined): Row {
    return row ?? {};
  }

  function applyWhere(qb: AnyTable, where: WhereClause | undefined, table: AnyTable): unknown {
    if (!where) return undefined;
    return buildExpression(where, columnMap(table));
  }

  function applyOrder(qb: AnyDrizzleDB, orderBy: SelectSpec["orderBy"], table: AnyTable): AnyDrizzleDB {
    if (!orderBy) return qb;
    const cols = columnMap(table);
    const exprs = orderBy
      .map((ob) => {
        const c = cols.get(ob.column);
        if (!c) return undefined;
        return ob.direction === "desc" ? drzDesc(c) : drzAsc(c);
      })
      .filter((e): e is SQL => e !== undefined);
    return exprs.length > 0 ? qb.orderBy(...exprs) : qb;
  }

  function pickJsCols(table: AnyTable, dbColumnNames: string[]): AnyColumn[] {
    const map = columnMap(table);
    const out: AnyColumn[] = [];
    for (const dbName of dbColumnNames) {
      const c = map.get(dbName);
      if (c) out.push(c);
    }
    return out;
  }

  return {
    db,
    dialect,

    async selectOne(spec: SelectSpec): Promise<Row | null> {
      const table = requireTable(spec.table);
      const selectArg = buildSelectMap(table, spec.columns);
      let q = db.select(selectArg).from(table);
      const w = applyWhere(table, spec.where, table);
      if (w !== undefined) q = q.where(w);
      q = applyOrder(q, spec.orderBy, table);
      q = q.limit(1);
      const rows = await q;
      const first = (rows as Row[])[0];
      return first ? toDbKeyedRow(table, jsKeyedFromSelect(first, selectArg)) : null;
    },

    async selectMany(spec: SelectSpec): Promise<Row[]> {
      const table = requireTable(spec.table);
      const selectArg = buildSelectMap(table, spec.columns);
      let q = db.select(selectArg).from(table);
      const w = applyWhere(table, spec.where, table);
      if (w !== undefined) q = q.where(w);
      q = applyOrder(q, spec.orderBy, table);
      if (spec.limit !== undefined) q = q.limit(spec.limit);
      if (spec.offset !== undefined) q = q.offset(spec.offset);
      const rows = (await q) as Row[];
      return rows.map((r) => toDbKeyedRow(table, jsKeyedFromSelect(r, selectArg)));
    },

    async count(spec: CountSpec): Promise<number> {
      const table = requireTable(spec.table);
      let q = db.select({ c: drzCount() }).from(table);
      const w = applyWhere(table, spec.where, table);
      if (w !== undefined) q = q.where(w);
      const rows = (await q) as Array<{ c: number | string | bigint }>;
      const v = rows[0]?.c;
      return typeof v === "number" ? v : Number(v ?? 0);
    },

    async insert(spec: InsertSpec): Promise<Row> {
      const table = requireTable(spec.table);
      try {
        const result = await db
          .insert(table)
          .values(toJsValues(table, spec.values))
          .returning(buildSelectMap(table, spec.returning));
        const first = (result as Row[])[0];
        if (!first) {
          throw new Error(`drizzleDriver.insert: no row returned for '${spec.table}'`);
        }
        return toDbKeyedRow(table, jsKeyedFromSelect(first, buildSelectMap(table, spec.returning)));
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async insertMany(spec: InsertManySpec): Promise<Row[]> {
      const table = requireTable(spec.table);
      try {
        const values = spec.rows.map((r) => toJsValues(table, r));
        const rows = (await db
          .insert(table)
          .values(values)
          .returning(buildSelectMap(table, spec.returning))) as Row[];
        return rows.map((r) =>
          toDbKeyedRow(table, jsKeyedFromSelect(r, buildSelectMap(table, spec.returning))),
        );
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async update(spec: UpdateSpec): Promise<Row | null> {
      const table = requireTable(spec.table);
      try {
        let q = db.update(table).set(toJsValues(table, spec.values));
        const w = applyWhere(table, spec.where, table);
        if (w !== undefined) q = q.where(w);
        const rows = (await q.returning(buildSelectMap(table, spec.returning))) as Row[];
        const first = rows[0];
        return first
          ? toDbKeyedRow(table, jsKeyedFromSelect(first, buildSelectMap(table, spec.returning)))
          : null;
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async updateMany(spec: UpdateManySpec): Promise<number> {
      const table = requireTable(spec.table);
      try {
        let q = db.update(table).set(toJsValues(table, spec.values));
        const w = applyWhere(table, spec.where, table);
        if (w !== undefined) q = q.where(w);
        const result = await q;
        return extractRowCount(result);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async delete(spec: DeleteSpec): Promise<number> {
      const table = requireTable(spec.table);
      try {
        let q = db.delete(table);
        const w = applyWhere(table, spec.where, table);
        if (w !== undefined) q = q.where(w);
        const result = await q;
        return extractRowCount(result);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async deleteMany(spec: DeleteManySpec): Promise<number> {
      const table = requireTable(spec.table);
      try {
        let q = db.delete(table);
        const w = applyWhere(table, spec.where, table);
        if (w !== undefined) q = q.where(w);
        const result = await q;
        return extractRowCount(result);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async transaction<T>(fn: (txDriver: PersistenceDriver) => Promise<T>): Promise<T> {
      return await db.transaction(async (tx: AnyDrizzleDB) => {
        const txDriver = makeDrizzleDriver(tx, tables, dialect);
        return await fn(txDriver);
      });
    },
  };
}

/**
 * Build the `select` arg for Drizzle by mapping DB column names back to
 * the table's JS columns. Drizzle expects a `Record<aliasKey, column>`;
 * we use the DB column name as the alias key so result rows are easy to
 * normalize back to a DB-keyed shape.
 */
function buildSelectMap(table: AnyTable, dbColumnNames: string[]): Record<string, AnyColumn> {
  const allCols = getTableColumns(table) as Record<string, AnyColumn>;
  const dbToCol = new Map<string, AnyColumn>();
  for (const col of Object.values(allCols)) {
    const name = (col as { name: string }).name;
    if (typeof name === "string") dbToCol.set(name, col);
  }
  const out: Record<string, AnyColumn> = {};
  for (const dbName of dbColumnNames) {
    const c = dbToCol.get(dbName);
    if (c) out[dbName] = c;
  }
  return out;
}

/**
 * Result rows from Drizzle are already keyed by whatever alias we passed in.
 * Since we used DB names as aliases in buildSelectMap, the result row is
 * already DB-keyed — we just pass it through to keep the function symmetric.
 */
function jsKeyedFromSelect(row: Row, _selectMap: Record<string, AnyColumn>): Row {
  return row;
}

function extractRowCount(result: unknown): number {
  // Drizzle's update/delete return shape varies by backend. We support the
  // common shapes; unknown shapes fall through to 0.
  if (typeof result === "number") return result;
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const obj = result as { rowsAffected?: number | bigint; rowCount?: number };
    if (typeof obj.rowsAffected === "number") return obj.rowsAffected;
    if (typeof obj.rowsAffected === "bigint") return Number(obj.rowsAffected);
    if (typeof obj.rowCount === "number") return obj.rowCount;
  }
  return 0;
}

function buildExpression(w: WhereClause, cols: Map<string, AnyColumn>): unknown {
  switch (w.kind) {
    case "eq": {
      const c = cols.get(w.column);
      return w.value === null ? drzIsNull(c) : drzEq(c, w.value);
    }
    case "ne": {
      const c = cols.get(w.column);
      return w.value === null ? drzIsNotNull(c) : drzNe(c, w.value);
    }
    case "gt": return drzGt(cols.get(w.column), w.value);
    case "gte": return drzGte(cols.get(w.column), w.value);
    case "lt": return drzLt(cols.get(w.column), w.value);
    case "lte": return drzLte(cols.get(w.column), w.value);
    case "like": return drzLike(cols.get(w.column), w.pattern);
    case "in": return drzInArray(cols.get(w.column), w.values);
    case "isNull": return w.not ? drzIsNotNull(cols.get(w.column)) : drzIsNull(cols.get(w.column));
    case "and": {
      // drzAnd is typed as accepting SQLWrapper; our recursive return is
      // structurally compatible but typed as unknown. Cast at the boundary.
      const parts = w.clauses.map((c) => buildExpression(c, cols)) as SQL[];
      return drzAnd(...parts);
    }
    case "or": {
      const parts = w.clauses.map((c) => buildExpression(c, cols)) as SQL[];
      return drzOr(...parts);
    }
    default: {
      const exhaustive: never = w;
      throw new Error(`Unhandled WhereClause kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Error normalization — same shape as kysely-driver so callers see one error
// type regardless of which driver they wired up.
// ---------------------------------------------------------------------------

function mapDriverError(err: unknown, table: string, dialect: "sqlite" | "postgres"): unknown {
  if (!(err instanceof Error)) return err;
  const msg = err.message;
  const code = (err as { code?: string }).code;

  if (dialect === "sqlite") {
    const kind = sqliteConstraintKind(code, msg);
    if (kind !== null) {
      const field = extractSqliteField(kind, msg);
      return new ConstraintViolationError(msg, {
        kind, table, ...(field !== undefined ? { field } : {}), cause: err,
      });
    }
    return err;
  }

  // pg-style SQLSTATE codes.
  if (code === "23505") return new ConstraintViolationError(msg, { kind: "unique", table, cause: err });
  if (code === "23503") return new ConstraintViolationError(msg, { kind: "foreign_key", table, cause: err });
  if (code === "23502") return new ConstraintViolationError(msg, { kind: "not_null", table, cause: err });
  if (code === "23514") return new ConstraintViolationError(msg, { kind: "check", table, cause: err });

  return err;
}

function sqliteConstraintKind(
  code: string | undefined,
  msg: string,
): "unique" | "foreign_key" | "not_null" | "check" | null {
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return "unique";
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return "foreign_key";
  if (code === "SQLITE_CONSTRAINT_NOTNULL") return "not_null";
  if (code === "SQLITE_CONSTRAINT_CHECK") return "check";
  if (code === "SQLITE_CONSTRAINT" || code === undefined) {
    if (msg.includes("UNIQUE constraint failed")) return "unique";
    if (msg.includes("FOREIGN KEY constraint failed")) return "foreign_key";
    if (msg.includes("NOT NULL constraint failed")) return "not_null";
    if (msg.includes("CHECK constraint failed")) return "check";
  }
  return null;
}

function extractSqliteField(kind: "unique" | "foreign_key" | "not_null" | "check", msg: string): string | undefined {
  const pattern = kind === "unique" ? /UNIQUE constraint failed: ([^\s,]+)/
    : kind === "not_null" ? /NOT NULL constraint failed: ([^\s,]+)/
    : null;
  if (!pattern) return undefined;
  const m = msg.match(pattern);
  return m ? m[1]?.split(".")[1] : undefined;
}
