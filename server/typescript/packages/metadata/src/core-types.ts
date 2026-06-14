// registerCoreTypes() — Java's 7 base types (plus metadata wrapper) and their subtypes
import { TypeId, type AttrSchema, type ChildRule, type TypeDefinition, TypeRegistry } from "./registry.js";
import type { MetaDataTypeProvider } from "./provider.js";
import { dbProvider } from "./persistence/db/db-provider.js";
import { docProvider } from "./core/documentation/doc-provider.js";
import { templateProvider } from "./template/template-provider.js";
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
import { MetaOrigin, MetaPassthroughOrigin, MetaAggregateOrigin, MetaCollectionOrigin } from "./persistence/origin/meta-origin.js";
import { defineProviderFromData, type FactoryMap } from "./provider-data.js";
import { FIELD_DEFINITION } from "./core/field/field-definition.embedded.js";
import { OBJECT_DEFINITION } from "./core/object/object-definition.embedded.js";
import { ATTR_DEFINITION } from "./core/attr/attr-definition.embedded.js";
import { VALIDATOR_DEFINITION } from "./core/validator/validator-definition.embedded.js";
import { IDENTITY_DEFINITION } from "./core/identity/identity-definition.embedded.js";
import { RELATIONSHIP_DEFINITION } from "./core/relationship/relationship-definition.embedded.js";
import { ORIGIN_DEFINITION } from "./persistence/origin/origin-definition.embedded.js";
import { SOURCE_DEFINITION } from "./persistence/source/source-definition.embedded.js";
import { VIEW_DEFINITION } from "./presentation/view/view-definition.embedded.js";
import { LAYOUT_DEFINITION } from "./presentation/layout/layout-definition.embedded.js";
import { MetaTemplate } from "./template/meta-template.js";
import { TEMPLATE_DEFINITION } from "./template/template-definition.embedded.js";
import { TEMPLATE_SUBTYPES } from "./template/template-constants.js";
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
  TYPE_TEMPLATE,
  SUBTYPE_ROOT,
} from "./shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "./shared/structural.js";
import { OBJECT_SUBTYPES, OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_PROJECTION } from "./core/object/object-constants.js";
import { FIELD_SUBTYPES } from "./core/field/field-constants.js";
import { ATTR_SUBTYPES } from "./core/attr/attr-constants.js";
import {
  VALIDATOR_SUBTYPES,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
} from "./core/validator/validator-constants.js";
import { VIEW_SUBTYPES } from "./presentation/view/view-constants.js";
import {
  IDENTITY_SUBTYPES,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
} from "./core/identity/identity-constants.js";
import { RELATIONSHIP_SUBTYPES } from "./core/relationship/relationship-constants.js";
import { LAYOUT_SUBTYPES } from "./presentation/layout/layout-constants.js";
import { SOURCE_SUBTYPES } from "./persistence/source/source-constants.js";
import {
  ORIGIN_SUBTYPES,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COLLECTION,
} from "./persistence/origin/origin-constants.js";

// ---------------------------------------------------------------------------
// The per-(type, subType) attribute schemas live in per-concern *-schema.ts
// modules (e.g. presentation/view/view-schema.ts) or, increasingly under
// FR-033, in the externalized spec/metamodel/*.json provider definitions.
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
  [ORIGIN_SUBTYPE_COLLECTION, MetaCollectionOrigin],
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
      wildcard(TYPE_TEMPLATE),
    ], MetaRoot),
  );

  // object — 4 subtypes. FR-033: the object provider's declarative definition
  // (vocabulary + per-subtype attr constraints + real descriptions + the
  // ADR-0028 taxonomy rule prose) is externalized to spec/metamodel/object.json,
  // embedded at build into OBJECT_DEFINITION. defineProviderFromData lowers it to
  // TypeDefinitions; the factory (behavior) stays code via OBJECT_FACTORIES,
  // mapping every subType → MetaObject. object.value additionally carries the
  // @normalize attr (declared inline in object.json's value children) — the
  // object-level default normalization mode for its enum fields' tolerant extract.
  //
  // Unlike the other converted providers, object's structural childRules VARY by
  // subtype, so they are NOT modeled in the JSON (attrs only) and are post-assigned
  // here per subtype, byte-identical to the pre-FR-033 registration:
  //   - entity     → objectRules + template (templates may be co-located)
  //   - projection → projectionRules (a derived read-only representation: NO
  //                  relationship — derivation is via @via, not a relationship
  //                  child — and NO template)
  //   - base/value → objectRules (no template)
  const objectRules = [
    wildcard(TYPE_FIELD),
    wildcard(TYPE_IDENTITY),
    wildcard(TYPE_RELATIONSHIP),
    wildcard(TYPE_VALIDATOR),
    wildcard(TYPE_LAYOUT),
    wildcard(TYPE_SOURCE),
    wildcard(TYPE_ATTR),
  ];
  const projectionRules = [
    wildcard(TYPE_FIELD),
    wildcard(TYPE_IDENTITY),
    wildcard(TYPE_VALIDATOR),
    wildcard(TYPE_LAYOUT),
    wildcard(TYPE_SOURCE),
    wildcard(TYPE_ATTR),
  ];
  const OBJECT_FACTORIES: FactoryMap = Object.fromEntries(
    OBJECT_SUBTYPES.map((subType) => [
      `${TYPE_OBJECT}.${subType}`,
      (typeId: TypeId, name: string) => new MetaObject(typeId, name),
    ]),
  );
  for (const objectDef of defineProviderFromData(OBJECT_DEFINITION, OBJECT_FACTORIES)) {
    const subType = objectDef.typeId.subType;
    objectDef.childRules =
      subType === OBJECT_SUBTYPE_ENTITY
        ? [...objectRules, wildcard(TYPE_TEMPLATE)]
        : subType === OBJECT_SUBTYPE_PROJECTION
          ? [...projectionRules]
          : [...objectRules];
    registry.register(objectDef);
  }

  // field — 15 subtypes. FR-033: the field provider's declarative definition
  // (vocabulary + per-subtype attr constraints + descriptions + rule prose) is
  // externalized to spec/metamodel/field.json, embedded at build into
  // FIELD_DEFINITION. defineProviderFromData lowers it to TypeDefinitions; the
  // factory (behavior) stays code via FIELD_FACTORIES. The structural childRules
  // are kept identical to today by post-assigning the same `fieldRules` array —
  // they are not modeled in the JSON (which carries attrs only).
  const fieldRules = [
    wildcard(TYPE_VALIDATOR),
    wildcard(TYPE_VIEW),
    wildcard(TYPE_ATTR),
    wildcard(TYPE_ORIGIN),
  ];
  // (id, name) → MetaField for every field subtype. MetaField computes its own
  // dataType from subType (FIELD_DATA_TYPE getter), so no setDataType is needed;
  // FIELD_DEFINITION.dataType carries the same per-subtype value onto the def.
  const FIELD_FACTORIES: FactoryMap = Object.fromEntries(
    FIELD_SUBTYPES.map((subType) => [
      `${TYPE_FIELD}.${subType}`,
      (typeId: TypeId, name: string) => new MetaField(typeId, name),
    ]),
  );
  for (const fieldDef of defineProviderFromData(FIELD_DEFINITION, FIELD_FACTORIES)) {
    // childRules are kept byte-identical to the pre-FR-033 registration (the
    // wildcard structural rules below are never read by the parser; they ARE
    // consumed by the Phase-1b constraint validator and excluded from the
    // registry manifest). A fresh copy per def matches the original semantics.
    fieldDef.childRules = [...fieldRules];
    registry.register(fieldDef);
  }

  // attr — 9 subtypes, no children allowed, no per-type attrs. FR-033: the attr
  // provider's declarative definition (vocabulary + descriptions + per-subtype
  // dataType) is externalized to spec/metamodel/attr.json, embedded at build into
  // ATTR_DEFINITION. defineProviderFromData lowers it to TypeDefinitions; the
  // factory (behavior) stays code via ATTR_FACTORIES. attrs are leaf value-type
  // vocabulary: no childRules and no attributes, so (unlike field) NO post-assign
  // is needed. Each subtype's class owns its dataType internally (resolved by
  // this.subType); ATTR_DEFINITION.dataType carries the same per-subtype value.
  const ATTR_FACTORIES: FactoryMap = Object.fromEntries(
    ATTR_SUBTYPES.map((subType) => [
      `${TYPE_ATTR}.${subType}`,
      (typeId: TypeId, name: string) => new (attrClassFor(subType))(typeId, name),
    ]),
  );
  for (const attrDef of defineProviderFromData(ATTR_DEFINITION, ATTR_FACTORIES)) {
    registry.register(attrDef);
  }

  // validator — 6 subtypes (base + 5 named); dispatch to subtype-specific class.
  // FR-033: the validator provider's declarative definition (vocabulary +
  // per-subtype attr constraints + descriptions + rule prose) is externalized to
  // spec/metamodel/validator.json, embedded at build into VALIDATOR_DEFINITION.
  // defineProviderFromData lowers it to TypeDefinitions; the factory (behavior)
  // stays code via VALIDATOR_FACTORIES, dispatching subType→class:
  //   required → MetaRequiredValidator, length → MetaLengthValidator,
  //   regex → MetaRegexValidator, numeric → MetaNumericValidator,
  //   array → MetaArrayValidator, default (base) → MetaValidator.
  // The structural childRules are kept byte-identical to the pre-FR-033
  // registration by post-assigning the same `validatorRules` array — they are
  // not modeled in the JSON (which carries attrs only). Attr schemas: base +
  // length/numeric/array read @min/@max via this.ownAttr(VALIDATOR_ATTR_MIN/MAX);
  // regex also reads @pattern; required has no extra attrs.
  const validatorRules = [wildcard(TYPE_ATTR)];
  const VALIDATOR_FACTORIES: FactoryMap = Object.fromEntries(
    VALIDATOR_SUBTYPES.map((subType) => [
      `${TYPE_VALIDATOR}.${subType}`,
      (typeId: TypeId, name: string) =>
        new (VALIDATOR_CLASS_MAP.get(subType) ?? MetaValidator)(typeId, name),
    ]),
  );
  for (const validatorDef of defineProviderFromData(VALIDATOR_DEFINITION, VALIDATOR_FACTORIES)) {
    // childRules are kept byte-identical to the pre-FR-033 registration (the
    // attr wildcard below is never read by the parser; it IS consumed by the
    // Phase-1b constraint validator and excluded from the registry manifest).
    // A fresh copy per def matches the original semantics.
    validatorDef.childRules = [...validatorRules];
    registry.register(validatorDef);
  }

  // view — 13 subtypes (base + 12 field-level UI/render hints). Each view permits
  // only attr children (Java parity: MetaView only attaches to fields, never
  // aggregates child views).
  // FR-033: the view provider's declarative definition (vocabulary + real
  // per-subtype descriptions + the single @locale attr on view.currency) is
  // externalized to spec/metamodel/view.json, embedded at build into
  // VIEW_DEFINITION. defineProviderFromData lowers it to TypeDefinitions; the
  // factory (behavior) stays code via VIEW_FACTORIES — every subtype maps to the
  // single MetaView class (views carry no per-subtype behavior). Only
  // view.currency carries a documented attr (@locale, default "en-US"); the
  // other 12 subtypes have none. The structural childRules ([wildcard(attr)]) are
  // kept byte-identical to the pre-FR-033 registration by post-assigning them
  // here (they are not modeled in the JSON, which carries attrs only).
  const VIEW_FACTORIES: FactoryMap = Object.fromEntries(
    VIEW_SUBTYPES.map((subType) => [
      `${TYPE_VIEW}.${subType}`,
      (typeId: TypeId, name: string) => new MetaView(typeId, name),
    ]),
  );
  const viewDefs = defineProviderFromData(VIEW_DEFINITION, VIEW_FACTORIES);
  for (const viewDef of viewDefs) {
    viewDef.childRules = [wildcard(TYPE_ATTR)];
    registry.register(viewDef);
  }

  // layout — object-level UI surfaces (data grids, forms, tabs, cards).
  // FR-033: the layout provider's declarative definition (2 subtypes — base +
  // dataGrid — vocabulary + the 6 dataGrid attr constraints + descriptions) is
  // externalized to spec/metamodel/layout.json, embedded at build into
  // LAYOUT_DEFINITION. defineProviderFromData lowers it to TypeDefinitions; the
  // factory (behavior) stays code via LAYOUT_FACTORIES — every subtype maps to
  // the single MetaLayout class (layouts are config carriers, no per-subtype
  // behavior). Each subtype permits only attr children — like views, layouts are
  // config carriers — so the structural childRules ([wildcard(attr)]) are kept
  // byte-identical to the pre-FR-033 registration by post-assigning them here
  // (they are not modeled in the JSON, which carries attrs only).
  const LAYOUT_FACTORIES: FactoryMap = Object.fromEntries(
    LAYOUT_SUBTYPES.map((subType) => [
      `${TYPE_LAYOUT}.${subType}`,
      (typeId: TypeId, name: string) => new MetaLayout(typeId, name),
    ]),
  );
  const layoutDefs = defineProviderFromData(LAYOUT_DEFINITION, LAYOUT_FACTORIES);
  for (const layoutDef of layoutDefs) {
    layoutDef.childRules = [wildcard(TYPE_ATTR)];
    registry.register(layoutDef);
  }

  // source — declares where an object's data lives (2 subtypes: base/rdb, per
  // ADR-0007). Only attr children; sources carry only configuration, never
  // nested structure.
  // FR-033: the CORE source registration (the bare source shells + real
  // descriptions + ADR-0007 rules prose) is externalized to
  // spec/metamodel/source.json, embedded at build into SOURCE_DEFINITION.
  // defineProviderFromData lowers it to TypeDefinitions; the factory (behavior)
  // stays code via SOURCE_FACTORIES — a single MetaSource class backs all
  // subtypes. The CORE registration carries NO own attrs (children == []); the
  // per-subtype @table/@kind/@role/@schema/@parameterRef attrs on source.rdb are
  // contributed by a SEPARATE provider (dbProvider, persistence/db) via
  // registry.extend(TYPE_SOURCE, "rdb", ...) — untouched by this conversion.
  // The structural childRules are kept byte-identical to the pre-FR-033
  // registration by post-assigning the same `sourceRules` array (the attr
  // wildcard is not modeled in the JSON, which carries types only).
  const sourceRules = [wildcard(TYPE_ATTR)];
  const SOURCE_FACTORIES: FactoryMap = Object.fromEntries(
    SOURCE_SUBTYPES.map((subType) => [
      `${TYPE_SOURCE}.${subType}`,
      (typeId: TypeId, name: string) => new MetaSource(typeId, name),
    ]),
  );
  for (const sourceDef of defineProviderFromData(SOURCE_DEFINITION, SOURCE_FACTORIES)) {
    // childRules kept byte-identical to the pre-FR-033 registration; a fresh
    // copy per def matches the original semantics.
    sourceDef.childRules = [...sourceRules];
    registry.register(sourceDef);
  }

  // origin — field-level provenance (4 subtypes: base/passthrough/aggregate/
  // collection; only attr children).
  // FR-033: the origin provider's declarative definition (vocabulary +
  // per-subtype attr constraints + real descriptions) is externalized to
  // spec/metamodel/origin.json, embedded at build into ORIGIN_DEFINITION.
  // defineProviderFromData lowers it to TypeDefinitions; the factory (behavior)
  // stays code via ORIGIN_FACTORIES, dispatching subType→class:
  //   passthrough → MetaPassthroughOrigin, aggregate → MetaAggregateOrigin,
  //   collection → MetaCollectionOrigin, base (and any unmapped subtype) →
  //   MetaOrigin (fallback).
  // The structural childRules are kept byte-identical to the pre-FR-033
  // registration by post-assigning the same `originRules` array — they are not
  // modeled in the JSON (which carries attrs only). Attr schemas: base has none;
  // passthrough adds @from (required) + @via; aggregate adds @agg (required) +
  // @of (required) + @via; collection adds @via (required).
  const originRules = [wildcard(TYPE_ATTR)];
  const ORIGIN_FACTORIES: FactoryMap = Object.fromEntries(
    ORIGIN_SUBTYPES.map((subType) => [
      `${TYPE_ORIGIN}.${subType}`,
      (typeId: TypeId, name: string) =>
        new (ORIGIN_CLASS_MAP.get(subType) ?? MetaOrigin)(typeId, name),
    ]),
  );
  for (const originDef of defineProviderFromData(ORIGIN_DEFINITION, ORIGIN_FACTORIES)) {
    // childRules are kept byte-identical to the pre-FR-033 registration (the attr
    // wildcard is never read by the parser; it IS consumed by the Phase-1b
    // constraint validator and excluded from the registry manifest). A fresh copy
    // per def matches the original semantics.
    originDef.childRules = [...originRules];
    registry.register(originDef);
  }

  // template — renderable text artifacts (FR-004) + tool-call envelopes
  // (ADR-0011). Four subtypes: base + prompt + output + toolcall; attr-only
  // children. A single MetaTemplate class backs every subtype (mirrors source);
  // per-subtype attr schemas drive validation (prompt + output require
  // @payloadRef + @textRef + @format closed enum; prompt adds the LLM overlay;
  // output adds @promptStyle + @kind/email part-refs; toolcall has its own set —
  // @toolName + @payloadRef, no @textRef requirement since toolcalls have no
  // renderable body).
  // FR-033: the template provider's declarative definition (the 4-subtype
  // vocabulary + the full per-subtype attr constraints — incl. @format/@promptStyle/
  // @kind closed-enum allowedValues + defaults + required @payloadRef/@toolName —
  // + real descriptions + the FR-004/ADR-0011 rules prose) is externalized to
  // spec/metamodel/template.json, embedded at build into TEMPLATE_DEFINITION.
  // defineProviderFromData lowers it to TypeDefinitions; the factory (behavior)
  // stays code via TEMPLATE_FACTORIES, mapping every subType → MetaTemplate.
  // The structural childRules are kept byte-identical to the pre-FR-033
  // registration by post-assigning the same `templateRules` array — they are not
  // modeled in the JSON (attrs only). (The separate templateProvider — which
  // EXTENDS every field subtype with @xmlText — is untouched by this conversion.)
  const templateRules = [wildcard(TYPE_ATTR)];
  const TEMPLATE_FACTORIES: FactoryMap = Object.fromEntries(
    TEMPLATE_SUBTYPES.map((subType) => [
      `${TYPE_TEMPLATE}.${subType}`,
      (typeId: TypeId, name: string) => new MetaTemplate(typeId, name),
    ]),
  );
  for (const templateDef of defineProviderFromData(TEMPLATE_DEFINITION, TEMPLATE_FACTORIES)) {
    // childRules are kept byte-identical to the pre-FR-033 registration (the attr
    // wildcard is never read by the parser; it IS consumed by the Phase-1b
    // constraint validator and excluded from the registry manifest). A fresh copy
    // per def matches the original semantics.
    templateDef.childRules = [...templateRules];
    registry.register(templateDef);
  }

  // identity — 3 subtypes (primary/secondary/reference; no base — Java doesn't
  // register one).
  // FR-033: the identity provider's declarative definition (vocabulary +
  // per-subtype attr constraints + descriptions) is externalized to
  // spec/metamodel/identity.json, embedded at build into IDENTITY_DEFINITION.
  // defineProviderFromData lowers it to TypeDefinitions; the factory (behavior)
  // stays code via IDENTITY_FACTORIES, dispatching subType→class:
  //   primary → MetaPrimaryIdentity, secondary → MetaSecondaryIdentity,
  //   reference → MetaReferenceIdentity, default → MetaIdentity (fallback).
  // The structural childRules are kept byte-identical to the pre-FR-033
  // registration by post-assigning the same `identityRules` array — they are not
  // modeled in the JSON (which carries attrs only). Attr schemas: all three carry
  // the required @fields; primary adds @generation, secondary @unique, reference
  // @references (required) + @enforce.
  const identityRules = [wildcard(TYPE_ATTR)];
  const IDENTITY_FACTORIES: FactoryMap = Object.fromEntries(
    IDENTITY_SUBTYPES.map((subType) => [
      `${TYPE_IDENTITY}.${subType}`,
      (typeId: TypeId, name: string) =>
        new (IDENTITY_CLASS_MAP.get(subType) ?? MetaIdentity)(typeId, name),
    ]),
  );
  for (const identityDef of defineProviderFromData(IDENTITY_DEFINITION, IDENTITY_FACTORIES)) {
    // childRules are kept byte-identical to the pre-FR-033 registration (the attr
    // wildcard is never read by the parser; it IS consumed by the Phase-1b
    // constraint validator and excluded from the registry manifest). A fresh copy
    // per def matches the original semantics.
    identityDef.childRules = [...identityRules];
    registry.register(identityDef);
  }

  // relationship — 4 subtypes (base/association/aggregation/composition), all
  // backed by the single MetaRelationship node class (no subType→class dispatch).
  // FR-033: the relationship provider's declarative definition (vocabulary +
  // the 7 shared attr constraints + real descriptions + the complex M:N rules
  // prose) is externalized to spec/metamodel/relationship.json, embedded at build
  // into RELATIONSHIP_DEFINITION. defineProviderFromData lowers it to
  // TypeDefinitions; the factory (behavior) stays code via RELATIONSHIP_FACTORIES,
  // mapping every subType → MetaRelationship. The structural childRules are kept
  // byte-identical to the pre-FR-033 registration by post-assigning the same
  // `relationshipRules` array — they are not modeled in the JSON (attrs only).
  const relationshipRules = [wildcard(TYPE_ATTR)];
  const RELATIONSHIP_FACTORIES: FactoryMap = Object.fromEntries(
    RELATIONSHIP_SUBTYPES.map((subType) => [
      `${TYPE_RELATIONSHIP}.${subType}`,
      (typeId: TypeId, name: string) => new MetaRelationship(typeId, name),
    ]),
  );
  for (const relationshipDef of defineProviderFromData(
    RELATIONSHIP_DEFINITION,
    RELATIONSHIP_FACTORIES,
  )) {
    // childRules are kept byte-identical to the pre-FR-033 registration (the attr
    // wildcard is never read by the parser; it IS consumed by the Phase-1b
    // constraint validator and excluded from the registry manifest). A fresh copy
    // per def matches the original semantics.
    relationshipDef.childRules = [...relationshipRules];
    registry.register(relationshipDef);
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
export const coreProviders: readonly MetaDataTypeProvider[] = [coreTypesProvider, dbProvider, docProvider, templateProvider];

/**
 * Register the core metamodel into an existing registry. Thin convenience
 * wrapper over `coreTypesProvider`; prefer `composeRegistry(coreProviders)`.
 */
export function registerCoreTypes(registry: TypeRegistry): void {
  coreTypesProvider.registerTypes(registry);
}
