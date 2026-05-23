// registerCoreTypes() — Java's 7 base types (plus metadata wrapper) and their subtypes
import { TypeId, type AttrSchema, type ChildRule, type TypeDefinition, TypeRegistry } from "./registry.js";
import type { MetaDataTypeProvider } from "./provider.js";
import { dbProvider } from "./persistence/db/db-provider.js";
import { type DataType } from "./data-type.js";
import type { MetaData } from "./shared/meta-data.js";
import { MetaRoot } from "./shared/meta-root.js";
import { MetaObject } from "./core/object/meta-object.js";
import { MetaField } from "./core/field/meta-field.js";
import { attrClassFor, type NodeConstructor } from "./attr-class-map.js";
// Import the attr subclasses for their self-registration side effect (each
// registers its subtype → class into attr-class-map at module load), so
// attrClassFor resolves the right class below. The base MetaAttr (the fallback)
// registers itself; importing a subclass transitively loads meta-attr.ts.
import "./core/attr/meta-attr-stringarray.js";
import "./core/attr/meta-attr-filter.js";
import "./core/attr/meta-attr-properties.js";
import {
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
} from "./core/validator/meta-validator.js";
import { MetaView } from "./presentation/view/meta-view.js";
import {
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
  MetaReferenceIdentity,
} from "./core/identity/meta-identity.js";
import { MetaRelationship } from "./core/relationship/meta-relationship.js";
import { MetaLayout } from "./presentation/layout/meta-layout.js";
import { MetaSource } from "./persistence/source/meta-source.js";
import { MetaOrigin, MetaPassthroughOrigin, MetaAggregateOrigin } from "./persistence/origin/meta-origin.js";
import { commonFieldAttrs, currencyFieldAttr } from "./core/field/field-schema.js";
import { objectAttrs } from "./core/object/object-schema.js";
import { relationshipAttrs } from "./core/relationship/relationship-schema.js";
import { identityFieldsAttr, IDENTITY_ATTRS_MAP } from "./core/identity/identity-schema.js";
import { VALIDATOR_ATTRS_MAP } from "./core/validator/validator-schema.js";
import { currencyViewAttrs } from "./presentation/view/view-schema.js";
import { dataGridLayoutAttrs } from "./presentation/layout/layout-schema.js";
import { ORIGIN_ATTRS_MAP } from "./persistence/origin/origin-schema.js";
import { MetaPrompt } from "./prompt/meta-prompt.js";
import { PROMPT_ATTRS_MAP } from "./prompt/prompt-schema.js";
import { PROMPT_SUBTYPES } from "./prompt/prompt-constants.js";
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
  TYPE_PROMPT,
  SUBTYPE_ROOT,
} from "./shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "./shared/structural.js";
import { OBJECT_SUBTYPES, OBJECT_SUBTYPE_ENTITY } from "./core/object/object-constants.js";
import { FIELD_SUBTYPES, FIELD_SUBTYPE_CURRENCY } from "./core/field/field-constants.js";
import { ATTR_SUBTYPES } from "./core/attr/attr-constants.js";
import {
  VALIDATOR_SUBTYPES,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
} from "./core/validator/validator-constants.js";
import {
  VIEW_SUBTYPES,
  VIEW_SUBTYPE_CURRENCY,
} from "./presentation/view/view-constants.js";
import {
  IDENTITY_SUBTYPES,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
} from "./core/identity/identity-constants.js";
import { RELATIONSHIP_SUBTYPES } from "./core/relationship/relationship-constants.js";
import { LAYOUT_SUBTYPES, LAYOUT_SUBTYPE_DATA_GRID } from "./presentation/layout/layout-constants.js";
import { SOURCE_SUBTYPES } from "./persistence/source/source-constants.js";
import {
  ORIGIN_SUBTYPES,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
} from "./persistence/origin/origin-constants.js";

// ---------------------------------------------------------------------------
// The per-(type, subType) attribute schemas live in per-concern *-schema.ts
// modules (e.g. core/field/field-schema.ts, persistence/origin/origin-schema.ts).
// This file keeps only the registration logic: the def() helper, the
// subtype→class dispatch maps, and registerCoreTypes() itself.
// ---------------------------------------------------------------------------

function wildcard(childType: string): ChildRule {
  return {
    childType,
    childSubType: CHILD_RULE_WILDCARD,
    childName: CHILD_RULE_WILDCARD,
  };
}

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
  [IDENTITY_SUBTYPE_REFERENCE, MetaReferenceIdentity],
]);

/** Map from origin subtype string → concrete node constructor. */
const ORIGIN_CLASS_MAP = new Map<string, NodeConstructor>([
  [ORIGIN_SUBTYPE_PASSTHROUGH, MetaPassthroughOrigin],
  [ORIGIN_SUBTYPE_AGGREGATE, MetaAggregateOrigin],
]);

// ATTR_CLASS_MAP + attrClassFor live in the leaf module ./attr-class-map.ts
// (imported above) so MetaData.setAttr can resolve an attr subclass without
// importing this module — that import created a module-eval cycle. They are
// re-exported from the package index for the same public surface.

function registerCoreTypeDefs(registry: TypeRegistry): void {
  // metadata — 1 subtype (the document root: metadata.root)
  registry.register(
    def(TYPE_METADATA, SUBTYPE_ROOT, "Root metadata document", [
      wildcard(TYPE_OBJECT),
      wildcard(TYPE_FIELD),
      wildcard(TYPE_ATTR),
      wildcard(TYPE_VALIDATOR),
      wildcard(TYPE_PROMPT),
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
        new MetaField(new TypeId(TYPE_FIELD, subType), "").dataType),
    );
  }

  // attr — 9 subtypes, no children allowed. Each subtype's class owns its
  // dataType (resolved by this.subType); we read it off a probe instance so the
  // TypeDefinition.dataType contract (registry.find(...).dataType) still holds.
  for (const subType of ATTR_SUBTYPES) {
    const AttrClass = attrClassFor(subType);
    const probeDataType = new AttrClass(new TypeId(TYPE_ATTR, subType), "").dataType;
    registry.register(
      def(TYPE_ATTR, subType, `Attribute of type ${subType}`, [], AttrClass, [], probeDataType),
    );
  }

  // validator — 6 subtypes (base + 5 named); dispatch to subtype-specific class.
  // Subtype→class dispatch for TYPE_VALIDATOR (formerly handled by metaOf()):
  //   required → MetaRequiredValidator, length → MetaLengthValidator,
  //   regex → MetaRegexValidator, numeric → MetaNumericValidator,
  //   array → MetaArrayValidator, default (base) → MetaValidator.
  // Attr schemas: MetaValidator (base) + length/numeric/array read @min/@max via
  //   this.ownAttr(VALIDATOR_ATTR_MIN/MAX); regex also reads @pattern via this.ownAttr().
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
  // DB-domain attrs (@name) are added by dbProvider via TypeRegistry.extend.
  for (const subType of SOURCE_SUBTYPES) {
    registry.register(
      def(TYPE_SOURCE, subType, `Source (${subType})`, [wildcard(TYPE_ATTR)], MetaSource, []),
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

  // prompt — LLM prompt construction (FR-004). template + fragment; attr-only
  // children. A single MetaPrompt class backs all subtypes (mirrors source);
  // per-subtype attr schemas drive validation (template requires @payloadRef +
  // @textRef; fragment requires @textRef).
  for (const subType of PROMPT_SUBTYPES) {
    const promptAttrs = PROMPT_ATTRS_MAP.get(subType) ?? [];
    registry.register(
      def(TYPE_PROMPT, subType, `Prompt (${subType})`, [wildcard(TYPE_ATTR)], MetaPrompt, promptAttrs),
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
 * the metadata root. One provider per package: this is `@metaobjectsdev/metadata`'s.
 */
export const coreTypesProvider: MetaDataTypeProvider = {
  id: "metaobjects-core-types",
  description: "Core metaobjects metamodel types and subtypes.",
  registerTypes(registry: TypeRegistry): void {
    registerCoreTypeDefs(registry);
  },
};

/** The default provider bundle — core metamodel types plus DB-domain attrs.
 *  Spread it to add more: `[...coreProviders, mine]`. */
export const coreProviders: readonly MetaDataTypeProvider[] = [coreTypesProvider, dbProvider];

/**
 * Register the core metamodel into an existing registry. Thin convenience
 * wrapper over `coreTypesProvider`; prefer `composeRegistry(coreProviders)`.
 */
export function registerCoreTypes(registry: TypeRegistry): void {
  coreTypesProvider.registerTypes(registry);
}
