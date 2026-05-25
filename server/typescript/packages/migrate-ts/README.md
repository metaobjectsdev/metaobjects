# @metaobjectsdev/migrate-ts

Schema migration tool for MetaObjects-driven projects.

Compares loaded MetaObjects metadata against a live Postgres or SQLite (libsql/Turso) database
and emits paired `up.sql` + `down.sql` migration files.

**Status:** v0.3. TS reference implementation; emits migration SQL but does not yet apply against the DB.

## Install

```bash
pnpm add @metaobjectsdev/migrate-ts
```

## Quick start

```typescript
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import {
  buildExpectedSchema, introspectSqlite, diff, emit, writeMigration,
} from "@metaobjectsdev/migrate-ts";

// 1. Load metadata.
const { root: metadata } = await MetaDataLoader.fromDirectory("./metaobjects");

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

## Dialects

### `sqlite` — SQLite / libsql / Turso

Connects via a Kysely `LibsqlDialect`. Emits `up.sql` + `down.sql` to the configured output directory.

### `postgres` — PostgreSQL

Connects via Kysely's built-in `PostgresDialect`. Emits `up.sql` + `down.sql`.

### `d1` — Cloudflare D1

Targets Cloudflare D1 via the wrangler CLI. Connection is read from `wrangler.toml`; introspection runs via `wrangler d1 execute --json`. SQL emit reuses the `sqlite` path with a D1-safety post-pass (strips explicit transactions, rejects `ATTACH`/`VACUUM`). Migration files are written in Wrangler's native layout (`migrations/<seq>_<slug>.sql` + a `.down/` sidecar for rollback).

**Flags (from `@metaobjectsdev/cli`):**
- `--dialect d1` — selects this pipeline.
- `--d1 <binding>` — explicit binding from `wrangler.toml` (auto-detected when there's exactly one).
- `--remote` — target remote D1 (default: local).
- `--apply` — invoke `wrangler d1 migrations apply` after writing.
- `--yes` — skip the `--remote --apply` 2-second confirmation pause.

**Config (`.metaobjects/config.json`):**

```jsonc
{
  "migrate": {
    "dialect": "d1",
    "d1": { "binding": "DB", "remote": false, "autoApply": false }
  }
}
```

**Requirements:** `wrangler` >= 3 on PATH (`npm i -D wrangler`).

## Not yet shipped

- `meta migrate --apply` (apply migrations against the DB).
- Migration history table.
- Triggers, generated columns, partial indexes, exclusion constraints, check constraints.
- MySQL.
- Data migrations (column-type changes that need data transformation: error with hint).
- Multi-step migration scaffolding (add nullable → backfill → set notnull).

## License

Apache-2.0.
