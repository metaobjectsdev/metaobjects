// The forge memory RECORD schemas (`RecordCore`, `DecisionRecord`, …), their file STORAGE
// layer (`readRecord` / `writeRecord` / `listRecords` / `promoteRecord` / `supersede`) and
// the `.meta` PATH helpers (`recordPath` / `resolveMetaRoot`) were exported here and are
// removed. Nothing in this repository imported any of them outside their own tests — not
// the CLI, not a generator — and no adopter estate did. They are the predecessor product's
// record store, and the vocabulary they describe is no longer in any default composition
// (see `defaultLoadMemoryProviders`); keeping a published API for a store nothing reads
// would have frozen it into 1.0.
//
// `recordPath` built `<metaRoot>/memory/<type>/<id>.json` — the layout of exactly that
// deleted store. `resolveMetaRoot` walked up for a `.meta` directory, which `meta init`
// does not scaffold and this package's own test asserts is NOT created; the one caller
// anywhere was this README's usage example, where it was paired with `loadConfig` — and
// `loadConfig` reads `<dir>/config.json`, while a project's config lives under
// `.metaobjects/`. The example therefore threw before it could read the wrong file. It now
// shows `resolveCollection`, the documented single authority for locating a project.

// Config
export { ConfigSchema, DEFAULT_CONFIG, loadConfig, saveConfig, AllowTokenEnum } from "./config.js";
export type { Config } from "./config.js";

// Metadata dependencies (FR-023) — the `dependencies` config key's schema,
// constants, and the manifest/lock schemas + integrity hashing (Task 7).
// The collection resolver that actually consumes them lands in a later task.
export {
  DEPS_DIR,
  LOCK_FILE,
  MANIFEST_FILE,
  ARTIFACT_SUFFIX,
  DEPENDENCY_SOURCE_ID_PREFIX,
  INTEGRITY_PREFIX,
  DependencySpecSchema,
  dependencyName,
  IntegritySchema,
  ManifestSchema,
  LockEntrySchema,
  LockSchema,
  sha256Integrity,
  dependencySourceId,
  readLock,
  writeLock,
} from "./dependencies.js";
export type { DependencySpec, Manifest, LockEntry, Lock, ResolvedDependency } from "./dependencies.js";

// Meta Forge metadata types + attribute name constants (registered into a
// TypeRegistry to let Loader parse decision/principle/etc. children + the
// @forge* attribute namespace).
export {
  // Type names
  FORGE_TYPE_DECISION,
  FORGE_TYPE_PRINCIPLE,
  FORGE_TYPE_CONVENTION,
  FORGE_TYPE_GLOSSARY,
  FORGE_TYPE_FAILURE,
  FORGE_TYPES,
  // Subtypes
  FORGE_DECISION_SUBTYPES,
  FORGE_PRINCIPLE_SUBTYPES,
  FORGE_CONVENTION_SUBTYPES,
  FORGE_GLOSSARY_SUBTYPES,
  FORGE_FAILURE_SUBTYPES,
  // Attribute names
  FORGE_ATTR_CONFIDENCE,
  FORGE_ATTR_SOURCE,
  FORGE_ATTR_CAPTURED_AT,
  FORGE_ATTR_LAST_VALIDATED_COMMIT,
  FORGE_ATTR_PRIMARY_LOCATION,
  FORGE_ATTR_OCCURRENCES,
  FORGE_ATTR_RATIONALE,
  FORGE_ATTR_ALTERNATIVES,
  FORGE_ATTR_SCOPE,
  FORGE_ATTR_STATEMENT,
  FORGE_ATTR_ENFORCEMENT,
  FORGE_ATTR_PATTERN_DESCRIPTION,
  FORGE_ATTR_EXAMPLES,
  FORGE_ATTR_COUNTER_EXAMPLES,
  FORGE_ATTR_APPLIES_TO,
  FORGE_ATTR_TERM,
  FORGE_ATTR_SYNONYMS,
  FORGE_ATTR_DEFINITION,
  FORGE_ATTR_CODE_ANCHORS,
  FORGE_ATTR_SEE_ALSO,
  FORGE_ATTR_WHAT_WAS_TRIED,
  FORGE_ATTR_WHY_IT_FAILED,
  FORGE_ATTRS,
  // Registration helper + provider
  registerForgeTypes,
  forgeTypesProvider,
} from "./forge-types.js";
export type { ForgeType, ForgeAttr } from "./forge-types.js";

// Memory loader — read a project's resolved metadata into a MetaData tree.
// Where those files come from is `resolveCollection`'s decision (below), which
// `loadMemory` calls when the caller supplies no explicit file set.
export { loadMemory, defaultLoadMemoryProviders } from "./memory.js";
export type { LoadMemoryOptions } from "./memory.js";

// Default project layout — the DEFAULT value of `sources` (applied by
// `resolveCollection` alone) and the fixed directory holding the config that
// declares them. Exported for `meta init`, which SCAFFOLDS that layout.
export { DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "./metadata-files.js";

// Scope — output filter over fully-qualified node names
export { compileScope, matchesScope } from "./scope.js";
export type { Scope, CompiledScope } from "./scope.js";

// Source resolution — a declared source SET to a canonically-sorted file list
export { resolveSources, resolveSpecPath, orderedPathSpecs, DEFAULT_SOURCES } from "./sources.js";
export type { SourceSpec, ResolvedSource } from "./sources.js";

// Discovery — nearest-ancestor project root (a `.metaobjects/config.json`,
// the only marker), bounded by the repo root
export { discoverCollectionRoot, resolveConfigDir } from "./discovery.js";
export type { DiscoveredRoot } from "./discovery.js";

// Collection — the single authority on where a project's metadata lives
export { resolveCollection } from "./collection.js";
export type { Collection } from "./collection.js";

// DEPRECATED (removed in 2.0) — workspace discovery over the v0.3 package.meta.json
// prototype. Nothing in the toolchain calls it; cross-repo sharing is FR-023.
export { discoverWorkspace, resolveExtendsOrder, packageLabel } from "./workspace.js";
export type { Workspace, WorkspacePackage } from "./workspace.js";

// DEPRECATED (removed in 2.0) — the v0.3 package.meta.json prototype. Never wired into
// loading; superseded by FR-023 (metadata dependencies).
export {
  PackageManifestSchema,
  readPackageManifest,
  resolveMetaobjectsPackage,
  PACKAGE_MANIFEST_FILE,
} from "./package.js";
export type { PackageManifest } from "./package.js";

// Agent context — stack resolver, file assembler, and vocabulary types
export * from "./agent-context/index.js";
