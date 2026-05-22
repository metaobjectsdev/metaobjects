// Attribute schemas — Phase A2.
//
// Per (type, subType) attr inventories consumed by registerCoreTypes()
// (core-types.ts) and the A3 validation pass (attr-schema-validate.ts).
//
// Sourced from constants.ts (attr names), the src/meta/* node accessors (which
// attrs each subtype reads), the conformance fixtures (real usage + `required`
// determination), and CLAUDE.md (descriptions, defaults, allowedValues).
//
// `required: true` is reserved for attrs that EVERY conformance fixture with
// that subtype supplies AND that are semantically mandatory. Everything else
// is `required: false` (Phase A3 validation depends on this being conservative).
//
// This module is pure declarative data — no logic, no registration. It is
// split out of core-types.ts purely so the registration logic stays readable.

import type { AttrSchema } from "./registry.js";
import {
  SUBTYPE_BASE,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  // attr-subtype value-type constants
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
  ATTR_SUBTYPE_FILTER,
  // attr-name constants
  FIELD_ATTR_OBJECT_REF,
  FIELD_OBJECT_ATTR_STORAGE,
  STORAGE_VALUES,
  FIELD_ATTR_REQUIRED,
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
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_REFERENCE_ATTR_ENFORCE,
  GENERATION_VALUES,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_JOIN_ENTITY,
  RELATIONSHIP_ATTR_JOIN_FIELDS,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
  AUTO_SET_VALUES,
  SORT_ORDER_VALUES,
  OBJECT_JAVA_RUNTIME_VALUES,
  OBJECT_ATTR_JAVA_RUNTIME,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  AGGREGATE_FUNCTIONS,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  VIEW_CURRENCY_ATTR_LOCALE,
  VIEW_CURRENCY_ATTR_LOCALE_DEFAULT,
} from "./constants.js";

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
    name: FIELD_OBJECT_ATTR_STORAGE,
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

/** Attrs on view.currency. */
export const currencyViewAttrs: AttrSchema[] = [
  {
    name: VIEW_CURRENCY_ATTR_LOCALE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    default: VIEW_CURRENCY_ATTR_LOCALE_DEFAULT,
    description:
      "BCP 47 locale code controlling currency display formatting. Defaults to 'en-US' when omitted.",
  },
];

/** Attrs common to every object subtype. */
export const objectAttrs: AttrSchema[] = [
  {
    name: OBJECT_ATTR_JAVA_RUNTIME,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...OBJECT_JAVA_RUNTIME_VALUES],
    description:
      "Java runtime materialization strategy for this object (pojo / map / proxy). Ignored by non-Java implementations.",
  },
];

/** Attrs common to every relationship subtype. */
export const relationshipAttrs: AttrSchema[] = [
  {
    name: RELATIONSHIP_ATTR_CARDINALITY,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    // No allowedValues: @cardinality is an open string at the metamodel level
    // (MetaRelationship.cardinality returns `string | undefined`). The Java
    // canonical fixtures use composite forms such as "many-to-one"; the
    // CARDINALITY_VALUES ("one"/"many") constant is a TS codegen convenience,
    // NOT a closed metamodel enum. A3 must not reject the Java-canonical values.
    description:
      "Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one').",
  },
  {
    name: RELATIONSHIP_ATTR_OBJECT_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car').",
  },
  {
    name: RELATIONSHIP_ATTR_JOIN_ENTITY,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Join-table entity name for N:M relationships.",
  },
  {
    name: RELATIONSHIP_ATTR_JOIN_FIELDS,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "Join-table column names for N:M relationships.",
  },
];

/** Attrs on identity.primary / identity.secondary — @fields is required. */
export const identityFieldsAttr: AttrSchema = {
  name: IDENTITY_ATTR_FIELDS,
  valueType: ATTR_SUBTYPE_STRINGARRAY,
  required: true,
  description:
    "The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite.",
};

const primaryIdentityAttrs: AttrSchema[] = [
  { ...identityFieldsAttr },
  {
    name: IDENTITY_ATTR_GENERATION,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...GENERATION_VALUES],
    description:
      "Primary-key value generation strategy: 'increment' (auto-increment), 'uuid', or 'assigned' (caller-supplied).",
  },
];

const secondaryIdentityAttrs: AttrSchema[] = [
  { ...identityFieldsAttr },
  {
    name: IDENTITY_ATTR_UNIQUE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true (default), the secondary identity is a UNIQUE index; false makes it a plain (non-unique) index.",
  },
];

const referenceIdentityAttrs: AttrSchema[] = [
  { ...identityFieldsAttr },
  {
    name: IDENTITY_REFERENCE_ATTR_REFERENCES,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Target of the reference. Bare entity name (e.g. 'Program') resolves to that entity's primary identity. " +
      "Dotted forms ('Program.id' or 'Program.fieldA,fieldB') target an explicit field set on the entity.",
  },
  {
    name: IDENTITY_REFERENCE_ATTR_ENFORCE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true (default), the backend physically enforces the reference (SQL FK constraint, " +
      "document validation rule, graph edge guarantee). Set false to declare a logical reference " +
      "for navigation/typing/codegen only — the value may dangle at the backend level.",
  },
];

/** Attrs on origin.passthrough — @from is required. */
const passthroughOriginAttrs: AttrSchema[] = [
  {
    name: ORIGIN_PASSTHROUGH_ATTR_FROM,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Dotted Entity.field reference identifying the source value this projection field passes through (e.g. 'Program.title').",
  },
  {
    name: ORIGIN_PASSTHROUGH_ATTR_VIA,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Optional dotted relationship path used to reach the source entity (e.g. 'Program.weeks').",
  },
];

/** Attrs on origin.aggregate — @agg, @of, @via all required. */
const aggregateOriginAttrs: AttrSchema[] = [
  {
    name: ORIGIN_AGGREGATE_ATTR_AGG,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    allowedValues: [...AGGREGATE_FUNCTIONS],
    description: "Aggregate function applied over the relationship path: count, sum, avg, min, or max.",
  },
  {
    name: ORIGIN_AGGREGATE_ATTR_OF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes').",
  },
  {
    name: ORIGIN_AGGREGATE_ATTR_VIA,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts').",
  },
];

/** Attrs on layout.dataGrid. */
export const dataGridLayoutAttrs: AttrSchema[] = [
  {
    name: LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Number of rows per page in the generated data grid.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Field name the grid is sorted by on initial render. Must reference an actual field on the entity.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...SORT_ORDER_VALUES],
    description: "Initial sort direction for the default sort field: 'asc' or 'desc'.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_FILTERABLE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description: "When true, the generated grid exposes column filtering UI.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_FILTER,
    valueType: ATTR_SUBTYPE_FILTER,
    required: false,
    description: "Structured preset filter object applied to the grid at the metadata level. Desugared to canonical { field: { op: value } } form at parse time.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_COLUMNS,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "Flat ordered list of field names to display as grid columns.",
  },
];

/** @min / @max shared by length, numeric, array, and the base validator. */
const minMaxValidatorAttrs: AttrSchema[] = [
  {
    name: VALIDATOR_ATTR_MIN,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Minimum allowed value (length, numeric value, or array element count depending on the validator subtype).",
  },
  {
    name: VALIDATOR_ATTR_MAX,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Maximum allowed value (length, numeric value, or array element count depending on the validator subtype).",
  },
];

/** Attrs per origin subtype. base has none; passthrough and aggregate carry their respective attrs. */
export const ORIGIN_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, []],
  [ORIGIN_SUBTYPE_PASSTHROUGH, [...passthroughOriginAttrs]],
  [ORIGIN_SUBTYPE_AGGREGATE, [...aggregateOriginAttrs]],
]);

/** Attrs per identity subtype. primary adds @generation; secondary adds @unique. */
export const IDENTITY_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [IDENTITY_SUBTYPE_PRIMARY, [...primaryIdentityAttrs]],
  [IDENTITY_SUBTYPE_SECONDARY, [...secondaryIdentityAttrs]],
  [IDENTITY_SUBTYPE_REFERENCE, [...referenceIdentityAttrs]],
]);

/** Attrs per validator subtype. Required uses none; regex adds @pattern. */
export const VALIDATOR_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, [...minMaxValidatorAttrs]],
  [VALIDATOR_SUBTYPE_REQUIRED, []],
  [VALIDATOR_SUBTYPE_LENGTH, [...minMaxValidatorAttrs]],
  [VALIDATOR_SUBTYPE_REGEX, [
    ...minMaxValidatorAttrs,
    {
      name: VALIDATOR_ATTR_PATTERN,
      valueType: ATTR_SUBTYPE_STRING,
      required: false,
      description: "Regular expression the value must match.",
    },
  ]],
  [VALIDATOR_SUBTYPE_NUMERIC, [...minMaxValidatorAttrs]],
  [VALIDATOR_SUBTYPE_ARRAY, [...minMaxValidatorAttrs]],
]);
