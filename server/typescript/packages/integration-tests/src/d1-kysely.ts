// d1-kysely.ts — a minimal Kysely dialect over a Cloudflare D1 binding, so the TypeScript
// ObjectManager can read through D1's own API (`prepare().bind().all()`), not libsql. D1 is
// SQLite at the SQL level, so the adapter, compiler and introspector are SQLite's.

import {
  CompiledQuery, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler,
  type DatabaseConnection, type Dialect, type Driver, type Kysely, type QueryResult,
} from "kysely";

/** The slice of the D1 binding this adapter uses. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: Array<Record<string, unknown>>; meta?: { changes?: number; last_row_id?: number } }>;
    };
  };
}

class D1Connection implements DatabaseConnection {
  constructor(private readonly d1: D1Like) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const r = await this.d1.prepare(q.sql).bind(...q.parameters).all();
    const rows = (r.results ?? []) as R[];
    return r.meta?.changes === undefined ? { rows } : { rows, numAffectedRows: BigInt(r.meta.changes) };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not stream queries");
  }
}

class D1Driver implements Driver {
  constructor(private readonly d1: D1Like) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> { return new D1Connection(this.d1); }
  // D1 has no interactive transactions; the report scenarios are read-only.
  async beginTransaction(): Promise<void> { throw new Error("D1 does not support interactive transactions"); }
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export function d1Dialect(d1: D1Like): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new D1Driver(d1),
    createIntrospector: (db: Kysely<unknown>) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}

