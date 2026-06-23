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
import { buildKyselyFromUrl } from "../lib/kysely.js";
import { log } from "../lib/log.js";
import { loadMemory } from "@metaobjectsdev/sdk";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import {
  buildExpectedSchema,
  introspect,
  diff,
  emit,
  writeMigration,
  baselineFromMetadata,
  planOffline,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
  BlockedChangesError,
  renderD1,
  writeMigrationD1,
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
  meta migrate [baseline] [flags]

SUBCOMMANDS:
  baseline             Seed the committed reference snapshot (no migration emitted).
                       Required before the first offline generate.

MIGRATE FLAGS:
  --db <url>           DB connection URL (required for live-introspect / --apply / --rollback)
                       Supports: file:, libsql:, postgres:, postgresql:
  --dialect sqlite|postgres|d1
                       Optional dialect override (auto-detected from URL scheme)
  --out-dir <path>     Migration directory (default: ./.metaobjects/migrations)
  --slug <name>        Required when changes are present (e.g., --slug add-user-shipping)
  --allow <csv>        Comma-separated destructive-change permissions:
                       drop-column,drop-table,type-change,drop-index,drop-fk,nullable-to-not-null
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
  meta migrate baseline --dialect sqlite
  meta migrate --dialect sqlite --slug add-users
  meta migrate --db file:local.db --slug add-orders
  meta migrate --db postgresql://localhost/mydb --slug add-index --apply
`;

/** Emit a structured error on stdout (not stderr) in the active format, per axi. */
function emitStructuredError(error: string, hint: string, fmt: OutputFormat): void {
  const payload = { error, hint };
  if (fmt === "json") {
    log.info(JSON.stringify(payload, null, 2));
  } else if (fmt === "toon") {
    log.info(toonEncode(payload));
  }
  // text format: errors go to stderr via log.error() — the caller handles that path
}

function mapOnAmbiguous(v: "abort" | "rename" | "drop-add"): AmbiguousResolution {
  return v === "drop-add" ? "drop+add" : v;
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

  if (config.dialect === "d1") {
    if (config.baseline) {
      log.error(`migrate baseline is not supported for dialect 'd1' (snapshots are a postgres/sqlite concept)`);
      return 2;
    }
    if (config.databaseUrl !== undefined) {
      log.error(`migrate: --db / DATABASE_URL is not used for dialect 'd1' — wrangler.toml owns connection`);
      return 2;
    }
    if (config.rollback !== undefined) {
      log.error(`migrate: --rollback is not supported for dialect 'd1' (use 'wrangler d1 migrations' tooling)`);
      return 2;
    }
    return await runD1Migrate(config, metaRoot, wranglerRunner ?? defaultWranglerRunner);
  }

  // `migrate baseline` — seed the committed reference snapshot, emit no migration.
  if (config.baseline) {
    return await runBaseline(config, metaRoot);
  }

  // Default = offline snapshot generation. The live-introspection path runs only
  // when explicitly requested via --from-db, when --apply needs a connection, or
  // for --rollback (which runs hand-authored down.sql against the live DB).
  if (!config.fromDb && !config.apply && config.rollback === undefined) {
    return await runOfflineGenerate(config, metaRoot);
  }

  if (config.databaseUrl === undefined) {
    log.error(`migrate: --db <url> required (or set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json)`);
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

  let metadata;
  try {
    metadata = await loadMemory(metaRoot, {
      ...(postgresConfigProviders !== undefined ? { providers: postgresConfigProviders } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ENOENT") || msg.includes("no such") || msg.includes("cannot read")) {
      log.error(`no metaobjects/ found in ${metaRoot}; run 'meta init' to scaffold`);
    } else {
      log.error(`failed to load metadata: ${msg}`);
    }
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
    const expected = buildExpectedSchema(metadata, {
      dialect: kysely.dialect,
      columnNamingStrategy,
      views: expectedViews,
    });
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
        onAmbiguous: async (a) => {
          collectedAmbiguous.push(a);
          return onAmbiguousResolution;
        },
      });
    } catch (err) {
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
          const outDir = resolvePath(metaRoot, config.outDir);
          await mkdir(outDir, { recursive: true });
          const res = await writeMigration(
            { up: emitted.up, down: emitted.down },
            { dir: outDir, slug: config.slug },
          );
          writtenPaths = [res.upPath, res.downPath];
          if (config.fromDb) {
            log.info(`migrate: --from-db did not advance the committed snapshot; run 'meta migrate baseline --from-db' to re-sync`);
          }
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
}

/**
 * `meta migrate baseline [--from-db]` — seed the committed reference snapshot.
 * `--from-metadata` (default) derives it from metadata; `--from-db` introspects
 * an existing database once. Emits no migration.
 */
export async function runBaseline(
  config: ResolvedMigrateConfig,
  metaRoot: string,
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
    let metadata;
    try {
      metadata = await loadMemory(metaRoot);
    } catch (err) {
      log.error(`migrate baseline: failed to load metadata: ${(err as Error).message}`);
      return 2;
    }
    let baselineStrategy: "snake_case" | "literal" | "kebab-case" = "snake_case";
    try {
      const cfg = await loadMetaobjectsConfig(metaRoot);
      if (cfg.columnNamingStrategy) baselineStrategy = cfg.columnNamingStrategy;
    } catch {
      // config absent — default snake_case
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
): Promise<number> {
  if (config.dialect === undefined) {
    log.error(`migrate: --dialect required for offline generation (or use --from-db)`);
    return 2;
  }
  let metadata;
  try {
    metadata = await loadMemory(metaRoot);
  } catch (err) {
    log.error(`migrate: failed to load metadata: ${(err as Error).message}`);
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
    log.error(`migrate: no schema snapshot at ${path}`);
    // Structured next-step on stdout so callers / agents can parse it.
    log.info(
      JSON.stringify({
        error: "no schema snapshot",
        "help[]": `first run \`meta migrate baseline --dialect ${config.dialect}\``,
      }),
    );
    return 2;
  }

  const collectedAmbiguous: AmbiguousChange[] = [];
  const onAmbiguousResolution = mapOnAmbiguous(config.onAmbiguous);

  let offlineStrategy: "snake_case" | "literal" | "kebab-case" = "snake_case";
  try {
    const cfg = await loadMetaobjectsConfig(metaRoot);
    if (cfg.columnNamingStrategy) offlineStrategy = cfg.columnNamingStrategy;
  } catch {
    // config absent — default snake_case
  }
  const offlineViews = buildProjectionViews(metadata, { dialect: config.dialect, columnNamingStrategy: offlineStrategy });

  let plan;
  try {
    plan = await planOffline({
      metadata,
      dialect: config.dialect,
      snapshot,
      columnNamingStrategy: offlineStrategy,
      views: offlineViews,
      allow: tokensToAllowOptions(config.allow),
      onAmbiguous: async (a) => {
        collectedAmbiguous.push(a);
        return onAmbiguousResolution;
      },
    });
  } catch (err) {
    if ((err as Error).message.includes("aborted by onAmbiguous")) {
      log.error(`migrate: ambiguous rename/drop detected; re-run with --on-ambiguous rename|drop-add`);
      return 1;
    }
    throw err;
  }

  const { diff: diffResult, nextSnapshot } = plan;

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
    ...(snapshot.meta ? { actualMeta: snapshot.meta } : {}),
  });

  if (config.dryRun) {
    log.info(`-- UP --\n${emitResult.up}\n\n-- DOWN --\n${emitResult.down}`);
    return 0;
  }

  await mkdir(outDir, { recursive: true });
  const res = await writeMigration(
    { up: emitResult.up, down: emitResult.down },
    { dir: outDir, slug: config.slug },
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

  let metadata;
  try {
    metadata = await loadMemory(metaRoot, {
      ...(d1ConfigProviders !== undefined ? { providers: d1ConfigProviders } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ENOENT") || msg.includes("no such") || msg.includes("cannot read")) {
      log.error(`no metaobjects/ found in ${metaRoot}; run 'meta init' to scaffold`);
    } else {
      log.error(`migrate: failed to load metadata: ${msg}`);
    }
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
  const expected = buildExpectedSchema(metadata, { dialect: "d1", columnNamingStrategy, views: expectedViews });
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
      allow: tokensToAllowOptions(config.allow),
      onAmbiguous: async (a) => {
        collectedAmbiguous.push(a);
        return onAmbiguousResolution;
      },
    });
  } catch (err) {
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
    emitResult = renderD1(diffResult.changes, expected, actual.meta);
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
