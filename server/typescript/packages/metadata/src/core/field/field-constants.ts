// Field concern constants — subtypes, field-level attr keys, and currency attrs.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Field subtypes (15)
// ---------------------------------------------------------------------------

export const FIELD_SUBTYPE_STRING = "string";
export const FIELD_SUBTYPE_INT = "int";
export const FIELD_SUBTYPE_SHORT = "short";
export const FIELD_SUBTYPE_BYTE = "byte";
export const FIELD_SUBTYPE_LONG = "long";
export const FIELD_SUBTYPE_DOUBLE = "double";
export const FIELD_SUBTYPE_FLOAT = "float";
export const FIELD_SUBTYPE_DECIMAL = "decimal";
export const FIELD_SUBTYPE_BOOLEAN = "boolean";
export const FIELD_SUBTYPE_DATE = "date";
export const FIELD_SUBTYPE_TIME = "time";
export const FIELD_SUBTYPE_TIMESTAMP = "timestamp";
export const FIELD_SUBTYPE_OBJECT = "object";
export const FIELD_SUBTYPE_CLASS = "class";
export const FIELD_SUBTYPE_CURRENCY = "currency";

export const FIELD_SUBTYPES = [
  SUBTYPE_BASE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_CLASS,
  FIELD_SUBTYPE_CURRENCY,
] as const;
export type FieldSubType = (typeof FIELD_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Field-level attrs (used by codegen-ts column mapper)
// ---------------------------------------------------------------------------

export const FIELD_ATTR_REQUIRED = "required";
export const FIELD_ATTR_UNIQUE = "unique";
export const FIELD_ATTR_DEFAULT = "default";
export const FIELD_ATTR_MAX_LENGTH = "maxLength";
export const FIELD_ATTR_PRECISION = "precision";
export const FIELD_ATTR_SCALE = "scale";
export const FIELD_ATTR_FILTERABLE = "filterable";
export const FIELD_ATTR_SORTABLE = "sortable";
export const FIELD_ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder";

/** Auto-set semantics on a timestamp field. Values: "onCreate" | "onUpdate". */
export const FIELD_ATTR_AUTO_SET = "autoSet";

/** Name (or FQN) of the target object an object-typed field nests. Same wire
 *  spelling as the relationship `@objectRef` — Java's single ATTR_OBJECT_REF. */
export const FIELD_ATTR_OBJECT_REF = "objectRef";

/** Storage strategy for an object-typed field. Meaningful only when @objectRef is set.
 *  Cross-language metamodel attr — every port must accept and round-trip it. */
export const FIELD_ATTR_STORAGE = "storage";

/** @storage "flattened" — nested object's columns expand into the parent table,
 *  each prefixed by the parent field's DB name (EF OwnsOne pattern). Requires
 *  the parent field.object to have isArray=false; arrays-of-values must use jsonb. */
export const STORAGE_FLATTENED = "flattened";

/** @storage "jsonb" — the nested value (or array of values when isArray=true) lives
 *  in a single jsonb column. The structure is typed by metadata; storage is opaque. */
export const STORAGE_JSONB = "jsonb";

/** @storage "subdocument" — document-store-native nested document. No Postgres
 *  column is emitted for this; codegen targets like Mongo render it inline. */
export const STORAGE_SUBDOCUMENT = "subdocument";

export const STORAGE_VALUES = [
  STORAGE_FLATTENED,
  STORAGE_JSONB,
  STORAGE_SUBDOCUMENT,
] as const;
export type StorageValue = (typeof STORAGE_VALUES)[number];

export const AUTO_SET_ON_CREATE = "onCreate";
export const AUTO_SET_ON_UPDATE = "onUpdate";

export const AUTO_SET_VALUES = [AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE] as const;
export type AutoSetValue = (typeof AUTO_SET_VALUES)[number];

// ---------------------------------------------------------------------------
// Currency attrs (on currency-subtype fields)
// ---------------------------------------------------------------------------

/** ISO 4217 currency code on a currency-subtype field. Defaults to "USD" when omitted. */
export const FIELD_ATTR_CURRENCY = "currency";
/** Default ISO 4217 currency code when @currency is omitted on a currency field. */
export const FIELD_ATTR_CURRENCY_DEFAULT = "USD";
