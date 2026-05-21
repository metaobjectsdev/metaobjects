# @metaobjects/migrate-ts

Schema migration tool for MetaObjects-driven projects.

Compares loaded MetaObjects metadata against a live Postgres or SQLite (libsql/Turso) database
and emits paired `up.sql` + `down.sql` migration files.

**Status:** v0.3. TS reference implementation; emits migration SQL but does not yet apply against the DB.

## Quick start

```typescript
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import {
  buildExpectedSchema, introspectSqlite, diff, emit, writeMigration,
} from "@metaobjects/migrate-ts";

// 1. Load metadata.
const { root: metadata } = await new FileMetaDataLoader().loadDirectory("./metaobjects");

// 2. Connect to live DB.
const db = new Kysely({ dialect: new LibsqlDialect({ url: "file:./local.db" }) });

// 3. Introspect + diff.
const expected = buildExpectedSchema(metadata);
const actual = await introspectSqlite(db);
const result = await diff({
  expected, actual,
  allow: { dropColumn: false, dropTable: false },
  onAmbiguous: async (q) => "rename",       // or prompt the user; "drop+add"; "abort"
});

if (result.blocked.length > 0) {
  console.error("Blocked changes:", result.blocked);
  process.exit(1);
}

// 4. Emit + write.
const sql = emit(result.changes, { dialect: "sqlite", expectedSchema: expected, actualMeta: actual.meta });
await writeMigration(sql, { dir: ".metaobjects/migrations", slug: "add-customer-shipping" });
```

## Design

- Five-stage pure pipeline; library has no CLI dependencies.
- Same `SchemaSnapshot` shape from metadata-side and DB-side; diff is symmetric.
- Canonical `SqlType` (dialect-neutral); per-dialect renderer in emit.
- Postgres uses native ALTERs; SQLite uses native ALTERs where supported (≥ 3.35) and bundles
  recreate-and-copy per table when needed (column type, nullable, default, FK changes).
- Rename detection via heuristic (Levenshtein on column names, column-set overlap on tables)
  + `onAmbiguous` callback — library doesn't prompt; CLI in SP5 wires the prompt.
- Per-change-kind allow flags for destructive opt-in.

## Not yet shipped

- `meta migrate --apply` (apply migrations against the DB).
- Migration history table.
- Triggers, generated columns, partial indexes, exclusion constraints, check constraints.
- MySQL.
- Data migrations (column-type changes that need data transformation: error with hint).
- Multi-step migration scaffolding (add nullable → backfill → set notnull).
