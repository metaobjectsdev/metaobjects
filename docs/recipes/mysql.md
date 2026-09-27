# MySQL

MySQL is a **code generation and runtime** target. It is not a schema target:

- `meta gen` generates code for MySQL.
- The TypeScript and Java runtimes read and write MySQL.
- `meta migrate` does not own a MySQL schema. It supports Postgres, SQLite and D1 only
  (ADR-0015). You write and evolve the MySQL DDL yourself.

## What works on MySQL

| Tier | TypeScript | Java |
|---|---|---|
| Generated code | `dialect: "mysql"`: Drizzle `mysqlTable` entities, Zod schemas, queries, Fastify/Hono routes | DTOs, controllers and repository interfaces are dialect-neutral |
| Runtime | the generated routes (`runtime-ts`); `ObjectManager` over `kyselyDriver` (Kysely `MysqlDialect`) or `drizzleDriver` (`drizzle-orm/mysql2`) | OMDB `MySQLDriver` |
| Schema | you own it: no `meta migrate`, `meta verify --db` or `--replay`, and no `agent/schema.md` page | you own it |
| Drift gates | `meta verify --codegen`, `--templates`, `--docs` work as on any dialect | `mvn metaobjects:verify` (codegen drift) |

These tests exercise the whole list against a real MySQL 8.4 server:

- `mysql-generated-app.test.ts`: the generated tier;
- `mysql-object-manager.test.ts`: both TypeScript ObjectManager drivers;
- `MySqlObjectManagerTest`: the Java OMDB driver.

Python, C# and Kotlin have no MySQL-specific code, and nothing tests them on MySQL yet.

## TypeScript setup

```ts
// metaobjects.config.ts
export default defineConfig({
  dialect: "mysql",
  // …generators, outDir, dbImport as usual
});
```

```ts
// db.ts: what the generated routes import (dbImport)
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
export const db = drizzle(mysql.createPool(process.env.DATABASE_URL!));
```

For the ObjectManager, create the mysql2 pool with `timezone: "Z"`. `DATETIME` then holds the
UTC wall clock, which is what the generated tier and the Java driver store:

```ts
import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
const db = new Kysely({ dialect: new MysqlDialect({ pool: createPool({ uri: url, timezone: "Z" }) }) });
const driver = kyselyDriver({ db, dialect: "mysql" });
```

## Writing the DDL

Write the tables to match the generated Drizzle declarations. The generated `<Entity>.ts` is
the reference: its column builders name the MySQL types.

| Field | Column |
|---|---|
| `field.string` with `@maxLength` | `VARCHAR(n)` |
| `field.string` without `@maxLength` | `TEXT`; `VARCHAR(255)` when the field is part of a key, an index, is `@unique` or has a `@default` (MySQL cannot key or default a `TEXT` column). Declare `@maxLength` to choose the length. |
| `field.enum` | `VARCHAR(n)`, where `n` is the longest member (int-backed: `INT`) |
| `field.int` / `field.long` / `field.currency` | `INT` / `BIGINT` / `BIGINT` |
| `field.decimal` | `DECIMAL(p,s)` (read back as a string) |
| `field.boolean` | `BOOLEAN` (`TINYINT(1)`) |
| `field.date` / `field.time` / `field.timestamp` | `DATE` / `TIME(3)` / `DATETIME(3)` |
| `field.uuid` / `field.inet` | `VARCHAR(36)` / `VARCHAR(45)` |
| arrays, `field.object`, `field.map`, `@dbColumnType: jsonb` | `JSON` |
| `@generation: increment` | `AUTO_INCREMENT` |
| `@generation: uuid` | `VARCHAR(36)`: the id is minted in the application |

A column named after a MySQL reserved word (`rank`, `order`) needs backticks in your DDL. The
generated code and both runtimes quote identifiers themselves.

## Behaviour that differs from Postgres and SQLite

- **Writes read the row back.** MySQL has no `RETURNING`:
  - A create inserts the row, takes the key (from the body, or from `$returningId()` /
    `insertId` for `AUTO_INCREMENT`), and selects the row.
  - An update runs the `UPDATE` and then selects the row.
  - The generated `delete<Entity>ById` checks that the row exists before deleting it.
- **`like` is case-sensitive**, as the API contract requires (ADR-0049). MySQL's default
  collation is case-insensitive, so the generated routes compare with
  `COLLATE utf8mb4_bin`. The TypeScript-only `?search` stays case-insensitive.
- **Timestamps use Drizzle's `date` mode.** A `DATETIME` rejects the ISO wire form
  (`2026-05-28T20:26:40.002Z` is `ERROR 1292`). The generated Zod schema coerces the ISO string
  to a `Date`, Drizzle stores the UTC wall clock, and the JSON response carries ISO with `Z`.
  The `timestampMode` setting has no effect on MySQL.
- **`TIME` values cannot carry a UTC offset.** MySQL rejects them, so send `HH:MM:SS[.fff]`.
- **Index options.** MySQL has no partial indexes, so `@where` is not emitted. `@using` is not
  emitted either, because MySQL's index types are not access methods. Expression indexes
  (`@expr`) are emitted.
- **The `callable` generator** (stored procedures and table functions) emits Postgres calls
  only.
