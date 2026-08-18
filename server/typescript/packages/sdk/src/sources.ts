// server/typescript/packages/sdk/src/sources.ts
//
// Phase-1 metadata-source-resolution — source spec resolution.
//
// Turns a declared source SET (`.metaobjects/config.json`'s `sources`) into a
// canonically-ordered, de-duplicated list of metadata file paths. The FULL
// result — including which spec each entry attributes to — is a pure
// function of the source SET, never of declaration order: permuting `specs`
// cannot change the output, even when two specs overlap on the same file.
// `test/order-independence.test.ts` pins that (the design's linchpin), so the
// canonical spec ordering below is load-bearing.
//
// Canonical is NOT the same as "flat-sorted". Within one directory spec the
// order is `listMetadataFiles`'s (memory.ts) — files at a level, then that
// level's subdirectories, depth-first — because that is the order production
// has always handed the loader, and declaration order survives into generated
// output (the barrel's export list, the shared `enums.ts`, `meta docs` page
// order, `meta export`'s sibling order). A flat sort of absolute paths
// silently reorders any project with a subdirectory whose name sorts before a
// sibling file. Across specs, order is decided by spec CONTENT, which is what
// keeps the whole result permutation-invariant. `test/source-order.test.ts`
// pins both halves.
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ParseError, codeSource } from "@metaobjectsdev/metadata";
import { DEFAULT_METADATA_DIR, listMetadataFiles } from "./memory.js";

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
 * Resolve a declared source SET to a canonically-ordered list of metadata files.
 *
 * The full result — each entry's `.file` AND its `.spec` — is a pure function
 * of the SET of `specs`: permuting `specs` cannot change the output. One thing
 * makes that hold: the specs are processed in CONTENT order
 * (`JSON.stringify(spec)`, ascending) rather than declared order, so both the
 * emitted file order and the spec attributed to a file overlapping two specs
 * are decided by content alone. Declared order carries no information anywhere
 * in this function.
 *
 * Within one directory spec the file order is `listMetadataFiles`'s — files at
 * a level, then that level's subdirectories, depth-first. That is deliberately
 * NOT a flat sort of absolute paths: see the file header, and
 * `test/source-order.test.ts`.
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

  // Content order, computed once. This is the ONLY place declaration order is
  // discarded, and everything below depends on it: the output file order, the
  // spec attributed to an overlapping file, and which of several unresolvable
  // paths reports its ERR_SOURCE_UNRESOLVED first.
  const ordered = [...specs].sort((a, b) => {
    const [ja, jb] = [JSON.stringify(a), JSON.stringify(b)];
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });

  // Insertion order IS output order — a Map preserves it, so the per-spec walk
  // order above survives to the caller. First contributor wins a shared file,
  // which is content-determined because `ordered` is.
  const byFile = new Map<string, SourceSpec>();

  for (const spec of ordered) {
    assertPathSpec(spec); // already validated above; narrows `spec.path` for TS below.

    const target = isAbsolute(spec.path) ? spec.path : resolve(configDir, spec.path);
    const stats = await stat(target).catch(() => undefined);
    if (stats === undefined) {
      throw new ParseError(
        `source path "${spec.path}" does not exist (resolved to ${target}, relative to ${configDir})`,
        { code: "ERR_SOURCE_UNRESOLVED", source: codeSource("resolveSources") },
      );
    }

    const found = stats.isDirectory() ? await listMetadataFiles(target) : [target];
    for (const file of found) {
      if (!byFile.has(file)) byFile.set(file, spec);
    }
  }

  return [...byFile].map(([file, spec]) => ({ file, spec }));
}
