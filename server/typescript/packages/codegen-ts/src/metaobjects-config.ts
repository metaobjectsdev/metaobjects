import { DEFAULT_COLUMN_NAMING_STRATEGY, type ColumnNamingStrategy, type MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import type { Generator } from "./generator.js";
import type { ExtStyle } from "./render-context.js";
import type { OutputLayout, ResolvedTarget } from "./import-path.js";
import { generatorRegistry } from "./generator-registry.js";

/**
 * A config `generators` entry. Either a typed generator (the primary, fully
 * typed form — `entityFile()`) OR a STABLE-NAME STRING resolved via the
 * {@link generatorRegistry} (e.g. `"entity"`). The string form is the
 * cross-port-consistent selection mechanism (matches C#/Python
 * `--generators entity,routes`); it always uses the generator's DEFAULT
 * options. Adopters needing options use the factory form.
 *
 * ADR-0021 #1 (TS parity).
 */
export type GeneratorSpec = Generator | string;

export type Dialect = "sqlite" | "postgres";
/** Re-exported from metadata so codegen-ts consumers see one canonical type. */
export type { ColumnNamingStrategy, MetaDataTypeProvider } from "@metaobjectsdev/metadata";
export type { ExtStyle };
export type { OutputLayout };
export type { ResolvedTarget };

/** The implicit target synthesized from top-level config (outDir/outputLayout/dbImport). */
export const DEFAULT_TARGET_NAME = "default";

/** User-facing per-target output config. */
export interface TargetConfig {
  outDir: string;
  importBase?: string;
  outputLayout?: OutputLayout;
  dbImport?: string;
  /**
   * Whether this target emits server runtime bindings. Defaults to `true` (a full
   * server package: Drizzle tables/views + the DB layer). Set `false` for a
   * contract-only target — Zod schemas + inferred TS types only, no `drizzle-orm`
   * / `runtime-ts` import — e.g. a shared wire-contract package consumed by a web
   * client with no database. See {@link ResolvedTarget.runtime}.
   */
  runtime?: boolean;
}

/** Subset of MetaobjectsGenConfig surfaced to generators via GenContext. */
export interface ResolvedGenConfig {
  outDir: string;
  extStyle: ExtStyle;
  dbImport: string;
  dialect: Dialect;
  /** "flat" (default) — all files in outDir; "package" — files placed in a sub-path derived from each entity's metadata package. */
  outputLayout?: OutputLayout;
  /** Whether the OPT-IN Hono routes generator (routesFileHono) is active in the
   *  run — aggregated by the runner from the suite's `emitsHonoRoutes` markers.
   *  api-docs reads this to AUTO-DETECT whether to document the Hono CRUD surface
   *  (it otherwise mirrors the default Fastify-only suite). Undefined ⇒ false. */
  includeHonoRoutes?: boolean;
  /**
   * FR-019 / ADR-0026: the module specifier from which an externally-PROVIDED
   * shared enum (`@provided: true` on an abstract package-level `field.enum`) is
   * imported. metaobjects emits NO type for a provided enum — consuming entity
   * files `import { <EnumName> } from "<providedEnumModule>"`. The per-port
   * namespace/module is codegen config, never a metadata attr (ADR-0001). A model
   * that references a provided enum without this set is a codegen-time error.
   */
  providedEnumModule?: string;
}

/** Default dialect / entity-import when a value-object-only project omits them.
 *  Inert — they are only ever read when DB code is generated, and a project that
 *  would generate DB code is required to set them explicitly (see `runGen`'s guard). */
export const DEFAULT_DIALECT: Dialect = "sqlite";
export const DEFAULT_DB_IMPORT = "./db";

/**
 * The user-facing codegen config. `dbImport` / `dialect` are OPTIONAL here (unlike the
 * resolved `ResolvedGenConfig` the generators consume): a value-object-only project
 * (no `object.entity` / `object.projection`) generates zero database / query / route
 * code, so requiring them would be a dead-but-mandatory `tsc` obligation. `runGen`
 * fills inert defaults when they are absent AND the model emits no DB artifacts, and
 * throws a clear error when they are absent but the model DOES emit DB code (#194).
 */
export interface MetaobjectsGenConfig extends Omit<ResolvedGenConfig, "dbImport" | "dialect"> {
  dbImport?: string;
  dialect?: Dialect;
  /**
   * Generators to run. Each entry is either a typed generator factory result
   * (`entityFile()`) or a stable-name string (`"entity"`) resolved via the
   * registry. Mixed arrays are allowed (`["entity", routesFile()]`). String
   * entries use the generator's default options. ADR-0021 #1.
   */
  generators: GeneratorSpec[];
  /** How field names map to DB column names when @dbColumn is omitted. Defaults to "snake_case". */
  columnNamingStrategy?: ColumnNamingStrategy;
  /**
   * Auto-pluralize the Drizzle collection (table) variable name derived from
   * each entity (`AgentConfig` → `agentConfigs`). Defaults to `true`. Set
   * `false` to keep collection vars singular. Per-entity exceptions go in
   * {@link collectionNameOverrides}. Naming is a per-port codegen concern
   * (ADR-0001), so this is config — not a metadata attribute — and carries no
   * cross-port conformance cost.
   */
  pluralizeCollections?: boolean;
  /**
   * Per-entity exact collection-var-name overrides, keyed by the bare entity
   * name. Wins over {@link pluralizeCollections} — the escape hatch for the
   * handful of tables a global rule gets wrong
   * (e.g. `{ AuditLog: "auditLog", LlmTierConfig: "llmTierConfig" }`).
   */
  collectionNameOverrides?: Record<string, string>;
  /**
   * Drizzle timestamp column mode. "string" (default) types timestamp columns as
   * ISO-8601 strings (matches the generated Zod + cross-port wire contract); "date"
   * uses drizzle's native JS-Date mode (for consumers whose hand-written code works
   * with `Date`).
   *
   * **Postgres-only.** Drizzle's sqlite-core `text()` timestamp column has no
   * Date-typed mode (only `pg-core`'s `timestamp()` does), so `"date"` is
   * normalized to `"string"` whenever `dialect: "sqlite"` (which also covers
   * Cloudflare D1 — D1 is sqlite-at-the-SQL-level, see the D1 note in the repo's
   * porting docs). This keeps the option a safe no-op on sqlite/D1 instead of
   * emitting a non-compiling column + a Zod schema disagreeing with it.
   *
   * Date-mode filtering (`?filter[<timestamp>][gte]=...`) IS supported: a
   * `@filterable` `field.timestamp` generated under this mode carries
   * `dateValues: true` in its `FilterAllowlist` rule, and `runtime-ts`'s filter
   * parser coerces the query-string value with `new Date(...)` rather than binding
   * a string against a Date-typed column (a malformed value is rejected as
   * `filter.invalid_value`). `field.date` / `field.time` are unaffected — Drizzle
   * types both as strings under every dialect.
   */
  timestampMode?: "date" | "string";
  /** Path prefix applied to generated route registrations + hook fetch URLs. Defaults to "". */
  apiPrefix?: string;
  /**
   * Whether abstract entities (`@isAbstract: true`) emit their shape artifact
   * (the type-only interface / value-object file from the entity-file
   * generator). Defaults to `true`. Instance/write artifacts (forms, CRUD/read
   * hooks, grids) are NEVER emitted for abstract entities regardless of this
   * flag — that invariant lives in `instance-artifacts.ts`. This knob only
   * governs the shape, mirroring the cross-port `emitAbstractShapes` option.
   */
  emitAbstractShapes?: boolean;
  /** Docs-output config consumed by the `meta docs` door. See {@link DocsConfig}. */
  docs?: DocsConfig;
  /** Named output destinations. Generators reference one via `target`. */
  targets?: Record<string, TargetConfig>;
  /** importBase for the default target (top-level outDir). */
  importBase?: string;
  /**
   * Consumer-supplied {@link MetaDataTypeProvider}s. Threaded to `loadMemory`
   * by the CLI's gen/migrate commands so a project can register its own
   * subtypes/attrs (e.g. a `template.toolcall` subtype) without forking the
   * loader. Composed AFTER the default core+forge bundle.
   */
  providers?: readonly MetaDataTypeProvider[];
  /** `meta verify` settings. Nothing here affects codegen. */
  verify?: VerifyConfig;
}

/** `meta verify` settings. */
export interface VerifyConfig {
  /**
   * Glob patterns naming this project's test files, for the `@verifiedBy` check.
   *
   * **What counts as a test file is the project's call.** The built-in patterns cover
   * the conventions this repo ports to (jest/vitest/bun, JUnit, Maven Failsafe `*IT`,
   * xUnit/NUnit, pytest, Kotlin) and are a CONVENIENCE, not an authority — a list of
   * guesses about someone else's repository will always be incomplete, and when it is,
   * a requirement naming a real test reads as a broken claim. Anything declared here is
   * added to the built-ins.
   *
   * Matched against forward-slash paths relative to the project root: `**` spans
   * separators, `*` does not.
   *
   * ```ts
   * verify: { testFiles: ["**\/*IT.kt", "**\/*.feature"] }
   * ```
   */
  testFiles?: string[];
}

/** MetaobjectsGenConfig after applying defaults. All fields required.
 *  `targets` is Omitted from the base so it can narrow from the user-facing
 *  TargetConfig to the fully-resolved ResolvedTarget (incompatible under
 *  exactOptionalPropertyTypes otherwise). */
export interface NormalizedMetaobjectsGenConfig
  extends Omit<MetaobjectsGenConfig, "targets" | "generators" | "dbImport" | "dialect"> {
  /** Resolved to a concrete value (the user's, else the inert default). */
  dbImport: string;
  dialect: Dialect;
  /** Fully resolved — every string spec has been mapped to its factory result. */
  generators: Generator[];
  columnNamingStrategy: ColumnNamingStrategy;
  pluralizeCollections: boolean;
  collectionNameOverrides: Record<string, string>;
  timestampMode: "date" | "string";
  apiPrefix: string;
  emitAbstractShapes: boolean;
  outputLayout: OutputLayout;
  targets: Record<string, ResolvedTarget>;
}

export type DocsSurface = "model" | "api";

export interface ApiSurface {
  lang: string;
  subDir: string;
  baseUrl?: string;
}

/** The single docs-output config: where ALL doc surfaces go, how pages are laid
 *  out, and which surfaces to emit. Read by the `meta docs` door (and, when the
 *  api surface fans out, by each port's docs command). */
export interface DocsConfig {
  outDir?: string;
  layout?: OutputLayout;
  baseUrl?: string;
  surfaces?: DocsSurface[];
  apiSurfaces?: ApiSurface[];
}

export interface ResolvedDocsConfig {
  outDir: string;
  layout: OutputLayout;
  baseUrl: string;
  surfaces: DocsSurface[];
  apiSurfaces: ApiSurface[];
}

/** Merge the config `docs:` block with CLI overrides over documented defaults.
 *  `fallbackLayout` is the project's `outputLayout` so docs default to the same
 *  page placement as codegen when `docs.layout` is unset. */
export function resolveDocsConfig(
  block: DocsConfig | undefined,
  cli: Partial<ResolvedDocsConfig>,
  fallbackLayout: OutputLayout,
): ResolvedDocsConfig {
  return {
    outDir: cli.outDir ?? block?.outDir ?? "./docs",
    layout: cli.layout ?? block?.layout ?? fallbackLayout,
    baseUrl: cli.baseUrl ?? block?.baseUrl ?? "",
    surfaces: cli.surfaces ?? block?.surfaces ?? ["model", "api"],
    apiSurfaces: cli.apiSurfaces ?? block?.apiSurfaces ?? [{ lang: "ts", subDir: "api" }],
  };
}

/** Identity passthrough; exists for IDE type-inference + autocomplete. */
export function defineConfig(config: MetaobjectsGenConfig): MetaobjectsGenConfig {
  return config;
}

/** Synthesize the implicit "default" target from top-level fields and resolve
 *  each named target (outputLayout + dbImport fall back to top-level;
 *  importBase does NOT inherit — it is a per-target identity). */
export function resolveTargets(config: MetaobjectsGenConfig): Record<string, ResolvedTarget> {
  const layout: OutputLayout = config.outputLayout ?? "flat";
  const out: Record<string, ResolvedTarget> = {
    [DEFAULT_TARGET_NAME]: {
      name: DEFAULT_TARGET_NAME,
      outDir: config.outDir,
      importBase: config.importBase,
      outputLayout: layout,
      dbImport: config.dbImport ?? DEFAULT_DB_IMPORT,
      // The default target is the server package — runtime bindings on.
      runtime: true,
    },
  };
  for (const [name, t] of Object.entries(config.targets ?? {})) {
    out[name] = {
      name,
      outDir: t.outDir,
      importBase: t.importBase,
      outputLayout: t.outputLayout ?? layout,
      dbImport: t.dbImport ?? config.dbImport ?? DEFAULT_DB_IMPORT,
      runtime: t.runtime ?? true,
    };
  }
  return out;
}

/**
 * Materialize the config `generators` array: pass typed generators through
 * untouched and resolve each stable-name string via the {@link generatorRegistry}
 * to its factory result (default options). ADR-0021 #1.
 *
 * Errors:
 *  - a NEUTRAL name (`docs`, `mermaid-er`) is owned by `meta docs` (ADR-0021 D1)
 *    and is not selectable in the gen suite.
 *  - an UNKNOWN name throws listing the available NATIVE names.
 */
export function resolveGenerators(specs: readonly GeneratorSpec[]): Generator[] {
  return specs.map((spec) => {
    if (typeof spec !== "string") return spec;
    const entry = generatorRegistry[spec];
    if (entry === undefined) {
      const native = Object.values(generatorRegistry)
        .filter((e) => e.tier === "native")
        .map((e) => e.name)
        .sort();
      throw new Error(
        `unknown generator "${spec}". Available native generators: ${native.join(", ")}.`,
      );
    }
    if (entry.tier !== "native") {
      throw new Error(
        `generator "${spec}" is neutral (owned by 'meta docs'); ` +
        `not selectable in the gen suite.`,
      );
    }
    return entry.factory();
  });
}

/** Apply defaults to a MetaobjectsGenConfig, returning a NormalizedMetaobjectsGenConfig. */
export function normalizeConfig(config: MetaobjectsGenConfig): NormalizedMetaobjectsGenConfig {
  const dialect = config.dialect ?? DEFAULT_DIALECT;
  return {
    ...config,
    dbImport: config.dbImport ?? DEFAULT_DB_IMPORT,
    dialect,
    generators: resolveGenerators(config.generators),
    columnNamingStrategy: config.columnNamingStrategy ?? DEFAULT_COLUMN_NAMING_STRATEGY,
    pluralizeCollections: config.pluralizeCollections ?? true,
    collectionNameOverrides: config.collectionNameOverrides ?? {},
    // "date" mode is Postgres-only (see the doc comment on timestampMode above) —
    // normalize to "string" on sqlite/D1 at this one choke point so the option
    // can never silently emit a non-compiling column + a disagreeing Zod schema.
    timestampMode: dialect === "sqlite" ? "string" : (config.timestampMode ?? "string"),
    apiPrefix: config.apiPrefix ?? "",
    emitAbstractShapes: config.emitAbstractShapes ?? true,
    outputLayout: config.outputLayout ?? "flat",
    targets: resolveTargets(config),
  };
}
