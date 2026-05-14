# @metaobjects/cli

The MetaObjects CLI — scaffolds `.meta/`, runs codegen and migrations against MetaObjects metadata.

**Status:** v0.2.0 (pre-alpha).

## Install

```bash
bun add -D @metaobjects/cli
```

Optional driver peers (install the one matching your DB):
- SQLite/Turso: `bun add -D @libsql/kysely-libsql`
- Postgres: `bun add -D pg`

## Quick start

```bash
# 1. Scaffold .meta/ in your repo
meta init

# 2. Author entity metadata
$EDITOR .meta/memory/myapp.json    # see .meta/AGENTS.md for format

# 3. Generate TS code
meta gen --out-dir ./src/db --dialect sqlite --db-import '~/server/db'

# 4. Diff metadata against your DB and emit migration SQL
meta migrate --db file:./local.db --slug initial
```

## Commands

### `meta init`

Scaffolds `.meta/` with `memory/`, `_pending/`, `config.json`, `README.md`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `.gen-state/`.

Flags:
- `--force` — overwrite scaffold files (memory records preserved)
- `--quiet` — suppress next-steps output
- `--print-only` — show what would be created without writing
- `--refresh-docs` — refresh AGENTS.md + CLAUDE.md after a CLI upgrade

### `meta gen [<entity>...]`

Generates TS code (Drizzle schema, Zod validators, query helpers) from `.meta/memory/` entity metadata.

Flags:
- `--out-dir <path>` (default `./src/db`)
- `--dialect sqlite|postgres` (default `sqlite`)
- `--db-import <path>` (default `~/db`)
- `--merge overwrite|three-way` (default `overwrite`; three-way uses skip-existing semantics in v0.1)
- `--dry-run` — informational; files still written in v0.1 (planned: no-write in v0.3)

Positional args filter entities by name.

### `meta migrate`

Diffs `.meta/memory/` metadata against a live DB and emits paired migration SQL files (per-migration subdirectories with `up.sql` and `down.sql`).

Flags:
- `--db <url>` (required or via `$DATABASE_URL` or `.meta/config.json`)
  - Supported schemes: `file:`, `libsql:`, `postgres:`, `postgresql:`
- `--dialect sqlite|postgres` — auto-detected from URL scheme
- `--out-dir <path>` (default `./.meta/migrations`)
- `--slug <name>` — required when changes are pending (e.g., `add-user-shipping`)
- `--allow <csv>` — destructive-change permissions: `drop-column,drop-table,type-change,drop-index,drop-fk,nullable-to-not-null`
- `--on-ambiguous abort|rename|drop-add` (default `abort`) — non-interactive
- `--dry-run` — print SQL pair to stdout, write nothing

## Configuration

Optional `.meta/config.json` provides defaults that CLI flags override:

```json
{
  "schema_version": 1,
  "codegen": {
    "outDir": "./src/db",
    "dialect": "sqlite",
    "dbImport": "~/server/db",
    "mergeStrategy": "three-way"
  },
  "migrate": {
    "outDir": "./.meta/migrations",
    "databaseUrl": "file:./local.db",
    "onAmbiguous": "abort",
    "allow": []
  }
}
```

Precedence: CLI flag > env var (`DATABASE_URL` only) > config > built-in default.

## Metadata format

See `.meta/AGENTS.md` (scaffolded by `meta init`) for the metaobjects metamodel rules, the `@forge*` attribute namespace, the five descriptive top-level types (decision/principle/convention/glossary/failure), and worked examples. Deeper references:

- `@metaobjects/metadata` [METAMODEL.md](../metaobjects-metadata/METAMODEL.md) — full metaobjects metamodel reference
- `@metaobjects/sdk` [FORGE-METADATA.md](../sdk/FORGE-METADATA.md) — MetaObjects metadata additions

## What's not in v0.2

- `meta migrate --apply` (deferred to v0.3) — emit only, no DB writes from CLI
- `meta gen --watch` (dropped) — re-run on demand
- True 3-way merge in `meta gen` — codegen-ts v0.1 has overwrite/skip-existing only; true merge in v0.3
- Cross-file `super:` resolution at the metadata-file level — Loader limitation; v0.3 follow-up
- Module-reference DB connections — URL-only
- TS-format config file (`.meta/config.ts`) — JSON only
- Reified SDK APIs for adding/promoting descriptive records — hand-edit JSON for now
