// The per-dialect Drizzle surface codegen emits against: the `*-core` module, the table and
// view builders, and the `Any*Column` type a `.references()` callback is annotated with.
//
// One place, so a new dialect is one row here plus its column mapping, rather than another
// `dialect === "sqlite" ? … : …` ternary in every template. Every site that used to read
// "not sqlite, so Postgres" asks this instead, which is how `mysql` stops being mistaken for
// Postgres.
//
// MySQL is a CODEGEN + RUNTIME dialect only: `meta migrate` does not own a MySQL schema
// (ADR-0015 — the migrate engine supports Postgres, SQLite and D1), so the adopter writes the
// DDL and the generated Drizzle schema describes it.
import type { Dialect } from "./metaobjects-config.js";

export interface DialectModule {
  /** The Drizzle core module every column/table builder is imported from. */
  readonly core: "drizzle-orm/sqlite-core" | "drizzle-orm/pg-core" | "drizzle-orm/mysql-core";
  readonly tableFn: "sqliteTable" | "pgTable" | "mysqlTable";
  readonly viewFn: "sqliteView" | "pgView" | "mysqlView";
  readonly anyColumn: "AnySQLiteColumn" | "AnyPgColumn" | "AnyMySqlColumn";
}

const MODULES: Record<Dialect, DialectModule> = {
  sqlite: { core: "drizzle-orm/sqlite-core", tableFn: "sqliteTable", viewFn: "sqliteView", anyColumn: "AnySQLiteColumn" },
  postgres: { core: "drizzle-orm/pg-core", tableFn: "pgTable", viewFn: "pgView", anyColumn: "AnyPgColumn" },
  mysql: { core: "drizzle-orm/mysql-core", tableFn: "mysqlTable", viewFn: "mysqlView", anyColumn: "AnyMySqlColumn" },
};

export function dialectModule(dialect: Dialect): DialectModule {
  return MODULES[dialect];
}

/**
 * The `Db` type alias (and its import) a generated queries module is parameterised over
 * (ADR-0008 — `db` is passed in). Every type argument is as open as Drizzle's own constraint
 * allows, so any driver's database handle assigns — a schema-carrying `drizzle(client,
 * { schema })` as well as a schema-less one.
 */
export function dbTypeBlock(dialect: Dialect): { import: string; alias: string } {
  switch (dialect) {
    case "postgres":
      return {
        import: `import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";`,
        alias: "type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;",
      };
    case "mysql":
      return {
        import: `import type { MySqlDatabase, MySqlQueryResultHKT, PreparedQueryHKTBase } from "drizzle-orm/mysql-core";`,
        alias: "type Db = MySqlDatabase<MySqlQueryResultHKT, PreparedQueryHKTBase, Record<string, unknown>>;",
      };
    case "sqlite":
      return {
        import: `import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";`,
        alias: `type Db = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;`,
      };
  }
}

/**
 * Whether the dialect's INSERT / UPDATE / DELETE can return rows (`RETURNING`). MySQL cannot:
 * its generated writes read the row back by primary key instead.
 */
export function supportsReturning(dialect: Dialect): boolean {
  return dialect !== "mysql";
}

/**
 * The timestamp mode a dialect can honour. SQLite/D1 is always "string" (Drizzle's
 * sqlite-core has no Date column). MySQL is always "date": a `DATETIME` accepts neither the
 * `T` … `Z` ISO wire form nor returns it, so the string mode would hand the database a value
 * it rejects and hand the client one that is not ISO. In "date" mode Drizzle writes and reads
 * the UTC wall clock of a JS `Date`, the Zod schema coerces the ISO wire string, and JSON
 * serialises the `Date` back to ISO. Postgres honours the configured mode.
 */
export function normalizeTimestampMode(
  dialect: Dialect,
  configured: "date" | "string" | undefined,
): "date" | "string" {
  if (dialect === "sqlite") return "string";
  if (dialect === "mysql") return "date";
  return configured ?? "string";
}

