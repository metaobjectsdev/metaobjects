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
// order is `listMetadataFiles`'s (metadata-files.ts) — files at a level, then
// that level's subdirectories, depth-first — because that is the order production
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
import { DEFAULT_METADATA_DIR, listMetadataFiles } from "./metadata-files.js";

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
 *  need not include the default directory at all. Built from
 *  `DEFAULT_METADATA_DIR` (`metadata-files.ts`'s single definition) rather than
 *  restating that name here: a second independent encoding of the same
 *  default would let `resolveCollection`'s "does the default dir exist"
 *  check (`collection.ts`) desync from what `resolveSources` actually
 *  resolves the moment the default ever changed — silently reproducing the
 *  "two code paths disagree about where metadata lives" class of bug this
 *  whole mechanism exists to eliminate. */
export const DEFAULT_SOURCES: readonly SourceSpec[] = [{ path: DEFAULT_METADATA_DIR }];

/** Narrows `spec` to its `path` arm, throwing `ERR_SOURCE_KIND_UNSUPPORTED`
 *  for `resource`/`package` — phase 1 resolves `path` only. Returns rather than
 *  asserting so one call both validates and narrows: an `asserts` signature has
 *  to be re-invoked wherever TypeScript's control-flow analysis cannot carry the
 *  narrowing, which is a language workaround masquerading as a second check. */
function toPathSpec(spec: SourceSpec): { readonly path: string } {
  if ("path" in spec) return spec;
  const kind = "resource" in spec ? "resource" : "package";
  throw new ParseError(
    `source kind "${kind}" is not supported by this toolchain yet; use a "path" source`,
    { code: "ERR_SOURCE_KIND_UNSUPPORTED", source: codeSource("resolveSources") },
  );
}

/**
 * The declared source SET in CANONICAL order — kind-validated, then sorted by
 * spec CONTENT rather than by declaration order.
 *
 * This is the ONE place declaration order is discarded, and the module's "pure
 * function of the SET" invariant rests on it: the emitted file order, the spec
 * attributed to a file two specs both reach, and which of several unresolvable
 * paths reports its `ERR_SOURCE_UNRESOLVED` first are all decided here.
 * Validation runs across the WHOLE list before any sorting or filesystem I/O —
 * interleaved with resolution, which error code came back would depend on
 * declaration order, contradicting that same invariant.
 *
 * Exported because `resolveCollection` derives `sourceRoots` from the declared
 * specs and must use this identical ordering; a second sort would be a second
 * definition of "canonical".
 */
export function orderedPathSpecs(specs: readonly SourceSpec[]): { readonly path: string }[] {
  return specs.map(toPathSpec).sort((a, b) => {
    const [ja, jb] = [JSON.stringify(a), JSON.stringify(b)];
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });
}

/**
 * Where a declared `path` source lives on disk: absolute as written, otherwise
 * relative to the DECLARING config's directory — never to ambient
 * `process.cwd()`.
 *
 * One definition, because this expression *is* the rule for where a declared
 * source lives, which is the single piece of knowledge this module exists to
 * own. A caller that needs a source's root directory (rather than its files)
 * calls this rather than restating it.
 */
export function resolveSpecPath(configDir: string, spec: { readonly path: string }): string {
  return isAbsolute(spec.path) ? spec.path : resolve(configDir, spec.path);
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
  // Kind-validated and content-ordered in one pass — see `orderedPathSpecs`.
  const ordered = orderedPathSpecs(specs);

  // Insertion order IS output order — a Map preserves it, so the per-spec walk
  // order above survives to the caller. First contributor wins a shared file,
  // which is content-determined because `ordered` is.
  const byFile = new Map<string, SourceSpec>();

  for (const spec of ordered) {
    const target = resolveSpecPath(configDir, spec);
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
