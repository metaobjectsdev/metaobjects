// registerCoreTypes() — Java's 7 base types (plus metadata wrapper) and their subtypes
import { TypeId, type AttrSchema, type ChildRule, type TypeDefinition, TypeRegistry } from "./registry.js";
import type { MetaDataTypeProvider } from "./provider.js";
import {
  type DataType,
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_INT,
  DATA_TYPE_LONG,
  DATA_TYPE_DOUBLE,
  DATA_TYPE_STRING,
  DATA_TYPE_DATE,
  DATA_TYPE_OBJECT,
} from "./data-type.js";
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
  commonFieldAttrs,
  currencyFieldAttr,
  currencyViewAttrs,
  objectAttrs,
  relationshipAttrs,
  identityFieldsAttr,
  sourceNameAttrs,
  dataGridLayoutAttrs,
  ORIGIN_ATTRS_MAP,
  IDENTITY_ATTRS_MAP,
  VALIDATOR_ATTRS_MAP,
} from "./core-attr-schemas.js";
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
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPES,
  FIELD_SUBTYPE_CURRENCY,
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
  ATTR_SUBTYPES,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_PROPERTIES,
  ATTR_SUBTYPE_STRINGARRAY,
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
} from "./constants.js";

// ---------------------------------------------------------------------------
// The per-(type, subType) attribute schemas live in ./core-attr-schemas.ts —
// ~320 lines of pure declarative data. This file keeps only the registration
// logic: the def() helper, the subtype→class dispatch maps, and
// registerCoreTypes() itself.
// ---------------------------------------------------------------------------

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
  dataType?: DataType,
): TypeDefinition {
  const definition: TypeDefinition = {
    typeId: new TypeId(type, subType),
    description,
    factory: (typeId, name) => {
      const node = new NodeClass(typeId, name);
      if (dataType !== undefined) node.setDataType(dataType);
      return node;
    },
    childRules,
    attributes,
  };
  if (dataType !== undefined) definition.dataType = dataType;
  return definition;
}

/** Field subtype → DataType. Co-located with registration — a provider adding a
 *  field subtype supplies its own dataType the same way. */
const FIELD_DATA_TYPE: Record<string, DataType> = {
  [SUBTYPE_BASE]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_STRING]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_CLASS]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_INT]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_SHORT]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_BYTE]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_LONG]: DATA_TYPE_LONG,
  [FIELD_SUBTYPE_CURRENCY]: DATA_TYPE_LONG,
  [FIELD_SUBTYPE_DOUBLE]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_FLOAT]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_DECIMAL]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_BOOLEAN]: DATA_TYPE_BOOLEAN,
  [FIELD_SUBTYPE_DATE]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_TIME]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_TIMESTAMP]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_OBJECT]: DATA_TYPE_OBJECT,
};

/** Attr subtype → DataType. */
const ATTR_DATA_TYPE: Record<string, DataType> = {
  [SUBTYPE_BASE]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_STRING]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_CLASS]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_STRINGARRAY]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_INT]: DATA_TYPE_INT,
  [ATTR_SUBTYPE_LONG]: DATA_TYPE_LONG,
  [ATTR_SUBTYPE_DOUBLE]: DATA_TYPE_DOUBLE,
  [ATTR_SUBTYPE_BOOLEAN]: DATA_TYPE_BOOLEAN,
  [ATTR_SUBTYPE_PROPERTIES]: DATA_TYPE_OBJECT,
};

/** Look up a subtype's DataType, failing loudly if the map omits it — a
 *  forgotten entry must not silently register as `string`. */
function dataTypeFor(map: Record<string, DataType>, subType: string, kind: string): DataType {
  const dt = map[subType];
  if (dt === undefined) {
    throw new Error(`registerCoreTypes: no DataType mapped for ${kind} subtype "${subType}"`);
  }
  return dt;
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

function registerCoreTypeDefs(registry: TypeRegistry): void {
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
      def(TYPE_FIELD, subType, `Field of type ${subType}`, fieldRules, MetaField, fieldAttrs,
        dataTypeFor(FIELD_DATA_TYPE, subType, "field")),
    );
  }

  // attr — 9 subtypes, no children allowed
  for (const subType of ATTR_SUBTYPES) {
    registry.register(
      def(TYPE_ATTR, subType, `Attribute of type ${subType}`, [], MetaAttr,
        [], dataTypeFor(ATTR_DATA_TYPE, subType, "attr")),
    );
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
    const idAttrs = IDENTITY_ATTRS_MAP.get(subType) ?? [{ ...identityFieldsAttr }];
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

  // Default subTypes for YAML authoring sugar: a bare `metadata:` / `object:`
  // key resolves to these. `metadata` has exactly one subtype (root) so the
  // default is unambiguous; `object` defaults to `entity`, the common case.
  // Other types (field, validator, ...) have no default — authoring always
  // writes the full `type.subType`.
  registry.setDefaultSubType(TYPE_METADATA, SUBTYPE_ROOT);
  registry.setDefaultSubType(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
}

/**
 * The core metaobjects metamodel — the seven base types (object, field, attr,
 * validator, view, identity, relationship) plus layout / source / origin and
 * the metadata root. One provider per package: this is `@metaobjects/metadata`'s.
 */
export const coreTypesProvider: MetaDataTypeProvider = {
  id: "metaobjects-core-types",
  description: "Core metaobjects metamodel types and subtypes.",
  registerTypes(registry: TypeRegistry): void {
    registerCoreTypeDefs(registry);
  },
};

/** The default provider bundle. Spread it to add more: `[...coreProviders, mine]`. */
export const coreProviders: readonly MetaDataTypeProvider[] = [coreTypesProvider];

/**
 * Register the core metamodel into an existing registry. Thin convenience
 * wrapper over `coreTypesProvider`; prefer `composeRegistry(coreProviders)`.
 */
export function registerCoreTypes(registry: TypeRegistry): void {
  coreTypesProvider.registerTypes(registry);
}
