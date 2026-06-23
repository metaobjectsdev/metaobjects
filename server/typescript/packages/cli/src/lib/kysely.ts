import { Kysely } from "kysely";
import { BunSqliteDialect, isBun } from "./bun-sqlite-dialect.js";
import { installCommand } from "./pm-detect.js";

export type Dialect = "sqlite" | "postgres" | "d1";

export interface KyselyHandle {
  db: Kysely<Record<string, unknown>>;
  dialect: Dialect;
  /** URL with credentials redacted, safe for display. */
  displayUrl: string;
  /** Idempotent — safe to call multiple times. */
  close: () => Promise<void>;
}

/**
 * Infer dialect from URL scheme. Throws if the scheme isn't recognized.
 */
export function inferDialect(url: string): Dialect {
  const match = /^([a-z]+):/i.exec(url);
  if (match === null) {
    throw new Error(`unrecognized URL '${url}'; expected scheme prefix like file:, libsql:, postgres:, postgresql:`);
  }
  const scheme = match[1]!.toLowerCase();
  switch (scheme) {
    case "file":
    case "libsql":
      return "sqlite";
    case "postgres":
    case "postgresql":
      return "postgres";
    default:
      throw new Error(
        `unrecognized URL scheme '${scheme}'; supported: file, libsql, postgres, postgresql`,
      );
  }
}

/**
 * Strip credentials from a URL for display. Returns unchanged if no userinfo.
 */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z]+:\/\/)([^:@/]+):([^@]+)@/i, "$1$2:***@");
}

/**
 * Construct a Kysely instance from a URL.
 *
 * For sqlite/libsql, requires `@libsql/kysely-libsql` peer dep.
 * For postgres, requires `pg` peer dep.
 *
 * Surfaces an install hint if the peer dep is missing.
 */
export async function buildKyselyFromUrl(
  url: string,
  dialectOverride?: Dialect,
): Promise<KyselyHandle> {
  const dialect = dialectOverride ?? inferDialect(url);
  const displayUrl = redactUrl(url);

  if (dialect === "d1") {
    throw new Error(
      `dialect 'd1' does not use a URL connection; use meta migrate --d1 <binding>`,
    );
  }

  if (dialect === "sqlite") {
    // Under Bun (notably the `bun build --compile` standalone binary), use the
    // built-in `bun:sqlite` driver. It ships inside the embedded Bun runtime,
    // so — unlike `@libsql/kysely-libsql`, whose platform-native `.node` addon
    // can't be bundled into a single-file binary — it works in the compiled
    // `meta` binary with no on-disk dependency. The Node/npm distribution falls
    // through to libsql below.
    let sqliteDialect: ConstructorParameters<typeof Kysely<Record<string, unknown>>>[0]["dialect"];
    if (isBun()) {
      sqliteDialect = new BunSqliteDialect(url);
    } else {
      type LibsqlDialectCtor = new (opts: { url: string }) => ConstructorParameters<typeof Kysely<Record<string, unknown>>>[0]["dialect"];
      let LibsqlDialect: LibsqlDialectCtor;
      try {
        const mod = await import("@libsql/kysely-libsql");
        LibsqlDialect = mod.LibsqlDialect as unknown as LibsqlDialectCtor;
      } catch {
        const cmd = await installCommand("@libsql/kysely-libsql", process.cwd());
        throw new Error(
          `dialect 'sqlite' requires '@libsql/kysely-libsql'; install it: '${cmd}'`,
        );
      }
      sqliteDialect = new LibsqlDialect({ url });
    }
    const db = new Kysely<Record<string, unknown>>({ dialect: sqliteDialect });
    let closed = false;
    return {
      db,
      dialect,
      displayUrl,
      close: async () => {
        if (closed) return;
        closed = true;
        try { await db.destroy(); } catch { /* swallow */ }
      },
    };
  }

  // postgres
  type PgPoolModule = { Pool: new (opts: { connectionString: string }) => unknown; default?: { Pool: new (opts: { connectionString: string }) => unknown } };
  let pg: PgPoolModule;
  let PostgresDialect: typeof import("kysely").PostgresDialect;
  try {
    pg = await import("pg") as unknown as PgPoolModule;
    ({ PostgresDialect } = await import("kysely"));
  } catch {
    throw new Error(
      `dialect 'postgres' requires 'pg'; install it: 'bun add pg'`,
    );
  }
  const PoolCtor = pg.Pool ?? pg.default?.Pool;
  if (PoolCtor === undefined) {
    throw new Error(`dialect 'postgres' requires 'pg' (no Pool export found)`);
  }
  const pool = new PoolCtor({ connectionString: url });
  const db = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: pool as never }) });
  let closed = false;
  return {
    db,
    dialect,
    displayUrl,
    close: async () => {
      if (closed) return;
      closed = true;
      try { await db.destroy(); } catch { /* swallow */ }
      try { await (pool as unknown as { end: () => Promise<void> }).end(); } catch { /* swallow */ }
    },
  };
}
