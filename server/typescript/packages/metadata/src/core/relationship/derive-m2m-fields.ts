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
//
// "source" above means the relationship's SUBJECT, and under `extends` there are two
// legitimate names for it. Every caller walks the RESOLVING `obj.relationships()`
// (codegen-ts's relation-resolver, runtime-ts's n2m-resolver, docs-site's link-graph)
// and passes the entity it is ITERATING, which for an inherited relationship is not
// the one that declared it. So the DECLARING entity is resolved here from `rel.parent`
// (same shape as the #368 loader fix, validation-passes' `declaringEntity = rel.parent
// ?? obj`), and the passed `source` is kept alongside it rather than discarded: a
// junction FK usually references the CONCRETE entity, because the abstract base has no
// table, while @objectRef on an inherited self-join names the base. Both are accepted,
// for the self-join classification and the hetero reference match alike. `source` is
// also the fallback when `rel` has no entity parent, which keeps the exported signature
// unchanged. Not covered: a junction reference naming an entity strictly BETWEEN the
// base and the navigating entity in a deeper hierarchy.
//
// The subject comparison is made on RESOLVED OBJECT IDENTITY, not on stripped
// short names, matching the Java reference (M2MFields.java). Bare-name equality
// cannot tell `a::NodeBase` from `b::NodeBase`, so once the subject set held two
// names a genuine CROSS-PACKAGE hetero M:N whose target shares a short name with
// the subject read as a self-join and refused to derive. Scoped deliberately to
// this one predicate — every other name comparison in this file is untouched.

import type { MetaObject } from "../object/meta-object.js";
import type { MetaRoot } from "../../shared/meta-root.js";
import type { MetaRelationship } from "./meta-relationship.js";
import type { MetaReferenceIdentity } from "../identity/meta-identity.js";
import { stripPackage } from "../../naming.js";
import { resolveObjectRef } from "../../naming-refs.js";
import { TYPE_OBJECT } from "../../shared/base-types.js";
import { PACKAGE_SEPARATOR } from "../../shared/structural.js";

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
 * The root entity a reference name denotes, or undefined — resolved by the ONE
 * matcher the loader uses (`resolveObjectRef`, ADR-0041/0042): a fully-qualified
 * name binds exactly on its resolution key, a bare name binds in the REFERRER's
 * package.
 *
 * This exists so the SUBJECT comparison below can be made on object IDENTITY.
 * A bare-name compare cannot tell `a::NodeBase` from `b::NodeBase`, which made a
 * genuine cross-package hetero M:N read as a self-join the moment the subject
 * set held two names — and the first-match-wins bare arm this used to carry
 * (Java's deferred #174) bound a bare name to whichever same-short-named entity
 * happened to load first, which is load-ORDER dependence, not a naming rule.
 */
function findEntity(
  root: MetaRoot,
  name: string | undefined,
  referrerPkg: string,
): MetaObject | undefined {
  if (name === undefined || name === "") return undefined;
  // ADR-0041/0042 through the single resolveObjectRef matcher — an FQN resolves
  // exactly on its resolution key, a BARE name resolves in the REFERRER's
  // package. The bare arm used to be `objects().find(o => o.name === bare)`,
  // which took whichever same-short-named entity loaded first: a bare
  // `@objectRef: "Tag"` on an abstract base in package `base` bound to
  // `acme::Tag` merely because the acme source was read first. Callers pass the
  // referrer that owns the name they are resolving — the DECLARING entity for
  // the relationship's own @objectRef, the JUNCTION for its references' —
  // because those are different packages whenever a base is inherited across one.
  return resolveObjectRef(root, name, referrerPkg).node as MetaObject | undefined;
}

/**
 * Derive the source/target junction FK fields for a M:N relationship.
 *
 * @param rel     the M:N relationship (carries @objectRef + @through + optional
 *                @sourceRefField / @symmetric)
 * @param source  the entity the caller is navigating from. Accepted alongside
 *                `rel.parent` as a name for the relationship's subject, and used
 *                as the declaring entity when `rel` has no entity parent.
 * @param root    the loaded model root (to find the junction entity)
 * @throws M2MDerivationError when the junction is missing/malformed or the
 *         self-join is ambiguous.
 */
export function deriveM2MFields(
  rel: MetaRelationship,
  source: MetaObject,
  root: MetaRoot,
): M2MFields {
  // The entity that DECLARES `rel` — see the header note. `rel.parent` is the
  // owning entity for both an own declaration and an inherited one (an unmodified
  // inherited child is the SAME node object, reused in place by
  // MetaData._effectiveChildren; an override is a genuinely different node whose
  // parent is the overriding entity, which is also correct).
  const relParent = rel.parent;
  const declaringEntity: MetaObject =
    relParent !== undefined && relParent.type === TYPE_OBJECT
      ? (relParent as MetaObject)
      : source;

  const throughName = rel.through;
  if (throughName === undefined) {
    throw new M2MDerivationError(
      `relationship "${declaringEntity.name}.${rel.name}" is missing @through (required for M:N derivation)`,
    );
  }
  // ADR-0041/0042 — resolve @through through the SAME matcher the loader uses
  // (resolveObjectRef, via validation-passes' _findObject): an FQN resolves
  // exactly on its resolution key, a bare name resolves package-locally.
  //
  // This used to be `root.findObject(fqn)` with a fall back to the bare suffix
  // after the last "::". findObject is keyed by BARE name, so the FQN lookup
  // always missed and the fallback took the FIRST entity with that short name —
  // the wrong package's whenever two share one. `xpkg-m2n-collision` is exactly
  // that model (`xpkg::store::AccountLink` and `xpkg::partner::AccountLink`),
  // and it silently derived against the partner junction, whose references point
  // nowhere near the navigating entity. The pairing then failed, so a valid
  // cross-package M:N emitted no traversal route in TS and C# and failed the
  // build in Java, Kotlin and Python.
  //
  // Note findEntity() below was ALREADY FQN-exact for the same reason (see its
  // doc comment). The two halves of one function disagreed about how a
  // package-qualified name resolves; only the junction half was wrong.
  const referrerPkg = declaringEntity.package ?? declaringEntity.fileDefaultPackage ?? "";
  const junction = resolveObjectRef(root, throughName, referrerPkg).node as MetaObject | undefined;
  if (junction === undefined) {
    throw new M2MDerivationError(
      `relationship "${declaringEntity.name}.${rel.name}" @through "${throughName}" does not resolve to an entity`,
    );
  }

  const targetName = rel.objectRef;
  if (targetName === undefined) {
    throw new M2MDerivationError(
      `relationship "${declaringEntity.name}.${rel.name}" is missing @objectRef (the M:N target)`,
    );
  }

  const refs = junction.referenceIdentities();
  if (refs.length !== 2) {
    throw new M2MDerivationError(
      `junction "${throughName}" for relationship "${declaringEntity.name}.${rel.name}" must declare exactly two ` +
        `identity.reference children (found ${refs.length})`,
    );
  }

  // The relationship's SUBJECT — the entity the M:N hangs off. Under `extends`
  // there are two legitimate names for it and BOTH occur in real models:
  //   * the DECLARING entity (rel.parent) — what @objectRef names for a self-join
  //     declared on an abstract base, and what a junction reference names when the
  //     author points the FK at the base type;
  //   * the NAVIGATING entity (`source`) — the concrete entity the caller is
  //     iterating, which is what a junction FK usually references, because that is
  //     the entity with the physical table.
  // Accepting either is what makes the derivation independent of which entity's
  // effective view reached the relationship. (Not covered: a junction reference
  // naming an entity strictly BETWEEN the declaring base and the navigating
  // entity in a deeper hierarchy — no model does that, and widening to the whole
  // super chain would make the "must declare one identity.reference to ..." error
  // unfalsifiable.)
  const subjectNames = declaringEntity.name === source.name
    ? [declaringEntity.name]
    : [declaringEntity.name, source.name];
  const subjectLabel = subjectNames.map((n) => `"${n}"`).join(" or ");
  // Compared by resolved object IDENTITY, matching the Java reference. A
  // stripPackage() compare cannot distinguish `a::NodeBase` from `b::NodeBase`,
  // so with two names in the set a genuine cross-package hetero M:N read as a
  // self-join and refused to derive.
  const isSubject = (entity: MetaObject | undefined): boolean =>
    entity !== undefined && (entity === declaringEntity || entity === source);
  const isSubjectName = (name: string | undefined): boolean =>
    name !== undefined && subjectNames.includes(stripPackage(name));

  // The junction owns its references' @references names, so those resolve in the
  // JUNCTION's package; the relationship's own @objectRef resolves in the
  // DECLARING entity's. Under `extends` across packages these differ, and using
  // one for both is what bound a bare @objectRef to the wrong same-named entity.
  const junctionPkg = junction.package ?? junction.fileDefaultPackage ?? "";
  const refEntity = (r: MetaReferenceIdentity): MetaObject | undefined =>
    findEntity(root, r.targetEntity, junctionPkg);

  // Defensive bare fallback when @objectRef does not resolve — loader validation
  // normally guarantees it does. Same carve-out the Java reference makes.
  const targetEntityNode = findEntity(root, targetName, referrerPkg);
  const isSelfJoin = targetEntityNode !== undefined
    ? isSubject(targetEntityNode)
    : isSubjectName(targetName);

  if (!isSelfJoin) {
    // Hetero: match each reference by the ENTITY OBJECT it resolves to.
    const sourceRef = refs.find((r) => isSubject(refEntity(r)));
    // Identity here too. The two searches are INDEPENDENT — nothing excludes
    // sourceRef from this one, unlike the directed self-join branch below — so a
    // bare compare could match the SOURCE-side reference again whenever the
    // target's short name equals the source's, and silently return (srcFk, srcFk).
    // Structurally unreachable while isSelfJoin was also bare (a colliding short
    // name forced the self-join branch); making only isSelfJoin identity-based
    // broke that invariant. Java matches identity on both sides (findRefToSubject
    // + findRefToObject) and never had the hole.
    const targetRef = targetEntityNode !== undefined
      ? refs.find((r) => refEntity(r) === targetEntityNode)
      : refs.find((r) => r.targetEntity !== undefined && stripPackage(r.targetEntity) === stripPackage(targetName));
    const sourceField = sourceRef ? refFkField(sourceRef) : undefined;
    const targetField = targetRef ? refFkField(targetRef) : undefined;
    if (sourceField === undefined || targetField === undefined) {
      throw new M2MDerivationError(
        `junction "${throughName}" for relationship "${declaringEntity.name}.${rel.name}" must declare one ` +
          `identity.reference to ${subjectLabel} and one to "${stripPackage(targetName)}"`,
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
        `symmetric junction "${throughName}" for "${declaringEntity.name}.${rel.name}" has a reference with no @fields`,
      );
    }
    return { sourceField: a, targetField: b };
  }

  const sourceRefField = rel.sourceRefField;
  if (sourceRefField === undefined) {
    throw new M2MDerivationError(
      `self-join relationship "${declaringEntity.name}.${rel.name}" through "${throughName}" is ambiguous: ` +
        `set @sourceRefField (directed) or @symmetric (undirected)`,
    );
  }

  // Directed self-join: @sourceRefField names the source-side FK; the other ref is the target.
  const sourceRef = refs.find((r) => refFkField(r) === sourceRefField);
  if (sourceRef === undefined) {
    throw new M2MDerivationError(
      `@sourceRefField "${sourceRefField}" on "${declaringEntity.name}.${rel.name}" does not match any ` +
        `identity.reference FK field on junction "${throughName}"`,
    );
  }
  const targetRef = refs.find((r) => r !== sourceRef);
  const targetField = targetRef ? refFkField(targetRef) : undefined;
  if (targetField === undefined) {
    throw new M2MDerivationError(
      `junction "${throughName}" for "${declaringEntity.name}.${rel.name}" has no distinct target-side reference`,
    );
  }
  return { sourceField: sourceRefField, targetField };
}
