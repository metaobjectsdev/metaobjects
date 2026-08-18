// server/typescript/packages/sdk/src/collection.ts
//
// Phase-1 metadata-source-resolution — the single authority.
//
// `resolveCollection()` composes discovery (`discovery.ts`), config
// (`config.ts`), source resolution (`sources.ts`) and the scope engine
// (`scope.ts`) into one function that decides where a project's metadata
// lives. `metaobjects/` is the DEFAULT value of `sources`, never a
// requirement — a project that declares nothing still resolves exactly as
// today (`DEFAULT_SOURCES` in `sources.ts`); a project that declares
// `sources` can point anywhere. No other call site may assume the directory
// name — this is where that assumption is allowed to live, exactly once.
import { join, resolve } from "node:path";
import { ParseError, codeSource } from "@metaobjectsdev/metadata";
import { CONFIG_FILE, loadConfig, type Config } from "./config.js";
import { discoverCollectionRoot, exists, isDir } from "./discovery.js";
import { compileScope, matchesScope, type Scope } from "./scope.js";
import { DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "./metadata-files.js";
import {
  DEFAULT_SOURCES,
  orderedPathSpecs,
  resolveSpecPath,
  resolveSources,
  type ResolvedSource,
  type SourceSpec,
} from "./sources.js";

export interface Collection {
  /** Directory whose config declared this collection (or the resolved start
   *  directory, when nothing was discovered and the default applies). */
  readonly configDir: string;
  /** Canonically-ordered absolute metadata file paths — see `resolveSources`.
   *  Canonical, not sorted: within a directory source the walk order the
   *  toolchain has always used is preserved, because it survives into
   *  generated output. */
  readonly files: readonly string[];
  /** Same set, carrying the contributing spec for provenance. */
  readonly sources: readonly ResolvedSource[];
  /** The distinct roots the declared source specs resolve to, absolute, in the
   *  same canonical (content) order `files` uses. Derived from the DECLARED
   *  specs, not from the resolved files, so a source directory that legitimately
   *  holds no metadata still appears — a consumer listing "where this model
   *  comes from" (`meta docs --site` groups its pages by source root) must not
   *  silently lose a declared source because it happens to be empty today. */
  readonly sourceRoots: readonly string[];
  /**
   * Output filter for codegen: does this fully-qualified name survive the
   * collection's `scope`? Always defined — an unconfigured project compiles to
   * an empty include/exclude, which admits everything, so callers pass this
   * through unconditionally rather than branching.
   *
   * A PREDICATE rather than the `CompiledScope` it closes over, because nothing
   * consumes a compiled scope as a compiled scope: every consumer immediately
   * wrapped it in exactly this lambda, and `migrateScopePatterns` exists
   * precisely because the compiled form cannot be shown to a human.
   * `compileScope`/`matchesScope` stay exported for the conformance corpus.
   */
  readonly inScope: (fqn: string) => boolean;
  /** Output filter for migrate/verify --db (`migrate.scope`). Undefined => the
   *  command governs everything loaded, and that undefined is load-bearing: it
   *  is what leaves the expected schema untouched (migrate-ts `scope.ts`). */
  readonly inMigrateScope: ((fqn: string) => boolean) | undefined;
  /** The patterns `inMigrateScope` was compiled FROM, for diagnostics only —
   *  `compileScope` produces RegExps, and a regex source is not something to
   *  show an author who wrote `acme::platform::**`. Carried so the "your scope
   *  matched nothing" refusal can name the patterns that missed. Always in
   *  lockstep with `inMigrateScope`: both undefined, or both present. */
  readonly migrateScopePatterns: readonly string[] | undefined;
}

/** Narrow the zod-inferred `Config["scope"]` (whose `.optional()` fields are
 *  typed `T | undefined` even when present) down to `Scope`'s
 *  exactOptionalPropertyTypes-safe shape — a key is omitted entirely rather
 *  than assigned `undefined`. */
function toScope(spec: Config["scope"]): Scope {
  return {
    ...(spec?.include !== undefined && { include: spec.include }),
    ...(spec?.exclude !== undefined && { exclude: spec.exclude }),
  };
}

/**
 * THE single authority on where metadata lives. Every read path routes
 * through this — `metaobjects/` is the DEFAULT value of `sources`, never an
 * assumption baked into a call site.
 *
 * Resolution order: an explicit `opts.explicitDir` wins outright; otherwise
 * `discoverCollectionRoot` walks up from `startDir` for the nearest directory
 * carrying `.metaobjects/config.json` — the ONLY project marker (`discovery.ts`
 * says why a directory that merely holds metadata is not one) — falling back to
 * `startDir` itself when none is found. When the resolved directory carries a
 * config, its declared `sources`/`scope`/`migrate.scope` govern. Only a
 * genuinely ABSENT `config.json` falls through to `DEFAULT_SOURCES` — the same
 * directory the pre-source-resolution toolchain always read; a config.json
 * that EXISTS but fails to load (malformed JSON, schema violation) is the
 * author's error and propagates rather than silently degrading — a source
 * that fails to resolve must never look like one that was never declared.
 * Throws `ERR_COLLECTION_NOT_FOUND` only when BOTH have failed: no
 * `sources` were declared AND the default source directory does not exist
 * either.
 *
 * A declared source that fails to resolve is a different, louder failure —
 * `resolveSources` throws `ERR_SOURCE_UNRESOLVED` for that case; only the
 * DEFAULT is allowed to be silently absent.
 */
export async function resolveCollection(
  startDir: string,
  opts?: { explicitDir?: string },
): Promise<Collection> {
  const explicit = opts?.explicitDir;

  // Whether `configDir` carries a `config.json` — threaded through rather
  // than re-`stat`'d below. On the non-explicit path, `discoverCollectionRoot`
  // already proved it either way: it reports `hasConfig` from the same
  // `.metaobjects/config.json` probe that decided where to stop, and reports
  // false only after confirming that file is absent at every directory it
  // examined, `resolve(startDir)` included. A second `stat` of the identical
  // file would just re-prove what discovery established. The check is only
  // load-bearing on the `explicitDir` path, where discovery never runs at all.
  let configDir: string;
  let hasConfig: boolean;
  if (explicit !== undefined) {
    configDir = resolve(explicit);
    hasConfig = await exists(join(configDir, DEFAULT_METAOBJECTS_DIR, CONFIG_FILE));
  } else {
    ({ dir: configDir, hasConfig } = await discoverCollectionRoot(startDir));
  }

  let specs: readonly SourceSpec[] = DEFAULT_SOURCES;
  let scopeSpec: Config["scope"];
  let migrateSpec: string[] | undefined;

  if (hasConfig) {
    // No try/catch here: a config.json that EXISTS but fails to load
    // (malformed JSON, a ConfigSchema violation) propagates. Swallowing it
    // would make a typo'd config behave identically to no config at all —
    // silently generating from a possibly-stale `metaobjects/` with no
    // diagnostic, which is a worse failure than the one this design exists
    // to remove.
    const cfg = await loadConfig(join(configDir, DEFAULT_METAOBJECTS_DIR));
    if (cfg.sources.length > 0) specs = cfg.sources;
    scopeSpec = cfg.scope;
    migrateSpec = cfg.migrate?.scope;
  }

  // Only the DEFAULT is allowed to be absent — an explicitly declared source
  // that does not resolve is `resolveSources`'s ERR_SOURCE_UNRESOLVED, not this.
  //
  // This re-`stat`s a directory the non-explicit discovery walk may already
  // have probed, and that redundancy is intentional: it exists to produce the
  // friendlier `ERR_COLLECTION_NOT_FOUND` diagnostic below rather than the raw
  // `ERR_SOURCE_UNRESOLVED` `resolveSources` would throw on a genuinely missing
  // default directory. Trading that clearer error for one syscall is a bad
  // trade. It is also load-bearing outright on the `explicitDir` path and
  // whenever a discovered config declares no `sources`, where nothing has
  // probed it at all.
  if (specs === DEFAULT_SOURCES && !(await isDir(join(configDir, DEFAULT_METADATA_DIR)))) {
    throw new ParseError(
      `no metadata sources declared in ${configDir} and no default "${DEFAULT_METADATA_DIR}" directory found. ` +
        `Declare "sources" in ${DEFAULT_METAOBJECTS_DIR}/config.json, or run 'meta init' to scaffold.`,
      { code: "ERR_COLLECTION_NOT_FOUND", source: codeSource("resolveCollection") },
    );
  }

  const sources = await resolveSources(configDir, specs);
  const scope = compileScope(toScope(scopeSpec));
  const migrateScope =
    migrateSpec === undefined ? undefined : compileScope({ include: migrateSpec });
  return {
    configDir,
    files: sources.map((s) => s.file),
    sources,
    // Canonical (content) order, from `resolveSources`'s own ordering — so this
    // list is a pure function of the source SET, exactly like `files`.
    sourceRoots: [
      ...new Set(orderedPathSpecs(specs).map((spec) => resolveSpecPath(configDir, spec))),
    ],
    inScope: (fqn: string): boolean => matchesScope(fqn, scope),
    inMigrateScope:
      migrateScope === undefined ? undefined : (fqn: string): boolean => matchesScope(fqn, migrateScope),
    migrateScopePatterns: migrateSpec,
  };
}
