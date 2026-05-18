// MetaIdentity — concrete node class for type=identity nodes.
// MetaPrimaryIdentity and MetaSecondaryIdentity are co-located subtype classes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
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
