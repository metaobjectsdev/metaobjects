// Records
export { RecordCore, RecordType, RecordSource } from "./records/core.js";
export { ConventionRecord } from "./records/convention.js";
export { DecisionRecord } from "./records/decision.js";
export { PrincipleRecord } from "./records/principle.js";
export { GlossaryRecord } from "./records/glossary.js";
export { FailureRecord } from "./records/failure.js";
export { AnyRecord } from "./records/any.js";

// Storage
export {
  readRecord,
  recordExists,
  writeRecord,
  removeRecord,
  listRecords,
  promoteRecord,
  supersede,
  MetaForgeRecordNotFoundError,
  MetaForgeAlreadyPromotedError,
  MetaForgeRecordParseError,
} from "./storage/index.js";
export type { ListOptions } from "./storage/index.js";

// Paths
export { recordPath, resolveMetaRoot } from "./paths.js";

// Config
export { ConfigSchema, DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
export type { Config } from "./config.js";

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
  // Registration helper
  registerForgeTypes,
} from "./forge-types.js";
export type { ForgeType, ForgeAttr } from "./forge-types.js";

// Memory loader — read metaobjects/ into a MetaModel
// (workspace-aware: walks extends: deps via pnpm-workspace.yaml or
//  package.json workspaces field if present)
export { loadMemory, DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "./memory.js";

// Workspace discovery — finds peer metadata packages in a monorepo
export { discoverWorkspace, resolveExtendsOrder, packageLabel } from "./workspace.js";
export type { Workspace, WorkspacePackage } from "./workspace.js";

// Package manifest — the v0.3 package.meta.json model. Three-field manifest
// (name, version, extends) that defines a metadata package's identity and
// upstream dependencies. The package's metadata tree IS its public API;
// there is no exports field. See docs/strategy/2026-05-12-v0.3-ai-first-
// metadata-loading.md.
export {
  PackageManifestSchema,
  readPackageManifest,
  resolveMetaobjectsPackage,
  PACKAGE_MANIFEST_FILE,
} from "./package.js";
export type { PackageManifest } from "./package.js";
