# Recipe: keep drizzle-kit as your migration tool

You already run `drizzle-kit generate` / `drizzle-kit migrate`, and you want MetaObjects to own
the **model** (entities, Zod schemas, queries, routes) without taking over your **migrations**.
That is a supported split: the TypeScript `entity` generator emits ordinary Drizzle tables
(`pgTable`, `sqliteTable` or `mysqlTable`, matching `dialect`), and drizzle-kit only needs a
schema file that exports them. `meta migrate` never has to run.

## Wire it

1. Generate as usual. `entityFile()` writes the table beside its Zod schemas:

   ```ts
   // metaobjects.config.ts
   import { defineConfig } from "@metaobjectsdev/cli";
   import { entityFile, queriesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";

   export default defineConfig({
     outDir: "src/generated",
     dialect: "postgres",          // must match the database drizzle-kit migrates
     generators: [entityFile(), queriesFile(), barrel()],
   });
   ```

2. Write **your own** schema file and re-export the generated tables from it. This file is
   yours: `meta gen` never touches it, so it is where you also add hand-written tables that are
   not in the model.

   ```ts
   // src/db/schema.ts
   export { customers } from "../generated/Customer.js";   // name the tables you want migrated
   export { orders } from "../generated/Order.js";
   // or, to follow the model as it grows:
   // export * from "../generated/index.js";
   export * from "./hand-written-tables.js";
   ```

   `export *` also re-exports Zod schemas and types. drizzle-kit ignores everything that is not
   a table, view or enum, so that is harmless; name the tables if you would rather keep the
   file explicit.

3. Point drizzle-kit at that file, not at `src/generated`:

   ```ts
   // drizzle.config.ts
   import { defineConfig } from "drizzle-kit";

   export default defineConfig({
     dialect: "postgresql",
     schema: "./src/db/schema.ts",
     out: "./drizzle",
   });
   ```

4. The loop is now: edit `metaobjects/*.json`, run `meta gen`, run `drizzle-kit generate`,
   review the SQL, run `drizzle-kit migrate`.

Keep one tool per database. Do not also run `meta migrate` against the same database: it
diffs the model against the live schema and would write a second, competing migration chain.
`meta verify --db <url>` is read-only and still useful as a drift check beside drizzle-kit:
it reports where the live database no longer matches the model, whoever applied the DDL.

## What was checked

The re-export was run against the real `entityFile()` output (SQLite dialect): both the named
re-export and `export *` from the barrel expose the generated table to Drizzle's own table
detection (`is(value, SQLiteTable)`), with the model's column names. drizzle-kit itself was not
installed in the checking environment, so the `drizzle-kit generate` step is the documented
drizzle-kit contract (it scans the schema file's exports), not something this repository gates.

## When to prefer `meta migrate` instead

Choose `meta migrate` (see [migrations and drift](../features/migrations-and-drift.md)) when
you want the schema derived from the model rather than from the generated Drizzle code:

- **No second source of truth.** With drizzle-kit, the chain of record is the diff of the
  generated TypeScript; with `meta migrate` it is the model itself, and `meta verify --db`
  and `meta verify --replay` gate the chain against the model.
- **Things the model owns that a table export does not carry.** SQL views for projections and
  `object.report` ([reporting](../features/reporting.md)) are created and kept in step by
  `meta migrate`, including recreating a view when a table it reads changes.
- **Renames and populated tables.** `meta migrate` resolves renames (`--on-ambiguous`) and
  treats destructive changes on populated tables explicitly
  ([Renames and populated tables](../features/migrations-and-drift.md#renames-and-populated-tables)).
- **Cloudflare D1.** `meta migrate --dialect d1` writes Wrangler's migration layout and
  handles SQLite's table-rebuild rules ([Cloudflare Workers recipe](cloudflare-workers.md)).
- **MySQL is the exception:** MetaObjects does not own a MySQL schema, so drizzle-kit (or
  hand-written DDL) is the only option ([MySQL recipe](mysql.md)).

You can adopt `meta migrate` later without changing the generated code. Baseline from the live
database with `meta migrate baseline --from-db --db <url>` and stop running drizzle-kit.
