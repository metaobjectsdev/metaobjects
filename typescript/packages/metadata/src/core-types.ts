// registerCoreTypes() — Java's 7 base types (plus metadata wrapper) and their subtypes
import { TypeId, type ChildRule, type TypeDefinition, TypeRegistry } from "./registry.js";
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
import { MetaOrigin } from "./meta/meta-origin.js";
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
  ATTR_SUBTYPES,
  VALIDATOR_SUBTYPES,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
  VIEW_SUBTYPES,
  IDENTITY_SUBTYPES,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  RELATIONSHIP_SUBTYPES,
  LAYOUT_SUBTYPES,
  SOURCE_SUBTYPES,
  ORIGIN_SUBTYPES,
  CHILD_RULE_WILDCARD,
} from "./constants.js";

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
): TypeDefinition {
  return {
    typeId: new TypeId(type, subType),
    description,
    factory: (typeId, name) => new NodeClass(typeId, name),
    childRules,
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
    registry.register(def(TYPE_OBJECT, subType, `Object/entity (${subType})`, objectRules, MetaObject));
  }

  // field — 13 subtypes
  const fieldRules = [
    wildcard(TYPE_VALIDATOR),
    wildcard(TYPE_VIEW),
    wildcard(TYPE_ATTR),
    wildcard(TYPE_ORIGIN),
  ];
  for (const subType of FIELD_SUBTYPES) {
    registry.register(def(TYPE_FIELD, subType, `Field of type ${subType}`, fieldRules, MetaField));
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
  const validatorRules = [wildcard(TYPE_ATTR)];
  for (const subType of VALIDATOR_SUBTYPES) {
    const NodeClass = VALIDATOR_CLASS_MAP.get(subType) ?? MetaValidator;
    registry.register(def(TYPE_VALIDATOR, subType, `Validator (${subType})`, validatorRules, NodeClass));
  }

  // view — N subtypes. Each view permits only attr children (Java parity:
  // MetaView only attaches to fields, never aggregates child views).
  for (const subType of VIEW_SUBTYPES) {
    registry.register(def(TYPE_VIEW, subType, `View (${subType})`, [wildcard(TYPE_ATTR)], MetaView));
  }

  // layout — object-level UI surfaces (data grids, forms, tabs, cards).
  // Each subtype permits only attr children — like views, layouts are config carriers.
  for (const subType of LAYOUT_SUBTYPES) {
    registry.register(def(TYPE_LAYOUT, subType, `Layout (${subType})`, [wildcard(TYPE_ATTR)], MetaLayout));
  }

  // source — declares where an object's data lives (dbTable, dbView, ...).
  // Only attr children; sources carry only configuration, never nested structure.
  for (const subType of SOURCE_SUBTYPES) {
    registry.register(def(TYPE_SOURCE, subType, `Source (${subType})`, [wildcard(TYPE_ATTR)], MetaSource));
  }

  // origin — field-level provenance. Only attr children.
  for (const subType of ORIGIN_SUBTYPES) {
    registry.register(def(TYPE_ORIGIN, subType, `Origin (${subType})`, [wildcard(TYPE_ATTR)], MetaOrigin));
  }

  // identity — 2 subtypes (no base; Java doesn't register one).
  // Subtype→class dispatch for TYPE_IDENTITY (formerly handled by metaOf()):
  //   primary → MetaPrimaryIdentity, secondary → MetaSecondaryIdentity,
  //   default → MetaIdentity (fallback, not currently registered).
  for (const subType of IDENTITY_SUBTYPES) {
    const NodeClass = IDENTITY_CLASS_MAP.get(subType) ?? MetaIdentity;
    registry.register(def(TYPE_IDENTITY, subType, `Identity (${subType})`, [wildcard(TYPE_ATTR)], NodeClass));
  }

  // relationship — 4 subtypes
  for (const subType of RELATIONSHIP_SUBTYPES) {
    registry.register(
      def(TYPE_RELATIONSHIP, subType, `Relationship (${subType})`, [wildcard(TYPE_ATTR)], MetaRelationship),
    );
  }
}
