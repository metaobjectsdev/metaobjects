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
  | { kind: "isNull"; column: string; not: boolean }
  | { kind: "and"; clauses: WhereClause[] }
  | { kind: "or"; clauses: WhereClause[] };

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
