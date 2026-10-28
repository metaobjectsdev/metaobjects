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
// above fall back; any other failure is a real one and is raised unchanged.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_METAOBJECTS_DIR,
  importedNodesOf,
  importedPackagesOf,
  loadConfig,
  loadMemory,
  readLock,
  resolveCollection,
  verifySnapshot,
} from "@metaobjectsdev/sdk";
import { collectionLoadOptions } from "./collection-load-options.js";

/** `resolveCollection`'s code for "no `sources` declared and no default directory". */
const ERR_COLLECTION_NOT_FOUND = "ERR_COLLECTION_NOT_FOUND";

/** The loader codes for vocabulary this toolchain does not register: a type or a subtype
 *  that only another port's providers declare. (The proof's load is lenient, so an unknown
 *  attribute loads and never reaches here.) A misspelt type in a project this toolchain
 *  does read takes the same path, which is why the fallback is announced, not silent. */
const PORT_ONLY_VOCABULARY_CODES: ReadonlySet<string> = new Set(["ERR_UNKNOWN_TYPE", "ERR_UNKNOWN_SUBTYPE"]);

export interface DependencyLoadProof {
  /** What was loaded: the whole collection, or only the locked dependency snapshots. */
  readonly scope: "full" | "dependencies-only";
  /** Why the project's own metadata was not part of it; present exactly when `scope` is
   *  `dependencies-only`. */
  readonly note: string | undefined;
}

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

/** Load only the locked dependency snapshots, together. */
async function loadDependenciesOnly(configDir: string): Promise<void> {
  let resolved;
  try {
    const cfg = await loadConfig(join(configDir, DEFAULT_METAOBJECTS_DIR));
    resolved = await verifySnapshot(configDir, cfg.dependencies, await readLock(configDir));
  } catch (err) {
    throw new DependencyLoadFailure("resolve", err);
  }
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
    if (codeOf(err) !== ERR_COLLECTION_NOT_FOUND || !existsSync(join(configDir, DEFAULT_METAOBJECTS_DIR, "config.json"))) {
      throw new DependencyLoadFailure("resolve", err);
    }
    await loadDependenciesOnly(configDir);
    return {
      scope: "dependencies-only",
      note:
        `the project's own metadata is not under a \`sources\` entry in ${DEFAULT_METAOBJECTS_DIR}/config.json ` +
        "(a build-tool source directory is not read by this command), so only the locked dependencies " +
        "were loaded together.",
    };
  }

  try {
    await loadMemory(collection.configDir, collectionLoadOptions(collection));
    return { scope: "full", note: undefined };
  } catch (err) {
    const code = codeOf(err);
    if (code === undefined || !PORT_ONLY_VOCABULARY_CODES.has(code)) {
      throw new DependencyLoadFailure("load", err);
    }
    await loadDependenciesOnly(configDir);
    return {
      scope: "dependencies-only",
      note:
        "the project's own metadata uses vocabulary this toolchain does not register " +
        `(${code}: ${err instanceof Error ? err.message : String(err)}), so only the locked ` +
        "dependencies were loaded together.",
    };
  }
}

/** The line both commands print after a `dependencies-only` proof. */
export function dependencyOnlyNotice(command: string, note: string): string {
  return `${command}: ${note} Run the project's own \`verify\` for the full check.`;
}
