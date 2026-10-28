// server/typescript/packages/cli/src/lib/dependency-load.ts
//
// FR-023 — the "does the synced dependency set load?" proof `meta deps sync` and
// `meta deps check` both end on (DESIGN §4.1's closing sentence).
//
// The Node `meta deps` commands are the only writers of the lock and the snapshot
// for EVERY port (Phase 2, #482), and they read nothing but
// `.metaobjects/config.json`. A Maven or C# project does not keep its own
// metadata where this toolchain looks (no neutral `sources`, the directory is
// named by the pom or the CLI), and it may use vocabulary only its own port
// registers. Loading the project's own files through THIS toolchain's source
// ladder and provider set therefore fails for reasons that say nothing about the
// dependency set, and it used to fail `sync` after it had already written.
//
// So the proof has two scopes. `full` is the whole collection, exactly as before.
// `dependencies-only` loads just the locked snapshots together (their
// `dep:<name>/<artifact>` ids, the ownership sets), which still catches a
// collision between two dependencies and an artifact that does not load, and says
// plainly that the port's own `verify` is the full check. Only the two causes
// above fall back, and the second only when EVERY load error is one of them in the
// project's own files; any other failure is a real one and is raised unchanged.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DEFAULT_METAOBJECTS_DIR,
  importedNodesOf,
  importedPackagesOf,
  loadConfig,
  loadErrors,
  loadMemory,
  readLock,
  resolveCollection,
  verifySnapshot,
  type Collection,
  type ResolvedDependency,
} from "@metaobjectsdev/sdk";
import { collectionLoadOptions } from "./collection-load-options.js";

/** `resolveCollection`'s code for "no `sources` declared and no default directory". */
const ERR_COLLECTION_NOT_FOUND = "ERR_COLLECTION_NOT_FOUND";

/** The loader codes for vocabulary this toolchain does not register: a type or a subtype
 *  that only another port's providers declare. (The proof's load is lenient, so an unknown
 *  attribute loads and never reaches here.) A misspelt type in a project this toolchain
 *  does read takes the same path, which is why the fallback is announced, not silent. */
const PORT_ONLY_VOCABULARY_CODES: ReadonlySet<string> = new Set(["ERR_UNKNOWN_TYPE", "ERR_UNKNOWN_SUBTYPE"]);

/** What the proof loaded. `dependencies-only` carries the note saying why the project's
 *  own metadata was left out; the note is typed present exactly in that case. */
export type DependencyLoadProof =
  | { readonly scope: "full" }
  | { readonly scope: "dependencies-only"; readonly note: string };

/** A failed proof, tagged with the step that failed so each caller keeps its own wording
 *  for "does not resolve" and "does not load". */
export class DependencyLoadFailure extends Error {
  constructor(
    readonly phase: "resolve" | "load",
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DependencyLoadFailure";
  }
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The source ids the loader names the project's own files by (a file loads under its
 *  basename unless the collection gives it an id). */
function ownSourceIds(collection: Collection): ReadonlySet<string> {
  return new Set(collection.ownFiles.map((f) => collection.fileIds.get(f) ?? basename(f)));
}

/** True when the error is port-only vocabulary and every file it names is the project's own. */
function isOwnPortOnlyVocabulary(err: unknown, ownIds: ReadonlySet<string>): boolean {
  const code = codeOf(err);
  if (code === undefined || !PORT_ONLY_VOCABULARY_CODES.has(code)) return false;
  const files = (err as { source?: { files?: unknown } }).source?.files;
  return Array.isArray(files) && files.length > 0 && files.every((f) => ownIds.has(f as string));
}

/** Load only the given locked dependency snapshots, together. */
async function loadSnapshotsOnly(configDir: string, resolved: readonly ResolvedDependency[]): Promise<void> {
  try {
    await loadMemory(configDir, {
      files: resolved.map((d) => d.artifactPath),
      fileIds: new Map(resolved.map((d) => [d.artifactPath, d.sourceId])),
      importedPackages: [...importedPackagesOf(resolved)].sort(),
      importedNodes: importedNodesOf(resolved),
    });
  } catch (err) {
    throw new DependencyLoadFailure("load", err);
  }
}

/**
 * Prove the dependency set in `configDir` resolves and loads.
 *
 * @throws {DependencyLoadFailure} when it does not.
 */
export async function proveDependencySetLoads(configDir: string): Promise<DependencyLoadProof> {
  let collection;
  try {
    collection = await resolveCollection(configDir);
  } catch (err) {
    // Only a project that carries a config: without one there is no dependency set to
    // prove, and the same code also reports "you passed a metadata directory".
    const hasOwnConfig = existsSync(join(configDir, DEFAULT_METAOBJECTS_DIR, "config.json"));
    if (codeOf(err) !== ERR_COLLECTION_NOT_FOUND || !hasOwnConfig) {
      throw new DependencyLoadFailure("resolve", err);
    }
    // No collection was resolved, so the snapshot is verified here.
    let resolved;
    try {
      const cfg = await loadConfig(join(configDir, DEFAULT_METAOBJECTS_DIR));
      resolved = await verifySnapshot(configDir, cfg.dependencies, await readLock(configDir));
    } catch (verifyErr) {
      throw new DependencyLoadFailure("resolve", verifyErr);
    }
    await loadSnapshotsOnly(configDir, resolved);
    return {
      scope: "dependencies-only",
      note:
        `the project's own metadata is not under a \`sources\` entry in ${DEFAULT_METAOBJECTS_DIR}/config.json ` +
        "(a build-tool source directory is not read by this command), so only the locked dependencies " +
        "were loaded together.",
    };
  }

  const loadOptions = collectionLoadOptions(collection);
  try {
    await loadMemory(collection.configDir, loadOptions);
    return { scope: "full" };
  } catch (err) {
    const ownIds = ownSourceIds(collection);
    if (!isOwnPortOnlyVocabulary(err, ownIds)) throw new DependencyLoadFailure("load", err);
    const errors = await loadErrors(collection.configDir, loadOptions);
    const real = errors.find((e) => !isOwnPortOnlyVocabulary(e, ownIds));
    if (real !== undefined) throw new DependencyLoadFailure("load", real);
    // The snapshot was already verified by resolveCollection; reuse it.
    await loadSnapshotsOnly(collection.configDir, collection.dependencies);
    return {
      scope: "dependencies-only",
      note:
        "the project's own metadata uses vocabulary this toolchain does not register " +
        `(${codeOf(err)}: ${err instanceof Error ? err.message : String(err)}), so only the locked ` +
        "dependencies were loaded together.",
    };
  }
}

/** The line both commands print after a `dependencies-only` proof. */
export function dependencyOnlyNotice(command: string, note: string): string {
  return `${command}: ${note} Run the project's own \`verify\` for the full check.`;
}
