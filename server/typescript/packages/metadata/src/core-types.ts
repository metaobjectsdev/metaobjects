// registerCoreTypes() — Java's 7 base types (plus metadata wrapper) and their subtypes
import { TypeId, type AttrSchema, type ChildRule, type TypeDefinition, TypeRegistry } from "./registry.js";
import type { MetaDataTypeProvider } from "./provider.js";
import { dbProvider } from "./persistence/db/db-provider.js";
import { docProvider } from "./core/documentation/doc-provider.js";
import { promptProvider } from "./template/prompt-provider.js";
import { uiProvider } from "./presentation/ui/ui-provider.js";
import { uiWebProvider } from "./presentation/ui-web/ui-web-provider.js";
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
import "./core/attr/meta-attr-expression.js";
import "./core/attr/meta-attr-int-map.js";
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
import { MetaOrigin, MetaPassthroughOrigin, MetaAggregateOrigin, MetaCollectionOrigin, MetaComputedOrigin, MetaFirstOrigin } from "./persistence/origin/meta-origin.js";
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
import { MetaIndex } from "./core/index/meta-index.js";
import { INDEX_DEFINITION } from "./core/index/index-definition.embedded.js";
import { INDEX_SUBTYPES } from "./core/index/index-constants.js";
import { MetaRequirement } from "./core/requirement/meta-requirement.js";
import { REQUIREMENT_DEFINITION } from "./core/requirement/requirement-definition.embedded.js";
import { REQUIREMENT_SUBTYPES } from "./core/requirement/requirement-constants.js";
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
  TYPE_INDEX,
  TYPE_REQUIREMENT,
  SUBTYPE_ROOT,
} from "./shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "./shared/structural.js";
import { OBJECT_SUBTYPES, OBJECT_SUBTYPE_ENTITY } from "./core/object/object-constants.js";
import { FIELD_SUBTYPES, FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP, FIELD_ATTR_OBJECT_REF } from "./core/field/field-constants.js";
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
  IDENTITY_REFERENCE_ATTR_REFERENCES,
} from "./core/identity/identity-constants.js";
import { RELATIONSHIP_SUBTYPES, RELATIONSHIP_ATTR_OBJECT_REF } from "./core/relationship/relationship-constants.js";
import { LAYOUT_SUBTYPES } from "./presentation/layout/layout-constants.js";
import { SOURCE_SUBTYPES } from "./persistence/source/source-constants.js";
import {
  ORIGIN_SUBTYPES,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COLLECTION,
  ORIGIN_SUBTYPE_COMPUTED,
  ORIGIN_SUBTYPE_FIRST,
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
  [ORIGIN_SUBTYPE_COMPUTED, MetaComputedOrigin],
  [ORIGIN_SUBTYPE_FIRST, MetaFirstOrigin],
]);

// ATTR_CLASS_MAP + attrClassFor live in the leaf module ./attr-class-map.ts
// (imported above) so MetaData.setAttr can resolve an attr subclass without
// importing this module — that import created a module-eval cycle. They are
// re-exported from the package index for the same public surface.

function registerCoreTypeDefs(registry: TypeRegistry): void {
  // metadata — 1 subtype (the document root: metadata.root). FR-033 S1-simple:
  // the any-attr wildcard child rule is DROPPED (strict/fail-closed — a document
  // root holds structural nodes, never bare attrs); the genuinely-open structural
  // wildcards (object/field/validator/template) are KEPT — a root legitimately
  // holds arbitrary nodes of those types.
  registry.register(
    def(TYPE_METADATA, SUBTYPE_ROOT, "Root metadata document", [
      wildcard(TYPE_OBJECT),
      wildcard(TYPE_FIELD),
      wildcard(TYPE_VALIDATOR),
      wildcard(TYPE_TEMPLATE),
      // Capability requirements are declared beside the entities they describe.
      wildcard(TYPE_REQUIREMENT),
    ], MetaRoot),
  );

  // object — 4 subtypes. FR-033 S1-object: the object provider's declarative
  // definition (vocabulary + per-subtype attr constraints + the structural child
  // rules + real descriptions + the ADR-0028 taxonomy rule prose) is externalized
  // to spec/metamodel/object.json, embedded at build into OBJECT_DEFINITION. The
  // strict per-subtype model lives entirely in the JSON now: object.base carries
  // the INTERSECTION of every subtype's structural children (field/identity/
  // validator/layout/source); each concrete subtype sets extendsBase:true
  // (composeWithBase folds the base childRules in at registration) and adds ONLY
  // its subtype-specific children — value adds relationship; entity adds
  // relationship + template (templates may be co-located) + the FR-014 TPH attrs
  // @discriminator/@discriminatorValue (an entity-inheritance concept — a value
  // object / derived projection carries no discriminator); projection inherits the
  // base intersection ONLY (NO relationship — derivation is via @via, not a
  // relationship child — and NO template). The "any attr" wildcard child rule is
  // DROPPED (strict/fail-closed) and childRules are NO LONGER post-assigned in
  // code. defineProviderFromData lowers it to TypeDefinitions; the factory
  // (behavior) stays code via OBJECT_FACTORIES, mapping every subType → MetaObject.
  const OBJECT_FACTORIES: FactoryMap = Object.fromEntries(
    OBJECT_SUBTYPES.map((subType) => [
      `${TYPE_OBJECT}.${subType}`,
      (typeId: TypeId, name: string) => new MetaObject(typeId, name),
    ]),
  );
  for (const objectDef of defineProviderFromData(OBJECT_DEFINITION, OBJECT_FACTORIES)) {
    registry.register(objectDef);
  }

  // field — 15 subtypes. FR-033 S1-field-B: the field provider's declarative
  // definition (vocabulary + per-subtype attr constraints + the structural child
  // rules + descriptions + rule prose) is externalized to spec/metamodel/field.json,
  // embedded at build into FIELD_DEFINITION. The strict per-subtype model lives
  // entirely in the JSON now: field.base carries the universal core attrs
  // (@required/@readOnly/@default/@unique) + the open validator/view/origin child
  // rules; each concrete subtype sets extendsBase:true (composeWithBase folds the
  // base attrs+childRules in at registration) and adds ONLY its subtype-specific
  // attrs (@maxLength→string, @precision/@scale→decimal, @currency→currency,
  // @objectRef→object, @values/@provided→enum). The "any attr" wildcard child rule
  // is DROPPED (strict/fail-closed) and childRules are NO LONGER post-assigned in
  // code. defineProviderFromData lowers it to TypeDefinitions; the factory
  // (behavior) stays code via FIELD_FACTORIES.
  //
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
  // FR-033 S1-simple: validator is an ATTR-ONLY type — its only children are its
  // declared named attrs (no structural children, ever). The "any attr" wildcard
  // child rule is DROPPED (strict/fail-closed); defineProviderFromData leaves
  // childRules EMPTY. The named attrs still enforce strictly via attr-schema-
  // validate (ERR_UNKNOWN_ATTR); a misplaced STRUCTURAL child is now
  // ERR_CHILD_NOT_ALLOWED. Attr schemas: base + length/numeric/array read @min/@max
  // via this.attr(VALIDATOR_ATTR_MIN/MAX) (ADR-0039 resolving); regex also reads
  // @pattern; required has no extra attrs.
  const VALIDATOR_FACTORIES: FactoryMap = Object.fromEntries(
    VALIDATOR_SUBTYPES.map((subType) => [
      `${TYPE_VALIDATOR}.${subType}`,
      (typeId: TypeId, name: string) =>
        new (VALIDATOR_CLASS_MAP.get(subType) ?? MetaValidator)(typeId, name),
    ]),
  );
  for (const validatorDef of defineProviderFromData(VALIDATOR_DEFINITION, VALIDATOR_FACTORIES)) {
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
  // other 12 subtypes have none. FR-033 S1-simple: view is an ATTR-ONLY type —
  // the "any attr" wildcard child rule is DROPPED (strict/fail-closed) and
  // childRules are left EMPTY; the declared named attrs still enforce strictly,
  // a misplaced STRUCTURAL child is now ERR_CHILD_NOT_ALLOWED.
  const VIEW_FACTORIES: FactoryMap = Object.fromEntries(
    VIEW_SUBTYPES.map((subType) => [
      `${TYPE_VIEW}.${subType}`,
      (typeId: TypeId, name: string) => new MetaView(typeId, name),
    ]),
  );
  for (const viewDef of defineProviderFromData(VIEW_DEFINITION, VIEW_FACTORIES)) {
    registry.register(viewDef);
  }

  // layout — object-level UI surfaces (data grids, forms, tabs, cards).
  // FR-033: the layout provider's declarative definition (2 subtypes — base +
  // dataGrid — vocabulary + the 6 dataGrid attr constraints + descriptions) is
  // externalized to spec/metamodel/layout.json, embedded at build into
  // LAYOUT_DEFINITION. defineProviderFromData lowers it to TypeDefinitions; the
  // factory (behavior) stays code via LAYOUT_FACTORIES — every subtype maps to
  // the single MetaLayout class (layouts are config carriers, no per-subtype
  // behavior). FR-033 S1-simple: layout is an ATTR-ONLY type — like views,
  // layouts are config carriers — the "any attr" wildcard child rule is DROPPED
  // (strict/fail-closed) and childRules are left EMPTY; the declared named attrs
  // still enforce strictly, a misplaced STRUCTURAL child is now
  // ERR_CHILD_NOT_ALLOWED.
  const LAYOUT_FACTORIES: FactoryMap = Object.fromEntries(
    LAYOUT_SUBTYPES.map((subType) => [
      `${TYPE_LAYOUT}.${subType}`,
      (typeId: TypeId, name: string) => new MetaLayout(typeId, name),
    ]),
  );
  for (const layoutDef of defineProviderFromData(LAYOUT_DEFINITION, LAYOUT_FACTORIES)) {
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
  // FR-033 S1-simple: source is an ATTR-ONLY type (configuration carrier, never
  // nested structure) — the "any attr" wildcard child rule is DROPPED (strict/
  // fail-closed) and childRules are left EMPTY; the per-subtype @table/@kind/
  // @role/@schema attrs (from dbProvider) still enforce strictly, a misplaced
  // STRUCTURAL child is now ERR_CHILD_NOT_ALLOWED.
  const SOURCE_FACTORIES: FactoryMap = Object.fromEntries(
    SOURCE_SUBTYPES.map((subType) => [
      `${TYPE_SOURCE}.${subType}`,
      (typeId: TypeId, name: string) => new MetaSource(typeId, name),
    ]),
  );
  for (const sourceDef of defineProviderFromData(SOURCE_DEFINITION, SOURCE_FACTORIES)) {
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
  // FR-033 S1-simple: origin is an ATTR-ONLY type — the "any attr" wildcard child
  // rule is DROPPED (strict/fail-closed) and childRules are left EMPTY; the named
  // attrs still enforce strictly, a misplaced STRUCTURAL child is now
  // ERR_CHILD_NOT_ALLOWED. Attr schemas: base has none; passthrough adds @from
  // (required) + @via; aggregate adds @agg (required) + @of (required) + @via;
  // collection adds @via (required).
  const ORIGIN_FACTORIES: FactoryMap = Object.fromEntries(
    ORIGIN_SUBTYPES.map((subType) => [
      `${TYPE_ORIGIN}.${subType}`,
      (typeId: TypeId, name: string) =>
        new (ORIGIN_CLASS_MAP.get(subType) ?? MetaOrigin)(typeId, name),
    ]),
  );
  for (const originDef of defineProviderFromData(ORIGIN_DEFINITION, ORIGIN_FACTORIES)) {
    registry.register(originDef);
  }

  // template — renderable text artifacts (FR-004) + tool-call envelopes
  // (ADR-0011). Four subtypes: base + prompt + output + toolcall; attr-only
  // children. A single MetaTemplate class backs every subtype (mirrors source);
  // per-subtype attr schemas drive validation (prompt + output require
  // @payloadRef + @textRef + @format closed enum; prompt adds the LLM overlay
  // plus the ADR-0052 inbound half (@responseRef/@promptStyle/@responseFormat);
  // output adds @kind/email part-refs and is OUTBOUND ONLY; toolcall has its own
  // set — @toolName + @payloadRef, no @textRef requirement since toolcalls have no
  // renderable body).
  // FR-033: the template provider's declarative definition (the 4-subtype
  // vocabulary + the full per-subtype attr constraints — incl. @format/@promptStyle/
  // @responseFormat/@kind closed-enum allowedValues + defaults + required
  // @payloadRef/@toolName —
  // + real descriptions + the FR-004/ADR-0011 rules prose) is externalized to
  // spec/metamodel/template.json, embedded at build into TEMPLATE_DEFINITION.
  // defineProviderFromData lowers it to TypeDefinitions; the factory (behavior)
  // stays code via TEMPLATE_FACTORIES, mapping every subType → MetaTemplate.
  // FR-033 S2: template's CORE registration carries NO own attrs (children == []);
  // the per-subtype type attrs (@payloadRef/@textRef/@format/@kind/…) on prompt/
  // output/toolcall are contributed by a SEPARATE provider (promptProvider,
  // template/prompt-provider) via registry.extend(TYPE_TEMPLATE, sub, ...). With
  // those attrs re-homed, template is now an ATTR-ONLY type and the "any attr"
  // wildcard child rule is DROPPED (strict completion — like view/layout/source);
  // childRules are left EMPTY, so a misplaced STRUCTURAL child is now
  // ERR_CHILD_NOT_ALLOWED and a non-declared attr is ERR_UNKNOWN_ATTR. Vendor
  // toolcall attrs stay extensible via consumer registry.extend (ADR-0011).
  const TEMPLATE_FACTORIES: FactoryMap = Object.fromEntries(
    TEMPLATE_SUBTYPES.map((subType) => [
      `${TYPE_TEMPLATE}.${subType}`,
      (typeId: TypeId, name: string) => new MetaTemplate(typeId, name),
    ]),
  );
  for (const templateDef of defineProviderFromData(TEMPLATE_DEFINITION, TEMPLATE_FACTORIES)) {
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
  // FR-033 S1-simple: identity is an ATTR-ONLY type — the "any attr" wildcard
  // child rule is DROPPED (strict/fail-closed) and childRules are left EMPTY; the
  // named attrs still enforce strictly, a misplaced STRUCTURAL child is now
  // ERR_CHILD_NOT_ALLOWED. Attr schemas: all three carry the required @fields;
  // primary adds @generation, secondary @unique, reference @references (required)
  // + @enforce.
  const IDENTITY_FACTORIES: FactoryMap = Object.fromEntries(
    IDENTITY_SUBTYPES.map((subType) => [
      `${TYPE_IDENTITY}.${subType}`,
      (typeId: TypeId, name: string) =>
        new (IDENTITY_CLASS_MAP.get(subType) ?? MetaIdentity)(typeId, name),
    ]),
  );
  for (const identityDef of defineProviderFromData(IDENTITY_DEFINITION, IDENTITY_FACTORIES)) {
    registry.register(identityDef);
  }

  // relationship — 4 subtypes (base/association/aggregation/composition), all
  // backed by the single MetaRelationship node class (no subType→class dispatch).
  // FR-033: the relationship provider's declarative definition (vocabulary +
  // the 7 shared attr constraints + real descriptions + the complex M:N rules
  // prose) is externalized to spec/metamodel/relationship.json, embedded at build
  // into RELATIONSHIP_DEFINITION. defineProviderFromData lowers it to
  // TypeDefinitions; the factory (behavior) stays code via RELATIONSHIP_FACTORIES,
  // mapping every subType → MetaRelationship. FR-033 S1-simple: relationship is an
  // ATTR-ONLY type — the "any attr" wildcard child rule is DROPPED (strict/fail-
  // closed) and childRules are left EMPTY; the named attrs still enforce strictly,
  // a misplaced STRUCTURAL child is now ERR_CHILD_NOT_ALLOWED.
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
    registry.register(relationshipDef);
  }

  // index — 1 subtype (lookup). Non-unique lookup indexes for query-performance.
  // Distinct from identity.secondary (which enforces uniqueness). A single
  // MetaIndex class backs the lookup subtype; physical attrs (@orders/@expr/
  // @where/@using) are contributed by the db provider via registry.extend.
  const INDEX_FACTORIES: FactoryMap = Object.fromEntries(
    INDEX_SUBTYPES.map((subType) => [
      `${TYPE_INDEX}.${subType}`,
      (typeId: TypeId, name: string) => new MetaIndex(typeId, name),
    ]),
  );
  for (const indexDef of defineProviderFromData(INDEX_DEFINITION, INDEX_FACTORIES)) {
    registry.register(indexDef);
  }

  // requirement — 2 subtypes. The axis is CHECK POLARITY, a genuine behaviour
  // difference (ADR-0037 §2): `functional` is checked by EXISTENCE (nothing
  // implements it -> fail), `architectural` by UNIVERSALITY (something violates
  // it -> fail). Registered rather than hand-parsed because the capability
  // ledger IS a metadata model: a closed status enum and a list of FQN
  // references to model nodes are exactly `allowedValues` plus reference
  // resolution, both of which this registry already owns (ruling amendment 3).
  const REQUIREMENT_FACTORIES: FactoryMap = Object.fromEntries(
    REQUIREMENT_SUBTYPES.map((subType) => [
      `${TYPE_REQUIREMENT}.${subType}`,
      (typeId: TypeId, name: string) => new MetaRequirement(typeId, name),
    ]),
  );
  for (const reqDef of defineProviderFromData(REQUIREMENT_DEFINITION, REQUIREMENT_FACTORIES)) {
    registry.register(reqDef);
  }

  // Declare the core cross-references ON their TypeDefinitions, so the loader's
  // registry-derived validation resolves them generically (a dangling target fails the
  // load). Set on the concrete subtypes the parser produces. (Production moves these into
  // the embedded spec/metamodel JSON once every port's spec reader carries the field.)
  for (const subType of RELATIONSHIP_SUBTYPES) {
    const def = registry.find(TYPE_RELATIONSHIP, subType);
    if (def) {
      def.references = [
        { attr: RELATIONSHIP_ATTR_OBJECT_REF, targetType: TYPE_OBJECT, errorCode: "ERR_INVALID_RELATIONSHIP" },
      ];
    }
  }
  // NOTE: @implementedBy is deliberately NOT declared as a loader `references`
  // descriptor. That pass always ERRORS on an unresolved target, and a
  // requirement with status `planned` names nodes that do not exist YET, so declaring
  // nodes that are GONE — declaring it here would make the entries that carry
  // the mechanism's only controlled evidence fail to load. The loader owns what
  // is unconditional (the status enum, shape, levels); `meta verify` owns the
  // status-conditional resolution, where the severity actually depends on data.
  const idRefDef = registry.find(TYPE_IDENTITY, IDENTITY_SUBTYPE_REFERENCE);
  if (idRefDef) {
    idRefDef.references = [
      {
        attr: IDENTITY_REFERENCE_ATTR_REFERENCES,
        targetType: TYPE_OBJECT,
        dottedFieldPath: true,
        errorCode: "ERR_INVALID_REFERENCE",
      },
    ];
  }
  // ADR-0042 — a field.object / field.map @objectRef must resolve (a dangling
  // target fails the load, closing the gap that surfaced downstream as a
  // misleading ERR_VAR_NOT_ON_PAYLOAD; #191). The required-attr pass owns
  // absence (ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF); this descriptor fires only
  // when @objectRef is present but resolves to nothing → ERR_UNRESOLVED_OBJECT_REF.
  for (const subType of [FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP]) {
    const def = registry.find(TYPE_FIELD, subType);
    if (def) {
      def.references = [
        { attr: FIELD_ATTR_OBJECT_REF, targetType: TYPE_OBJECT, errorCode: "ERR_UNRESOLVED_OBJECT_REF" },
      ];
    }
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

/** The default provider bundle — core metamodel types plus the five concern
 *  providers (DB-domain attrs, documentation common-attrs, prompt/AI, the
 *  UI/query-surface markers, and the TS-web presentation view attrs).
 *  FR-033 S1-field-A re-homed the field's filter/sort/teaching/extract/storage
 *  attrs out of core into db/ui/prompt; the composed set is unchanged. uiWebProvider
 *  is TS-only (the non-TS ports mirror its spec file but never apply it — see
 *  presentation/ui-web/ui-web-provider.ts). Spread it to add more:
 *  `[...coreProviders, mine]`. */
export const coreProviders: readonly MetaDataTypeProvider[] = [
  coreTypesProvider,
  dbProvider,
  docProvider,
  promptProvider,
  uiProvider,
  uiWebProvider,
];

/**
 * Register the core metamodel into an existing registry. Thin convenience
 * wrapper over `coreTypesProvider`; prefer `composeRegistry(coreProviders)`.
 */
export function registerCoreTypes(registry: TypeRegistry): void {
  coreTypesProvider.registerTypes(registry);
}
