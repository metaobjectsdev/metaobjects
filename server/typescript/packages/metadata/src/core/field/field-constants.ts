// Field concern constants — subtypes, field-level attr keys, and currency attrs.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Field subtypes (14)
// ---------------------------------------------------------------------------

export const FIELD_SUBTYPE_STRING = "string";
export const FIELD_SUBTYPE_INT = "int";
export const FIELD_SUBTYPE_LONG = "long";
export const FIELD_SUBTYPE_DOUBLE = "double";
export const FIELD_SUBTYPE_FLOAT = "float";
export const FIELD_SUBTYPE_DECIMAL = "decimal";
export const FIELD_SUBTYPE_BOOLEAN = "boolean";
export const FIELD_SUBTYPE_DATE = "date";
export const FIELD_SUBTYPE_TIME = "time";
export const FIELD_SUBTYPE_TIMESTAMP = "timestamp";
export const FIELD_SUBTYPE_OBJECT = "object";
export const FIELD_SUBTYPE_MAP = "map";
export const FIELD_SUBTYPE_CURRENCY = "currency";
export const FIELD_SUBTYPE_ENUM = "enum";
/** R6 Plan 2a: logical UUID identity scalar. Bare scalar (no required attrs, no
 *  loader value-validation) — like field.long; native binding is forced to TS
 *  `string` (TS has no native UUID type). DB column is Postgres-native `uuid`. */
export const FIELD_SUBTYPE_UUID = "uuid";
/** ADR-0036/0037 Wave 3: a URI/URL string. Concept with a native type + behavior
 *  → a subtype (not a @stringFormat). TS binds to `string` (no native URI type,
 *  same as uuid); other ports bind to native URI (java.net.URI / System.Uri /
 *  urllib). DB column is `text`. Codegen emits URL validation (Zod .url()). */
export const FIELD_SUBTYPE_URI = "uri";
/** ADR-0036/0037 Wave 3: an IP-address string (v4 or v6). Concept with a native
 *  type + behavior → a subtype. TS binds to `string`; other ports bind to native
 *  IP (InetAddress / IPAddress / ipaddress). DB column is Postgres-native `inet`.
 *  Codegen emits IP validation accepting v4+v6 (Zod .ip()). */
export const FIELD_SUBTYPE_INET = "inet";

export const FIELD_SUBTYPES = [
  SUBTYPE_BASE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_INET,
] as const;
export type FieldSubType = (typeof FIELD_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Field-level attrs (used by codegen-ts column mapper)
// ---------------------------------------------------------------------------

export const FIELD_ATTR_REQUIRED = "required";
export const FIELD_ATTR_UNIQUE = "unique";

/** FR-013: when true, the field is read-only from the application's perspective.
 *  Codegen emits no setter; persistence skips the column on INSERT/UPDATE; Zod
 *  create/update variants omit the field. Default false (writable). See ADR-0013
 *  layer split — this is logical (no DB-introspection round-trip). */
export const FIELD_ATTR_READ_ONLY = "readOnly";
export const FIELD_ATTR_DEFAULT = "default";
export const FIELD_ATTR_MAX_LENGTH = "maxLength";

/** ADR-0036/0037 Wave 3: a closed validation format for a plain `field.string`
 *  that has no native type or behavior of its own. Closed set: email | hostname.
 *  The field stays a plain string; codegen emits the matching validator. Named
 *  @stringFormat (NOT @format) to avoid colliding with the existing template.*
 *  @format (output/serialization format). Only on field.string. */
export const FIELD_ATTR_STRING_FORMAT = "stringFormat";

/** @stringFormat: a plain string validated as an email address. Codegen emits
 *  Zod z.string().email() (TS); other ports emit the idiomatic email validator. */
export const STRING_FORMAT_EMAIL = "email";

/** @stringFormat: a plain string validated as a DNS hostname. Codegen emits a
 *  hostname check (the canonical matcher lives in codegen, not author regex). */
export const STRING_FORMAT_HOSTNAME = "hostname";

/** Closed value-set for @stringFormat (byte-gated via allowedValues in the registry). */
export const STRING_FORMAT_VALUES = [
  STRING_FORMAT_EMAIL,
  STRING_FORMAT_HOSTNAME,
] as const;
export type StringFormatValue = (typeof STRING_FORMAT_VALUES)[number];

/** #234: opt a field.uri / field.inet OUT of strict well-formedness enforcement. Optional
 *  boolean; default (absent/false) is strict (an absolute-scheme URI / an IPv4-or-IPv6 literal).
 *  When true, codegen binds a PLAIN STRING (no URL/IP validator, no native URI/InetAddress type)
 *  and field.inet uses a text column (not the native inet type), so a not-strictly-valid value
 *  (an LLM-emitted citation URL, a hostname) round-trips unchanged. Only on field.uri / field.inet. */
export const FIELD_ATTR_LENIENT = "lenient";
export const FIELD_ATTR_PRECISION = "precision";
export const FIELD_ATTR_SCALE = "scale";
export const FIELD_ATTR_FILTERABLE = "filterable";
export const FIELD_ATTR_SORTABLE = "sortable";
export const FIELD_ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder";

/** When true, the field is omitted from generated forms. */
export const FIELD_ATTR_FORM_EXCLUDE = "formExclude";

/** Auto-set semantics on a timestamp field. Values: "onCreate" | "onUpdate". */
export const FIELD_ATTR_AUTO_SET = "autoSet";

/** Name (or FQN) of the target object an object-typed field nests. Same wire
 *  spelling as the relationship `@objectRef` — Java's single ATTR_OBJECT_REF. */
export const FIELD_ATTR_OBJECT_REF = "objectRef";

/** Scalar value subtype of a `field.map` (open-keyed map). Mutually exclusive
 *  with @objectRef (which sets a value-object value type). Keys are always strings. */
export const FIELD_ATTR_VALUE_TYPE = "valueType";

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

// ---------------------------------------------------------------------------
// Enum attrs (on enum-subtype fields)
// ---------------------------------------------------------------------------

/** Member symbols of an enum-subtype field. Required, string array. */
export const FIELD_ATTR_VALUES = "values";

/**
 * Optional per-member explicit integer value ({memberSymbol: int}) switching
 * this enum field's DB persistence from string+CHECK to integer+CHECK. Keys
 * must exactly match @values; values must be unique integers. The generated
 * native type and wire format are UNCHANGED in every language — this is a
 * persistence-layer-only concern (docs/superpowers/specs/2026-07-23-int-backed-
 * enum-values-design.md).
 */
export const FIELD_ATTR_INT_VALUE_MAP = "intValueMap";

/**
 * Pattern every enum member must satisfy: a legal identifier in all target
 * languages (TS union member, Java/C#/Python enum member). Ensures symbol ==
 * stored string with no name↔value divergence.
 */
export const ENUM_MEMBER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** FR-019: marks a named-type declaration (an abstract package-level field.enum)
 *  as externally PROVIDED — codegen references the type instead of materializing
 *  it. Optional boolean, default false; meaningful only on an abstract (declaration)
 *  field.enum (a concrete consuming field does not carry it). Per ADR-0026, no
 *  per-port namespace lives in metadata — the reference target is codegen config. */
export const FIELD_ATTR_PROVIDED = "provided";

/** FR-010: map of off-vocabulary token → canonical enum member, feeding the
 *  tolerant extract alias-fold. `properties`-shaped; only on field.enum. */
export const FIELD_ATTR_ENUM_ALIAS = "enumAlias";

/** FR-010: map of enum member → human-readable description, shown per-member in
 *  the 'guide'-style output-format prompt fragment. `properties`-shaped; only on field.enum. */
export const FIELD_ATTR_ENUM_DOC = "enumDoc";

// ---------------------------------------------------------------------------
// FR-010 field-teaching attrs (on any field; drive the output-format prompt)
// ---------------------------------------------------------------------------

/** FR-010: an example value for this field, shown in the generated prompt fragment. */
export const FIELD_ATTR_EXAMPLE = "example";

/** FR-010: a short instruction for this field, shown in the generated prompt fragment. */
export const FIELD_ATTR_INSTRUCTION = "instruction";

// ---------------------------------------------------------------------------
// FR-011 extract-hardening attrs (enum tolerant extract)
// ---------------------------------------------------------------------------

/** FR-011: fallback enum member used when an LLM sends a present-but-uncoercible
 *  value. Must be one of the field's @values (loader-validated). On field.enum only. */
export const FIELD_ATTR_COERCE_DEFAULT = "coerceDefault";

/** FR-011: ASCII normalization mode for tolerant enum extract. Closed enum
 *  (none|collapse|strip). On field.enum (per-field) and object.value (default
 *  for its enum fields). Resolved field → object → global NORMALIZE_DEFAULT. */
export const FIELD_ATTR_NORMALIZE = "normalize";

/** FR-011: the three ASCII normalization modes (closed set).
 *  - none     : exact match only.
 *  - collapse : ASCII case-fold + trim + collapse runs of [\s_-]+ to one _.
 *  - strip    : ASCII case-fold + strip everything except [A-Z0-9] (most forgiving). */
export const NORMALIZE_MODES = ["none", "collapse", "strip"] as const;
export type NormalizeMode = (typeof NORMALIZE_MODES)[number];

/** FR-011: global normalization default when neither the field nor its owning
 *  object.value declares @normalize. */
export const NORMALIZE_DEFAULT: NormalizeMode = "strip";
