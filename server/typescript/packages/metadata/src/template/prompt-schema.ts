// Prompt-domain attribute schemas — registered by promptProvider
// (prompt-provider.ts), the AI + serialization concern (FR-004/006/010/011).
// These field-teaching + tolerant-extract markers were re-homed out of the core
// field definition (spec/metamodel/field.json) and object.value (object.json) by
// FR-033 S1-field-A. The descriptions are copied VERBATIM from those sources so
// the composed registry manifest stays byte-identical — only the owning provider
// changes.

import type { AttrSchema } from "../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_PROPERTIES,
} from "../core/attr/attr-constants.js";
import {
  FIELD_ATTR_EXAMPLE,
  FIELD_ATTR_INSTRUCTION,
  FIELD_ATTR_ENUM_ALIAS,
  FIELD_ATTR_ENUM_DOC,
  FIELD_ATTR_COERCE_DEFAULT,
  FIELD_ATTR_NORMALIZE,
  NORMALIZE_MODES,
  NORMALIZE_DEFAULT,
} from "../core/field/field-constants.js";

// --- on EVERY field subtype (FR-010 field-teaching) ---

/** `@example` — example value shown in the generated output-format prompt fragment. */
export const exampleSchema: AttrSchema = {
  name: FIELD_ATTR_EXAMPLE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "FR-010: an example value for this field, shown in the generated output-format prompt fragment.",
};

/** `@instruction` — short instruction shown in the generated output-format prompt fragment. */
export const instructionSchema: AttrSchema = {
  name: FIELD_ATTR_INSTRUCTION,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "FR-010: a short instruction for this field, shown in the generated output-format prompt fragment.",
};

/** The two field-teaching markers added to every field subtype. */
export const promptFieldAttrs: readonly AttrSchema[] = [
  exampleSchema,
  instructionSchema,
];

// --- on field.enum ONLY (FR-010/FR-011 tolerant-extract overlays) ---

/** `@enumAlias` — off-vocabulary token → canonical member map (FR-010 alias-fold). */
export const enumAliasSchema: AttrSchema = {
  name: FIELD_ATTR_ENUM_ALIAS,
  valueType: ATTR_SUBTYPE_PROPERTIES,
  required: false,
  description:
    "Map of alternate/off-vocabulary tokens to canonical enum members; feeds the FR-010 tolerant extract alias-fold.",
};

/** `@enumDoc` — per-member human-readable description map (FR-010 'guide' fragment). */
export const enumDocSchema: AttrSchema = {
  name: FIELD_ATTR_ENUM_DOC,
  valueType: ATTR_SUBTYPE_PROPERTIES,
  required: false,
  description:
    "Map of enum member to a human-readable description; shown per-member in the FR-010 'guide'-style prompt fragment.",
};

/** `@coerceDefault` — uncoercible-value fallback member (FR-011). */
export const coerceDefaultSchema: AttrSchema = {
  name: FIELD_ATTR_COERCE_DEFAULT,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Fallback enum member used by tolerant extract when a present value cannot be coerced; must be one of the field's @values.",
};

/** `@normalize` — ASCII normalization mode for tolerant enum extract (FR-011).
 *  On field.enum it is per-field; on object.value it is the default for the
 *  object's enum fields. The same AttrSchema is reused for both placements. */
export const normalizeSchema: AttrSchema = {
  name: FIELD_ATTR_NORMALIZE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  default: NORMALIZE_DEFAULT,
  allowedValues: [...NORMALIZE_MODES],
  description:
    "ASCII normalization mode for tolerant enum extract (none|collapse|strip, default strip). On field.enum it is per-field; on object.value it is the default for the object's enum fields.",
};

/** The four extract-overlay attrs added to field.enum only. */
export const promptEnumAttrs: readonly AttrSchema[] = [
  enumAliasSchema,
  enumDocSchema,
  coerceDefaultSchema,
  normalizeSchema,
];
