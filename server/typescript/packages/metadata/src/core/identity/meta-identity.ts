// MetaIdentity — concrete node class for type=identity nodes.
// MetaPrimaryIdentity and MetaSecondaryIdentity are co-located subtype classes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_REFERENCE_ATTR_ENFORCE,
} from "./identity-constants.js";
import type { MetaRoot } from "../../shared/meta-root.js";

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
   * Whether the reference is physically enforced by the backend.
   * Default true (hard FK constraint emitted). Explicit `@enforce: false`
   * marks the reference as logical-only — drizzle-schema skips `.references()`
   * and migrate-ts's expected schema omits the FK descriptor. relations()
   * block and projection JOIN inference are unaffected.
   */
  get enforce(): boolean {
    return this.ownAttr(IDENTITY_REFERENCE_ATTR_ENFORCE) !== false;
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

  /**
   * Resolve the target field on the referenced entity that this reference
   * points at. Priority: explicit dotted-form `@references: "Entity.field"`
   * override → target entity's primary identity field → "id" fallback.
   *
   * Returns undefined only if the target entity cannot be found in `root`.
   * Centralizes the FK-target resolution rule used by projection view DDL,
   * Drizzle schema emit, and migration schema comparison.
   */
  resolvedTargetPkField(root: MetaRoot): string | undefined {
    const explicit = this.targetFields[0];
    if (explicit !== undefined) return explicit;

    const targetName = this.targetEntity;
    if (targetName === undefined) return undefined;
    const targetObj = root.findObject(targetName);
    if (!targetObj) return undefined;

    const primary = targetObj.primaryIdentity();
    const fields = primary?.ownAttr(IDENTITY_ATTR_FIELDS) as string | string[] | undefined;
    if (typeof fields === "string") return fields.split(",")[0]!.trim();
    if (Array.isArray(fields) && fields.length > 0) return String(fields[0]).trim();
    return "id";
  }
}
