// Cross-entity reference lookup — anchored to identity.reference declarations.
//
// Given a relationship-style query "is there a reference between A and B?",
// walk A's and B's identity.reference children to find the side that physically
// holds the reference. This is the single source of truth for FK direction
// across projection codegen, Drizzle schema emit, relations() blocks, and
// migration schema comparison.

import type { MetaObject } from "../object/meta-object.js";
import type { MetaReferenceIdentity } from "../identity/meta-identity.js";
import { refTarget } from "../../naming-refs.js";
import { IDENTITY_REFERENCE_ATTR_REFERENCES } from "../identity/identity-constants.js";
import { collectionNameOf } from "../../naming.js";

export interface ReferenceLookup {
  /** The entity whose identity.reference points at `other`. */
  readonly holder: MetaObject;
  /** The other side of the reference. */
  readonly other: MetaObject;
  /** The matching identity.reference declaration on `holder`. */
  readonly referenceIdentity: MetaReferenceIdentity;
}

/**
 * Every identity.reference on `a` or `b` whose @references targets the other
 * side, `a` walked first. Comparison is package-insensitive: `@references` may
 * be a bare entity name ("User") or a fully-qualified one ("pkg::User"); both
 * match `other.name`.
 *
 * #368: an entity may legally declare more than one identity.reference onto
 * the same target (e.g. Match.homeTeamRef and Match.awayTeamRef both -> Team).
 * Callers that must not silently guess which one is meant enumerate here and
 * report the ambiguity themselves; see also `findReferenceBetween`, which
 * keeps the historical first-match contract for callers that legitimately
 * expect at most one reference between the pair.
 */
export function findReferencesBetween(
  a: MetaObject,
  b: MetaObject,
): ReferenceLookup[] {
  const found: ReferenceLookup[] = [];
  for (const [holder, other] of [[a, b], [b, a]] as const) {
    for (const ref of holder.referenceIdentities()) {
      // ADR-0059 R7: compare the bound target, never a short name.
      if (refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES) === other) {
        found.push({ holder, other, referenceIdentity: ref });
      }
    }
  }
  return found;
}

/**
 * Find an identity.reference on either `a` or `b` whose @references targets the
 * other side. Returns undefined if neither side declares one.
 *
 * Delegates to `findReferencesBetween` and returns its first entry — kept for
 * backward compatibility (this is exported public API) and for the mutual-1:1
 * case where both sides declare references targeting each other. #368: two
 * references onto the SAME target are also legal and indistinguishable from
 * here — a caller that must not guess which one is meant should call
 * `findReferencesBetween` directly and handle ambiguity explicitly rather than
 * relying on this function's first-match behaviour.
 */
export function findReferenceBetween(
  a: MetaObject,
  b: MetaObject,
): ReferenceLookup | undefined {
  return findReferencesBetween(a, b)[0];
}

/**
 * The name a `@via` hop takes when it walks the REVERSE of an
 * identity.reference, from the referenced entity back to the one that declares it:
 * the holder's collection name, lowerFirst(<Holder's collection name>) — its @collectionName, else the project's pluralizer — `consents` for
 * `Consent`, so `Patient.consents` walks Consent.patient backwards. One rule for every port.
 */
export function reverseHopName(holder: MetaObject): string {
  // the holder's collection name — its @collectionName, else the project's pluralizer.
  const plural = collectionNameOf(holder);
  return plural.charAt(0).toLowerCase() + plural.slice(1);
}

/** A reverse `@via` hop: the reference walked backwards and the entity that declares it. */
export interface ReverseReferenceHop {
  /** The concrete object whose identity.reference targets the walked-from entity. */
  readonly holder: MetaObject;
  readonly referenceIdentity: MetaReferenceIdentity;
}

/**
 * Every identity.reference that targets `target` from a concrete object whose
 * {@link reverseHopName} is `hopName` — the candidates a reverse hop `Target.hopName` names.
 * One is the hop; none means the hop is not a reverse; more than one is ambiguous, and the
 * caller refuses it naming them. A declared relationship or reference of the same name on
 * `target` always wins; callers look those up first.
 */
export function findReverseReferenceHops(
  target: MetaObject,
  hopName: string,
  objects: readonly MetaObject[],
): ReverseReferenceHop[] {
  const found: ReverseReferenceHop[] = [];
  for (const holder of objects) {
    if (holder.isAbstract || reverseHopName(holder) !== hopName) continue;
    for (const ref of holder.referenceIdentities()) {
      // ADR-0059 R7: compare the bound target, never a short name.
      if (refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES) === target) found.push({ holder, referenceIdentity: ref });
    }
  }
  return found;
}
