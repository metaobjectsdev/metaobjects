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
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ParseError, codeSource } from "@metaobjectsdev/metadata";
import { CONFIG_FILE, loadConfig, type Config } from "./config.js";
import { exists, findConfigDir } from "./discovery.js";
import { compileScope, type CompiledScope, type Scope } from "./scope.js";
import { DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "./memory.js";
import { DEFAULT_SOURCES, resolveSources, type ResolvedSource, type SourceSpec } from "./sources.js";

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
  /** Output filter for codegen. Empty include => everything. */
  readonly scope: CompiledScope;
  /** Output filter for migrate/verify --db. Undefined => the command governs
   *  everything in scope. */
  readonly migrateScope: CompiledScope | undefined;
  /** The patterns `migrateScope` was compiled FROM, for diagnostics only —
   *  `compileScope` produces RegExps, and a regex source is not something to
   *  show an author who wrote `acme::platform::**`. Carried so the "your scope
   *  matched nothing" refusal can name the patterns that missed. Always in
   *  lockstep with `migrateScope`: both undefined, or both present. */
  readonly migrateScopePatterns: readonly string[] | undefined;
}

// Deliberately NOT deduped with `exists` (imported from `./discovery.js`)
// even though both wrap a bare stat/catch: this predicate exists to produce
// the friendlier `ERR_COLLECTION_NOT_FOUND` diagnostic below rather than the
// raw `ERR_SOURCE_UNRESOLVED` `resolveSources` would throw on a genuinely
// missing default directory — trading that clearer error for one syscall is
// a bad trade, so the redundant `stat` here is intentional, not an oversight.
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
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
 * `findConfigDir` walks up from `startDir` for the nearest
 * `.metaobjects/config.json`, falling back to `startDir` itself when none is
 * found. When the resolved directory carries a config, its declared
 * `sources`/`scope`/`migrate.scope` govern. Only a genuinely ABSENT
 * `config.json` falls through to `DEFAULT_SOURCES` — the same `metaobjects/`
 * directory the pre-source-resolution toolchain always read; a config.json
 * that EXISTS but fails to load (malformed JSON, schema violation) is the
 * author's error and propagates rather than silently degrading — a source
 * that fails to resolve must never look like one that was never declared.
 * Throws `ERR_COLLECTION_NOT_FOUND` only when BOTH have failed: no
 * `sources` were declared AND the default `metaobjects/` directory does not
 * exist either.
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
  // than re-`stat`'d below. On the non-explicit path, `findConfigDir`
  // already proved this: it returns a directory ONLY after confirming
  // `.metaobjects/config.json` exists there (discovery.ts's own `exists`
  // check), and returns undefined only after confirming the same file is
  // absent at every directory it examined, `resolve(startDir)` included. A
  // second `stat` of the identical file would just re-prove what discovery
  // already established. The check is only load-bearing on the
  // `explicitDir` path, where `findConfigDir` never runs at all.
  let configDir: string;
  let hasConfig: boolean;
  if (explicit !== undefined) {
    configDir = resolve(explicit);
    hasConfig = await exists(join(configDir, DEFAULT_METAOBJECTS_DIR, CONFIG_FILE));
  } else {
    const found = await findConfigDir(startDir);
    configDir = found ?? resolve(startDir);
    hasConfig = found !== undefined;
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
  if (specs === DEFAULT_SOURCES && !(await isDir(join(configDir, DEFAULT_METADATA_DIR)))) {
    throw new ParseError(
      `no metadata sources declared in ${configDir} and no default "${DEFAULT_METADATA_DIR}" directory found. ` +
        `Declare "sources" in ${DEFAULT_METAOBJECTS_DIR}/config.json, or run 'meta init' to scaffold.`,
      { code: "ERR_COLLECTION_NOT_FOUND", source: codeSource("resolveCollection") },
    );
  }

  const sources = await resolveSources(configDir, specs);
  return {
    configDir,
    files: sources.map((s) => s.file),
    sources,
    scope: compileScope(toScope(scopeSpec)),
    migrateScope: migrateSpec === undefined ? undefined : compileScope({ include: migrateSpec }),
    migrateScopePatterns: migrateSpec,
  };
}
