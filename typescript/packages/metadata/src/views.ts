// Typed views over MetaModel.
//
// MetaModel is the flat data layer — one class, attrs in a Map, children in an
// array. The views in this file add typed accessors and behavior co-located
// with type. They are read-only wrappers; mutation still goes through MetaModel.
//
// Naming follows the metaobjects ecosystem convention (Java/.NET/Python):
//   MetaData (abstract base)
//     ├── MetaRoot           — for the type=metadata root node
//     ├── MetaObject
//     ├── MetaField
//     ├── MetaIdentity
//     ├── MetaRelationship
//     ├── MetaValidator
//     ├── MetaView
//     └── MetaAttr
//
// Construct typed views via the `metaOf(model)` factory.

import type { MetaModel } from "./model.js";
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
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_DB_TABLE_ATTR_NAME,
  TYPE_ORIGIN,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  FIELD_ATTR_DB_COLUMN,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_FK_FIELD,
  RELATIONSHIP_ATTR_JOIN_ENTITY,
  RELATIONSHIP_ATTR_JOIN_FIELDS,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
} from "./constants.js";

// ---------------------------------------------------------------------------
// MetaData — abstract base
// ---------------------------------------------------------------------------

export abstract class MetaData {
  constructor(readonly model: MetaModel) {}

  get name(): string {
    return this.model.name;
  }
  get type(): string {
    return this.model.type;
  }
  get subType(): string {
    return this.model.subType;
  }
  get package(): string | undefined {
    return this.model.package;
  }
  get isAbstract(): boolean {
    return this.model.isAbstract;
  }
  get isArray(): boolean {
    return this.model.isArray;
  }
  fqn(): string {
    return this.model.fqn();
  }

  /** Escape hatch for attrs not exposed as named getters. */
  attr<V = unknown>(name: string): V | undefined {
    return this.model.attr(name) as V | undefined;
  }

  /** All children, returned as typed views (preserves insertion order). */
  children(): MetaData[] {
    return this.model.children().map(metaOf);
  }
}

// ---------------------------------------------------------------------------
// MetaRoot — the type=metadata root node
// ---------------------------------------------------------------------------

export class MetaRoot extends MetaData {
  /** Object entities defined at this root level. */
  objects(): MetaObject[] {
    return this.model
      .children()
      .filter((c) => c.type === TYPE_OBJECT)
      .map((c) => metaOf(c) as MetaObject);
  }

  /** Abstract / package-level fields defined at root (rare; e.g. shared id fields). */
  fields(): MetaField[] {
    return this.model
      .children()
      .filter((c) => c.type === TYPE_FIELD)
      .map((c) => metaOf(c) as MetaField);
  }

  /** Find an object by name. */
  findObject(name: string): MetaObject | undefined {
    const m = this.model.childByTypeAndName(TYPE_OBJECT, name);
    return m ? (metaOf(m) as MetaObject) : undefined;
  }
}

// ---------------------------------------------------------------------------
// MetaObject — entity / value / base classifications
// ---------------------------------------------------------------------------

export class MetaObject extends MetaData {
  get dbTable(): string | undefined {
    const source = this.model.children().find(
      (c) => c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_DB_TABLE,
    );
    const name = source?.attr(SOURCE_DB_TABLE_ATTR_NAME);
    return typeof name === "string" && name !== "" ? name : undefined;
  }

  get javaRuntime(): string | undefined {
    return this.attr<string>("javaRuntime");
  }

  isEntity(): boolean {
    return this.subType === OBJECT_SUBTYPE_ENTITY;
  }

  isValue(): boolean {
    return this.subType === OBJECT_SUBTYPE_VALUE;
  }

  fields(): MetaField[] {
    return this.model
      .children()
      .filter((c) => c.type === TYPE_FIELD)
      .map((c) => metaOf(c) as MetaField);
  }

  identities(): MetaIdentity[] {
    return this.model
      .children()
      .filter((c) => c.type === TYPE_IDENTITY)
      .map((c) => metaOf(c) as MetaIdentity);
  }

  /** Returns the single primary identity, if any (typed as MetaPrimaryIdentity). */
  primaryIdentity(): MetaPrimaryIdentity | undefined {
    return this.identities().find(
      (i): i is MetaPrimaryIdentity => i instanceof MetaPrimaryIdentity,
    );
  }

  /** Secondary identities (typed as MetaSecondaryIdentity). */
  secondaryIdentities(): MetaSecondaryIdentity[] {
    return this.identities().filter(
      (i): i is MetaSecondaryIdentity => i instanceof MetaSecondaryIdentity,
    );
  }

  relationships(): MetaRelationship[] {
    return this.model
      .children()
      .filter((c) => c.type === TYPE_RELATIONSHIP)
      .map((c) => metaOf(c) as MetaRelationship);
  }

  validators(): MetaValidator[] {
    return this.model
      .children()
      .filter((c) => c.type === TYPE_VALIDATOR)
      .map((c) => metaOf(c) as MetaValidator);
  }

  findField(name: string): MetaField | undefined {
    const m = this.model.childByTypeAndName(TYPE_FIELD, name);
    return m ? (metaOf(m) as MetaField) : undefined;
  }
}

// ---------------------------------------------------------------------------
// MetaField — typed accessors for column / validation / FK shape
// ---------------------------------------------------------------------------

export class MetaField extends MetaData {
  get dbColumn(): string | undefined {
    return this.attr<string>(FIELD_ATTR_DB_COLUMN);
  }

  get default(): unknown {
    return this.attr(FIELD_ATTR_DEFAULT);
  }

  get maxLength(): number | undefined {
    return this.attr<number>(FIELD_ATTR_MAX_LENGTH);
  }

  get precision(): number | undefined {
    return this.attr<number>(FIELD_ATTR_PRECISION);
  }

  get scale(): number | undefined {
    return this.attr<number>(FIELD_ATTR_SCALE);
  }

  /** True if `@unique: true` is set on the field itself (column-level unique). */
  get unique(): boolean {
    return this.attr(FIELD_ATTR_UNIQUE) === true;
  }

  /**
   * True if the field is required (NOT NULL).
   *
   * Checks both `@required: true` attr and `validator.required` children —
   * matches the codegen-ts isRequired() semantics.
   */
  get isRequired(): boolean {
    if (this.attr(FIELD_ATTR_REQUIRED) === true) return true;
    for (const c of this.model.children()) {
      if (c.type === TYPE_VALIDATOR && c.subType === VALIDATOR_SUBTYPE_REQUIRED) {
        return true;
      }
    }
    return false;
  }

  validators(): MetaValidator[] {
    return this.model
      .children()
      .filter((c) => c.type === TYPE_VALIDATOR)
      .map((c) => metaOf(c) as MetaValidator);
  }

  /** The typed supertype field if `extends:` resolved, else undefined. */
  resolveSuper(): MetaField | undefined {
    const sup = this.model.superResolved;
    return sup ? (metaOf(sup) as MetaField) : undefined;
  }
}

// ---------------------------------------------------------------------------
// MetaIdentity — common base; subtype-specific accessors live on subclasses
// ---------------------------------------------------------------------------

/** Strongly-typed identity generation strategies. */
export type IdentityGeneration = "increment" | "uuid" | "assigned";

export class MetaIdentity extends MetaData {
  get fields(): string[] {
    const f = this.attr<string[]>(IDENTITY_ATTR_FIELDS);
    return Array.isArray(f) ? f : [];
  }

  /**
   * Whether the identity enforces uniqueness.
   * Defaults to true; explicit `@unique: false` makes it a non-unique index.
   */
  get unique(): boolean {
    return this.attr(IDENTITY_ATTR_UNIQUE) !== false;
  }

  isPrimary(): boolean {
    return this.subType === IDENTITY_SUBTYPE_PRIMARY;
  }

  isSecondary(): boolean {
    return this.subType === IDENTITY_SUBTYPE_SECONDARY;
  }

  isComposite(): boolean {
    return this.fields.length > 1;
  }
}

/**
 * Primary identity (the entity's PK). Always unique by definition.
 * Carries `@generation` (increment / uuid / assigned).
 */
export class MetaPrimaryIdentity extends MetaIdentity {
  get generation(): IdentityGeneration | undefined {
    return this.attr<IdentityGeneration>(IDENTITY_ATTR_GENERATION);
  }
}

/**
 * Secondary identity — a unique or non-unique index on one or more fields.
 * `@generation` does not apply here.
 */
export class MetaSecondaryIdentity extends MetaIdentity {}

// ---------------------------------------------------------------------------
// MetaRelationship — associations between objects
// ---------------------------------------------------------------------------

export class MetaRelationship extends MetaData {
  get cardinality(): string | undefined {
    return this.attr<string>(RELATIONSHIP_ATTR_CARDINALITY);
  }

  /** FQN of the target object (e.g., "acme::vehicle::Car"). */
  get objectRef(): string | undefined {
    return this.attr<string>(RELATIONSHIP_ATTR_OBJECT_REF);
  }

  /** Name of the FK field on the source entity (for one-to-many / many-to-one). */
  get fkField(): string | undefined {
    return this.attr<string>(RELATIONSHIP_ATTR_FK_FIELD);
  }

  /** Join-table entity name for N:M relationships. */
  get joinEntity(): string | undefined {
    return this.attr<string>(RELATIONSHIP_ATTR_JOIN_ENTITY);
  }

  /** Join-table column names for N:M relationships. */
  get joinFields(): string[] {
    const f = this.attr<string[]>(RELATIONSHIP_ATTR_JOIN_FIELDS);
    return Array.isArray(f) ? f : [];
  }
}

// ---------------------------------------------------------------------------
// MetaValidator — common base; subtype-specific accessors live on subclasses
// ---------------------------------------------------------------------------

export class MetaValidator extends MetaData {
  /**
   * Numeric range — shared by length, numeric, and array validators.
   * (Pattern moves to MetaRegexValidator; required validators have no extra attrs.)
   */
  get min(): number | undefined {
    return this.attr<number>(VALIDATOR_ATTR_MIN);
  }

  get max(): number | undefined {
    return this.attr<number>(VALIDATOR_ATTR_MAX);
  }

  isRequired(): boolean {
    return this.subType === VALIDATOR_SUBTYPE_REQUIRED;
  }

  isLength(): boolean {
    return this.subType === VALIDATOR_SUBTYPE_LENGTH;
  }

  isRegex(): boolean {
    return this.subType === VALIDATOR_SUBTYPE_REGEX;
  }
}

/** Required validator (no extra attrs; subtype class exists for instanceof narrowing). */
export class MetaRequiredValidator extends MetaValidator {}

/** Length validator: min/max are string/array length bounds. */
export class MetaLengthValidator extends MetaValidator {}

/** Regex validator: carries the pattern. */
export class MetaRegexValidator extends MetaValidator {
  get pattern(): string | undefined {
    return this.attr<string>(VALIDATOR_ATTR_PATTERN);
  }
}

/** Numeric validator: min/max are value bounds. */
export class MetaNumericValidator extends MetaValidator {}

/** Array validator: min/max are element-count bounds. */
export class MetaArrayValidator extends MetaValidator {}

// ---------------------------------------------------------------------------
// MetaView — UI rendering hints (currently minimal — placeholder for v0.3+)
// ---------------------------------------------------------------------------

export class MetaView extends MetaData {}

// ---------------------------------------------------------------------------
// MetaAttr — when an attribute is materialized as a child node (rare)
// ---------------------------------------------------------------------------

export class MetaAttr extends MetaData {
  get value(): unknown {
    return this.attr("value");
  }
}

// ---------------------------------------------------------------------------
// MetaLayout — object-level UI surfaces (Project E; replaces object-attached
// data-grid view subtype; views are strictly field-level per Java parity).
// ---------------------------------------------------------------------------

export class MetaLayout extends MetaData {}

// ---------------------------------------------------------------------------
// MetaSource — declares where an object's data lives (Project E).
// dbTable / dbView source subtypes declare the SQL table or view name.
// ---------------------------------------------------------------------------

export class MetaSource extends MetaData {
  /** The SQL table or view name (value of @name attr on the source child). */
  get sourceName(): string | undefined {
    return this.attr<string>("name");
  }
}

// ---------------------------------------------------------------------------
// MetaOrigin — field-level provenance (Project E).
// passthrough / aggregate origin subtypes declare how field values are derived.
// ---------------------------------------------------------------------------

export class MetaOrigin extends MetaData {}

// ---------------------------------------------------------------------------
// Factory — dispatch on model.type
// ---------------------------------------------------------------------------

export type AnyMeta =
  | MetaRoot
  | MetaObject
  | MetaField
  | MetaIdentity              // base + subtype-specific (Primary, Secondary)
  | MetaRelationship
  | MetaValidator             // base + subtype-specific (Required, Length, Regex, Numeric, Array)
  | MetaView
  | MetaAttr
  | MetaLayout
  | MetaSource
  | MetaOrigin;

export function metaOf(model: MetaModel): AnyMeta {
  switch (model.type) {
    case TYPE_METADATA:
      return new MetaRoot(model);
    case TYPE_OBJECT:
      return new MetaObject(model);
    case TYPE_FIELD:
      return new MetaField(model);
    case TYPE_ATTR:
      return new MetaAttr(model);
    case TYPE_VALIDATOR:
      // Second-level dispatch — pick the most specific subclass.
      switch (model.subType) {
        case VALIDATOR_SUBTYPE_REQUIRED:
          return new MetaRequiredValidator(model);
        case VALIDATOR_SUBTYPE_LENGTH:
          return new MetaLengthValidator(model);
        case VALIDATOR_SUBTYPE_REGEX:
          return new MetaRegexValidator(model);
        case VALIDATOR_SUBTYPE_NUMERIC:
          return new MetaNumericValidator(model);
        case VALIDATOR_SUBTYPE_ARRAY:
          return new MetaArrayValidator(model);
        default:
          return new MetaValidator(model);
      }
    case TYPE_VIEW:
      return new MetaView(model);
    case TYPE_IDENTITY:
      switch (model.subType) {
        case IDENTITY_SUBTYPE_PRIMARY:
          return new MetaPrimaryIdentity(model);
        case IDENTITY_SUBTYPE_SECONDARY:
          return new MetaSecondaryIdentity(model);
        default:
          return new MetaIdentity(model);
      }
    case TYPE_RELATIONSHIP:
      return new MetaRelationship(model);
    case TYPE_LAYOUT:
      return new MetaLayout(model);
    case TYPE_SOURCE:
      return new MetaSource(model);
    case TYPE_ORIGIN:
      return new MetaOrigin(model);
    default:
      throw new Error(
        `metaOf: unknown metadata type "${model.type}" on model "${model.fqn()}"`,
      );
  }
}
