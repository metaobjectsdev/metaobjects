import { resolve as resolvePath } from "node:path";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseMigrateArgs } from "../lib/args.js";
import { resolveMigrateConfig, MIGRATE_DEFAULT_OUT_DIR } from "../lib/config.js";
import type { ResolvedMigrateConfig } from "../lib/config.js";
import { formatMigrateResult, type BlockedEntry, type AmbiguousEntry } from "../lib/output.js";
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
  BlockedChangesError,
  renderD1,
  writeMigrationD1,
  introspectD1,
  findWranglerConfig,
  parseWranglerConfig,
  resolveD1Binding,
  type AllowOptions,
  type AmbiguousChange,
  type AmbiguousResolution,
  type Change,
  type EmitResult,
  type D1Runner,
} from "@metaobjectsdev/migrate-ts";
import {
  buildWranglerExecuteArgs,
  defaultWranglerRunner,
  type WranglerRunner,
} from "../lib/wrangler.js";
import {
  computeProjectionMigrations,
  computeProjectionViewDependencies,
} from "../lib/projection-migrations.js";

// Map CLI allow tokens → migrate-ts AllowOptions field names
const ALLOW_TOKEN_MAP: Record<string, keyof AllowOptions> = {
  "drop-column": "dropColumn",
  "drop-table": "dropTable",
  "type-change": "typeChange",
  "drop-index": "dropIndex",
  "drop-fk": "dropFk",
  "nullable-to-not-null": "nullableToNotNull",
};

function mapOnAmbiguous(v: "abort" | "rename" | "drop-add"): AmbiguousResolution {
  return v === "drop-add" ? "drop+add" : v;
}

function tokensToAllowOptions(tokens: string[]): AllowOptions {
  const opts: AllowOptions = {};
  for (const tok of tokens) {
    const field = ALLOW_TOKEN_MAP[tok];
    if (field !== undefined) {
      opts[field] = true;
    }
  }
  return opts;
}

function summarizeChanges(changes: Change[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of changes) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  return counts;
}

function describeChangeForOutput(c: Change): string {
  switch (c.kind) {
    case "create-table": return c.table.name;
    case "drop-table": return c.table;
    case "rename-table": return `${c.from} → ${c.to}`;
    case "add-column": return `${c.table}.${c.column.name}`;
    case "drop-column": return `${c.table}.${c.column}`;
    case "rename-column": return `${c.table}.${c.from} → ${c.table}.${c.to}`;
    case "change-column-type": return `${c.table}.${c.column} (${c.from.kind} → ${c.to.kind})`;
    case "change-column-nullable": return `${c.table}.${c.column} (${c.from ? "NULL" : "NOT NULL"} → ${c.to ? "NULL" : "NOT NULL"})`;
    case "change-column-default": return `${c.table}.${c.column}`;
    case "add-index": return `${c.table} idx ${c.index.name}`;
    case "drop-index": return `${c.table} idx ${c.index}`;
    case "add-fk": return `${c.table} fk ${c.fk.name}`;
    case "drop-fk": return `${c.table} fk ${c.fk}`;
    default: return JSON.stringify(c);
  }
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
    description: describeChangeForOutput(c),
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
): Promise<number> {
  let flags;
  try {
    flags = parseMigrateArgs(args);
  } catch (err) {
    log.error(`migrate: ${(err as Error).message}`);
    return 2;
  }

  const metaRoot = cwd;
  const config = await resolveMigrateConfig(flags, metaRoot);

  if (config.dialect === "d1") {
    if (config.databaseUrl !== undefined) {
      log.error(`migrate: --db / DATABASE_URL is not used for dialect 'd1' — wrangler.toml owns connection`);
      return 2;
    }
    return await runD1Migrate(config, metaRoot, wranglerRunner ?? defaultWranglerRunner);
  }

  if (config.databaseUrl === undefined) {
    log.error(`migrate: --db <url> required (or set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json)`);
    return 2;
  }

  let metadata;
  try {
    metadata = await loadMemory(metaRoot);
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
  let blocked: BlockedEntry[] = [];
  let ambiguous: AmbiguousEntry[] = [];
  let changeCounts: Record<string, number> = {};

  try {
    const expected = buildExpectedSchema(metadata, { dialect: kysely.dialect });
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
        const output = formatMigrateResult({
          dialect: kysely.dialect,
          displayUrl: kysely.displayUrl,
          changeCounts: {},
          blocked: [],
          ambiguous,
          writtenPaths: [],
          dryRun: config.dryRun,
        }, { isTTY: !!process.stdout.isTTY });
        log.info(output);
        await kysely.close();
        return 1;
      }
      throw err;
    }

    changeCounts = summarizeChanges(diffResult.changes);

    // Load metaobjects config to pick up columnNamingStrategy for view DDL emit.
    // If metaobjects.config.ts is absent (e.g. in projects that don't use codegen),
    // fall back to snake_case so migrate still works without it.
    let columnNamingStrategy: "snake_case" | "literal" | "kebab-case" = "snake_case";
    try {
      const forgeConfig = await loadMetaobjectsConfig(metaRoot);
      if (forgeConfig.columnNamingStrategy) {
        columnNamingStrategy = forgeConfig.columnNamingStrategy;
      }
    } catch {
      // metaobjects.config.ts absent or invalid — use default snake_case
    }

    // Pull existing view CREATE SQL from the DB so unchanged views can be
    // skipped (no DROP+CREATE noise when the body hasn't changed).
    const existingViewSql = await readExistingViewSql(kysely.db, kysely.dialect);

    // Compute view migrations (projections) independently of table changes.
    const viewResult = computeProjectionMigrations({
      metadata,
      dialect: kysely.dialect,
      allowBreaking: false,
      columnNamingStrategy,
      existingViewSql,
    });
    if (viewResult.errors.length > 0) {
      for (const err of viewResult.errors) log.error(err);
      await kysely.close();
      return 1;
    }
    const viewUpSql = viewResult.migrations.join("\n\n");

    const hasTableChanges = diffResult.changes.length > 0;
    const hasViewChanges = viewResult.migrations.length > 0;

    if (!hasTableChanges && !hasViewChanges) {
      // no-op — output will say "No schema changes"
    } else {
      // Emit table SQL (may be empty if only views changed).
      let tableSql: EmitResult | undefined;
      if (hasTableChanges) {
        try {
          tableSql = emit(diffResult.changes, {
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
      }

      // Combine table + view SQL into a single migration if no errors.
      if (exitCode === 0) {
        // Extract view names from the CREATE VIEW statements (used by both the
        // pre-drop and down-migration paths below).
        const viewNames = viewResult.migrations
          .map((s) => {
            const m = /CREATE(?:\s+OR\s+REPLACE)?\s+VIEW\s+(\S+)/i.exec(s);
            return m ? m[1] : undefined;
          })
          .filter((n): n is string => Boolean(n));

        // Pre-drop dependent views, BUT only the ones whose source tables are
        // being recreated. SQLite's ALTER TABLE ... RENAME re-parses dependent
        // view definitions and errors if any of them reference a source table
        // that's mid-recreate (the recreate-and-copy pattern temporarily drops
        // the source table and creates __new_<table>, then RENAMEs). The
        // viewUpSql block below recreates the dropped views fresh.
        const recreatedTables = tableSql?.recreatedTables ?? new Set<string>();
        const viewPreDropSql = recreatedTables.size > 0 && viewNames.length > 0
          ? (() => {
              const deps = computeProjectionViewDependencies({
                metadata,
                columnNamingStrategy,
              });
              const affected = viewNames.filter((n) => {
                const sources = deps.get(n);
                if (!sources) return false;
                for (const t of sources) if (recreatedTables.has(t)) return true;
                return false;
              });
              return affected.length > 0
                ? affected.map((n) => `DROP VIEW IF EXISTS ${n};`).join("\n")
                : "";
            })()
          : "";

        const upParts = [viewPreDropSql, tableSql?.up, viewUpSql].filter(Boolean);
        const combinedUp = upParts.join("\n\n");
        // Down SQL: DROP VIEW statements for any views we created.
        const viewDownSql = viewNames
          .map((n) => `DROP VIEW IF EXISTS ${n};`)
          .join("\n");
        const downParts = [viewDownSql, tableSql?.down].filter(Boolean);
        const combinedDown = downParts.join("\n\n");

        if (config.slug === undefined) {
          log.error(`migrate: --slug <name> required when there are changes (e.g., --slug add-user-shipping)`);
          await kysely.close();
          return 2;
        }

        if (config.dryRun) {
          log.info(`-- UP --\n${combinedUp}\n\n-- DOWN --\n${combinedDown}`);
        } else {
          const outDir = resolvePath(metaRoot, config.outDir);
          await mkdir(outDir, { recursive: true });
          const res = await writeMigration(
            { up: combinedUp, down: combinedDown },
            { dir: outDir, slug: config.slug },
          );
          writtenPaths = [res.upPath, res.downPath];
        }
      }
    }
  } finally {
    try {
      await kysely.close();
    } catch (err) {
      log.warn(`migrate: failed to close DB cleanly: ${(err as Error).message}`);
    }
  }

  const output = formatMigrateResult({
    dialect: kysely.dialect,
    displayUrl: kysely.displayUrl,
    changeCounts,
    blocked,
    ambiguous,
    writtenPaths,
    dryRun: config.dryRun,
  }, { isTTY: !!process.stdout.isTTY });

  log.info(output);
  return exitCode;
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

  let binding: { binding: string; database_name: string; database_id: string; migrations_dir: string | undefined };
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

  // 3. Load metadata.
  let metadata;
  try {
    metadata = await loadMemory(metaRoot);
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
  const expected = buildExpectedSchema(metadata, { dialect: "d1" });
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

  // Migration dir resolution: --out-dir > wrangler.toml's migrations_dir > "migrations".
  // The default outDir (./.metaobjects/migrations) is the Kysely-path default; for D1
  // we fall back to wrangler conventions when the caller hasn't overridden it.
  const isDefaultOutDir = config.outDir === MIGRATE_DEFAULT_OUT_DIR;
  const migrationsDir = resolvePath(
    metaRoot,
    isDefaultOutDir ? (binding.migrations_dir ?? "migrations") : config.outDir,
  );

  if (config.dryRun) {
    log.info(`-- UP --\n${emitResult.up}\n\n-- DOWN --\n${emitResult.down}`);
    return 0;
  }

  const writeResult = await writeMigrationD1(emitResult, { dir: migrationsDir, slug: config.slug });
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

/**
 * Read existing view CREATE SQL from the DB. Returns an empty map on any
 * introspection failure — the worst case is over-eager DROP+CREATE
 * (the original behaviour), not data loss.
 */
async function readExistingViewSql(
  // biome-ignore lint/suspicious/noExplicitAny: kysely raw query, dialect-dispatched
  db: any,
  dialectIn: "sqlite" | "postgres" | "d1",
): Promise<ReadonlyMap<string, string>> {
  // D1 is SQLite at the SQL level; route to the sqlite branch.
  const dialect: "sqlite" | "postgres" = dialectIn === "d1" ? "sqlite" : dialectIn;
  const result = new Map<string, string>();
  try {
    if (dialect === "sqlite") {
      const { sql } = await import("kysely");
      const rows = await sql<{ name: string; sql: string }>`
        SELECT name, sql FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%'
      `.execute(db);
      for (const r of rows.rows) {
        if (r.name && r.sql) result.set(r.name, r.sql);
      }
    } else {
      const { sql } = await import("kysely");
      const rows = await sql<{ name: string; def: string }>`
        SELECT viewname AS name, definition AS def
        FROM pg_views
        WHERE schemaname = 'public'
      `.execute(db);
      for (const r of rows.rows) {
        // Postgres pg_views.definition returns only the SELECT body, not the
        // full "CREATE VIEW ... AS ...". Synthesize so comparison is apples-
        // to-apples with what emitViewDdl produces.
        if (r.name && r.def) result.set(r.name, `CREATE VIEW ${r.name} AS ${r.def}`);
      }
    }
  } catch {
    // ignore — empty map means over-eager recreate, same as before this fix
  }
  return result;
}
