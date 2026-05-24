# `meta migrate` — Cloudflare D1 dialect (TypeScript)

**Status:** Design — plan-of-record
**Author:** Claude + Doug
**Date:** 2026-05-24
**Scope:** TypeScript (`@metaobjectsdev/migrate-ts` + `@metaobjectsdev/cli`)
**Depends on:** existing `sqlite` dialect pipeline

## Goal

Add a `dialect: "d1"` to `meta migrate` so a TypeScript project targeting Cloudflare D1 can go from metadata to applied schema in one command, in Wrangler's native migration layout, without leaving the Wrangler-native workflow developers already use.

## Why a new dialect

D1 is SQLite at the SQL level, but it diverges from generic SQLite in three places that matter to `meta migrate`:

- **Connection.** Wrangler owns the database — there's no connection URL. The toolchain is `wrangler d1 execute <binding> [--local|--remote]`, configured in `wrangler.toml`.
- **Migration file layout.** Wrangler expects forward-only `migrations/<seq>_<slug>.sql`, tracks applied migrations in a `d1_migrations` table, and ignores anything else.
- **SQL constraints.** D1 rejects explicit `BEGIN/COMMIT/SAVEPOINT` in user SQL (it wraps each file itself), forbids `ATTACH`/`VACUUM`, and has per-statement size limits.

Modelling this as a flag on the existing `sqlite` dialect would fork three internal code paths on `target`. A new dialect keeps `sqlite` meaning "generic SQLite via libsql" and gives D1 a clean lane that other Wrangler-native dialects (hypothetical future Turso, Cloudflare Hyperdrive) can mimic.

## Forward-compatibility posture

The design preserves room for richer Postgres/Oracle work without locking us in:

- The diff/emit core (`expected-schema.ts`, `diff/`, `sql-type.ts`) is unchanged and stays state-based, not history-based. D1's `d1_migrations` history table is a sidecar concern owned by the `--apply` hook, not by the pipeline.
- Output format is dialect-pluggable. A future `writeMigrationFlyway` (`V<n>__<slug>.sql`) or Liquibase writer slots in next to `writeMigrationD1` without touching the pipeline.
- The CLI flag `--remote` is D1-specific now; if a future Postgres/Oracle design needs richer multi-environment support, the natural shape is `--env=<name>` of which `--remote` becomes a D1-vocabulary synonym. This is a forward note, not a commitment.

Deliberate constraint preserved (not introduced): `meta migrate` is single-target per invocation. The D1 design keeps that.

## Architecture

```
                    metadata ──┐
                               ▼
                    buildExpectedSchema(d1)        ← d1 maps to sqlite shape
                               │
                               ▼
   ┌─────────────────┐    ┌────────────────┐    ┌─────────────────────────┐
   │ wrangler.toml   │    │  diff()        │    │ renderD1 = renderSqlite │
   │  resolver       ├──► │  (shared)      ├──► │  + D1 safety post-pass  │
   └─────────────────┘    └────────────────┘    └─────────────────────────┘
            │                                              │
            ▼                                              ▼
   introspectD1 (shell-out                       writeMigrationD1(up, down)
   to `wrangler d1 execute                       ├─ migrations/<seq>_<slug>.sql
   --json --command "..."`)                      └─ migrations/.down/<seq>_<slug>.sql
                                                          │
                                                          ▼
                                          (optional, --apply)
                                          `wrangler d1 migrations apply`
```

Three swap points; the diff/emit core is untouched.

## Connection + introspection

### Binding resolution

`meta migrate` finds the D1 database via Wrangler's own config. Resolution order:

1. `--d1 <BINDING>` CLI flag (explicit).
2. `migrate.d1.binding` in `.metaobjects/config.json`.
3. Auto: parse `wrangler.toml` (or `wrangler.jsonc`); if it has exactly one `[[d1_databases]]` entry, use it. If zero or 2+, error with a list of available bindings.

From the wrangler config block we capture `binding`, `database_name`, `database_id`, and `migrations_dir` (defaults to `migrations`).

`--db <url>` is rejected with a clear error for `dialect: "d1"` — Wrangler owns connection.

### Introspector

`migrate-ts/src/introspect/d1.ts` exposes `introspectD1(opts)` and returns the same `SchemaSnapshot` shape as `introspectSqlite`. It works by:

1. Issuing the same set of catalog queries against `sqlite_master`, `PRAGMA table_info`, `PRAGMA index_list`, `PRAGMA foreign_key_list` that `introspectSqlite` issues today.
2. Running each via `execFile("wrangler", ["d1", "execute", "<binding>", "--local"|"--remote", "--json", "--command", "<sql>"], { cwd })` and parsing the JSON envelope (`{ results: [{ ... }] }`).
3. Mapping rows back into `TableDescriptor` / `ColumnDescriptor` / `IndexDescriptor` / `FkDescriptor` using the same logic SQLite uses — only the transport differs.

`snapshot.meta.sqliteVersion` is populated from `SELECT sqlite_version()` over the same channel, so any version-gated decisions downstream (recreate-and-copy threshold) use D1's actual reported version.

### Why shell-out, not import wrangler as a library

Wrangler's programmatic API is unstable; shell-out insulates us from internal churn. Cost: fork overhead per query. Mitigations:

- Local introspection is negligible-cost (~ms per query).
- Remote introspection makes one HTTPS round-trip per query; we print a per-query progress line and emit a one-line `wrangler d1 execute --remote` aggregate timing in the summary.
- Future optimization (out of scope for v1): batch read queries via `wrangler d1 execute --file`.

### Error surfaces

- Wrangler not on PATH → "install wrangler: `npm i -D wrangler`".
- No `wrangler.toml` in cwd or parents → "expected wrangler.toml; pass `--d1 <binding>` to bypass".
- Binding not found → list available bindings.
- Wrangler unauthenticated for `--remote` → forward wrangler's own error; suggest `wrangler login`.
- Empty introspection on `--remote` → probe with `SELECT name FROM sqlite_master LIMIT 1` and distinguish "empty DB" from "wrong db_id".

### What stays shared with `sqlite`

`buildExpectedSchema(metadata, { dialect: "d1" })` maps internally to `"sqlite"` — D1 *is* SQLite for schema-shape purposes. Nothing in `expected-schema.ts`, `diff/`, or `sql-type.ts` knows D1 exists. The split is purely at I/O.

## Emit + D1-safety pass

### Wrapper structure

`migrate-ts/src/emit/d1.ts`:

```ts
export function renderD1(changes, expectedSchema, actualMeta?): EmitResult {
  const sqliteResult = renderSqlite(changes, expectedSchema, actualMeta);
  return {
    up:   applyD1SafetyPass(sqliteResult.up),
    down: applyD1SafetyPass(sqliteResult.down),
    recreatedTables: sqliteResult.recreatedTables,
  };
}
```

Both up and down get the safety pass — the down sidecar isn't run by Wrangler, but a human piping it through `wrangler d1 execute --file` needs it to be D1-safe too.

`emit/index.ts` dispatch adds `case "d1": return renderD1(...)`.

### Safety transforms

1. **Strip explicit transactions.** Remove `BEGIN TRANSACTION;` / `BEGIN;` / `COMMIT;` / `ROLLBACK;` at statement boundaries (case-insensitive). Wrangler wraps each file in its own transaction; nested ones are rejected.
2. **Drop `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`.** Same family. Defensive — not generated today.
3. **Preserve `PRAGMA foreign_keys = OFF/ON`.** Wrangler sends a migration file as a single D1 batch, so PRAGMAs are expected to persist for the file's duration and the recreate-and-copy pattern should work as-is. **Verify during implementation:** the safety-pass test suite includes a recreate-and-copy fixture exercised end-to-end against `wrangler d1 execute --local` to confirm. If D1 silently drops the PRAGMA across statements in a batch, fall back to emitting per-statement FK-disable + re-enable bookends around each recreate-and-copy block (or, last resort, gate FK-touching DDL behind a typed error).
4. **Reject `ATTACH DATABASE` / `DETACH DATABASE` / `VACUUM` at emit time** with a typed error. Not generated today; this is a future-proofing guard so a regression fails early with a clear message instead of at apply time.
5. **Warn on statement size** if any statement exceeds 100 KB (the `wrangler d1 execute` limit). Schema DDL never gets close; data migrations could. Warn, don't block.

### Recreate-and-copy unchanged

`renderSqlite`'s version-gated decision (ALTER vs. recreate-and-copy via `__new_<table>`) uses `actualMeta.sqliteVersion`. `introspectD1` populates that from D1's actual version, so the right code path is selected automatically. No D1 special case.

### Testing the pass

Unit tests in `migrate-ts/test/emit/d1.test.ts` cover each transform with explicit in/out pairs (BEGIN stripped, ATTACH rejected with typed error, PRAGMA preserved verbatim, size warning fires above threshold). A snapshot test feeds `renderD1` a known `Change[]` and asserts the output matches the sqlite emit modulo the safety transforms. We do not duplicate `emit/sqlite.ts`'s suite.

### Why post-pass, not parallel emitter

Forking `renderSqlite` into `renderD1` would duplicate ~1000 lines and add maintenance liability every time SQLite emit evolves. The post-pass is ~50 lines and is text-equivalent to "sqlite minus what D1 rejects." If D1 ever needs structurally different DDL (not just text edits), we split then.

## Migration writer

### Layout

```
migrations/
├── 0001_init.sql              ← up SQL (forward, Wrangler-discoverable)
├── 0002_add-shipping.sql
├── 0003_drop-legacy.sql
└── .down/
    ├── 0001_init.sql          ← down SQL (sidecar; Wrangler doesn't recurse)
    ├── 0002_add-shipping.sql
    └── 0003_drop-legacy.sql
```

### Sequence assignment

Scan `migrations/*.sql` (top-level only), parse the leading `<digits>_` prefix, pick `max + 1`, pad to 4 digits. First-ever migration is `0001`. Pre-existing wrangler migrations from another source are honored — we slot in after them.

### Directory resolution

Precedence (first non-null wins):

1. `--out-dir` CLI flag.
2. `migrate.outDir` in `.metaobjects/config.json`.
3. `migrations_dir` from the captured `wrangler.toml` binding.
4. `migrations/` (Wrangler default).

### Down sidecar

Down SQL lands at `migrations/.down/<seq>_<slug>.sql` with the same filename as the up file. Wrangler doesn't recurse, so it's invisible to `wrangler d1 migrations apply`. We do not touch `.gitignore` automatically — down files are useful artifacts for review, and projects that want them ignored can add `migrations/.down/` themselves.

`writeMigrationD1(emitResult, opts)` lives next to `writeMigration` in `write-migration.ts`. Existing `writeMigration` is unchanged.

## Apply hook

Opt-in via `--apply` flag or `migrate.d1.autoApply: true`.

After files are written successfully, shell:

```
wrangler d1 migrations apply <binding> [--local|--remote] --config <wrangler-config-path>
```

Output streams through `log`. The local/remote target is whatever drove introspection in the same run — diff target and apply target are the same environment by design. No flag combinations for "diff local, apply remote" in v1.

### Production confirmation

`--apply --remote` (without `--dry-run`) prints a confirmation banner naming the database (`Applying to remote D1 'myapp-prod' (database_id=abc...)`) and pauses 2 seconds before invoking wrangler, unless `--yes` is also passed. Mirrors wrangler's own production guard.

### Exit codes

- `0` — wrote files and (if `--apply`) applied cleanly.
- `1` — diff produced blocked/ambiguous changes, or apply failed. Files are still written; rollback is the user's call.
- `2` — config/auth/wrangler-not-installed error before any work happens.

## CLI + config surface

### CLI flags added

```
--dialect d1                  selects this pipeline
--d1 <binding>                explicit binding from wrangler.toml
--remote                      target remote D1 (default: local)
--apply                       run `wrangler d1 migrations apply` after write
--yes                         skip the --remote --apply confirmation pause
```

Existing flags (`--slug`, `--dry-run`, `--allow`, `--out-dir`, `--on-ambiguous`) work as today.

### Config block

`.metaobjects/config.json`:

```jsonc
{
  "migrate": {
    "dialect": "d1",
    "d1": {
      "binding": "DB",               // optional; overrides auto-detect
      "remote": false,               // default target
      "autoApply": false,            // default off
      "wranglerConfigPath": "wrangler.toml"
    },
    "outDir": "migrations"           // optional; otherwise from wrangler.toml
  }
}
```

### `meta init --d1`

Adds the `dialect: "d1"` block and prompts for the binding (auto-fills from `wrangler.toml` if present). Existing `meta init` flow is unchanged.

## Testing

| Suite | Path | Covers |
|---|---|---|
| Safety pass | `migrate-ts/test/emit/d1.test.ts` | BEGIN strip, ATTACH reject, PRAGMA preserve, size warn |
| Introspect | `migrate-ts/test/introspect/d1.test.ts` | wrangler invoked with right args; JSON → SchemaSnapshot mapping |
| Writer | `migrate-ts/test/write-migration-d1.test.ts` | sequence numbering, `.down/` sidecar, dir resolution |
| CLI | `cli/test/commands/migrate-d1.test.ts` | wrangler.toml parsing, binding resolution errors, `--remote` + `--apply` interactions, confirmation banner |

`execFile` is mocked in introspect tests — no live wrangler dependency in default CI. An opt-in `bun test:d1-live` script targets a real account when `CLOUDFLARE_API_TOKEN` is set, but isn't part of the default suite.

## Out of scope (v1)

- Direct Cloudflare HTTP API path (wrangler CLI only; add later if dependency becomes painful).
- Reading `d1_migrations` table to skip already-applied migrations (diff is schema-state-based; wrangler tracks history itself).
- Multi-environment diff/apply in one invocation (single target per run, as today).
- Data migrations (schema only, as today).
- Wrangler version pinning / probing (assume `>=3`; document the floor).
- Batching introspection queries via `wrangler d1 execute --file` (perf optimization deferred).

## File-level change summary

New files:

- `server/typescript/packages/migrate-ts/src/introspect/d1.ts`
- `server/typescript/packages/migrate-ts/src/emit/d1.ts`
- `server/typescript/packages/migrate-ts/src/emit/d1-safety-pass.ts`
- `server/typescript/packages/migrate-ts/src/write-migration-d1.ts`
- `server/typescript/packages/migrate-ts/src/wrangler-config.ts` (wrangler.toml/jsonc parser)
- `server/typescript/packages/cli/src/lib/wrangler.ts` (CLI invocation helpers, mocked in tests)
- Test files mirroring each of the above.

Touched files:

- `server/typescript/packages/migrate-ts/src/types.ts` — extend `Dialect` to include `"d1"`.
- `server/typescript/packages/migrate-ts/src/expected-schema.ts` — map `"d1"` → SQLite expected-schema path.
- `server/typescript/packages/migrate-ts/src/emit/index.ts` — dispatch `case "d1"`.
- `server/typescript/packages/migrate-ts/src/introspect/index.ts` — dispatch `case "d1"`.
- `server/typescript/packages/migrate-ts/src/index.ts` — re-export D1 surface.
- `server/typescript/packages/cli/src/commands/migrate.ts` — branch on `dialect === "d1"` for wrangler-based connection (skip `buildKyselyFromUrl`).
- `server/typescript/packages/cli/src/lib/args.ts` — add `--d1`, `--remote`, `--apply`, `--yes`.
- `server/typescript/packages/cli/src/lib/config.ts` — add `migrate.d1` block.
- `server/typescript/packages/cli/src/commands/init.ts` — add `--d1` init path.
- `docs/RELEASING.md` / `README.md` — document the new dialect.

## Open questions

None — all design decisions resolved during brainstorming.
