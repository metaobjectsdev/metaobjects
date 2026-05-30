// A Kysely SQLite dialect backed by Bun's built-in `bun:sqlite`.
//
// WHY: the standalone `meta` binary is produced with `bun build --compile`,
// which embeds the Bun runtime but CANNOT bundle native node addons. The
// default sqlite driver (`@libsql/kysely-libsql`) loads a platform-native
// `.node` addon (`@libsql/linux-x64-gnu` etc.) via a runtime require that the
// single-file binary's virtual filesystem can't resolve — so libsql fails
// inside the compiled binary with `Cannot find module '@libsql/linux-x64-gnu'`.
//
// `bun:sqlite` ships *inside* the Bun runtime that `--compile` embeds, so it
// needs no on-disk addon. This dialect is therefore the sqlite driver the
// standalone binary uses. The npm/Node distribution keeps using libsql (this
// module is only loaded when running under Bun — see buildKyselyFromUrl).
//
// The `bun:sqlite` import is dynamic + typed loosely so the tsc → Node build
// (which has no `bun:sqlite` module) never tries to resolve it statically.

import {
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseIntrospector,
  type Kysely,
  type DialectAdapter,
  type QueryCompiler,
} from "kysely";

/** Minimal structural view of a `bun:sqlite` Database — only what we use. */
interface BunSqliteDatabase {
  query(sql: string): BunSqliteStatement;
  run(sql: string): void;
  close(): void;
}
interface BunSqliteStatement {
  all(...params: readonly unknown[]): unknown[];
  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

/**
 * Open a `bun:sqlite` database for a `file:`/`libsql:` URL (or a bare path).
 * Throws when not running under Bun (no `bun:sqlite` module).
 */
async function openBunSqlite(url: string): Promise<BunSqliteDatabase> {
  // `bun:sqlite` is a Bun built-in; the dynamic specifier keeps Node/tsc from
  // resolving it. The cast is necessary because there's no ambient type here.
  const mod = (await import("bun:sqlite")) as unknown as {
    Database: new (filename: string) => BunSqliteDatabase;
  };
  // Strip a file:/libsql: scheme to a plain filesystem path; `:memory:` stays.
  let filename = url;
  const schemeMatch = /^(file|libsql):\/\/(.*)$/i.exec(url) ?? /^(file|libsql):(.*)$/i.exec(url);
  if (schemeMatch) filename = schemeMatch[2] ?? "";
  if (filename === "") filename = ":memory:";
  return new mod.Database(filename);
}

class BunSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: BunSqliteDatabase) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.db.query(sql);
    const params = parameters as readonly unknown[];
    // SELECT-shaped statements return rows; everything else reports counts.
    const isReturningRows = /^\s*(select|with|pragma)\b/i.test(sql);
    if (isReturningRows) {
      const rows = stmt.all(...params) as R[];
      return { rows };
    }
    const info = stmt.run(...params);
    return {
      numAffectedRows: BigInt(info.changes),
      insertId: BigInt(info.lastInsertRowid),
      rows: [],
    };
  }

  // Async generator that never yields by design — streaming is unsupported.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("bun:sqlite dialect does not support streaming");
  }
}

class BunSqliteDriver implements Driver {
  private db: BunSqliteDatabase | undefined;
  private connection: BunSqliteConnection | undefined;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    this.db = await openBunSqlite(this.url);
    this.connection = new BunSqliteConnection(this.db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.connection === undefined) throw new Error("bun:sqlite driver not initialized");
    return this.connection;
  }

  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "begin", parameters: [], query: { kind: "RawNode" } as never });
  }
  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "commit", parameters: [], query: { kind: "RawNode" } as never });
  }
  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "rollback", parameters: [], query: { kind: "RawNode" } as never });
  }

  async releaseConnection(): Promise<void> {
    /* single shared connection — nothing to release */
  }

  async destroy(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    this.connection = undefined;
  }
}

/** Kysely Dialect backed by `bun:sqlite`. */
export class BunSqliteDialect implements Dialect {
  constructor(private readonly url: string) {}
  createDriver(): Driver {
    return new BunSqliteDriver(this.url);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }
  createIntrospector(db: Kysely<Record<string, unknown>>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/** True when running under the Bun runtime (where `bun:sqlite` is available). */
export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}
