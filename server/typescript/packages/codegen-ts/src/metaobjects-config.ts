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
}

export interface MetaobjectsGenConfig extends ResolvedGenConfig {
  /**
   * Generators to run. Each entry is either a typed generator factory result
   * (`entityFile()`) or a stable-name string (`"entity"`) resolved via the
   * registry. Mixed arrays are allowed (`["entity", routesFile()]`). String
   * entries use the generator's default options. ADR-0021 #1.
   */
  generators: GeneratorSpec[];
  /** How field names map to DB column names when @dbColumn is omitted. Defaults to "snake_case". */
  columnNamingStrategy?: ColumnNamingStrategy;
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
}

/** MetaobjectsGenConfig after applying defaults. All fields required.
 *  `targets` is Omitted from the base so it can narrow from the user-facing
 *  TargetConfig to the fully-resolved ResolvedTarget (incompatible under
 *  exactOptionalPropertyTypes otherwise). */
export interface NormalizedMetaobjectsGenConfig extends Omit<MetaobjectsGenConfig, "targets" | "generators"> {
  /** Fully resolved — every string spec has been mapped to its factory result. */
  generators: Generator[];
  columnNamingStrategy: ColumnNamingStrategy;
  apiPrefix: string;
  emitAbstractShapes: boolean;
  outputLayout: OutputLayout;
  targets: Record<string, ResolvedTarget>;
}

export type DocsSurface = "model" | "api";

/** The single docs-output config: where ALL doc surfaces go, how pages are laid
 *  out, and which surfaces to emit. Read by the `meta docs` door (and, when the
 *  api surface fans out, by each port's docs command). */
export interface DocsConfig {
  outDir?: string;
  layout?: OutputLayout;
  baseUrl?: string;
  surfaces?: DocsSurface[];
}

export interface ResolvedDocsConfig {
  outDir: string;
  layout: OutputLayout;
  baseUrl: string;
  surfaces: DocsSurface[];
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
      dbImport: config.dbImport,
    },
  };
  for (const [name, t] of Object.entries(config.targets ?? {})) {
    out[name] = {
      name,
      outDir: t.outDir,
      importBase: t.importBase,
      outputLayout: t.outputLayout ?? layout,
      dbImport: t.dbImport ?? config.dbImport,
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
  return {
    ...config,
    generators: resolveGenerators(config.generators),
    columnNamingStrategy: config.columnNamingStrategy ?? DEFAULT_COLUMN_NAMING_STRATEGY,
    apiPrefix: config.apiPrefix ?? "",
    emitAbstractShapes: config.emitAbstractShapes ?? true,
    outputLayout: config.outputLayout ?? "flat",
    targets: resolveTargets(config),
  };
}
