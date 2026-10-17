// Association -> identity.reference resolution (issue #368).
//
// An entity may declare more than one identity.reference onto the SAME target
// entity (Match.homeTeamRef and Match.awayTeamRef both -> Team). A
// `@cardinality: one` relationship names only its target, so when two
// references match, the target alone cannot say which FK the navigation uses.
// Taking the first match emits a join on the wrong column that typechecks, has
// correct DDL and passes verify — so the ladder below resolves it explicitly or
// not at all. ADR-0029 §5: ambiguity is a load error naming the candidates.

import type { MetaObject } from "../object/meta-object.js";
import type { MetaReferenceIdentity } from "../identity/meta-identity.js";
import type { MetaData } from "../../shared/meta-data.js";
import { stripPackage } from "../../naming.js";
import { refTarget } from "../../naming-refs.js";
import { IDENTITY_REFERENCE_ATTR_REFERENCES } from "../identity/identity-constants.js";

/**
 * Trailing suffixes stripped from a CANDIDATE's name/FK field when building its
 * pairing keys. Ordered — first match wins, so "reference" is tested before
 * "ref". Never applied to the relationship name (see referencePairingKeys).
 */
const PAIRING_SUFFIXES = ["reference", "ref", "id", "key"] as const;

function stripOneSuffix(value: string): string {
  for (const suffix of PAIRING_SUFFIXES) {
    if (value.length > suffix.length && value.endsWith(suffix)) {
      return value.slice(0, value.length - suffix.length);
    }
  }
  return value;
}

/** The FK field a reference is anchored on (first field; composite FKs pair on their first column). */
function refFkField(ref: MetaReferenceIdentity): string | undefined {
  return ref.fields.length > 0 ? ref.fields[0] : undefined;
}

/**
 * The set of lowercased names a candidate reference answers to: its own name
 * and its FK field, each with and without one stripped suffix.
 */
export function referencePairingKeys(ref: MetaReferenceIdentity): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    const lower = value.toLowerCase();
    keys.add(lower);
    keys.add(stripOneSuffix(lower));
  };
  add(ref.name);
  add(refFkField(ref));
  return keys;
}

/**
 * Every identity.reference on `holder` whose @references targets `targetEntity`.
 * Given the target NODE, a reference matches when the loader bound its @references to
 * that node (ADR-0059 R7: identity, never a short name). Given only a name, the match
 * is package-insensitive on both sides, for callers that hold no node.
 */
export function referenceCandidatesFor(
  holder: MetaObject,
  targetEntity: string | MetaData,
): MetaReferenceIdentity[] {
  // ADR-0039: resolving — referenceIdentities() honors references inherited via extends.
  const all = holder.referenceIdentities().filter((ref) => refFkField(ref) !== undefined);
  if (typeof targetEntity !== "string") {
    return all.filter((ref) => refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES) === targetEntity);
  }
  const target = stripPackage(targetEntity);
  return all.filter((ref) => stripPackage(ref.targetEntity ?? "") === target);
}

/**
 * Which identity.reference does this `@cardinality: one` relationship navigate
 * through? The ladder, in order:
 *
 *   1. exactly one candidate            -> that one (the common case; unchanged behaviour)
 *   2. `@sourceRefField` declared       -> the candidate whose FK field it names
 *   3. exactly one candidate name-pairs -> that one
 *   4. otherwise                        -> undefined (caller reports the ambiguity)
 *
 * Returns undefined for "no candidate" and "cannot choose" alike; callers that
 * need to tell them apart use referenceCandidatesFor().
 */
export function resolveRelationshipReference(
  holder: MetaObject,
  relationshipName: string,
  targetEntity: string | MetaData,
  sourceRefField?: string,
): MetaReferenceIdentity | undefined {
  const candidates = referenceCandidatesFor(holder, targetEntity);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  if (sourceRefField !== undefined && sourceRefField !== "") {
    return candidates.find((ref) => refFkField(ref) === sourceRefField);
  }

  const wanted = relationshipName.toLowerCase();
  const paired = candidates.filter((ref) => referencePairingKeys(ref).has(wanted));
  return paired.length === 1 ? paired[0] : undefined;
}
