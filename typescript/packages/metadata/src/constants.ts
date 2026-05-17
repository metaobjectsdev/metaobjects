// ---------------------------------------------------------------------------
// Base type names (the 8 registered base types — Java metaobjects-core vocabulary)
// ---------------------------------------------------------------------------

export const TYPE_METADATA = "metadata";
export const TYPE_OBJECT = "object";
export const TYPE_FIELD = "field";
export const TYPE_ATTR = "attr";
export const TYPE_VALIDATOR = "validator";
export const TYPE_VIEW = "view";
export const TYPE_IDENTITY = "identity";
export const TYPE_RELATIONSHIP = "relationship";
export const TYPE_LAYOUT = "layout";
export const TYPE_SOURCE = "source";
export const TYPE_ORIGIN = "origin";

export const BASE_TYPES = [
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_ATTR,
  TYPE_VALIDATOR,
  TYPE_VIEW,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_LAYOUT,
  TYPE_SOURCE,
  TYPE_ORIGIN,
] as const;
export type BaseType = (typeof BASE_TYPES)[number];

// ---------------------------------------------------------------------------
// Universal subtype
// ---------------------------------------------------------------------------

export const SUBTYPE_BASE = "base";

// ---------------------------------------------------------------------------
// Metadata subtypes (1)
// ---------------------------------------------------------------------------

/**
 * The metadata document root subtype. The root node is `metadata.root` in the
 * canonical format. (Distinct from the universal SUBTYPE_BASE — the redesigned
 * format spec confirms the root subtype is `root`, not `base`.)
 */
export const SUBTYPE_ROOT = "root";

export const METADATA_SUBTYPES = [SUBTYPE_ROOT] as const;
export type MetadataSubType = (typeof METADATA_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Object subtypes (cross-language, conceptual)
// ---------------------------------------------------------------------------
//
//   - base   : abstract template (no runtime semantics)
//   - entity : persistent record (typically has @primary identity)
//   - value  : value-object (no identity; equality by content)
//
// Java runtime strategies (pojo/map/proxy) live on @javaRuntime, not subType.

export const OBJECT_SUBTYPE_ENTITY = "entity";
export const OBJECT_SUBTYPE_VALUE = "value";

export const OBJECT_SUBTYPES = [
  SUBTYPE_BASE,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
] as const;
export type ObjectSubType = (typeof OBJECT_SUBTYPES)[number];

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
// Attr subtypes (9)
// ---------------------------------------------------------------------------

export const ATTR_SUBTYPE_STRING = "string";
export const ATTR_SUBTYPE_INT = "int";
export const ATTR_SUBTYPE_LONG = "long";
export const ATTR_SUBTYPE_DOUBLE = "double";
export const ATTR_SUBTYPE_BOOLEAN = "boolean";
export const ATTR_SUBTYPE_CLASS = "class";
export const ATTR_SUBTYPE_PROPERTIES = "properties";
export const ATTR_SUBTYPE_STRINGARRAY = "stringarray";

export const ATTR_SUBTYPES = [
  SUBTYPE_BASE,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_PROPERTIES,
  ATTR_SUBTYPE_STRINGARRAY,
] as const;
export type AttrSubType = (typeof ATTR_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Validator subtypes (6)
// ---------------------------------------------------------------------------

export const VALIDATOR_SUBTYPE_REQUIRED = "required";
export const VALIDATOR_SUBTYPE_LENGTH = "length";
export const VALIDATOR_SUBTYPE_REGEX = "regex";
export const VALIDATOR_SUBTYPE_NUMERIC = "numeric";
export const VALIDATOR_SUBTYPE_ARRAY = "array";

export const VALIDATOR_SUBTYPES = [
  SUBTYPE_BASE,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
] as const;
export type ValidatorSubType = (typeof VALIDATOR_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// View subtypes (13)
//
// The view's subType IS the UI control type. Each control kind has its own
// expected attrs (placeholder, maxLength, options, etc.) — runtime-ts
// surfaces them as opaque Record<string, unknown>; UI layers interpret.
// Mirrors metaobjects-dynamic/web/.../html/*View.java naming.
// ---------------------------------------------------------------------------

export const VIEW_SUBTYPE_TEXT = "text";
export const VIEW_SUBTYPE_TEXTAREA = "textarea";
export const VIEW_SUBTYPE_DATE = "date";
export const VIEW_SUBTYPE_MONTH = "month";
export const VIEW_SUBTYPE_HOTLINK = "hotlink";
export const VIEW_SUBTYPE_DROPDOWN = "dropdown";
export const VIEW_SUBTYPE_RADIO = "radio";
export const VIEW_SUBTYPE_CHECKBOX = "checkbox";
export const VIEW_SUBTYPE_NUMBER = "number";
export const VIEW_SUBTYPE_PASSWORD = "password";
export const VIEW_SUBTYPE_HIDDEN = "hidden";
export const VIEW_SUBTYPE_WEB = "web";          // abstract base for web-rendered views
export const VIEW_SUBTYPE_CURRENCY = "currency";

export const VIEW_SUBTYPES = [
  SUBTYPE_BASE,
  VIEW_SUBTYPE_TEXT,
  VIEW_SUBTYPE_TEXTAREA,
  VIEW_SUBTYPE_DATE,
  VIEW_SUBTYPE_MONTH,
  VIEW_SUBTYPE_HOTLINK,
  VIEW_SUBTYPE_DROPDOWN,
  VIEW_SUBTYPE_RADIO,
  VIEW_SUBTYPE_CHECKBOX,
  VIEW_SUBTYPE_NUMBER,
  VIEW_SUBTYPE_PASSWORD,
  VIEW_SUBTYPE_HIDDEN,
  VIEW_SUBTYPE_WEB,
  VIEW_SUBTYPE_CURRENCY,
] as const;
export type ViewSubType = (typeof VIEW_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Layout type — object-level UI surfaces (replaces Project B's object-attached
// data-grid view subtype; views are now strictly field-level per Java parity).
// ---------------------------------------------------------------------------

export const LAYOUT_SUBTYPE_DATA_GRID = "dataGrid";

export const LAYOUT_SUBTYPES = [
  SUBTYPE_BASE,
  LAYOUT_SUBTYPE_DATA_GRID,
] as const;
export type LayoutSubType = (typeof LAYOUT_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Layout attrs (on dataGrid layouts)
// ---------------------------------------------------------------------------
export const LAYOUT_DATA_GRID_ATTR_PAGE_SIZE          = "pageSize";
export const LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD = "defaultSortField";
export const LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER = "defaultSortOrder";
export const LAYOUT_DATA_GRID_ATTR_FILTERABLE         = "filterable";
export const LAYOUT_DATA_GRID_ATTR_FILTER             = "filter";
export const LAYOUT_DATA_GRID_ATTR_COLUMNS            = "columns";

// ---------------------------------------------------------------------------
// View attrs (on currency views)
// ---------------------------------------------------------------------------
/** BCP 47 locale code on a view[currency]. Defaults to "en-US" when omitted. */
export const VIEW_CURRENCY_ATTR_LOCALE = "locale";
/** Default BCP 47 locale code when @locale is omitted on a view[currency]. */
export const VIEW_CURRENCY_ATTR_LOCALE_DEFAULT = "en-US";

// ---------------------------------------------------------------------------
// Identity subtypes (2 — NO base; Java doesn't register one)
// ---------------------------------------------------------------------------

export const IDENTITY_SUBTYPE_PRIMARY = "primary";
export const IDENTITY_SUBTYPE_SECONDARY = "secondary";

export const IDENTITY_SUBTYPES = [
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
] as const;
export type IdentitySubType = (typeof IDENTITY_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Relationship subtypes (4)
// ---------------------------------------------------------------------------

export const RELATIONSHIP_SUBTYPE_ASSOCIATION = "association";
export const RELATIONSHIP_SUBTYPE_AGGREGATION = "aggregation";
export const RELATIONSHIP_SUBTYPE_COMPOSITION = "composition";

export const RELATIONSHIP_SUBTYPES = [
  SUBTYPE_BASE,
  RELATIONSHIP_SUBTYPE_ASSOCIATION,
  RELATIONSHIP_SUBTYPE_AGGREGATION,
  RELATIONSHIP_SUBTYPE_COMPOSITION,
] as const;
export type RelationshipSubType = (typeof RELATIONSHIP_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Reserved structural body keys (redesigned format — NOT @-prefixed, NOT attrs)
//
// Every node body is a map whose only permitted non-@ keys are these. The
// canonical body-key order is: name, package, extends, abstract, overlay,
// isArray, @-attrs (alphabetical), children.
// ---------------------------------------------------------------------------

export const RESERVED_KEY_NAME = "name";
export const RESERVED_KEY_PACKAGE = "package";
export const RESERVED_KEY_EXTENDS = "extends";   // the supertype reference
export const RESERVED_KEY_ABSTRACT = "abstract"; // true → the node is abstract
export const RESERVED_KEY_OVERLAY = "overlay";   // true → re-opens an existing same-named node
export const RESERVED_KEY_IS_ARRAY = "isArray";  // true → the node is an array
export const RESERVED_KEY_CHILDREN = "children";

/** attr-child-node body key carrying the typed value. */
export const RESERVED_KEY_VALUE = "value";

export const RESERVED_KEYS = new Set<string>([
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_OVERLAY,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_VALUE,
]);

// ---------------------------------------------------------------------------
// JSON document special keys (top-level, ignored during wrapper-key detection)
// ---------------------------------------------------------------------------

export const JSON_KEY_SCHEMA = "$schema";

// ---------------------------------------------------------------------------
// Inline attribute prefix + fused type.subType key separator
// ---------------------------------------------------------------------------

export const ATTR_PREFIX = "@";

/** Separator fusing type and subType in a node's wrapper key (`object.entity`). */
export const TYPE_SUBTYPE_SEPARATOR = ".";

// ---------------------------------------------------------------------------
// Package path conventions
// ---------------------------------------------------------------------------

/** Separator between package segments and between package and name. */
export const PACKAGE_SEPARATOR = "::";

/** Relative-reference "go up one level" marker. */
export const PACKAGE_PARENT = "..";

// ---------------------------------------------------------------------------
// Wildcard for child-rule matching
// ---------------------------------------------------------------------------

export const CHILD_RULE_WILDCARD = "*";

// ---------------------------------------------------------------------------
// Codegen / runtime attribute keys
//
// These are the attribute names referenced by codegen-ts, runtime-ts, and
// migrate-ts when reading metadata. Centralized here for typo-safety and
// cross-language parity (Java metaobjects-core uses analogous string
// constants for the same attribute names).
// ---------------------------------------------------------------------------

// Identity attrs
export const IDENTITY_ATTR_FIELDS = "fields";
export const IDENTITY_ATTR_GENERATION = "generation";
/** On secondary identities: true → uniqueIndex; false/absent → index. Defaults to true for back-compat. */
export const IDENTITY_ATTR_UNIQUE = "unique";

// Relationship attrs
export const RELATIONSHIP_ATTR_CARDINALITY = "cardinality";
export const RELATIONSHIP_ATTR_OBJECT_REF = "objectRef";
export const RELATIONSHIP_ATTR_FK_FIELD = "fkField";
/** The field name on the PARENT entity that the FK references. Defaults to the parent's primary identity field. */
export const RELATIONSHIP_ATTR_PARENT_FIELD = "parentField";
export const RELATIONSHIP_ATTR_JOIN_ENTITY = "joinEntity";    // N:M cardinality
export const RELATIONSHIP_ATTR_JOIN_FIELDS = "joinFields";    // N:M cardinality

// Field-level attrs (used by codegen-ts column mapper)
export const FIELD_ATTR_REQUIRED = "required";
export const FIELD_ATTR_UNIQUE = "unique";
export const FIELD_ATTR_DEFAULT = "default";
export const FIELD_ATTR_MAX_LENGTH = "maxLength";
export const FIELD_ATTR_DB_COLUMN = "dbColumn";
export const FIELD_ATTR_PRECISION = "precision";
export const FIELD_ATTR_SCALE = "scale";
export const FIELD_ATTR_FILTERABLE = "filterable";
export const FIELD_ATTR_SORTABLE = "sortable";
export const FIELD_ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder";
/** When true, suppress the @filterable-without-index Loader warning (Project D drift check). */
export const FIELD_ATTR_DB_INDEXED = "db.indexed";
/** ISO 4217 currency code on a currency-subtype field. Defaults to "USD" when omitted. */
export const FIELD_ATTR_CURRENCY = "currency";
/** Default ISO 4217 currency code when @currency is omitted on a currency field. */
export const FIELD_ATTR_CURRENCY_DEFAULT = "USD";

/** Auto-set semantics on a timestamp field. Values: "onCreate" | "onUpdate". */
export const FIELD_ATTR_AUTO_SET = "autoSet";

/** Name (or FQN) of the target object an object-typed field nests. Same wire
 *  spelling as the relationship `@objectRef` — Java's single ATTR_OBJECT_REF. */
export const FIELD_ATTR_OBJECT_REF = "objectRef";

export const AUTO_SET_ON_CREATE = "onCreate";
export const AUTO_SET_ON_UPDATE = "onUpdate";

export const AUTO_SET_VALUES = [AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE] as const;
export type AutoSetValue = (typeof AUTO_SET_VALUES)[number];

// Sort order values (used by @sortableDefaultOrder on fields and @defaultSortOrder on dataGrid layouts)
export const SORT_ORDER_ASC  = "asc";
export const SORT_ORDER_DESC = "desc";

export const SORT_ORDER_VALUES = [SORT_ORDER_ASC, SORT_ORDER_DESC] as const;
export type SortOrderValue = (typeof SORT_ORDER_VALUES)[number];

// Java runtime materialization strategies (values for @javaRuntime on objects)
export const OBJECT_JAVA_RUNTIME_POJO  = "pojo";
export const OBJECT_JAVA_RUNTIME_MAP   = "map";
export const OBJECT_JAVA_RUNTIME_PROXY = "proxy";

export const OBJECT_JAVA_RUNTIME_VALUES = [
  OBJECT_JAVA_RUNTIME_POJO,
  OBJECT_JAVA_RUNTIME_MAP,
  OBJECT_JAVA_RUNTIME_PROXY,
] as const;
export type ObjectJavaRuntimeValue = (typeof OBJECT_JAVA_RUNTIME_VALUES)[number];

// Validator attr keys (used by codegen-ts when reading validator children)
export const VALIDATOR_ATTR_PATTERN = "pattern";
export const VALIDATOR_ATTR_MIN = "min";
export const VALIDATOR_ATTR_MAX = "max";

// Identity generation strategies (values for IDENTITY_ATTR_GENERATION)
export const GENERATION_INCREMENT = "increment";
export const GENERATION_UUID = "uuid";
export const GENERATION_ASSIGNED = "assigned";

export const GENERATION_VALUES = [
  GENERATION_INCREMENT,
  GENERATION_UUID,
  GENERATION_ASSIGNED,
] as const;
export type GenerationValue = (typeof GENERATION_VALUES)[number];

// Relationship cardinality values (for RELATIONSHIP_ATTR_CARDINALITY)
export const CARDINALITY_ONE = "one";
export const CARDINALITY_MANY = "many";

export const CARDINALITY_VALUES = [CARDINALITY_ONE, CARDINALITY_MANY] as const;
export type CardinalityValue = (typeof CARDINALITY_VALUES)[number];

// ---------------------------------------------------------------------------
// Filter operators (Project D) — shared source of truth across server +
// codegen. Each subtype declares which operators are legal for fields of that
// type. Server allowlist generation + TS type generation + codegen-time grid
// validation all import from here.
// ---------------------------------------------------------------------------

export const FILTER_OPS = [
  "eq", "ne", "gt", "gte", "lt", "lte", "in", "like", "isNull",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const OPS_BY_SUBTYPE: Readonly<Record<string, readonly FilterOp[]>> = {
  string:    ["eq", "ne", "in", "like", "isNull"],
  int:       ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  short:     ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  byte:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  long:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  double:    ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  float:     ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  decimal:   ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  boolean:   ["eq", "isNull"],
  date:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  time:      ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
  timestamp: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
} as const;

export function opsForSubType(subType: string): readonly FilterOp[] {
  return OPS_BY_SUBTYPE[subType] ?? [];
}

// Object-level attrs
/** Java runtime strategy for an object. Values: "pojo" | "map" | "proxy". */
export const OBJECT_ATTR_JAVA_RUNTIME = "javaRuntime";

// ---------------------------------------------------------------------------
// Source type — declares where an object's data lives (Project E).
// dbTable / dbView ship in v1. Multiple sources per object are allowed
// and meaningful (write-through CQRS: dbTable for writes + dbView for reads).
// ---------------------------------------------------------------------------

export const SOURCE_SUBTYPE_DB_TABLE = "dbTable";
export const SOURCE_SUBTYPE_DB_VIEW  = "dbView";

export const SOURCE_SUBTYPES = [
  SUBTYPE_BASE,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
] as const;
export type SourceSubType = (typeof SOURCE_SUBTYPES)[number];

// Source attrs — both dbTable and dbView use @name for the SQL identifier
// (table name and view name respectively). Same key for ergonomic consistency.
export const SOURCE_DB_TABLE_ATTR_NAME = "name";
export const SOURCE_DB_VIEW_ATTR_NAME  = "name";
/** Shared @name attr key for MetaSource (covers both dbTable and dbView). Use this
 *  in generic source accessors instead of the subtype-specific aliases above. */
export const SOURCE_ATTR_NAME          = "name";

// ---------------------------------------------------------------------------
// Origin type — field-level provenance (Project E).
//
// Origin is a child of `field`. Says "this field's value comes from there."
// passthrough: from <Entity.field> [via <relationship path>]
// aggregate:   <agg> of <Entity.field> via <relationship path>
//
// ---------------------------------------------------------------------------

export const ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough";
export const ORIGIN_SUBTYPE_AGGREGATE   = "aggregate";

export const ORIGIN_SUBTYPES = [
  SUBTYPE_BASE,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
] as const;
export type OriginSubType = (typeof ORIGIN_SUBTYPES)[number];

// passthrough attrs
export const ORIGIN_PASSTHROUGH_ATTR_FROM = "from";
export const ORIGIN_PASSTHROUGH_ATTR_VIA  = "via";

// aggregate attrs
export const ORIGIN_AGGREGATE_ATTR_AGG = "agg";
export const ORIGIN_AGGREGATE_ATTR_OF  = "of";
export const ORIGIN_AGGREGATE_ATTR_VIA = "via";

// aggregate function vocabulary
export const AGGREGATE_FUNCTIONS = ["count", "sum", "avg", "min", "max"] as const;
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];
