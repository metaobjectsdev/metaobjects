// server/typescript/packages/cli/src/lib/collection-load-options.ts
//
// FR-023 — everything a resolved `Collection` contributes to a metadata LOAD,
// in one helper.
//
// One helper rather than four properties spread by hand at each of the nine
// `loadMemory` call sites, for the reason `loadMemoryOptionsFrom` exists next
// door (#333): threading one and forgetting another is how a capability reaches
// some commands and not others. Here the stakes are higher than a missing
// provider — a site that passes `files` alone loads a dependency's artifact
// under a local-looking source id AND loses the
// `ERR_DEPENDENCY_PACKAGE_NOT_OWNED` refusal, so a node declared into a
// dependency's package is silently excluded from that command's output instead
// of being refused by name.
import type { Collection, LoadMemoryOptions } from "@metaobjectsdev/sdk";

/**
 * The load half of a `Collection`: the resolved file list (dependency artifacts
 * first, then the project's own files), the `dep:<name>/<artifact>` source ids
 * those artifacts load under, and the two imported sets the ownership refusal
 * reads.
 *
 * The return type is a `Pick` of {@link LoadMemoryOptions} rather than a
 * hand-written shape, so renaming or retyping an option there is a compile
 * error here rather than a silently-dropped key.
 */
export function collectionLoadOptions(
  collection: Collection,
): Required<Pick<LoadMemoryOptions, "files" | "fileIds" | "importedPackages" | "importedNodes" | "libraries">> {
  return {
    files: collection.files,
    fileIds: collection.fileIds,
    importedPackages: collection.importedPackages,
    importedNodes: collection.importedNodes,
    // FR-043 — the shipped-library selection moved here from metaobjects.config.ts, so
    // it now rides the same helper as everything else the collection contributes. That
    // is the point of the move as much as the neutrality is: `libraries` used to be
    // threaded by `loadMemoryOptionsFrom`, a SECOND helper, and #333 is on record as the
    // bug where one of the two reached every command and the other reached none.
    libraries: collection.libraries,
  };
}
