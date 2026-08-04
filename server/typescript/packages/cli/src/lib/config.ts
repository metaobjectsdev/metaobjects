import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigSchema, type Config, DEFAULT_METAOBJECTS_DIR } from "@metaobjectsdev/sdk";
import type { GenFlags, MigrateFlags, MigrateFormat } from "./args.js";
import type { Dialect } from "./kysely.js";

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

export const MIGRATE_DEFAULT_OUT_DIR = "./.metaobjects/migrations";

const MIGRATE_DEFAULTS = {
  outDir: MIGRATE_DEFAULT_OUT_DIR,
  databaseUrl: undefined as string | undefined,
  dialect: undefined as Dialect | undefined,
  format: "default" as MigrateFormat,
  onAmbiguous: "abort" as const,
  allow: [] as string[],
};

// ---------------------------------------------------------------------------
// Resolved option shapes
// ---------------------------------------------------------------------------

export interface ResolvedGenConfig {
  dryRun: boolean;
  entities: string[];
}

export interface ResolvedD1Config {
  binding: string | undefined;
  remote: boolean;
  autoApply: boolean;
  wranglerConfigPath: string | undefined;
}

export interface ResolvedMigrateConfig {
  outDir: string;
  databaseUrl: string | undefined;
  dialect: Dialect | undefined;
  /** Output-format adapter (#192): "default" homegrown layout, or "flyway" V__/U__. */
  format: MigrateFormat;
  onAmbiguous: "abort" | "rename" | "drop-add";
  allow: string[];
  slug: string | undefined;
  dryRun: boolean;
  /** Run pending migration files against the DB (postgres/sqlite, ledger-backed). */
  apply: boolean;
  /**
   * Roll back all applied migrations newer than this target (target retained),
   * postgres/sqlite only. Mutually exclusive with apply.
   */
  rollback: string | undefined;
  yes: boolean;
  /** Use live-DB introspection instead of the committed snapshot. */
  fromDb: boolean;
  /** Seed the snapshot and exit (no migration). */
  baseline: boolean;
  /** Replay committed migration files, no diff. */
  applyPending: boolean;
  d1: ResolvedD1Config;
}

// ---------------------------------------------------------------------------
// Config loader (silent if file missing)
// ---------------------------------------------------------------------------

async function tryLoadConfig(metaRoot: string): Promise<Config | undefined> {
  try {
    const raw = await readFile(join(metaRoot, DEFAULT_METAOBJECTS_DIR, "config.json"), "utf8");
    return ConfigSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------

export function resolveGenConfig(flags: GenFlags): ResolvedGenConfig {
  return { dryRun: flags.dryRun, entities: flags.entities };
}

/**
 * Resolve the D1 connection config (binding / remote / wranglerConfigPath) from
 * CLI flags + `.metaobjects/config.json`'s `migrate.d1` block, flags-win-except-
 * remote-is-OR'd — the same precedence `resolveMigrateConfig` applies inline
 * for `meta migrate --dialect d1`. Factored out (#225) so `meta verify --d1`
 * honors the identical local-vs-remote notion without a second, divergent
 * implementation of the same defaulting rule.
 */
export async function resolveD1Config(
  flags: { d1Binding: string | undefined; remote: boolean; apply?: boolean },
  metaRoot: string,
): Promise<ResolvedD1Config> {
  const config = await tryLoadConfig(metaRoot);
  const d1Block = config?.migrate?.d1 ?? {};
  return {
    binding: flags.d1Binding ?? d1Block.binding,
    remote: flags.remote || (d1Block.remote ?? false),
    autoApply: (flags.apply ?? false) || (d1Block.autoApply ?? false),
    wranglerConfigPath: d1Block.wranglerConfigPath,
  };
}

export async function resolveMigrateConfig(
  flags: MigrateFlags,
  metaRoot: string,
): Promise<ResolvedMigrateConfig> {
  const config = await tryLoadConfig(metaRoot);
  const cfgBlock = config?.migrate ?? {};
  const d1Block = cfgBlock.d1 ?? {};

  const envUrl = process.env.DATABASE_URL;

  return {
    outDir: flags.outDir ?? cfgBlock.outDir ?? MIGRATE_DEFAULTS.outDir,
    databaseUrl: flags.db ?? envUrl ?? cfgBlock.databaseUrl ?? MIGRATE_DEFAULTS.databaseUrl,
    dialect: flags.dialect ?? cfgBlock.dialect ?? MIGRATE_DEFAULTS.dialect,
    format: flags.format ?? cfgBlock.format ?? MIGRATE_DEFAULTS.format,
    onAmbiguous: flags.onAmbiguous ?? cfgBlock.onAmbiguous ?? MIGRATE_DEFAULTS.onAmbiguous,
    allow: flags.allow.length > 0
      ? flags.allow
      : (cfgBlock.allow ?? MIGRATE_DEFAULTS.allow),
    slug: flags.slug,
    dryRun: flags.dryRun,
    apply: flags.apply,
    rollback: flags.rollback,
    yes: flags.yes,
    fromDb: flags.fromDb,
    baseline: flags.baseline,
    applyPending: flags.applyPending,
    d1: {
      binding: flags.d1Binding ?? d1Block.binding,
      remote: flags.remote || (d1Block.remote ?? false),
      autoApply: flags.apply || (d1Block.autoApply ?? false),
      wranglerConfigPath: d1Block.wranglerConfigPath,
    },
  };
}
