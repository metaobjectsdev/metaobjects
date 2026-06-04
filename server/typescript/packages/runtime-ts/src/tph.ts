// FR-017 — table-per-hierarchy (TPH) discriminator resolution for the runtime.
//
// A TPH SUBTYPE is an entity that declares `@discriminatorValue` and `extends`
// (transitively) a base that declares `@discriminator`. The ObjectManager uses
// this to:
//   - inject the discriminator value on create (the entity names the subtype;
//     the caller never sets it);
//   - scope every read/update/delete to the subtype (a row of a different
//     subtype is invisible), mirroring the generated per-subtype route's
//     cross-subtype 404 and the drizzle-fastify `discriminator` option;
//   - treat the discriminator as immutable (stripped from update patches).
//
// The discriminator FIELD name lives on the base (`@discriminator`); the VALUE
// lives on the subtype (`@discriminatorValue`). For deep hierarchies the base
// may be any ancestor, so we walk the resolved super chain to find it.

import type { MetaData } from "@metaobjectsdev/metadata";
import { OBJECT_ATTR_DISCRIMINATOR, OBJECT_ATTR_DISCRIMINATOR_VALUE } from "@metaobjectsdev/metadata";

export interface TphSubtype {
  /** The discriminator field NAME (declared on the base via `@discriminator`). */
  field: string;
  /** This subtype's discriminator VALUE (declared via `@discriminatorValue`). */
  value: string;
}

/**
 * If `entity` is a TPH subtype, return its discriminator field + value; else
 * null. A subtype declares `@discriminatorValue` and inherits `@discriminator`
 * from an ancestor in its resolved super chain.
 */
export function tphSubtypeOf(entity: MetaData): TphSubtype | null {
  const value = entity.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE);
  if (value === undefined || value === null) return null;

  // Walk the resolved super chain to find the @discriminator-bearing ancestor.
  let ancestor: MetaData | undefined = entity.superResolved;
  while (ancestor !== undefined) {
    const field = ancestor.ownAttr(OBJECT_ATTR_DISCRIMINATOR);
    if (field !== undefined && field !== null) {
      return { field: String(field), value: String(value) };
    }
    ancestor = ancestor.superResolved;
  }
  return null;
}
