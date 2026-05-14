// Public API surface for @metaobjects/metadata v0.2.0
//
// Architecture: runtime model (MetaModel) + open type registry + JSON
// parser/serializer + Loader orchestration. Java-pattern aligned.
//
// See docs/strategy/2026-05-09-northstar-v4.md and
// docs/specs/2026-05-09-v0.2-ts-pillar.md for context.

// Constants — type names, subtype names, reserved keys, separators
export * from "./constants.js";

// Model (flat data layer)
export { MetaModel } from "./model.js";
export type { AttrValue } from "./model.js";

// Typed views (reflection layer over MetaModel — see views.ts)
export {
  MetaData,
  MetaRoot,
  MetaObject,
  MetaField,
  // Identity: base + subtype-specific
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
  // Relationship
  MetaRelationship,
  // Validator: base + subtype-specific
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
  // Other
  MetaView,
  MetaAttr,
  MetaLayout,
  MetaSource,
  MetaOrigin,
  // Factory
  metaOf,
} from "./views.js";
export type { AnyMeta, IdentityGeneration } from "./views.js";

// Registry
export { TypeId, TypeRegistry, childRuleMatches } from "./registry.js";
export type { ChildRule, TypeDefinition } from "./registry.js";
export { registerCoreTypes } from "./core-types.js";

// Value coercion
export { coerceAttrValue } from "./value-coerce.js";
export type { CoercedValue, InferredType } from "./value-coerce.js";

// Parser
export { parseJson } from "./parser-json.js";
export type { ParseOptions, ParseResult } from "./parser-json.js";

// Serializer
export { serializeJson, canonicalSerialize, inferAttrSubType } from "./serializer-json.js";
export type { SerializeOptions } from "./serializer-json.js";

// Super resolution helper (most resolution moved into parser; this is the lookup utility)
export { resolveSuperRef } from "./super-resolve.js";

// Loader
export { Loader } from "./loader.js";
export type { LoadOptions, LoadResult, LoadingState } from "./loader.js";

// Errors
export { ParseError } from "./errors.js";

// Naming — hoisted from runtime-ts in v0.2.3 so multiple consumers (runtime-ts, migrate-ts, codegen-ts)
// share identical name resolution. See spec §4.1.
export {
  toSnakeCase, pluralize,
  resolveTableName, resolveColumnName,
  buildNameMap,
} from "./naming.js";
export type { EntityNameMap } from "./naming.js";
