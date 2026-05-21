// Concrete impls: kyselyDriver (real DBs), inMemoryDriver (tests).
// The driver IS the unit of transaction — transaction(fn) yields a tx-scoped sub-driver.
// Java analog: ObjectConnection.

export type Dialect = "sqlite" | "postgres" | "memory";

export type PrimitiveValue = string | number | boolean;

export type WhereClause =
  | { kind: "eq" | "ne"; column: string; value: PrimitiveValue | null }
  | { kind: "gt" | "gte" | "lt" | "lte"; column: string; value: number | string }
  | { kind: "in"; column: string; values: PrimitiveValue[] }
  | { kind: "like"; column: string; pattern: string }
  | { kind: "isNull"; column: string; not: boolean }
  | { kind: "and"; clauses: WhereClause[] };

export interface OrderBy {
  column: string;
  direction: "asc" | "desc";
}

export type Row = Record<string, unknown>;

export interface SelectSpec {
  table: string;
  /** PK columns are always included by the caller. */
  columns: string[];
  where?: WhereClause;
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
}

export interface CountSpec {
  table: string;
  where?: WhereClause;
}

export interface InsertSpec {
  table: string;
  values: Row;
  /** Columns to return — driver handles RETURNING / lastInsertId per dialect. */
  returning: string[];
}

export interface InsertManySpec {
  table: string;
  rows: Row[];
  returning: string[];
}

export interface UpdateSpec {
  table: string;
  values: Row;
  where: WhereClause;
  returning: string[];
}

export interface UpdateManySpec {
  table: string;
  values: Row;
  where: WhereClause;
}

export interface DeleteSpec {
  table: string;
  where: WhereClause;
}

export interface DeleteManySpec {
  table: string;
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
