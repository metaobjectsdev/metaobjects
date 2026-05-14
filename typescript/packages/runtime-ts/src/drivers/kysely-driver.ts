import type { Kysely, ExpressionBuilder, SelectQueryBuilder, Expression, SqlBool } from "kysely";
import type {
  PersistenceDriver, SelectSpec, CountSpec, InsertSpec, InsertManySpec,
  UpdateSpec, UpdateManySpec, DeleteSpec, DeleteManySpec, WhereClause, Row,
} from "../persistence-driver.js";
import { ConstraintViolationError } from "../errors.js";

// Kysely's fluent builder is heavily generic on the database schema, but this driver
// is metadata-driven and accepts any table name at runtime. Confine the schema-agnostic
// escape to these aliases rather than per-call `as any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawKysely = Kysely<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyExprBuilder = ExpressionBuilder<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = SelectQueryBuilder<any, any, any>;

export interface KyselyDriverOptions {
  db: Kysely<Record<string, Row>>;
  dialect: "sqlite" | "postgres";
}

export interface KyselyDriverPublic extends PersistenceDriver {
  /** The underlying Kysely instance — power-user escape hatch. */
  readonly db: Kysely<Record<string, Row>>;
}

export function kyselyDriver(opts: KyselyDriverOptions): KyselyDriverPublic {
  return makeKyselyDriver(opts.db, opts.dialect);
}

function makeKyselyDriver(
  db: Kysely<Record<string, Row>>,
  dialect: "sqlite" | "postgres",
): KyselyDriverPublic {
  return {
    db,
    dialect,

    async selectOne(spec: SelectSpec): Promise<Row | null> {
      let q = (db as RawKysely).selectFrom(spec.table).select(spec.columns);
      q = applyWhere(q, spec.where);
      q = applyOrderLimit(q, spec.orderBy, 1, undefined);
      const rows = await q.execute();
      return (rows[0] as Row | undefined) ?? null;
    },

    async selectMany(spec: SelectSpec): Promise<Row[]> {
      let q = (db as RawKysely).selectFrom(spec.table).select(spec.columns);
      q = applyWhere(q, spec.where);
      q = applyOrderLimit(q, spec.orderBy, spec.limit, spec.offset);
      return (await q.execute()) as Row[];
    },

    async count(spec: CountSpec): Promise<number> {
      let q = (db as RawKysely).selectFrom(spec.table).select((eb: AnyExprBuilder) => eb.fn.countAll().as("c"));
      q = applyWhere(q, spec.where);
      const rows = (await q.execute()) as Array<{ c: number | string | bigint }>;
      const v = rows[0]?.c;
      return typeof v === "number" ? v : Number(v ?? 0);
    },

    async insert(spec: InsertSpec): Promise<Row> {
      try {
        const result = await (db as RawKysely)
          .insertInto(spec.table)
          .values(spec.values)
          .returning(spec.returning)
          .executeTakeFirstOrThrow();
        return result as Row;
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async insertMany(spec: InsertManySpec): Promise<Row[]> {
      try {
        const rows = await (db as RawKysely)
          .insertInto(spec.table)
          .values(spec.rows)
          .returning(spec.returning)
          .execute();
        return rows as Row[];
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async update(spec: UpdateSpec): Promise<Row | null> {
      try {
        let q = (db as RawKysely).updateTable(spec.table).set(spec.values);
        q = applyWhere(q, spec.where);
        const rows = await q.returning(spec.returning).execute();
        return ((rows as Row[])[0]) ?? null;
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async updateMany(spec: UpdateManySpec): Promise<number> {
      try {
        let q = (db as RawKysely).updateTable(spec.table).set(spec.values);
        q = applyWhere(q, spec.where);
        const result = await q.executeTakeFirst() as { numUpdatedRows?: bigint | number } | undefined;
        return Number(result?.numUpdatedRows ?? 0);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async delete(spec: DeleteSpec): Promise<number> {
      try {
        let q = (db as RawKysely).deleteFrom(spec.table);
        q = applyWhere(q, spec.where);
        const result = await q.executeTakeFirst() as { numDeletedRows?: bigint | number } | undefined;
        return Number(result?.numDeletedRows ?? 0);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async deleteMany(spec: DeleteManySpec): Promise<number> {
      try {
        let q = (db as RawKysely).deleteFrom(spec.table);
        q = applyWhere(q, spec.where);
        const result = await q.executeTakeFirst() as { numDeletedRows?: bigint | number } | undefined;
        return Number(result?.numDeletedRows ?? 0);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async transaction<T>(fn: (txDriver: PersistenceDriver) => Promise<T>): Promise<T> {
      return await db.transaction().execute(async (trx) => {
        const txDriver = makeKyselyDriver(trx as Kysely<Record<string, Row>>, dialect);
        return await fn(txDriver);
      });
    },
  };
}

interface HasWhere<Q> {
  where(cb: (eb: AnyExprBuilder) => Expression<SqlBool>): Q;
}

function applyWhere<Q extends HasWhere<Q>>(q: Q, where: WhereClause | undefined): Q {
  if (!where) return q;
  return q.where((eb: AnyExprBuilder) => buildExpression(eb, where));
}

function buildExpression(eb: AnyExprBuilder, w: WhereClause): Expression<SqlBool> {
  switch (w.kind) {
    case "eq": return w.value === null ? eb(w.column, "is", null) : eb(w.column, "=", w.value);
    case "ne": return w.value === null ? eb(w.column, "is not", null) : eb(w.column, "<>", w.value);
    case "gt": return eb(w.column, ">", w.value);
    case "gte": return eb(w.column, ">=", w.value);
    case "lt": return eb(w.column, "<", w.value);
    case "lte": return eb(w.column, "<=", w.value);
    case "like": return eb(w.column, "like", w.pattern);
    case "in": return eb(w.column, "in", w.values);
    case "isNull": return w.not ? eb(w.column, "is not", null) : eb(w.column, "is", null);
    case "and": return eb.and(w.clauses.map((c: WhereClause) => buildExpression(eb, c)));
    default: {
      const exhaustive: never = w;
      throw new Error(`Unhandled WhereClause kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function applyOrderLimit(
  q: AnyQuery,
  orderBy: { column: string; direction: "asc" | "desc" }[] | undefined,
  limit: number | undefined,
  offset: number | undefined,
): AnyQuery {
  let out = q;
  if (orderBy) {
    for (const ob of orderBy) {
      out = out.orderBy(ob.column, ob.direction);
    }
  }
  if (limit !== undefined) out = out.limit(limit);
  if (offset !== undefined) out = out.offset(offset);
  return out;
}

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

  // Postgres pg driver attaches SQLSTATE on `.code`.
  if (code === "23505") return new ConstraintViolationError(msg, { kind: "unique", table, cause: err });
  if (code === "23503") return new ConstraintViolationError(msg, { kind: "foreign_key", table, cause: err });
  if (code === "23502") return new ConstraintViolationError(msg, { kind: "not_null", table, cause: err });
  if (code === "23514") return new ConstraintViolationError(msg, { kind: "check", table, cause: err });

  return err;
}

// libsql wraps better-sqlite3, which maps SQLite extended error codes to
// strings like SQLITE_CONSTRAINT_UNIQUE. Older/server-mode libsql may only
// surface SQLITE_CONSTRAINT and signal the kind in the message — fall through
// to message-parse in that case.
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
