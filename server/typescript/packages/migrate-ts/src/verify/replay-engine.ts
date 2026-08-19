// An empty, throwaway database that lives INSIDE this process.
//
// The replay gate has to apply a whole committed chain from nothing. Doing that
// against the user's server would mean CREATE DATABASE — which needs CREATEDB,
// breaks behind a connection pooler, is restricted on managed Postgres, collides
// between parallel CI jobs sharing one server, and puts a DROP DATABASE next to a
// name derived from a real one (Postgres truncates identifiers at 63 bytes, so a
// long enough target derives a scratch name that truncates back ONTO the target).
// None of that is worth it when the engines run in-process: PGlite is real Postgres
// compiled to WASM, and libsql runs sqlite in memory. Nothing to provision, nothing
// to clean up, nothing to drop by mistake.
//
// Both drivers are OPTIONAL peers imported lazily. PGlite is ~22 MB of WASM and must
// not land in the node_modules of every adopter who only ever runs `meta gen`; the
// install hints mirror `buildKyselyFromUrl`'s. `cli` already depends on
// `@libsql/kysely-libsql` outright, so only a direct embedder can miss that one.
import { Kysely } from "kysely";

export interface ReplayEngine {
  /** An empty database. The caller owns applying migrations into it. */
  db: Kysely<Record<string, unknown>>;
  /** Release the engine. Safe to call more than once. */
  dispose: () => Promise<void>;
}

/** Open an empty in-process database of the given dialect. */
export async function openReplayEngine(
  dialect: "postgres" | "sqlite",
): Promise<ReplayEngine> {
  return dialect === "postgres" ? openPglite() : openMemorySqlite();
}

async function openMemorySqlite(): Promise<ReplayEngine> {
  type LibsqlDialectCtor = new (opts: { url: string }) =>
    ConstructorParameters<typeof Kysely<Record<string, unknown>>>[0]["dialect"];
  let LibsqlDialect: LibsqlDialectCtor;
  try {
    const mod = await import("@libsql/kysely-libsql");
    LibsqlDialect = mod.LibsqlDialect as unknown as LibsqlDialectCtor;
  } catch {
    throw new Error(
      `the sqlite replay engine requires '@libsql/kysely-libsql'; install it to run 'meta verify --replay'`,
    );
  }
  const db = new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: ":memory:" }) });
  return disposable(db, async () => { /* the in-memory database dies with the connection */ });
}

async function openPglite(): Promise<ReplayEngine> {
  let PGliteCtor: new () => PgliteInstance;
  try {
    const mod = await import("@electric-sql/pglite");
    PGliteCtor = mod.PGlite as unknown as new () => PgliteInstance;
  } catch {
    throw new Error(
      `the postgres replay engine requires '@electric-sql/pglite' (in-process WASM Postgres); ` +
        `install it to run 'meta verify --replay' against a postgres chain`,
    );
  }
  const { PostgresDialect } = await import("kysely");
  const pg = new PGliteCtor();
  const db = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: pgliteAsPool(pg) as never }),
  });
  return disposable(db, () => pg.close());
}

/** The slice of PGlite's surface this file uses. */
interface PgliteInstance {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; affectedRows?: number; statement?: string }>;
  close(): Promise<void>;
}

/**
 * Adapt PGlite to the `pg.Pool` shape kysely's `PostgresDialect` expects: `connect()`
 * returning a client with `query()`/`release()`, plus `end()`. PGlite offers only
 * `query`/`close`, so without this the dialect cannot drive it at all.
 *
 * PGlite is a SINGLE session, so every `connect()` hands back the same underlying
 * instance. That is correct here — a replay is strictly sequential — and it is what
 * makes a session advisory lock taken on one kysely connection visible to the next.
 *
 * `command` is read by kysely only to decide whether to report numAffectedRows; the
 * replay path never reads it, so PGlite's `statement` (or a SELECT default) suffices.
 */
function pgliteAsPool(pg: PgliteInstance): unknown {
  return {
    async connect() {
      return {
        async query(sqlText: unknown, params?: readonly unknown[]) {
          if (typeof sqlText !== "string") {
            throw new Error(`the PGlite replay engine does not support cursors`);
          }
          const r = await pg.query(sqlText, params ? [...params] : []);
          return {
            command: r.statement ?? "SELECT",
            rowCount: r.affectedRows ?? r.rows.length,
            rows: r.rows,
          };
        },
        release() { /* single session — there is no pool to return to */ },
      };
    },
    async end() {
      await pg.close();
    },
  };
}

function disposable(
  db: Kysely<Record<string, unknown>>,
  closeEngine: () => Promise<void>,
): ReplayEngine {
  let disposed = false;
  return {
    db,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // Both swallow: the engine is throwaway, and a teardown error must not mask
      // the replay verdict the caller is about to report.
      try { await db.destroy(); } catch { /* ignore */ }
      try { await closeEngine(); } catch { /* ignore */ }
    },
  };
}
