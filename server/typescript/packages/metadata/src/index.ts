// Public API surface for @metaobjectsdev/metadata v0.2.0
//
// Architecture: one typed tree of concrete node classes organized under
// src/{core,persistence,presentation}/<concern>/, plus open type registry
// + JSON parser/serializer + Loader orchestration. Java-pattern aligned.
//
// See docs/strategy/2026-05-09-northstar-v4.md and
// docs/specs/2026-05-09-v0.2-ts-pillar.md for context.

// AnyMeta imports — kept here (not in src/shared/ or concern folders) to avoid circular imports.
// See the AnyMeta comment below for full explanation.
import type { MetaRoot } from "./shared/meta-root.js";
import type { MetaObject } from "./core/object/meta-object.js";
import type { MetaField } from "./core/field/meta-field.js";
import type { MetaIdentity } from "./core/identity/meta-identity.js";
import type { MetaIndex } from "./core/index/meta-index.js";
import type { MetaRelationship } from "./core/relationship/meta-relationship.js";
import type { MetaValidator } from "./core/validator/meta-validator.js";
import type { MetaView } from "./presentation/view/meta-view.js";
import type { MetaAttr } from "./core/attr/meta-attr.js";
import type { MetaLayout } from "./presentation/layout/meta-layout.js";
import type { MetaSource } from "./persistence/source/meta-source.js";
import type { MetaOrigin } from "./persistence/origin/meta-origin.js";

// Constants — type names, subtype names, reserved keys, separators
export * from "./shared/base-types.js";
export * from "./shared/structural.js";
export * from "./core/object/object-constants.js";
export * from "./core/field/field-constants.js";
// FR-037 R1 — THE mutability accessors. Every consumer deciding "may this be
// written, and when?" must go through these rather than reading the attr, so the
// absent-means-readWrite default lives in exactly one place per port.
export {
  fieldMutability,
  isReadOnlyMutability,
  isWriteOnceMutability,
} from "./core/field/validate-field-mutability.js";
export * from "./core/attr/attr-constants.js";
export * from "./core/documentation/doc-constants.js";
export * from "./core/validator/validator-constants.js";
export * from "./core/identity/identity-constants.js";
export * from "./core/index/index-constants.js";
export * from "./core/requirement/requirement-constants.js";
export { MetaRequirement } from "./core/requirement/meta-requirement.js";
// Shared `@implementedBy` resolution — one resolver for the CLI's requirement
// checks and codegen's requirement-test fan-out (FR-038).
export {
  resolveClaim,
  resolveClaimTarget,
  resolveMember,
} from "./core/requirement/resolve-claim.js";
export * from "./core/relationship/relationship-constants.js";
export * from "./core/query/query-constants.js";
export * from "./persistence/source/source-constants.js";
export * from "./persistence/origin/origin-constants.js";
export * from "./template/template-constants.js";
export * from "./persistence/db/db-constants.js";
export * from "./presentation/view/view-constants.js";
export * from "./presentation/layout/layout-constants.js";

// MetaData node base — abstract class; also exports AttrValue
export { MetaData } from "./shared/meta-data.js";
export type { AttrValue } from "./shared/meta-data.js";

// Shared node classes
export { MetaRoot } from "./shared/meta-root.js";

// Cross-realm node guards — identify a node by metamodel `type`, not `instanceof`.
// Cross-package callers (codegen-ts / migrate-ts / runtime-ts) MUST use these:
// `instanceof` silently fails when two physical copies of this package are
// loaded. See shared/node-guards.ts for the mechanism.
export {
  isMetaRoot,
  isMetaObject,
  isMetaField,
  isMetaSource,
  isWritableSource,
  isReadOnlySource,
} from "./shared/node-guards.js";

// Core node classes
export { MetaObject } from "./core/object/meta-object.js";
export { MetaField } from "./core/field/meta-field.js";
export { MetaAttr } from "./core/attr/meta-attr.js";

// Runtime object model — backing objects + FQN→factory binding (Phase A).
export { ValueObject } from "./core/object/value-object.js";
export { isMetaObjectAware } from "./core/object/meta-object-aware.js";
export type { MetaObjectAware } from "./core/object/meta-object-aware.js";
export {
  ObjectClassRegistry,
  defaultObjectClassRegistry,
} from "./core/object/object-class-registry.js";
export type { ObjectFactory } from "./core/object/object-class-registry.js";
// Identity: base + subtype-specific
export {
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
  MetaReferenceIdentity,
} from "./core/identity/meta-identity.js";
// Index
export { MetaIndex } from "./core/index/meta-index.js";
export type { IdentityGeneration } from "./core/identity/meta-identity.js";
// FR-024 — projection identity pass-through derivation (computed local key;
// pure tree read, codegen-facing).
export {
  computedIdentityFields,
  identityOwnFields,
  identityEffectiveFields,
  resolveIdentityPassthrough,
} from "./core/identity/validate-identity-passthrough.js";
export type { IdentityPassthroughResolution } from "./core/identity/validate-identity-passthrough.js";
// Relationship
export { MetaRelationship } from "./core/relationship/meta-relationship.js";
// Cross-entity reference lookup
export { findReferenceBetween } from "./core/relationship/find-reference.js";
export type { ReferenceLookup } from "./core/relationship/find-reference.js";
// FR-017 — M:N junction FK derivation (hetero / directed-self-join / symmetric)
export { deriveM2MFields, M2MDerivationError } from "./core/relationship/derive-m2m-fields.js";
export type { M2MFields } from "./core/relationship/derive-m2m-fields.js";
// Validator: base + subtype-specific
export {
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
} from "./core/validator/meta-validator.js";

// Persistence node classes
export { MetaSource } from "./persistence/source/meta-source.js";
// Origin: base + subtype-specific
export {
  MetaOrigin,
  MetaPassthroughOrigin,
  MetaAggregateOrigin,
  MetaComputedOrigin,
  MetaFirstOrigin,
} from "./persistence/origin/meta-origin.js";
// Template: single class backs both subtypes (FR-004)
export { MetaTemplate } from "./template/meta-template.js";

// Presentation node classes
export { MetaView } from "./presentation/view/meta-view.js";
export { MetaLayout } from "./presentation/layout/meta-layout.js";

// AnyMeta — union of all concrete node types.
// Defined here (not in a shared concern folder) to avoid a circular import:
// each concrete class file imports MetaData from meta-data.ts; a shared
// any-meta.ts would need to import all of them, and they'd need to import it
// — creating a cycle. index.ts is the natural resolution point: it already
// re-exports every class.
export type AnyMeta =
  | MetaRoot
  | MetaObject
  | MetaField
  | MetaIdentity
  | MetaIndex
  | MetaRelationship
  | MetaValidator
  | MetaView
  | MetaAttr
  | MetaLayout
  | MetaSource
  | MetaOrigin;

// Registry
export { TypeId, TypeRegistry, childRuleMatches } from "./registry.js";
export type { AttrSchema, ChildRule, TypeDefinition } from "./registry.js";
export { registerCoreTypes, coreTypesProvider, coreProviders } from "./core-types.js";

// FR-033 — the constraint engine: additive merge + the contradiction validator.
export { mergeConstraints } from "./constraint-merge.js";
export type { EffectiveConstraints } from "./constraint-merge.js";
export { validateConstraints } from "./constraint-validate.js";

// Registry conformance manifest (SP-G) — the canonical logical-vocabulary serializer.
export { buildRegistryManifest, emitRegistryManifest, classifyPerTypeAttr, METAMODEL_VERSION } from "./registry-manifest.js";
// #357 — the AUTHORING-facing twin of buildRegistryManifest: every registered
// (type, subType) this port accepts, with the cross-port carve-outs MARKED rather
// than dropped. `meta types` reads this; the five-port byte gate reads the manifest.
export { buildVocabularyCatalog } from "./vocabulary-catalog.js";
export type { VocabularyCatalog, VocabularyType } from "./vocabulary-catalog.js";
export type { AttrClassification } from "./registry-manifest.js";
export { ExclusionReason } from "./registry-manifest-exclusions.js";

// FR-033 S3 — metamodel doc-gen: tiered, LLM-readable docs FOR THE METAMODEL
// (the type/subtype/attr vocabulary), generated from the strict registry.
// Distinct from `meta docs --model` (which documents a user's entities).
export {
  renderMetamodelDocs,
  buildMetamodelProvenance,
  coreProviderDescriptions,
  renderCoreMetamodelDocs,
} from "./metamodel-docs/index.js";
export type { MetamodelProvenance } from "./metamodel-docs/index.js";

// Registry coverage (SP-G Unit 5) — untested-vocabulary report (manifest vs
// fixture corpora). NODE-ONLY: registry-coverage.ts statically imports node:fs
// to scan the fixture corpora, so it must NOT be re-exported from this
// browser-facing barrel (it would drag node:fs into the root entry, breaking
// browser-safety.test.ts). It is a build-time tooling module — consumers (and
// its test) import it directly by path: `@metaobjectsdev/metadata/src/registry-coverage`.
export { dbProvider } from "./persistence/db/db-provider.js";
export { docProvider } from "./core/documentation/doc-provider.js";
export { promptProvider } from "./template/prompt-provider.js";
export { uiProvider } from "./presentation/ui/ui-provider.js";
export { uiWebProvider } from "./presentation/ui-web/ui-web-provider.js";
export { FIELD_ATTR_XML_TEXT } from "./template/template-constants.js";

// Type provider model
export { composeRegistry } from "./provider.js";
export type { MetaDataTypeProvider } from "./provider.js";

// DataType classification
export {
  DATA_TYPES,
  DATA_TYPE_BOOLEAN, DATA_TYPE_INT, DATA_TYPE_LONG, DATA_TYPE_DOUBLE,
  DATA_TYPE_STRING, DATA_TYPE_DATE, DATA_TYPE_OBJECT,
} from "./data-type.js";
export type { DataType, DataTypeAware } from "./data-type.js";

// Metadata-driven object serializer
export { objectToJson, jsonToObject } from "./object-serializer.js";
export type { ObjectSerializeOptions } from "./object-serializer.js";

// Data converter — convert a value to a known DataType (no inference)
export { convertToDataType, toAttrValue } from "./data-converter.js";

// Parser — shared core builder + per-format front-ends
export { buildTree } from "./parser-core.js";
export type { ParseOptions, ParseResult } from "./parser-core.js";
export { parseJson } from "./parser-json.js";

// Serializer
export { serializeJson, canonicalSerialize, inferAttrSubType } from "./serializer-json.js";
export type { SerializeOptions } from "./serializer-json.js";

// Super resolution helper (most resolution moved into parser; this is the lookup utility)
export { resolveSuperRef } from "./super-resolve.js";

// FR-032 (ADR-0032) — canonical reference expansion + FQN object matching.
export { expandRef, isRelativeRef, refMatchesObject, resolveObjectRef, didYouMeanHint, REF_BEARING_ATTR_NAMES } from "./naming-refs.js";

// Loader hierarchy
export { MetaDataLoader } from "./loader/meta-data-loader.js";
export type { LoadOptions, LoadResult, LoadingState, DirectoryFactoryOptions } from "./loader/meta-data-loader.js";
export { InMemoryStringSource } from "./loader/meta-data-source.js";
export type { MetaDataSource, MetaDataFormat } from "./loader/meta-data-source.js";

// Module-level loader shortcuts — delegate to MetaDataLoader.from* static
// factories. The shortcuts honor the ergonomic per-port pattern (TS and
// Python expose both class statics AND module-level functions); Java/C# stay
// class-only. Browser safety is preserved: the underlying sources are
// loaded via dynamic import inside MetaDataLoader.from*.
export {
  loadDirectory,
  loadUris,
  loadString,
} from "./loader/shortcuts.js";

// Errors
export { ParseError, MetaModelError, ERROR_CODES } from "./errors.js";
export type { ErrorCode } from "./errors.js";

// FR5a — loader error envelope + source-on-node (ADR-0009).
// Re-exported from the package root so consumers that catch + repackage
// ParseErrors (or narrow on `err.source.format === "json"`) can import the
// envelope types alongside the runtime discriminator.
export type {
  ErrorSource,
  LoaderError,
  LoaderWarning,
  NodeContext,
  Contributor,
} from "./source.js";
export { codeSource } from "./source.js";

// Attribute-schema validation pass (Phase A3)
export { validateAttrSchema } from "./attr-schema-validate.js";
export type { AttrSchemaValidationResult } from "./attr-schema-validate.js";

// Naming — hoisted from runtime-ts in v0.2.3 so multiple consumers (runtime-ts, migrate-ts, codegen-ts)
// share identical name resolution. See spec §4.1.
export {
  toSnakeCase, toKebabCase, pluralize,
  applyColumnNamingStrategy, DEFAULT_COLUMN_NAMING_STRATEGY,
  resolveTableName, resolveColumnName, resolveTableSchema,
  buildNameMap,
  stripPackage,
} from "./naming.js";
export type { EntityNameMap, ColumnNamingStrategy } from "./naming.js";

// Retired vocabulary: the map the loader reads to explain a retirement, and the raw-document
// rewriter `meta upgrade` drives from the SAME entries — so the error message and the fix
// cannot drift apart.
export {
  RETIRED_VOCABULARY,
  retiredAttr,
  retiredAttrValue,
  retiredSubType,
  retirementHint,
  retirementSuggestions,
} from "./retired-vocabulary.js";
export type { RetirementNote, RetiredEntry, VocabularyRewrite } from "./retired-vocabulary.js";
// Its sibling: pairs of LIVE attributes that may not sit on one node. Same two consumers,
// same reason — a retirement removes a name, a contradiction refuses a combination.
export {
  ATTR_CONTRADICTIONS,
  contradictionsFor,
  contradictionScopeMatches,
  contradictionHint,
} from "./attr-contradictions.js";
export type { AttrContradiction } from "./attr-contradictions.js";
export { rewriteDocument } from "./vocabulary-rewrite.js";
export type { RewriteResult, RewriteChange, RewriteRefusal, RewriteOpts } from "./vocabulary-rewrite.js";
