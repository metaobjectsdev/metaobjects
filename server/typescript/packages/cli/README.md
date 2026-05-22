# @metaobjectsdev/cli

The MetaObjects CLI — scaffolds `metaobjects/` + `.metaobjects/`, runs codegen and migrations against MetaObjects metadata.

**Status:** v0.3. TS reference implementation with Projects D–G shipped end-to-end.

## Install

```bash
bun add -D @metaobjectsdev/cli
```

Optional driver peers (install the one matching your DB):
- SQLite/Turso: `bun add -D @libsql/kysely-libsql`
- Postgres: `bun add -D pg`

## Quick start

```bash
# 1. Scaffold metaobjects/ + .metaobjects/ + metaobjects.config.ts
meta init

# 2. Author entity metadata
$EDITOR metaobjects/meta.myapp.json    # see .metaobjects/AGENTS.md for format

# 3. Generate TS code (config-driven via metaobjects.config.ts)
meta gen

# 4. Diff metadata against your DB and emit migration SQL
meta migrate --db file:./local.db --slug initial
```

## Commands

### `meta init`

Scaffolds `metaobjects/` (visible entity declarations, with a placeholder `meta.common.json`), `.metaobjects/` (hidden tool state: `config.json`, `package.meta.json`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.gen-state/`), and `metaobjects.config.ts` at the repo root.

Flags:
- `--force` — overwrite scaffold files (memory records preserved)
- `--quiet` — suppress next-steps output
- `--print-only` — show what would be created without writing
- `--refresh-docs` — refresh AGENTS.md + CLAUDE.md after a CLI upgrade

### `meta gen [<entity>...]`

Generates TS code (Drizzle schema, Zod validators, query helpers, TanStack Query hooks, etc.) from `metaobjects/` entity metadata. Generator wiring lives in `metaobjects.config.ts`; `meta gen` errors out if that file is missing.

Flags:
- `--dry-run` — informational; files still written (true no-write planned)

Positional args filter entities by name. All other knobs (`outDir`, `targets`, `dialect`, `dbImport`, `extStyle`, `apiPrefix`, generator list) live in `metaobjects.config.ts`.

### `meta migrate`

Diffs `metaobjects/` metadata against a live DB and emits paired migration SQL files (per-migration subdirectories with `up.sql` and `down.sql`).

Flags:
- `--db <url>` (required or via `$DATABASE_URL` or `.metaobjects/config.json`)
  - Supported schemes: `file:`, `libsql:`, `postgres:`, `postgresql:`
- `--dialect sqlite|postgres` — auto-detected from URL scheme
- `--out-dir <path>` (default `./.metaobjects/migrations`)
- `--slug <name>` — required when changes are pending (e.g., `add-user-shipping`)
- `--allow <csv>` — destructive-change permissions: `drop-column,drop-table,type-change,drop-index,drop-fk,nullable-to-not-null`
- `--on-ambiguous abort|rename|drop-add` (default `abort`) — non-interactive
- `--dry-run` — print SQL pair to stdout, write nothing

## Configuration

Two config files, by design:

**`metaobjects.config.ts`** (at repo root) — generator wiring and codegen knobs, type-checked TS:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "packages/database/src/generated",
  extStyle: "none",
  dbImport: "../index",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
});
```

### Multiple output targets

By default every generator writes to `outDir`. To route each generator's output
to a different directory/package — so generated code lands with its runtime
concern — declare named **targets** and point generators at them with `target`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  // The top-level outDir is the implicit "default" target — it holds the entity
  // modules (Drizzle + Zod), so it needs an importBase that other targets use to
  // import them.
  outDir: "packages/database/src/generated",
  importBase: "@acme/database/generated",
  dbImport: "../index",
  dialect: "sqlite",
  outputLayout: "package",
  apiPrefix: "/api",

  targets: {
    // routes run on the server; import db from the database package
    api: { outDir: "apps/api/src/generated", dbImport: "@acme/database" },
    // hooks/forms/grids run in the browser
    web: { outDir: "apps/web/src/generated" },
  },

  generators: [
    entityFile(), queriesFile(), barrel(),     // → default (entity-module) target
    routesFile({ target: "api" }),
    formFile({ target: "web" }),
    tanstackQuery({ target: "web" }),
    tanstackGrid({ target: "web" }),
  ],
});
```

A **target** is `{ outDir, importBase?, outputLayout?, dbImport? }`. `outputLayout`
and `dbImport` fall back to the top-level values; `importBase` does not inherit (it
is each target's own identity). Generators with no `target` use the implicit
`default` target (the top-level `outDir`).

**How cross-target imports resolve.** Every generated artifact imports the entity
module (queries, routes, hooks, columns, forms). When a generator's target differs
from the entity-module target (the one holding `entityFile()` output), that import
is emitted as an **extension-less package path** built from the entity-module
target's `importBase` — e.g. `@acme/database/generated/acme/commerce/Program` —
instead of a relative `./Program`. Same-target imports stay relative and honor
`extStyle`. The entity-module target therefore **must** set `importBase` whenever
any generator routes elsewhere (the runner errors with a fix-it message otherwise),
and the package it lives in must expose those modules via its `exports` map (e.g.
`"./generated/*": "./src/generated/*.ts"`).

With no `targets` and no per-generator `target`, output is byte-identical to a
single-`outDir` project.

**`.metaobjects/config.json`** — static project state parseable by non-TS tooling:

```json
{
  "schema_version": 1,
  "pending_in_git": true,
  "confidence_thresholds": { "pending_promote": 0.8, "drift_warn": 0.7 },
  "sources": [],
  "extract": {},
  "migrate": {
    "outDir": "./.metaobjects/migrations",
    "databaseUrl": "file:./local.db",
    "onAmbiguous": "abort",
    "allow": []
  }
}
```

Precedence for `meta migrate`: CLI flag > env var (`DATABASE_URL` only) > `.metaobjects/config.json` > built-in default.

## Metadata format

See `.metaobjects/AGENTS.md` (scaffolded by `meta init`) for the metaobjects metamodel rules, attribute conventions, and worked examples. Deeper references:

- `@metaobjectsdev/metadata` [METAMODEL.md](../metadata/METAMODEL.md) — full metaobjects metamodel reference
- `@metaobjectsdev/sdk` [FORGE-METADATA.md](../sdk/FORGE-METADATA.md) — MetaObjects metadata additions

## Not yet shipped

- `meta migrate --apply` — emit only, no DB writes from CLI
- `meta gen --watch` (dropped) — re-run on demand
- True 3-way merge in `meta gen` — codegen-ts has overwrite/skip-existing only
- Module-reference DB connections — URL-only
- Reified SDK APIs for adding/promoting descriptive records — hand-edit JSON for now

## License

Apache-2.0.
