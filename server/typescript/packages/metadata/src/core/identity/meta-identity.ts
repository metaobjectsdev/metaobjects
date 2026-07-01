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
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_REFERENCE_ATTR_ENFORCE,
  IDENTITY_REFERENCE_ATTR_ON_DELETE,
  IDENTITY_REFERENCE_ATTR_ON_UPDATE,
} from "./identity-constants.js";
import type { MetaRoot } from "../../shared/meta-root.js";

/** Strongly-typed identity generation strategies. */
export type IdentityGeneration = "increment" | "uuid" | "assigned";

export class MetaIdentity extends MetaData {
  /** ADR-0039: resolving — @fields may be inherited via extends. */
  get fields(): string[] {
    const f = this.attr(IDENTITY_ATTR_FIELDS);
    return Array.isArray(f) ? (f as string[]) : [];
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
    // ADR-0039: resolving — @generation may be inherited via extends.
    const v = this.attr(IDENTITY_ATTR_GENERATION);
    return typeof v === "string" ? (v as IdentityGeneration) : undefined;
  }
}

/**
 * Secondary identity — always a unique index on one or more fields.
 * Uniqueness is in the type; use `index.lookup` for non-unique indexes.
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
    // ADR-0039: resolving — @references may be inherited via extends.
    const v = this.attr(IDENTITY_REFERENCE_ATTR_REFERENCES);
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
    // ADR-0039: resolving — @enforce may be inherited via extends.
    return this.attr(IDENTITY_REFERENCE_ATTR_ENFORCE) !== false;
  }

  /**
   * Referential action on parent delete, declared directly on the FK-defining
   * reference (cascade / set-null / restrict / no-action). Undefined when not
   * set — callers fall back to a correlated relationship's @onDelete, then the
   * relationship-subtype default. The FK is declared here, so the action may be
   * declared here too rather than only on a sibling relationship node.
   */
  get onDelete(): string | undefined {
    // ADR-0039: resolving — @onDelete may be inherited via extends.
    const v = this.attr(IDENTITY_REFERENCE_ATTR_ON_DELETE);
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /** Referential action on key update, declared directly on the reference. Undefined when not set. */
  get onUpdate(): string | undefined {
    // ADR-0039: resolving — @onUpdate may be inherited via extends.
    const v = this.attr(IDENTITY_REFERENCE_ATTR_ON_UPDATE);
    return typeof v === "string" && v !== "" ? v : undefined;
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
    // targetEntity may be package-qualified (FQN); findObject is keyed by bare
    // name, so fall back to the bare suffix after the last "::". Mirrors the
    // resolveTargetTable fix; without it a cross-package reference resolves no
    // target and the PK column wrongly defaults to "id".
    const targetObj = root.findObject(targetName)
      ?? (targetName.includes("::")
        ? root.findObject(targetName.slice(targetName.lastIndexOf("::") + 2))
        : undefined);
    if (!targetObj) return undefined;

    const primary = targetObj.primaryIdentity();
    // ADR-0039: resolving — the target's @fields may be inherited via extends.
    const fields = primary?.attr(IDENTITY_ATTR_FIELDS) as string | string[] | undefined;
    if (typeof fields === "string") return fields.split(",")[0]!.trim();
    if (Array.isArray(fields) && fields.length > 0) return String(fields[0]).trim();
    return "id";
  }
}
