// server/typescript/packages/sdk/src/sources.ts
//
// Phase-1 metadata-source-resolution — source spec resolution.
//
// Turns a declared source SET (`.metaobjects/config.json`'s `sources`) into a
// canonically-sorted, de-duplicated list of metadata file paths. The FULL
// result — including which spec each entry attributes to — is a pure
// function of the source SET, never of declaration order: permuting `specs`
// cannot change the output, even when two specs overlap on the same file. A
// later phase-1 task pins this with a permutation test (the design's
// linchpin), so both the sort-by-absolute-path step and the content-based
// overlap tie-break below are load-bearing.
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ParseError, codeSource } from "@metaobjectsdev/metadata";
import { DEFAULT_METADATA_DIR, isMetadataFile } from "./memory.js";

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
 *  need not include `metaobjects/` at all. Built from `DEFAULT_METADATA_DIR`
 *  (`memory.ts`'s own default-directory constant) rather than restating the
 *  literal "metaobjects" here: a second independent encoding of the same
 *  default would let `resolveCollection`'s "does the default dir exist"
 *  check (`collection.ts`) desync from what `resolveSources` actually
 *  resolves the moment the default ever changed — silently reproducing the
 *  "two code paths disagree about where metadata lives" class of bug this
 *  whole mechanism exists to eliminate. */
export const DEFAULT_SOURCES: readonly SourceSpec[] = [{ path: DEFAULT_METADATA_DIR }];

const PENDING_DIR = "_pending";

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
    let s;
    try {
      s = await stat(full);
    } catch {
      // A dangling symlink, a TOCTOU removal between readdir and stat, or an
      // inaccessible (EACCES) entry — skip it, matching DirectorySource in
      // @metaobjectsdev/metadata (directory-source.ts), which this walk
      // otherwise mirrors. An uncaught stat() here would crash
      // resolveSources with a raw Node ENOENT on a tree the loader reads
      // fine.
      continue;
    }
    if (s.isDirectory()) await collectDir(full, out);
    else if (s.isFile() && isMetadataFile(entry)) out.push(full);
  }
}

/** Narrows `spec` to its `path` arm, throwing `ERR_SOURCE_KIND_UNSUPPORTED`
 *  for `resource`/`package` — phase 1 resolves `path` only. Called in two
 *  separate passes by {@link resolveSources} (see the comment there): an
 *  unsupported kind must be reported regardless of where it sits in the
 *  declared list. */
function assertPathSpec(spec: SourceSpec): asserts spec is { readonly path: string } {
  if ("path" in spec) return;
  const kind = "resource" in spec ? "resource" : "package";
  throw new ParseError(
    `source kind "${kind}" is not supported by this toolchain yet; use a "path" source`,
    { code: "ERR_SOURCE_KIND_UNSUPPORTED", source: codeSource("resolveSources") },
  );
}

/**
 * Resolve a declared source SET to a canonically-sorted list of metadata files.
 *
 * The full result — each entry's `.file` AND its `.spec` — is a pure function
 * of the SET of `specs`: permuting `specs` cannot change the output. Two parts
 * make that hold: entries are sorted by absolute path (so file ORDER carries no
 * declaration-order information), and when two specs overlap on the same file,
 * the one attributed is chosen by comparing `JSON.stringify(spec)` — a
 * content-only tie-break, so which spec "wins" never depends on which was
 * processed first. Declared order carries no information anywhere in this
 * function (the loader derives whatever order it needs from the files
 * themselves).
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
  // Validate every spec's KIND up front, before any filesystem I/O. Without
  // this separate pass, kind-validation and path resolution were
  // interleaved in one loop, so which error code came back depended on
  // DECLARATION ORDER: an unsupported-kind spec placed after an
  // unresolvable path spec never got reached (the path spec's
  // ERR_SOURCE_UNRESOLVED fired first) — contradicting this module's own
  // "pure function of the SET" invariant (see the file header).
  for (const spec of specs) assertPathSpec(spec);

  const byFile = new Map<string, SourceSpec>();

  for (const spec of specs) {
    assertPathSpec(spec); // already validated above; narrows `spec.path` for TS below.

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
    for (const file of found) {
      const existing = byFile.get(file);
      // Content-only tie-break: never "first spec processed wins", or the
      // attributed `.spec` would depend on declaration order.
      if (existing === undefined || JSON.stringify(spec) < JSON.stringify(existing)) {
        byFile.set(file, spec);
      }
    }
  }

  return [...byFile.keys()].sort().map((file) => ({ file, spec: byFile.get(file)! }));
}
