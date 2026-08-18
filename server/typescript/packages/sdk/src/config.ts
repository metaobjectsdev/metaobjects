import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceSpec } from "./sources.js";

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
  /** Restricts a `meta migrate` run to a subset of the loaded metadata, by the
   *  same package-glob pattern grammar as top-level `scope` (see `scope.ts`).
   *  Include-only — there's no `migrate.scope.exclude`, since a migration run
   *  is scoped to what it's touching, not filtered down from "everything". */
  scope: z.array(z.string().min(1)),
}).partial();

/**
 * Mirrors the hand-written `SourceSpec` union in `./sources.ts` — a
 * declared source kind, one of `path` (resolves today), `resource`, or
 * `package` (both reserved, throw `ERR_SOURCE_KIND_UNSUPPORTED` until a
 * later phase). `.strict()` on every arm: this project is fail-closed on
 * undeclared keys everywhere else (ADR-0023 makes an unregistered metadata
 * attribute a hard error for the same reason) — a config schema that
 * silently strips an unknown key would let `{ path: "model", pathh: "typo"
 * }` parse clean and resolve one source instead of erroring on the typo.
 * The pre-phase-1 `{ kind: "path", path: "..." }` shape (the dead 2-arm
 * discriminated union this replaces) never shipped to an adopter — `meta
 * init` has only ever scaffolded `"sources": []`, and nothing under `src/`
 * ever read the old shape — so there is no live config to be lenient for;
 * it only ever existed in this package's own tests, updated alongside this
 * schema.
 */
const SourceSpecSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ resource: z.string().min(1) }).strict(),
  z.object({ package: z.string().min(1) }).strict(),
]);

// Compile-time parity: if SourceSpecSchema and the hand-written SourceSpec
// (./sources.ts) ever drift, this assignment stops compiling. A conditional
// type (`z.infer<...> extends SourceSpec ? true : never`) would silently
// resolve to `never` instead of erroring — this form fails for real.
const _sourceSpecParity: SourceSpec = {} as z.infer<typeof SourceSpecSchema>;
void _sourceSpecParity;

/** Mirrors the hand-written `Scope` interface in `./scope.ts`. An absent or
 *  empty `include` means "everything" — see `matchesScope`. */
const ScopeSchema = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ConfigSchema = z.object({
  schema_version: z.literal(1),
  pending_in_git: z.boolean().default(true),
  confidence_thresholds: z
    .object({
      pending_promote: z.number().min(0).max(1).default(0.8),
      drift_warn: z.number().min(0).max(1).default(0.7),
    })
    .default({}),
  sources: z.array(SourceSpecSchema).default([]),
  /** Output filter applied across every command — see `./scope.ts`. Absent
   *  means "everything" (no filtering), matching `Scope`'s own contract. */
  scope: ScopeSchema.optional(),
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
