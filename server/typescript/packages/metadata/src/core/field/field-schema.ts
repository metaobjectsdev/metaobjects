// Field attribute schemas — attrs common to every field subtype, plus the
// @currency attr specific to field.currency. Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
  ATTR_SUBTYPE_PROPERTIES,
} from "../attr/attr-constants.js";
import { SORT_ORDER_VALUES } from "../query/query-constants.js";
import {
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  STORAGE_VALUES,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_READ_ONLY,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_CURRENCY_DEFAULT,
  FIELD_ATTR_AUTO_SET,
  AUTO_SET_VALUES,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_ENUM_ALIAS,
  FIELD_ATTR_ENUM_DOC,
  FIELD_ATTR_EXAMPLE,
  FIELD_ATTR_INSTRUCTION,
  FIELD_ATTR_COERCE_DEFAULT,
  FIELD_ATTR_NORMALIZE,
  NORMALIZE_MODES,
  NORMALIZE_DEFAULT,
} from "./field-constants.js";

/** Attrs common to every field subtype (codegen-ts column mapper + Project D filter/sort). */
export const commonFieldAttrs: AttrSchema[] = [
  {
    name: FIELD_ATTR_OBJECT_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Name (or FQN) of the target object an object-typed field nests — drives nested-object (de)serialization.",
  },
  {
    name: FIELD_ATTR_STORAGE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...STORAGE_VALUES],
    description:
      "Storage strategy for an object-typed field (set with @objectRef). " +
      "\"flattened\" expands the nested value into prefixed columns on the parent " +
      "table. \"jsonb\" stores the structured value in a single jsonb column " +
      "(supports isArray=true for arrays of values). \"subdocument\" is a hint for " +
      "document-store codegen targets and emits no Postgres column.",
  },
  {
    name: FIELD_ATTR_REQUIRED,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true, the field is NOT NULL. Equivalent to attaching a validator.required child.",
  },
  {
    name: FIELD_ATTR_READ_ONLY,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "FR-013: when true, the field is read-only — codegen emits no setter / " +
      "writable property, the persistence layer skips the column on INSERT/UPDATE, " +
      "and Zod/Pydantic/class-validator schemas mark it read-only on input variants. " +
      "The value is populated by the database (computed column, default expression, " +
      "trigger), by replication, or by another external owner.",
  },
  {
    name: FIELD_ATTR_UNIQUE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description: "When true, the field gets a column-level UNIQUE constraint.",
  },
  {
    name: FIELD_ATTR_DEFAULT,
    // @default is polymorphic: its value type follows the OWNING field's
    // subtype — a boolean field defaults to a boolean, an int field to a
    // number, a string field to a string. No single fixed valueType can
    // capture that, so valueType is intentionally omitted (declared-but-untyped).
    // The parser stores the raw JSON value type-preserved (no coercion).
    // Typed conversion happens at consumption time via MetaField.defaultValue(),
    // which applies the field's own DataType — Java parity with
    // MetaField.getDefaultValue() / DataConverter.toTypeSafe(getDataType(), o).
    required: false,
    description:
      "Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue().",
  },
  {
    name: FIELD_ATTR_MAX_LENGTH,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Maximum character length for string-typed fields (drives VARCHAR(n)).",
  },
  {
    name: FIELD_ATTR_PRECISION,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Total number of significant digits for decimal-typed fields.",
  },
  {
    name: FIELD_ATTR_SCALE,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Number of digits to the right of the decimal point for decimal-typed fields.",
  },
  {
    name: FIELD_ATTR_FILTERABLE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer).",
  },
  {
    name: FIELD_ATTR_SORTABLE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out.",
  },
  {
    name: FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...SORT_ORDER_VALUES],
    description: "Default sort direction applied when this field is the default sort field.",
  },
  {
    name: FIELD_ATTR_AUTO_SET,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...AUTO_SET_VALUES],
    description:
      "Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write.",
  },
  // FR-010 field-teaching attrs (any field): free-text shown in the generated
  // output-format prompt fragment. Never carried in comments.
  {
    name: FIELD_ATTR_EXAMPLE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "FR-010: an example value for this field, shown in the generated output-format prompt fragment.",
  },
  {
    name: FIELD_ATTR_INSTRUCTION,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "FR-010: a short instruction for this field, shown in the generated output-format prompt fragment.",
  },
];

/** The @currency attr — only on field.currency. */
export const currencyFieldAttr: AttrSchema = {
  name: FIELD_ATTR_CURRENCY,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  default: FIELD_ATTR_CURRENCY_DEFAULT,
  description:
    "ISO 4217 currency code for a currency-subtype field. Storage is integer minor units; defaults to 'USD' when omitted.",
};

/** The @values attr — only on field.enum. Required string array. */
export const enumFieldAttr: AttrSchema = {
  name: FIELD_ATTR_VALUES,
  valueType: ATTR_SUBTYPE_STRINGARRAY,
  required: true,
  description:
    "Member symbols of an enum-subtype field. Declaration order is significant; each is a legal identifier and its own stored string.",
};

/** The @enumAlias attr — only on field.enum. Map of off-vocabulary token → canonical
 *  member, feeding the FR-010 tolerant extract alias-fold (runtime aliases win on conflict). */
export const enumAliasAttr: AttrSchema = {
  name: FIELD_ATTR_ENUM_ALIAS,
  valueType: ATTR_SUBTYPE_PROPERTIES,
  required: false,
  description:
    "Map of alternate/off-vocabulary tokens to canonical enum members; feeds the FR-010 tolerant extract alias-fold.",
};

/** The @enumDoc attr — only on field.enum. Map of member → human-readable description,
 *  shown per-member in the FR-010 'guide'-style output-format prompt fragment. */
export const enumDocAttr: AttrSchema = {
  name: FIELD_ATTR_ENUM_DOC,
  valueType: ATTR_SUBTYPE_PROPERTIES,
  required: false,
  description:
    "Map of enum member to a human-readable description; shown per-member in the FR-010 'guide'-style prompt fragment.",
};

/** FR-011: the @coerceDefault attr — only on field.enum. String member symbol used as
 *  the extract fallback when an LLM sends a present-but-uncoercible value. Loader-validated
 *  to be one of the field's @values (ERR_BAD_ATTR_VALUE otherwise). */
export const coerceDefaultAttr: AttrSchema = {
  name: FIELD_ATTR_COERCE_DEFAULT,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Fallback enum member used by tolerant extract when a present value cannot be coerced; must be one of the field's @values.",
};

/** FR-011: the @normalize attr — on field.enum (per-field) and object.value (object default).
 *  Closed enum (none|collapse|strip); controls the ASCII normalization applied during tolerant
 *  enum extract. Resolved field → owning object.value → global default (strip). */
export const normalizeAttr: AttrSchema = {
  name: FIELD_ATTR_NORMALIZE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  default: NORMALIZE_DEFAULT,
  allowedValues: [...NORMALIZE_MODES],
  description:
    "ASCII normalization mode for tolerant enum extract (none|collapse|strip, default strip). " +
    "On field.enum it is per-field; on object.value it is the default for the object's enum fields.",
};
