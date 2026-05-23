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
export * from "./core/attr/attr-constants.js";
export * from "./core/validator/validator-constants.js";
export * from "./core/identity/identity-constants.js";
export * from "./core/relationship/relationship-constants.js";
export * from "./core/query/query-constants.js";
export * from "./persistence/source/source-constants.js";
export * from "./persistence/origin/origin-constants.js";
export * from "./prompt/prompt-constants.js";
export * from "./persistence/db/db-constants.js";
export * from "./presentation/view/view-constants.js";
export * from "./presentation/layout/layout-constants.js";

// MetaData node base — abstract class; also exports AttrValue
export { MetaData } from "./shared/meta-data.js";
export type { AttrValue } from "./shared/meta-data.js";

// Shared node classes
export { MetaRoot } from "./shared/meta-root.js";

// Core node classes
export { MetaObject } from "./core/object/meta-object.js";
export { MetaField } from "./core/field/meta-field.js";
export { MetaAttr } from "./core/attr/meta-attr.js";
// Identity: base + subtype-specific
export {
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
  MetaReferenceIdentity,
} from "./core/identity/meta-identity.js";
export type { IdentityGeneration } from "./core/identity/meta-identity.js";
// Relationship
export { MetaRelationship } from "./core/relationship/meta-relationship.js";
// Cross-entity reference lookup
export { findReferenceBetween } from "./core/relationship/find-reference.js";
export type { ReferenceLookup } from "./core/relationship/find-reference.js";
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
} from "./persistence/origin/meta-origin.js";
// Prompt: single class backs all subtypes (FR-004)
export { MetaPrompt } from "./prompt/meta-prompt.js";

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
export { dbProvider } from "./persistence/db/db-provider.js";

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

// Loader hierarchy
export { MetaDataLoader } from "./loader/meta-data-loader.js";
export type { LoadOptions, LoadResult, LoadingState } from "./loader/meta-data-loader.js";
export { InMemorySource } from "./loader/meta-data-source.js";
export type { MetaDataSource, MetaDataFormat } from "./loader/meta-data-source.js";

// Errors
export { ParseError, MetaModelError, ERROR_CODES } from "./errors.js";
export type { ErrorCode } from "./errors.js";

// Attribute-schema validation pass (Phase A3)
export { validateAttrSchema } from "./attr-schema-validate.js";
export type { AttrSchemaValidationResult } from "./attr-schema-validate.js";

// Naming — hoisted from runtime-ts in v0.2.3 so multiple consumers (runtime-ts, migrate-ts, codegen-ts)
// share identical name resolution. See spec §4.1.
export {
  toSnakeCase, pluralize,
  resolveTableName, resolveColumnName, resolveTableSchema,
  buildNameMap,
  stripPackage,
} from "./naming.js";
export type { EntityNameMap } from "./naming.js";
