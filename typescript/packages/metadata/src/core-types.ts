// registerCoreTypes() — Java's 7 base types (plus metadata wrapper) and their subtypes
import { TypeId, type AttrSchema, type ChildRule, type TypeDefinition, TypeRegistry } from "./registry.js";
import type { MetaData } from "./meta/meta-data.js";
import { MetaRoot } from "./meta/meta-root.js";
import { MetaObject } from "./meta/meta-object.js";
import { MetaField } from "./meta/meta-field.js";
import { MetaAttr } from "./meta/meta-attr.js";
import {
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
} from "./meta/meta-validator.js";
import { MetaView } from "./meta/meta-view.js";
import {
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
} from "./meta/meta-identity.js";
import { MetaRelationship } from "./meta/meta-relationship.js";
import { MetaLayout } from "./meta/meta-layout.js";
import { MetaSource } from "./meta/meta-source.js";
import { MetaOrigin, MetaPassthroughOrigin, MetaAggregateOrigin } from "./meta/meta-origin.js";
import {
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
  SUBTYPE_BASE,
  SUBTYPE_ROOT,
  OBJECT_SUBTYPES,
  FIELD_SUBTYPES,
  FIELD_SUBTYPE_CURRENCY,
  ATTR_SUBTYPES,
  VALIDATOR_SUBTYPES,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
  VIEW_SUBTYPES,
  VIEW_SUBTYPE_CURRENCY,
  IDENTITY_SUBTYPES,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  RELATIONSHIP_SUBTYPES,
  LAYOUT_SUBTYPES,
  LAYOUT_SUBTYPE_DATA_GRID,
  SOURCE_SUBTYPES,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
  ORIGIN_SUBTYPES,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  CHILD_RULE_WILDCARD,
  // attr-subtype value-type constants
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
  // attr-name constants
  FIELD_ATTR_DB_COLUMN,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  FIELD_ATTR_DB_INDEXED,
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_CURRENCY_DEFAULT,
  FIELD_ATTR_AUTO_SET,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  GENERATION_VALUES,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_FK_FIELD,
  RELATIONSHIP_ATTR_PARENT_FIELD,
  RELATIONSHIP_ATTR_JOIN_ENTITY,
  RELATIONSHIP_ATTR_JOIN_FIELDS,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
  AUTO_SET_VALUES,
  SORT_ORDER_VALUES,
  OBJECT_JAVA_RUNTIME_VALUES,
  OBJECT_ATTR_JAVA_RUNTIME,
  SOURCE_ATTR_NAME,
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

// ---------------------------------------------------------------------------
// Attribute schemas — Phase A2.
//
// Per (type, subType) attr inventories. Sourced from constants.ts (attr names),
// the src/meta/* node accessors (which attrs each subtype reads), the
// conformance fixtures (real usage + `required` determination), and CLAUDE.md
// (descriptions, defaults, allowedValues).
//
// `required: true` is reserved for attrs that EVERY conformance fixture with
// that subtype supplies AND that are semantically mandatory. Everything else
// is `required: false` (Phase A3 validation depends on this being conservative).
// ---------------------------------------------------------------------------

/** Attrs common to every field subtype (codegen-ts column mapper + Project D filter/sort). */
const commonFieldAttrs: AttrSchema[] = [
  {
    name: FIELD_ATTR_DB_COLUMN,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Override the generated SQL column name for this field. Defaults to the field name run through the project's columnNamingStrategy.",
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
    // number, a string field to a string. A single fixed valueType cannot
    // capture that, so it is declared as the universal base subtype, which
    // A3's type check treats as unconstrained (accept any AttrValue).
    valueType: SUBTYPE_BASE,
    required: false,
    description:
      "Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...).",
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
    name: FIELD_ATTR_DB_INDEXED,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means).",
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
const currencyFieldAttr: AttrSchema = {
  name: FIELD_ATTR_CURRENCY,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  default: FIELD_ATTR_CURRENCY_DEFAULT,
  description:
    "ISO 4217 currency code for a currency-subtype field. Storage is integer minor units; defaults to 'USD' when omitted.",
};

/** Attrs on view.currency. */
const currencyViewAttrs: AttrSchema[] = [
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
const objectAttrs: AttrSchema[] = [
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
const relationshipAttrs: AttrSchema[] = [
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
    name: RELATIONSHIP_ATTR_FK_FIELD,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Name of the foreign-key field on the source entity (for one-to-many / many-to-one relationships).",
  },
  {
    name: RELATIONSHIP_ATTR_PARENT_FIELD,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Field name on the parent entity that the FK references. Defaults to the parent's primary identity field.",
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
const identityFieldsAttr: AttrSchema = {
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

/** Attrs on source.dbTable / source.dbView — @name (the SQL identifier). */
const sourceNameAttrs: AttrSchema[] = [
  {
    name: SOURCE_ATTR_NAME,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "The SQL table or view name for this source. Defaults to the object name run through the columnNamingStrategy when omitted.",
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
const dataGridLayoutAttrs: AttrSchema[] = [
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
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "JSON-encoded preset filter applied to the grid at the metadata level.",
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
const ORIGIN_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, []],
  [ORIGIN_SUBTYPE_PASSTHROUGH, [...passthroughOriginAttrs]],
  [ORIGIN_SUBTYPE_AGGREGATE, [...aggregateOriginAttrs]],
]);

/** Attrs per validator subtype. Required uses none; regex adds @pattern. */
const VALIDATOR_ATTRS_MAP = new Map<string, AttrSchema[]>([
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

function wildcard(childType: string): ChildRule {
  return {
    childType,
    childSubType: CHILD_RULE_WILDCARD,
    childName: CHILD_RULE_WILDCARD,
  };
}

type NodeConstructor = new (typeId: TypeId, name: string) => MetaData;

function def(
  type: string,
  subType: string,
  description: string,
  childRules: ChildRule[],
  NodeClass: NodeConstructor,
  attributes: AttrSchema[] = [],
): TypeDefinition {
  return {
    typeId: new TypeId(type, subType),
    description,
    factory: (typeId, name) => new NodeClass(typeId, name),
    childRules,
    attributes,
  };
}

/** Map from validator subtype string → concrete node constructor. */
const VALIDATOR_CLASS_MAP = new Map<string, NodeConstructor>([
  [VALIDATOR_SUBTYPE_REQUIRED, MetaRequiredValidator],
  [VALIDATOR_SUBTYPE_LENGTH, MetaLengthValidator],
  [VALIDATOR_SUBTYPE_REGEX, MetaRegexValidator],
  [VALIDATOR_SUBTYPE_NUMERIC, MetaNumericValidator],
  [VALIDATOR_SUBTYPE_ARRAY, MetaArrayValidator],
]);

/** Map from identity subtype string → concrete node constructor. */
const IDENTITY_CLASS_MAP = new Map<string, NodeConstructor>([
  [IDENTITY_SUBTYPE_PRIMARY, MetaPrimaryIdentity],
  [IDENTITY_SUBTYPE_SECONDARY, MetaSecondaryIdentity],
]);

/** Map from origin subtype string → concrete node constructor. */
const ORIGIN_CLASS_MAP = new Map<string, NodeConstructor>([
  [ORIGIN_SUBTYPE_PASSTHROUGH, MetaPassthroughOrigin],
  [ORIGIN_SUBTYPE_AGGREGATE, MetaAggregateOrigin],
]);

export function registerCoreTypes(registry: TypeRegistry): void {
  // metadata — 1 subtype (the document root: metadata.root)
  registry.register(
    def(TYPE_METADATA, SUBTYPE_ROOT, "Root metadata document", [
      wildcard(TYPE_OBJECT),
      wildcard(TYPE_FIELD),
      wildcard(TYPE_ATTR),
      wildcard(TYPE_VALIDATOR),
    ], MetaRoot),
  );

  // object — 4 subtypes
  const objectRules = [
    wildcard(TYPE_FIELD),
    wildcard(TYPE_IDENTITY),
    wildcard(TYPE_RELATIONSHIP),
    wildcard(TYPE_VALIDATOR),
    wildcard(TYPE_LAYOUT),
    wildcard(TYPE_SOURCE),
    wildcard(TYPE_ATTR),
  ];
  for (const subType of OBJECT_SUBTYPES) {
    registry.register(
      def(TYPE_OBJECT, subType, `Object/entity (${subType})`, objectRules, MetaObject, [...objectAttrs]),
    );
  }

  // field — 13 subtypes
  const fieldRules = [
    wildcard(TYPE_VALIDATOR),
    wildcard(TYPE_VIEW),
    wildcard(TYPE_ATTR),
    wildcard(TYPE_ORIGIN),
  ];
  for (const subType of FIELD_SUBTYPES) {
    // field.currency additionally carries @currency; all other field subtypes
    // share the common codegen/filter attrs only.
    const fieldAttrs =
      subType === FIELD_SUBTYPE_CURRENCY
        ? [...commonFieldAttrs, { ...currencyFieldAttr }]
        : [...commonFieldAttrs];
    registry.register(
      def(TYPE_FIELD, subType, `Field of type ${subType}`, fieldRules, MetaField, fieldAttrs),
    );
  }

  // attr — 9 subtypes, no children allowed
  for (const subType of ATTR_SUBTYPES) {
    registry.register(def(TYPE_ATTR, subType, `Attribute of type ${subType}`, [], MetaAttr));
  }

  // validator — 6 subtypes (base + 5 named); dispatch to subtype-specific class.
  // Subtype→class dispatch for TYPE_VALIDATOR (formerly handled by metaOf()):
  //   required → MetaRequiredValidator, length → MetaLengthValidator,
  //   regex → MetaRegexValidator, numeric → MetaNumericValidator,
  //   array → MetaArrayValidator, default (base) → MetaValidator.
  // Attr schemas: MetaValidator (base) + length/numeric/array read @min/@max via
  //   this.attr(VALIDATOR_ATTR_MIN/MAX); regex also reads @pattern via this.attr().
  //   required has no extra attrs.
  const validatorRules = [wildcard(TYPE_ATTR)];
  for (const subType of VALIDATOR_SUBTYPES) {
    const NodeClass = VALIDATOR_CLASS_MAP.get(subType) ?? MetaValidator;
    const validatorAttrs = VALIDATOR_ATTRS_MAP.get(subType) ?? [];
    registry.register(
      def(TYPE_VALIDATOR, subType, `Validator (${subType})`, validatorRules, NodeClass, validatorAttrs),
    );
  }

  // view — N subtypes. Each view permits only attr children (Java parity:
  // MetaView only attaches to fields, never aggregates child views).
  // Only view.currency carries a documented attr (@locale); others have none.
  for (const subType of VIEW_SUBTYPES) {
    const viewAttrs = subType === VIEW_SUBTYPE_CURRENCY ? [...currencyViewAttrs] : [];
    registry.register(
      def(TYPE_VIEW, subType, `View (${subType})`, [wildcard(TYPE_ATTR)], MetaView, viewAttrs),
    );
  }

  // layout — object-level UI surfaces (data grids, forms, tabs, cards).
  // Each subtype permits only attr children — like views, layouts are config carriers.
  for (const subType of LAYOUT_SUBTYPES) {
    const layoutAttrs = subType === LAYOUT_SUBTYPE_DATA_GRID ? [...dataGridLayoutAttrs] : [];
    registry.register(
      def(TYPE_LAYOUT, subType, `Layout (${subType})`, [wildcard(TYPE_ATTR)], MetaLayout, layoutAttrs),
    );
  }

  // source — declares where an object's data lives (dbTable, dbView, ...).
  // Only attr children; sources carry only configuration, never nested structure.
  for (const subType of SOURCE_SUBTYPES) {
    const sourceAttrs =
      subType === SOURCE_SUBTYPE_DB_TABLE || subType === SOURCE_SUBTYPE_DB_VIEW
        ? [...sourceNameAttrs]
        : [];
    registry.register(
      def(TYPE_SOURCE, subType, `Source (${subType})`, [wildcard(TYPE_ATTR)], MetaSource, sourceAttrs),
    );
  }

  // origin — field-level provenance. Only attr children.
  // Subtype→class dispatch (mirrors validator / identity patterns):
  //   passthrough → MetaPassthroughOrigin, aggregate → MetaAggregateOrigin,
  //   base (and any unmapped subtype) → MetaOrigin.
  for (const subType of ORIGIN_SUBTYPES) {
    const NodeClass = ORIGIN_CLASS_MAP.get(subType) ?? MetaOrigin;
    const originAttrs = ORIGIN_ATTRS_MAP.get(subType) ?? [];
    registry.register(
      def(TYPE_ORIGIN, subType, `Origin (${subType})`, [wildcard(TYPE_ATTR)], NodeClass, originAttrs),
    );
  }

  // identity — 2 subtypes (no base; Java doesn't register one).
  // Subtype→class dispatch for TYPE_IDENTITY (formerly handled by metaOf()):
  //   primary → MetaPrimaryIdentity, secondary → MetaSecondaryIdentity,
  //   default → MetaIdentity (fallback, not currently registered).
  for (const subType of IDENTITY_SUBTYPES) {
    const NodeClass = IDENTITY_CLASS_MAP.get(subType) ?? MetaIdentity;
    const idAttrs =
      subType === IDENTITY_SUBTYPE_PRIMARY
        ? [...primaryIdentityAttrs]
        : subType === IDENTITY_SUBTYPE_SECONDARY
          ? [...secondaryIdentityAttrs]
          : [{ ...identityFieldsAttr }];
    registry.register(
      def(TYPE_IDENTITY, subType, `Identity (${subType})`, [wildcard(TYPE_ATTR)], NodeClass, idAttrs),
    );
  }

  // relationship — 4 subtypes
  for (const subType of RELATIONSHIP_SUBTYPES) {
    registry.register(
      def(
        TYPE_RELATIONSHIP,
        subType,
        `Relationship (${subType})`,
        [wildcard(TYPE_ATTR)],
        MetaRelationship,
        [...relationshipAttrs],
      ),
    );
  }
}
