import { resolve as resolvePath } from "node:path";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseMigrateArgs } from "../lib/args.js";
import { resolveMigrateConfig, MIGRATE_DEFAULT_OUT_DIR } from "../lib/config.js";
import type { ResolvedMigrateConfig } from "../lib/config.js";
import { formatMigrateResult, formatMigrateResultToon, type BlockedEntry, type AmbiguousEntry } from "../lib/output.js";
import { formatMigrateResultJson } from "../lib/output-json.js";
import type { OutputFormat } from "../lib/format.js";
import { toonEncode } from "../lib/format.js";
import { buildKyselyFromUrl, redactUrl } from "../lib/kysely.js";
import { log } from "../lib/log.js";
import { loadMemory, resolveCollection } from "@metaobjectsdev/sdk";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { migrateScopeMismatch, toObjectScope } from "../lib/migrate-scope.js";
import {
  buildExpectedSchemaWithProvenance,
  scopeExpectedSchema,
  introspect,
  diff,
  collectUnmanagedNames,
  emit,
  writeMigration,
  baselineFromMetadata,
  planOffline,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
  BlockedChangesError,
  PrimaryKeyChangeError,
  renderD1,
  writeMigrationD1,
  writeMigrationFlyway,
  introspectD1,
  applyPending,
  rollbackTo,
  findWranglerConfig,
  parseWranglerConfig,
  resolveD1Binding,
  type AmbiguousChange,
  type AmbiguousResolution,
  type Change,
  type D1Binding,
  type EmitResult,
  type D1Runner,
} from "@metaobjectsdev/migrate-ts";
import {
  buildWranglerExecuteArgs,
  defaultWranglerRunner,
  type WranglerRunner,
} from "../lib/wrangler.js";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { tokensToAllowOptions, describeChange } from "../lib/allow.js";

const MIGRATE_HELP_TEXT = `meta migrate — diff metadata vs live DB; emit migration SQL files

USAGE:
  meta migrate [baseline|apply-pending] [flags]

SUBCOMMANDS:
  baseline             Snapshot an EXISTING database's schema as the reference point
                       (use with --from-db). NOTE: for a brand-new/empty database use
                       the greenfield example below, NOT baseline — an offline baseline
                       records your metadata as already-applied and emits no CREATE TABLE.
  apply-pending        Replay committed migration files against --db (no diff);
                       provisions a fresh/CI database. postgres/sqlite only.

MIGRATE FLAGS:
  --db <url>           DB connection URL (required for live-introspect / --apply / --rollback)
                       Supports: file:, libsql:, postgres:, postgresql:
  --dialect sqlite|postgres|d1
                       Optional dialect override (auto-detected from URL scheme)
  --migration-format default|flyway
                       Migration file layout (default: default). 'flyway' emits
                       V<N>__<slug>.sql + U<N>__<slug>.sql for a Flyway runner;
                       --apply/apply-pending/--rollback are refused under it
                       because Flyway owns apply and flyway_schema_history.
                       Also settable once as migrate.format in
                       .metaobjects/config.json.
  --out-dir <path>     Migration directory (default: ./.metaobjects/migrations;
                       flyway: src/main/resources/db/migration)
  --slug <name>        Required when changes are present (e.g., --slug add-user-shipping)
  --allow <csv>        Comma-separated destructive-change permissions:
                       drop-column,drop-table,type-change,drop-index,drop-fk,
                       drop-check,drop-view,drop-view-cascade,
                       adopt-view,nullable-to-not-null,drop-identity-default
  --on-ambiguous abort|rename|drop-add
                       How to handle ambiguous renames (default: abort)
  --from-db            Introspect live DB instead of using the committed snapshot
  --apply              Run pending migration files against the DB after writing
  --rollback <target>  Roll back applied migrations newer than <target>
  --d1 <binding>       D1 binding name from wrangler.toml (only with --dialect d1)
  --remote             Target remote D1 instead of local (only with --dialect d1)
  --yes                Skip the --remote --apply confirmation pause
  --dry-run            Print SQL to stdout, don't write
  --help, -h           Print this help

EXAMPLES:
  # New project — create tables in a fresh database (introspect → diff → CREATE TABLE → apply):
  meta migrate --from-db --db file:dev.sqlite --dialect sqlite --slug init --apply
  # Later — add a schema change and apply it:
  meta migrate --db file:dev.sqlite --dialect sqlite --slug add-users --apply
  meta migrate --db postgresql://localhost/mydb --slug add-index --apply
  # Adopt an existing database — snapshot its current schema first:
  meta migrate baseline --from-db --db postgresql://localhost/mydb
  # Provision a fresh/CI database from the committed migration files:
  meta migrate apply-pending --db postgresql://localhost/mydb
`;

/** Emit a structured error on stdout (not stderr) in the active format, per axi. */
/** Flyway's conventional migrations location for a JVM project (#192). */
const FLYWAY_DEFAULT_OUT_DIR = "src/main/resources/db/migration";

/**
 * Resolve the migration output dir for the active format. Mirrors the D1 path's
 * shape: an explicit --out-dir always wins; otherwise each adapter falls back to
 * its own ecosystem convention rather than the homegrown default.
 */
function resolveFormatOutDir(config: ResolvedMigrateConfig, metaRoot: string): string {
  const isDefaultOutDir = config.outDir === MIGRATE_DEFAULT_OUT_DIR;
  if (config.format === "flyway" && isDefaultOutDir) {
    return resolvePath(metaRoot, FLYWAY_DEFAULT_OUT_DIR);
  }
  return resolvePath(metaRoot, config.outDir);
}

/**
 * Say what a declared `migrate.scope` left out. An excluded object produces neither
 * a create nor a drop, so without this line "no changes" and "no changes to the half
 * of the model this run governs" read identically.
 */
function logOutOfScope(names: readonly string[]): void {
  if (names.length === 0) return;
  log.info(
    `meta migrate — ${names.length} object(s) out-of-scope (outside migrate.scope, ` +
      `governed elsewhere): ${names.join(", ")}`,
  );
}

function emitStructuredError(error: string, hint: string, fmt: OutputFormat): void {
  const payload = { error, hint };
  if (fmt === "json") {
    log.info(JSON.stringify(payload, null, 2));
  } else if (fmt === "toon") {
    log.info(toonEncode(payload));
  }
  // text format: errors go to stderr via log.error() — the caller handles that path
}

/**
 * Sentinel thrown by sub-functions that have already emitted a structured error
 * via emitStructuredError(). The top-level catch in migrateCommand re-throws
 * this as-is without double-emitting.
 */
class AlreadyEmittedError extends Error {
  constructor(public readonly exitCode: number) {
    super("already-emitted");
  }
}

function mapOnAmbiguous(v: "abort" | "rename" | "drop-add"): AmbiguousResolution {
  return v === "drop-add" ? "drop+add" : v;
}

/**
 * The command that actually creates tables in a fresh/empty database. This is the
 * correct first step for a brand-new project — it introspects the (empty) DB, diffs
 * metadata against it to produce every CREATE TABLE, and applies them. Offline
 * `baseline` is NOT this: it records the desired schema as already-applied and emits
 * no DDL (launch-blocker B1).
 */
function greenfieldCreateCmd(dialect: string | undefined): string {
  const d = dialect ?? "sqlite";
  return `meta migrate --from-db --db <url> --dialect ${d} --slug init --apply`;
}

/** The command to adopt a database that already exists (snapshot its live schema). */
function adoptExistingDbCmd(): string {
  return "meta migrate baseline --from-db --db <url>";
}

/** Shared `emitStructuredError` detail — points at the greenfield-create and
 *  adopt-existing commands. Used by the empty-DB refusal and the no-snapshot hint. */
function nextStepsDetail(dialect: string | undefined): string {
  return `run \`${greenfieldCreateCmd(dialect)}\` to create tables, or \`${adoptExistingDbCmd()}\` to adopt an existing database`;
}

/** Table count of the target DB, or undefined when it can't be reached/introspected
 *  (any failure ⇒ unknown ⇒ never block; the caller warns instead of refusing). */
async function countLiveTables(
  url: string,
  dialect: ResolvedMigrateConfig["dialect"],
): Promise<number | undefined> {
  try {
    const kysely = await buildKyselyFromUrl(url, dialect);
    try {
      return (await introspect(kysely.db, kysely.dialect)).tables.length;
    } finally {
      await kysely.close();
    }
  } catch {
    return undefined;
  }
}

function summarizeChanges(changes: Change[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of changes) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  return counts;
}

function allowFlagFor(kind: string): string {
  switch (kind) {
    case "drop-column": return "drop-column";
    case "drop-table": return "drop-table";
    case "drop-index": return "drop-index";
    case "drop-fk": return "drop-fk";
    case "change-column-type": return "type-change";
    case "change-column-nullable": return "nullable-to-not-null";
    case "change-column-default": return "drop-identity-default";
    default: return kind;
  }
}

function blockedToEntries(err: BlockedChangesError): BlockedEntry[] {
  return err.blocked.map((c) => ({
    kind: c.kind,
    description: describeChange(c),
    allowFlag: allowFlagFor(c.kind),
  }));
}

function ambiguousToEntries(amb: AmbiguousChange[]): AmbiguousEntry[] {
  return amb.map((a) => {
    if (a.kind === "possible-column-rename") {
      return {
        kind: a.kind,
        description: `${a.table}.${a.from.name} → ${a.table}.${a.to.name}`,
        hint: `${a.from.sqlType.kind} → ${a.to.sqlType.kind}`,
      };
    }
    return {
      kind: a.kind,
      description: `${a.from.name} → ${a.to.name}`,
      hint: `column-set overlap ${a.columnOverlap.toFixed(2)}`,
    };
  });
}

export async function migrateCommand(
  args: string[],
  cwd: string,
  /** Injectable wrangler runner — tests pass a mock; production uses the default. */
  wranglerRunner?: WranglerRunner,
  fmt: OutputFormat = "text",
): Promise<number> {
  // Intercept --help / -h before parseMigrateArgs (parseArgs strict mode rejects them).
  if (args.includes("--help") || args.includes("-h")) {
    log.info(MIGRATE_HELP_TEXT);
    return 0;
  }

  let flags;
  try {
    flags = parseMigrateArgs(args);
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`migrate: ${msg}`);
    emitStructuredError(`migrate: ${msg}`, "run `meta migrate --help` for usage", fmt);
    return 2;
  }

  const metaRoot = cwd;
  const config = await resolveMigrateConfig(flags, metaRoot);

  try {
  // #192 — Flyway owns apply + history (flyway_schema_history). We generate the
  // migration; applying it is Flyway's job. Refuse at generation time rather than
  // emitting something that would desync its history table (the #226/#241/#258
  // detect-and-refuse posture).
  if (config.format === "flyway") {
    if (config.dialect === "d1") {
      log.error(`migrate: --migration-format flyway is not supported for dialect 'd1' (d1 has its own wrangler migrations layout)`);
      emitStructuredError(
        `migrate: --migration-format flyway is not supported for dialect 'd1'`,
        "drop --migration-format flyway for d1 — wrangler owns the migrations layout",
        fmt,
      );
      return 2;
    }
    if (config.apply) {
      log.error(`migrate: --apply is not supported with --migration-format flyway — run 'flyway migrate' to apply`);
      emitStructuredError(
        `migrate: --apply is not supported with --migration-format flyway`,
        "run 'flyway migrate' to apply — applying behind Flyway desyncs flyway_schema_history",
        fmt,
      );
      return 2;
    }
    if (config.applyPending) {
      log.error(`migrate apply-pending is not supported with --migration-format flyway — run 'flyway migrate' to replay`);
      emitStructuredError(
        `migrate apply-pending is not supported with --migration-format flyway`,
        "run 'flyway migrate' to replay committed migrations",
        fmt,
      );
      return 2;
    }
    if (config.rollback !== undefined) {
      log.error(`migrate: --rollback is not supported with --migration-format flyway — use 'flyway undo' (Teams) or roll forward`);
      emitStructuredError(
        `migrate: --rollback is not supported with --migration-format flyway`,
        "use 'flyway undo' (Flyway Teams) or roll forward — the metaobjects ledger does not exist on a Flyway-managed DB",
        fmt,
      );
      return 2;
    }
  }

  if (config.dialect === "d1") {
    if (config.baseline) {
      log.error(`migrate baseline is not supported for dialect 'd1' (snapshots are a postgres/sqlite concept)`);
      emitStructuredError(
        `migrate baseline is not supported for dialect 'd1'`,
        "drop 'baseline' for d1 — snapshots are a postgres/sqlite concept",
        fmt,
      );
      return 2;
    }
    if (config.applyPending) {
      log.error(`migrate apply-pending is not supported for dialect 'd1' — use 'wrangler d1 migrations apply' to replay committed migrations`);
      emitStructuredError(
        `migrate apply-pending is not supported for dialect 'd1'`,
        "use 'wrangler d1 migrations apply' to replay committed migrations for d1",
        fmt,
      );
      return 2;
    }
    if (config.databaseUrl !== undefined) {
      log.error(`migrate: --db / DATABASE_URL is not used for dialect 'd1' — wrangler.toml owns connection`);
      emitStructuredError(
        `migrate: --db / DATABASE_URL is not used for dialect 'd1'`,
        "remove --db / DATABASE_URL for d1 — wrangler.toml owns the connection",
        fmt,
      );
      return 2;
    }
    if (config.rollback !== undefined) {
      log.error(`migrate: --rollback is not supported for dialect 'd1' (use 'wrangler d1 migrations' tooling)`);
      emitStructuredError(
        `migrate: --rollback is not supported for dialect 'd1'`,
        "use 'wrangler d1 migrations' tooling to roll back d1",
        fmt,
      );
      return 2;
    }
    return await runD1Migrate(config, metaRoot, wranglerRunner ?? defaultWranglerRunner, fmt);
  }

  // `migrate baseline` — seed the committed reference snapshot, emit no migration.
  if (config.baseline) {
    return await runBaseline(config, metaRoot, fmt);
  }

  // `migrate apply-pending` — replay committed migration files; no diff, no metadata load.
  if (config.applyPending) {
    return await runApplyPending(config, metaRoot, fmt);
  }

  // Default = offline snapshot generation. The live-introspection path runs only
  // when explicitly requested via --from-db, when --apply needs a connection, or
  // for --rollback (which runs hand-authored down.sql against the live DB).
  if (!config.fromDb && !config.apply && config.rollback === undefined) {
    return await runOfflineGenerate(config, metaRoot, fmt);
  }

  if (config.databaseUrl === undefined) {
    log.error(`migrate: --db <url> required (or set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json)`);
    emitStructuredError(
      `migrate: --db <url> required`,
      "pass --db <url>, set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json",
      fmt,
    );
    return 2;
  }

  // --rollback short-circuits the diff/emit pipeline: it runs the down.sql of
  // every applied migration NEWER than <target> (target retained), in reverse
  // order, ledger-tracked + advisory-locked. postgres/sqlite only.
  if (config.rollback !== undefined) {
    return await runRollback(config, metaRoot);
  }

  // Best-effort load of metaobjects.config.ts to pick up consumer-supplied
  // providers. migrate's postgres/sqlite path also reads the config later
  // for columnNamingStrategy; we load it once here and reuse below.
  let postgresConfigProviders: readonly import("@metaobjectsdev/codegen-ts").MetaDataTypeProvider[] | undefined;
  try {
    const forgeConfig = await loadMetaobjectsConfig(metaRoot);
    postgresConfigProviders = forgeConfig.providers;
  } catch {
    postgresConfigProviders = undefined;
  }

  // Discovery and load are two separate failure modes, kept in separate try blocks
  // (the `meta gen` pattern): a broad catch around both reports a genuine ParseError
  // as "no metadata found", masking the real failure. `resolveCollection` raises
  // ERR_COLLECTION_NOT_FOUND with its own message — the same exit 2 the hand-rolled
  // ENOENT sniff used to produce.
  let collection;
  try {
    collection = await resolveCollection(metaRoot);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let metadata;
  try {
    metadata = await loadMemory(collection.configDir, {
      files: collection.files,
      ...(postgresConfigProviders !== undefined ? { providers: postgresConfigProviders } : {}),
    });
  } catch (err) {
    log.error(`failed to load metadata: ${(err as Error).message}`);
    return 2;
  }

  const scopeMismatch = migrateScopeMismatch(collection, metadata);
  if (scopeMismatch !== undefined) {
    log.error(`migrate: ${scopeMismatch}`);
    emitStructuredError(`migrate: ${scopeMismatch}`, "fix or remove migrate.scope in .metaobjects/config.json", fmt);
    return 2;
  }

  let kysely;
  try {
    kysely = await buildKyselyFromUrl(config.databaseUrl, config.dialect);
  } catch (err) {
    log.error(`migrate: ${(err as Error).message}`);
    return 2;
  }

  let exitCode = 0;
  let writtenPaths: string[] = [];
  let appliedNames: string[] = [];
  let applyFailed = false;
  let blocked: BlockedEntry[] = [];
  let ambiguous: AmbiguousEntry[] = [];
  let changeCounts: Record<string, number> = {};

  try {
    // Column-naming strategy (from metaobjects.config) drives BOTH the table schema
    // and projection view DDL — derive it once, up front, so every view path agrees.
    let columnNamingStrategy: "snake_case" | "literal" | "kebab-case" = "snake_case";
    try {
      const cfg = await loadMetaobjectsConfig(metaRoot);
      if (cfg.columnNamingStrategy) columnNamingStrategy = cfg.columnNamingStrategy;
    } catch {
      // metaobjects.config.ts absent or invalid — use default snake_case
    }
    // Expected views from the SINGLE view-SQL source (codegen-ts emitViewDdl, via
    // buildProjectionViews). Threaded into the schema-diff so the diff produces all
    // view DDL (create/drop/replace + dependency-recreate) and emit() renders it —
    // there is no separate view-migration emitter.
    const expectedViews = buildProjectionViews(metadata, { dialect: kysely.dialect, columnNamingStrategy });
    // Per-command scope: objects outside `migrate.scope` are another owner's. They
    // leave the expected schema here and are suppressed on the actual side below —
    // dropping them from `expected` ALONE would propose DROP TABLE for every one of
    // them that exists in the database.
    const scoped = scopeExpectedSchema(
      buildExpectedSchemaWithProvenance(metadata, {
        dialect: kysely.dialect,
        columnNamingStrategy,
        views: expectedViews,
      }),
      toObjectScope(collection.migrateScope),
    );
    const expected = scoped.snapshot;
    logOutOfScope(scoped.outOfScope);
    let actual;
    try {
      actual = await introspect(kysely.db, kysely.dialect);
    } catch (err) {
      log.error(`migrate: failed to connect to ${kysely.displayUrl}: ${(err as Error).message}`);
      await kysely.close();
      return 2;
    }

    const collectedAmbiguous: AmbiguousChange[] = [];
    const onAmbiguousResolution = mapOnAmbiguous(config.onAmbiguous);

    let diffResult;
    try {
      diffResult = await diff({
        expected,
        actual,
        dialect: kysely.dialect,
        allow: tokensToAllowOptions(config.allow),
        // #258 — adopting a live DB whose PRIMARY KEY differs from the metadata identity
        // has no expressible migration; refuse loudly instead of emitting SQL that drops
        // the constraint and breaks referencing FKs at apply.
        refusePrimaryKeyChange: true,
        // #208 §7 — declared-@unmanaged objects are external: exclude them from the
        // actual side so migrate proposes neither create nor drop for them. Objects
        // outside `migrate.scope` ride the same seam, for the same reason.
        unmanagedNames: [...collectUnmanagedNames(metadata), ...scoped.outOfScope],
        // Pin the schema scope to the UNSCOPED model's schemas (see migrate-ts's
        // scope.ts header): a `migrate.scope` matching nothing would otherwise empty
        // `expected`, which `diff` reads as "no model, govern the whole database".
        // Absent when no scope was given, so an unscoped run is unchanged.
        ...(scoped.declaredSchemas !== undefined ? { scopeSchemas: scoped.declaredSchemas } : {}),
        onAmbiguous: async (a) => {
          collectedAmbiguous.push(a);
          return onAmbiguousResolution;
        },
      });
    } catch (err) {
      // #258 — a primary-key move has no expressible migration; refuse loudly.
      if (err instanceof PrimaryKeyChangeError) {
        log.error(`migrate: ${err.message}`);
        emitStructuredError(`migrate: ${err.message}`, "align the primary key manually, or reconcile the metadata identity to match the live table", fmt);
        await kysely.close();
        return 1;
      }
      // diff() throws when onAmbiguous returns "abort" — surface as exit 1
      // with the collected ambiguity list.
      if ((err as Error).message.includes("aborted by onAmbiguous")) {
        ambiguous = ambiguousToEntries(collectedAmbiguous);
        const migrateResult = {
          dialect: kysely.dialect,
          displayUrl: kysely.displayUrl,
          changeCounts: {},
          blocked: [],
          ambiguous,
          writtenPaths: [],
          dryRun: config.dryRun,
          applied: [],
          applyFailed: false,
        };
        const output =
          fmt === "toon" ? formatMigrateResultToon(migrateResult)
          : fmt === "json" ? formatMigrateResultJson(migrateResult)
          : formatMigrateResult(migrateResult, { isTTY: !!process.stdout.isTTY });
        log.info(output);
        await kysely.close();
        return 1;
      }
      throw err;
    }

    changeCounts = summarizeChanges(diffResult.changes);

    // All changes — tables AND views — are emitted by the one schema-diff path.
    // View DDL (create/drop/replace) is produced by diff()'s view passes (2b body
    // comparison, 2c dependency-recreate) and rendered by every dialect's emitter;
    // STAGE_ORDER sequences drop-view before and create-view after any column change
    // a view reads. There is no separate view-migration emitter, and unchanged views
    // produce no change (introspect reads the actual body, diff compares it).
    if (diffResult.changes.length === 0) {
      // no-op — output will say "No schema changes"
    } else {
      let emitted: EmitResult | undefined;
      try {
        emitted = emit(diffResult.changes, {
          dialect: kysely.dialect,
          expectedSchema: expected,
          actualSchema: actual,
          ...(actual.meta !== undefined ? { actualMeta: actual.meta } : {}),
        });
      } catch (err) {
        if (err instanceof BlockedChangesError) {
          blocked = blockedToEntries(err);
          exitCode = 1;
        } else {
          throw err;
        }
      }

      if (exitCode === 0 && emitted) {
        if (config.slug === undefined) {
          log.error(`migrate: --slug <name> required when there are changes (e.g., --slug add-user-shipping)`);
          await kysely.close();
          return 2;
        }

        if (config.dryRun) {
          log.info(`-- UP --\n${emitted.up}\n\n-- DOWN --\n${emitted.down}`);
        } else {
          const outDir = resolveFormatOutDir(config, metaRoot);
          await mkdir(outDir, { recursive: true });
          // #192 — only the envelope differs; the emitted SQL is identical.
          const res = config.format === "flyway"
            ? await writeMigrationFlyway(
                { up: emitted.up, down: emitted.down },
                { dir: outDir, slug: config.slug },
              )
            : await writeMigration(
                { up: emitted.up, down: emitted.down },
                { dir: outDir, slug: config.slug },
              );
          writtenPaths = [res.upPath, res.downPath];
        }
      }
    }

    // --apply: run pending committed migration files against the DB, tracked by
    // the migration-history ledger, transactionally. Idempotency comes from the
    // ledger (skip already-applied), NOT from re-diffing — so this also applies
    // any previously-written-but-unapplied files in this run. Skipped on dry-run
    // and when a prior step set a non-zero exit (e.g. blocked changes).
    if (config.apply && exitCode === 0 && !config.dryRun) {
      const outDir = resolvePath(metaRoot, config.outDir);
      try {
        // applyPending calls ensureLedger internally (idempotent), so no need
        // to ensure it here. Pass the dialect so postgres gets schema-qualified
        // ledger DDL + the session advisory lock (sqlite is a no-op there).
        const result = await applyPending(kysely.db, outDir, {
          dryRun: false,
          dialect: kysely.dialect as "sqlite" | "postgres",
        });
        appliedNames = [...result.applied];
      } catch (err) {
        log.error(`migrate: apply failed: ${(err as Error).message}`);
        exitCode = 1;
        applyFailed = true;
      }
    }

    // Advance the committed reference snapshot — the live-DB path writes the same
    // migration files the offline path does, so it owes the same bookkeeping. It
    // used to skip it, which broke the documented day-1 -> day-2 sequence: the
    // greenfield `--from-db … --apply` command `meta init` prints created the
    // schema but left no snapshot, so the very next incremental
    // `meta migrate --dialect <d> --slug …` died with `no schema snapshot` on a
    // project whose database was provably correct. (The `--apply`-only variant of
    // the documented everyday flow had it worse: no warning, and the next offline
    // diff re-emitted the already-applied change.)
    //
    // The snapshot means "the schema the COMMITTED MIGRATIONS land you in", so it
    // advances exactly when this run wrote one — the same rule runOfflineGenerate
    // follows (it returns on `no changes` before writing). Advancing on a run that
    // emitted nothing would be the greenfield-`baseline` trap by another door: a
    // drift check against a hand-migrated database would record the target schema
    // as already-applied with no CREATE TABLE anywhere, so the offline path would
    // report `no changes` forever and `apply-pending` would provision an empty
    // database. Dry-run previews nothing, and a blocked / refused / apply-failed
    // run must not record a schema the database is not in.
    //
    // Written as the metadata-expected schema — the same construction offline
    // persists as `nextSnapshot`, so both paths converge on one representation and
    // a follow-up offline diff sees no phantom churn — but carrying the live
    // engine version introspection just captured, which `emit` reads to choose
    // native ALTER vs recreate-and-copy on older SQLite.
    if (!config.dryRun && exitCode === 0 && !applyFailed && writtenPaths.length > 0) {
      try {
        await writeSnapshot(
          snapshotPath(resolvePath(metaRoot, config.outDir), kysely.dialect),
          actual.meta !== undefined ? { ...expected, meta: actual.meta } : expected,
        );
      } catch (err) {
        // The migration itself is written (and possibly applied) — report the
        // bookkeeping failure for what it is rather than as an unexpected error.
        log.error(`migrate: failed to write the schema snapshot: ${(err as Error).message}`);
        exitCode = 1;
      }
    }
  } finally {
    try {
      await kysely.close();
    } catch (err) {
      log.warn(`migrate: failed to close DB cleanly: ${(err as Error).message}`);
    }
  }

  const migrateResult = {
    dialect: kysely.dialect,
    displayUrl: kysely.displayUrl,
    changeCounts,
    blocked,
    ambiguous,
    writtenPaths,
    dryRun: config.dryRun,
    format: config.format,
    applied: appliedNames,
    applyFailed,
  };
  const output =
    fmt === "toon" ? formatMigrateResultToon(migrateResult)
    : fmt === "json" ? formatMigrateResultJson(migrateResult)
    : formatMigrateResult(migrateResult, { isTTY: !!process.stdout.isTTY });

  log.info(output);
  if (config.apply && exitCode === 0) {
    if (appliedNames.length > 0) {
      log.info(`migrate: applied ${appliedNames.length} migration(s): ${appliedNames.join(", ")}`);
    } else {
      log.info(`migrate: no pending migrations to apply`);
    }
  }
  return exitCode;
  } catch (err) {
    // AlreadyEmittedError: sub-function already called emitStructuredError — just
    // propagate the exit code without double-emitting.
    if (err instanceof AlreadyEmittedError) return err.exitCode;
    // Unexpected error: emit structured error on stdout in the active format, then exit 1.
    const msg = (err as Error).message ?? String(err);
    log.error(`migrate: unexpected error: ${msg}`);
    emitStructuredError(`migrate: unexpected error: ${msg}`, "run `meta migrate --help` for usage", fmt);
    return 1;
  }
}

/**
 * `meta migrate baseline [--from-db]` — seed the committed reference snapshot.
 * `--from-metadata` (default) derives it from metadata; `--from-db` introspects
 * an existing database once. Emits no migration.
 */
export async function runBaseline(
  config: ResolvedMigrateConfig,
  metaRoot: string,
  fmt: OutputFormat = "text",
): Promise<number> {
  if (config.dialect === undefined) {
    log.error(`migrate baseline: --dialect required (or set migrate.dialect in .metaobjects/config.json)`);
    return 2;
  }
  const outDir = resolvePath(metaRoot, config.outDir);
  const path = snapshotPath(outDir, config.dialect);

  let snapshot;
  if (config.fromDb) {
    if (config.databaseUrl === undefined) {
      log.error(`migrate baseline --from-db: --db <url> required`);
      return 2;
    }
    let kysely;
    try {
      kysely = await buildKyselyFromUrl(config.databaseUrl, config.dialect);
    } catch (err) {
      log.error(`migrate baseline: ${(err as Error).message}`);
      return 2;
    }
    try {
      snapshot = await introspect(kysely.db, kysely.dialect);
    } finally {
      await kysely.close();
    }
  } else {
    // Greenfield-trap guard (launch-blocker B1). An offline baseline records the
    // metadata's DESIRED schema as the already-applied baseline; on an empty/new
    // database that silently suppresses every CREATE TABLE forever. When we can see
    // the target --db and PROVE it has no tables, refuse and point at the working
    // greenfield path. In every OTHER case — no --db, a non-empty --db, or a --db we
    // couldn't reach — we still write the snapshot but WARN: an offline baseline is
    // only correct when the database already matches the metadata, and emits no DDL.
    const liveTableCount = config.databaseUrl !== undefined
      ? await countLiveTables(config.databaseUrl, config.dialect)
      : undefined;
    if (liveTableCount === 0) {
      // `liveTableCount === 0` ⇒ databaseUrl was defined (countLiveTables only
      // returns a number when it introspected a real connection).
      log.error(
        `migrate baseline: the database at ${redactUrl(config.databaseUrl!)} has no tables — ` +
        `baselining now would record your metadata as already-applied and no CREATE TABLE ` +
        `would ever be emitted. For a new/empty database run \`${greenfieldCreateCmd(config.dialect)}\` ` +
        `to create your tables (or \`${adoptExistingDbCmd()}\` to adopt an existing database).`,
      );
      emitStructuredError("migrate baseline: target database is empty", nextStepsDetail(config.dialect), fmt);
      return 2;
    }
    log.warn(
      `migrate baseline (offline): recording your metadata's schema as the already-applied ` +
      `baseline — this emits NO CREATE TABLE. Use it only if your database already matches ` +
      `your metadata; for a new/empty database run \`${greenfieldCreateCmd(config.dialect)}\` instead.`,
    );
    let metadata;
    // Load metaobjects.config.ts ONCE, up front, for BOTH the consumer providers
    // and the columnNamingStrategy — mirroring the DB path (and `meta gen`) so
    // offline baseline resolves config-registered custom subtypes too (#157).
    let baselineConfigProviders:
      | readonly import("@metaobjectsdev/codegen-ts").MetaDataTypeProvider[]
      | undefined;
    let baselineStrategy: "snake_case" | "literal" | "kebab-case" = "snake_case";
    try {
      const cfg = await loadMetaobjectsConfig(metaRoot);
      baselineConfigProviders = cfg.providers;
      if (cfg.columnNamingStrategy) baselineStrategy = cfg.columnNamingStrategy;
    } catch {
      // config absent — no custom providers, default snake_case
    }
    // `baseline` records a STARTING POINT, so it is deliberately NOT scoped: the
    // `--from-db` arm captures whatever the database holds (there is no provenance
    // for an introspected table), and an offline baseline that recorded less would
    // disagree with it. An out-of-scope table sitting in the snapshot is harmless —
    // every later run suppresses it on both sides.
    try {
      const collection = await resolveCollection(metaRoot);
      metadata = await loadMemory(collection.configDir, {
        files: collection.files,
        ...(baselineConfigProviders !== undefined ? { providers: baselineConfigProviders } : {}),
      });
    } catch (err) {
      log.error(`migrate baseline: failed to load metadata: ${(err as Error).message}`);
      return 2;
    }
    const baselineViews = buildProjectionViews(metadata, { dialect: config.dialect, columnNamingStrategy: baselineStrategy });
    snapshot = baselineFromMetadata(metadata, config.dialect, baselineStrategy, baselineViews);
  }

  if (config.dryRun) {
    log.info(`migrate baseline (dry-run): would write schema snapshot ${path}`);
    return 0;
  }

  await writeSnapshot(path, snapshot);
  log.info(`migrate: wrote schema snapshot ${path}`);
  return 0;
}

/**
 * `meta migrate apply-pending` — replay the committed migration files against the
 * target DB, ledger-tracked and transactional (no diff, no metadata load). This is the
 * fresh-DB / CI provisioning path the diff-first `--apply` cannot serve. postgres/sqlite
 * only (d1 replays via `wrangler d1 migrations apply`). See #242.
 */
export async function runApplyPending(
  config: ResolvedMigrateConfig,
  metaRoot: string,
  fmt: OutputFormat = "text",
): Promise<number> {
  if (config.databaseUrl === undefined) {
    log.error(`migrate apply-pending: --db <url> required (or set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json)`);
    emitStructuredError(
      `migrate apply-pending: --db <url> required`,
      "pass --db <url>, set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json",
      fmt,
    );
    return 2;
  }

  let kysely;
  try {
    kysely = await buildKyselyFromUrl(config.databaseUrl, config.dialect);
  } catch (err) {
    log.error(`migrate apply-pending: ${(err as Error).message}`);
    return 2;
  }

  const outDir = resolvePath(metaRoot, config.outDir);
  let exitCode = 0;
  let pendingNames: string[] = [];
  let appliedNames: string[] = [];
  try {
    const result = await applyPending(kysely.db, outDir, {
      dryRun: config.dryRun,
      dialect: kysely.dialect as "sqlite" | "postgres",
    });
    pendingNames = [...result.pending];
    appliedNames = [...result.applied];
  } catch (err) {
    log.error(`migrate apply-pending: apply failed: ${(err as Error).message}`);
    exitCode = 1;
  } finally {
    try {
      await kysely.close();
    } catch (err) {
      log.warn(`migrate apply-pending: failed to close DB cleanly: ${(err as Error).message}`);
    }
  }
  if (exitCode !== 0) return exitCode;

  const payload = {
    command: "apply-pending",
    dialect: kysely.dialect,
    displayUrl: kysely.displayUrl,
    dryRun: config.dryRun,
    pending: pendingNames,
    applied: appliedNames,
  };
  if (fmt === "json") {
    log.info(JSON.stringify(payload, null, 2));
  } else if (fmt === "toon") {
    log.info(toonEncode(payload));
  } else if (config.dryRun) {
    log.info(
      pendingNames.length > 0
        ? `migrate apply-pending (dry-run): ${pendingNames.length} pending: ${pendingNames.join(", ")}`
        : `migrate apply-pending (dry-run): already up to date`,
    );
  } else {
    log.info(
      appliedNames.length > 0
        ? `migrate apply-pending: applied ${appliedNames.length} migration(s): ${appliedNames.join(", ")}`
        : `migrate apply-pending: already up to date`,
    );
  }
  return 0;
}

/**
 * Default `meta migrate` generate path — fully offline. Diffs metadata against
 * the committed snapshot (no DB), writes up/down.sql, and advances the snapshot.
 * The live-introspection path is used only with --from-db or --apply.
 *
 * Scope: table/column/index/FK changes. Projection-view migrations stay on the
 * introspection path (offline-view parity is a follow-up).
 */
export async function runOfflineGenerate(
  config: ResolvedMigrateConfig,
  metaRoot: string,
  fmt: OutputFormat = "text",
): Promise<number> {
  if (config.dialect === undefined) {
    log.error(`migrate: --dialect required for offline generation (or use --from-db)`);
    return 2;
  }
  // Load metaobjects.config.ts ONCE, up front, for BOTH the consumer providers
  // and the columnNamingStrategy — mirroring the DB path (and `meta gen`) so
  // offline generate resolves config-registered custom subtypes too (#157).
  let offlineConfigProviders:
    | readonly import("@metaobjectsdev/codegen-ts").MetaDataTypeProvider[]
    | undefined;
  let offlineStrategy: "snake_case" | "literal" | "kebab-case" = "snake_case";
  try {
    const cfg = await loadMetaobjectsConfig(metaRoot);
    offlineConfigProviders = cfg.providers;
    if (cfg.columnNamingStrategy) offlineStrategy = cfg.columnNamingStrategy;
  } catch {
    // config absent — no custom providers, default snake_case
  }

  let metadata;
  let collection;
  try {
    collection = await resolveCollection(metaRoot);
    metadata = await loadMemory(collection.configDir, {
      files: collection.files,
      ...(offlineConfigProviders !== undefined ? { providers: offlineConfigProviders } : {}),
    });
  } catch (err) {
    log.error(`migrate: failed to load metadata: ${(err as Error).message}`);
    return 2;
  }

  const offlineScopeMismatch = migrateScopeMismatch(collection, metadata);
  if (offlineScopeMismatch !== undefined) {
    log.error(`migrate: ${offlineScopeMismatch}`);
    emitStructuredError(`migrate: ${offlineScopeMismatch}`, "fix or remove migrate.scope in .metaobjects/config.json", fmt);
    return 2;
  }

  const outDir = resolvePath(metaRoot, config.outDir);
  const path = snapshotPath(outDir, config.dialect);
  let snapshot;
  try {
    snapshot = await readSnapshot(path);
  } catch (err) {
    log.error(`migrate: cannot read schema snapshot at ${path}: ${(err as Error).message}`);
    return 2;
  }
  if (snapshot === null) {
    // For a brand-new project the working first step is the greenfield --from-db …
    // --apply path (introspect the empty DB, diff, CREATE TABLE, apply), NOT the
    // offline `baseline` subcommand — offline baseline records the desired schema as
    // already-applied and would suppress every CREATE TABLE (launch-blocker B1).
    log.error(
      `migrate: no schema snapshot at ${path}. For a new project run ` +
      `\`${greenfieldCreateCmd(config.dialect)}\` to create your tables, or ` +
      `\`${adoptExistingDbCmd()}\` to adopt an existing database.`,
    );
    // Structured next-step on stdout so callers / agents can parse it, in the active format.
    emitStructuredError("no schema snapshot", nextStepsDetail(config.dialect), fmt);
    return 2;
  }

  const collectedAmbiguous: AmbiguousChange[] = [];
  const onAmbiguousResolution = mapOnAmbiguous(config.onAmbiguous);

  const offlineViews = buildProjectionViews(metadata, { dialect: config.dialect, columnNamingStrategy: offlineStrategy });
  const offlineScope = toObjectScope(collection.migrateScope);

  let plan;
  try {
    plan = await planOffline({
      metadata,
      dialect: config.dialect,
      snapshot,
      columnNamingStrategy: offlineStrategy,
      views: offlineViews,
      // Per-command scope — narrows BOTH sides of the offline diff (see planOffline).
      ...(offlineScope !== undefined ? { inScope: offlineScope } : {}),
      allow: tokensToAllowOptions(config.allow),
      onAmbiguous: async (a) => {
        collectedAmbiguous.push(a);
        return onAmbiguousResolution;
      },
    });
  } catch (err) {
    // #258 — a primary-key move has no expressible migration; refuse loudly.
    if (err instanceof PrimaryKeyChangeError) {
      log.error(`migrate: ${err.message}`);
      emitStructuredError(`migrate: ${err.message}`, "align the primary key manually, or reconcile the metadata identity to match the live table", fmt);
      return 1;
    }
    if ((err as Error).message.includes("aborted by onAmbiguous")) {
      log.error(`migrate: ambiguous rename/drop detected; re-run with --on-ambiguous rename|drop-add`);
      return 1;
    }
    throw err;
  }

  const { diff: diffResult, nextSnapshot } = plan;
  logOutOfScope(plan.outOfScope);

  if (diffResult.blocked.length > 0) {
    log.error(`migrate: ${diffResult.blocked.length} destructive change(s) blocked; re-run with --allow <tokens>`);
    return 1;
  }
  if (diffResult.changes.length === 0) {
    log.info(`migrate: no changes`);
    return 0;
  }
  if (config.slug === undefined) {
    log.error(`migrate: --slug <name> required when there are changes (e.g., --slug add-user-shipping)`);
    return 2;
  }

  const emitResult = emit(diffResult.changes, {
    dialect: config.dialect,
    expectedSchema: nextSnapshot,
    actualSchema: snapshot,
    ...(snapshot.meta ? { actualMeta: snapshot.meta } : {}),
  });

  if (config.dryRun) {
    log.info(`-- UP --\n${emitResult.up}\n\n-- DOWN --\n${emitResult.down}`);
    return 0;
  }

  // #192 — the MIGRATION FILES follow the active format's layout, while the
  // snapshot stays in `outDir` (it is metaobjects' own state). With the default
  // out-dir that separates them: snapshot in .metaobjects/migrations/, migrations
  // in the Flyway dir. With an explicit --out-dir the two coincide by the caller's
  // own choice — harmless, since the snapshot is a dotfile and Flyway scans *.sql.
  const writeDir = resolveFormatOutDir(config, metaRoot);
  await mkdir(writeDir, { recursive: true });
  const res = config.format === "flyway"
    ? await writeMigrationFlyway(
        { up: emitResult.up, down: emitResult.down },
        { dir: writeDir, slug: config.slug },
      )
    : await writeMigration(
        { up: emitResult.up, down: emitResult.down },
        { dir: writeDir, slug: config.slug },
      );
  await writeSnapshot(path, nextSnapshot);
  log.info(`migrate: wrote ${res.upPath}`);
  return 0;
}

/**
 * `meta migrate --rollback <target>` — run the down.sql of every applied
 * migration newer than <target> (target retained) in reverse order, against the
 * live DB, ledger-tracked + advisory-locked. postgres/sqlite only.
 *
 * Pass `--rollback ""` (empty target) is treated as null → roll back everything.
 */
async function runRollback(
  config: ResolvedMigrateConfig,
  metaRoot: string,
): Promise<number> {
  // databaseUrl is guaranteed defined by the caller's guard above.
  const databaseUrl = config.databaseUrl as string;

  // Rollback is destructive and runs hand-authored down.sql; there is no
  // meaningful dry-run plan (no diff to preview), so reject the combination
  // rather than silently executing.
  if (config.dryRun) {
    log.error(`migrate: --dry-run is not supported with --rollback`);
    return 2;
  }

  let kysely;
  try {
    kysely = await buildKyselyFromUrl(databaseUrl, config.dialect);
  } catch (err) {
    log.error(`migrate: ${(err as Error).message}`);
    return 2;
  }
  // kysely.dialect is "sqlite" | "postgres" here — d1 is rejected upstream.
  const dialect = kysely.dialect as "sqlite" | "postgres";
  const outDir = resolvePath(metaRoot, config.outDir);
  // An empty --rollback string means "roll back everything".
  const target = config.rollback === "" ? null : (config.rollback ?? null);

  try {
    const result = await rollbackTo(kysely.db, outDir, target, { dialect });
    if (result.rolledBack.length > 0) {
      log.info(`migrate: rolled back ${result.rolledBack.length} migration(s): ${result.rolledBack.join(", ")}`);
    } else {
      log.info(`migrate: nothing to roll back${target ? ` newer than '${target}'` : ""}`);
    }
    return 0;
  } catch (err) {
    log.error(`migrate: rollback failed: ${(err as Error).message}`);
    return 1;
  } finally {
    try {
      await kysely.close();
    } catch (err) {
      log.warn(`migrate: failed to close DB cleanly: ${(err as Error).message}`);
    }
  }
}

async function runD1Migrate(
  config: ResolvedMigrateConfig,
  metaRoot: string,
  runner: WranglerRunner,
  fmt: OutputFormat = "text",
): Promise<number> {
  // 1. Resolve wrangler.toml + binding.
  const wranglerConfigPath = config.d1.wranglerConfigPath
    ? resolvePath(metaRoot, config.d1.wranglerConfigPath)
    : findWranglerConfig(metaRoot);

  if (wranglerConfigPath === undefined && config.d1.binding === undefined) {
    log.error(`migrate: no wrangler.toml found in ${metaRoot} or parents; pass --d1 <binding> to bypass`);
    return 2;
  }

  let binding: D1Binding;
  if (wranglerConfigPath !== undefined) {
    const parsed = parseWranglerConfig(wranglerConfigPath);
    try {
      binding = resolveD1Binding(parsed.d1Bindings, config.d1.binding);
    } catch (err) {
      log.error(`migrate: ${(err as Error).message}`);
      return 2;
    }
  } else {
    // No wrangler config but explicit binding — let wrangler discover the DB itself.
    binding = { binding: config.d1.binding!, database_name: "", database_id: "", migrations_dir: undefined };
  }

  // 2. Build a D1Runner closure over the wrangler runner.
  const d1Runner: D1Runner = async (sql) => {
    const args = buildWranglerExecuteArgs({
      binding: binding.binding,
      remote: config.d1.remote,
      command: sql,
      configPath: wranglerConfigPath,
    });
    const { stdout } = await runner(args, metaRoot);
    return stdout;
  };

  // 3. Load metadata. Best-effort config read for consumer providers; falls
  //    back to default core+forge bundle if metaobjects.config.ts is absent.
  let d1ConfigProviders: readonly import("@metaobjectsdev/codegen-ts").MetaDataTypeProvider[] | undefined;
  try {
    const forgeConfig = await loadMetaobjectsConfig(metaRoot);
    d1ConfigProviders = forgeConfig.providers;
  } catch {
    d1ConfigProviders = undefined;
  }

  // Discovery and load are separate failure modes (the `meta gen` pattern);
  // `resolveCollection`'s own ERR_COLLECTION_NOT_FOUND replaces the hand-rolled
  // ENOENT sniff, with the same exit 2.
  let collection;
  try {
    collection = await resolveCollection(metaRoot);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let metadata;
  try {
    metadata = await loadMemory(collection.configDir, {
      files: collection.files,
      ...(d1ConfigProviders !== undefined ? { providers: d1ConfigProviders } : {}),
    });
  } catch (err) {
    log.error(`migrate: failed to load metadata: ${(err as Error).message}`);
    return 2;
  }

  const d1ScopeMismatch = migrateScopeMismatch(collection, metadata);
  if (d1ScopeMismatch !== undefined) {
    log.error(`migrate: ${d1ScopeMismatch}`);
    emitStructuredError(`migrate: ${d1ScopeMismatch}`, "fix or remove migrate.scope in .metaobjects/config.json", fmt);
    return 2;
  }

  // 4. Build expected schema + introspect actual.
  let columnNamingStrategy: "snake_case" | "literal" | "kebab-case" = "snake_case";
  try {
    const cfg = await loadMetaobjectsConfig(metaRoot);
    if (cfg.columnNamingStrategy) columnNamingStrategy = cfg.columnNamingStrategy;
  } catch {
    // metaobjects.config.ts absent or invalid — use default snake_case
  }
  const expectedViews = buildProjectionViews(metadata, { dialect: "d1", columnNamingStrategy });
  // Per-command scope — both-sided, exactly as on the Kysely path above.
  const scoped = scopeExpectedSchema(
    buildExpectedSchemaWithProvenance(metadata, { dialect: "d1", columnNamingStrategy, views: expectedViews }),
    toObjectScope(collection.migrateScope),
  );
  const expected = scoped.snapshot;
  logOutOfScope(scoped.outOfScope);
  let actual;
  try {
    actual = await introspectD1({
      runner: d1Runner,
      binding: binding.binding,
      remote: config.d1.remote,
      configPath: wranglerConfigPath,
    });
  } catch (err) {
    log.error(`migrate: failed to introspect D1: ${(err as Error).message}`);
    return 2;
  }

  // 5. Diff.
  const collectedAmbiguous: AmbiguousChange[] = [];
  const onAmbiguousResolution = mapOnAmbiguous(config.onAmbiguous);
  let diffResult;
  try {
    diffResult = await diff({
      expected,
      actual,
      // D1 is SQLite at the SQL level — the dialect activates the sqlite diff
      // semantics (structural FK matching: SQLite stores no FK names; CHECK
      // evolution via recreate-and-copy). Omitting it left composite-FK /
      // @constraintName models churning and enum @values changes silent on D1.
      dialect: "d1",
      allow: tokensToAllowOptions(config.allow),
      // #258 — adopting a live D1 DB whose PRIMARY KEY differs from the metadata identity
      // has no expressible migration; refuse loudly instead of emitting SQL that drops
      // the constraint and breaks referencing FKs at apply (same failure as the online path).
      refusePrimaryKeyChange: true,
      // #208 §7 — declared-@unmanaged objects are external (see the online path above),
      // and so are objects outside `migrate.scope`.
      unmanagedNames: [...collectUnmanagedNames(metadata), ...scoped.outOfScope],
      // Schema scope pinned to the UNSCOPED model's schemas — same reasoning as the
      // online path above (migrate-ts's scope.ts header has the mechanism).
      ...(scoped.declaredSchemas !== undefined ? { scopeSchemas: scoped.declaredSchemas } : {}),
      onAmbiguous: async (a) => {
        collectedAmbiguous.push(a);
        return onAmbiguousResolution;
      },
    });
  } catch (err) {
    // #258 — a primary-key move has no expressible migration; refuse loudly.
    if (err instanceof PrimaryKeyChangeError) {
      log.error(`migrate: ${err.message}`);
      emitStructuredError(`migrate: ${err.message}`, "align the primary key manually, or reconcile the metadata identity to match the live table", fmt);
      return 1;
    }
    if ((err as Error).message.includes("aborted by onAmbiguous")) {
      const entries = ambiguousToEntries(collectedAmbiguous);
      for (const e of entries) {
        log.error(`  ambiguous ${e.kind}: ${e.description}${e.hint ? ` [${e.hint}]` : ""}`);
      }
      log.error(`migrate: aborted on ambiguous change (re-run with --on-ambiguous rename|drop-add)`);
      return 1;
    }
    throw err;
  }

  const changeCounts = summarizeChanges(diffResult.changes);

  // Views are emitted by the one schema-diff path: renderD1 = renderSqlite (which
  // renders view DDL) + the D1 safety pass (applied inside renderD1, stripping the
  // BEGIN/COMMIT + PRAGMA that recreate-and-copy emits). There is no separate
  // view-migration emitter; introspectD1 now reads view bodies so unchanged views
  // produce no change and body changes emit a DROP+CREATE.
  if (diffResult.changes.length === 0) {
    log.info(`migrate: no schema changes for d1 binding '${binding.binding}'`);
    return 0;
  }

  if (config.slug === undefined) {
    log.error(`migrate: --slug <name> required when there are changes`);
    return 2;
  }

  // 6. Emit (with D1 safety pass) + write Wrangler migration files.
  let emitResult;
  try {
    emitResult = renderD1(diffResult.changes, expected, actual.meta, actual);
  } catch (err) {
    if (err instanceof BlockedChangesError) {
      const entries = blockedToEntries(err);
      for (const e of entries) {
        log.error(`migrate: blocked '${e.kind}' on ${e.description} (allow with --allow ${e.allowFlag})`);
      }
      return 1;
    }
    throw err;
  }

  const combinedUp = emitResult.up;
  const combinedDown = emitResult.down;

  // Migration dir resolution: --out-dir > wrangler.toml's migrations_dir > "migrations".
  // The default outDir (./.metaobjects/migrations) is the Kysely-path default; for D1
  // we fall back to wrangler conventions when the caller hasn't overridden it.
  const isDefaultOutDir = config.outDir === MIGRATE_DEFAULT_OUT_DIR;
  const migrationsDir = resolvePath(
    metaRoot,
    isDefaultOutDir ? (binding.migrations_dir ?? "migrations") : config.outDir,
  );

  if (config.dryRun) {
    log.info(`-- UP --\n${combinedUp}\n\n-- DOWN --\n${combinedDown}`);
    return 0;
  }

  const writeResult = await writeMigrationD1(
    { up: combinedUp, down: combinedDown },
    { dir: migrationsDir, slug: config.slug },
  );
  log.info(`migrate: wrote ${writeResult.upPath}`);
  log.info(`migrate: wrote ${writeResult.downPath}`);
  for (const [kind, count] of Object.entries(changeCounts)) {
    log.info(`  ${kind}: ${count}`);
  }

  // 7. Optional --apply: run `wrangler d1 migrations apply`.
  if (config.d1.autoApply) {
    return await runWranglerApply(
      binding.binding,
      binding.database_name,
      config.d1.remote,
      wranglerConfigPath,
      config.yes,
    );
  }

  return 0;
}

async function runWranglerApply(
  bindingName: string,
  databaseName: string,
  remote: boolean,
  wranglerConfigPath: string | undefined,
  yes: boolean,
): Promise<number> {
  if (remote && !yes) {
    log.info(
      `Applying to remote D1 '${databaseName}' (binding=${bindingName}) in 2s — Ctrl+C to abort or pass --yes to skip this pause.`,
    );
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  const applyArgs = ["d1", "migrations", "apply", bindingName, remote ? "--remote" : "--local"];
  if (wranglerConfigPath !== undefined) applyArgs.push("--config", wranglerConfigPath);

  return await new Promise<number>((resolve) => {
    const child = spawn("wrangler", applyArgs, { stdio: "inherit" });
    child.on("error", (err) => {
      log.error(`migrate: failed to run wrangler: ${(err as Error).message}`);
      resolve(2);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
