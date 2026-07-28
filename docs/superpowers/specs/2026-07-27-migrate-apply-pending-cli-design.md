# `meta migrate apply-pending` — replay committed migrations (#242)

- **Date:** 2026-07-27
- **Status:** Design approved; ready for implementation plan
- **Issue:** [#242](https://github.com/metaobjectsdev/metaobjects/issues/242) — add a CLI subcommand to replay committed migrations (`applyPending`)
- **Surface:** `@metaobjectsdev/cli` (`meta migrate`). TS-only. No change to `@metaobjectsdev/migrate-ts` replay semantics.

## Problem

Provisioning a fresh (or partially-migrated) database from the **committed** migration
files — local dev, CI test databases, scratch/replay databases — is a standard
operation, but the CLI has no verb for it.

`applyPending(db, dir, opts)` is exported from `@metaobjectsdev/migrate-ts` and is the
correct primitive: it replays the migration files in order, ledger-tracked
(`_metaobjects_migrations`), transactionally, creating tables **and** views. But the
only CLI path that reaches it is `meta migrate --apply`, which is **diff-first** — it
diffs metadata against the live DB and authors a migration for the difference before
replaying. On an empty database that diff is non-empty, so:

- with no `--slug`, `migrate` exits `2` before `applyPending` ever runs;
- with `--slug`, it authors a redundant monolith migration that then collides with the
  already-committed migration files.

So "replay the committed migrations against this DB" is currently reachable only by
hand-writing a bespoke Kysely-construction script that calls `applyPending` directly —
boilerplate every consumer re-invents.

Authoring-from-a-diff and replaying-committed-files are two distinct operations (cf.
Prisma `migrate dev` vs `migrate deploy`, Flyway `migrate`, Rails `db:migrate`). The
toolchain ships the author half via CLI and the replay half only as a library
function; this adds the missing replay verb.

## Design

Add a `meta migrate apply-pending` subcommand — a thin CLI wrapper over the existing
public `applyPending`. It performs **no diff and loads no metadata**, so it works on an
empty database where `--apply` cannot.

### Subcommand parsing

`apply-pending` is parsed as a positional in `parseMigrateArgs`, mirroring the existing
`baseline` positional, into a new boolean `config.applyPending`. (`baseline` and
`apply-pending` are mutually exclusive positionals; supplying both is a usage error.)

### Dispatch + handler

Dispatched early in `migrateCommand` (before the diff/emit pipeline), alongside the
existing `runBaseline` / `runRollback` handlers, via a new
`runApplyPending(config, metaRoot, fmt): Promise<number>`. It reuses the CLI's existing
plumbing verbatim:

1. **Reject `d1`.** `apply-pending` is postgres/sqlite only — D1 replays committed files
   through `wrangler d1 migrations apply`, not Kysely. Emit an error that points there
   and return `2`. Placed with the other d1 subcommand rejections (baseline/rollback).
2. **Require a connection.** Reuse the existing `config.databaseUrl === undefined` →
   "`--db <url> required`" error path; return `2`.
3. `const kysely = await buildKyselyFromUrl(config.databaseUrl, config.dialect)`.
4. `const outDir = resolvePath(metaRoot, config.outDir)` — the same migrations-directory
   default every migrate subcommand uses (`MIGRATE_DEFAULT_OUT_DIR`).
5. `const result = await applyPending(kysely.db, outDir, { dryRun: config.dryRun ?? false, dialect: kysely.dialect as "sqlite" | "postgres" })`.
6. **Report** (text + structured, honoring `fmt`):
   - dry-run: the pending list (`N pending: <names>`), nothing applied;
   - real run with applied files: `applied N migration(s): <names>`;
   - real run with nothing pending: `already up to date` (a no-op success, not an error).
7. `await kysely.db.destroy()` in a `finally`.
8. Return `0` on success, `2` on usage error, `1` on an apply failure (an
   `applyPending` throw — e.g. the checksum tamper guard, or SQL that fails to apply).

### Help text

Add `apply-pending` to `MIGRATE_HELP_TEXT`: the subcommand line (a one-line description)
and one example, e.g.
`meta migrate apply-pending --db postgresql://localhost/mydb`.

## Behavior notes

- **Idempotent.** `applyPending` skips ledger-recorded migrations, so a second run applies
  nothing and reports "already up to date". Re-runnable safely.
- **Drift is not checked.** `apply-pending` replays files; it does not compare against
  current metadata. `meta verify` remains the drift check. (This is inherent to
  `applyPending`, which is already public — not a new capability, just a discoverable CLI
  path to it.)
- **`--dry-run`** lists pending migrations without applying (delegates to
  `applyPending`'s `dryRun`).

## Non-goals (YAGNI)

- No change to `applyPending`'s replay semantics.
- No `--target` / partial-apply, no transaction-tuning flags, no `down`/rollback (that is
  `meta migrate --rollback`).
- No `d1` support (use `wrangler d1 migrations apply`).
- No metadata diffing (that is the diff-first `--apply` path).

## Testing

Mirror the existing `migrate` command tests (`packages/cli/test/…`), against a real
libSQL/sqlite database (the harness the migrate integration tests already use):

- **Provision from empty:** commit two migration files (a `CREATE TABLE` + a view),
  run `apply-pending` against an empty DB → both applied, tables + view exist, the
  `_metaobjects_migrations` ledger has both rows, exit `0`.
- **Idempotent re-run:** a second `apply-pending` applies `0`, reports "already up to
  date", exit `0`.
- **`--dry-run`:** lists the pending migration(s), applies nothing (DB unchanged), exit
  `0`.
- **Missing `--db`:** exit `2` with the "`--db <url> required`" error.
- **`d1` rejected:** `apply-pending --dialect d1` exits `2` with the wrangler pointer.
- **Apply failure surfaces:** a committed migration whose already-applied `up.sql` was
  edited (checksum tamper guard) makes `apply-pending` exit `1` with the guard's error.
