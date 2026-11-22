import type { Kysely, ExpressionBuilder, SelectQueryBuilder, Expression, SqlBool } from "kysely";
import type {
  PersistenceDriver, SelectSpec, CountSpec, InsertSpec, InsertManySpec,
  UpdateSpec, UpdateManySpec, DeleteSpec, DeleteManySpec, WhereClause, Row, CompareOp, Operand,
} from "../persistence-driver.js";
import { ConstraintViolationError } from "../errors.js";
import { likePatternToGlob } from "../drizzle-fastify/list-query.js";
import { arraysAsJsonText, insertedKey, mysqlConstraintKind } from "./mysql-support.js";

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
  /** `mysql`: build the Kysely instance with `MysqlDialect` over a mysql2 pool created with
   *  `timezone: "Z"` (DATETIME then holds the UTC wall clock). */
  dialect: "sqlite" | "postgres" | "mysql";
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
  dialect: "sqlite" | "postgres" | "mysql",
): KyselyDriverPublic {
  // Neither SQLite nor MySQL has an array type: a scalar array is bound as JSON text.
  const bindable = (values: Row): Row => (dialect === "postgres" ? values : arraysAsJsonText(values));

  // The builder for a relation: qualified by its @schema where the engine has schemas.
  const on = (schema: string | undefined): RawKysely =>
    schema !== undefined && dialect !== "sqlite" ? (db as RawKysely).withSchema(schema) : (db as RawKysely);

  // MySQL has no RETURNING: insert, then read the row back by its key.
  async function insertAndReadBack(table: string, schema: string | undefined, values: Row, returning: string[], key: string[] | undefined): Promise<Row> {
    const result = await on(schema).insertInto(table).values(bindable(values)).executeTakeFirst() as
      { insertId?: bigint | number } | undefined;
    const keyValues = key !== undefined && key.length > 0 ? insertedKey(key, values, result?.insertId) : undefined;
    if (keyValues === undefined) {
      throw new Error(`kyselyDriver.insert: cannot read back the row inserted into '${table}' (no primary-key value)`);
    }
    let q = on(schema).selectFrom(table).select(returning);
    for (const [col, v] of Object.entries(keyValues)) q = q.where(col, "=", v);
    return (await q.executeTakeFirstOrThrow()) as Row;
  }

  return {
    db,
    dialect,

    async selectOne(spec: SelectSpec): Promise<Row | null> {
      let q = on(spec.schema).selectFrom(spec.table).select(spec.columns);
      q = applyWhere(q, spec.where, dialect);
      q = applyOrderLimit(q, spec.orderBy, 1, undefined);
      const rows = await q.execute();
      return (rows[0] as Row | undefined) ?? null;
    },

    async selectMany(spec: SelectSpec): Promise<Row[]> {
      let q = on(spec.schema).selectFrom(spec.table).select(spec.columns);
      q = applyWhere(q, spec.where, dialect);
      q = applyOrderLimit(q, spec.orderBy, spec.limit, spec.offset);
      return (await q.execute()) as Row[];
    },

    async count(spec: CountSpec): Promise<number> {
      let q = on(spec.schema).selectFrom(spec.table).select((eb: AnyExprBuilder) => eb.fn.countAll().as("c"));
      q = applyWhere(q, spec.where, dialect);
      const rows = (await q.execute()) as Array<{ c: number | string | bigint }>;
      const v = rows[0]?.c;
      return typeof v === "number" ? v : Number(v ?? 0);
    },

    async insert(spec: InsertSpec): Promise<Row> {
      try {
        if (dialect === "mysql") return await insertAndReadBack(spec.table, spec.schema, spec.values, spec.returning, spec.key);
        const result = await on(spec.schema)
          .insertInto(spec.table)
          .values(bindable(spec.values))
          .returning(spec.returning)
          .executeTakeFirstOrThrow();
        return result as Row;
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async insertMany(spec: InsertManySpec): Promise<Row[]> {
      try {
        if (dialect === "mysql") {
          const out: Row[] = [];
          for (const row of spec.rows) out.push(await insertAndReadBack(spec.table, spec.schema, row, spec.returning, spec.key));
          return out;
        }
        const rows = await on(spec.schema)
          .insertInto(spec.table)
          .values(spec.rows.map(bindable))
          .returning(spec.returning)
          .execute();
        return rows as Row[];
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async update(spec: UpdateSpec): Promise<Row | null> {
      try {
        let q = on(spec.schema).updateTable(spec.table).set(bindable(spec.values));
        q = applyWhere(q, spec.where, dialect);
        if (dialect === "mysql") {
          const result = await q.executeTakeFirst() as { numUpdatedRows?: bigint | number } | undefined;
          if (spec.key !== undefined && Number(result?.numUpdatedRows ?? 0) === 0) return null;
          let s = on(spec.schema).selectFrom(spec.table).select(spec.returning);
          s = applyWhere(s, spec.key ?? spec.where, dialect);
          return ((await s.executeTakeFirst()) as Row | undefined) ?? null;
        }
        const rows = await q.returning(spec.returning).execute();
        return ((rows as Row[])[0]) ?? null;
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async updateMany(spec: UpdateManySpec): Promise<number> {
      try {
        let q = on(spec.schema).updateTable(spec.table).set(bindable(spec.values));
        q = applyWhere(q, spec.where, dialect);
        const result = await q.executeTakeFirst() as { numUpdatedRows?: bigint | number } | undefined;
        return Number(result?.numUpdatedRows ?? 0);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async delete(spec: DeleteSpec): Promise<number> {
      try {
        let q = on(spec.schema).deleteFrom(spec.table);
        q = applyWhere(q, spec.where, dialect);
        const result = await q.executeTakeFirst() as { numDeletedRows?: bigint | number } | undefined;
        return Number(result?.numDeletedRows ?? 0);
      } catch (err) {
        throw mapDriverError(err, spec.table, dialect);
      }
    },

    async deleteMany(spec: DeleteManySpec): Promise<number> {
      try {
        let q = on(spec.schema).deleteFrom(spec.table);
        q = applyWhere(q, spec.where, dialect);
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

function applyWhere<Q extends HasWhere<Q>>(q: Q, where: WhereClause | undefined, dialect: KyselyDialect): Q {
  if (!where) return q;
  return q.where((eb: AnyExprBuilder) => buildExpression(eb, where, dialect));
}

type KyselyDialect = "sqlite" | "postgres" | "mysql";

/**
 * `like` is case-SENSITIVE SQL LIKE on every engine (ADR-0049). Postgres LIKE already is.
 * SQLite's is not, so it is the core `glob(pattern, value)` function over the translated
 * pattern. MySQL's follows the column's collation (case-insensitive by default), so both
 * sides are compared as binary strings. (Kysely, an optional peer, is only TYPE-imported
 * here, so there is no `sql` tag for a `COLLATE` clause; binary matching differs from it only
 * in `_` matching one byte, not one character, of a multi-byte character.)
 */
function caseSensitiveLike(eb: AnyExprBuilder, column: string, pattern: string, dialect: KyselyDialect): Expression<SqlBool> {
  if (dialect === "sqlite") return eb(eb.fn("glob", [eb.val(likePatternToGlob(pattern)), eb.ref(column)]), "=", 1);
  if (dialect === "mysql") return eb(eb.cast(eb.ref(column), "binary"), "like", eb.cast(eb.val(pattern), "binary"));
  return eb(column, "like", pattern);
}

/** Case-insensitive LIKE: Postgres ILIKE; SQLite's native LIKE (it folds ASCII case); MySQL
 *  folds both sides, because its LIKE follows the column's collation. */
function caseInsensitiveLike(eb: AnyExprBuilder, column: string, pattern: string, dialect: KyselyDialect): Expression<SqlBool> {
  if (dialect === "postgres") return eb(column, "ilike", pattern);
  if (dialect === "mysql") return eb(eb.fn("lower", [eb.ref(column)]), "like", eb.fn("lower", [eb.val(pattern)]));
  return eb(column, "like", pattern);
}

function buildExpression(eb: AnyExprBuilder, w: WhereClause, dialect: KyselyDialect): Expression<SqlBool> {
  switch (w.kind) {
    case "eq": return w.value === null ? eb(w.column, "is", null) : eb(w.column, "=", w.value);
    case "ne": return w.value === null ? eb(w.column, "is not", null) : eb(w.column, "<>", w.value);
    case "gt": return eb(w.column, ">", w.value);
    case "gte": return eb(w.column, ">=", w.value);
    case "lt": return eb(w.column, "<", w.value);
    case "lte": return eb(w.column, "<=", w.value);
    case "like": return caseSensitiveLike(eb, w.column, w.pattern, dialect);
    case "ilike": return caseInsensitiveLike(eb, w.column, w.pattern, dialect);
    case "in": return eb(w.column, "in", w.values);
    case "isNull": return w.not ? eb(w.column, "is not", null) : eb(w.column, "is", null);
    case "and": return eb.and(w.clauses.map((c: WhereClause) => buildExpression(eb, c, dialect)));
    case "or": return eb.or(w.clauses.map((c: WhereClause) => buildExpression(eb, c, dialect)));
    case "not": return eb.not(buildExpression(eb, w.clause, dialect));
    case "compare": return eb(kyselyOperand(eb, w.left), KYSELY_COMPARE[w.op], kyselyOperand(eb, w.right));
    case "nullTest": return eb(kyselyOperand(eb, w.operand), w.not ? "is not" : "is", null);
    default: {
      const exhaustive: never = w;
      throw new Error(`Unhandled WhereClause kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const KYSELY_COMPARE = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const satisfies Record<CompareOp, string>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kyselyOperand(eb: AnyExprBuilder, o: Operand): any {
  if ("column" in o) return eb.ref(o.column);
  if ("value" in o) return eb.val(o.value);
  return eb.fn("coalesce", o.coalesce.map((x) => kyselyOperand(eb, x)));
}

function applyOrderLimit(
  q: AnyQuery,
  orderBy: { column: string; direction: "asc" | "desc" }[] | undefined,
  limit: number | undefined,
  offset: number | undefined,
): AnyQuery {
  let out = q;
  if (orderBy) {
    // Nulls sort as larger than any value on every engine (ASC last, DESC first), which is
    // Postgres's default. A leading `col IS NULL` key says it in plain SQL: Kysely is an
    // optional peer here, so no raw `NULLS LAST` fragment, and MySQL has no such clause.
    for (const ob of orderBy) {
      out = out.orderBy((eb: AnyExprBuilder) => eb(ob.column, "is", null), ob.direction);
      out = out.orderBy(ob.column, ob.direction);
    }
  }
  if (limit !== undefined) out = out.limit(limit);
  // SQLite and MySQL have no OFFSET without a LIMIT (the bare clause is a syntax error),
  // so an offset alone gets a limit no result can reach. Postgres takes the same statement.
  else if (offset !== undefined) out = out.limit(Number.MAX_SAFE_INTEGER);
  if (offset !== undefined) out = out.offset(offset);
  return out;
}

function mapDriverError(err: unknown, table: string, dialect: "sqlite" | "postgres" | "mysql"): unknown {
  if (!(err instanceof Error)) return err;
  const msg = err.message;
  const code = (err as { code?: string }).code;

  if (dialect === "mysql") {
    const kind = mysqlConstraintKind(err);
    return kind === null ? err : new ConstraintViolationError(msg, { kind, table, cause: err });
  }

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
