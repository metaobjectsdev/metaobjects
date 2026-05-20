// Cross-entity reference lookup — anchored to identity.reference declarations.
//
// Given a relationship-style query "is there a reference between A and B?",
// walk A's and B's identity.reference children to find the side that physically
// holds the reference. This is the single source of truth for FK direction
// across projection codegen, Drizzle schema emit, relations() blocks, and
// migration schema comparison.

import type { MetaObject } from "./meta-object.js";
import type { MetaReferenceIdentity } from "./meta-identity.js";
import { PACKAGE_SEPARATOR } from "../constants.js";

export interface ReferenceLookup {
  /** The entity whose identity.reference points at `other`. */
  readonly holder: MetaObject;
  /** The other side of the reference. */
  readonly other: MetaObject;
  /** The matching identity.reference declaration on `holder`. */
  readonly referenceIdentity: MetaReferenceIdentity;
}

/** Strip a package prefix ("pkg::Name" → "Name"). Returns the name unchanged if no separator. */
function bareName(name: string | undefined): string {
  if (!name) return "";
  const idx = name.lastIndexOf(PACKAGE_SEPARATOR);
  return idx === -1 ? name : name.slice(idx + PACKAGE_SEPARATOR.length);
}

/**
 * Find an identity.reference on either `a` or `b` whose @references targets the
 * other side. Returns undefined if neither side declares one.
 *
 * Comparison is package-insensitive: `@references` may be a bare entity name
 * ("User") or a fully-qualified one ("pkg::User"); both match `other.name`.
 *
 * If both sides declare references targeting each other (rare, but legal for
 * mutual 1:1), returns the first found, walking `a` first.
 */
export function findReferenceBetween(
  a: MetaObject,
  b: MetaObject,
): ReferenceLookup | undefined {
  for (const [holder, other] of [[a, b], [b, a]] as const) {
    for (const ref of holder.referenceIdentities()) {
      if (bareName(ref.targetEntity) === other.name) {
        return { holder, other, referenceIdentity: ref };
      }
    }
  }
  return undefined;
}
