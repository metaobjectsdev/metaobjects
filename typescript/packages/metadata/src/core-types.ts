// registerCoreTypes() — Java's 7 base types (plus metadata wrapper) and their subtypes
import { TypeId, type ChildRule, type TypeDefinition, TypeRegistry } from "./registry.js";
import { MetaModel } from "./model.js";
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
  OBJECT_SUBTYPES,
  FIELD_SUBTYPES,
  ATTR_SUBTYPES,
  VALIDATOR_SUBTYPES,
  VIEW_SUBTYPES,
  IDENTITY_SUBTYPES,
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

function def(
  type: string,
  subType: string,
  description: string,
  childRules: ChildRule[],
): TypeDefinition {
  return {
    typeId: new TypeId(type, subType),
    description,
    factory: (typeId, name) => new MetaModel(typeId, name),
    childRules,
  };
}

export function registerCoreTypes(registry: TypeRegistry): void {
  // metadata — 1 subtype
  registry.register(
    def(TYPE_METADATA, SUBTYPE_BASE, "Root metadata document", [
      wildcard(TYPE_OBJECT),
      wildcard(TYPE_FIELD),
      wildcard(TYPE_ATTR),
      wildcard(TYPE_VALIDATOR),
    ]),
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
    registry.register(def(TYPE_OBJECT, subType, `Object/entity (${subType})`, objectRules));
  }

  // field — 13 subtypes
  const fieldRules = [
    wildcard(TYPE_VALIDATOR),
    wildcard(TYPE_VIEW),
    wildcard(TYPE_ATTR),
    wildcard(TYPE_ORIGIN),
  ];
  for (const subType of FIELD_SUBTYPES) {
    registry.register(def(TYPE_FIELD, subType, `Field of type ${subType}`, fieldRules));
  }

  // attr — 9 subtypes, no children allowed
  for (const subType of ATTR_SUBTYPES) {
    registry.register(def(TYPE_ATTR, subType, `Attribute of type ${subType}`, []));
  }

  // validator — 6 subtypes
  const validatorRules = [wildcard(TYPE_ATTR)];
  for (const subType of VALIDATOR_SUBTYPES) {
    registry.register(def(TYPE_VALIDATOR, subType, `Validator (${subType})`, validatorRules));
  }

  // view — N subtypes. Each view permits only attr children (Java parity:
  // MetaView only attaches to fields, never aggregates child views).
  for (const subType of VIEW_SUBTYPES) {
    registry.register(def(TYPE_VIEW, subType, `View (${subType})`, [wildcard(TYPE_ATTR)]));
  }

  // layout — object-level UI surfaces (data grids, forms, tabs, cards).
  // Each subtype permits only attr children — like views, layouts are config carriers.
  for (const subType of LAYOUT_SUBTYPES) {
    registry.register(def(TYPE_LAYOUT, subType, `Layout (${subType})`, [wildcard(TYPE_ATTR)]));
  }

  // source — declares where an object's data lives (dbTable, dbView, ...).
  // Only attr children; sources carry only configuration, never nested structure.
  for (const subType of SOURCE_SUBTYPES) {
    registry.register(def(TYPE_SOURCE, subType, `Source (${subType})`, [wildcard(TYPE_ATTR)]));
  }

  // origin — field-level provenance. Only attr children.
  for (const subType of ORIGIN_SUBTYPES) {
    registry.register(def(TYPE_ORIGIN, subType, `Origin (${subType})`, [wildcard(TYPE_ATTR)]));
  }

  // identity — 2 subtypes (no base; Java doesn't register one)
  for (const subType of IDENTITY_SUBTYPES) {
    registry.register(def(TYPE_IDENTITY, subType, `Identity (${subType})`, [wildcard(TYPE_ATTR)]));
  }

  // relationship — 4 subtypes
  for (const subType of RELATIONSHIP_SUBTYPES) {
    registry.register(
      def(TYPE_RELATIONSHIP, subType, `Relationship (${subType})`, [wildcard(TYPE_ATTR)]),
    );
  }
}
