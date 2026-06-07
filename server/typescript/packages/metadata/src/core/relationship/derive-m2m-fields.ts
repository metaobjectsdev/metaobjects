// M:N junction FK derivation — the single source of truth for which junction
// columns are the SOURCE side and the TARGET side of a many-to-many relationship.
//
// A M:N relationship (`@cardinality: "many"`, `@objectRef: <target>`,
// `@through: <junction>`) does NOT restate its FK columns. They are derived from
// the junction entity's two `identity.reference` children — one resolving to the
// source entity, one to the target — exactly as 1:N FK direction is declared
// (`find-reference.ts` is the analogous SSOT).
//
// Three modes (see the FR-018 design):
//   1. Hetero (source != target): the reference resolving to the source entity
//      gives sourceField; the one resolving to the target gives targetField.
//   2. Directed self-join (source == target, @sourceRefField set): both
//      references resolve to the same entity, so @sourceRefField names the
//      source-side FK field; the OTHER reference is the target side.
//   3. Symmetric self-join (source == target, @symmetric: true): undirected; the
//      two references are taken in declaration order (sourceField = first,
//      targetField = second). Resolution unions both at read time.
// Ambiguous (source == target, neither @sourceRefField nor @symmetric) → throw.

import type { MetaObject } from "../object/meta-object.js";
import type { MetaRoot } from "../../shared/meta-root.js";
import type { MetaRelationship } from "./meta-relationship.js";
import type { MetaReferenceIdentity } from "../identity/meta-identity.js";
import { stripPackage } from "../../naming.js";

/** Thrown when a M:N relationship's junction FK fields cannot be derived. */
export class M2MDerivationError extends Error {
  readonly code = "ERR_INVALID_RELATIONSHIP";
  constructor(message: string) {
    super(message);
    this.name = "M2MDerivationError";
  }
}

export interface M2MFields {
  /** The junction FK field holding the source-entity key. */
  readonly sourceField: string;
  /** The junction FK field holding the target-entity key. */
  readonly targetField: string;
}

/** First @fields entry of a reference (the physical FK column on the junction). */
function refFkField(ref: MetaReferenceIdentity): string | undefined {
  return ref.fields[0];
}

/**
 * Derive the source/target junction FK fields for a M:N relationship.
 *
 * @param rel     the M:N relationship (carries @objectRef + @through + optional
 *                @sourceRefField / @symmetric)
 * @param source  the entity declaring `rel`
 * @param root    the loaded model root (to find the junction entity)
 * @throws M2MDerivationError when the junction is missing/malformed or the
 *         self-join is ambiguous.
 */
export function deriveM2MFields(
  rel: MetaRelationship,
  source: MetaObject,
  root: MetaRoot,
): M2MFields {
  const throughName = rel.through;
  if (throughName === undefined) {
    throw new M2MDerivationError(
      `relationship "${source.name}.${rel.name}" is missing @through (required for M:N derivation)`,
    );
  }
  const junction = root.findObject(throughName);
  if (junction === undefined) {
    throw new M2MDerivationError(
      `relationship "${source.name}.${rel.name}" @through "${throughName}" does not resolve to an entity`,
    );
  }

  const targetName = rel.objectRef;
  if (targetName === undefined) {
    throw new M2MDerivationError(
      `relationship "${source.name}.${rel.name}" is missing @objectRef (the M:N target)`,
    );
  }

  const refs = junction.referenceIdentities();
  if (refs.length !== 2) {
    throw new M2MDerivationError(
      `junction "${throughName}" for relationship "${source.name}.${rel.name}" must declare exactly two ` +
        `identity.reference children (found ${refs.length})`,
    );
  }

  const isSelfJoin = stripPackage(targetName) === source.name;

  if (!isSelfJoin) {
    // Hetero: match each reference by the entity it resolves to.
    const sourceRef = refs.find((r) => r.targetEntity !== undefined && stripPackage(r.targetEntity) === source.name);
    const targetRef = refs.find((r) => r.targetEntity !== undefined && stripPackage(r.targetEntity) === stripPackage(targetName));
    const sourceField = sourceRef ? refFkField(sourceRef) : undefined;
    const targetField = targetRef ? refFkField(targetRef) : undefined;
    if (sourceField === undefined || targetField === undefined) {
      throw new M2MDerivationError(
        `junction "${throughName}" for relationship "${source.name}.${rel.name}" must declare one ` +
          `identity.reference to "${source.name}" and one to "${stripPackage(targetName)}"`,
      );
    }
    return { sourceField, targetField };
  }

  // Self-join: both references resolve to the same entity.
  if (rel.symmetric) {
    // Undirected: take references in declaration order; union happens at read time.
    const a = refFkField(refs[0]!);
    const b = refFkField(refs[1]!);
    if (a === undefined || b === undefined) {
      throw new M2MDerivationError(
        `symmetric junction "${throughName}" for "${source.name}.${rel.name}" has a reference with no @fields`,
      );
    }
    return { sourceField: a, targetField: b };
  }

  const sourceRefField = rel.sourceRefField;
  if (sourceRefField === undefined) {
    throw new M2MDerivationError(
      `self-join relationship "${source.name}.${rel.name}" through "${throughName}" is ambiguous: ` +
        `set @sourceRefField (directed) or @symmetric (undirected)`,
    );
  }

  // Directed self-join: @sourceRefField names the source-side FK; the other ref is the target.
  const sourceRef = refs.find((r) => refFkField(r) === sourceRefField);
  if (sourceRef === undefined) {
    throw new M2MDerivationError(
      `@sourceRefField "${sourceRefField}" on "${source.name}.${rel.name}" does not match any ` +
        `identity.reference FK field on junction "${throughName}"`,
    );
  }
  const targetRef = refs.find((r) => r !== sourceRef);
  const targetField = targetRef ? refFkField(targetRef) : undefined;
  if (targetField === undefined) {
    throw new M2MDerivationError(
      `junction "${throughName}" for "${source.name}.${rel.name}" has no distinct target-side reference`,
    );
  }
  return { sourceField: sourceRefField, targetField };
}
