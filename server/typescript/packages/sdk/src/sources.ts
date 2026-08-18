// server/typescript/packages/sdk/src/sources.ts
//
// Phase-1 metadata-source-resolution — source spec resolution.
//
// Turns a declared source SET (`.metaobjects/config.json`'s `sources`) into a
// canonically-sorted, de-duplicated list of metadata file paths. The result is
// a pure function of the source SET, never of declaration order: permuting
// `specs` cannot change the output. A later phase-1 task pins this with a
// permutation test, so the sort-by-absolute-path + de-dup step is load-bearing.
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ParseError, codeSource } from "@metaobjectsdev/metadata";

/** Tagged union of source kinds. `resource` and `package` are declared now so
 *  the config shape is stable across phases; only `path` resolves in phase 1 —
 *  `resource`/`package` throw `ERR_SOURCE_KIND_UNSUPPORTED`. */
export type SourceSpec =
  | { readonly path: string }
  | { readonly resource: string }
  | { readonly package: string };

export interface ResolvedSource {
  /** Absolute path of one metadata file. */
  readonly file: string;
  /** The spec that contributed it — provenance for diagnostics. */
  readonly spec: SourceSpec;
}

/** Used when `sources` is absent or empty in `.metaobjects/config.json`. A
 *  DEFAULT, never a requirement — a project that declares `sources` explicitly
 *  need not include `metaobjects/` at all. */
export const DEFAULT_SOURCES: readonly SourceSpec[] = [{ path: "metaobjects" }];

const PENDING_DIR = "_pending";

function isMetadataFile(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml");
}

/** Recursively collect metadata files under `dir`, excluding `_pending/` at any
 *  depth. Uses `stat` (follows symlinks) rather than `lstat` or
 *  `Dirent.isDirectory()` — `DirectorySource` in `@metaobjectsdev/metadata` has
 *  always followed symlinks this way, so a symlinked subdirectory must be
 *  traversed here too, or this walk and the loader's would silently disagree
 *  about the same tree. */
async function collectDir(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (entry === PENDING_DIR) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) await collectDir(full, out);
    else if (s.isFile() && isMetadataFile(entry)) out.push(full);
  }
}

/**
 * Resolve a declared source SET to a canonically-sorted list of metadata files.
 *
 * The result is sorted by absolute path and de-duplicated by file, so it is a
 * pure function of the SET of `specs` — permuting `specs` cannot change the
 * output. Declared order carries no information (the loader derives whatever
 * order it needs from the files themselves).
 *
 * Only `path` specs resolve in phase 1: a directory is walked recursively, a
 * file is taken as-is. An unresolvable `path` throws `ERR_SOURCE_UNRESOLVED`
 * rather than silently contributing nothing; `resource`/`package` specs throw
 * `ERR_SOURCE_KIND_UNSUPPORTED`.
 *
 * @param configDir absolute directory of the declaring config (the parent of
 *   `.metaobjects/`) — relative `path` specs resolve against it, never against
 *   ambient `process.cwd()`.
 */
export async function resolveSources(
  configDir: string,
  specs: readonly SourceSpec[],
): Promise<ResolvedSource[]> {
  const byFile = new Map<string, SourceSpec>();

  for (const spec of specs) {
    if (!("path" in spec)) {
      const kind = "resource" in spec ? "resource" : "package";
      throw new ParseError(
        `source kind "${kind}" is not supported by this toolchain yet; use a "path" source`,
        { code: "ERR_SOURCE_KIND_UNSUPPORTED", source: codeSource("resolveSources") },
      );
    }

    const target = isAbsolute(spec.path) ? spec.path : resolve(configDir, spec.path);
    let stats;
    try {
      stats = await stat(target);
    } catch {
      throw new ParseError(
        `source path "${spec.path}" does not exist (resolved to ${target}, relative to ${configDir})`,
        { code: "ERR_SOURCE_UNRESOLVED", source: codeSource("resolveSources") },
      );
    }

    const found: string[] = [];
    if (stats.isDirectory()) await collectDir(target, found);
    else found.push(target);
    for (const file of found) if (!byFile.has(file)) byFile.set(file, spec);
  }

  return [...byFile.keys()].sort().map((file) => ({ file, spec: byFile.get(file)! }));
}
