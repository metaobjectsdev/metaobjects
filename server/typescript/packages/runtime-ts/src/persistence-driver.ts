// Concrete impls: kyselyDriver (real DBs), inMemoryDriver (tests).
// The driver IS the unit of transaction — transaction(fn) yields a tx-scoped sub-driver.
// Java analog: ObjectConnection.

export type Dialect = "sqlite" | "postgres" | "mysql" | "memory";

export type PrimitiveValue = string | number | boolean;

export type WhereClause =
  | { kind: "eq" | "ne"; column: string; value: PrimitiveValue | null }
  | { kind: "gt" | "gte" | "lt" | "lte"; column: string; value: number | string }
  | { kind: "in"; column: string; values: PrimitiveValue[] }
  | { kind: "like"; column: string; pattern: string }
  /** A case-INSENSITIVE LIKE (`%`/`_` wildcards). Not a wire operator: a REST list's
   *  `?search` compiles to an OR of these over its text fields. */
  | { kind: "ilike"; column: string; pattern: string }
  | { kind: "isNull"; column: string; not: boolean }
  | { kind: "and"; clauses: WhereClause[] }
  | { kind: "or"; clauses: WhereClause[] }
  /** SQL NOT: three-valued, so NOT of an unknown (a comparison with NULL) stays unknown and matches nothing. */
  | { kind: "not"; clause: WhereClause }
  /** A comparison of two operands, either of which may be a column, a literal or a coalesce. A
   *  transition's `@condition` compiles to these (ADR-0066 §6); a NULL operand matches nothing. */
  | { kind: "compare"; op: CompareOp; left: Operand; right: Operand }
  /** IS [NOT] NULL over any operand (a column alone is `isNull`). */
  | { kind: "nullTest"; operand: Operand; not: boolean };

/** The six comparisons a `compare` clause makes. */
export type CompareOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** One side of a `compare`: a column, a bound literal, or the first non-null of several operands. */
export type Operand =
  | { column: string }
  | { value: PrimitiveValue | null }
  | { coalesce: Operand[] };

export interface OrderBy {
  column: string;
  direction: "asc" | "desc";
}

export type Row = Record<string, unknown>;

/**
 * The relation a spec reads or writes: its physical name and, when the source declares one,
 * its `@schema`. A driver qualifies the relation by the schema on an engine that has schemas,
 * so two same-named tables in two schemas stay two relations; SQLite has none and ignores it.
 */
export interface TableTarget {
  table: string;
  schema?: string;
}

export interface SelectSpec extends TableTarget {
  /** PK columns are always included by the caller. */
  columns: string[];
  where?: WhereClause;
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
}

export interface CountSpec extends TableTarget {
  where?: WhereClause;
}

export interface InsertSpec extends TableTarget {
  values: Row;
  /** Columns to return — driver handles RETURNING / lastInsertId per dialect. */
  returning: string[];
  /**
   * The primary-key columns. A dialect without RETURNING (MySQL) reads the inserted row
   * back by them; the others ignore it.
   */
  key?: string[];
}

export interface InsertManySpec extends TableTarget {
  rows: Row[];
  returning: string[];
  /** As {@link InsertSpec.key}. */
  key?: string[];
}

export interface UpdateSpec extends TableTarget {
  values: Row;
  where: WhereClause;
  returning: string[];
  /**
   * A write whose `where` no longer matches the row it wrote (a guarded update moves the state
   * its own guard tests) names the key alone here. A dialect without RETURNING (MySQL) then
   * answers no row when the statement changed none, and otherwise reads the row back by this
   * clause instead of by `where`.
   */
  key?: WhereClause;
}

export interface UpdateManySpec extends TableTarget {
  values: Row;
  where: WhereClause;
}

export interface DeleteSpec extends TableTarget {
  where: WhereClause;
}

export interface DeleteManySpec extends TableTarget {
  where: WhereClause;
}

export interface PersistenceDriver {
  readonly dialect: Dialect;

  selectOne(spec: SelectSpec): Promise<Row | null>;
  selectMany(spec: SelectSpec): Promise<Row[]>;
  count(spec: CountSpec): Promise<number>;

  insert(spec: InsertSpec): Promise<Row>;
  insertMany(spec: InsertManySpec): Promise<Row[]>;

  update(spec: UpdateSpec): Promise<Row | null>;
  updateMany(spec: UpdateManySpec): Promise<number>;

  delete(spec: DeleteSpec): Promise<number>;
  deleteMany(spec: DeleteManySpec): Promise<number>;

  transaction<T>(fn: (txDriver: PersistenceDriver) => Promise<T>): Promise<T>;
}
