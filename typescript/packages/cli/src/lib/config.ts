import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigSchema, type Config, DEFAULT_METAOBJECTS_DIR } from "@metaobjects/sdk";
import type { GenFlags, MigrateFlags } from "./args.js";

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

const MIGRATE_DEFAULTS = {
  outDir: "./.metaobjects/migrations",
  databaseUrl: undefined as string | undefined,
  dialect: undefined as "sqlite" | "postgres" | undefined,
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

export interface ResolvedMigrateConfig {
  outDir: string;
  databaseUrl: string | undefined;
  dialect: "sqlite" | "postgres" | undefined;
  onAmbiguous: "abort" | "rename" | "drop-add";
  allow: string[];
  slug: string | undefined;
  dryRun: boolean;
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

export async function resolveMigrateConfig(
  flags: MigrateFlags,
  metaRoot: string,
): Promise<ResolvedMigrateConfig> {
  const config = await tryLoadConfig(metaRoot);
  const cfgBlock = config?.migrate ?? {};

  const envUrl = process.env.DATABASE_URL;

  return {
    outDir: flags.outDir ?? cfgBlock.outDir ?? MIGRATE_DEFAULTS.outDir,
    databaseUrl: flags.db ?? envUrl ?? cfgBlock.databaseUrl ?? MIGRATE_DEFAULTS.databaseUrl,
    dialect: flags.dialect ?? cfgBlock.dialect ?? MIGRATE_DEFAULTS.dialect,
    onAmbiguous: flags.onAmbiguous ?? cfgBlock.onAmbiguous ?? MIGRATE_DEFAULTS.onAmbiguous,
    allow: flags.allow.length > 0
      ? flags.allow
      : (cfgBlock.allow ?? MIGRATE_DEFAULTS.allow),
    slug: flags.slug,
    dryRun: flags.dryRun,
  };
}
