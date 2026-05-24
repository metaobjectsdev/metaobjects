import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseMigrateArgs } from "../lib/args.js";
import { resolveMigrateConfig } from "../lib/config.js";
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
  type AllowOptions,
  type AmbiguousChange,
  type AmbiguousResolution,
  type Change,
  type EmitResult,
} from "@metaobjectsdev/migrate-ts";
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

export async function migrateCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseMigrateArgs(args);
  } catch (err) {
    log.error(`migrate: ${(err as Error).message}`);
    return 2;
  }

  const metaRoot = cwd;
  const config = await resolveMigrateConfig(flags, metaRoot);

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
          const outDir = resolve(metaRoot, config.outDir);
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
