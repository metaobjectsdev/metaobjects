# @metaobjectsdev/cli

The MetaObjects CLI — scaffolds `metaobjects/` + `.metaobjects/`, runs codegen and migrations against MetaObjects metadata.

**Status:** v0.3. TS reference implementation with Projects D–G shipped end-to-end.

## Install

```bash
bun add -D @metaobjectsdev/cli
```

The SQLite/Turso driver (`@libsql/kysely-libsql`) ships as a direct dependency — `meta migrate` against a `sqlite`/`libsql` URL works out of the box. Postgres remains an optional peer (install only if you target Postgres):
- Postgres: `bun add -D pg`

If a required driver is ever missing, the CLI prints an install command matching your project's package manager (npm / pnpm / yarn / bun, detected from the lockfile).

## Standalone binary (no Node/Bun toolchain to run)

The CLI can be compiled to a **single-file native executable** with [`bun build --compile`](https://bun.sh/docs/bundler/executables). The Bun runtime is embedded in the binary, so the schema operations (`meta migrate` and `meta verify --db`) run on any machine with **no Node or Bun installed** — the same "schema is a standalone tool" packaging as Flyway or Atlas. This lets a non-TS backend (Java, C#, Python, Go, …) adopt MetaObjects' migration + drift-detection layer without bringing in a JS toolchain.

Build the host-target binary:

```bash
bun run build:binary        # → dist/meta (compiled for the build host's OS/arch)
./dist/meta --help
```

The build externalizes two optional Biome WASM backends (`@biomejs/wasm-bundler`, `@biomejs/wasm-web`) that the CLI never loads — only the native Biome backend is used.

### Cross-compiling for other platforms

`bun build --compile` cross-compiles by passing `--target`. To build for a platform other than the host, append the target to the `build:binary` invocation:

```bash
bun build ./bin/meta.ts --compile --target=bun-linux-x64   --outfile dist/meta-linux-x64   --external @biomejs/wasm-bundler --external @biomejs/wasm-web
bun build ./bin/meta.ts --compile --target=bun-linux-arm64 --outfile dist/meta-linux-arm64 --external @biomejs/wasm-bundler --external @biomejs/wasm-web
bun build ./bin/meta.ts --compile --target=bun-darwin-arm64 --outfile dist/meta-darwin-arm64 --external @biomejs/wasm-bundler --external @biomejs/wasm-web
bun build ./bin/meta.ts --compile --target=bun-darwin-x64  --outfile dist/meta-darwin-x64  --external @biomejs/wasm-bundler --external @biomejs/wasm-web
bun build ./bin/meta.ts --compile --target=bun-windows-x64 --outfile dist/meta-windows-x64.exe --external @biomejs/wasm-bundler --external @biomejs/wasm-web
```

### SQLite driver inside the binary

The standalone binary uses Bun's built-in **`bun:sqlite`** for the `sqlite` dialect (it ships inside the embedded Bun runtime). The npm/Node distribution uses the bundled `@libsql/kysely-libsql` dependency. This is automatic — the same `--db file:./app.db --dialect sqlite` flags work in both. (Postgres in the standalone binary still requires the `pg` peer to be resolvable, because `pg` is a native module that `--compile` cannot embed; sqlite is the fully self-contained path.)

Run schema ops from the compiled binary:

```bash
./dist/meta migrate --db file:./app.db --dialect sqlite --slug initial --apply
./dist/meta verify  --db file:./app.db --dialect sqlite    # exit 0 when in sync, 1 on drift
```

(`dist/` is git-ignored — build the binary in CI/release, don't commit it.)

## Quick start

```bash
# 1. Scaffold metaobjects/ + .metaobjects/ + codegen/generators/ + metaobjects.config.ts
meta init

# 2. Author entity metadata
$EDITOR metaobjects/meta.myapp.json    # see .metaobjects/AGENTS.md for format

# 3. Generate TS code (config-driven via metaobjects.config.ts)
meta gen

# 4. Diff metadata against your DB and emit migration SQL
meta migrate --db file:./local.db --slug initial
```

## Global options

These apply to every command:

- `--cwd <path>`, `-C <path>` — run as if launched from `<path>` (default: current directory)
- `--format <toon|json|text>` — output format. The default is **TTY-aware**: a human at a terminal gets human-readable `text`, while a pipe or agent gets [TOON](https://github.com/toon-format/toon) (a compact, token-efficient structured format). Pass `--format json` for plain JSON, or force `--format text` when piping but still wanting the human view. Currently honored by `gen` and `migrate`.
- `--help`, `-h` — print help. Bare `meta --help` prints the full command reference; `meta <command> --help` prints focused usage for that command (e.g. `meta migrate --help`).
- `--version`, `-v` — print the CLI version.

Running `meta` with no arguments prints a concise status line (whether a `metaobjects/` directory is present) plus the most relevant next-step commands, rather than the full manual.

**Exit codes:** `0` success (including idempotent no-op runs), `1` runtime error, `2` usage error (bad flag, missing required argument, invalid `--format`). For agent-friendliness, structured errors and next-step hints are emitted on **stdout** in the active `--format` (not stderr), so callers can parse them without scraping stderr.

## Commands

### `meta init`

Scaffolds `metaobjects/` (visible entity declarations, with a placeholder `meta.common.json`), `.metaobjects/` (hidden tool state: `config.json`, `package.meta.json`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.gen-state/`), the **owned codegen generators** at `codegen/generators/{entity,queries,routes,barrel}.ts`, and `metaobjects.config.ts` at the repo root.

The generators are copied from the codegen reference templates and are **yours to edit** (ADR-0034 scaffold-and-own); the scaffolded `metaobjects.config.ts` imports them locally, and `meta gen` runs from those local copies — not from the package. Each generator file is written only if absent, so re-running with `--force` never clobbers a hand-edited generator.

Flags:
- `--force` — overwrite scaffold files (memory records preserved)
- `--quiet` — suppress next-steps output
- `--print-only` — show what would be created without writing
- `--refresh-docs` — refresh AGENTS.md + CLAUDE.md after a CLI upgrade

### `meta gen [<entity>...]`

Generates TS code (Drizzle schema, Zod validators, query helpers, TanStack Query hooks, etc.) from `metaobjects/` entity metadata. Generator wiring lives in `metaobjects.config.ts`; `meta gen` errors out if that file is missing.

Flags:
- `--dry-run` — informational; files still written (true no-write planned)
- `--no-antipatterns` — suppress the advisory anti-pattern pass (see below)

Positional args filter entities by name. All other knobs (`outDir`, `targets`, `dialect`, `dbImport`, `extStyle`, `apiPrefix`, generator list) live in `metaobjects.config.ts`.

On a real write run (not `--dry-run`), `meta gen` also runs an **advisory anti-pattern pass** — the same "verify-as-teacher" scan as `meta verify`. It scans your authored source for hand-rolled aggregates, money-as-float, and `CHECK (... IN (...))` enums and points you at the construct that models them (`origin.aggregate` / `field.currency` / `field.enum`). It emits **warnings only** and never changes the exit code. Opt out with `--no-antipatterns` or `META_NO_ANTIPATTERNS=1`.

### `meta types [<query>]`

Searches the metadata vocabulary (types, subtypes, `@attrs`) without loading it all into context — apropos + `kubectl explain` over the live registry. Use it to find the declarative construct for a piece of data logic instead of hand-writing it.

```
meta types relationship                 # subtypes/attrs whose name matches "relationship"
meta types --all money                   # search names AND descriptions ("find by what it does")
meta types --type field --kind subtype   # all field subtypes (terse)
meta types field.enum --detail           # one construct: description + when-to-use + valid @attrs
meta types --type origin --json          # machine-readable subtree
```

`QUERY` is a case-insensitive substring matched on the name (`type.subType` / `@attr`).

Flags:
- `--desc` / `--all` — also match `QUERY` against descriptions + when-to-use guidance (not just names)
- `--kind <type|subtype|attr>` — filter by category (comma-list ok)
- `--type <name>` — scope to one top-level type (e.g. `--type field`)
- `--detail` — drill in: full description, when-to-use, and valid `@attrs`
- `--json` — emit the matching registry subtree verbatim (stable-sorted)
- `--limit <N>` — cap results (default 20; `0` = unlimited)
- `--no-headers` — omit the `N of M`/match-count footer (parse-friendly)

Default output is one terse line per match.

### `meta migrate`

Diffs `metaobjects/` metadata against a live DB and emits paired migration SQL files (per-migration subdirectories with `up.sql` and `down.sql`).

Flags:
- `--db <url>` (required or via `$DATABASE_URL` or `.metaobjects/config.json`)
  - Supported schemes: `file:`, `libsql:`, `postgres:`, `postgresql:`
- `--dialect sqlite|postgres|d1` — auto-detected from URL scheme; use `d1` for Cloudflare D1
- `--out-dir <path>` (default `./.metaobjects/migrations`)
- `--slug <name>` — required when changes are pending (e.g., `add-user-shipping`)
- `--allow <csv>` — destructive-change permissions: `drop-column,drop-table,type-change,drop-index,drop-fk,nullable-to-not-null`
- `--on-ambiguous abort|rename|drop-add` (default `abort`) — non-interactive
- `--dry-run` — print SQL pair to stdout, write nothing
- `--apply` — after writing migration files, immediately apply all pending migrations against the DB (runs `up.sql` for each unapplied entry, tracked in the migration ledger). Mutually exclusive with `--rollback`. Postgres and SQLite only (D1 uses `--apply` to invoke `wrangler d1 migrations apply` instead).
- `--rollback <version>` — roll back applied migrations newer than `<version>` by running their `down.sql` in reverse order, ledger-tracked. Pass an empty string (`--rollback ""`) to roll back everything. Mutually exclusive with `--apply`. Postgres and SQLite only.

**D1-specific flags** (only relevant with `--dialect d1`):
- `--d1 <binding>` — explicit D1 binding from `wrangler.toml` (auto-detected when there's exactly one)
- `--remote` — target remote D1 (default: local)
- `--apply` — invoke `wrangler d1 migrations apply` after writing
- `--yes` — skip the `--remote --apply` 2-second confirmation pause

**Requirements for D1:** `wrangler` >= 3 on PATH (`npm i -D wrangler`).

## Configuration

Two config files, by design:

**`metaobjects.config.ts`** (at repo root) — generator wiring and codegen knobs, type-checked TS. The generators are imported from the **owned local copies** that `meta init` scaffolded into `codegen/generators/` (ADR-0034 scaffold-and-own), not from the package:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";

export default defineConfig({
  outDir: "packages/database/src/generated",
  extStyle: "none",
  dbImport: "../index",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
});
```

> Importing these generator factories from `@metaobjectsdev/codegen-ts/generators`
> still works but is **deprecated** (ADR-0034) — own a local copy instead. The
> package export will be removed in a future major.

### Multiple output targets

By default every generator writes to `outDir`. To route each generator's output
to a different directory/package — so generated code lands with its runtime
concern — declare named **targets** and point generators at them with `target`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` (ADR-0034 scaffold-and-own).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";
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

For D1 projects, the `migrate` block instead looks like:

```jsonc
{
  "migrate": {
    "dialect": "d1",
    "d1": { "binding": "DB", "remote": false, "autoApply": false }
  }
}
```

Precedence for `meta migrate`: CLI flag > env var (`DATABASE_URL` only) > `.metaobjects/config.json` > built-in default.

## Metadata format

See `.metaobjects/AGENTS.md` (scaffolded by `meta init`) for the metaobjects metamodel rules, attribute conventions, and worked examples. Deeper references:

- `@metaobjectsdev/metadata` [METAMODEL.md](../metadata/METAMODEL.md) — full metaobjects metamodel reference
- `@metaobjectsdev/sdk` [FORGE-METADATA.md](../sdk/FORGE-METADATA.md) — MetaObjects metadata additions

## Not yet shipped

- `meta gen --watch` (dropped) — re-run on demand
- True 3-way merge in `meta gen` — codegen-ts has overwrite/skip-existing only
- Module-reference DB connections — URL-only
- Reified SDK APIs for adding/promoting descriptive records — hand-edit JSON for now

## License

Apache-2.0.
