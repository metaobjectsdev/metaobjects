import { Kysely } from "kysely";
import { BunSqliteDialect, isBun } from "./bun-sqlite-dialect.js";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { installCommand } from "./pm-detect.js";

/**
 * The directory a dynamic `import()` of a DB driver resolves from: the project whose
 * `node_modules` holds `@metaobjectsdev/cli`. `undefined` when the CLI is not running from
 * an installed package (a source checkout), where there is no one place to name.
 */
export function cliInstallRoot(moduleUrl: string): string | undefined {
  const path = moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl;
  const marker = `${sep}node_modules${sep}@metaobjectsdev${sep}`;
  const i = path.lastIndexOf(marker);
  return i === -1 ? undefined : path.slice(0, i);
}

/**
 * A missing driver says WHERE it must be installed. In a monorepo the package that
 * depends on the CLI need not be the one that runs the app, and installing the driver in
 * the wrong one changes nothing.
 */
export function missingDriverMessage(
  dialect: string, pkg: string, root: string | undefined, cmd: string,
): string {
  const where = root === undefined
    ? "where @metaobjectsdev/cli is installed"
    : `where @metaobjectsdev/cli is installed (${root})`;
  return `dialect '${dialect}' requires '${pkg}', resolvable from ${where} — in a monorepo, ` +
    `the package that depends on the CLI, not necessarily the one that runs your app. ` +
    `Install it there: '${cmd}'`;
}

async function missingDriver(dialect: string, pkg: string): Promise<Error> {
  const root = cliInstallRoot(import.meta.url);
  const cmd = await installCommand(pkg, root ?? process.cwd());
  return new Error(missingDriverMessage(dialect, pkg, root, cmd));
}

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
        throw await missingDriver("sqlite", "@libsql/kysely-libsql");
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
    throw await missingDriver("postgres", "pg");
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
