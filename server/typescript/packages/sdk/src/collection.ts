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
import { loadConfig, type Config } from "./config.js";
import { findConfigDir } from "./discovery.js";
import { compileScope, type CompiledScope, type Scope } from "./scope.js";
import { DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "./memory.js";
import { DEFAULT_SOURCES, resolveSources, type ResolvedSource, type SourceSpec } from "./sources.js";

export interface Collection {
  /** Directory whose config declared this collection (or the resolved start
   *  directory, when nothing was discovered and the default applies). */
  readonly configDir: string;
  /** Canonically-sorted absolute metadata file paths — see `resolveSources`. */
  readonly files: readonly string[];
  /** Same set, carrying the contributing spec for provenance. */
  readonly sources: readonly ResolvedSource[];
  /** Output filter for codegen. Empty include => everything. */
  readonly scope: CompiledScope;
  /** Output filter for migrate/verify --db. Undefined => the command governs
   *  everything in scope. */
  readonly migrateScope: CompiledScope | undefined;
}

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
 * `sources`/`scope`/`migrate.scope` govern; an absent or malformed config
 * (no `.metaobjects/config.json`, or one `loadConfig` cannot read) falls
 * through to `DEFAULT_SOURCES` — the same `metaobjects/` directory the
 * pre-source-resolution toolchain always read. Throws
 * `ERR_COLLECTION_NOT_FOUND` only when BOTH have failed: no `sources` were
 * declared AND the default `metaobjects/` directory does not exist either.
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
  const configDir =
    explicit !== undefined ? resolve(explicit) : ((await findConfigDir(startDir)) ?? resolve(startDir));

  let specs: readonly SourceSpec[] = DEFAULT_SOURCES;
  let scopeSpec: Config["scope"];
  let migrateSpec: string[] | undefined;

  if (await isDir(join(configDir, DEFAULT_METAOBJECTS_DIR))) {
    try {
      const cfg = await loadConfig(join(configDir, DEFAULT_METAOBJECTS_DIR));
      if (cfg.sources.length > 0) specs = cfg.sources;
      scopeSpec = cfg.scope;
      migrateSpec = cfg.migrate?.scope;
    } catch {
      // `.metaobjects/` exists but `config.json` is absent or unreadable —
      // fall through to the default source set, matching the no-config
      // case below. A genuinely MALFORMED config.json (present, readable,
      // but failing ConfigSchema.parse) takes the same path here, since
      // loadConfig's current signature gives no way to tell "absent" apart
      // from "malformed" without re-implementing its read+parse. See the
      // task report for why that's flagged rather than fixed in place.
    }
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
  };
}
