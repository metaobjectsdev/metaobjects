import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DialectEnum = z.enum(["sqlite", "postgres", "d1"]);

const OnAmbiguousEnum = z.enum(["abort", "rename", "drop-add"]);

const AllowTokenEnum = z.enum([
  "drop-column",
  "drop-table",
  "type-change",
  "drop-index",
  "drop-fk",
  "nullable-to-not-null",
]);

const MigrateBlock = z.object({
  outDir: z.string(),
  databaseUrl: z.string(),
  dialect: DialectEnum,
  onAmbiguous: OnAmbiguousEnum,
  allow: z.array(AllowTokenEnum),
}).partial();

export const ConfigSchema = z.object({
  schema_version: z.literal(1),
  pending_in_git: z.boolean().default(true),
  confidence_thresholds: z
    .object({
      pending_promote: z.number().min(0).max(1).default(0.8),
      drift_warn: z.number().min(0).max(1).default(0.7),
    })
    .default({}),
  sources: z
    .array(
      z.union([
        z.object({ kind: z.literal("path"), path: z.string() }),
        z.object({ kind: z.literal("package"), package: z.string() }),
      ]),
    )
    .default([]),
  extract: z
    .object({
      metaignore: z.string().optional(),
    })
    .default({}),
  migrate: MigrateBlock.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({ schema_version: 1 });

const CONFIG_FILE = "config.json";

export async function loadConfig(metaRoot: string): Promise<Config> {
  const raw = await readFile(join(metaRoot, CONFIG_FILE), "utf8");
  return ConfigSchema.parse(JSON.parse(raw));
}

export async function saveConfig(metaRoot: string, config: Config): Promise<void> {
  ConfigSchema.parse(config); // validate before writing
  await writeFile(
    join(metaRoot, CONFIG_FILE),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}
