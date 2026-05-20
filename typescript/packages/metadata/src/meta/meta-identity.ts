// MetaIdentity — concrete node class for type=identity nodes.
// MetaPrimaryIdentity and MetaSecondaryIdentity are co-located subtype classes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
} from "../constants.js";

/** Strongly-typed identity generation strategies. */
export type IdentityGeneration = "increment" | "uuid" | "assigned";

export class MetaIdentity extends MetaData {
  get fields(): string[] {
    const f = this.ownAttr(IDENTITY_ATTR_FIELDS);
    return Array.isArray(f) ? (f as string[]) : [];
  }

  /**
   * Whether the identity enforces uniqueness.
   * Defaults to true; explicit `@unique: false` makes it a non-unique index.
   */
  get unique(): boolean {
    return this.ownAttr(IDENTITY_ATTR_UNIQUE) !== false;
  }

  isPrimary(): boolean {
    return this.subType === IDENTITY_SUBTYPE_PRIMARY;
  }

  isSecondary(): boolean {
    return this.subType === IDENTITY_SUBTYPE_SECONDARY;
  }

  isReference(): boolean {
    return this.subType === IDENTITY_SUBTYPE_REFERENCE;
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
    const v = this.ownAttr(IDENTITY_ATTR_GENERATION);
    return typeof v === "string" ? (v as IdentityGeneration) : undefined;
  }
}

/**
 * Secondary identity — a unique or non-unique index on one or more fields.
 * `@generation` does not apply here.
 */
export class MetaSecondaryIdentity extends MetaIdentity {}

/**
 * Reference identity — a field (or compound field set) on this entity whose
 * value(s) identify an instance of another entity.
 *
 * Maps to: SQL foreign key, document linked reference, graph edge target,
 * OO pointer/reference. Backend-agnostic at the metamodel level.
 *
 * Carries `@references` — either a bare entity name (defaults to that
 * entity's primary identity) or a dotted `Entity.field` or
 * `Entity.fieldA,fieldB` form for explicit field/compound targets.
 */
export class MetaReferenceIdentity extends MetaIdentity {
  /** Raw `@references` attr value, unparsed. */
  get referencesRaw(): string | undefined {
    const v = this.ownAttr(IDENTITY_REFERENCE_ATTR_REFERENCES);
    return typeof v === "string" ? v : undefined;
  }

  /** Target entity name (the bit before the dot, or the whole bare value). */
  get targetEntity(): string | undefined {
    const raw = this.referencesRaw;
    if (raw === undefined) return undefined;
    const dotIdx = raw.indexOf(".");
    return dotIdx === -1 ? raw : raw.slice(0, dotIdx);
  }

  /**
   * Target field names. Empty array means "use the target's primary identity"
   * (the bare-entity form). For dotted forms, returns the field(s) after the
   * dot (comma-split, trimmed).
   */
  get targetFields(): string[] {
    const raw = this.referencesRaw;
    if (raw === undefined) return [];
    const dotIdx = raw.indexOf(".");
    if (dotIdx === -1) return [];
    return raw
      .slice(dotIdx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}
