// Public API surface for @metaobjects/metadata v0.2.0
//
// Architecture: one typed tree of concrete node classes under src/meta/,
// plus open type registry + JSON parser/serializer + Loader orchestration.
// Java-pattern aligned.
//
// See docs/strategy/2026-05-09-northstar-v4.md and
// docs/specs/2026-05-09-v0.2-ts-pillar.md for context.

// AnyMeta imports — kept here (not in src/meta/) to avoid circular imports.
// See the AnyMeta comment below for full explanation.
import type { MetaRoot } from "./meta/meta-root.js";
import type { MetaObject } from "./meta/meta-object.js";
import type { MetaField } from "./meta/meta-field.js";
import type { MetaIdentity } from "./meta/meta-identity.js";
import type { MetaRelationship } from "./meta/meta-relationship.js";
import type { MetaValidator } from "./meta/meta-validator.js";
import type { MetaView } from "./meta/meta-view.js";
import type { MetaAttr } from "./meta/meta-attr.js";
import type { MetaLayout } from "./meta/meta-layout.js";
import type { MetaSource } from "./meta/meta-source.js";
import type { MetaOrigin } from "./meta/meta-origin.js";

// Constants — type names, subtype names, reserved keys, separators
export * from "./constants.js";

// MetaData node base — abstract class; also exports AttrValue
export { MetaData } from "./meta/meta-data.js";
export type { AttrValue } from "./meta/meta-data.js";

// Concrete node classes
export { MetaRoot } from "./meta/meta-root.js";
export { MetaObject } from "./meta/meta-object.js";
export { MetaField } from "./meta/meta-field.js";
// Identity: base + subtype-specific
export {
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
} from "./meta/meta-identity.js";
export type { IdentityGeneration } from "./meta/meta-identity.js";
// Relationship
export { MetaRelationship } from "./meta/meta-relationship.js";
// Validator: base + subtype-specific
export {
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
} from "./meta/meta-validator.js";
// Other node classes
export { MetaView } from "./meta/meta-view.js";
export { MetaAttr } from "./meta/meta-attr.js";
export { MetaLayout } from "./meta/meta-layout.js";
export { MetaSource } from "./meta/meta-source.js";
// Origin: base + subtype-specific
export {
  MetaOrigin,
  MetaPassthroughOrigin,
  MetaAggregateOrigin,
} from "./meta/meta-origin.js";

// AnyMeta — union of all concrete node types.
// Defined here (not in src/meta/) to avoid a circular import: each concrete
// class file imports MetaData from meta-data.ts; a shared any-meta.ts would
// need to import all of them, and they'd need to import it — creating a
// cycle. index.ts is the natural resolution point: it already re-exports
// every class.
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
export { dbProvider } from "./db/db-provider.js";

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
  resolveTableName, resolveColumnName,
  buildNameMap,
} from "./naming.js";
export type { EntityNameMap } from "./naming.js";
