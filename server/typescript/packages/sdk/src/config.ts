import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DialectEnum = z.enum(["sqlite", "postgres", "d1"]);

const OnAmbiguousEnum = z.enum(["abort", "rename", "drop-add"]);

/**
 * Kept in lockstep with the CLI's authoritative `ALLOW_TOKENS`
 * (`cli/src/lib/args.ts`) by hand — `sdk` has no dependency on `cli` (the
 * dependency runs the other way: `cli` depends on `sdk`), so this list
 * cannot import that one. `cli`'s `allow-tokens-pinned.test.ts` is the
 * drift guard: it imports BOTH `ALLOW_TOKENS` and this enum's `.options`
 * and asserts they're the same set, so an out-of-sync edit here fails that
 * test rather than silently rejecting a token the CLI itself accepts (as
 * happened before `drop-check`/`drop-view`/`drop-view-cascade`/
 * `adopt-view`/`drop-identity-default` were added to `cli` without a
 * matching update here).
 */
export const AllowTokenEnum = z.enum([
  "drop-column",
  "drop-table",
  "type-change",
  "drop-index",
  "drop-fk",
  "drop-check",
  "drop-view",
  "drop-view-cascade",
  "adopt-view",
  "nullable-to-not-null",
  "drop-identity-default",
]);

const D1Block = z.object({
  binding: z.string(),
  remote: z.boolean(),
  autoApply: z.boolean(),
  wranglerConfigPath: z.string(),
}).partial();

/** #192 — migration output-format adapters; orthogonal to dialect. */
const MigrateFormatEnum = z.enum(["default", "flyway"]);

const MigrateBlock = z.object({
  outDir: z.string(),
  databaseUrl: z.string(),
  dialect: DialectEnum,
  format: MigrateFormatEnum,
  onAmbiguous: OnAmbiguousEnum,
  allow: z.array(AllowTokenEnum),
  d1: D1Block,
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
